import { describe, expect, it, vi } from "vitest";
import { AicooTransport } from "../../src/shared/aicoo-transport.js";
import { ApiError } from "../../src/shared/http-client.js";

function transport(fetchImpl: typeof fetch, timeoutMs = 20) {
  return new AicooTransport({
    baseUrl: "https://example.test",
    token: "aicoo_sk_example",
    deviceId: "device-1",
    timeoutMs,
    fetchImpl,
  });
}

/** A fetch that respects the abort signal, so the transport's own timer decides the outcome. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
    })) as unknown as typeof fetch;
}

describe("hosted transport retry", () => {
  const delegationInput = {
    target: { kind: "person_default_runtime" as const, principalId: "peer" },
    task: "Create the file",
    sessionHandle: "rs-me",
    clientMessageId: "client-stable",
    correlationId: "correlation-stable",
  };

  it("recovers when the first attempt times out and the second succeeds", async () => {
    // This is the observed field failure: an attempt aborts at the cap, and the very next
    // request — on the socket the failed attempt just opened — succeeds.
    let call = 0;
    const fetchImpl = vi.fn(((_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch);

    await expect(transport(fetchImpl).heartbeatEndpoint("ep_1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives default heartbeats enough time for a slow development server", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((() => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(null, { status: 204 })), 6_000);
      })) as unknown as typeof fetch);
      const client = new AicooTransport({
        baseUrl: "https://example.test",
        token: "aicoo_sk_example",
        deviceId: "device-1",
        fetchImpl,
      });

      const heartbeat = client.heartbeatEndpoint("ep_1");
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(heartbeat).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts with a diagnosable reason instead of a bare AbortError", async () => {
    await expect(transport(hangingFetch()).heartbeatEndpoint("ep_1")).rejects.toThrow(
      /timed out after 20ms \(attempt 2\/2\).*POST .*\/endpoints\/ep_1\/heartbeat/,
    );
  });

  it("never retries an ApiError — a 401 must reach the token-revoked handler intact", async () => {
    const fetchImpl = vi.fn((() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      )) as unknown as typeof fetch);

    await expect(transport(fetchImpl).heartbeatEndpoint("ep_1")).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry acknowledgeDelivery — the injector is already the retry loop", async () => {
    // ackReceived() awaits this serially per stuck message, so an in-transport retry would
    // double the injector stall for every message still in 'received'.
    const fetchImpl = vi.fn(hangingFetch());
    await expect(
      transport(fetchImpl).acknowledgeDelivery({
        messageId: "msg_1",
        phase: "device_ack",
        attemptId: "device_ack:msg_1",
        retryable: false,
      }),
    ).rejects.toThrow(/timed out after 20ms \(attempt 1\/1\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows delegation submission to outlive the transport-wide timeout", async () => {
    // Regression: Pulse can legitimately need more than five seconds for routing,
    // grant, folder-access, and persistence checks before returning the receipt.
    const fetchImpl = vi.fn((async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({
        status: "grant_requested",
        communicationSession: {
          id: "comm-1",
          requesterId: "me",
          recipientId: "peer",
          target: { kind: "person_default_runtime", principalId: "peer" },
          replyEndpointId: "ep-me",
          replySessionHandle: "rs-me",
          requestedTtlMinutes: 30,
          status: "pending",
          requestedAt: new Date().toISOString(),
          requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        clientMessageId: delegationInput.clientMessageId,
        correlationId: delegationInput.correlationId,
        duplicate: false,
      });
    }) as unknown as typeof fetch);

    await expect(
      transport(fetchImpl, 10).delegateLocalAgentTask(delegationInput),
    ).resolves.toMatchObject({ status: "grant_requested", clientMessageId: "client-stable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows tool-approval creation to outlive the transport-wide timeout without duplicating it", async () => {
    const fetchImpl = vi.fn(((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({
        approvalId: "appr-1",
        status: "pending",
        decision: null,
      })), 30);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject((init.signal as AbortSignal).reason);
      });
    })) as unknown as typeof fetch);

    await expect(
      transport(fetchImpl, 10).requestToolApproval({
        communicationSessionId: "comm-1",
        sessionHandle: "rs-owner",
        messageId: "msg-1",
        toolName: "Edit",
        toolInputSummary: "Modify files",
      }),
    ).resolves.toMatchObject({ approvalId: "appr-1", status: "pending" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors the delegation-specific submission timeout across idempotent retries", async () => {
    const fetchImpl = vi.fn(hangingFetch());

    await expect(
      transport(fetchImpl, 100).delegateLocalAgentTask(delegationInput, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms \(attempt 2\/2\).*POST .*\/delegations/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const requestBodies = fetchImpl.mock.calls.map(([, init]) => init?.body);
    expect(requestBodies).toEqual([
      JSON.stringify(delegationInput),
      JSON.stringify(delegationInput),
    ]);
  });

  it("refuses to follow a cross-origin redirect that would strip the bearer token", async () => {
    const fetchImpl = vi.fn(((_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch);

    await transport(fetchImpl).heartbeatEndpoint("ep_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
