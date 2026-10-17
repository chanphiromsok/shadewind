import {
  Activity,
  Fragment,
  Suspense,
  createContext,
  memo,
  Profiler,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ShadewindEngine,
  useThemedRef,
  type ThemeStrategy,
  type ThemeTimings,
  type ThemedStyles,
} from 'shadewind/internal';

declare const performance: { now(): number };

type Theme = 'light' | 'dark';
type Mode = 'native' | 'react';

const CARD: ThemedStyles = {
  light: { backgroundColor: '#ffffff', borderColor: '#e5e5e5' },
  dark: { backgroundColor: '#111111', borderColor: '#333333' },
};

const renders = { count: 0 };

// Same idea as react-freeze / react-native-screens: suspend the subtree with a never-resolving promise.
function Suspender({
  freeze,
  children,
}: {
  freeze: boolean;
  children: ReactNode;
}) {
  const cache = useRef<{ promise?: Promise<void>; resolve?: () => void }>(
    {}
  ).current;

  if (freeze && !cache.promise) {
    cache.promise = new Promise<void>((resolve) => {
      cache.resolve = resolve;
    });
    throw cache.promise;
  } else if (freeze) {
    throw cache.promise;
  } else if (cache.promise) {
    cache.resolve?.();
    cache.promise = undefined;
  }

  return <Fragment>{children}</Fragment>;
}

function Freeze({
  freeze,
  children,
}: {
  freeze: boolean;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <Suspender freeze={freeze}>{children}</Suspender>
    </Suspense>
  );
}

function TestCard({ label }: { label: string }) {
  const ref = useThemedRef(CARD);

  return (
    <View ref={ref} style={[styles.card, CARD.light]}>
      <Text>{label}</Text>
    </View>
  );
}
const ThemeContext = createContext<Theme>('light');

// Native engine: style is registered per theme and swapped in C++. No React render on switch.
const NativeRow = memo(function NativeRow({
  i,
  clip,
}: {
  i: number;
  clip: boolean;
}) {
  renders.count++;
  const ref = useThemedRef(CARD);

  return (
    <View ref={ref} style={[styles.card, clip && styles.clipped, CARD.light]}>
      <Text>{`Native ${i}`}</Text>
    </View>
  );
});

// Baseline: the usual approach. Every row subscribes to context and re-renders on a switch.
const ReactRow = memo(function ReactRow({
  i,
  clip,
}: {
  i: number;
  clip: boolean;
}) {
  renders.count++;
  const theme = useContext(ThemeContext);

  return (
    <View style={[styles.card, clip && styles.clipped, CARD[theme]]}>
      <Text>{`React ${i}`}</Text>
    </View>
  );
});

function ThemeProvider({
  theme,
  children,
}: {
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}

export default function BenchScreen() {
  const [mode, setMode] = useState<Mode>('native');
  const [count, setCount] = useState<number>(300);
  const [clip, setClip] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [strategy, setStrategy] = useState<ThemeStrategy>('hook');
  const profMs = useRef(0);
  // frame pacing around the last cold switch: longest gap between two display callbacks before / after the switch call
  const pacing = useRef({ before: 0, after: 0, after1500: 0, remount: 0 });
  const [theme, setTheme] = useState<Theme>('light');
  const [report, setReport] = useState('no switch yet');
  const items = useRef(Array.from({ length: 1500 }, (_, i) => i)).current;

  const [frozen, setFrozen] = useState(false);
  const themeRef = useRef<Theme>('light');
  const taps = useRef(0);

  // One switch. Resolves once 8 frames after the switch were produced.
  const runOnce = (next: Theme) =>
    new Promise<{
      call: number;
      native?: ThemeTimings;
      renders: number;
      reactMs: number;
      worstGap: number;
    }>((resolve) => {
      const rendersBefore = renders.count;

      profMs.current = 0;

      const t0 = performance.now();
      let native: ThemeTimings | undefined;

      if (mode === 'native') {
        native = ShadewindEngine.setTheme(next, strategy);
      }

      const call = performance.now() - t0;

      themeRef.current = next;
      setTheme(next); // in 'react' mode this is what re-renders every row

      const stamps: number[] = [t0];
      const tick = () => {
        stamps.push(performance.now());

        if (stamps.length < 9) {
          requestAnimationFrame(tick);
          return;
        }

        const gaps = stamps.slice(1).map((v, i) => v - (stamps[i] as number));

        resolve({
          call,
          native,
          renders: renders.count - rendersBefore,
          reactMs: profMs.current,
          worstGap: Math.max(...gaps),
        });
      };

      requestAnimationFrame(tick);
    });

  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  const toggle = async () => {
    taps.current++;
    const r = await runOnce(themeRef.current === 'light' ? 'dark' : 'light');

    setReport(
      `${mode} tap#${taps.current} -> ${themeRef.current}: worst gap ${r.worstGap.toFixed(1)} | call ${r.call.toFixed(2)} | react ${r.reactMs.toFixed(1)} | renders ${r.renders}`
    );
  };

  const bench = async () => {
    const runs = [] as Awaited<ReturnType<typeof runOnce>>[];

    for (let i = 0; i < 12; i++) {
      runs.push(await runOnce(themeRef.current === 'light' ? 'dark' : 'light'));
      await new Promise<void>((done) => setTimeout(done, 150));
    }

    const warm = runs.slice(2); // drop 2 warm-up switches
    const n = (f: (x: (typeof runs)[number]) => number) =>
      median(warm.map(f)).toFixed(2);
    const nat =
      mode === 'native'
        ? ` | ${strategy}: scan ${median(warm.map((x) => x.native!.scanMs)).toFixed(2)} clone ${median(warm.map((x) => x.native!.cloneMs)).toFixed(2)} (props ${median(warm.map((x) => x.native!.propsMs)).toFixed(2)}, reused ${median(warm.map((x) => x.native!.reused ?? 0))}, visited ${median(warm.map((x) => x.native!.visited ?? 0))}, skipped ${median(warm.map((x) => x.native!.skipped ?? 0))}) commit ${median(warm.map((x) => x.native!.commitMs)).toFixed(2)} total ${median(warm.map((x) => x.native!.totalMs)).toFixed(2)}`
        : '';

    setReport(
      `BENCH ${mode} x${count}, median of ${warm.length}: worst gap ${n((x) => x.worstGap)} ms | JS call ${n((x) => x.call)} ms | React render ${n((x) => x.reactMs)} ms | renders ${n((x) => x.renders)}${nat}`
    );
  };

  const wait = (ms: number) =>
    new Promise<void>((done) => setTimeout(done, ms));

  // Freeze the test cards, switch the theme while they are frozen/hidden, then unfreeze.
  // After unfreezing, both cards must be dark (CARD.dark). A white card means the switch was lost.
  const frozenTest = async () => {
    setReport('frozen test: freezing...');
    setFrozen(true);
    await wait(400);
    setReport('frozen test: switching theme while frozen...');
    ShadewindEngine.setTheme('dark');
    themeRef.current = 'dark';
    setTheme('dark');
    await wait(400);
    setFrozen(false);
    await wait(600);
    setReport(
      'frozen test done: the two cards above must be DARK (theme switched while frozen)'
    );
  };

  const stats = (xs: number[]) => {
    const sorted = [...xs].sort((x, y) => x - y);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

    return {
      n: sorted.length,
      min: at(0),
      med: at(0.5),
      p90: at(0.9),
      max: sorted[sorted.length - 1] ?? 0,
      over10: sorted.filter((x) => x >= 10).length,
    };
  };

  const fmt = (label: string, xs: number[]) => {
    const t = stats(xs);

    return `${label} n=${t.n}: min ${t.min.toFixed(2)} med ${t.med.toFixed(2)} p90 ${t.p90.toFixed(2)} max ${t.max.toFixed(2)} | >=10ms: ${t.over10}/${t.n}`;
  };

  // First switch on a freshly mounted list: remount every row, give registration and pre-warm time to finish, then do the
  // first switch to dark. setTheme returns the stats of the PREVIOUS background commit, so the cold switch is read back by
  // the following call.
  const coldOnce = async (idleMs = 3000, hintMs = 0, strat: 'hookAsync' = 'hookAsync') => {
    ShadewindEngine.setTheme('light', strat);
    themeRef.current = 'light';
    setTheme('light');
    await wait(800);
    // validation of the probe: remounting 1500 rows is known to keep the main thread busy for hundreds of ms
    ShadewindEngine.resetMainBusy();
    await wait(50);
    ShadewindEngine.resetMainBusy();
    setEpoch((e) => e + 1);
    await wait(idleMs);

    const remount = ShadewindEngine.mainBusyMs();

    if (hintMs > 0) {
      // like onPressIn -> onPress: the hint comes a press-duration before the switch
      ShadewindEngine.prepare();
      await wait(hintMs);
    }

    // Do not switch while the main thread is still busy with the remount (a switch queued behind it measures the remount):
    // wait until a 150 ms window shows no busy period, up to 8 s.
    for (let k = 0; k < 50; k++) {
      ShadewindEngine.resetMainBusy();
      await wait(150);

      if (ShadewindEngine.mainBusyMs() < 3) {
        break;
      }
    }

    // Main-thread probe: the longest stretch the main run loop stayed busy (no return to sleep) in the 400 ms before the switch
    // (baseline) and the 300 ms after it. A 1500-view mount shows up as one long busy period; a JS timer cannot see it.
    ShadewindEngine.resetMainBusy();
    await wait(400);

    const before = ShadewindEngine.mainBusyMs();

    ShadewindEngine.resetMainBusy();
    ShadewindEngine.setTheme('dark', strat); // the cold switch
    await wait(300);

    const after = ShadewindEngine.mainBusyMs();

    await wait(1200);

    // same window extended to 1.5 s in case the mount is queued later than 300 ms
    const after1500 = ShadewindEngine.mainBusyMs();

    pacing.current = { before, after, after1500, remount };
    const t = ShadewindEngine.setTheme('light', strat);

    await wait(500);

    return t;
  };

  const coldTest = async () => {
    setReport('cold test: running...');
    const t = await coldOnce();

    setReport(
      `COLD first switch, fresh mount, ${count} views: commit ${t.commitMs.toFixed(2)} ms | to screen ${(t.visualMs ?? 0).toFixed(2)} ms | scan ${t.scanMs.toFixed(2)} clone ${t.cloneMs.toFixed(2)} (props ${t.propsMs.toFixed(2)}, reused ${t.reused ?? 0}, visited ${t.visited ?? 0})`
    );
  };

  const coldLoop = async (
    n = 10,
    idleMs = 3000,
    hintMs = 0,
    strat: 'hookAsync' = 'hookAsync'
  ) => {
    const paints: number[] = [];
    const paintText: string[] = [];
    const commits: number[] = [];
    const visuals: number[] = [];
    const gaps: number[] = [];
    const baseGaps: number[] = [];
    const detail: string[] = [];

    for (let i = 0; i < n; i++) {
      setReport(`cold x${n}: ${i}/${n}...`);
      const t = await coldOnce(idleMs, hintMs, strat);


      commits.push(t.commitMs);
      visuals.push(t.visualMs ?? 0);
      gaps.push(pacing.current.after);
      baseGaps.push(pacing.current.before);
      // commit ms, nodes taken from the pre-built buffer, props rebuilt ms, scan ms, clone ms
      detail.push(
        `${t.commitMs.toFixed(1)}c ${t.reused ?? 0}r ${t.propsMs.toFixed(1)}pr ${t.scanMs.toFixed(1)}s ${t.cloneMs.toFixed(1)}cl ${(t.visualMs ?? 0).toFixed(1)}v ${pacing.current.after.toFixed(1)}m/${pacing.current.after1500.toFixed(1)}M/${pacing.current.before.toFixed(1)}b/${pacing.current.remount.toFixed(0)}R${(t.reused ?? 0) < count ? ` miss[${t.misses}]` : ''}`
      );
    }

    setReport(
      `COLD[${strat}](idle ${idleMs}ms${hintMs ? `, hint ${hintMs}ms before` : ''}) ${count} views | ${fmt('commit', commits)} | ${fmt('to screen', visuals)} | main-thread busy after switch (run loop, ms): max ${Math.max(...gaps).toFixed(1)} med ${stats(gaps).med.toFixed(1)}, busy >16.7ms (a dropped frame): ${gaps.filter((g) => g > 16.7).length}/${gaps.length}; baseline busy before switch: max ${Math.max(...baseGaps).toFixed(1)}, >16.7ms: ${baseGaps.filter((g) => g > 16.7).length}/${baseGaps.length} || ${detail.join(' ; ')}`
    );
  };

  // 32 switches back to back (150 ms apart); setTheme returns the previous commit, so switch i+1 reports switch i.
  const warmLoop = async (n = 30) => {
    const commits: number[] = [];
    const visuals: number[] = [];
    const nextTheme = () => (themeRef.current === 'light' ? 'dark' : 'light');
    const switchOnce = () => {
      const next = nextTheme();
      const t = ShadewindEngine.setTheme(next, 'hookAsync');

      themeRef.current = next;
      setTheme(next);

      return t;
    };

    switchOnce();
    await wait(300);
    switchOnce(); // two warm-up switches: the node buffer is built after the first
    await wait(300);

    for (let i = 0; i < n + 1; i++) {
      const t = switchOnce();

      if (i > 0) {
        commits.push(t.commitMs);
        visuals.push(t.visualMs ?? 0);
      }

      await wait(150);
    }

    const worst = [...visuals]
      .map((v, i) => [v, commits[i]] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([v, c]) => `${v.toFixed(1)}v/${c.toFixed(1)}c`)
      .join(' ');

    setReport(
      `WARM ${count} views | ${fmt('commit', commits)} | ${fmt('to screen', visuals)} | worst to-screen/commit: ${worst}`
    );
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setTheme('light');
    themeRef.current = 'light';
    ShadewindEngine.setTheme('light');
    setReport('mode changed');
  };

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        {(['native', 'react'] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => switchMode(m)}
            style={[styles.tab, mode === m && styles.tabOn]}
          >
            <Text style={styles.buttonText}>{m}</Text>
          </Pressable>
        ))}
        <Pressable
          testID="bench-count"
          onPress={() => {
            setCount((c) => (c === 300 ? 1500 : 300));
            setReport('count changed');
          }}
          style={styles.tab}
        >
          <Text style={styles.buttonText}>{count}</Text>
        </Pressable>
        <Pressable
          testID="bench-strategy"
          onPress={() =>
            setStrategy((v) => (v === 'hook' ? 'hookAsync' : 'hook'))
          }
          style={styles.tab}
        >
          <Text style={styles.buttonText}>{strategy}</Text>
        </Pressable>
        <Pressable onPress={toggle} style={styles.button}>
          <Text style={styles.buttonText}>Switch</Text>
        </Pressable>
        <Pressable onPress={bench} style={styles.button}>
          <Text style={styles.buttonText}>Bench x12</Text>
        </Pressable>
      </View>
      <Text testID="bench-report" style={styles.report}>
        {report}
      </Text>
      <View style={styles.testRow}>
        <Freeze freeze={frozen}>
          <TestCard label="Freeze (Suspense)" />
        </Freeze>
        <Activity mode={frozen ? 'hidden' : 'visible'}>
          <TestCard label="Activity" />
        </Activity>
        <Pressable onPress={frozenTest} style={styles.tab}>
          <Text style={styles.buttonText}>Frozen</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setClip((v) => !v);
            setReport('clip changed');
          }}
          style={styles.tab}
        >
          <Text style={styles.buttonText}>{clip ? 'clip' : 'noclip'}</Text>
        </Pressable>
        <Pressable onPress={coldTest} style={styles.tab}>
          <Text style={styles.buttonText}>cold</Text>
        </Pressable>
        <Pressable
          testID="bench-cold10"
          onPress={() => coldLoop(10)}
          style={styles.tab}
        >
          <Text style={styles.buttonText}>cold x10</Text>
        </Pressable>
        <Pressable onPress={() => coldLoop(10, 400)} style={styles.tab}>
          <Text style={styles.buttonText}>cold x10 short idle</Text>
        </Pressable>
        <Pressable onPress={() => coldLoop(10, 3000, 80)} style={styles.tab}>
          <Text style={styles.buttonText}>cold x10 hinted</Text>
        </Pressable>
        <Pressable
          testID="bench-warm30"
          onPress={() => warmLoop(30)}
          style={styles.tab}
        >
          <Text style={styles.buttonText}>warm x30</Text>
        </Pressable>
      </View>
      <ThemeProvider theme={theme}>
        <Profiler
          id="rows"
          onRender={(_id, _phase, actual) => {
            profMs.current += actual;
          }}
        >
          <ScrollView key={`${mode}-${count}-${clip}-${epoch}`}>
            {items
              .slice(0, count)
              .map((i) =>
                mode === 'native' ? (
                  <NativeRow key={i} i={i} clip={clip} />
                ) : (
                  <ReactRow key={i} i={i} clip={clip} />
                )
              )}
          </ScrollView>
        </Profiler>
      </ThemeProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 60, backgroundColor: '#888888' },
  bar: { flexDirection: 'row', gap: 8, margin: 12 },
  tab: { padding: 12, borderRadius: 8, backgroundColor: '#555555' },
  tabOn: { backgroundColor: '#1d6fd1' },
  button: { flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#04ab52' },
  buttonText: { color: 'white', fontWeight: '600' },
  testRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    marginHorizontal: 6,
  },
  report: { marginHorizontal: 12, marginBottom: 8, fontSize: 11 },
  card: {
    margin: 6,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  // clipping lets iOS draw the border with Core Animation instead of rendering a bitmap per view
  clipped: { overflow: 'hidden' },
});
