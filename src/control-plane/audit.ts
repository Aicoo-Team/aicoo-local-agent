import type { AuditRecord } from "../shared/contracts.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "./db.js";

export function audit(
  db: AppDatabase,
  input: {
    actorPrincipalId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO audit(actor_principal_id, action, entity_type, entity_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.actorPrincipalId,
    input.action,
    input.entityType,
    input.entityId,
    JSON.stringify(input.metadata ?? {}),
    nowIso(),
  );
}

export function listAudit(
  db: AppDatabase,
  principalId: string,
  entityType?: string,
  entityId?: string,
): AuditRecord[] {
  let rows;
  if (entityType === "communication_session" && entityId) {
    const visible = db.prepare(
      `SELECT 1 FROM comm_sessions WHERE comm_session_id = ?
       AND (requester_principal_id = ? OR recipient_principal_id = ?)`,
    ).get(entityId, principalId, principalId);
    if (!visible) return [];
    rows = db.prepare(
      `SELECT * FROM audit WHERE
       (entity_type = 'communication_session' AND entity_id = ?)
       OR json_extract(metadata_json, '$.communicationSessionId') = ?
       OR (entity_type = 'message' AND entity_id IN (
         SELECT message_id FROM messages WHERE comm_session_id = ?
       ))
       ORDER BY id`,
    ).all(entityId, entityId, entityId);
  } else {
    rows = db.prepare("SELECT * FROM audit WHERE actor_principal_id = ? ORDER BY id").all(principalId);
  }
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    actorPrincipalId: String(row.actor_principal_id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}
