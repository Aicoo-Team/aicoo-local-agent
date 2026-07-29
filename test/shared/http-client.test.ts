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
