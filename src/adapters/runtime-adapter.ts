import type { MessageEnvelope } from "../shared/contracts.js";

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
  prepareCommunicationSession?(sessionHandle: string, communicationSessionId: string): Promise<void>;
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
          | "project_selection_required"
          | "project_access_not_found";
      }
  >;
}
