import { getInternals, type Resolved } from './install';

// What the adapter asks of Uniwind's store beyond a plain getStyles: the style for another theme, and without filling Uniwind's cache.
// Needs installUniwind() to have run (the callers are the components, which install first).

// UniwindStore.getStyles(..., { scopedTheme }) is wrong for light-dark() (spike A): make `theme` the runtime theme for the call.
export const withTheme = <T>(theme: string, fn: () => T): T => {
  const runtime = getInternals()!.UniwindStore.runtime;
  const previous = runtime.currentThemeName;

  runtime.currentThemeName = theme;

  try {
    return fn();
  } finally {
    runtime.currentThemeName = previous;
  }
};

// What getStyles would return for this className, state and (runtime) theme, without putting it in Uniwind's cache. A plan probes the
// other themes and ALL_STATE once per className; through getStyles every probe stayed in Uniwind's cache with its own listener
// subscription, three entries per className instead of the view's one, never read again (docs/BENCHMARK.md, memory). Same guards as getStyles (no className, a theme without
// a cache). The instance's own resolveStyles is the native resolver when the class table is loaded (nativeResolver.ts).
export const resolveUncached = (
  className: string,
  props: Record<string, any>,
  state: Record<string, boolean> | undefined,
  context: { scopedTheme: string | null }
): Resolved => {
  const store = getInternals()!.UniwindStore;
  const theme = context.scopedTheme ?? store.runtime.currentThemeName;

  if (
    className === '' ||
    typeof store.resolveStyles !== 'function' ||
    store.cache?.[theme] === undefined
  ) {
    // not Uniwind 1.12's store shape: the cached path, as before
    return store.getStyles(className, props, state, context);
  }

  return store.resolveStyles(className, props, state, context);
};

type Styles = Record<string, unknown>;

/**
 * The style of `className` in every theme, a fresh record the caller may change. The theme being rendered is `current` (what
 * getStyles returned for this render); the others are resolved without caching.
 */
export const stylesByTheme = (
  className: string,
  props: Record<string, any>,
  state: Record<string, boolean> | undefined,
  context: { scopedTheme: string | null },
  current: Resolved
): Record<string, Styles> => {
  const { UniwindStore } = getInternals()!;
  const renderTheme = UniwindStore.runtime.currentThemeName;
  const result: Record<string, Styles> = {};

  for (const theme of Object.keys(UniwindStore.vars)) {
    result[theme] =
      theme === renderTheme
        ? current.styles
        : withTheme(
            theme,
            () => resolveUncached(className, props, state, context).styles
          );
  }

  return result;
};
