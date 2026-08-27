export const RELATIONSHIP_ACCESS_PRESETS = ["chat-only", "read-project", "edit-project"] as const;

export type RelationshipAccessPreset = typeof RELATIONSHIP_ACCESS_PRESETS[number];
export type FileAccessPreset = Exclude<RelationshipAccessPreset, "chat-only">;

export const PRESET_TOOLS: Readonly<Record<RelationshipAccessPreset, readonly string[]>> = {
  "chat-only": [],
  "read-project": ["Read", "Glob", "Grep", "GitStatus", "GitDiff", "GitLog"],
  "edit-project": [
    "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit",
    "GitStatus", "GitDiff", "GitLog", "GitAdd", "GitCommit",
  ],
};

export function isRelationshipAccessPreset(value: string): value is RelationshipAccessPreset {
  return (RELATIONSHIP_ACCESS_PRESETS as readonly string[]).includes(value);
}

export function isFileAccessPreset(value: string): value is FileAccessPreset {
  return value === "read-project" || value === "edit-project";
}

export function accessPresetSatisfies(
  approved: RelationshipAccessPreset,
  required: RelationshipAccessPreset,
): boolean {
  if (required === "chat-only") return true;
  return approved === "edit-project" || approved === required;
}

export function accessPresetAllowsTool(preset: RelationshipAccessPreset, tool: string): boolean {
  return PRESET_TOOLS[preset].includes(tool);
}

export function accessPresetForTool(tool: string): FileAccessPreset | undefined {
  if (["Write", "Edit", "NotebookEdit", "GitAdd", "GitCommit"].includes(tool)) return "edit-project";
  if (["Read", "Glob", "Grep", "GitStatus", "GitDiff", "GitLog"].includes(tool)) return "read-project";
  return undefined;
}

export function strongestAccessPreset(presets: readonly RelationshipAccessPreset[]): RelationshipAccessPreset {
  if (presets.includes("edit-project")) return "edit-project";
  if (presets.includes("read-project")) return "read-project";
  return "chat-only";
}
