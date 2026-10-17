import { useEffect, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { nativeResolver } from '../engineReport';
import { startup } from './startup';

// `-resolveBench 1`: Uniwind's class resolution, its own JS against the native resolver (cpp/css/StyleResolver.hpp), on this
// device, 5 s after launch. Add `-resolverOff 1` (src/boot.ts) for a launch with Uniwind's own resolution only.
//
//   launch   the class table in use and where it came from (prebuilt: built by shadewind/metro at bundle time; runtime: built
//            on the device), its size and native load time, how many of Uniwind's getStyles cache misses since launch were
//            resolved natively / by Uniwind's JS (the first screen included), and the first feed layout (src/bench/startup.ts)
//   parity   the table in use, before anything is rebuilt: every case resolved both ways and compared (same keys in the same
//            order, same values, dependencies, sum)
//   build    JS thread time to build the table on the device (styleTable.ts) and to load it natively, median of 5 rebuilds
//   resolve  per resolution (className x theme x state), Uniwind's resolveStyles against the native one on the cases the native
//            one answers (the rest stay with Uniwind's JS in the app too), both called directly: getStyles' cache is in front of
//            both in the app, so this is the cost of a cache miss. Every theme, resting and pressed, median of 5 passes.
//
// classNames: every class of the stylesheet on its own, and 400 random combinations of 2 to 7 classes (seeded).

type Status = ReturnType<NonNullable<typeof nativeResolver>['status']>;
type Debug = ReturnType<NonNullable<typeof nativeResolver>['debug']>;

type Result = {
  launch: Status;
  firstLayoutMs: number | string;
  cases: number;
  native: number;
  mismatches: number;
  firstMismatch?: string;
  buildMs: number;
  loadMs: number;
  /** all cases, Uniwind's JS */
  allUniwindUs: number;
  /** the cases the native resolver answers: Uniwind's JS, native */
  uniwindUs: number;
  nativeUs: number;
  error?: string;
};

const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const fmt = (n: number, digits = 2) => n.toFixed(digits);

// undefined and NaN are distinct values in a style: kept apart from null in the comparison
const encode = (result: { styles: Record<string, unknown>; dependencies: number[]; dependencySum: number }) =>
  JSON.stringify([
    Object.entries(result.styles).map(([key, value]) => [
      key,
      value === undefined ? '$u' : typeof value === 'number' && !Number.isFinite(value) ? `$${value}` : value,
    ]),
    result.dependencies,
    result.dependencySum,
  ]);

const context = { scopedTheme: null, rtl: null, variables: null };
const states = [undefined, { isPressed: true }];

const classNamesOf = (stylesheet: Record<string, unknown>) => {
  const names = Object.keys(stylesheet).sort();
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  return [
    ...names,
    ...Array.from({ length: 400 }, () =>
      Array.from({ length: 2 + Math.floor(random() * 6) }, () => names[Math.floor(random() * names.length)]).join(' ')
    ),
  ];
};

// every case both ways; which ones the native resolver answers
function parity({ store, uniwind, native }: Debug, classNames: string[]) {
  const runtime = store!.runtime;
  const width = runtime.screen.width;
  const previousTheme = runtime.currentThemeName;
  const answered: boolean[] = [];
  let mismatches = 0;
  let firstMismatch: string | undefined;

  try {
    for (const theme of Object.keys(store!.vars)) {
      runtime.currentThemeName = theme;

      for (const className of classNames) {
        for (const state of states) {
          const own = uniwind!(className, {}, state, context);
          const mine = native!(className, theme, width, state?.isPressed, undefined, undefined);

          answered.push(mine !== undefined);

          if (mine !== undefined && encode(mine) !== encode(own)) {
            mismatches++;
            firstMismatch ??= `${theme} "${className}" ${JSON.stringify(state)}: native ${encode(mine)} uniwind ${encode(own)}`;
          }
        }
      }
    }
  } finally {
    runtime.currentThemeName = previousTheme;
  }

  return { answered, mismatches, firstMismatch };
}

function run(): Result {
  const launch = nativeResolver!.status();
  const base = {
    launch,
    firstLayoutMs: startup.firstLayoutMs,
    cases: 0,
    native: 0,
    mismatches: 0,
    buildMs: 0,
    loadMs: 0,
    allUniwindUs: 0,
    uniwindUs: 0,
    nativeUs: 0,
  };

  if (launch.state === 'off') {
    return base;
  }

  // the table in use (the prebuilt one, if it was loaded), before anything is rebuilt
  let debug = nativeResolver!.debug();

  if (!debug.store || !debug.uniwind || !debug.native) {
    return { ...base, error: launch.error ?? launch.state };
  }

  const classNames = classNamesOf(debug.store.stylesheet);
  const checked = parity(debug, classNames);

  // a table built on the device, five times (build time), then its own parity and the timing
  const builds = Array.from({ length: 5 }, () => nativeResolver!.rebuild());

  debug = nativeResolver!.debug();

  if (!debug.native) {
    return { ...base, mismatches: checked.mismatches, firstMismatch: checked.firstMismatch, error: builds.at(-1)!.error };
  }

  const rebuilt = parity(debug, classNames);
  const { store, uniwind, native } = debug;
  const runtime = store!.runtime;
  const width = runtime.screen.width;
  const themes = Object.keys(store!.vars);
  const previousTheme = runtime.currentThemeName;
  const answered = rebuilt.answered;
  const nativeCount = answered.filter(Boolean).length;
  const allPasses: number[] = [];
  const uniwindPasses: number[] = [];
  const nativePasses: number[] = [];

  try {
    for (let pass = 0; pass < 5; pass++) {
      let t0 = now();

      for (const theme of themes) {
        runtime.currentThemeName = theme;

        for (const className of classNames) {
          for (const state of states) {
            uniwind!(className, {}, state, context);
          }
        }
      }

      allPasses.push(now() - t0);

      let i = 0;

      t0 = now();

      for (const theme of themes) {
        runtime.currentThemeName = theme;

        for (const className of classNames) {
          for (const state of states) {
            if (answered[i++]) {
              uniwind!(className, {}, state, context);
            }
          }
        }
      }

      uniwindPasses.push(now() - t0);
      i = 0;
      t0 = now();

      for (const theme of themes) {
        for (const className of classNames) {
          for (const state of states) {
            if (answered[i++]) {
              native!(className, theme, width, state?.isPressed, undefined, undefined);
            }
          }
        }
      }

      nativePasses.push(now() - t0);
    }
  } finally {
    runtime.currentThemeName = previousTheme;
  }

  const cases = themes.length * classNames.length * states.length;

  return {
    ...base,
    cases,
    native: nativeCount,
    mismatches: checked.mismatches + rebuilt.mismatches,
    firstMismatch: checked.firstMismatch ?? rebuilt.firstMismatch,
    buildMs: median(builds.map((b) => b.buildMs)),
    loadMs: median(builds.map((b) => b.loadMs)),
    allUniwindUs: (median(allPasses) * 1000) / cases,
    uniwindUs: nativeCount ? (median(uniwindPasses) * 1000) / nativeCount : 0,
    nativeUs: nativeCount ? (median(nativePasses) * 1000) / nativeCount : 0,
  };
}

const describe = (r: Result) => {
  const l = r.launch;
  const launch = `LAUNCH resolver ${l.state} table ${l.source ?? 'none'} (${l.classes} classes, ${fmt(l.tableBytes / 1024, 1)} KB, load ${fmt(
    l.loadMs
  )} ms) | getStyles misses native ${l.native} uniwind ${l.uniwind} | first feed layout ${String(r.firstLayoutMs)} ms`;

  if (l.state === 'off' || r.cases === 0) {
    return r.error ? `${launch} | RESOLVE unavailable: ${r.error}` : launch;
  }

  return `${launch} | RESOLVE ${r.cases} cases, ${r.native} native | parity mismatches ${r.mismatches} | device build ${fmt(
    r.buildMs
  )} ms + load ${fmt(r.loadMs)} ms | per resolution, native cases: uniwind ${fmt(r.uniwindUs)} us, native ${fmt(r.nativeUs)} us (x${fmt(
    r.uniwindUs / (r.nativeUs || 1),
    1
  )}) | all cases uniwind ${fmt(r.allUniwindUs)} us${r.firstMismatch ? ` | FIRST ${r.firstMismatch.slice(0, 400)}` : ''}`;
};

export function ResolveBench() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!Settings.get('resolveBench')) {
      return undefined;
    }

    const t = setTimeout(() => setText(nativeResolver ? describe(run()) : 'RESOLVE plain arm: no native resolver'), 5000);

    return () => clearTimeout(t);
  }, []);

  if (!text) {
    return null;
  }

  // plain styles: the overlay must not go through the resolver it measures
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 12, right: 12, top: 48, backgroundColor: '#000000cc', padding: 8, borderRadius: 8 }}>
      <Text testID="resolve-bench" style={{ color: '#ffffff', fontSize: 11 }}>
        {text}
      </Text>
    </View>
  );
}
