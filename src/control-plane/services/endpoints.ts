import type {
  RegisterEndpointInput,
  RegisterRuntimeSessionInput,
  RuntimeEndpoint,
  RuntimeSessionBinding,
  ServiceResult,
} from "../../shared/contracts.js";
import { id } from "../../shared/ids.js";
import { nowIso } from "../../shared/time.js";
import { audit } from "../audit.js";
import type { AuthContext } from "../auth.js";
import type { AppDatabase } from "../db.js";

export class EndpointService {
  constructor(private readonly db: AppDatabase) {}

  register(auth: AuthContext, input: RegisterEndpointInput): RuntimeEndpoint {
    const now = nowIso();
    const existing = this.db.prepare(
      "SELECT endpoint_id FROM endpoints WHERE principal_id = ? AND device_id = ? AND runtime = ?",
    ).get(auth.principalId, auth.deviceId, input.runtime) as { endpoint_id: string } | undefined;
    const endpointId = existing?.endpoint_id ?? id("ep");
    if (existing) {
      this.db.prepare(
        `UPDATE endpoints SET bridge_version = ?, adapter_version = ?, capabilities_json = ?,
         presence = 'online', last_seen_at = ? WHERE endpoint_id = ?`,
      ).run(input.bridgeVersion, input.adapterVersion, JSON.stringify(input.capabilities), now, endpointId);
    } else {
      this.db.prepare(
        `INSERT INTO endpoints(endpoint_id, principal_id, device_id, runtime, bridge_version,
         adapter_version, capabilities_json, presence, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
      ).run(
        endpointId,
        auth.principalId,
        auth.deviceId,
        input.runtime,
        input.bridgeVersion,
        input.adapterVersion,
        JSON.stringify(input.capabilities),
        now,
        now,
      );
    }
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: existing ? "endpoint.reregistered" : "endpoint.registered",
      entityType: "endpoint",
      entityId: endpointId,
      metadata: { deviceId: auth.deviceId, runtime: input.runtime },
    });
    const registered = this.getOwned(auth, endpointId);
    if (!registered.ok) throw new Error(`Registered endpoint ${endpointId} could not be read back`);
    return registered.value;
  }

  heartbeat(auth: AuthContext, endpointId: string): ServiceResult<void> {
    const result = this.db.prepare(
      `UPDATE endpoints SET presence = 'online', last_seen_at = ?
       WHERE endpoint_id = ? AND principal_id = ? AND device_id = ?`,
    ).run(nowIso(), endpointId, auth.principalId, auth.deviceId);
    if (Number(result.changes) === 0) return fail("endpoint_not_owned", 404);
    return { ok: true, value: undefined };
  }

  getOwned(auth: AuthContext, endpointId: string): ServiceResult<RuntimeEndpoint> {
    const row = this.db.prepare(
      "SELECT * FROM endpoints WHERE endpoint_id = ? AND principal_id = ? AND device_id = ?",
    ).get(endpointId, auth.principalId, auth.deviceId) as EndpointRow | undefined;
    if (!row) return fail("endpoint_not_owned", 404);
    return { ok: true, value: mapEndpoint(row) };
  }

  listForPrincipal(principalId: string): RuntimeEndpoint[] {
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    this.db.prepare(
      "UPDATE endpoints SET presence = 'offline' WHERE principal_id = ? AND last_seen_at < ? AND presence = 'online'",
    ).run(principalId, staleBefore);
    return (this.db.prepare("SELECT * FROM endpoints WHERE principal_id = ? ORDER BY created_at").all(
      principalId,
    ) as unknown as EndpointRow[]).map(mapEndpoint);
  }

  registerSession(
    auth: AuthContext,
    endpointId: string,
    input: RegisterRuntimeSessionInput,
  ): ServiceResult<RuntimeSessionBinding> {
    const endpoint = this.getOwned(auth, endpointId);
    if (!endpoint.ok) return endpoint;
    const handle = id("rs");
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO runtime_sessions(session_handle, endpoint_id, principal_id, label, state,
       delivery_mode, capabilities_json, allow_inbound, allow_mid_turn_steer, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      handle,
      endpointId,
      auth.principalId,
      input.label,
      input.state,
      input.deliveryMode,
      JSON.stringify(input.capabilities),
      input.allowInbound ? 1 : 0,
      input.allowMidTurnSteer ? 1 : 0,
      now,
      now,
    );
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "runtime_session.registered",
      entityType: "runtime_session",
      entityId: handle,
      metadata: { endpointId, label: input.label },
    });
    return this.getSessionOwned(auth, endpointId, handle);
  }

  updateSession(
    auth: AuthContext,
    endpointId: string,
    handle: string,
    input: { state?: "idle" | "busy" | "closed"; allowInbound?: boolean; allowMidTurnSteer?: boolean },
  ): ServiceResult<RuntimeSessionBinding> {
    const current = this.getSessionOwned(auth, endpointId, handle);
    if (!current.ok) return current;
    const next = {
      state: input.state ?? current.value.state,
      allowInbound: input.allowInbound ?? current.value.allowInbound,
      allowMidTurnSteer: input.allowMidTurnSteer ?? current.value.allowMidTurnSteer,
    };
    this.db.prepare(
      `UPDATE runtime_sessions SET state = ?, allow_inbound = ?, allow_mid_turn_steer = ?, last_active_at = ?
       WHERE session_handle = ? AND endpoint_id = ? AND principal_id = ?`,
    ).run(
      next.state,
      next.allowInbound ? 1 : 0,
      next.allowMidTurnSteer ? 1 : 0,
      nowIso(),
      handle,
      endpointId,
      auth.principalId,
    );
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "runtime_session.updated",
      entityType: "runtime_session",
      entityId: handle,
      metadata: next,
    });
    return this.getSessionOwned(auth, endpointId, handle);
  }

  closeSession(auth: AuthContext, endpointId: string, handle: string): ServiceResult<void> {
    const result = this.updateSession(auth, endpointId, handle, { state: "closed", allowInbound: false });
    return result.ok ? { ok: true, value: undefined } : result;
  }

  getSessionOwned(
    auth: AuthContext,
    endpointId: string,
    handle: string,
  ): ServiceResult<RuntimeSessionBinding> {
    const row = this.db.prepare(
      `SELECT rs.* FROM runtime_sessions rs JOIN endpoints e ON e.endpoint_id = rs.endpoint_id
       WHERE rs.session_handle = ? AND rs.endpoint_id = ? AND rs.principal_id = ? AND e.device_id = ?`,
    ).get(handle, endpointId, auth.principalId, auth.deviceId) as SessionRow | undefined;
    if (!row) return fail("session_not_owned", 404);
    return { ok: true, value: mapSession(row) };
  }

  getSession(handle: string): RuntimeSessionBinding | undefined {
    const row = this.db.prepare("SELECT * FROM runtime_sessions WHERE session_handle = ?").get(handle) as
      | SessionRow
      | undefined;
    return row ? mapSession(row) : undefined;
  }

  setDefaultRoute(
    auth: AuthContext,
    endpointId: string,
    sessionHandle: string,
  ): ServiceResult<{ endpointId: string; sessionHandle: string; updatedAt: string }> {
    const session = this.getSessionOwned(auth, endpointId, sessionHandle);
    if (!session.ok) return session;
    if (session.value.state === "closed") return fail("session_closed", 409);
    if (!session.value.allowInbound) return fail("inbound_disabled", 409);
    const updatedAt = nowIso();
    this.db.prepare(
      `INSERT INTO default_routes(principal_id, endpoint_id, session_handle, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(principal_id) DO UPDATE SET endpoint_id = excluded.endpoint_id,
       session_handle = excluded.session_handle, updated_at = excluded.updated_at`,
    ).run(auth.principalId, endpointId, sessionHandle, updatedAt);
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "default_route.set",
      entityType: "principal",
      entityId: auth.principalId,
      metadata: { endpointId, sessionHandle },
    });
    return { ok: true, value: { endpointId, sessionHandle, updatedAt } };
  }

  getDefaultRoute(principalId: string): { endpointId: string; sessionHandle: string; updatedAt: string } | undefined {
    const row = this.db.prepare(
      "SELECT endpoint_id, session_handle, updated_at FROM default_routes WHERE principal_id = ?",
    ).get(principalId) as { endpoint_id: string; session_handle: string; updated_at: string } | undefined;
    return row
      ? { endpointId: row.endpoint_id, sessionHandle: row.session_handle, updatedAt: row.updated_at }
      : undefined;
  }

  clearDefaultRoute(auth: AuthContext): ServiceResult<void> {
    this.db.prepare("DELETE FROM default_routes WHERE principal_id = ?").run(auth.principalId);
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "default_route.cleared",
      entityType: "principal",
      entityId: auth.principalId,
    });
    return { ok: true, value: undefined };
  }
}

interface EndpointRow {
  endpoint_id: string;
  principal_id: string;
  device_id: string;
  runtime: RuntimeEndpoint["runtime"];
  bridge_version: string;
  adapter_version: string;
  capabilities_json: string;
  presence: RuntimeEndpoint["presence"];
  last_seen_at: string;
}

interface SessionRow {
  session_handle: string;
  endpoint_id: string;
  principal_id: string;
  label: string;
  state: RuntimeSessionBinding["state"];
  delivery_mode: RuntimeSessionBinding["deliveryMode"];
  capabilities_json: string;
  allow_inbound: number;
  allow_mid_turn_steer: number;
  created_at: string;
  last_active_at: string;
}

function mapEndpoint(row: EndpointRow): RuntimeEndpoint {
  return {
    endpointId: row.endpoint_id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    runtime: row.runtime,
    bridgeVersion: row.bridge_version,
    adapterVersion: row.adapter_version,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    presence: row.presence,
    lastSeenAt: row.last_seen_at,
  };
}

function mapSession(row: SessionRow): RuntimeSessionBinding {
  return {
    sessionHandle: row.session_handle,
    endpointId: row.endpoint_id,
    principalId: row.principal_id,
    label: row.label,
    state: row.state,
    deliveryMode: row.delivery_mode,
    capabilities: JSON.parse(row.capabilities_json) as RuntimeSessionBinding["capabilities"],
    allowInbound: Boolean(row.allow_inbound),
    allowMidTurnSteer: Boolean(row.allow_mid_turn_steer),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function fail<T>(code: import("../../shared/reason-codes.js").ReasonCode, httpStatus: number): ServiceResult<T> {
  return { ok: false, code, httpStatus };
}
