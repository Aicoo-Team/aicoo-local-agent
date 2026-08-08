import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { id } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import type { HttpMessageTransport } from "../shared/http-client.js";
import type { BridgeSpool, SpoolMessage } from "./spool.js";

export const MAX_INJECTION_ATTEMPTS = 5;

export interface InjectionHooks {
  beforeMessageInject(message: SpoolMessage["envelope"], targetSession: string): Promise<void>;
  beforeToolUse(
    action: { toolName: string; input: Record<string, unknown> },
    context: { nativeSessionHandle: string; communicationSessionId?: string },
  ): Promise<void>;
  beforeMessageEgress(
    response: { text: string; inReplyTo: string; correlationId: string },
    context: { nativeSessionHandle: string; serverSessionHandle: string; communicationSessionId: string },
  ): Promise<void>;
}

// These no-ops are integration seams, never security substitutes. P1 safety comes
// from the Claude adapter's tools-disabled receiver; policy-bearing hooks remain P2.
export const noOpInjectionHooks: InjectionHooks = {
  async beforeMessageInject() {
    await Promise.resolve();
  },
  async beforeToolUse() {
    await Promise.resolve();
  },
  async beforeMessageEgress() {
    await Promise.resolve();
  },
};

export class Injector {
  constructor(
    private readonly transport: HttpMessageTransport,
    private readonly spool: BridgeSpool,
    private readonly adapter: RuntimeAdapter,
    private readonly endpointId: string,
    private readonly serverToNativeHandle: ReadonlyMap<string, string>,
    private readonly hooks: InjectionHooks = noOpInjectionHooks,
  ) {}

  async runOnce(): Promise<void> {
    await this.flushPendingReports();
    await this.ackReceived();
    for (const message of this.spool.listInjectable()) await this.inject(message);
  }

  /**
   * Device-ack messages the event loop only stored (status 'received'). Doing this here — off
   * the SSE consumer, with retry — means a slow or failing control-plane ack can never wedge the
   * stream or stall the cursor. Expired messages are dropped so they never loop forever.
   */
  private async ackReceived(): Promise<void> {
    const now = Date.now();
    for (const message of this.spool.listReceived()) {
      if (new Date(message.envelope.expiresAt).getTime() <= now) {
        this.spool.markResult(message.messageId, "blocked", "expired_before_ack");
        continue;
      }
      try {
        await this.transport.acknowledgeDelivery({
          messageId: message.messageId,
          phase: "device_ack",
          attemptId: `device_ack:${message.messageId}`,
          retryable: false,
        });
        this.spool.markDeviceAcked(message.messageId);
      } catch {
        // Control plane slow/unavailable — leave 'received' and retry on the next runOnce.
      }
    }
  }

  private async flushPendingReports(): Promise<void> {
    for (const report of this.spool.listPendingReports()) {
      const message = this.spool.getMessage(report.messageId);
      if (!message || message.status === "blocked") {
        this.spool.markAttemptReported(report.attemptId);
        continue;
      }
      try {
        const validation = await this.transport.validateInjection({
          messageId: message.messageId,
          communicationSessionId: message.communicationSessionId,
          endpointId: this.endpointId,
          sessionHandle: message.sessionHandle,
        });
        if (!validation.valid) {
          this.spool.markResult(message.messageId, "blocked", validation.reason);
          this.spool.markAttemptReported(report.attemptId);
          continue;
        }
      } catch {
        return;
      }
      try {
        await this.transport.acknowledgeDelivery({
          messageId: report.messageId,
          phase: report.phase,
          attemptId: report.attemptId,
          resultCode: report.resultCode,
          retryable: report.retryable,
          runtimeAckId: report.runtimeAckId,
        });
        this.spool.markAttemptReported(report.attemptId);
        if (report.phase === "runtime_ack") {
          this.spool.markResult(report.messageId, "injected", undefined, report.runtimeAckId);
        }
      } catch {
        return;
      }
    }
  }

  private async inject(message: SpoolMessage): Promise<void> {
    if (message.attemptCount >= MAX_INJECTION_ATTEMPTS) {
      await this.reportFailure(message, "max_injection_attempts_exceeded", false);
      return;
    }
    let validation: { valid: true } | { valid: false; reason: string };
    try {
      validation = await this.transport.validateInjection({
        messageId: message.messageId,
        communicationSessionId: message.communicationSessionId,
        endpointId: this.endpointId,
        sessionHandle: message.sessionHandle,
      });
    } catch {
      this.spool.markResult(message.messageId, "blocked_offline", "control_plane_unavailable");
      return;
    }
    if (!validation.valid) {
      this.spool.markResult(message.messageId, "blocked", validation.reason);
      return;
    }
    const nativeHandle = this.serverToNativeHandle.get(message.sessionHandle);
    if (!nativeHandle) {
      await this.reportFailure(message, "session_not_found", false);
      return;
    }
    this.spool.markInjecting(message.messageId);
    let result: Awaited<ReturnType<RuntimeAdapter["deliverToSession"]>>;
    try {
      await this.hooks.beforeMessageInject(message.envelope, message.sessionHandle);
      result = await this.adapter.deliverToSession(
        nativeHandle,
        { ...message.envelope, trust: "untrusted_external_content" },
        "queue",
      );
    } catch {
      await this.reportFailure(message, "runtime_unavailable", true);
      return;
    }
    if (result.status === "runtime_acked") {
      const attemptId = id("attempt");
      this.spool.recordAttempt({
        attemptId,
        messageId: message.messageId,
        phase: "runtime_ack",
        retryable: false,
        runtimeAckId: result.runtimeAckId,
        createdAt: nowIso(),
      });
      this.spool.markResult(message.messageId, "injected_unreported", undefined, result.runtimeAckId);
      try {
        await this.transport.acknowledgeDelivery({
          messageId: message.messageId,
          phase: "runtime_ack",
          attemptId,
          retryable: false,
          runtimeAckId: result.runtimeAckId,
        });
        this.spool.markAttemptReported(attemptId);
        this.spool.markResult(message.messageId, "injected", undefined, result.runtimeAckId);
      } catch {
        // The local acceptance fact is retained and must never be recreated by reinjection.
      }
      return;
    }
    if (result.status === "queued_busy") {
      const attemptId = id("attempt");
      this.spool.recordAttempt({
        attemptId,
        messageId: message.messageId,
        phase: "runtime_pending",
        resultCode: result.status,
        retryable: true,
        createdAt: nowIso(),
      });
      this.spool.markResult(message.messageId, "runtime_pending", result.status);
      try {
        await this.transport.acknowledgeDelivery({
          messageId: message.messageId,
          phase: "runtime_pending",
          attemptId,
          resultCode: result.status,
          retryable: true,
        });
        this.spool.markAttemptReported(attemptId);
      } catch {
        // Revalidation is required before the next attempt, so this remains fail closed.
      }
      return;
    }
    await this.reportFailure(
      message,
      result.status,
      result.status === "runtime_unavailable",
    );
  }

  private async reportFailure(message: SpoolMessage, resultCode: string, retryable: boolean): Promise<void> {
    const attemptId = id("attempt");
    this.spool.recordAttempt({
      attemptId,
      messageId: message.messageId,
      phase: retryable ? "runtime_pending" : "runtime_failed",
      resultCode,
      retryable,
      createdAt: nowIso(),
    });
    this.spool.markResult(message.messageId, retryable ? "runtime_pending" : "failed", resultCode);
    try {
      await this.transport.acknowledgeDelivery({
        messageId: message.messageId,
        phase: retryable ? "runtime_pending" : "runtime_failed",
        attemptId,
        resultCode,
        retryable,
      });
      this.spool.markAttemptReported(attemptId);
    } catch {
      if (retryable) this.spool.markResult(message.messageId, "blocked_offline", "control_plane_unavailable");
    }
  }
}
