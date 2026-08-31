import { describe, expect, it } from "vitest";
import { IdlePollBackoff } from "../../src/bridge/idle-backoff.js";

describe("idle bridge polling backoff", () => {
  it("backs idle database polling off and immediately resets when work appears", () => {
    const backoff = new IdlePollBackoff({ minimumMs: 100, maximumMs: 2_000 });

    expect([false, false, false, false, false, false].map((worked) => backoff.next(worked)))
      .toEqual([200, 400, 800, 1_600, 2_000, 2_000]);
    expect(backoff.next(true)).toBe(100);
  });
});
