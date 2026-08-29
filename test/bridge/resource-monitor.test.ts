import { describe, expect, it } from "vitest";
import { ResourceUsageTracker } from "../../src/bridge/resource-monitor.js";

describe("bridge resource usage tracker", () => {
  it("flags sustained bridge CPU burn but ignores a single busy sample", () => {
    const tracker = new ResourceUsageTracker({ highCpuPercent: 80, consecutiveLimit: 3 });

    expect(tracker.record({ cpuPercent: 95, rssBytes: 100 })).toMatchObject({ fatal: false });
    expect(tracker.record({ cpuPercent: 10, rssBytes: 100 })).toMatchObject({ fatal: false });
    expect(tracker.record({ cpuPercent: 90, rssBytes: 100 })).toMatchObject({ fatal: false });
    expect(tracker.record({ cpuPercent: 91, rssBytes: 100 })).toMatchObject({ fatal: false });
    expect(tracker.record({ cpuPercent: 92, rssBytes: 100 })).toMatchObject({ fatal: true });
  });
});
