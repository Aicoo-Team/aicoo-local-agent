import { describe, expect, it, vi } from "vitest";
import { AicooTransport } from "../../src/shared/aicoo-transport.js";
import { HttpMessageTransport, normalizeBearerToken } from "../../src/shared/http-client.js";

describe("bearer token normalization", () => {
  it("removes copied boundary whitespace and control bytes", () => {
    expect(normalizeBearerToken("\r\n\t aicoo_sk_example \u0000")).toBe("aicoo_sk_example");
    expect(normalizeBearerToken("\u00a0\u200baicoo_sk_example\ufeff")).toBe("aicoo_sk_example");
  });

  it("rejects empty and embedded invalid bytes", () => {
    expect(() => normalizeBearerToken(" \r\n\t ")).toThrow("must not be empty");
    expect(() => normalizeBearerToken("aicoo_sk_\r\nexample")).toThrow("invalid whitespace or control");
    expect(() => normalizeBearerToken("aicoo sk example")).toThrow("invalid whitespace or control");
    expect(() => normalizeBearerToken("aicoo_sk_\u200bexample")).toThrow("invalid whitespace or control");
  });

  it.each([
    ["flat transport", (fetchImpl: typeof fetch) => new HttpMessageTransport({
      baseUrl: "https://example.test",
      token: "\r\n aicoo_sk_example \t",
      fetchImpl,
    })],
    ["hosted transport", (fetchImpl: typeof fetch) => new AicooTransport({
      baseUrl: "https://example.test",
      token: "\r\n aicoo_sk_example \t",
      deviceId: "device-test",
      fetchImpl,
    })],
  ])("uses the normalized token in the %s authorization header", async (_label, makeTransport) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }));
    const transport = makeTransport(fetchMock as unknown as typeof fetch);

    await transport.requestJson("/health");

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ authorization: "Bearer aicoo_sk_example" });
  });
});

describe("hosted Aicoo transport", () => {
  it("posts relationship MCP acknowledgements to the local-agent API", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ policies: [] }));
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_dev_test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await transport.acknowledgeRelationshipMcpPolicies({
      policyIds: ["rmp-1"],
      revision: 7,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://example.test/api/v1/local-agent/relationship-mcp-policies/ack",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ policyIds: ["rmp-1"], revision: 7 }),
    });
  });

  it("maps a collaboration request without trying to load a grant that does not exist yet", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-agent/delegations")) {
        return Response.json({
          ok: true,
          status: "collaboration_requested",
          collaborationId: "collab-1",
          targetPrincipalId: "peer",
          message: "Waiting for task acceptance",
        }, { status: 202 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_dev_test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.delegateLocalAgentTask({
      target: { kind: "person_default_runtime", principalId: "peer" },
      task: "Review my pending diff",
      sessionHandle: "rs-me",
      clientMessageId: "client-1",
      correlationId: "corr-1",
    })).resolves.toMatchObject({
      status: "collaboration_requested",
      collaborationId: "collab-1",
      clientMessageId: "client-1",
      correlationId: "corr-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps the hosted flat delegated response into the client delegation contract", async () => {
    // Regression: ccd delegate crashed while reading result.communicationSession.id.
    const grant = hostedGrant({ status: "active" });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-agent/delegations")) {
        return Response.json({
          ok: true,
          status: "delegated",
          communicationSessionId: grant.commSessionId,
          messageId: "msg-1",
          deliveryId: "del-1",
          correlationId: "corr-1",
          duplicate: false,
          queuedAt: "2026-08-05T10:00:00.000Z",
        }, { status: 201 });
      }
      if (url.endsWith("/api/v1/local-agent/grants")) return Response.json([grant]);
      throw new Error(`Unexpected request ${url}`);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_dev_test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.delegateLocalAgentTask({
      target: { kind: "person_default_runtime", principalId: "peer" },
      task: "Create the file",
      sessionHandle: "rs-me",
      clientMessageId: "client-1",
      correlationId: "corr-1",
    })).resolves.toMatchObject({
      status: "delegated",
      communicationSession: { id: grant.commSessionId, status: "active" },
      receipt: { messageId: "msg-1", deliveryId: "del-1", status: "queued" },
      clientMessageId: "client-1",
      correlationId: "corr-1",
    });
  });

  it("maps the hosted flat grant-requested response and preserves the client retry identity", async () => {
    const grant = hostedGrant({ status: "pending" });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-agent/delegations")) {
        return Response.json({
          ok: true,
          status: "grant_requested",
          communicationSessionId: grant.commSessionId,
          targetPrincipalId: "peer",
          message: "Waiting for approval",
        }, { status: 202 });
      }
      if (url.endsWith("/api/v1/local-agent/grants")) return Response.json([grant]);
      throw new Error(`Unexpected request ${url}`);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_dev_test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.delegateLocalAgentTask({
      target: { kind: "person_default_runtime", principalId: "peer" },
      task: "Create the file",
      sessionHandle: "rs-me",
      clientMessageId: "client-1",
      correlationId: "corr-1",
    })).resolves.toMatchObject({
      status: "grant_requested",
      approvalKind: "collaboration",
      communicationSession: { id: grant.commSessionId, status: "pending" },
      clientMessageId: "client-1",
      correlationId: "corr-1",
    });
  });

  it("distinguishes a parked folder approval from a collaboration grant request", async () => {
    const grant = hostedGrant({ status: "active" });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-agent/delegations")) {
        return Response.json({
          ok: true,
          status: "folder_access_requested",
          communicationSessionId: grant.commSessionId,
          approvalId: "facc-1",
          messageId: "msg-parked",
          correlationId: "corr-1",
        }, { status: 202 });
      }
      if (url.endsWith("/api/v1/local-agent/grants")) return Response.json([grant]);
      throw new Error(`Unexpected request ${url}`);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_dev_test",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.delegateLocalAgentTask({
      target: { kind: "person_default_runtime", principalId: "peer" },
      task: "Create the file",
      sessionHandle: "rs-me",
      clientMessageId: "client-1",
      correlationId: "corr-1",
    })).resolves.toMatchObject({
      status: "folder_access_requested",
      approvalKind: "folder",
      approvalId: "facc-1",
      messageId: "msg-parked",
      communicationSession: { id: grant.commSessionId, status: "active" },
    });
  });

  it("reloads a device token rotated by another process", async () => {
    let persistedToken = "aicoo_dev_old";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && String(_input).endsWith("/endpoints")) {
        return Response.json({
          endpoint: { endpointId: "ep-1", principalId: "user-1", deviceId: "device-1" },
          deviceToken: "aicoo_dev_old",
        });
      }
      return new Response(null, { status: 204 });
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_user",
      deviceId: "device-1",
      loadToken: () => persistedToken,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await transport.registerEndpoint({
      runtime: "codex",
      bridgeVersion: "test",
      adapterVersion: "test",
      capabilities: [],
    });

    persistedToken = "aicoo_dev_rotated";
    await expect(transport.recoverAuthentication()).resolves.toEqual({ recovered: true, source: "credentials" });
    await transport.heartbeatEndpoint("ep-1");

    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      authorization: "Bearer aicoo_dev_rotated",
    });
  });

  it("re-registers once with the original credential when no newer token was persisted", async () => {
    let registrationCount = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      registrationCount += 1;
      expect(init?.headers).toMatchObject({ authorization: "Bearer aicoo_sk_user" });
      return Response.json({
        endpoint: { endpointId: "ep-1", principalId: "user-1", deviceId: "device-1" },
        deviceToken: registrationCount === 1 ? "aicoo_dev_old" : "aicoo_dev_new",
      });
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_user",
      deviceId: "device-1",
      loadToken: () => "aicoo_dev_old",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await transport.registerEndpoint({
      runtime: "codex",
      bridgeVersion: "test",
      adapterVersion: "test",
      capabilities: [],
    });

    const [first, second] = await Promise.all([
      transport.recoverAuthentication(),
      transport.recoverAuthentication(),
    ]);

    expect(first).toEqual({ recovered: true, source: "registration" });
    expect(second).toEqual(first);
    expect(registrationCount).toBe(2);

    // A heartbeat already in flight may report the old token's 401 just after the
    // event stream recovered. It must reuse the result, not rotate the token again.
    await expect(transport.recoverAuthentication()).resolves.toEqual(first);
    expect(registrationCount).toBe(2);
  });

  it("uses the local-agent identity endpoint for whoami", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ principalId: "user-1", deviceId: "device-1" }));
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      deviceId: "device-fallback",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.whoami()).resolves.toEqual({ principalId: "user-1", deviceId: "device-1" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/api/v1/local-agent/whoami");
  });

  it("falls back to the configured device id when identity omits one", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ principalId: "user-1" }));
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      deviceId: "device-fallback",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.whoami()).resolves.toEqual({ principalId: "user-1", deviceId: "device-fallback" });
  });

  it("uses the local-agent grants endpoint when listing relationships", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      deviceId: "device-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(transport.listCommunicationSessions()).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/api/v1/local-agent/grants");
  });

  it("passes through relationship policy update events from hosted SSE", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"cursor\":\"1\",\"type\":\"relationship.policy_update\",\"endpointId\":\"ep-1\",\"createdAt\":\"2026-08-01T00:00:00.000Z\",\"data\":{\"access\":\"read-project\"}}\n\n",
        ));
      },
    });
    let fetchCalls = 0;
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? Response.json({ endpoint: { endpointId: "ep-1", principalId: "user-1" }, deviceToken: "aicoo_dev_next" })
        : new Response(stream);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      deviceId: "device-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await transport.registerEndpoint({
      runtime: "codex",
      bridgeVersion: "test",
      adapterVersion: "test",
      capabilities: [],
    });
    const iterator = transport.subscribeEvents()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "relationship.policy_update", data: { access: "read-project" } },
      done: false,
    });
  });

  it("passes through trusted tool policy events from hosted SSE", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          "data: {\"cursor\":\"1\",\"type\":\"trusted_tool_policy.upserted\",\"endpointId\":\"ep-1\",\"createdAt\":\"2026-08-08T00:00:00.000Z\",\"data\":{\"policyId\":\"ttp-1\"}}\n\n",
          "data: {\"cursor\":\"2\",\"type\":\"trusted_tool_policy.revoked\",\"endpointId\":\"ep-1\",\"createdAt\":\"2026-08-08T00:01:00.000Z\",\"data\":{\"policyId\":\"ttp-1\"}}\n\n",
        ].join("")));
      },
    });
    let fetchCalls = 0;
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? Response.json({ endpoint: { endpointId: "ep-1", principalId: "user-1" }, deviceToken: "aicoo_dev_next" })
        : new Response(stream);
    });
    const transport = new AicooTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      deviceId: "device-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await transport.registerEndpoint({
      runtime: "codex",
      bridgeVersion: "test",
      adapterVersion: "test",
      capabilities: [],
    });
    const iterator = transport.subscribeEvents()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "trusted_tool_policy.upserted", data: { policyId: "ttp-1" } },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "trusted_tool_policy.revoked", data: { policyId: "ttp-1" } },
      done: false,
    });
  });
});

function hostedGrant(input: { status: "pending" | "active" }) {
  return {
    commSessionId: `comm-${input.status}`,
    requesterPrincipalId: "me",
    requesterDeviceId: "device-me",
    requesterReplyEndpointId: "ep-me",
    requesterReplySessionHandle: "rs-me",
    recipientPrincipalId: "peer",
    targetKind: "person_default_runtime" as const,
    targetOfferId: null,
    frozenEndpointId: input.status === "active" ? "ep-peer" : null,
    frozenSessionHandle: input.status === "active" ? "rs-peer" : null,
    status: input.status,
    requestedAt: "2026-08-05T09:00:00.000Z",
    requestExpiresAt: "2026-08-05T09:10:00.000Z",
    activatedAt: input.status === "active" ? "2026-08-05T09:01:00.000Z" : null,
    grantExpiresAt: input.status === "active" ? "2026-08-05T09:31:00.000Z" : null,
    revokedAt: null,
  };
}
