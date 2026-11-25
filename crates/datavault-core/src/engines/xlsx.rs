use crate::error::{DatavaultError, Result};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

/// Minimal zero-dependency OOXML `.xlsx` writer using standard ZIP (Deflate via `flate2`).
pub fn write_xlsx<P: AsRef<Path>>(
    path: P,
    sheet_name: &str,
    headers: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Result<()> {
    let safe_sheet = sanitize_sheet_name(sheet_name);
    let mut sheet_xml = String::with_capacity(4096 + rows.len() * 64);
    sheet_xml.push_str(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );

    let mut row_num: usize = 1;
    if !headers.is_empty() {
        sheet_xml.push_str(&format!(r#"<row r="{}">"#, row_num));
        for (c_idx, h) in headers.iter().enumerate() {
            let cell_ref = format!("{}{}", col_index_to_letters(c_idx), row_num);
            sheet_xml.push_str(&format!(
                r#"<c r="{}" t="inlineStr"><is><t>{}</t></is></c>"#,
                cell_ref,
                xml_escape(h)
            ));
        }
        sheet_xml.push_str("</row>");
        row_num += 1;
    }

    for row in rows {
        sheet_xml.push_str(&format!(r#"<row r="{}">"#, row_num));
        for (c_idx, val) in row.iter().enumerate() {
            let cell_ref = format!("{}{}", col_index_to_letters(c_idx), row_num);
            match val {
                serde_json::Value::Null => {}
                serde_json::Value::Bool(b) => {
                    sheet_xml.push_str(&format!(
                        r#"<c r="{}" t="b"><v>{}</v></c>"#,
                        cell_ref,
                        if *b { 1 } else { 0 }
                    ));
                }
                serde_json::Value::Number(n) => {
                    sheet_xml.push_str(&format!(r#"<c r="{}"><v>{}</v></c>"#, cell_ref, n));
                }
                serde_json::Value::String(s) => {
                    sheet_xml.push_str(&format!(
                        r#"<c r="{}" t="inlineStr"><is><t>{}</t></is></c>"#,
                        cell_ref,
                        xml_escape(s)
                    ));
                }
                other => {
                    let s = other.to_string();
                    sheet_xml.push_str(&format!(
                        r#"<c r="{}" t="inlineStr"><is><t>{}</t></is></c>"#,
                        cell_ref,
                        xml_escape(&s)
                    ));
                }
            }
        }
        sheet_xml.push_str("</row>");
        row_num += 1;
    }
    sheet_xml.push_str("</sheetData></worksheet>");

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;

    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;

    let workbook_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        xml_escape(&safe_sheet)
    );

    let workbook_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;

    let entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("xl/workbook.xml", workbook_xml.as_bytes()),
        ("xl/_rels/workbook.xml.rels", workbook_rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet_xml.as_bytes()),
    ];

    write_zip(path, &entries)
}

/// Minimal zero-dependency OOXML `.xlsx` reader (first worksheet, supports sharedStrings, inlineStr, numbers, booleans).
pub fn read_xlsx<P: AsRef<Path>>(path: P, max_rows: Option<usize>) -> Result<Vec<Vec<serde_json::Value>>> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;

    let entries = read_zip_entries(&bytes)?;
    let shared_strings = entries
        .get("xl/sharedStrings.xml")
        .map(|b| parse_shared_strings(&String::from_utf8_lossy(b)))
        .unwrap_or_default();

    let sheet_bytes = entries
        .get("xl/worksheets/sheet1.xml")
        .or_else(|| {
            entries
                .iter()
                .find(|(k, _)| k.starts_with("xl/worksheets/sheet") && k.ends_with(".xml"))
                .map(|(_, v)| v)
        })
        .ok_or_else(|| DatavaultError::Storage("Invalid .xlsx file: missing worksheet XML".into()))?;

    let xml = String::from_utf8_lossy(sheet_bytes);
    parse_worksheet_rows(&xml, &shared_strings, max_rows)
}

fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | '?' | '*' | '[' | ']' | ':'))
        .take(31)
        .collect();
    if cleaned.trim().is_empty() {
        "Sheet1".to_string()
    } else {
        cleaned
    }
}

fn col_index_to_letters(mut idx: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    out.into_iter().rev().collect()
}

fn letters_to_col_index(cell_ref: &str) -> usize {
    let mut col = 0usize;
    for b in cell_ref.bytes() {
        if b.is_ascii_alphabetic() {
            let up = b.to_ascii_uppercase();
            col = col * 26 + ((up - b'A') as usize + 1);
        } else {
            break;
        }
    }
    col.saturating_sub(1)
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(si_start) = xml[pos..].find("<si") {
        let abs_start = pos + si_start;
        let Some(si_end_rel) = xml[abs_start..].find("</si>") else {
            break;
        };
        let si_chunk = &xml[abs_start..abs_start + si_end_rel];
        let mut combined = String::new();
        let mut t_pos = 0;
        while let Some(t_start) = si_chunk[t_pos..].find("<t") {
            let t_abs = t_pos + t_start;
            let Some(gt) = si_chunk[t_abs..].find('>') else {
                break;
            };
            let content_start = t_abs + gt + 1;
            let Some(t_end) = si_chunk[content_start..].find("</t>") else {
                break;
            };
            combined.push_str(&xml_unescape(&si_chunk[content_start..content_start + t_end]));
            t_pos = content_start + t_end + 4;
        }
        out.push(combined);
        pos = abs_start + si_end_rel + 5;
    }
    out
}

fn parse_worksheet_rows(
    xml: &str,
    shared_strings: &[String],
    max_rows: Option<usize>,
) -> Result<Vec<Vec<serde_json::Value>>> {
    let mut rows = Vec::new();
    let mut pos = 0;

    while let Some(row_start) = xml[pos..].find("<row") {
        if let Some(limit) = max_rows {
            if rows.len() >= limit {
                break;
            }
        }
        let abs_start = pos + row_start;
        let Some(row_end_rel) = xml[abs_start..].find("</row>") else {
            break;
        };
        let row_chunk = &xml[abs_start..abs_start + row_end_rel];
        let mut row_vals: Vec<serde_json::Value> = Vec::new();
        let mut c_pos = 0;

        while let Some(c_start) = row_chunk[c_pos..].find("<c ") {
            let c_abs = c_pos + c_start;
            let Some(tag_end) = row_chunk[c_abs..].find('>') else {
                break;
            };
            let open_tag = &row_chunk[c_abs..c_abs + tag_end + 1];
            let is_self_closing = open_tag.ends_with("/>");
            let cell_body_end = if is_self_closing {
                c_abs + tag_end + 1
            } else {
                match row_chunk[c_abs + tag_end + 1..].find("</c>") {
                    Some(end_rel) => c_abs + tag_end + 1 + end_rel,
                    None => break,
                }
            };
            let cell_body = if is_self_closing {
                ""
            } else {
                &row_chunk[c_abs + tag_end + 1..cell_body_end]
            };

            let col_idx = extract_attr(open_tag, "r")
                .map(|r| letters_to_col_index(&r))
                .unwrap_or(row_vals.len());
            while row_vals.len() <= col_idx {
                row_vals.push(serde_json::Value::Null);
            }

            let cell_type = extract_attr(open_tag, "t").unwrap_or_default();
            let val = if cell_type == "inlineStr" {
                extract_tag_text(cell_body, "t")
                    .map(|s| serde_json::Value::String(xml_unescape(&s)))
                    .unwrap_or(serde_json::Value::Null)
            } else if cell_type == "s" {
                extract_tag_text(cell_body, "v")
                    .and_then(|s| s.trim().parse::<usize>().ok())
                    .and_then(|i| shared_strings.get(i))
                    .map(|s| serde_json::Value::String(s.clone()))
                    .unwrap_or(serde_json::Value::Null)
            } else if cell_type == "b" {
                extract_tag_text(cell_body, "v")
                    .map(|s| serde_json::Value::Bool(s.trim() == "1"))
                    .unwrap_or(serde_json::Value::Null)
            } else if cell_type == "str" {
                extract_tag_text(cell_body, "v")
                    .map(|s| serde_json::Value::String(xml_unescape(&s)))
                    .unwrap_or(serde_json::Value::Null)
            } else if let Some(v) = extract_tag_text(cell_body, "v") {
                let trimmed = v.trim();
                if let Ok(i) = trimmed.parse::<i64>() {
                    serde_json::Value::from(i)
                } else if let Ok(f) = trimmed.parse::<f64>() {
                    serde_json::Number::from_f64(f)
                        .map(serde_json::Value::Number)
                        .unwrap_or_else(|| serde_json::Value::String(trimmed.to_string()))
                } else {
                    serde_json::Value::String(xml_unescape(trimmed))
                }
            } else {
                serde_json::Value::Null
            };

            row_vals[col_idx] = val;
            c_pos = if is_self_closing {
                cell_body_end
            } else {
                cell_body_end + 4
            };
        }

        if !row_vals.is_empty() {
            rows.push(row_vals);
        }
        pos = abs_start + row_end_rel + 6;
    }

    Ok(rows)
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!(r#"{}=""#, name);
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')?;
    Some(tag[start..start + end].to_string())
}

fn extract_tag_text(chunk: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = chunk.find(&open)?;
    let gt = chunk[start..].find('>')?;
    let body_start = start + gt + 1;
    let body_end = chunk[body_start..].find(&close)?;
    Some(chunk[body_start..body_start + body_end].to_string())
}

// ============================================================================
// Minimal ZIP writer & reader (Deflate + Stored) using flate2 + CRC32
// ============================================================================

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn write_zip<P: AsRef<Path>>(path: P, entries: &[(&str, &[u8])]) -> Result<()> {
    let file = File::create(path)?;
    let mut w = BufWriter::new(file);
    let mut central_dir = Vec::new();
    let mut offset: u32 = 0;

    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data)?;
        let compressed = encoder.finish()?;

        // Local file header
        w.write_all(&0x0403_4b50u32.to_le_bytes())?;
        w.write_all(&20u16.to_le_bytes())?; // version needed
        w.write_all(&0u16.to_le_bytes())?; // flags
        w.write_all(&8u16.to_le_bytes())?; // method: deflate
        w.write_all(&0u16.to_le_bytes())?; // mod time
        w.write_all(&0u16.to_le_bytes())?; // mod date
        w.write_all(&crc.to_le_bytes())?;
        w.write_all(&(compressed.len() as u32).to_le_bytes())?;
        w.write_all(&(data.len() as u32).to_le_bytes())?;
        w.write_all(&(name_bytes.len() as u16).to_le_bytes())?;
        w.write_all(&0u16.to_le_bytes())?; // extra len
        w.write_all(name_bytes)?;
        w.write_all(&compressed)?;

        // Central directory header
        central_dir.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&8u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0u32.to_le_bytes());
        central_dir.extend_from_slice(&offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);

        offset = offset
            .saturating_add(30)
            .saturating_add(name_bytes.len() as u32)
            .saturating_add(compressed.len() as u32);
    }

    let cd_size = central_dir.len() as u32;
    w.write_all(&central_dir)?;

    // End of central directory record
    w.write_all(&0x0605_4b50u32.to_le_bytes())?;
    w.write_all(&0u16.to_le_bytes())?;
    w.write_all(&0u16.to_le_bytes())?;
    w.write_all(&(entries.len() as u16).to_le_bytes())?;
    w.write_all(&(entries.len() as u16).to_le_bytes())?;
    w.write_all(&cd_size.to_le_bytes())?;
    w.write_all(&offset.to_le_bytes())?;
    w.write_all(&0u16.to_le_bytes())?;
    w.flush()?;
    Ok(())
}

fn read_zip_entries(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>> {
    // Locate End of Central Directory (EOCD) signature 0x06054b50
    let eocd_pos = (0..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| bytes[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| DatavaultError::Storage("Invalid ZIP/.xlsx archive (missing EOCD)".into()))?;

    let cd_offset = u32::from_le_bytes(bytes[eocd_pos + 16..eocd_pos + 20].try_into().unwrap()) as usize;
    let total_entries = u16::from_le_bytes(bytes[eocd_pos + 10..eocd_pos + 12].try_into().unwrap()) as usize;

    let mut map = HashMap::new();
    let mut pos = cd_offset;
    for _ in 0..total_entries {
        if pos + 46 > bytes.len() || bytes[pos..pos + 4] != [0x50, 0x4b, 0x01, 0x02] {
            break;
        }
        let method = u16::from_le_bytes(bytes[pos + 10..pos + 12].try_into().unwrap());
        let comp_size = u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().unwrap()) as usize;
        let name_len = u16::from_le_bytes(bytes[pos + 28..pos + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(bytes[pos + 30..pos + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(bytes[pos + 32..pos + 34].try_into().unwrap()) as usize;
        let local_offset = u32::from_le_bytes(bytes[pos + 42..pos + 46].try_into().unwrap()) as usize;

        let name = String::from_utf8_lossy(&bytes[pos + 46..pos + 46 + name_len]).to_string();
        pos += 46 + name_len + extra_len + comment_len;

        if local_offset + 30 > bytes.len() {
            continue;
        }
        let l_name_len = u16::from_le_bytes(bytes[local_offset + 26..local_offset + 28].try_into().unwrap()) as usize;
        let l_extra_len = u16::from_le_bytes(bytes[local_offset + 28..local_offset + 30].try_into().unwrap()) as usize;
        let data_start = local_offset + 30 + l_name_len + l_extra_len;
        let data_end = (data_start + comp_size).min(bytes.len());
        let raw = &bytes[data_start..data_end];

        let decoded = match method {
            0 => raw.to_vec(),
            8 => {
                let mut dec = DeflateDecoder::new(raw);
                let mut out = Vec::new();
                dec.read_to_end(&mut out)?;
                out
            }
            _ => continue,
        };
        map.insert(name, decoded);
    }

    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_xlsx() {
        let tmp = std::env::temp_dir().join("datavault_test_roundtrip.xlsx");
        let headers = vec!["id".into(), "name".into(), "active".into()];
        let rows = vec![
            vec![serde_json::json!(1), serde_json::json!("Alice & Bob"), serde_json::json!(true)],
            vec![serde_json::json!(2), serde_json::json!("Charlie"), serde_json::json!(false)],
        ];
        write_xlsx(&tmp, "users", &headers, &rows).unwrap();
        let read_back = read_xlsx(&tmp, None).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(read_back.len(), 3);
        assert_eq!(read_back[0][1], serde_json::json!("name"));
        assert_eq!(read_back[1][0], serde_json::json!(1));
        assert_eq!(read_back[1][1], serde_json::json!("Alice & Bob"));
        assert_eq!(read_back[1][2], serde_json::json!(true));
    }
}
