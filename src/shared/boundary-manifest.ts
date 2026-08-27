import { stableHash } from "./ids.js";

export interface BoundaryManifestInput {
  runtime: "claude-code" | "codex";
  adapterVersion: string;
  bridgeInstanceId: string;
  requesterPrincipalId: string;
  requesterDeviceId: string;
  grantId: string;
  grantRevision: number;
  preset: "read-project" | "edit-project";
  folders: readonly string[];
  writableFolders: readonly string[];
}

export interface BoundaryManifest {
  version: 1;
  runtime: BoundaryManifestInput["runtime"];
  adapterVersion: string;
  bridgeInstanceId: string;
  requesterPrincipalId: string;
  requesterDeviceId: string;
  grantId: string;
  grantRevision: number;
  preset: BoundaryManifestInput["preset"];
  folders: string[];
  writableFolders: string[];
  network: "deny";
}

export function createBoundaryManifest(input: BoundaryManifestInput): {
  manifest: BoundaryManifest;
  hash: string;
} {
  const folders = [...new Set(input.folders)].sort();
  const folderSet = new Set(folders);
  const writableFolders = [...new Set(input.writableFolders)]
    .filter((folder) => folderSet.has(folder))
    .sort();
  const manifest: BoundaryManifest = {
    version: 1,
    runtime: input.runtime,
    adapterVersion: input.adapterVersion,
    bridgeInstanceId: input.bridgeInstanceId,
    requesterPrincipalId: input.requesterPrincipalId,
    requesterDeviceId: input.requesterDeviceId,
    grantId: input.grantId,
    grantRevision: input.grantRevision,
    preset: input.preset,
    folders,
    writableFolders,
    network: "deny",
  };
  return { manifest, hash: stableHash(manifest) };
}
