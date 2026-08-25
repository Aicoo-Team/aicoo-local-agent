import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolApprovalGateway } from "../../src/shared/tool-approval.js";

const capturedConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../../src/adapters/codex/codex-adapter.js", () => ({
  CodexAdapter: class {
    static readonly adapterVersion = "test";

    constructor(config: Record<string, unknown>) {
      capturedConfigs.push(config);
    }

    close() {}
  },
}));

import { selectRuntimeAdapter } from "../../src/adapters/select-adapter.js";

describe("selectRuntimeAdapter Codex approvals", () => {
  const directories: string[] = [];

  afterEach(() => {
    capturedConfigs.length = 0;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("passes the approval gateway to the default Codex exec adapter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-select-approval-"));
    directories.push(directory);
    const codexPath = join(directory, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    chmodSync(codexPath, 0o700);
    const approvalGateway: ToolApprovalGateway = {
      async requestToolApproval() {
        return { approvalId: "approval-1", status: "allow", decision: "allow" };
      },
      async getToolApproval() {
        return { status: "allow", decision: "allow" };
      },
    };

    await selectRuntimeAdapter({
      kind: "codex",
      sessions: 1,
      spoolFile: join(directory, "bridge.spool"),
      workspace: directory,
      codexPath,
      approvalGateway,
    });

    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.approvalGateway).toBe(approvalGateway);
    expect(capturedConfigs[0]?.driver).toBeUndefined();
  });

  it("wires gated full-agent Codex through app-server and owner approvals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-select-full-codex-"));
    directories.push(directory);
    const codexPath = join(directory, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    chmodSync(codexPath, 0o700);
    const approvalGateway: ToolApprovalGateway = {
      async requestToolApproval() {
        return { approvalId: "approval-full", status: "allow", decision: "allow" };
      },
      async getToolApproval() {
        return { status: "allow", decision: "allow" };
      },
    };

    await selectRuntimeAdapter({
      kind: "codex",
      sessions: 1,
      spoolFile: join(directory, "bridge.spool"),
      workspace: directory,
      codexPath,
      approvalGateway,
      codexAppServer: true,
      capabilitySurface: "full-agent",
    });

    expect(capturedConfigs[0]).toMatchObject({
      approvalGateway,
      capabilitySurface: "full-agent",
      driver: expect.any(Object),
    });
  });
});
