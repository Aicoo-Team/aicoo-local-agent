import { describe, expect, it } from "vitest";
import { createBoundaryManifest } from "../../src/shared/boundary-manifest.js";

const input = {
  runtime: "claude-code" as const,
  adapterVersion: "claude-agent-sdk-1",
  bridgeInstanceId: "bridge_1",
  requesterPrincipalId: "prn_a",
  requesterDeviceId: "device_a",
  grantId: "grant_7",
  grantRevision: 7,
  preset: "edit-project" as const,
  folders: ["/srv/b", "/srv/a", "/srv/a"],
  writableFolders: ["/srv/b", "/outside"],
};

describe("kernel boundary manifest", () => {
  it("produces one deterministic hash from the normalized effective boundary", () => {
    const first = createBoundaryManifest(input);
    const second = createBoundaryManifest({
      ...input,
      folders: [...input.folders].reverse(),
      writableFolders: [...input.writableFolders].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.manifest).toMatchObject({
      folders: ["/srv/a", "/srv/b"],
      writableFolders: ["/srv/b"],
      network: "deny",
    });
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when security-relevant runtime or grant data changes", () => {
    const original = createBoundaryManifest(input).hash;
    expect(createBoundaryManifest({ ...input, grantRevision: 8 }).hash).not.toBe(original);
    expect(createBoundaryManifest({ ...input, folders: ["/srv/a"] }).hash).not.toBe(original);
    expect(createBoundaryManifest({ ...input, adapterVersion: "claude-agent-sdk-2" }).hash).not.toBe(original);
  });
});
