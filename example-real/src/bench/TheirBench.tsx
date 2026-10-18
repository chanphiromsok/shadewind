// The theme scenario of uni-stack/uniwind-benchmarks with Uniwind `className`s, so it measures what a Uniwind app gets. Same screen
// (a header card + 1000 items = 2003 views), same protocol (an unmeasured switch to light, then 10 changes 100 ms apart, each timed
// from Uniwind.setTheme until requestIdleCallback), same colours (the bench-* tokens in global.css). The switch is
// Uniwind.setTheme, as in an app: with the engine arm the adapter applies it (hookDeferred), with REAL_PLAIN=1 Uniwind re-renders.
//
// iOS launch arguments (the app shows this screen instead of the tabs):
//   -theirBench theme                 runs by itself 1 s after launch
//   -uniwindStrategy hookAsync        the engine's strategy on the Uniwind path (measuring only, __SHADEWIND_UNIWIND_STRATEGY__)
//   -theirBenchReader 1               adds one Text whose colour comes from useCSSVariable: a component React re-renders on a
//                                     switch, as almost every app has (status bar, navigation theme, icon colours)
//
// What it reports is the JavaScript thread only. The commit on a background thread (hookAsync) and the main thread's mount are not
// in it: see docs/BENCHMARK.md, "Uniwind with hookAsync".
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, Settings, Text, View } from 'react-native';
import { Uniwind, useCSSVariable } from 'uniwind';
import { ShadewindEngine } from 'shadewind/internal';

const RUNS = 10;
const ITEMS_COUNT = 1000;
const DELAY_BETWEEN_RUNS = 100;

const strategy = Settings.get('uniwindStrategy');

if (Settings.get('theirBench') && typeof strategy === 'string') {
  (globalThis as { __SHADEWIND_UNIWIND_STRATEGY__?: string }).__SHADEWIND_UNIWIND_STRATEGY__ = strategy;
}

const withReader = Boolean(Settings.get('theirBenchReader'));

const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const med = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);

  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

function Item({ index }: { index: number }) {
  return (
    <View className="h-25 w-[32%] items-center justify-center rounded-2xl bg-bench-primary">
      <Text className="text-2xl font-bold text-bench-typo">{index}</Text>
    </View>
  );
}

// a component React re-renders on a theme switch (useCSSVariable subscribes to the theme)
function Reader() {
  const color = useCSSVariable('--color-bench-typo') as string | undefined;

  return (
    <Text testID="their-reader" style={{ color, textAlign: 'center' }}>
      useCSSVariable reader
    </Text>
  );
}

// the engine's view of the tree after the run (dev tools build, engine arm); the plain arm has no engine
function treeCheck(): string {
  try {
    const r = ShadewindEngine.inspect();

    return `registered=${r.registered} treeOK=${r.treeMatchesExpected} viewOK=${r.nativePropsMatchExpected} layerOK=${r.layerMatchesExpected}`;
  } catch {
    return 'no engine report (plain arm, or no dev tools)';
  }
}

export function TheirBench() {
  const [run, setRun] = useState(RUNS); // idle until started
  const [result, setResult] = useState<{ js: number[]; tree: string } | null>(null);
  const js = useRef<number[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      js.current = [];
      Uniwind.setTheme('light'); // unmeasured, like their harness
      setTimeout(() => setRun(0), 600);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  useLayoutEffect(() => {
    if (run >= RUNS) {
      return undefined;
    }

    const timer = setTimeout(() => {
      const t0 = now();

      Uniwind.setTheme(run % 2 === 0 ? 'dark' : 'light');

      // @ts-ignore requestIdleCallback exists on Hermes + React Native
      requestIdleCallback(() => {
        js.current.push(now() - t0);
        setRun((r) => r + 1);
      });
    }, DELAY_BETWEEN_RUNS);

    return () => clearTimeout(timer);
  }, [run]);

  useEffect(() => {
    if (run !== RUNS || js.current.length !== RUNS) {
      return undefined;
    }

    // after the last mount has landed
    const timer = setTimeout(() => setResult({ js: js.current, tree: treeCheck() }), 1500);

    return () => clearTimeout(timer);
  }, [run]);

  const running = run < RUNS;
  const engineStrategy =
    (globalThis as { __SHADEWIND_UNIWIND_STRATEGY__?: string }).__SHADEWIND_UNIWIND_STRATEGY__ ?? 'default (hookDeferred)';

  return (
    <View className="mt-15 flex-1 px-3">
      <Text className="mb-4 text-center text-lg font-bold text-bench-typo">Uniwind Benchmark (className)</Text>

      <View className="mb-4 rounded-lg bg-bench-gray p-4">
        <Text className="mb-1 text-center text-[13px] font-semibold text-bench-typo">
          {running ? `Run ${run + 1} of ${RUNS}` : result ? '✓ Benchmark Complete' : 'Idle'}
        </Text>
        {result ? (
          <Text testID="their-result" className="text-center text-[13px] font-semibold text-bench-typo">
            {`JS idle avg ${avg(result.js).toFixed(2)} ms, median ${med(result.js).toFixed(2)} ms, min ${Math.min(...result.js).toFixed(2)}, max ${Math.max(...result.js).toFixed(2)}\n${result.tree}\nstrategy ${engineStrategy}${withReader ? ', with a useCSSVariable reader' : ''}\n${ITEMS_COUNT * 2 + 3} views x ${RUNS} theme changes`}
          </Text>
        ) : null}
      </View>

      {withReader ? <Reader /> : null}

      <ScrollView contentContainerStyle={{ gap: 8, flexDirection: 'row', flexWrap: 'wrap' }} showsVerticalScrollIndicator={false}>
        {Array.from({ length: ITEMS_COUNT }, (_, i) => (
          <Item key={i} index={i} />
        ))}
      </ScrollView>
    </View>
  );
}
