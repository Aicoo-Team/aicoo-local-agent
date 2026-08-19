import type { GoalPlan, GoalSubtaskPlan } from "../shared/goal-plan.js";

export type GoalSubtaskResult = {
  id: string;
  target: string;
  expectedOutput: string;
  correlationId: string;
  status: "completed" | "needs_owner" | "awaiting_approval" | "timed_out" | "failed";
  outcome?: "respond" | "needs_owner" | "propose_complete" | "failed";
  result?: string;
  error?: string;
};

export interface GoalRunResult {
  goalId: string;
  objective: string;
  status: "completed" | "needs_owner" | "pending" | "failed";
  subtasks: GoalSubtaskResult[];
}

export interface GoalRunnerDependencies {
  runSubtask(
    subtask: GoalSubtaskPlan,
    identifiers: { clientMessageId: string; correlationId: string },
  ): Promise<Omit<GoalSubtaskResult, "id" | "target" | "expectedOutput" | "correlationId">>;
}

export async function runGoalPlan(
  plan: GoalPlan,
  dependencies: GoalRunnerDependencies,
): Promise<GoalRunResult> {
  const subtasks = await Promise.all(
    plan.subtasks.map(async (subtask): Promise<GoalSubtaskResult> => {
      const correlationId = `goal:${plan.goalId}:${subtask.id}`;
      const base = {
        id: subtask.id,
        target: subtask.target,
        expectedOutput: subtask.expectedOutput,
        correlationId,
      };
      try {
        return {
          ...base,
          ...(await dependencies.runSubtask(subtask, {
            clientMessageId: correlationId,
            correlationId,
          })),
        };
      } catch (error) {
        return {
          ...base,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const status = subtasks.every((subtask) => subtask.status === "completed")
    ? "completed"
    : subtasks.some((subtask) => subtask.status === "needs_owner")
      ? "needs_owner"
      : subtasks.some(
          (subtask) => subtask.status === "awaiting_approval" || subtask.status === "timed_out",
        )
        ? "pending"
        : "failed";

  return { goalId: plan.goalId, objective: plan.objective, status, subtasks };
}
