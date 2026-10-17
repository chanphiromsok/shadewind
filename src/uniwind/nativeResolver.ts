import { ShadewindEngine, type ResolvedStyles } from '../internal';
import { buildStyleTable, type UniwindStyle } from './styleTable';

// Uniwind's class resolution, natively (cpp/css/StyleResolver.hpp). Uniwind caches resolveStyles' result per className, state
// and theme (UniwindStore.getStyles); this replaces what runs on a cache miss: the first render of a className, a new
// pressed / focused state, a new theme, a new screen width.
//
// The table is Uniwind's stylesheet evaluated once per theme (styleTable.ts). It is built when the JS thread is idle after
// install, so the first screen is still resolved by Uniwind's JS; every resolution after that goes native when it can:
//
// - no scoped theme and no scoped variables (Uniwind's context): the table has neither,
// - the table was built from the stylesheet and variables the store holds now (a CSS reload replaces them; updateCSSVariables
//   changes them in place and notifies Variables, which marks the table stale until it is rebuilt),
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
};

export type ResolverStatus = {
  /** off: not installed or disabled; waiting: the table is not built yet; stale: built from other variables, rebuilding. */
  state: 'off' | 'waiting' | 'ready' | 'stale' | 'failed';
  /** classes in the table / classes Uniwind's JS keeps resolving (post-processed or runtime-dependent values, data / rtl variants). */
  classes: number;
  fallback: number;
  /** JS thread time of the last build (styleTable.ts) and of loading it natively (parse). */
  buildMs: number;
  loadMs: number;
  builds: number;
  error?: string;
};

const REBUILD_DELAY_MS = 500;

const status: ResolverStatus = {
  state: 'off',
  classes: 0,
  fallback: 0,
  buildMs: 0,
  loadMs: 0,
  builds: 0,
};
let store: ResolverStore | null = null;
let original: Resolve | null = null;
let nativeResolve: NativeResolve | null = null;
let enabled = true;
let builtFrom: { stylesheet: unknown; vars: unknown } | null = null;
let stale = true;
let scheduled = false;

const now = () =>
  (
    globalThis as unknown as { performance: { now(): number } }
  ).performance.now();

const whenIdle = (callback: () => void, delayMs: number) => {
  const g = globalThis as {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout: number }
    ) => void;
  };

  setTimeout(
    () =>
      g.requestIdleCallback
        ? g.requestIdleCallback(callback, { timeout: 2000 })
        : callback(),
    delayMs
  );
};

const schedule = (delayMs: number) => {
  if (scheduled || !store) {
    return;
  }

  scheduled = true;
  whenIdle(() => {
    scheduled = false;

    if (enabled && stale) {
      rebuild();
    }
  }, delayMs);
};

/** Builds the table from the store now and loads it natively (normally done when idle). */
export function rebuild(): ResolverStatus {
  if (!store) {
    return { ...status };
  }

  const current = store;

  stale = true;
  nativeResolve = null;

  try {
    const t0 = now();
    const table = buildStyleTable({
      stylesheet: current.stylesheet,
      varsByTheme: current.vars,
      themes: Object.keys(current.vars),
      runtime: current.runtime,
    });
    const t1 = now();
    const load = ShadewindEngine.loadStyleTable(table.json);

    status.buildMs = t1 - t0;
    status.loadMs = now() - t1;
    status.classes = table.classes;
    status.fallback = table.fallback;
    status.builds++;

    const global = globalThis as { __swResolve?: NativeResolve };

    if (!load.ok || load.unsupported > 0 || !global.__swResolve) {
      status.state = 'failed';
      status.error =
        load.error ??
        `${load.unsupported} classes of the table could not be read natively`;
      return { ...status };
    }

    builtFrom = { stylesheet: current.stylesheet, vars: current.vars };
    nativeResolve = global.__swResolve;
    stale = false;
    status.state = enabled ? 'ready' : 'off';
    status.error = undefined;
  } catch (error) {
    status.state = 'failed';
    status.error = String(error);
  }

  return { ...status };
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
  if (
    nativeResolve !== null &&
    enabled &&
    !stale &&
    typeof classNames === 'string' &&
    context.scopedTheme === null &&
    context.variables === null
  ) {
    if (
      builtFrom!.stylesheet === this.stylesheet &&
      builtFrom!.vars === this.vars
    ) {
      try {
        const result = nativeResolve(
          classNames,
          this.runtime.currentThemeName,
          this.runtime.screen.width,
          state?.isPressed,
          state?.isFocused,
          state?.isDisabled
        );

        if (result !== undefined) {
          return result;
        }
      } catch {
        // Uniwind's own below
      }
    } else {
      // Uniwind reloaded its CSS (development): a table for the new stylesheet
      stale = true;
      status.state = 'stale';
      schedule(REBUILD_DELAY_MS);
    }
  }

  return original!.call(this, classNames, componentProps, state, context);
}

/**
 * Puts the native resolver in front of Uniwind's resolveStyles (once) and builds the table when the JS thread is idle.
 * `variablesDependency`: Uniwind's StyleDependency.Variables.
 */
export function installNativeResolver(
  target: ResolverStore,
  listener: ResolverListener,
  variablesDependency: number
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
  // getStyles calls this.resolveStyles: an own property of the instance comes first
  target.resolveStyles = resolveStyles;

  listener.subscribe(() => {
    stale = true;
    status.state = 'stale';
    schedule(REBUILD_DELAY_MS);
  }, [variablesDependency]);

  status.state = 'waiting';
  schedule(0);
}

export const nativeResolver = {
  status: (): ResolverStatus => ({
    ...status,
    state: !enabled && status.state === 'ready' ? 'off' : status.state,
  }),
  /** Builds the table now (it is otherwise built when the JS thread is idle after install and after a variables change). */
  rebuild,
  /** Off: every className goes to Uniwind's own resolveStyles again. */
  setEnabled(value: boolean) {
    enabled = value;

    if (value && stale) {
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
