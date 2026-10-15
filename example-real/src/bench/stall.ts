// Theme-switch stall: the longest JS-thread gap in the 350 ms after each Uniwind.setTheme (same method as the tovtam runs).
import { Uniwind } from 'uniwind';

export type StallResult = { medianMs: number; worstMs: number; stalls: number[] };

const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

export async function runStall(switches = 12): Promise<StallResult> {
  const stalls: number[] = [];

  for (let i = 0; i < switches; i++) {
    await new Promise<void>((r) => setTimeout(() => r(), 300));
    let last = now();
    const t0 = last;

    Uniwind.setTheme(i % 2 === 0 ? 'dark' : 'light');

    let max = now() - t0;

    while (now() - t0 < 350) {
      await tick();
      const t = now();

      max = Math.max(max, t - last);
      last = t;
    }

    stalls.push(max);
  }

  Uniwind.setTheme('light');

  const sorted = stalls.slice(1).sort((a, b) => a - b); // first switch is cold
  const rounded = stalls.map((s) => Math.round(s));

  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(1),
    worstMs: +Math.max(...stalls.slice(1)).toFixed(1),
    stalls: rounded,
  };
}

// Their metric, for the real app: from the Uniwind.setTheme call until the JS thread is idle again. The stall chain above is
// bounded below by the timer cadence (about one frame); this one shows how much JS work a switch really causes.
export type IdleResult = { medianMs: number; syncMs: number; worstMs: number; runs: number[] };

const idle = () =>
  new Promise<void>((resolve) => {
    const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void) => void };

    if (g.requestIdleCallback) {
      g.requestIdleCallback(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });

export async function runIdle(switches = 12): Promise<IdleResult> {
  const runs: number[] = [];
  const syncs: number[] = [];

  for (let i = 0; i < switches; i++) {
    await new Promise<void>((r) => setTimeout(() => r(), 300));
    // same order as uniwind-benchmarks' useBenchmark: the idle callback is registered first, then the theme is changed
    const t0 = now();
    const done = idle();

    Uniwind.setTheme(i % 2 === 0 ? 'dark' : 'light');
    syncs.push(now() - t0);
    await done;
    runs.push(now() - t0);
  }

  Uniwind.setTheme('light');

  const med = (a: number[]) => [...a.slice(1)].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]!;

  return {
    medianMs: +med(runs).toFixed(2),
    syncMs: +med(syncs).toFixed(2),
    worstMs: +Math.max(...runs.slice(1)).toFixed(2),
    runs: runs.map((r) => +r.toFixed(1)),
  };
}
