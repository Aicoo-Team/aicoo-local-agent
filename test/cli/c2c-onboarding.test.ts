import { describe, expect, it, vi } from "vitest";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { AicooTransport } from "../../src/shared/aicoo-transport.js";

describe("C2C Onboarding Client Integration", () => {
  it("fetches pair status via AicooTransport", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
        json: async () => ({
        status: "accept_incoming",
        message: "They already asked to collaborate.",
      }),
    });

    const client = new AicooTransport({
      baseUrl: "https://www.aicoo.io",
      token: "test-token",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const res = await client.getPairStatus("target-principal-123");
    expect(res.status).toBe("accept_incoming");
    expect(res.message).toBe("They already asked to collaborate.");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.aicoo.io/api/v1/local-agent/pair-status?principalId=target-principal-123",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("resolves person handles via AicooTransport", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        principalId: "p-999",
        handle: "abhinav",
        displayName: "Abhinav Jain",
      }),
    });

    const client = new AicooTransport({
      baseUrl: "https://www.aicoo.io",
      token: "test-token",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const res = await client.resolvePerson("@abhinav");
    expect(res.principalId).toBe("p-999");
    expect(res.displayName).toBe("Abhinav Jain");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.aicoo.io/api/v1/local-agent/resolve-person?q=%40abhinav",
      expect.anything(),
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object without a principal", { handle: "abhinav" }],
    ["a blank principal", { principalId: "   ", handle: "abhinav" }],
  ])("rejects %s resolve-person responses with a useful error", async (_label, responseBody) => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responseBody,
    });
    const client = new AicooTransport({
      baseUrl: "https://www.aicoo.io",
      token: "test-token",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(client.resolvePerson("@abhinavjain2107")).rejects.toThrow(
      'Aicoo did not return a usable peer identity for "@abhinavjain2107"',
    );
  });

  it("normalizes whitespace around the resolved principal ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ principalId: "  p-999  ", handle: "abhinav" }),
    });
    const client = new AicooTransport({
      baseUrl: "https://www.aicoo.io",
      token: "test-token",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(client.resolvePerson("@abhinav")).resolves.toMatchObject({ principalId: "p-999" });
  });

  it("starts and polls device code flow via AicooTransport", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          userCode: "ABCD-1234",
          pollToken: "secret-poll-token",
          approvalUrl: "https://www.aicoo.io/local-agent/device-code?code=ABCD-1234",
          expiresAt: "2026-07-31T16:00:00Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "approved",
          deviceToken: "aicoo_sk_device_xyz",
          userId: "user-123",
        }),
      });

    const client = new AicooTransport({
      baseUrl: "https://www.aicoo.io",
      token: "anonymous",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const startRes = await client.startDeviceCode({
      deviceId: "device-1",
      runtime: "codex",
      bridgeVersion: "0.1.0",
      adapterVersion: "0.1.0",
      capabilities: ["comm:c2c"],
    });

    expect(startRes.userCode).toBe("ABCD-1234");
    expect(startRes.pollToken).toBe("secret-poll-token");

    const pollRes = await client.pollDeviceCode("secret-poll-token");
    expect(pollRes.status).toBe("approved");
    if (pollRes.status === "approved") {
      expect(pollRes.deviceToken).toBe("aicoo_sk_device_xyz");
    }
  });
});
