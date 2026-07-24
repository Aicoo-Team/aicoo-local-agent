import type { ReachableTarget, ServiceResult } from "../../shared/contracts.js";
import { id } from "../../shared/ids.js";
import { addSeconds, nowIso } from "../../shared/time.js";
import { audit } from "../audit.js";
import type { AuthContext } from "../auth.js";
import type { AppDatabase } from "../db.js";
import { EndpointService } from "./endpoints.js";

export interface TargetOffer {
  targetOfferId: string;
  endpointId: string;
  sessionHandle: string;
  audiencePrincipalId: string;
  label: string;
  expiresAt: string;
}

export class OfferService {
  constructor(
    private readonly db: AppDatabase,
    private readonly endpoints: EndpointService,
  ) {}

  create(
    auth: AuthContext,
    input: { endpointId: string; sessionHandle: string; audiencePrincipalId: string; ttlSeconds?: number },
  ): ServiceResult<TargetOffer> {
    const session = this.endpoints.getSessionOwned(auth, input.endpointId, input.sessionHandle);
    if (!session.ok) return session;
    if (session.value.state === "closed") return failure("session_closed", 409);
    if (!session.value.allowInbound) return failure("inbound_disabled", 409);
    const audience = this.db.prepare("SELECT 1 FROM principals WHERE principal_id = ?").get(input.audiencePrincipalId);
    if (!audience) return failure("not_found", 404);
    const offerId = id("offer");
    const now = nowIso();
    const expiresAt = addSeconds(now, input.ttlSeconds ?? 600);
    this.db.prepare(
      `INSERT INTO target_offers(offer_id, owner_principal_id, audience_principal_id, endpoint_id,
       session_handle, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      offerId,
      auth.principalId,
      input.audiencePrincipalId,
      input.endpointId,
      input.sessionHandle,
      session.value.label,
      expiresAt,
      now,
    );
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "target_offer.created",
      entityType: "target_offer",
      entityId: offerId,
      metadata: { audiencePrincipalId: input.audiencePrincipalId, expiresAt },
    });
    return {
      ok: true,
      value: {
        targetOfferId: offerId,
        endpointId: input.endpointId,
        sessionHandle: input.sessionHandle,
        audiencePrincipalId: input.audiencePrincipalId,
        label: session.value.label,
        expiresAt,
      },
    };
  }

  revoke(auth: AuthContext, offerId: string): ServiceResult<void> {
    const result = this.db.prepare(
      "UPDATE target_offers SET revoked_at = ? WHERE offer_id = ? AND owner_principal_id = ? AND revoked_at IS NULL",
    ).run(nowIso(), offerId, auth.principalId);
    if (Number(result.changes) === 0) return failure("offer_not_found", 404);
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: "target_offer.revoked",
      entityType: "target_offer",
      entityId: offerId,
    });
    return { ok: true, value: undefined };
  }

  resolve(
    offerId: string,
    ownerPrincipalId: string,
    audiencePrincipalId: string,
  ): ServiceResult<{ endpointId: string; sessionHandle: string }> {
    const row = this.db.prepare("SELECT * FROM target_offers WHERE offer_id = ? AND owner_principal_id = ?").get(
      offerId,
      ownerPrincipalId,
    ) as OfferRow | undefined;
    if (!row) return failure("offer_not_found", 404);
    if (row.audience_principal_id !== audiencePrincipalId) return failure("offer_audience_mismatch", 403);
    if (row.revoked_at) return failure("offer_revoked", 409);
    if (row.expires_at <= nowIso()) return failure("offer_expired", 409);
    return { ok: true, value: { endpointId: row.endpoint_id, sessionHandle: row.session_handle } };
  }

  listReachable(viewerPrincipalId: string, personId: string): ReachableTarget[] {
    const principal = this.db.prepare("SELECT 1 FROM principals WHERE principal_id = ?").get(personId);
    if (!principal) return [];
    const targets: ReachableTarget[] = [];
    const route = this.endpoints.getDefaultRoute(personId);
    targets.push({
      kind: "person_default_runtime",
      principalId: personId,
      label: "Default local runtime",
      available: Boolean(route),
    });
    const rows = this.db.prepare(
      `SELECT offer_id, label, expires_at FROM target_offers
       WHERE owner_principal_id = ? AND audience_principal_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at`,
    ).all(personId, viewerPrincipalId, nowIso()) as Array<{
      offer_id: string;
      label: string;
      expires_at: string;
    }>;
    for (const row of rows) {
      targets.push({
        kind: "runtime_session",
        principalId: personId,
        label: row.label,
        targetOfferId: row.offer_id,
        expiresAt: row.expires_at,
        available: true,
      });
    }
    return targets;
  }
}

interface OfferRow {
  audience_principal_id: string;
  endpoint_id: string;
  session_handle: string;
  expires_at: string;
  revoked_at: string | null;
}

function failure<T>(
  code: import("../../shared/reason-codes.js").ReasonCode,
  httpStatus: number,
): ServiceResult<T> {
  return { ok: false, code, httpStatus };
}
