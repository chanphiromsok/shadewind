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
import { ShadewindEngine, toNativeProps } from './internal';

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
  'UNKNOWN_THEME' | 'TOO_MANY_THEMES' | 'DUPLICATE_THEME' | 'NOT_CONFIGURED';

export class ShadewindError extends Error {
  code: ShadewindErrorCode;

  constructor(code: ShadewindErrorCode, message: string) {
    super(`[shadewind] ${message}`);
    this.name = 'ShadewindError';
    this.code = code;
  }
}

export type ConfigureOptions = {
  themes: readonly ThemeName[];
  initialTheme: ThemeName;
  /** What to do when a binding cannot use the fast path (it renders through React instead). Default 'warn'. */
  onUnsupported?: 'warn' | 'throw' | 'silent';
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
  const { themes, initialTheme, onUnsupported = 'warn' } = options;

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

const applyTheme = (name: string) => {
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

  current = name;
  ShadewindEngine.setTheme(name);
  listeners.forEach((listener) => listener(name as ThemeName));
};

/** Switches every bound view without rendering React components. Rapid calls: the last one wins. */
export function setTheme(name: ThemeName): void {
  stopFollowing?.();
  applyTheme(name);
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

  const message = `[shadewind] view uses the React path: ${reason}`;

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

const noopSubscribe = () => () => {};

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

  // only the fallback subscribes; engine views do not re-render on a switch
  const theme = useSyncExternalStore(
    engine ? noopSubscribe : subscribe,
    getTheme
  );
  const native = useMemo(
    () =>
      engine
        ? Object.fromEntries(
            Object.entries(stable).map(([name, style]) => [
              name,
              toNativeProps(style as ThemedStyle),
            ])
          )
        : null,
    [engine, stable]
  );

  // React 19 calls the returned function on detach; typed as void so any host ref type accepts it
  const ref = useCallback<RefCallback<unknown>>(
    (node) => {
      if (!node || !native) {
        return undefined;
      }

      ShadewindEngine.registerRaw(node, native);

      return () => ShadewindEngine.unregister(node);
    },
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
