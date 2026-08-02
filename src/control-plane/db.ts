import { DatabaseSync } from "node:sqlite";

export type AppDatabase = DatabaseSync;

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_credentials (
  token TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(principal_id, device_id)
);

CREATE TABLE IF NOT EXISTS endpoints (
  endpoint_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  bridge_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  presence TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(principal_id, device_id, runtime)
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  session_handle TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  allow_inbound INTEGER NOT NULL,
  allow_mid_turn_steer INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS default_routes (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  session_handle TEXT NOT NULL REFERENCES runtime_sessions(session_handle),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_offers (
  offer_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  audience_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  session_handle TEXT NOT NULL REFERENCES runtime_sessions(session_handle),
  label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comm_sessions (
  comm_session_id TEXT PRIMARY KEY,
  requester_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  requester_device_id TEXT,
  requester_reply_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  requester_reply_session_handle TEXT NOT NULL REFERENCES runtime_sessions(session_handle),
  recipient_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  target_kind TEXT NOT NULL,
  target_offer_id TEXT,
  frozen_endpoint_id TEXT REFERENCES endpoints(endpoint_id),
  frozen_session_handle TEXT REFERENCES runtime_sessions(session_handle),
  requested_ttl_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  request_expires_at TEXT NOT NULL,
  activated_at TEXT,
  grant_expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  client_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  comm_session_id TEXT REFERENCES comm_sessions(comm_session_id),
  sender_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  sender_device_id TEXT,
  target_kind TEXT NOT NULL,
  target_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  target_endpoint_id TEXT REFERENCES endpoints(endpoint_id),
  target_session_handle TEXT REFERENCES runtime_sessions(session_handle),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reply_to TEXT,
  correlation_id TEXT,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(sender_principal_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
  endpoint_id TEXT REFERENCES endpoints(endpoint_id),
  status TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  dispatched_at TEXT,
  device_ack_received_at TEXT,
  runtime_pending_at TEXT,
  runtime_ack_received_at TEXT,
  terminal_at TEXT,
  result_code TEXT,
  runtime_ack_id TEXT,
  adapter_label TEXT
);

CREATE TABLE IF NOT EXISTS local_agent_delegations (
  requester_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  client_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  comm_session_id TEXT REFERENCES comm_sessions(comm_session_id),
  message_id TEXT REFERENCES messages(message_id),
  correlation_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(requester_principal_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
  phase TEXT NOT NULL,
  result_code TEXT,
  retryable INTEGER NOT NULL,
  runtime_ack_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(endpoint_id, seq)
);

CREATE TABLE IF NOT EXISTS inbox_items (
  inbox_item_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_endpoint_seq ON events(endpoint_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_comm_sequence ON messages(comm_session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity_type, entity_id, id);
`;

export function openDb(file: string): AppDatabase {
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  ensureColumn(db, "comm_sessions", "requester_device_id", "TEXT");
  ensureColumn(db, "messages", "sender_device_id", "TEXT");
  seedMockIdentities(db);
  return db;
}

function ensureColumn(db: AppDatabase, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function seedMockIdentities(db: AppDatabase): void {
  const principals = [
    ["prn_a", "Principal A"],
    ["prn_b", "Principal B"],
    ["prn_c", "Principal C"],
  ] as const;
  const credentials = [
    [process.env.CCD_TOKEN_A ?? "ccd-token-a1", "prn_a", "device-a1"],
    [process.env.CCD_TOKEN_B ?? "ccd-token-b1", "prn_b", "device-b1"],
    [process.env.CCD_TOKEN_C ?? "ccd-token-c1", "prn_c", "device-c1"],
  ] as const;
  const addPrincipal = db.prepare("INSERT OR IGNORE INTO principals(principal_id, display_name) VALUES (?, ?)");
  for (const row of principals) addPrincipal.run(...row);
  const addCredential = db.prepare(
    "INSERT OR IGNORE INTO device_credentials(token, principal_id, device_id, active) VALUES (?, ?, ?, 1)",
  );
  for (const row of credentials) addCredential.run(...row);
}

export function transaction<T>(db: AppDatabase, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
