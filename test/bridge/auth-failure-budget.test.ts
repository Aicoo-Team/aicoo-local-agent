import { describe, expect, it } from "vitest";
import { AuthenticationFailureBudget } from "../../src/bridge/auth-failure-budget.js";

describe("authentication failure budget", () => {
  it("turns sustained unrecoverable 401s into one fatal lifecycle event", () => {
    let now = 1_000;
    const budget = new AuthenticationFailureBudget({ timeoutMs: 300_000, now: () => now });

    expect(budget.recordFailure()).toMatchObject({ fatal: false, elapsedMs: 0 });
    now += 299_999;
    expect(budget.recordFailure()).toMatchObject({ fatal: false, elapsedMs: 299_999 });
    now += 1;
    expect(budget.recordFailure()).toMatchObject({ fatal: true, elapsedMs: 300_000 });
    now += 60_000;
    expect(budget.recordFailure()).toMatchObject({ fatal: false, alreadyReported: true });
  });

  it("resets after authentication recovers", () => {
    let now = 1_000;
    const budget = new AuthenticationFailureBudget({ timeoutMs: 100, now: () => now });
    budget.recordFailure();
    now += 99;
    budget.recordRecovery();
    now += 99;

    expect(budget.recordFailure()).toMatchObject({ fatal: false, elapsedMs: 0 });
  });
});
