import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { z } from "zod";

export const TRUSTED_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "GitStatus",
  "GitDiff",
  "GitLog",
  "GitAdd",
  "GitCommit",
] as const;

export type TrustedToolName = typeof TRUSTED_TOOL_NAMES[number];
export type TrustedToolPolicyScope = "bridge_run" | "persistent";

const trustedToolNameSchema = z.enum(TRUSTED_TOOL_NAMES);
const pendingUseSchema = z.object({
  sequence: z.number().int().positive(),
  usedAt: z.string().datetime(),
}).strict();
const policySchema = z.object({
  policyId: z.string().trim().min(1),
  ownerPrincipalId: z.string().trim().min(1),
  ownerDeviceId: z.string().trim().min(1),
  requesterPrincipalId: z.string().trim().min(1),
  requesterDeviceId: z.string().trim().min(1),
  canonicalFolder: z.string().trim().min(1),
  normalizedTool: trustedToolNameSchema,
  scope: z.enum(["bridge_run", "persistent"]),
  bridgeInstanceId: z.string().trim().min(1).optional(),
  status: z.enum(["active", "revoked", "invalid"]),
  createdFrom: z.enum(["cli", "settings", "approval_prompt"]),
  createdAt: z.string().datetime(),
  createdBy: z.string().trim().min(1),
  lastUsedAt: z.string().datetime().optional(),
  useCount: z.number().int().nonnegative(),
  pendingUses: z.array(pendingUseSchema).default([]),
  revokedAt: z.string().datetime().optional(),
  revokedBy: z.string().trim().min(1).optional(),
  invalidatedReason: z.string().trim().min(1).optional(),
}).strict();

const documentSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  serverRevisions: z.record(z.string(), z.number().int().nonnegative()),
  policies: z.array(policySchema),
}).strict();

const legacyDocumentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  policies: z.array(policySchema),
}).strict();

export type TrustedToolPolicy = z.infer<typeof policySchema>;
export type TrustedToolPolicyUse = z.infer<typeof pendingUseSchema>;
export type TrustedToolPolicyDocument = z.infer<typeof documentSchema>;

export interface TrustedToolPolicyIdentity {
  ownerPrincipalId: string;
  ownerDeviceId: string;
  bridgeInstanceId: string;
}

export function isTrustedToolName(value: string): value is TrustedToolName {
  return (TRUSTED_TOOL_NAMES as readonly string[]).includes(value);
}

export function readTrustedToolPolicies(file: string): TrustedToolPolicyDocument {
  if (!existsSync(file)) return { version: 2, revision: 0, serverRevisions: {}, policies: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read trusted tool policies ${file}: ${String(error)}`);
  }
  const parsed = documentSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const legacy = legacyDocumentSchema.safeParse(raw);
  if (legacy.success) return { ...legacy.data, version: 2, serverRevisions: {} };
  throw new Error(`Invalid trusted tool policies ${file}: ${z.prettifyError(parsed.error)}`);
}

export function upsertTrustedToolPolicy(input: {
  file: string;
  policyId?: string;
  ownerPrincipalId: string;
  ownerDeviceId: string;
  requesterPrincipalId: string;
  requesterDeviceId: string;
  folder: string;
  normalizedTool: TrustedToolName;
  scope: TrustedToolPolicyScope;
  bridgeInstanceId?: string;
  createdFrom: "cli" | "settings" | "approval_prompt";
  createdBy: string;
  createdAt?: Date;
  serverRevision?: number;
}): TrustedToolPolicy {
  if (input.scope === "bridge_run" && !input.bridgeInstanceId) {
    throw new Error("bridgeInstanceId is required for bridge-run trusted tool access");
  }
  const canonicalFolder = canonicalizePolicyFolder(input.folder);
  const document = readTrustedToolPolicies(input.file);
  const serverRevision = input.serverRevision ?? 0;
  const latestServerRevision = document.serverRevisions[input.policyId ?? ""];
  const sameIdActive = input.policyId
    ? document.policies.find((policy) => policy.policyId === input.policyId && policy.status === "active")
    : undefined;
  if (latestServerRevision !== undefined && latestServerRevision > serverRevision) {
    throw new Error("Stale trusted tool policy revision");
  }
  if (latestServerRevision === serverRevision && input.policyId) {
    if (sameIdActive) return sameIdActive;
    throw new Error("Trusted tool policy was already revoked at this revision");
  }
  const now = (input.createdAt ?? new Date()).toISOString();
  const exact = document.policies.find((policy) =>
    policy.status === "active"
    && policy.ownerPrincipalId === input.ownerPrincipalId
    && policy.ownerDeviceId === input.ownerDeviceId
    && policy.requesterPrincipalId === input.requesterPrincipalId
    && policy.requesterDeviceId === input.requesterDeviceId
    && policy.canonicalFolder === canonicalFolder
    && policy.normalizedTool === input.normalizedTool
    && policy.scope === input.scope
    && (!input.policyId || policy.policyId === input.policyId)
    && (input.scope !== "bridge_run" || policy.bridgeInstanceId === input.bridgeInstanceId));
  if (exact) return exact;

  const policy: TrustedToolPolicy = {
    policyId: input.policyId ?? `ttp_${randomUUID()}`,
    ownerPrincipalId: input.ownerPrincipalId,
    ownerDeviceId: input.ownerDeviceId,
    requesterPrincipalId: input.requesterPrincipalId,
    requesterDeviceId: input.requesterDeviceId,
    canonicalFolder,
    normalizedTool: input.normalizedTool,
    scope: input.scope,
    ...(input.scope === "bridge_run" ? { bridgeInstanceId: input.bridgeInstanceId } : {}),
    status: "active",
    createdFrom: input.createdFrom,
    createdAt: now,
    createdBy: input.createdBy,
    useCount: 0,
    pendingUses: [],
  };
  writeTrustedToolPolicies(input.file, {
    version: 2,
    revision: document.revision + 1,
    serverRevisions: input.policyId
      ? { ...document.serverRevisions, [input.policyId]: serverRevision }
      : document.serverRevisions,
    policies: [...document.policies, policy],
  });
  return policy;
}

export function revokeTrustedToolPolicy(input: {
  file: string;
  policyId: string;
  revokedBy: string;
  serverRevision?: number;
  now?: Date;
}): TrustedToolPolicy | undefined {
  const document = readTrustedToolPolicies(input.file);
  const serverRevision = input.serverRevision ?? 0;
  const latestServerRevision = document.serverRevisions[input.policyId];
  if (latestServerRevision !== undefined && serverRevision < latestServerRevision) return undefined;
  const index = document.policies.findIndex((policy) => policy.policyId === input.policyId);
  if (index < 0) {
    writeTrustedToolPolicies(input.file, {
      ...document,
      revision: document.revision + 1,
      serverRevisions: { ...document.serverRevisions, [input.policyId]: serverRevision },
    });
    return undefined;
  }
  const current = document.policies[index]!;
  if (current.status !== "active") return current;
  const revoked: TrustedToolPolicy = {
    ...current,
    status: "revoked",
    revokedAt: (input.now ?? new Date()).toISOString(),
    revokedBy: input.revokedBy,
  };
  const policies = [...document.policies];
  policies[index] = revoked;
  writeTrustedToolPolicies(input.file, {
    version: 2,
    revision: document.revision + 1,
    serverRevisions: { ...document.serverRevisions, [input.policyId]: serverRevision },
    policies,
  });
  return revoked;
}

export function markTrustedToolPolicyUsed(file: string, policyId: string, now = new Date()): void {
  const document = readTrustedToolPolicies(file);
  const index = document.policies.findIndex((policy) => policy.policyId === policyId && policy.status === "active");
  if (index < 0) return;
  const policies = [...document.policies];
  policies[index] = {
    ...policies[index]!,
    lastUsedAt: now.toISOString(),
    useCount: policies[index]!.useCount + 1,
    pendingUses: [
      ...policies[index]!.pendingUses,
      { sequence: policies[index]!.useCount + 1, usedAt: now.toISOString() },
    ],
  };
  writeTrustedToolPolicies(file, { ...document, revision: document.revision + 1, policies });
}

export function pendingTrustedToolPolicyUses(
  file: string,
  ownerPrincipalId: string,
  ownerDeviceId: string,
  limit = 100,
): Array<{
  policy: TrustedToolPolicy;
  serverRevision: number;
  uses: TrustedToolPolicyUse[];
}> {
  const document = readTrustedToolPolicies(file);
  return document.policies
    .filter((policy) =>
      policy.ownerPrincipalId === ownerPrincipalId
      && policy.ownerDeviceId === ownerDeviceId
      && document.serverRevisions[policy.policyId] !== undefined
      && policy.pendingUses.length > 0)
    .map((policy) => ({
      policy,
      serverRevision: document.serverRevisions[policy.policyId]!,
      uses: policy.pendingUses.slice(0, limit),
    }));
}

export function markTrustedToolPolicyUsesReported(
  file: string,
  policyId: string,
  acceptedThroughSequence: number,
): void {
  const document = readTrustedToolPolicies(file);
  const index = document.policies.findIndex((policy) => policy.policyId === policyId);
  if (index < 0) return;
  const current = document.policies[index]!;
  const pendingUses = current.pendingUses.filter((use) => use.sequence > acceptedThroughSequence);
  if (pendingUses.length === current.pendingUses.length) return;
  const policies = [...document.policies];
  policies[index] = { ...current, pendingUses };
  writeTrustedToolPolicies(file, { ...document, revision: document.revision + 1, policies });
}

export function policyMatchesOwner(
  policy: TrustedToolPolicy,
  identity: TrustedToolPolicyIdentity,
): boolean {
  return policy.status === "active"
    && policy.ownerPrincipalId === identity.ownerPrincipalId
    && policy.ownerDeviceId === identity.ownerDeviceId
    && (policy.scope === "persistent" || policy.bridgeInstanceId === identity.bridgeInstanceId);
}

function canonicalizePolicyFolder(folder: string): string {
  const canonicalFolder = realpathSync.native(resolve(folder));
  if (canonicalFolder === parse(canonicalFolder).root) {
    throw new Error("Filesystem roots cannot be granted to a collaborator");
  }
  return canonicalFolder;
}

function writeTrustedToolPolicies(file: string, document: TrustedToolPolicyDocument): void {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
