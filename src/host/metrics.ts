/** Process-local timings only: no contents, identities or persistent traces. */
export class ObserverMetrics {
  private readonly buckets = new Map<string, { count: number; totalMs: number; maxMs: number; recent: number[]; next: number }>();
  record(name: 'observer' | 'tool-dispatch-extra' | 'snapshot' | 'flush', milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const bucket = this.buckets.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, recent: [], next: 0 };
    bucket.count++; bucket.totalMs += milliseconds; bucket.maxMs = Math.max(bucket.maxMs, milliseconds);
    bucket.recent[bucket.next] = milliseconds; bucket.next = (bucket.next + 1) % 512;
    this.buckets.set(name, bucket);
  }
  snapshot() {
    return { source: 'actual-host-process', unit: 'ms', windowLimit: 512,
      boundary: 'Full synchronous observer callbacks, the exclusive enter/exit time of the actual tools/execute wrapper, snapshot requests and awaited storage flush. Tool/model execution is excluded from dispatch-extra. These are local measurements, not a controlled provider benchmark.',
      timings: Object.fromEntries([...this.buckets].map(([name, bucket]) => {
        const sorted = [...bucket.recent].sort((a, b) => a - b);
        const quantile = (fraction: number) => sorted[Math.ceil((sorted.length - 1) * fraction)]!;
        return [name, { count: bucket.count, totalMs: bucket.totalMs, meanMs: bucket.totalMs / bucket.count, maxMs: bucket.maxMs,
          recentSamples: sorted.length, recentP50Ms: quantile(0.5), recentP95Ms: quantile(0.95) }];
      })) };
  }
}
