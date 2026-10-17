import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Uniwind } from 'uniwind';
import { ShadewindEngine } from 'shadewind/internal';

// Measures a theme switch where it hurts, on the JS thread, and checks the shadow tree afterwards.
//
//   sync   JS time inside Uniwind.setTheme (the commit hook runs here for the sync strategy)
//   idle   setTheme call until the JS thread has nothing left to do (the metric of uniwind-benchmarks)
//   stall  longest gap between two timer ticks in the 350 ms after the call = the longest frame the JS thread dropped
//   tree   registered views whose shadow-node backgroundColor equals the current theme (engine.inspect), must be all of them
//
// The commit and the mount happen after the call returns: the engine commits on a background thread, so `idle` is small and the
// screen still catches up a few ms later. `stall` and `tree` show whether that was done correctly.

type ThemeName = 'light' | 'dark';
type Run = { sync: number; idle: number; stall: number };
type Report = { runs: Run[]; tree: string; theme: string };

const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));
const idle = () =>
  new Promise<void>((resolve) => {
    const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void) => void };

    if (g.requestIdleCallback) {
      g.requestIdleCallback(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const fmt = (n: number) => n.toFixed(2);

export async function measureSwitch(themes: [ThemeName, ThemeName], count: number): Promise<Report> {
  const runs: Run[] = [];

  for (let i = 0; i < count; i++) {
    await new Promise<void>((r) => setTimeout(() => r(), 300));

    const t0 = now();
    const done = idle();
    let last = t0;

    Uniwind.setTheme(themes[i % 2]!);

    const sync = now() - t0;
    let stall = sync;

    await done;

    const idleMs = now() - t0;

    while (now() - t0 < 350) {
      await tick();

      const t = now();

      stall = Math.max(stall, t - last);
      last = t;
    }

    runs.push({ sync, idle: idleMs, stall });
  }

  const report = ShadewindEngine.inspect();

  return {
    // the first switch is cold (props cache empty), report the warm ones
    runs: runs.slice(1),
    theme: report.theme,
    // views in frozen screens (`hidden`) are themed when they show, so they are not compared: right = visible ones
    tree: `${report.treeMatchesExpected ?? '?'}/${(report.inTree ?? 0) - (report.hidden ?? 0)}`,
  };
}

export function ThemeSwitchMeter({ themes = ['light', 'dark'], count = 12 }: { themes?: [ThemeName, ThemeName]; count?: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) {
      return;
    }

    running.current = true;
    setBusy(true);
    setReport(await measureSwitch(themes, count));
    setBusy(false);
    running.current = false;
  }, [themes, count]);

  const sync = report ? median(report.runs.map((r) => r.sync)) : 0;
  const idleMs = report ? median(report.runs.map((r) => r.idle)) : 0;
  const stall = report ? median(report.runs.map((r) => r.stall)) : 0;
  const worst = report ? Math.max(...report.runs.map((r) => r.stall)) : 0;

  return (
    <View className="gap-1 rounded-lg bg-card p-3">
      <Pressable testID="meter-run" onPress={run} disabled={busy}>
        <Text className="text-sm font-semibold text-foreground">{busy ? 'measuring...' : `Measure ${count} theme switches`}</Text>
      </Pressable>
      {report ? (
        <Text testID="meter-report" className="text-xs text-foreground">
          sync {fmt(sync)} ms | idle {fmt(idleMs)} ms | stall median {fmt(stall)} ms, worst {fmt(worst)} ms | tree {report.tree} ({report.theme})
        </Text>
      ) : null}
    </View>
  );
}
