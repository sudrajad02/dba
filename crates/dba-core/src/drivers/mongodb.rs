use crate::drivers::SqlDriver;
use crate::error::{DbaError, Result};
use crate::models::*;
use async_trait::async_trait;
use futures::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, IndexOptions, Tls, TlsOptions};
use mongodb::{Client, IndexModel};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub struct MongoDriver {
    client: Client,
    default_db: String,
}

impl MongoDriver {
    pub async fn connect(
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
        database: Option<String>,
        ssl: SslConfig,
    ) -> Result<Self> {
        let default_db = database
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "admin".to_string());

        let uri = if host.starts_with("mongodb://") || host.starts_with("mongodb+srv://") {
            host.clone()
        } else if !username.trim().is_empty() {
            let pw = password.as_deref().unwrap_or("");
            format!(
                "mongodb://{}:{}@{}:{}/?authSource=admin",
                url_encode(&username),
                url_encode(pw),
                host,
                port
            )
        } else {
            format!("mongodb://{}:{}", host, port)
        };

        let mut opts = ClientOptions::parse(&uri).await.map_err(map_mongo_error)?;
        opts.connect_timeout = Some(Duration::from_secs(10));
        opts.server_selection_timeout = Some(Duration::from_secs(10));

        if ssl.mode != SslMode::Disable {
            let allow_invalid = matches!(ssl.mode, SslMode::Prefer | SslMode::Require);
            let ca_path = ssl
                .ca_cert_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
            let tls_opts = TlsOptions::builder()
                .allow_invalid_certificates(Some(allow_invalid))
                .ca_file_path(ca_path)
                .build();
            if ssl.mode != SslMode::Prefer {
                opts.tls = Some(Tls::Enabled(tls_opts));
            }
        }

        let client = Client::with_options(opts).map_err(map_mongo_error)?;
        // Verify connectivity via ping
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(map_mongo_error)?;

        Ok(Self { client, default_db })
    }

    fn db_name<'a>(&'a self, database: Option<&'a str>) -> &'a str {
        database
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.default_db)
    }

    pub async fn get_collection_metadata(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<MongoCollectionMetadata> {
        let db = self.client.database(database);
        let coll = db.collection::<Document>(collection);

        let document_count = coll.estimated_document_count().await.unwrap_or(0);

        let mut options = MongoCollectionOptions::default();
        if let Ok(cursor) = db
            .list_collections()
            .filter(doc! { "name": collection })
            .await
        {
            if let Ok(specs) = cursor.try_collect::<Vec<_>>().await {
                if let Some(spec) = specs.first() {
                    options.capped = spec.options.capped.unwrap_or(false);
                    options.max_size_bytes = spec.options.size;
                    options.max_docs = spec.options.max;
                    options.validator = spec
                        .options
                        .validator
                        .as_ref()
                        .map(|d| Bson::Document(d.clone()).into_relaxed_extjson());
                    options.validation_level = spec
                        .options
                        .validation_level
                        .as_ref()
                        .map(|v| format!("{:?}", v).to_lowercase());
                    options.validation_action = spec
                        .options
                        .validation_action
                        .as_ref()
                        .map(|v| format!("{:?}", v).to_lowercase());
                }
            }
        }

        let mut avg_doc_size = None;
        let mut storage_size = None;
        if let Ok(stats) = db.run_command(doc! { "collStats": collection }).await {
            avg_doc_size = stats
                .get("avgObjSize")
                .and_then(|v| v.as_i64().or_else(|| v.as_i32().map(i64::from)))
                .map(|v| v.max(0) as u64);
            storage_size = stats
                .get("storageSize")
                .and_then(|v| v.as_i64().or_else(|| v.as_i32().map(i64::from)))
                .map(|v| v.max(0) as u64);
        }

        let mut indexes = Vec::new();
        if let Ok(cursor) = coll.list_indexes().await {
            if let Ok(models) = cursor.try_collect::<Vec<_>>().await {
                for m in models {
                    let opts = m.options.unwrap_or_default();
                    indexes.push(MongoIndexSpec {
                        name: opts.name.unwrap_or_else(|| "unnamed".into()),
                        keys: Bson::Document(m.keys).into_relaxed_extjson(),
                        unique: opts.unique.unwrap_or(false),
                        sparse: opts.sparse.unwrap_or(false),
                        ttl_seconds: opts.expire_after.map(|d| d.as_secs() as i64),
                        partial_filter_expression: opts
                            .partial_filter_expression
                            .map(|d| Bson::Document(d).into_relaxed_extjson()),
                    });
                }
            }
        }

        Ok(MongoCollectionMetadata {
            database: database.to_string(),
            name: collection.to_string(),
            document_count,
            avg_doc_size,
            storage_size,
            indexes,
            options,
        })
    }

    pub async fn fetch_documents(&self, req: &MongoDocRequest) -> Result<MongoDocResponse> {
        let start = Instant::now();
        let db = self.client.database(&req.database);
        let coll = db.collection::<Document>(&req.collection);

        let filter = parse_json_doc(req.filter_json.as_deref())?;
        let sort = parse_opt_json_doc(req.sort_json.as_deref())?;
        let projection = parse_opt_json_doc(req.projection_json.as_deref())?;

        let total_count = coll
            .count_documents(filter.clone())
            .await
            .map_err(map_mongo_error)?;

        let page = req.page.max(1);
        let page_size = req.page_size.clamp(1, 1000);
        let skip = (page - 1) * page_size;

        let mut find_action = coll.find(filter).skip(skip).limit(page_size as i64);
        if let Some(s) = sort {
            find_action = find_action.sort(s);
        }
        if let Some(p) = projection {
            find_action = find_action.projection(p);
        }

        let docs: Vec<Document> = find_action
            .await
            .map_err(map_mongo_error)?
            .try_collect()
            .await
            .map_err(map_mongo_error)?;

        let json_docs = docs
            .into_iter()
            .map(|d| Bson::Document(d).into_relaxed_extjson())
            .collect();

        Ok(MongoDocResponse {
            documents: json_docs,
            total_count,
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    pub async fn apply_document_changes(&self, req: &MongoApplyChangesRequest) -> Result<u64> {
        let db = self.client.database(&req.database);
        let coll = db.collection::<Document>(&req.collection);
        let mut affected = 0u64;

        for change in &req.changes {
            match change {
                MongoDocChange::Insert { document } => {
                    let doc = json_value_to_doc(document)?;
                    coll.insert_one(doc).await.map_err(map_mongo_error)?;
                    affected += 1;
                }
                MongoDocChange::Update { id, document } => {
                    let id_bson = json_value_to_bson(id)?;
                    let mut doc = json_value_to_doc(document)?;
                    doc.remove("_id");
                    let res = coll
                        .replace_one(doc! { "_id": id_bson }, doc)
                        .await
                        .map_err(map_mongo_error)?;
                    affected += res.modified_count.max(res.matched_count);
                }
                MongoDocChange::Delete { id } => {
                    let id_bson = json_value_to_bson(id)?;
                    let res = coll
                        .delete_one(doc! { "_id": id_bson })
                        .await
                        .map_err(map_mongo_error)?;
                    affected += res.deleted_count;
                }
            }
        }
        Ok(affected)
    }

    pub async fn execute_mql(&self, req: &MongoQueryRequest) -> Result<MongoQueryResponse> {
        let start = Instant::now();
        let db = self.client.database(&req.database);
        let coll = db.collection::<Document>(&req.collection);

        match req.operation.as_str() {
            "find" => {
                let filter = parse_json_doc(req.filter_json.as_deref())?;
                let mut action = coll.find(filter).limit(req.limit.unwrap_or(100));
                if let Some(skip) = req.skip {
                    action = action.skip(skip);
                }
                if let Some(sort) = parse_opt_json_doc(req.sort_json.as_deref())? {
                    action = action.sort(sort);
                }
                if let Some(proj) = parse_opt_json_doc(req.projection_json.as_deref())? {
                    action = action.projection(proj);
                }
                let docs: Vec<Document> = action
                    .await
                    .map_err(map_mongo_error)?
                    .try_collect()
                    .await
                    .map_err(map_mongo_error)?;
                let count = docs.len();
                Ok(MongoQueryResponse {
                    documents: docs
                        .into_iter()
                        .map(|d| Bson::Document(d).into_relaxed_extjson())
                        .collect(),
                    affected_count: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: format!("Returned {} document(s)", count),
                })
            }
            "aggregate" => {
                let pipeline = parse_json_pipeline(req.pipeline_json.as_deref())?;
                let docs: Vec<Document> = coll
                    .aggregate(pipeline)
                    .await
                    .map_err(map_mongo_error)?
                    .try_collect()
                    .await
                    .map_err(map_mongo_error)?;
                let count = docs.len();
                Ok(MongoQueryResponse {
                    documents: docs
                        .into_iter()
                        .map(|d| Bson::Document(d).into_relaxed_extjson())
                        .collect(),
                    affected_count: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: format!("Aggregation returned {} document(s)", count),
                })
            }
            "count" => {
                let filter = parse_json_doc(req.filter_json.as_deref())?;
                let cnt = coll.count_documents(filter).await.map_err(map_mongo_error)?;
                Ok(MongoQueryResponse {
                    documents: vec![serde_json::json!({ "count": cnt })],
                    affected_count: Some(cnt),
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: format!("Count: {}", cnt),
                })
            }
            "insertOne" => {
                let doc = parse_json_doc(req.document_json.as_deref())?;
                let res = coll.insert_one(doc).await.map_err(map_mongo_error)?;
                Ok(MongoQueryResponse {
                    documents: vec![serde_json::json!({
                        "insertedId": res.inserted_id.into_relaxed_extjson()
                    })],
                    affected_count: Some(1),
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: "Inserted 1 document".into(),
                })
            }
            "updateMany" => {
                let filter = parse_json_doc(req.filter_json.as_deref())?;
                let update = parse_json_doc(req.update_json.as_deref())?;
                let res = coll
                    .update_many(filter, update)
                    .await
                    .map_err(map_mongo_error)?;
                Ok(MongoQueryResponse {
                    documents: vec![serde_json::json!({
                        "matchedCount": res.matched_count,
                        "modifiedCount": res.modified_count
                    })],
                    affected_count: Some(res.modified_count),
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: format!(
                        "Matched {}, modified {} document(s)",
                        res.matched_count, res.modified_count
                    ),
                })
            }
            "deleteMany" => {
                let filter = parse_json_doc(req.filter_json.as_deref())?;
                let res = coll.delete_many(filter).await.map_err(map_mongo_error)?;
                Ok(MongoQueryResponse {
                    documents: vec![serde_json::json!({ "deletedCount": res.deleted_count })],
                    affected_count: Some(res.deleted_count),
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: format!("Deleted {} document(s)", res.deleted_count),
                })
            }
            "command" => {
                let cmd = parse_json_doc(req.document_json.as_deref().or(req.filter_json.as_deref()))?;
                let res = db.run_command(cmd).await.map_err(map_mongo_error)?;
                Ok(MongoQueryResponse {
                    documents: vec![Bson::Document(res).into_relaxed_extjson()],
                    affected_count: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                    summary: "Command executed".into(),
                })
            }
            other => Err(DbaError::Database {
                message: format!("Unsupported MongoDB operation '{}'", other),
                code: None,
                detail: None,
                line: None,
            }),
        }
    }

    /// Stage-by-Stage Aggregation Pipeline Builder preview: executes cumulative prefixes
    /// `[stage_0]`, `[stage_0, stage_1]`, ... with `$limit: 25` so user can inspect every stage.
    pub async fn preview_aggregation_stages(
        &self,
        database: &str,
        collection: &str,
        stages: &[MongoAggregationStage],
    ) -> Result<Vec<MongoAggregationStageResult>> {
        let db = self.client.database(database);
        let coll = db.collection::<Document>(collection);
        let mut results = Vec::new();
        let mut cumulative: Vec<Document> = Vec::new();

        for (idx, stage) in stages.iter().enumerate() {
            if !stage.enabled {
                continue;
            }
            let st_start = Instant::now();
            let body_val: serde_json::Value = match serde_json::from_str(&stage.body_json) {
                Ok(v) => v,
                Err(err) => {
                    results.push(MongoAggregationStageResult {
                        stage_index: idx,
                        operator: stage.operator.clone(),
                        doc_count: 0,
                        sample_docs: Vec::new(),
                        execution_ms: st_start.elapsed().as_millis() as u64,
                        error: Some(format!("Invalid JSON in {}: {}", stage.operator, err)),
                    });
                    break;
                }
            };
            let body_bson = match json_value_to_bson(&body_val) {
                Ok(b) => b,
                Err(err) => {
                    results.push(MongoAggregationStageResult {
                        stage_index: idx,
                        operator: stage.operator.clone(),
                        doc_count: 0,
                        sample_docs: Vec::new(),
                        execution_ms: st_start.elapsed().as_millis() as u64,
                        error: Some(err.to_string()),
                    });
                    break;
                }
            };

            let mut stage_doc = Document::new();
            stage_doc.insert(stage.operator.clone(), body_bson);
            cumulative.push(stage_doc);

            let mut preview_pipe = cumulative.clone();
            preview_pipe.push(doc! { "$limit": 25 });

            match coll.aggregate(preview_pipe).await {
                Ok(cursor) => match cursor.try_collect::<Vec<Document>>().await {
                    Ok(docs) => {
                        let sample_docs: Vec<serde_json::Value> = docs
                            .into_iter()
                            .map(|d| Bson::Document(d).into_relaxed_extjson())
                            .collect();
                        results.push(MongoAggregationStageResult {
                            stage_index: idx,
                            operator: stage.operator.clone(),
                            doc_count: sample_docs.len(),
                            sample_docs,
                            execution_ms: st_start.elapsed().as_millis() as u64,
                            error: None,
                        });
                    }
                    Err(err) => {
                        results.push(MongoAggregationStageResult {
                            stage_index: idx,
                            operator: stage.operator.clone(),
                            doc_count: 0,
                            sample_docs: Vec::new(),
                            execution_ms: st_start.elapsed().as_millis() as u64,
                            error: Some(err.to_string()),
                        });
                        break;
                    }
                },
                Err(err) => {
                    results.push(MongoAggregationStageResult {
                        stage_index: idx,
                        operator: stage.operator.clone(),
                        doc_count: 0,
                        sample_docs: Vec::new(),
                        execution_ms: st_start.elapsed().as_millis() as u64,
                        error: Some(err.to_string()),
                    });
                    break;
                }
            }
        }

        Ok(results)
    }

    pub async fn create_index(&self, req: &MongoCreateIndexRequest) -> Result<String> {
        let db = self.client.database(&req.database);
        let coll = db.collection::<Document>(&req.collection);
        let keys = parse_json_doc(Some(&req.keys_json))?;
        let mut opts = IndexOptions::builder()
            .unique(req.unique)
            .sparse(req.sparse)
            .build();
        if let Some(ref name) = req.name {
            if !name.trim().is_empty() {
                opts.name = Some(name.trim().to_string());
            }
        }
        if let Some(ttl) = req.ttl_seconds {
            opts.expire_after = Some(Duration::from_secs(ttl));
        }
        if let Some(pf) = parse_opt_json_doc(req.partial_filter_json.as_deref())? {
            opts.partial_filter_expression = Some(pf);
        }
        let model = IndexModel::builder().keys(keys).options(opts).build();
        let res = coll.create_index(model).await.map_err(map_mongo_error)?;
        Ok(res.index_name)
    }

    pub async fn drop_index(&self, database: &str, collection: &str, index_name: &str) -> Result<()> {
        let db = self.client.database(database);
        let coll = db.collection::<Document>(collection);
        coll.drop_index(index_name)
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    pub async fn update_collection_validation(
        &self,
        req: &MongoValidationUpdateRequest,
    ) -> Result<()> {
        let db = self.client.database(&req.database);
        let validator = parse_opt_json_doc(req.validator_json.as_deref())?
            .unwrap_or_else(Document::new);
        let cmd = doc! {
            "collMod": &req.collection,
            "validator": validator,
            "validationLevel": &req.validation_level,
            "validationAction": &req.validation_action,
        };
        db.run_command(cmd).await.map_err(map_mongo_error)?;
        Ok(())
    }

    pub async fn explain_mql(
        &self,
        database: &str,
        collection: &str,
        filter_json: Option<&str>,
    ) -> Result<ExplainPlanResult> {
        let start = Instant::now();
        let db = self.client.database(database);
        let filter = parse_json_doc(filter_json)?;
        let cmd = doc! {
            "explain": {
                "find": collection,
                "filter": filter,
            },
            "verbosity": "executionStats"
        };
        let res = db.run_command(cmd).await.map_err(map_mongo_error)?;
        let raw_json = Bson::Document(res).into_relaxed_extjson();
        let root = parse_mongo_explain(&raw_json);
        Ok(ExplainPlanResult {
            root,
            raw_json,
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }
}

fn parse_mongo_explain(raw: &serde_json::Value) -> Option<ExplainNode> {
    let stage = raw
        .pointer("/executionStats/executionStages")
        .or_else(|| raw.pointer("/queryPlanner/winningPlan"))?;
    Some(mongo_stage_to_node(stage))
}

fn mongo_stage_to_node(stage: &serde_json::Value) -> ExplainNode {
    let stage_name = stage
        .get("stage")
        .and_then(|v| v.as_str())
        .unwrap_or("STAGE")
        .to_string();
    let is_full_scan = stage_name == "COLLSCAN";
    let actual_rows = stage
        .get("nReturned")
        .and_then(|v| v.as_f64());
    let actual_time_ms = stage
        .get("executionTimeMillisEstimate")
        .and_then(|v| v.as_f64());
    let docs_examined = stage
        .get("docsExamined")
        .and_then(|v| v.as_u64());
    let index_name = stage
        .get("indexName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut extra_parts = Vec::new();
    if let Some(d) = docs_examined {
        extra_parts.push(format!("docsExamined: {}", d));
    }
    if let Some(ref idx) = index_name {
        extra_parts.push(format!("index: {}", idx));
    }

    let mut children = Vec::new();
    if let Some(input) = stage.get("inputStage") {
        children.push(mongo_stage_to_node(input));
    }
    if let Some(inputs) = stage.get("inputStages").and_then(|v| v.as_array()) {
        for inp in inputs {
            children.push(mongo_stage_to_node(inp));
        }
    }

    ExplainNode {
        node_type: stage_name,
        relation: index_name,
        startup_cost: None,
        total_cost: None,
        plan_rows: None,
        actual_time_ms,
        actual_rows,
        is_full_scan,
        extra: if extra_parts.is_empty() {
            None
        } else {
            Some(extra_parts.join(" • "))
        },
        children,
    }
}

fn map_mongo_error(err: mongodb::error::Error) -> DbaError {
    DbaError::Database {
        message: err.to_string(),
        code: None,
        detail: None,
        line: None,
    }
}

fn url_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn json_value_to_bson(val: &serde_json::Value) -> Result<Bson> {
    Bson::try_from(val.clone()).map_err(|e| DbaError::Database {
        message: format!("Failed to convert JSON to BSON: {}", e),
        code: None,
        detail: None,
        line: None,
    })
}

fn json_value_to_doc(val: &serde_json::Value) -> Result<Document> {
    match json_value_to_bson(val)? {
        Bson::Document(d) => Ok(d),
        _ => Err(DbaError::Database {
            message: "Expected a JSON object document".into(),
            code: None,
            detail: None,
            line: None,
        }),
    }
}

fn parse_json_doc(raw: Option<&str>) -> Result<Document> {
    let s = raw.map(str::trim).unwrap_or("");
    if s.is_empty() {
        return Ok(Document::new());
    }
    let val: serde_json::Value = serde_json::from_str(s)?;
    json_value_to_doc(&val)
}

fn parse_opt_json_doc(raw: Option<&str>) -> Result<Option<Document>> {
    let s = raw.map(str::trim).unwrap_or("");
    if s.is_empty() {
        return Ok(None);
    }
    let val: serde_json::Value = serde_json::from_str(s)?;
    Ok(Some(json_value_to_doc(&val)?))
}

fn parse_json_pipeline(raw: Option<&str>) -> Result<Vec<Document>> {
    let s = raw.map(str::trim).unwrap_or("[]");
    if s.is_empty() {
        return Ok(Vec::new());
    }
    let val: serde_json::Value = serde_json::from_str(s)?;
    let arr = val.as_array().ok_or_else(|| DbaError::Database {
        message: "Aggregation pipeline must be a JSON array of stage objects".into(),
        code: None,
        detail: None,
        line: None,
    })?;
    let mut docs = Vec::with_capacity(arr.len());
    for item in arr {
        docs.push(json_value_to_doc(item)?);
    }
    Ok(docs)
}

#[async_trait]
impl SqlDriver for MongoDriver {
    async fn server_version(&self) -> Result<String> {
        let res = self
            .client
            .database("admin")
            .run_command(doc! { "buildInfo": 1 })
            .await
            .map_err(map_mongo_error)?;
        let ver = res
            .get_str("version")
            .map(|v| format!("MongoDB {}", v))
            .unwrap_or_else(|_| "MongoDB".to_string());
        Ok(ver)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let specs = self
            .client
            .list_databases()
            .await
            .map_err(map_mongo_error)?;
        Ok(specs
            .into_iter()
            .map(|d| DatabaseInfo {
                name: d.name,
                size_bytes: Some(d.size_on_disk as i64),
            })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        Ok(Vec::new())
    }

    async fn list_objects(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let db_name = self.db_name(database);
        let db = self.client.database(db_name);
        let cursor = db.list_collections().await.map_err(map_mongo_error)?;
        let specs: Vec<_> = cursor.try_collect().await.map_err(map_mongo_error)?;

        let mut out = Vec::new();
        for s in specs {
            let kind = match s.collection_type {
                mongodb::results::CollectionType::View => ObjectKind::View,
                _ => ObjectKind::Collection,
            };
            let est = if kind == ObjectKind::Collection {
                db.collection::<Document>(&s.name)
                    .estimated_document_count()
                    .await
                    .ok()
                    .map(|c| c as i64)
            } else {
                None
            };
            out.push(DatabaseObject {
                name: s.name,
                schema: Some(db_name.to_string()),
                kind,
                row_estimate: est,
                comment: if s.options.capped.unwrap_or(false) {
                    Some("capped".into())
                } else {
                    None
                },
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn get_table_metadata(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        table: &str,
    ) -> Result<TableMetadata> {
        let db_name = self.db_name(database);
        let meta = self.get_collection_metadata(db_name, table).await?;
        let indexes = meta
            .indexes
            .iter()
            .map(|idx| IndexMeta {
                name: idx.name.clone(),
                columns: idx
                    .keys
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default(),
                is_unique: idx.unique,
                is_primary: idx.name == "_id_",
                method: "btree".into(),
                definition: Some(idx.keys.to_string()),
            })
            .collect();
        Ok(TableMetadata {
            schema: Some(db_name.to_string()),
            name: table.to_string(),
            columns: vec![ColumnMeta {
                name: "_id".into(),
                data_type: "ObjectId".into(),
                udt_name: Some("ObjectId".into()),
                max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_auto_increment: false,
                comment: None,
            }],
            indexes,
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            row_estimate: Some(meta.document_count as i64),
            ddl: meta.options.validator.map(|v| serde_json::to_string_pretty(&v).unwrap_or_default()),
        })
    }

    async fn fetch_table_data(&self, req: &TableDataRequest) -> Result<QueryResultSet> {
        let db_name = self.db_name(req.database.as_deref()).to_string();
        let doc_res = self
            .fetch_documents(&MongoDocRequest {
                connection_id: req.connection_id.clone(),
                database: db_name,
                collection: req.table.clone(),
                filter_json: None,
                sort_json: None,
                projection_json: None,
                page: req.page,
                page_size: req.page_size,
            })
            .await?;

        let mut key_set: BTreeSet<String> = BTreeSet::new();
        for d in &doc_res.documents {
            if let Some(obj) = d.as_object() {
                for k in obj.keys() {
                    key_set.insert(k.clone());
                }
            }
        }
        let mut keys: Vec<String> = key_set.into_iter().collect();
        if let Some(pos) = keys.iter().position(|k| k == "_id") {
            keys.remove(pos);
            keys.insert(0, "_id".into());
        }

        let columns: Vec<ResultColumn> = keys
            .iter()
            .map(|k| ResultColumn {
                name: k.clone(),
                data_type: "bson".into(),
                is_primary_key: k == "_id",
                fk_target: None,
            })
            .collect();

        let rows: Vec<Vec<serde_json::Value>> = doc_res
            .documents
            .iter()
            .map(|d| {
                keys.iter()
                    .map(|k| d.get(k).cloned().unwrap_or(serde_json::Value::Null))
                    .collect()
            })
            .collect();

        Ok(QueryResultSet {
            columns,
            rows,
            rows_affected: None,
            total_count: Some(doc_res.total_count),
            execution_ms: doc_res.execution_ms,
            statement: format!("db.{}.find({{}})", req.table),
        })
    }

    async fn execute_query(
        &self,
        database: Option<&str>,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryExecutionResponse> {
        let start = Instant::now();
        let db_name = self.db_name(database);
        let cmd = parse_json_doc(Some(sql))?;
        let res = self
            .client
            .database(db_name)
            .run_command(cmd)
            .await
            .map_err(map_mongo_error)?;
        let json = Bson::Document(res).into_relaxed_extjson();
        Ok(QueryExecutionResponse {
            query_id: query_id.to_string(),
            result_sets: vec![QueryResultSet {
                columns: vec![ResultColumn {
                    name: "result".into(),
                    data_type: "json".into(),
                    is_primary_key: false,
                    fk_target: None,
                }],
                rows: vec![vec![json]],
                rows_affected: None,
                total_count: Some(1),
                execution_ms: start.elapsed().as_millis() as u64,
                statement: sql.to_string(),
            }],
            total_execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn cancel_query(&self, _query_id: &str) -> Result<()> {
        Ok(())
    }

    async fn explain_query(&self, database: Option<&str>, sql: &str) -> Result<ExplainPlanResult> {
        let start = Instant::now();
        let db_name = self.db_name(database);
        let cmd = parse_json_doc(Some(sql))?;
        let res = self
            .client
            .database(db_name)
            .run_command(doc! { "explain": cmd, "verbosity": "executionStats" })
            .await
            .map_err(map_mongo_error)?;
        let raw_json = Bson::Document(res).into_relaxed_extjson();
        let root = parse_mongo_explain(&raw_json);
        Ok(ExplainPlanResult {
            root,
            raw_json,
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn apply_staged_changes(&self, _req: &ApplyChangesRequest) -> Result<u64> {
        Err(DbaError::UnsupportedEngine(
            "Use mongo_apply_document_changes for MongoDB collections".into(),
        ))
    }

    async fn get_autocomplete_schema(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
    ) -> Result<AutocompleteSchema> {
        let objs = self.list_objects(database, None).await?;
        let mut tables = HashMap::new();
        for o in objs {
            tables.insert(o.name, vec!["_id".into()]);
        }
        Ok(AutocompleteSchema { tables })
    }

    async fn execute_ddl(&self, database: Option<&str>, ddl: &str) -> Result<()> {
        let db_name = self.db_name(database);
        let cmd = parse_json_doc(Some(ddl))?;
        self.client
            .database(db_name)
            .run_command(cmd)
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    async fn truncate_table(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        table: &str,
    ) -> Result<()> {
        let db_name = self.db_name(database);
        self.client
            .database(db_name)
            .collection::<Document>(table)
            .delete_many(Document::new())
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    async fn drop_object(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        name: &str,
        _kind: ObjectKind,
    ) -> Result<()> {
        let db_name = self.db_name(database);
        self.client
            .database(db_name)
            .collection::<Document>(name)
            .drop()
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    async fn create_database(
        &self,
        name: &str,
        _charset: Option<&str>,
        _collation: Option<&str>,
    ) -> Result<()> {
        self.client
            .database(name)
            .create_collection("_init")
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    async fn drop_database(&self, name: &str) -> Result<()> {
        self.client
            .database(name)
            .drop()
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }

    async fn duplicate_table(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        source: &str,
        target: &str,
        with_data: bool,
    ) -> Result<()> {
        let db_name = self.db_name(database);
        let db = self.client.database(db_name);
        if with_data {
            let _: Vec<Document> = db
                .collection::<Document>(source)
                .aggregate(vec![doc! { "$out": target }])
                .await
                .map_err(map_mongo_error)?
                .try_collect()
                .await
                .map_err(map_mongo_error)?;
        } else {
            db.create_collection(target)
                .await
                .map_err(map_mongo_error)?;
        }
        Ok(())
    }

    async fn rename_table(
        &self,
        database: Option<&str>,
        _schema: Option<&str>,
        old_name: &str,
        new_name: &str,
    ) -> Result<()> {
        let db_name = self.db_name(database);
        self.client
            .database("admin")
            .run_command(doc! {
                "renameCollection": format!("{}.{}", db_name, old_name),
                "to": format!("{}.{}", db_name, new_name),
            })
            .await
            .map_err(map_mongo_error)?;
        Ok(())
    }
}
