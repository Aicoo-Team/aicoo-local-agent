export interface GoalSubtaskPlan {
  id: string;
  target: string;
  task: string;
  expectedOutput: string;
  project?: string;
  contextFile?: string;
}

export interface GoalPlan {
  goalId: string;
  objective: string;
  subtasks: GoalSubtaskPlan[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseGoalPlan(value: unknown): GoalPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("goal plan must be an object");
  }
  const input = value as Record<string, unknown>;
  const goalId = requiredString(input.goalId, "goalId", 64);
  if (!ID_PATTERN.test(goalId)) {
    throw new Error("goalId must use lowercase letters, numbers, hyphens, or underscores");
  }
  const objective = requiredString(input.objective, "objective", 4_000);
  if (!Array.isArray(input.subtasks) || input.subtasks.length === 0) {
    throw new Error("goal plan must contain at least one subtask");
  }
  if (input.subtasks.length > 10) throw new Error("goal plan cannot contain more than 10 subtasks");

  const ids = new Set<string>();
  const subtasks = input.subtasks.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`subtasks[${index}] must be an object`);
    }
    const subtask = raw as Record<string, unknown>;
    const id = requiredString(subtask.id, `subtasks[${index}].id`, 64);
    if (!ID_PATTERN.test(id)) throw new Error(`subtasks[${index}].id is invalid`);
    if (ids.has(id)) throw new Error(`duplicate subtask id: ${id}`);
    ids.add(id);
    const project = optionalString(subtask.project, `subtasks[${index}].project`, 1_024);
    const contextFile = optionalString(
      subtask.contextFile,
      `subtasks[${index}].contextFile`,
      4_096,
    );
    return {
      id,
      target: requiredString(subtask.target, `subtasks[${index}].target`, 256),
      task: requiredString(subtask.task, `subtasks[${index}].task`, 8_000),
      expectedOutput: requiredString(
        subtask.expectedOutput,
        `subtasks[${index}].expectedOutput`,
        1_000,
      ),
      ...(project ? { project } : {}),
      ...(contextFile ? { contextFile } : {}),
    };
  });

  return { goalId, objective, subtasks };
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}
