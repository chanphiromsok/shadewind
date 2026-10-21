import {
  createElement,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type Ref,
  type RefCallback,
} from 'react';
import {
  Appearance,
  Platform,
  StyleSheet,
  Text,
  View,
  type ColorValue,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import {
  ShadewindEngine,
  toNativeProps,
  toNativePropsWith,
  type NativeThemeTransition,
  type ThemeStrategy,
  type ThemeTransitionPreset,
} from './internal';

export type { ThemeTransitionPreset };

// Public API, see docs/API.md. Everything diagnostic or benchmark-only lives in `shadewind/internal`.

/** Augment to type theme names: `declare module 'shadewind' { interface Register { themes: 'light' | 'dark' } }`. */
export interface Register {}

export type ThemeName = Register extends { themes: infer T extends string }
  ? T
  : string;

export type ThemeKey = 'backgroundColor' | 'borderColor' | 'color';

export type ThemedStyle = {
  backgroundColor?: ColorValue;
  borderColor?: ColorValue;
  /** Text colour (Text only). */
  color?: ColorValue;
};

export type ThemedStyles = Readonly<Partial<Record<ThemeName, ThemedStyle>>>;

export type Capabilities = Readonly<{
  maxThemes: number;
  supportedKeys: readonly ThemeKey[];
  asyncCommit: boolean;
  platform: 'ios' | 'android';
}>;

export type ShadewindErrorCode =
  | 'UNKNOWN_THEME'
  | 'TOO_MANY_THEMES'
  | 'DUPLICATE_THEME'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN_TRANSITION';

export class ShadewindError extends Error {
  code: ShadewindErrorCode;

  constructor(code: ShadewindErrorCode, message: string) {
    super(`[shadewind] ${message}`);
    this.name = 'ShadewindError';
    this.code = code;
  }
}

/**
 * An animated theme change: a snapshot of the old screen is laid over the app, the theme is switched underneath it, and the
 * snapshot fades out once the new theme is mounted ('fade'), or first blurs for half the time and then fades ('blur'; Android
 * below 12 fades without the blur). It never takes touches. Skipped (instant switch) when the OS asks for reduced
 * motion, when the app is in the background or has no window. Default: no transition.
 */
export type ThemeTransition = {
  type: ThemeTransitionPreset;
  /** Length of the whole transition in ms (default 250, at most 2000). 0 or less: instant. */
  durationMs?: number;
};

export type SetThemeOptions = {
  /** Overrides the default set by `configure` / `setDefaultTransition`; `false` forces an instant switch. */
  transition?: ThemeTransition | false;
};

export type ConfigureOptions = {
  themes: readonly ThemeName[];
  initialTheme: ThemeName;
  /** What to do when a binding cannot use the fast path (it renders through React instead). Default 'warn'. */
  onUnsupported?: 'warn' | 'throw' | 'silent';
  /** Transition for every theme change that does not pass its own (Uniwind's setTheme included). Default: none. */
  transition?: ThemeTransition;
};

const SUPPORTED_KEYS: readonly ThemeKey[] = [
  'backgroundColor',
  'borderColor',
  'color',
];

export const capabilities: Capabilities = Object.freeze({
  maxThemes: 6,
  supportedKeys: SUPPORTED_KEYS,
  // hookAsync commits off the JS thread on both platforms: a background queue on iOS, the `sw-commit` worker thread on Android.
  asyncCommit: true,
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
} as const);

type Config = {
  themes: readonly string[];
  onUnsupported: 'warn' | 'throw' | 'silent';
};

let config: Config | null = null;
let defaultTransition: ThemeTransition | undefined;
let current: string | null = null;
let stopFollowing: (() => void) | null = null;
// Set by shadewind/uniwind: an explicit setTheme goes to Uniwind, whose listener brings the engine along (applyUniwindTheme).
let themeDriver: ((name: string) => void) | null = null;
// The setTheme call the driver is running, so its listener uses the call's transition and keeps followSystem; Uniwind notifies
// synchronously.
let driving: { transition: ThemeTransition | false | undefined } | null = null;
const listeners = new Set<(theme: ThemeName) => void>();

const assertConfigured = (): Config => {
  if (!config || current === null) {
    throw new ShadewindError(
      'NOT_CONFIGURED',
      'call configure({ themes, initialTheme }) before using Shadewind'
    );
  }

  return config;
};

/** Declares the themes. Call once, before the first render. A different list needs a reload (native state is per process). */
export function configure(options: ConfigureOptions): void {
  const { themes, initialTheme, onUnsupported = 'warn', transition } = options;

  if (new Set(themes).size !== themes.length) {
    throw new ShadewindError('DUPLICATE_THEME', 'duplicate theme name');
  }

  if (themes.length === 0 || themes.some((name) => !name)) {
    throw new ShadewindError('UNKNOWN_THEME', 'themes must be non-empty names');
  }

  if (themes.length > capabilities.maxThemes) {
    throw new ShadewindError(
      'TOO_MANY_THEMES',
      `at most ${capabilities.maxThemes} themes are supported, got ${themes.length}`
    );
  }

  if (!themes.includes(initialTheme)) {
    throw new ShadewindError(
      'UNKNOWN_THEME',
      `initialTheme '${initialTheme}' is not in themes`
    );
  }

  // throws on a bad preset here: as the default it would make every later switch throw before it applies
  nativeTransition(transition);

  if (config) {
    const same =
      config.themes.length === themes.length &&
      config.themes.every((name, i) => name === themes[i]);

    if (!same && __DEV__) {
      console.warn(
        '[shadewind] configure() was called with a different theme list; reload the app, native state is per process.'
      );
    }

    config.onUnsupported = onUnsupported;
    defaultTransition = transition ?? defaultTransition;

    return;
  }

  const declared = ShadewindEngine.configure([...themes]);

  if (!declared.ok) {
    throw new ShadewindError(
      'TOO_MANY_THEMES',
      `native engine supports ${declared.maxThemes} themes`
    );
  }

  config = { themes: [...themes], onUnsupported };
  defaultTransition = transition ?? defaultTransition; // setDefaultTransition may have run first
  current = initialTheme;
  ShadewindEngine.setTheme(initialTheme, 'hook');
}

export function getTheme(): ThemeName {
  assertConfigured();

  return current as ThemeName;
}

export function subscribe(listener: (theme: ThemeName) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

const MAX_TRANSITION_MS = 2000;
const DEFAULT_TRANSITION_MS = 250;

/** Validates and normalises a transition for the native call; undefined means an instant switch. */
const nativeTransition = (
  transition: ThemeTransition | false | undefined
): NativeThemeTransition | undefined => {
  if (!transition) {
    return undefined;
  }

  const { type, durationMs = DEFAULT_TRANSITION_MS } = transition;

  if (type !== 'fade' && type !== 'blur') {
    throw new ShadewindError(
      'UNKNOWN_TRANSITION',
      `unknown transition '${String(type)}' (fade, blur)`
    );
  }

  if (!(durationMs > 0)) {
    return undefined; // 0, negative or NaN: instant
  }

  return { type, durationMs: Math.min(durationMs, MAX_TRANSITION_MS) };
};

/** Sets the transition used by every theme change that passes none of its own (also Uniwind's). `undefined` clears it. */
export function setDefaultTransition(
  transition: ThemeTransition | undefined
): void {
  nativeTransition(transition); // throws on a bad preset now, not at the first switch
  defaultTransition = transition;
}

const applyTheme = (
  name: string,
  strategy?: ThemeStrategy,
  transition?: ThemeTransition | false
) => {
  const { themes } = assertConfigured();

  if (!themes.includes(name)) {
    throw new ShadewindError(
      'UNKNOWN_THEME',
      `theme '${name}' was not declared`
    );
  }

  if (name === current) {
    return;
  }

  const animated = nativeTransition(
    transition === undefined ? defaultTransition : transition
  );

  current = name;
  ShadewindEngine.setTheme(name, strategy, animated);
  listeners.forEach((listener) => listener(name as ThemeName));
};

/**
 * Switches every bound view without rendering React components. Rapid calls: the last one wins.
 * `setTheme('dark', { transition: { type: 'fade', durationMs: 250 } })` cross-fades instead of switching at once; `type: 'blur'`
 * blurs the old screen first.
 */
export function setTheme(name: ThemeName, options?: SetThemeOptions): void {
  const transition = options?.transition;

  stopFollowing?.();

  if (!themeDriver) {
    applyTheme(name, undefined, transition);

    return;
  }

  // checked before the driver runs: its listener only warns, so a throw there would leave Uniwind switched and the engine not
  if (!assertConfigured().themes.includes(name)) {
    throw new ShadewindError(
      'UNKNOWN_THEME',
      `theme '${name}' was not declared`
    );
  }

  nativeTransition(transition);

  // Called even when the engine is on `name` already: Uniwind decides whether it changes, so both end on the same theme.
  driving = { transition };

  try {
    themeDriver(name);
  } finally {
    driving = null;
  }

  // Uniwind was on `name` already while the engine was not, so it notified nobody
  if (current !== name) {
    applyTheme(name, undefined, transition);
  }
}

/**
 * For shadewind/uniwind: routes setTheme through Uniwind's setTheme, so Uniwind and the engine never hold different themes.
 * Not part of the public API.
 * @internal
 */
export function setThemeDriver(driver: ((name: string) => void) | null): void {
  themeDriver = driver;
}

/**
 * For shadewind/uniwind: a Uniwind theme change, applied by the React commit that Uniwind's own subscribers trigger (see
 * ThemeStrategy 'hookDeferred'), so the engine's views and React's change together. Not part of the public API.
 * @internal
 */
export function applyUniwindTheme(name: ThemeName): void {
  if (!driving) {
    stopFollowing?.();
  }

  // `__SHADEWIND_UNIWIND_STRATEGY__`: for measuring only (docs/BENCHMARK.md, "Uniwind with hookAsync"); hookDeferred is what keeps
  // views React re-renders in the same frame as the engine's
  const strategy =
    (globalThis as { __SHADEWIND_UNIWIND_STRATEGY__?: ThemeStrategy })
      .__SHADEWIND_UNIWIND_STRATEGY__ ?? 'hookDeferred';

  applyTheme(name, strategy, driving?.transition);
}

/** Follows the OS appearance. An explicit setTheme() stops following. Returns an unsubscribe. */
export function followSystem(
  map: { light: ThemeName; dark: ThemeName } = {
    light: 'light' as ThemeName,
    dark: 'dark' as ThemeName,
  }
): () => void {
  stopFollowing?.();

  const apply = (scheme: string | null | undefined) => {
    applyTheme(scheme === 'dark' ? map.dark : map.light);
  };
  const subscription = Appearance.addChangeListener(({ colorScheme }) =>
    apply(colorScheme)
  );

  apply(Appearance.getColorScheme());

  const stop = () => {
    subscription.remove();

    if (stopFollowing === stop) {
      stopFollowing = null;
    }
  };

  stopFollowing = stop;

  return stop;
}

/** The current theme as React state, for UI the engine does not update (status bar, navigation theme). */
export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribe, getTheme);
}

export function mergeRefs<T>(
  ...refs: Array<Ref<T> | undefined>
): RefCallback<T> {
  return (value) => {
    const cleanups: Array<() => void> = [];

    for (const ref of refs) {
      if (typeof ref === 'function') {
        const cleanup = ref(value);

        if (typeof cleanup === 'function') {
          cleanups.push(cleanup);
        }
      } else if (ref) {
        (ref as { current: T | null }).current = value;
      }
    }

    return cleanups.length > 0
      ? () => cleanups.forEach((cleanup) => cleanup())
      : undefined;
  };
}

const warned = new Set<string>();

const unsupported = (reason: string, key: string) => {
  const mode = config?.onUnsupported ?? 'warn';

  if (mode === 'silent') {
    return;
  }

  const message = `[shadewind] view is not bound to the engine and will be stale after a theme switch: ${reason}`;

  if (mode === 'throw') {
    throw new Error(message);
  }

  if (__DEV__ && !warned.has(key)) {
    warned.add(key);
    console.warn(message);
  }
};

// Returns why the styles cannot use the engine, or null when they can.
const checkStyles = (styles: ThemedStyles, themes: readonly string[]) => {
  const defined = Object.keys(styles);
  const keys = new Set<string>();

  for (const name of defined) {
    if (!themes.includes(name)) {
      return `theme '${name}' was not declared`;
    }

    for (const key of Object.keys(styles[name as ThemeName] ?? {})) {
      keys.add(key);
    }
  }

  for (const key of keys) {
    if (!SUPPORTED_KEYS.includes(key as ThemeKey)) {
      return `'${key}' is not supported (supported: ${SUPPORTED_KEYS.join(', ')})`;
    }
  }

  for (const name of themes) {
    const style = (styles[name as ThemeName] ?? {}) as Record<string, unknown>;

    for (const key of keys) {
      if (style[key] === undefined) {
        return `theme '${name}' does not define '${key}'`;
      }
    }
  }

  return keys.size === 0 ? 'no style keys' : null;
};

const attachedNodes = new WeakSet<object>();

type NativeByTheme = Record<string, Record<string, unknown>>;

// One entry per styles content: every view with the same styles shares it, so native parses them once and caches one entry,
// however many views mount and unmount. Bounded: an app has few distinct themed styles, and inline objects that change on every
// render start over past the limit.
const cachedByKey = <E,>(cache: Map<string, E>, key: string, make: () => E) => {
  let entry = cache.get(key);

  if (!entry) {
    if (cache.size >= 512) {
      cache.clear();
    }

    entry = make();
    cache.set(key, entry);
  }

  return entry;
};

type ThemedEntry = {
  /** The first styles object seen with this content: inline objects are fine, identity is the content. */
  styles: ThemedStyles;
  /** Why the engine cannot take the styles, or null when it can. `config.themes` never changes after the first configure. */
  reason: string | null;
  native: NativeByTheme | null;
  /** One ref per render theme, so a re-render keeps its ref (React attaches it again only when the ref changes). */
  refs: Map<string, RefCallback<unknown>>;
};

const themedByKey = new Map<string, ThemedEntry>();

const themedEntry = (
  key: string,
  styles: ThemedStyles,
  themes: readonly string[]
) =>
  cachedByKey(themedByKey, key, (): ThemedEntry => {
    const reason = checkStyles(styles, themes);
    let native: NativeByTheme | null = null;

    if (reason === null) {
      native = Object.fromEntries(
        Object.entries(styles).map(([name, style]) => [
          name,
          toNativeProps(style as ThemedStyle),
        ])
      );

      if (__DEV__) {
        ShadewindEngine.label(native, `useThemed: ${key}`);
      }
    }

    return { styles, reason, native, refs: new Map() };
  });

// No cleanup on purpose: React runs ref cleanups when it hides a subtree (Suspense, Activity, freezeOnBlur), and the binding
// must outlive that so the commit that shows the subtree again themes it. An unmount frees it with the view.
const bindRef = (
  native: NativeByTheme,
  theme: string
): RefCallback<unknown> => {
  return (node) => {
    if (!node) {
      return;
    }

    // `theme` names the theme the render that handed out this ref used, which only describes the props of a node's first
    // attach. A re-attach of a view whose styles changed finds props the commit hook may have re-themed meanwhile, so it passes
    // none and the next commit applies the current theme.
    const first = typeof node === 'object' && !attachedNodes.has(node);

    if (typeof node === 'object') {
      attachedNodes.add(node);
    }

    ShadewindEngine.registerRaw(node, native, first ? theme : undefined);
  };
};

// the styles are no longer something the engine takes: React's props are right for this view from now on
const unbindRef: RefCallback<unknown> = (node) => {
  if (node && ShadewindEngine.isRegistered(node)) {
    ShadewindEngine.unregister(node);
  }
};

const themedRef = (entry: ThemedEntry, theme: string) => {
  let ref = entry.refs.get(theme);

  if (!ref) {
    ref = bindRef(entry.native!, theme);
    entry.refs.set(theme, ref);
  }

  return ref;
};

export type UseThemedResult<T extends object> = {
  // any: a host component's ref type differs per component (View, Text, ScrollView, ...)

  ref: (instance: any) => void;
  /** Style of the current theme, so mount, re-render and fallback always show the right colour. */
  style: T;
  /** true: the engine updates this view; false: it re-renders through React on a switch. */
  engine: boolean;
};

/**
 * Binds one view to per-theme styles. Pass `ref` and `style` to a host component.
 * Anything the engine cannot handle falls back to a normal React render for this view.
 */
export function useThemed<T extends object = ViewStyle>(
  styles: ThemedStyles,
  options?: { forceFallback?: string }
): UseThemedResult<T> {
  // The theme is module state read on every render (no subscription, see below); compiled, it would be memoized on the styles
  // and go stale after a switch. The compiler skips hook-free functions by default; this keeps it so in compilationMode 'all'.
  'use no memo';

  // Calls no React hook: everything derived from the styles is cached per content (themedEntry), so a render costs one
  // JSON.stringify and a map lookup.
  const { themes } = assertConfigured();
  const key = JSON.stringify(styles);
  const entry = themedEntry(key, styles, themes);
  const reason = options?.forceFallback ?? entry.reason;

  if (reason !== null) {
    unsupported(reason, key);
  }

  // No subscription (rule 1): the style is the current theme's at this render. An engine view is then kept right by the
  // commit hook; a fallback view is stale after a later switch until its next render (dev warning above).
  const theme = current as string;

  return {
    ref: reason === null ? themedRef(entry, theme) : unbindRef,
    style: (entry.styles[theme as ThemeName] ?? {}) as unknown as T,
    engine: reason === null,
  };
}

const overlap = (style: StyleProp<object>, styles: ThemedStyles) => {
  if (style == null) {
    return undefined; // the common case: nothing to flatten
  }

  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const registered = new Set<string>();

  for (const name of Object.keys(styles)) {
    for (const key of Object.keys(styles[name as ThemeName] ?? {})) {
      registered.add(key);
    }
  }

  for (const key of registered) {
    if (flat[key] !== undefined) {
      return `inline style overrides '${key}'`;
    }
  }

  return undefined;
};

export type ThemedViewProps = ViewProps & { themed: ThemedStyles };
export type ThemedTextProps = TextProps & { themed: ThemedStyles };

function makeThemed<
  P extends { style?: StyleProp<object>; ref?: Ref<unknown> },
>(Base: ComponentType<P>, displayName: string) {
  const Themed = ({ themed, ...props }: P & { themed: ThemedStyles }) => {
    const bound = useThemed(themed, {
      forceFallback: overlap(props.style, themed),
    });
    // a new merged ref on every render would make React detach and attach both refs on every commit
    const ref = useMemo(
      () => mergeRefs(bound.ref, props.ref),
      [bound.ref, props.ref]
    );

    return createElement(Base, {
      ...(props as unknown as P),
      ref,
      style: [bound.style, props.style],
    } as unknown as P);
  };

  Themed.displayName = displayName;

  return Themed;
}

export const ThemedView = makeThemed<ViewProps & { ref?: Ref<unknown> }>(
  View as ComponentType<ViewProps & { ref?: Ref<unknown> }>,
  'ThemedView'
) as ComponentType<ThemedViewProps & { style?: StyleProp<ViewStyle> }>;

export const ThemedText = makeThemed<TextProps & { ref?: Ref<unknown> }>(
  Text as ComponentType<TextProps & { ref?: Ref<unknown> }>,
  'ThemedText'
) as ComponentType<ThemedTextProps & { style?: StyleProp<TextStyle> }>;

export type UseThemedPropsResult<T extends object> = {
  ref: (instance: any) => void;
  /** The props of the current theme, for the render that is happening now. Never subscribes: no React state is involved. */
  props: T;
};

/**
 * Themes props that are not `style` (a gradient's `colors`, a native view's `color`, ...) without any React state:
 * the values per theme are handed to the engine, which rewrites the host node's props inside the commit on every switch.
 *
 * `colorKeys` names the props that hold colours (a colour or an array of colours); they are converted to native colours.
 * The component re-renders for other reasons as usual and then simply reads the current theme again.
 */
type PropsEntry = {
  /** The first values object seen with this content (with these colorKeys). */
  values: Readonly<Partial<Record<ThemeName, Record<string, unknown>>>>;
  ref: RefCallback<unknown>;
};

const propsByKey = new Map<string, PropsEntry>();

const propsEntry = (
  key: string,
  valuesByTheme: PropsEntry['values'],
  colorKeys: readonly string[]
) =>
  cachedByKey(propsByKey, key, (): PropsEntry => {
    const native: NativeByTheme = Object.fromEntries(
      Object.entries(valuesByTheme).map(([name, values]) => [
        name,
        toNativePropsWith(values as Record<string, unknown>, colorKeys),
      ])
    );

    if (__DEV__) {
      ShadewindEngine.label(native, `useThemedProps: ${key}`);
    }

    // no cleanup: the binding outlives a Suspense/Activity hide (see bindRef)
    const ref: RefCallback<unknown> = (node) => {
      if (node) {
        ShadewindEngine.registerRaw(node, native);
      }
    };

    return { values: valuesByTheme, ref };
  });

export function useThemedProps<T extends Record<string, unknown>>(
  valuesByTheme: Readonly<Partial<Record<ThemeName, T>>>,
  options?: { colorKeys?: readonly string[] }
): UseThemedPropsResult<T> {
  'use no memo'; // reads the theme on every render (see useThemed)

  // Calls no React hook, like useThemed: the conversion, the label and the ref are made once per content and shared by every
  // view with the same values.
  assertConfigured();

  const colorKeys = options?.colorKeys;
  const key = JSON.stringify([valuesByTheme, colorKeys]);
  const entry = propsEntry(key, valuesByTheme, colorKeys ?? []);

  return {
    ref: entry.ref,
    props: (entry.values[current as ThemeName] ?? {}) as T,
  };
}

export { cn, configureCn, type ClassValue } from './cn';
