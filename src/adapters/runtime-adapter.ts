import type { MessageEnvelope } from "../shared/contracts.js";
import type { ContinuationCheckpoint, ContinuationStore } from "../shared/continuation-store.js";

export interface RuntimeSessionDescriptor {
  sessionHandle: string;
  label: string;
  state: "idle" | "busy" | "closed";
  allowInbound: boolean;
}

export type InboundMessage = MessageEnvelope & {
  trust: "untrusted_external_content";
};

export interface RuntimeAdapter {
  configureContinuationStore?(store: ContinuationStore): void;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
  capabilities(): Promise<{
    listSessions: boolean;
    startSession: boolean;
    resumeSession: boolean;
    liveInject: boolean;
    midTurnSteer: boolean;
    replyEvents?: boolean;
  }>;
  listSessions(): Promise<RuntimeSessionDescriptor[]>;
  subscribeSessionEvents(
    sessionHandle: string,
    cursor?: string,
  ): AsyncIterable<{
    cursor?: string;
    type: "turn_started" | "reply" | "turn_failed" | "session_closed";
    inReplyTo?: string;
    correlationId?: string;
    payload?: Record<string, unknown>;
  }>;
  releaseCommunicationSession?(communicationSessionId: string): Promise<void>;
  invalidateRelationshipSessions?(principalId: string, deviceId: string): Promise<void>;
  prepareCommunicationSession?(sessionHandle: string, communicationSessionId: string): Promise<void>;
  canActivateContinuation?(checkpoint: ContinuationCheckpoint): Promise<boolean>;
  attestBoundaryActivation?(input: {
    continuationId: string;
    grantId: string;
    grantRevision: number;
    canonicalFolder: string;
    accessPreset: "read-project" | "edit-project";
  }): Promise<string | undefined>;
  quiesceContinuation?(checkpoint: ContinuationCheckpoint): Promise<void>;
  rebuildContinuation?(checkpoint: ContinuationCheckpoint): Promise<{ boundaryManifestHash: string }>;
  resumeContinuation?(checkpoint: ContinuationCheckpoint): Promise<{ status: string; runtimeAckId?: string }>;
  deliverToSession(
    sessionHandle: string,
    message: InboundMessage,
    mode: "queue" | "new_turn" | "steer",
  ): Promise<
    | { status: "runtime_acked"; runtimeAckId: string }
    | {
        status:
          | "queued_busy"
          | "session_not_found"
          | "inbound_disabled"
          | "steer_not_allowed"
          | "runtime_unavailable"
          | "unsupported"
          | "permission_required"
          | "project_access_required"
          | "project_selection_required"
          | "project_access_not_found";
      }
  >;
}
