// Port of uni-stack/uniwind-benchmarks (packages/benchmark + apps/uniwind/App.tsx), theme scenario.
// Same screen (header card + 1000 items = 2003 views), same config (10 runs, 100 ms between runs), same timing
// (performance.now() at the theme call until requestIdleCallback), same colours (global.css of apps/uniwind).
// Added on top, so the engine's async strategies are not flattered by a 0.1 ms JS return:
//   visual = setTheme call until the main thread finished mounting it (ThemeTimings.visualMs, reported by the NEXT call),
//   inspect = treeOK / nativeOK after the run.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Settings, StyleSheet, Text, View } from 'react-native';
import {
  ShadewindEngine,
  useThemedRef,
  type ThemeStrategy,
  type ThemedStyles,
} from 'shadewind/internal';

const RUNS = 10;
const ITEMS_COUNT = 1000;
const DELAY_BETWEEN_RUNS = 100;

const PRIMARY: ThemedStyles = {
  light: { backgroundColor: '#00a8ff' },
  dark: { backgroundColor: '#273c75' },
};
const GRAY: ThemedStyles = {
  light: { backgroundColor: '#f0f0f0' },
  dark: { backgroundColor: '#353b48' },
};
const TYPO: ThemedStyles = {
  light: { color: '#000000' },
  dark: { color: '#ffffff' },
};

function Typo({
  style,
  children,
}: {
  style: object;
  children: React.ReactNode;
}) {
  const ref = useThemedRef(TYPO);

  return (
    <Text ref={ref} style={[style, TYPO.light]}>
      {children}
    </Text>
  );
}

function Item({ index }: { index: number }) {
  const ref = useThemedRef(PRIMARY);

  return (
    <View ref={ref} style={[styles.item, PRIMARY.light]}>
      <Typo style={styles.itemText}>{index}</Typo>
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const ref = useThemedRef(GRAY);

  return (
    <View ref={ref} style={[styles.card, GRAY.light]}>
      {children}
    </View>
  );
}

type Result = {
  strategy: ThemeStrategy;
  js: number[];
  visual: number[];
  inspect: string;
  parts: string;
};

const avg = (v: number[]) =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
const med = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);

  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export default function TheirBench({
  auto = false,
  strategy: initialStrategy = 'hook',
}: {
  /** start the 10 theme changes by itself after the launch (their `-benchmarkScenario theme`) */
  auto?: boolean;
  strategy?: string;
}) {
  const launchStrategy = initialStrategy as ThemeStrategy;
  const [strategy, setStrategy] = useState<ThemeStrategy>(launchStrategy);
  const [run, setRun] = useState(RUNS); // idle until started
  const [result, setResult] = useState<Result | null>(null);
  const js = useRef<number[]>([]);
  const visual = useRef<number[]>([]);
  const parts = useRef<Array<Record<string, number | string | undefined>>>([]);
  const started = useRef(0);

  const start = () => {
    js.current = [];
    visual.current = [];
    parts.current = [];
    ShadewindEngine.setTheme('light', strategy); // unmeasured switch to light, like their harness
    setResult(null);
    setTimeout(() => setRun(0), 600);
  };

  // same protocol as their apps: `-benchmarkScenario theme` starts the 10 theme changes by itself after the launch
  useEffect(() => {
    if (auto) {
      const timer = setTimeout(start, 1000);

      return () => clearTimeout(timer);
    }

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (run >= RUNS) {
      return;
    }

    const timer = setTimeout(() => {
      const t0 = performance.now();
      const timings = ShadewindEngine.setTheme(
        run % 2 === 0 ? 'dark' : 'light',
        strategy
      );

      parts.current.push({
        clone: timings.cloneMs,
        props: timings.propsMs,
        commit: timings.commitMs,
        total: timings.totalMs,
        views: timings.views,
        reused: timings.reused,
        precloned: timings.precloned,
        misses: timings.misses,
      });

      // visualMs / paintMs of the call before this one are reported by this call
      if (run > 0 && timings.visualMs !== undefined) {
        visual.current.push(timings.visualMs);
      }

      // @ts-ignore requestIdleCallback exists on Hermes + RN
      requestIdleCallback(() => {
        js.current.push(performance.now() - t0);
        setRun((r) => r + 1);
      });
    }, DELAY_BETWEEN_RUNS);

    return () => clearTimeout(timer);
  }, [run, strategy]);

  useEffect(() => {
    if (run !== RUNS || js.current.length !== RUNS) {
      return;
    }

    // one more call reports the last switch's visualMs (re-applies the same theme, so it is a no-op change)
    const last = ShadewindEngine.setTheme(
      (RUNS - 1) % 2 === 0 ? 'dark' : 'light',
      strategy
    );

    if (last.visualMs !== undefined) {
      visual.current.push(last.visualMs);
    }

    setTimeout(() => {
      const r = ShadewindEngine.inspect();

      setResult({
        strategy,
        js: js.current,
        visual: visual.current,
        parts: (() => {
          const mean = (k: string) =>
            avg(parts.current.map((p) => Number(p[k] ?? 0))).toFixed(2);
          const last = parts.current[parts.current.length - 1];

          return `clone ${mean('clone')} props ${mean('props')} commit ${mean('commit')} total ${mean('total')} | views ${last?.views} reused ${last?.reused} misses ${last?.misses}`;
        })(),
        inspect: `theme=${r.theme} registered=${r.registered} treeOK=${r.treeMatchesExpected} viewOK=${r.nativePropsMatchExpected} layerOK=${r.layerMatchesExpected}`,
      });
    }, 1500);
  }, [run, strategy]);

  const running = run < RUNS;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Uniwind Benchmark (shadow engine port)</Text>

      <Card>
        <Typo style={styles.cardText}>
          {running
            ? `Run ${run + 1} of ${RUNS}`
            : result
              ? '✓ Benchmark Complete'
              : 'Idle'}
        </Typo>
        {result ? (
          <>
            <Typo
              style={styles.cardText}
            >{`JS-idle (their metric) avg: ${avg(result.js).toFixed(2)}ms`}</Typo>
            <Typo
              style={styles.cardText}
            >{`Min: ${Math.min(...result.js).toFixed(2)}ms  Max: ${Math.max(...result.js).toFixed(2)}ms  Median: ${med(result.js).toFixed(2)}ms`}</Typo>
            <Typo
              style={styles.cardText}
            >{`Visual (call to mounted) avg: ${avg(result.visual).toFixed(2)}ms  max: ${Math.max(0, ...result.visual).toFixed(2)}ms`}</Typo>
            <Typo style={styles.cardText}>{`${result.inspect}`}</Typo>
            <Typo style={styles.cardText}>{result.parts}</Typo>
            <Typo
              style={styles.cardSmall}
            >{`${ITEMS_COUNT * 2 + 3} views x ${RUNS} theme changes, ${result.strategy}`}</Typo>
          </>
        ) : null}
      </Card>

      <View style={styles.row}>
        {(['hook', 'hookAsync'] as ThemeStrategy[]).map((s) => (
          <Pressable
            key={s}
            testID={`their-${s}`}
            style={[styles.btn, strategy === s && styles.btnOn]}
            onPress={() => setStrategy(s)}
          >
            <Text style={styles.btnText}>{s}</Text>
          </Pressable>
        ))}
        <Pressable testID="their-run" style={styles.btn} onPress={start}>
          <Text style={styles.btnText}>Run</Text>
        </Pressable>
        <Pressable
          testID="their-dark"
          style={styles.btn}
          onPress={() => ShadewindEngine.setTheme('dark', strategy)}
        >
          <Text style={styles.btnText}>Dark</Text>
        </Pressable>
        <Pressable
          testID="their-light"
          style={styles.btn}
          onPress={() => ShadewindEngine.setTheme('light', strategy)}
        >
          <Text style={styles.btnText}>Light</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.grid}
        showsVerticalScrollIndicator={false}
      >
        {Array.from({ length: ITEMS_COUNT }, (_, i) => (
          <Item key={i} index={i} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, marginTop: 60, paddingHorizontal: 12 },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 16,
  },
  card: { padding: 16, borderRadius: 8, marginBottom: 16 },
  cardText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
  cardSmall: { fontSize: 14, textAlign: 'center', marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btn: { backgroundColor: '#555', padding: 8, borderRadius: 6 },
  btnOn: { backgroundColor: '#1a6fdc' },
  btnText: { color: '#fff' },
  grid: { gap: 8, flexDirection: 'row', flexWrap: 'wrap' },
  item: {
    width: '32%',
    height: 100,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemText: { fontWeight: 'bold', fontSize: 24 },
});
