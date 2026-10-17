import { useEffect, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { nativeResolver } from 'shadewind/uniwind';

// `-resolveBench 1`: Uniwind's class resolution, its own JS against the native resolver (cpp/css/StyleResolver.hpp), on this
// device, 5 s after launch (the class table is built when the JS thread is first idle).
//
//   build    JS thread time to build the class table from Uniwind's stylesheet (styleTable.ts) and to load it natively,
//            median of 5 rebuilds; the first screen of the app is resolved by Uniwind's JS while it is not there yet
//   resolve  per resolution (className x theme x state), Uniwind's resolveStyles against the native one on the cases the native
//            one answers (the rest stay with Uniwind's JS in the app too), both called directly: getStyles' cache is in front of
//            both in the app, so this is the cost of a cache miss. Every theme, resting and pressed, median of 5 passes.
//   parity   every case resolved both ways and compared: same keys in the same order, same values, dependencies, sum
//
// classNames: every class of the stylesheet on its own, and 400 random combinations of 2 to 7 classes (seeded).

type Result = {
  buildMs: number;
  loadMs: number;
  classes: number;
  fallback: number;
  cases: number;
  native: number;
  /** all cases, Uniwind's JS */
  allUniwindUs: number;
  /** the cases the native resolver answers: Uniwind's JS, native */
  uniwindUs: number;
  nativeUs: number;
  mismatches: number;
  firstMismatch?: string;
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

function run(): Result {
  const builds = Array.from({ length: 5 }, () => nativeResolver.rebuild());
  const status = builds.at(-1)!;
  const { store, uniwind, native } = nativeResolver.debug();
  const base = {
    buildMs: median(builds.map((b) => b.buildMs)),
    loadMs: median(builds.map((b) => b.loadMs)),
    classes: status.classes,
    fallback: status.fallback,
  };

  if (!store || !uniwind || !native) {
    return {
      ...base,
      cases: 0,
      native: 0,
      allUniwindUs: 0,
      uniwindUs: 0,
      nativeUs: 0,
      mismatches: 0,
      error: status.error ?? status.state,
    };
  }

  const names = Object.keys(store.stylesheet).sort();
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const classNames = [
    ...names,
    ...Array.from({ length: 400 }, () =>
      Array.from({ length: 2 + Math.floor(random() * 6) }, () => names[Math.floor(random() * names.length)]).join(' ')
    ),
  ];
  const themes = Object.keys(store.vars);
  const states = [undefined, { isPressed: true }];
  const context = { scopedTheme: null, rtl: null, variables: null };
  const runtime = store.runtime;
  const width = runtime.screen.width;
  const previousTheme = runtime.currentThemeName;
  let mismatches = 0;
  let firstMismatch: string | undefined;
  let nativeCount = 0;
  const answered: boolean[] = [];
  const allPasses: number[] = [];
  const uniwindPasses: number[] = [];
  const nativePasses: number[] = [];

  try {
    // parity, and which cases resolve natively

    for (const theme of themes) {
      runtime.currentThemeName = theme;

      for (const className of classNames) {
        for (const state of states) {
          const own = uniwind(className, {}, state, context);
          const mine = native(className, theme, width, state?.isPressed, undefined, undefined);

          answered.push(mine !== undefined);

          if (mine !== undefined) {
            nativeCount++;

            if (encode(mine) !== encode(own)) {
              mismatches++;
              firstMismatch ??= `${theme} "${className}" ${JSON.stringify(state)}: native ${encode(mine)} uniwind ${encode(own)}`;
            }
          }
        }
      }
    }

    // timing: five passes each, alternating
    for (let pass = 0; pass < 5; pass++) {
      let t0 = now();

      for (const theme of themes) {
        runtime.currentThemeName = theme;

        for (const className of classNames) {
          for (const state of states) {
            uniwind(className, {}, state, context);
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
              uniwind(className, {}, state, context);
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
              native(className, theme, width, state?.isPressed, undefined, undefined);
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
    allUniwindUs: (median(allPasses) * 1000) / cases,
    uniwindUs: nativeCount ? (median(uniwindPasses) * 1000) / nativeCount : 0,
    nativeUs: nativeCount ? (median(nativePasses) * 1000) / nativeCount : 0,
    mismatches,
    firstMismatch,
  };
}

export function ResolveBench() {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!Settings.get('resolveBench')) {
      return undefined;
    }

    const t = setTimeout(() => setResult(run()), 5000);

    return () => clearTimeout(t);
  }, []);

  if (!result) {
    return null;
  }

  // plain styles: the overlay must not go through the resolver it measures
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 12, right: 12, top: 48, backgroundColor: '#000000cc', padding: 8, borderRadius: 8 }}>
      <Text testID="resolve-bench" style={{ color: '#ffffff', fontSize: 11 }}>
        {result.error
          ? `RESOLVE native resolver unavailable: ${result.error}`
          : `RESOLVE table ${result.classes} classes (${result.fallback} stay JS), build ${fmt(result.buildMs)} ms + load ${fmt(
              result.loadMs
            )} ms | ${result.cases} cases, ${result.native} native | per resolution, native cases: uniwind ${fmt(
              result.uniwindUs
            )} us, native ${fmt(result.nativeUs)} us (x${fmt(result.uniwindUs / (result.nativeUs || 1), 1)}) | all cases uniwind ${fmt(
              result.allUniwindUs
            )} us | parity mismatches ${result.mismatches}${
              result.firstMismatch ? ` FIRST ${result.firstMismatch.slice(0, 400)}` : ''
            }`}
      </Text>
    </View>
  );
}
