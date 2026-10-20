import { ShadewindEngine, type ResolvedStyles } from '../internal';
import { buildStyleTable, type UniwindStyle } from './styleTable';

// Uniwind's class resolution, natively (cpp/css/StyleResolver.hpp). Uniwind caches resolveStyles' result per className, state
// and theme (UniwindStore.getStyles); this replaces what runs on a cache miss: the first render of a className, a new
// pressed / focused state, a new theme, a new screen width.
//
// The table is Uniwind's stylesheet evaluated once per theme (styleTable.ts). It comes from one of two places:
//
// - prebuilt: shadewind/metro builds it while Metro bundles and appends it to Uniwind's CSS module, which hands it over right
//   after Uniwind loaded the stylesheet (registerPrebuiltStyleTable in install.ts). Loading it is a native parse, so it is used
//   from install on, first screen included. Classes that read the pixel ratio or hairline width are not in it (unknown at bundle
//   time); if there are any, the table is rebuilt on the device when the JS thread is idle;
// - runtime: built on the device when the JS thread is idle (no prebuilt table, or a stale one).
//
// A resolution goes native only when:
//
// - there is no scoped theme and no scoped variables (Uniwind's context): the table has neither,
// - the table is current: updateCSSVariables notifies Variables, and a CSS reload (development) replaces the stylesheet and
//   variables and then notifies every dependency (UniwindStore.reinit calls UniwindListener.notifyAll in __DEV__); either marks
//   the table stale until it is rebuilt (the subscription in installNativeResolver),
// - every class of the className is in the table (natively: otherwise the native call answers undefined).
//
// Anything else, and any error, runs Uniwind's own resolveStyles, which is kept and called as before.

type Getter = (vars: Record<string, unknown>) => unknown;
type Resolve = (
  classNames: string,
  componentProps: unknown,
  state: any,
  context: any
) => ResolvedStyles;
type NativeResolve = (
  className: string,
  theme: string,
  screenWidth: number,
  isPressed?: unknown,
  isFocused?: unknown,
  isDisabled?: unknown
) => ResolvedStyles | undefined;

/** The parts of Uniwind 1.12's UniwindStore the resolver reads (core/native/store.ts). */
export type ResolverStore = {
  stylesheet: Record<string, UniwindStyle[]>;
  vars: Record<string, Record<string, Getter>>;
  runtime: { currentThemeName: string; screen: { width: number } } & Record<
    string,
    unknown
  >;
  resolveStyles: Resolve;
};

export type ResolverListener = {
  subscribe: (listener: () => void, dependencies: number[]) => () => void;
  getSnapshot?: (dependencies: number[]) => number;
};

/** A table built at bundle time, with the store state it was handed over with (registerPrebuiltStyleTable). */
export type PrebuiltTable = {
  json: string;
  /** classes Uniwind's JS keeps resolving */
  fallback: number;
  /** of those, classes left out because they read device-fixed runtime fields: a table built on the device can hold them */
  deviceDependent: number;
  stylesheet: unknown;
  vars: unknown;
  /** UniwindListener's Variables revision then: a change before install makes the table stale */
  variablesRevision: number | undefined;
};

export type ResolverStatus = {
  /** off: not installed or disabled; waiting: the table is not built yet; stale: built from other variables, rebuilding. */
  state: 'off' | 'waiting' | 'ready' | 'stale' | 'failed';
  /** where the table in use came from */
  source: 'prebuilt' | 'runtime' | null;
  /** classes in the table / classes Uniwind's JS keeps resolving (post-processed or runtime-dependent values, data / rtl variants). */
  classes: number;
  fallback: number;
  /** size of the table's JSON */
  tableBytes: number;
  /** JS thread time of the last build on the device (styleTable.ts; 0 for a prebuilt table) and of loading it natively (parse). */
  buildMs: number;
  loadMs: number;
  builds: number;
  /** cache misses of Uniwind's getStyles since launch: resolved natively / by Uniwind's JS */
  native: number;
  uniwind: number;
  error?: string;
};

const REBUILD_DELAY_MS = 500;

const status: ResolverStatus = {
  state: 'off',
  source: null,
  classes: 0,
  fallback: 0,
  tableBytes: 0,
  buildMs: 0,
  loadMs: 0,
  builds: 0,
  native: 0,
  uniwind: 0,
};
let store: ResolverStore | null = null;
let original: Resolve | null = null;
let listener: ResolverListener | null = null;
let variablesDependency = -1;
let nativeResolve: NativeResolve | null = null;
let enabled = true;
let stale = true;
// a prebuilt table without device-dependent classes: rebuild on the device when idle to add them
let upgrade = false;
let scheduled = false;
let prebuilt: PrebuiltTable | null = null;

const now = () =>
  (
    globalThis as unknown as { performance: { now(): number } }
  ).performance.now();

// React Native defines requestIdleCallback
const whenIdle = (callback: () => void, delayMs: number) => {
  const { requestIdleCallback } = globalThis as unknown as {
    requestIdleCallback: (cb: () => void, options: { timeout: number }) => void;
  };

  setTimeout(() => requestIdleCallback(callback, { timeout: 2000 }), delayMs);
};

const schedule = (delayMs: number) => {
  if (scheduled || !store) {
    return;
  }

  scheduled = true;
  whenIdle(() => {
    scheduled = false;

    if (enabled && (stale || upgrade)) {
      rebuild();
    }
  }, delayMs);
};

// what status() reports: a table in use while disabled reads 'off' (load always records 'ready')
const snapshot = (): ResolverStatus => ({
  ...status,
  state: !enabled && status.state === 'ready' ? 'off' : status.state,
});

// loads a table natively; true when it is in use
const load = (json: string, source: 'prebuilt' | 'runtime'): boolean => {
  stale = true;
  nativeResolve = null;

  const t0 = now();
  const result = ShadewindEngine.loadStyleTable(json);
  const global = globalThis as { __swResolve?: NativeResolve };

  status.loadMs = now() - t0;

  if (!result.ok || result.unsupported > 0 || !global.__swResolve) {
    status.state = 'failed';
    status.error =
      result.error ??
      `${result.unsupported} classes of the table could not be read natively`;
    return false;
  }

  nativeResolve = global.__swResolve;
  stale = false;
  status.source = source;
  status.state = 'ready';
  status.tableBytes = json.length;
  status.classes = result.classes;
  status.error = undefined;

  return true;
};

// the prebuilt table, if it belongs to the store as it is now
const loadPrebuilt = (): boolean => {
  const table = prebuilt;

  if (!table || !store || !enabled) {
    return false;
  }

  const revision = listener?.getSnapshot?.([variablesDependency]);

  if (
    table.stylesheet !== store.stylesheet ||
    table.vars !== store.vars ||
    revision !== table.variablesRevision
  ) {
    prebuilt = null;
    return false;
  }

  prebuilt = null;

  try {
    if (!load(table.json, 'prebuilt')) {
      return false;
    }
  } catch (error) {
    status.state = 'failed';
    status.error = String(error);
    return false;
  }

  status.fallback = table.fallback;
  status.buildMs = 0;

  if (table.deviceDependent > 0) {
    upgrade = true;
    schedule(REBUILD_DELAY_MS);
  }

  return true;
};

/** Builds the table from the store now, on the device, and loads it natively (normally done when idle). */
export function rebuild(): ResolverStatus {
  if (!store) {
    return snapshot();
  }

  const current = store;

  upgrade = false;

  try {
    const t0 = now();
    const table = buildStyleTable({
      stylesheet: current.stylesheet,
      varsByTheme: current.vars,
      themes: Object.keys(current.vars),
      runtime: current.runtime,
    });

    status.buildMs = now() - t0;
    status.fallback = table.fallback;
    status.builds++;
    load(table.json, 'runtime');
  } catch (error) {
    stale = true;
    nativeResolve = null;
    status.state = 'failed';
    status.error = String(error);
  }

  return snapshot();
}

function resolveStyles(
  this: ResolverStore,
  classNames: string,
  componentProps: unknown,
  state:
    | { isPressed?: unknown; isFocused?: unknown; isDisabled?: unknown }
    | undefined,
  context: { scopedTheme: unknown; variables?: unknown }
): ResolvedStyles {
  // `stale` is false only while `nativeResolve` holds a loaded table (load)
  if (
    !stale &&
    enabled &&
    context.scopedTheme === null &&
    context.variables === null
  ) {
    try {
      const result = nativeResolve!(
        classNames,
        this.runtime.currentThemeName,
        this.runtime.screen.width,
        state?.isPressed,
        state?.isFocused,
        state?.isDisabled
      );

      if (result !== undefined) {
        status.native++;
        return result;
      }
    } catch {
      // Uniwind's own below
    }
  }

  status.uniwind++;
  return original!.call(this, classNames, componentProps, state, context);
}

/** Called by install.ts with the table shadewind/metro built at bundle time (see registerPrebuiltStyleTable). */
export function offerPrebuiltTable(table: PrebuiltTable) {
  prebuilt = table;

  // a CSS reload in development, after install: the new table replaces the old one at once
  if (store) {
    loadPrebuilt();
  }
}

/**
 * Puts the native resolver in front of Uniwind's resolveStyles (once): with the prebuilt table if there is one for the store as it
 * is now, otherwise with a table built when the JS thread is idle. `variablesDependency`: Uniwind's StyleDependency.Variables.
 */
export function installNativeResolver(
  target: ResolverStore,
  uniwindListener: ResolverListener,
  variables: number
) {
  if (store) {
    return;
  }

  const prototype = Object.getPrototypeOf(
    target
  ) as Partial<ResolverStore> | null;

  if (
    typeof prototype?.resolveStyles !== 'function' ||
    typeof target.stylesheet !== 'object' ||
    !target.runtime?.screen
  ) {
    status.state = 'failed';
    status.error =
      'UniwindStore has no resolveStyles / stylesheet / runtime.screen (not Uniwind 1.12?)';
    return;
  }

  store = target;
  original = prototype.resolveStyles;
  listener = uniwindListener;
  variablesDependency = variables;
  // getStyles calls this.resolveStyles: an own property of the instance comes first
  target.resolveStyles = resolveStyles;

  // Variables: updateCSSVariables. A CSS reload in development lands here too: UniwindStore.reinit replaces the stylesheet and
  // variables, then calls UniwindListener.notifyAll (__DEV__ only; production loads the CSS once, before install)
  uniwindListener.subscribe(() => {
    stale = true;
    status.state = 'stale';
    schedule(REBUILD_DELAY_MS);
  }, [variables]);

  status.state = 'waiting';

  if (!loadPrebuilt()) {
    schedule(0);
  }
}

export const nativeResolver = {
  status: snapshot,
  /** Builds the table now, on the device (it is otherwise built when the JS thread is idle, unless a prebuilt one is in use). */
  rebuild,
  /** Off: every className goes to Uniwind's own resolveStyles again. Before install: no table is loaded or built either. */
  setEnabled(value: boolean) {
    enabled = value;

    if (value && stale && !loadPrebuilt()) {
      schedule(0);
    }
  },
  /** Benchmarks and checks: Uniwind's own resolveStyles and the native one, each called directly (no cache in front). */
  debug() {
    return {
      store,
      uniwind: store && original ? (original.bind(store) as Resolve) : null,
      native: !stale && enabled ? nativeResolve : null,
    };
  },
};
