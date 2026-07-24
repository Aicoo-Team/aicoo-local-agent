import { id } from "../../shared/ids.js";
import type { InboundMessage, RuntimeAdapter, RuntimeSessionDescriptor } from "../runtime-adapter.js";

interface FakeSession extends RuntimeSessionDescriptor {
  delivered: InboundMessage[];
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  static readonly adapterVersion = "fake-0.1.0";
  readonly adapterLabel = "[MOCK: FakeRuntimeAdapter]";
  readonly #sessions = new Map<string, FakeSession>();

  constructor(sessionCount = 1) {
    for (let index = 1; index <= sessionCount; index += 1) {
      const sessionHandle = `fake-session-${index}`;
      this.#sessions.set(sessionHandle, {
        sessionHandle,
        label: `Fake managed session ${index}`,
        state: "idle",
        allowInbound: true,
        delivered: [],
      });
    }
  }

  async capabilities() {
    return {
      listSessions: true,
      startSession: true,
      resumeSession: false,
      liveInject: true,
      midTurnSteer: false,
    };
  }

  async listSessions(): Promise<RuntimeSessionDescriptor[]> {
    return [...this.#sessions.values()].map(({ delivered: _delivered, ...session }) => ({ ...session }));
  }

  async *subscribeSessionEvents(_sessionHandle: string, _cursor?: string) {
    // P0 deliberately does not claim session-to-session reply capture.
    await Promise.resolve();
  }

  async deliverToSession(sessionHandle: string, message: InboundMessage, mode: "queue" | "new_turn" | "steer") {
    const session = this.#sessions.get(sessionHandle);
    if (!session || session.state === "closed") return { status: "session_not_found" } as const;
    if (!session.allowInbound) return { status: "inbound_disabled" } as const;
    if (mode === "steer") return { status: "steer_not_allowed" } as const;
    if (session.state === "busy") return { status: "queued_busy" } as const;
    session.delivered.push(structuredClone(message));
    return { status: "runtime_acked", runtimeAckId: id("fakeack") } as const;
  }

  setBusy(sessionHandle: string, busy = true): void {
    const session = this.#require(sessionHandle);
    session.state = busy ? "busy" : "idle";
  }

  setClosed(sessionHandle: string): void {
    this.#require(sessionHandle).state = "closed";
  }

  setInboundDisabled(sessionHandle: string, disabled = true): void {
    this.#require(sessionHandle).allowInbound = !disabled;
  }

  listDelivered(sessionHandle: string): InboundMessage[] {
    return this.#require(sessionHandle).delivered.map((message) => structuredClone(message));
  }

  #require(sessionHandle: string): FakeSession {
    const session = this.#sessions.get(sessionHandle);
    if (!session) throw new Error(`Unknown fake session: ${sessionHandle}`);
    return session;
  }
}
