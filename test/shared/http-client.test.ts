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
});
