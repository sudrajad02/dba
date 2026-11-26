import type { SavedQuery } from "../types/dba";
import type { WorkbenchTab } from "../store/useWorkbenchStore";

export interface MongoSavedQueryPayload {
  version: 1;
  mode: "mql" | "pipeline";
  collection: string;
  operation:
    | "find"
    | "aggregate"
    | "count"
    | "insertOne"
    | "updateMany"
    | "deleteMany"
    | "command";
  payloadJson: string;
  updateJson: string;
  limit: number;
  stages: {
    id: string;
    operator: string;
    bodyJson: string;
    enabled: boolean;
  }[];
}

export function isMongoSavedQuery(sq: Pick<SavedQuery, "path" | "engine">): boolean {
  return (
    sq.engine === "mongodb" || sq.path.toLowerCase().endsWith(".mongodb.json")
  );
}

export function formatSavedQueryFilename(sq: Pick<SavedQuery, "name" | "path" | "engine">): string {
  return isMongoSavedQuery(sq) ? `${sq.name}.mongodb.json` : `${sq.name}.sql`;
}

export function parseMongoSavedQueryPayload(raw?: string | null): MongoSavedQueryPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && (parsed.mode === "mql" || parsed.mode === "pipeline")) {
      return parsed as MongoSavedQueryPayload;
    }
  } catch {
    // ignore malformed json
  }
  return null;
}

export function buildTabFromSavedQuery(
  sq: SavedQuery,
  fallback?: { connectionId?: string | null; database?: string | null; schema?: string | null }
): Omit<WorkbenchTab, "id"> {
  const connectionId = sq.connectionId ?? fallback?.connectionId ?? undefined;
  const database = sq.database ?? fallback?.database ?? undefined;
  const schema = sq.schema ?? fallback?.schema ?? undefined;

  if (isMongoSavedQuery(sq)) {
    const parsed = parseMongoSavedQueryPayload(sq.sql);
    return {
      kind: "mongo_query",
      title: formatSavedQueryFilename(sq),
      connectionId,
      database,
      collection: parsed?.collection || undefined,
      mongoMode: parsed?.mode ?? "mql",
      sql: sq.sql,
      savedQueryPath: sq.path,
      dirty: false,
    };
  }

  return {
    kind: "query",
    title: formatSavedQueryFilename(sq),
    connectionId,
    database,
    schema,
    sql: sq.sql,
    savedQueryPath: sq.path,
    dirty: false,
  };
}

export function validateQueryName(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/\.mongodb\.json$/i, "")
    .replace(/\.sql$/i, "")
    .trim();
  if (!trimmed) return "Query name is required.";
  if (trimmed === "." || trimmed === "..") return "Invalid query name.";
  if (/[\/\\:*?"<>|\0]|\.\./.test(trimmed)) {
    return 'Query name cannot contain / \\ : * ? " < > | or ".."';
  }
  return null;
}
