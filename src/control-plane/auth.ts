import type { AppDatabase } from "./db.js";

export interface AuthContext {
  principalId: string;
  deviceId: string;
  token: string;
}

export function resolveBearer(db: AppDatabase, authorization: string | undefined): AuthContext | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return undefined;
  const row = db
    .prepare(
      "SELECT token, principal_id, device_id FROM device_credentials WHERE token = ? AND active = 1",
    )
    .get(token) as { token: string; principal_id: string; device_id: string } | undefined;
  if (!row) return undefined;
  return { principalId: row.principal_id, deviceId: row.device_id, token: row.token };
}
