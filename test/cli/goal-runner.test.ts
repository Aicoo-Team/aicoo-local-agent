import { describe, expect, it, vi } from "vitest";
import { runGoalPlan } from "../../src/cli/goal-runner.js";
import { parseGoalPlan } from "../../src/shared/goal-plan.js";

const plan = parseGoalPlan({
  goalId: "enterprise-proposal",
  objective: "Prepare an approved proposal for Acme",
  subtasks: [
    {
      id: "bd",
      target: "@bd",
      task: "Return customer context and budget",
      expectedOutput: "Customer brief",
    },
    {
      id: "engineering",
      target: "@engineering",
      task: "Assess SSO and private deployment feasibility",
      expectedOutput: "Technical feasibility report",
    },
  ],
});

describe("multi-agent goal runner", () => {
  it("dispatches independent subtasks with stable goal correlation IDs", async () => {
    const runSubtask = vi.fn(async () => ({
      status: "completed" as const,
      outcome: "propose_complete" as const,
      result: "done",
    }));

    const result = await runGoalPlan(plan, { runSubtask });

    expect(result.status).toBe("completed");
    expect(runSubtask).toHaveBeenCalledTimes(2);
    expect(runSubtask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "engineering" }),
      {
        clientMessageId: "goal:enterprise-proposal:engineering",
        correlationId: "goal:enterprise-proposal:engineering",
      },
    );
  });

  it("keeps owner escalation distinct from successful agent work", async () => {
    const result = await runGoalPlan(plan, {
      runSubtask: async (subtask) =>
        subtask.id === "bd"
          ? { status: "completed", result: "Customer brief" }
          : { status: "needs_owner", outcome: "needs_owner", result: "Approve delivery date" },
    });

    expect(result.status).toBe("needs_owner");
    expect(result.subtasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "engineering", status: "needs_owner" }),
      ]),
    );
  });

  it("rejects ambiguous or duplicate plans before contacting another agent", () => {
    expect(() =>
      parseGoalPlan({
        goalId: "launch",
        objective: "Launch enterprise plan",
        subtasks: [
          { id: "review", target: "@a", task: "Review positioning", expectedOutput: "Notes" },
          { id: "review", target: "@b", task: "Review feasibility", expectedOutput: "Report" },
        ],
      }),
    ).toThrow("duplicate subtask id: review");
  });
});
