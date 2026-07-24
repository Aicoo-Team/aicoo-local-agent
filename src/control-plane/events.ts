import { EventEmitter } from "node:events";
import type { RuntimeEvent } from "../shared/contracts.js";
import { nowIso } from "../shared/time.js";
import type { AppDatabase } from "./db.js";

export class EventStore {
  readonly #hub = new EventEmitter();

  constructor(private readonly db: AppDatabase) {
    this.#hub.setMaxListeners(100);
  }

  append(endpointId: string, type: RuntimeEvent["type"], data: Record<string, unknown>): RuntimeEvent {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE endpoint_id = ?").get(
      endpointId,
    ) as { seq: number };
    const sequence = Number(row.seq) + 1;
    const createdAt = nowIso();
    this.db.prepare(
      "INSERT INTO events(endpoint_id, seq, event_type, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(endpointId, sequence, type, JSON.stringify(data), createdAt);
    return { cursor: String(sequence), type, endpointId, createdAt, data };
  }

  wake(endpointIds: Iterable<string>): void {
    for (const endpointId of new Set(endpointIds)) this.#hub.emit(endpointId);
  }

  subscribe(endpointId: string, listener: () => void): () => void {
    this.#hub.on(endpointId, listener);
    return () => this.#hub.off(endpointId, listener);
  }

  list(endpointId: string, afterCursor = "0", limit = 500): RuntimeEvent[] {
    const cursor = Number.parseInt(afterCursor, 10);
    const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const rows = this.db.prepare(
      `SELECT endpoint_id, seq, event_type, data_json, created_at
       FROM events WHERE endpoint_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(endpointId, safeCursor, limit) as Array<{
      endpoint_id: string;
      seq: number;
      event_type: RuntimeEvent["type"];
      data_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      cursor: String(row.seq),
      type: row.event_type,
      endpointId: row.endpoint_id,
      createdAt: row.created_at,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
    }));
  }
}
