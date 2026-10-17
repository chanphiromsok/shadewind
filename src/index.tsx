import {
  createElement,
  useCallback,
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
 * snapshot fades out once the new theme is mounted. It never takes touches. Skipped (instant switch) when the OS asks for reduced
 * motion, when the app is in the background or has no window. Default: no transition.
 */
export type ThemeTransition = {
  type: ThemeTransitionPreset;
  /** Length of the fade in ms (default 250, at most 2000). 0 or less: instant. */
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
  // Android commits synchronously for now (no background executor yet).
  asyncCommit: Platform.OS === 'ios',
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

  if (type !== 'fade') {
    throw new ShadewindError(
      'UNKNOWN_TRANSITION',
      `unknown transition '${String(type)}' (fade)`
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
 * `setTheme('dark', { transition: { type: 'fade', durationMs: 250 } })` cross-fades instead of switching at once.
 */
export function setTheme(name: ThemeName, options?: SetThemeOptions): void {
  stopFollowing?.();
  applyTheme(name, undefined, options?.transition);
}

/**
 * For shadewind/uniwind: a Uniwind theme change, applied so the native commit is mounted together with the React commit that
 * Uniwind's own subscribers trigger in the same task (see ThemeStrategy 'hookDeferred'). Not part of the public API.
 * @internal
 */
export function applyUniwindTheme(name: ThemeName): void {
  stopFollowing?.();
  applyTheme(name, 'hookDeferred');
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

// Native styles per styles content: every view with the same styles shares one object, so native parses them once and caches
// one entry, however many views mount and unmount. Bounded: an app has few distinct themed styles, and inline objects that
// change on every render start over past the limit.
const nativeByKey = new Map<string, Record<string, Record<string, unknown>>>();

const nativeFor = (key: string, styles: ThemedStyles) => {
  let native = nativeByKey.get(key);

  if (!native) {
    if (nativeByKey.size >= 512) {
      nativeByKey.clear();
    }

    native = Object.fromEntries(
      Object.entries(styles).map(([name, style]) => [
        name,
        toNativeProps(style as ThemedStyle),
      ])
    );
    nativeByKey.set(key, native);
  }

  return native;
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
  const cfg = assertConfigured();
  // inline objects are fine: identity is the content
  const key = JSON.stringify(styles);
  const stable = useMemo(() => styles, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const reason = options?.forceFallback ?? checkStyles(stable, cfg.themes);
  const engine = reason === null;

  if (reason !== null) {
    unsupported(reason, key);
  }

  // No subscription (rule 1): the style is the current theme's at this render. An engine view is then kept right by the
  // commit hook; a fallback view is stale after a later switch until its next render (dev warning above).
  const theme = getTheme();
  const native = engine ? nativeFor(key, stable) : null;

  // No cleanup on purpose: React runs ref cleanups when it hides a subtree (Suspense, Activity, freezeOnBlur), and the binding
  // must outlive that so the commit that shows the subtree again themes it. An unmount frees it with the view.
  const ref = useCallback<RefCallback<unknown>>(
    (node) => {
      if (!node) {
        return;
      }

      if (!native) {
        // the styles are no longer something the engine takes: React's props are right for this view from now on
        if (ShadewindEngine.isRegistered(node)) {
          ShadewindEngine.unregister(node);
        }

        return;
      }

      // `theme` names the theme this render used, which only describes the props of a node's first attach. A re-attach of a
      // view whose styles changed finds props the commit hook may have re-themed meanwhile, so it passes none and the next
      // commit applies the current theme.
      const first = typeof node === 'object' && !attachedNodes.has(node);

      if (typeof node === 'object') {
        attachedNodes.add(node);
      }

      ShadewindEngine.registerRaw(node, native, first ? theme : undefined);
    },
    // `theme` is read at attach time only: it names the theme this render used; a later switch is applied by the hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [native]
  );

  return {
    ref,
    style: (stable[theme] ?? {}) as unknown as T,
    engine,
  };
}

const overlap = (style: StyleProp<object>, styles: ThemedStyles) => {
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

    return createElement(Base, {
      ...(props as unknown as P),
      ref: mergeRefs(bound.ref, props.ref),
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
export function useThemedProps<T extends Record<string, unknown>>(
  valuesByTheme: Readonly<Partial<Record<ThemeName, T>>>,
  options: { colorKeys?: readonly string[] } = {}
): UseThemedPropsResult<T> {
  assertConfigured();

  const key = JSON.stringify([valuesByTheme, options.colorKeys]);
  const stable = useMemo(() => valuesByTheme, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const colorKeys = options.colorKeys ?? [];
  const native = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(stable).map(([name, values]) => [
          name,
          toNativePropsWith(values as Record<string, unknown>, colorKeys),
        ])
      ),
    [stable] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // no cleanup: the binding outlives a Suspense/Activity hide (see useThemed)
  const ref = useCallback<RefCallback<unknown>>(
    (node) => {
      if (node) {
        ShadewindEngine.registerRaw(node, native);
      }
    },
    [native]
  );

  return { ref, props: (stable[getTheme() as ThemeName] ?? {}) as T };
}

// ---- cn: native, tailwind-merge compatible class merge ------------------------------------------------------------

export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ClassValue[]
  | { readonly [key: string]: unknown };

type CnFallback = (...inputs: ClassValue[]) => string;

let nativeCn: ((...parts: string[]) => string | undefined) | null = null;
let cnFallback: CnFallback | null = null;
let warnedCnFallback = false;

/**
 * Installs the native class merge.
 *
 * `table` is the text generated by `npx shadewind-cn-table <srcDir>` (tailwind-merge is the oracle, so for every token in the
 * table the result is byte-identical to `twMerge(clsx(...))`). `fallback` (normally `(...a) => twMerge(clsx(a))`) is used for
 * any call that contains a token the table does not know, so the output never differs from the reference.
 * Returns false when the native module could not load the table.
 */
export function configureCn(options: {
  table: string;
  fallback?: CnFallback;
}): boolean {
  cnFallback = options.fallback ?? null;

  if (!ShadewindEngine.loadClassTable(options.table)) {
    nativeCn = null;

    return false;
  }

  // loadClassTable installs a plain global host function that skips the Nitro method wrapper (about 23 % faster)
  const global = globalThis as {
    __swCn?: (...parts: string[]) => string | undefined;
  };

  nativeCn =
    global.__swCn ?? ((...parts) => ShadewindEngine.mergeClasses(...parts));

  return true;
}

// clsx semantics: strings and numbers are kept, arrays are flattened, objects contribute the keys with truthy values
function flatten(value: ClassValue, out: string[]): void {
  if (!value) {
    return;
  }

  const type = typeof value;

  if (type === 'string') {
    out.push(value as string);
  } else if (type === 'number') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      flatten(item as ClassValue, out);
    }
  } else if (type === 'object') {
    for (const key in value as Record<string, unknown>) {
      if ((value as Record<string, unknown>)[key]) {
        out.push(key);
      }
    }
  }
}

/**
 * `twMerge(clsx(...inputs))`, computed natively for every token the table knows.
 *
 * Fast path: up to four arguments that are each a string or falsy go to the native function directly, with no array
 * allocation. Anything else (arrays, objects, numbers) is flattened first.
 */
export function cn(...inputs: ClassValue[]): string;
export function cn(
  a?: ClassValue,
  b?: ClassValue,
  c?: ClassValue,
  d?: ClassValue
): string {
  const count = arguments.length;

  if (nativeCn !== null && count <= 4) {
    const plain =
      (!a || typeof a === 'string') &&
      (!b || typeof b === 'string') &&
      (!c || typeof c === 'string') &&
      (!d || typeof d === 'string');

    if (plain) {
      const merged = nativeCn(
        (a as string) || '',
        (b as string) || '',
        (c as string) || '',
        (d as string) || ''
      );

      if (merged !== undefined) {
        return merged;
      }
    }
  }

  const inputs = Array.prototype.slice.call(arguments) as ClassValue[];
  const parts: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    flatten(inputs[i], parts);
  }

  if (nativeCn !== null) {
    const merged = nativeCn(...parts);

    if (merged !== undefined) {
      return merged;
    }
  }

  if (cnFallback !== null) {
    return cnFallback(...inputs);
  }

  if (__DEV__ && !warnedCnFallback) {
    warnedCnFallback = true;
    console.warn(
      '[shadewind] cn(): a class is not in the table and no `fallback` was given, classes are joined without conflict resolution.'
    );
  }

  return parts.join(' ');
}
