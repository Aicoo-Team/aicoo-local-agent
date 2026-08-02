import { describe, expect, it } from "vitest";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import {
  describeTimeoutTiming,
  eventLoopMaxMs,
  startEventLoopMonitor,
} from "../../src/shared/event-loop.js";

describe("timeout timing verdict", () => {
  it("blames the event loop when the abort timer overshot its deadline", () => {
    // setTimeout(fn, 5000) that runs 5900ms in means the loop was blocked ~900ms, so the
    // request itself may have been fine. Elapsed time alone cannot tell these apart.
    const verdict = describeTimeoutTiming(5_900, 5_000);
    expect(verdict).toContain("LOOP BLOCKED ~900ms");
    expect(verdict).toContain("may not have been slow");
  });

  it("blames the server when the timer fired on schedule", () => {
    const verdict = describeTimeoutTiming(5_010, 5_000);
    expect(verdict).toContain("loop healthy");
    expect(verdict).toContain("genuinely slow");
    expect(verdict).not.toContain("LOOP BLOCKED");
  });

  it("reports a real histogram once monitoring starts", () => {
    startEventLoopMonitor();
    startEventLoopMonitor(); // idempotent
    expect(Number.isNaN(eventLoopMaxMs())).toBe(false);
    expect(describeTimeoutTiming(5_010, 5_000)).toContain("worst loop delay so far");
  });
});

describe("error body reading", () => {
  it("preserves the real status when the error body is not JSON", async () => {
    // Regression: throwApiError did json() and fell back to text() in the catch. json()
    // consumes the stream even when it fails to parse, so the fallback threw
    // "TypeError: Body is unusable" and buried the actual status.
    const fetchImpl = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const transport = new HttpMessageTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      fetchImpl,
    });

    await expect(transport.whoami()).rejects.toMatchObject({
      status: 502,
      code: "http_error",
      body: "<html>502 Bad Gateway</html>",
    });
  });

  it("still parses a JSON error body", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "invalid_device_token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const transport = new HttpMessageTransport({
      baseUrl: "https://example.test",
      token: "aicoo_sk_example",
      fetchImpl,
    });

    await expect(transport.whoami()).rejects.toMatchObject({
      status: 401,
      code: "invalid_device_token",
    });
  });
});
