export interface ResourceUsageSample {
  cpuPercent: number;
  rssBytes: number;
}

export interface ResourceUsageDecision extends ResourceUsageSample {
  fatal: boolean;
  consecutiveHighCpuSamples: number;
}

export class ResourceUsageTracker {
  readonly #highCpuPercent: number;
  readonly #consecutiveLimit: number;
  #consecutiveHighCpuSamples = 0;
  #reported = false;

  constructor(options: { highCpuPercent: number; consecutiveLimit: number }) {
    this.#highCpuPercent = options.highCpuPercent;
    this.#consecutiveLimit = options.consecutiveLimit;
  }

  record(sample: ResourceUsageSample): ResourceUsageDecision {
    this.#consecutiveHighCpuSamples = sample.cpuPercent >= this.#highCpuPercent
      ? this.#consecutiveHighCpuSamples + 1
      : 0;
    const fatal = !this.#reported && this.#consecutiveHighCpuSamples >= this.#consecutiveLimit;
    if (fatal) this.#reported = true;
    return { ...sample, fatal, consecutiveHighCpuSamples: this.#consecutiveHighCpuSamples };
  }
}

export interface ResourceMonitor {
  stop(): void;
}

export function startResourceMonitor(options: {
  intervalMs?: number;
  highCpuPercent?: number;
  consecutiveLimit?: number;
  onSample?: (sample: ResourceUsageDecision & { sampledAt: string }) => void;
  onSustainedHighCpu?: (sample: ResourceUsageDecision) => void;
}): ResourceMonitor {
  const intervalMs = options.intervalMs ?? 30_000;
  const tracker = new ResourceUsageTracker({
    highCpuPercent: options.highCpuPercent ?? 80,
    consecutiveLimit: options.consecutiveLimit ?? 10,
  });
  let previousCpu = process.cpuUsage();
  let previousTime = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousTime);
    const usage = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    previousTime = now;
    const decision = tracker.record({
      cpuPercent: ((usage.user + usage.system) / 1_000 / elapsedMs) * 100,
      rssBytes: process.memoryUsage().rss,
    });
    options.onSample?.({ ...decision, sampledAt: new Date(now).toISOString() });
    if (decision.fatal) options.onSustainedHighCpu?.(decision);
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
