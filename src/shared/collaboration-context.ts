import { createHash } from "node:crypto";

export const COLLABORATION_CONTEXT_MAX_BYTES = 128 * 1024;
export const COLLABORATION_CONTEXT_MAX_CONTENT_BYTES = 96 * 1024;
export const COLLABORATION_CONTEXT_MAX_ITEMS = 12;

export const COLLABORATION_CONTEXT_KINDS = [
  "requirement",
  "diff",
  "file_excerpt",
  "error",
  "test_output",
  "decision",
  "freeform",
] as const;

export type CollaborationContextKind = typeof COLLABORATION_CONTEXT_KINDS[number];

export interface CollaborationContextItem {
  kind: CollaborationContextKind;
  label: string;
  content: string;
  sourcePath?: string;
  sha256: string;
}

export interface CollaborationContext {
  objective: string;
  summary: string;
  items: CollaborationContextItem[];
  limitations: string[];
}

const FORBIDDEN_SOURCE_PATH = /(^|[/\\])(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials?(?:\.|$)|secrets?(?:\.|$))/i;
const OBVIOUS_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{12,}/i;

export function parseCollaborationContext(value: unknown, objective: string): CollaborationContext {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new Error("context_invalid");
  if (Buffer.byteLength(encoded, "utf8") > COLLABORATION_CONTEXT_MAX_BYTES) {
    throw new Error("context_too_large");
  }
  if (!isRecord(value)) throw new Error("context_invalid");
  if (typeof value.objective === "string" && value.objective.trim() !== objective.trim()) {
    throw new Error("context_objective_mismatch");
  }
  if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 2_000) {
    throw new Error("context_summary_invalid");
  }
  if (!Array.isArray(value.items) || value.items.length > COLLABORATION_CONTEXT_MAX_ITEMS) {
    throw new Error("context_items_invalid");
  }
  if (!Array.isArray(value.limitations) || value.limitations.length > 12) {
    throw new Error("context_limitations_invalid");
  }

  let contentBytes = 0;
  const items = value.items.map((candidate): CollaborationContextItem => {
    if (!isRecord(candidate)) throw new Error("context_item_invalid");
    if (!isContextKind(candidate.kind)) throw new Error("context_item_kind_invalid");
    if (typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 120) {
      throw new Error("context_item_label_invalid");
    }
    if (typeof candidate.content !== "string" || !candidate.content.trim()) {
      throw new Error("context_item_content_invalid");
    }
    contentBytes += Buffer.byteLength(candidate.content, "utf8");
    if (contentBytes > COLLABORATION_CONTEXT_MAX_CONTENT_BYTES) throw new Error("context_content_too_large");
    const sourcePath = typeof candidate.sourcePath === "string" && candidate.sourcePath.trim()
      ? candidate.sourcePath.trim()
      : undefined;
    if (sourcePath && FORBIDDEN_SOURCE_PATH.test(sourcePath)) throw new Error("context_source_forbidden");
    if (OBVIOUS_SECRET.test(candidate.content)) throw new Error("context_secret_detected");
    const sha256 = createHash("sha256").update(candidate.content).digest("hex");
    if (candidate.sha256 !== undefined && candidate.sha256 !== sha256) {
      throw new Error("context_hash_mismatch");
    }
    return {
      kind: candidate.kind,
      label: candidate.label.trim(),
      content: candidate.content,
      ...(sourcePath ? { sourcePath } : {}),
      sha256,
    };
  });

  const limitations = value.limitations.map((limitation) => {
    if (typeof limitation !== "string" || !limitation.trim() || limitation.length > 500) {
      throw new Error("context_limitation_invalid");
    }
    return limitation.trim();
  });

  return {
    objective: objective.trim(),
    summary: value.summary.trim(),
    items,
    limitations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isContextKind(value: unknown): value is CollaborationContextKind {
  return typeof value === "string"
    && (COLLABORATION_CONTEXT_KINDS as readonly string[]).includes(value);
}
