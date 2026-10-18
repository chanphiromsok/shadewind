import { useCallback, useMemo } from 'react';
import { processColor, type ColorValue } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { Shadewind } from './Shadewind.nitro';

// Raw JSI methods registered natively in HybridShadewind::loadHybridMethods.
type RawMethods = {
  register(
    shadowNode: unknown,
    propsByTheme: Record<string, object>,
    styleId?: number,
    renderTheme?: string
  ): void;
  registerMany(
    shadowNodes: unknown[],
    propsByTheme: object[],
    styleIds: number[],
    renderThemes: Array<string | undefined>
  ): void;
  unregister(shadowNode: unknown): void;
  configure(names: string[]): { maxThemes: number; ok: boolean };
  loadClassTable(text: string): boolean;
  mergeClasses(...parts: string[]): string | undefined;
  loadStyleTable(json: string): StyleTableLoad;
  resolveClasses(
    className: string,
    theme: string,
    screenWidth: number,
    isPressed?: unknown,
    isFocused?: unknown,
    isDisabled?: unknown
  ): ResolvedStyles | undefined;
  setTheme(
    name: string,
    strategy?: ThemeStrategy,
    transition?: NativeThemeTransition
  ): ThemeTimings;
  flushPending(): void;
  prepare(): void;
  resetMainBusy(): void;
  mainBusyMs(): number;
  inspect(): InspectReport;
};

// Created on first use, not at import: a styling library that imports the engine from a component module can be evaluated before
// React Native has finished its own setup (the native runtime is not ready then).
let nativeInstance: (Shadewind & RawMethods) | undefined;

const getNative = () =>
  (nativeInstance ??= NitroModules.createHybridObject<Shadewind>(
    'Shadewind'
  ) as Shadewind & RawMethods);

/** loadStyleTable's answer: classes the table holds, classes it could not read (0 for a table styleTable.ts built). */
export type StyleTableLoad = {
  ok: boolean;
  classes: number;
  unsupported: number;
  error?: string;
};

/** Uniwind's resolveStyles result, as the native resolver returns it. */
export type ResolvedStyles = {
  styles: Record<string, unknown>;
  dependencies: number[];
  dependencySum: number;
  hasDataAttributes: boolean;
};

/** Debug report: where a stale colour comes from. All counts refer to backgroundColor of registered views. */
export type InspectReport = {
  theme: string;
  registered?: number;
  inTree?: number;
  notInTree?: number;
  /** Registered views inside a `display: none` subtree (a frozen screen): themed when they show, not compared. */
  hidden?: number;
  treeMatchesExpected?: number;
  /** iOS: registered views whose UIView.backgroundColor equals the expected theme colour. */
  nativePropsMatchExpected?: number;
  /** iOS: registered views whose layer was painted with the expected theme colour. */
  layerMatchesExpected?: number;
  samples?: string;
  /** Debug: hook state of registered views whose tree colour is not the expected one. */
  stale?: string;
};

/** Native-side breakdown of the engine's last commit, in milliseconds. */
export type ThemeTimings = {
  /** Views cloned with their theme's props. */
  views: number;
  /** A commit that changed nothing: the walk. */
  scanMs: number;
  /** A commit that changed something: walk, props and clones. */
  cloneMs: number;
  /** Part of cloneMs spent building the typed props. */
  propsMs: number;
  /** Views whose props came from the per-view cache instead of being rebuilt. */
  reused?: number;
  /** Nodes the walk visited. */
  visited?: number;
  /** Subtrees skipped because the previous commit had already themed them. */
  skipped?: number;
  /** `display: none` subtrees skipped (frozen screens, themed when they show). */
  hidden?: number;
  /** Why props were rebuilt and how text was recoloured (debug). */
  misses?: string;
  /** 'hookAsync': time from the previous setTheme call until the main thread finished mounting it. */
  visualMs?: number;
  /** 'hook': the commit; 'hookAsync': the previous background commit. */
  commitMs: number;
  /** What the JS thread paid inside the call. */
  totalMs: number;
};

/**
 * How a theme change reaches the screen. Unknown names throw.
 * - 'hookAsync' (default): the commit runs on a background thread, the JS thread is free right away. On Android it is synchronous
 *   for now.
 * - 'hook': the commit runs synchronously on the JS thread and is mounted at once.
 * - 'hookDeferred': the commit runs synchronously on the JS thread but its mount is queued on the RuntimeScheduler, so it lands
 *   with the React commit made in the same task (a Uniwind setTheme in a press handler): views the engine handles and views
 *   React re-renders change in the same frame. Only valid inside a JS task.
 * Either way the theme is applied inside a commit hook, so every later commit (React's too) keeps it.
 */
export type ThemeStrategy = 'hook' | 'hookAsync' | 'hookDeferred';

/** Preset names of an animated theme change. Add a name here and to `ThemeTransitionPreset` in cpp/ShadewindNative.hpp. */
export type ThemeTransitionPreset = 'fade' | 'blur';

/** What the native overlay is asked for: a preset and its length. */
export type NativeThemeTransition = {
  type: ThemeTransitionPreset;
  durationMs: number;
};

/** Style subset supported in v0: visual-only props that don't need a Yoga layout pass. */
export type ThemedStyle = {
  backgroundColor?: ColorValue;
  borderColor?: ColorValue;
  /** Text colour (Text only). The engine rebuilds the paragraph state itself, so no layout pass is needed. */
  color?: ColorValue;
  opacity?: number;
};

export type ThemedStyles = Record<string, ThemedStyle>;

const COLOR_KEYS = new Set<keyof ThemedStyle>([
  'backgroundColor',
  'borderColor',
  'color',
]);

// UIManager::updateShadowTree takes props in the raw format React Native sends to native,
// so colors must be processed (numbers) before they cross into C++.
// Like toNativeProps for any component: `colorKeys` name the props that hold colours (a colour, or an array of colours).
export function toNativePropsWith(
  props: Record<string, unknown>,
  colorKeys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(props)) {
    const value = props[key];

    if (value === undefined) {
      continue;
    }

    if (colorKeys.includes(key)) {
      out[key] = Array.isArray(value)
        ? value.map((color) => toNativeColor(color as ColorValue))
        : toNativeColor(value as ColorValue);
    } else {
      out[key] = value;
    }
  }

  return out;
}

// Colour strings the native parser understands (css/ColorParser.hpp) travel as strings; everything else (named colours,
// PlatformColor, DynamicColorIOS objects) still goes through React Native's processColor.
const NATIVE_COLOR =
  /^\s*(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|transparent$)/i;

const toNativeColor = (value: ColorValue): unknown =>
  typeof value === 'string' && NATIVE_COLOR.test(value)
    ? value
    : processColor(value);

export function toNativeProps(style: ThemedStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(style) as Array<keyof ThemedStyle>) {
    const value = style[key];

    if (value === undefined) {
      continue;
    }

    out[key] = COLOR_KEYS.has(key) ? toNativeColor(value as ColorValue) : value;
  }

  return out;
}

// Private React Native API (same one RN's own DOM APIs use). Isolated here because it can change.
let nodeFromHandle: ((handle: unknown) => unknown) | undefined;

const getShadowNode = (ref: unknown): unknown => {
  const handle = (ref as { __internalInstanceHandle?: unknown } | null)
    ?.__internalInstanceHandle;

  if (!handle) {
    return null;
  }

  nodeFromHandle ??= (
    require('react-native/Libraries/ReactNative/RendererProxy') as {
      getNodeFromInternalInstanceHandle: (handle: unknown) => unknown;
    }
  ).getNodeFromInternalInstanceHandle;

  return nodeFromHandle(handle);
};

// The native styles each mounted view (its ref, the public instance) is registered with. React detaches and re-attaches refs when
// it hides and reveals a subtree (Suspense, Activity, freezeOnBlur); the registration stays meanwhile (the commit hook themes the
// subtree when it shows), so a re-attach with the same styles costs nothing. A WeakMap: an unmounted view is simply collected, and
// its native entry goes with its shadow node family.
const registeredWith = new WeakMap<object, object>();

// Registrations since the last flush, sent in one native call after React's commit.
const pendingNodes: unknown[] = [];
const pendingProps: object[] = [];
const pendingIds: number[] = [];
const pendingThemes: Array<string | undefined> = [];

const flushRegistrations = () => {
  if (pendingNodes.length === 0) {
    return;
  }

  getNative().registerMany(
    pendingNodes,
    pendingProps,
    pendingIds,
    pendingThemes
  );
  pendingNodes.length = 0;
  pendingProps.length = 0;
  pendingIds.length = 0;
  pendingThemes.length = 0;
};

let flushScheduled = false;

// Refs attach during React's commit; the microtask runs right after it, when the nodes are in the committed tree.
const scheduleFlush = () => {
  if (flushScheduled) {
    return;
  }

  flushScheduled = true;
  Promise.resolve().then(() => {
    flushScheduled = false;
    flushRegistrations();
  });
};

const nativeByStyles = new WeakMap<
  object,
  Record<string, Record<string, unknown>>
>();
// One id per distinct native styles object: C++ builds its typed props once per id, not once per view.
const styleIds = new WeakMap<object, number>();
let nextStyleId = 1;
const styleIdOf = (native: object): number => {
  let id = styleIds.get(native);

  if (id === undefined) {
    id = nextStyleId++;
    styleIds.set(native, id);
  }

  return id;
};

const registerNative = (
  ref: unknown,
  native: Record<string, Record<string, unknown>>,
  renderTheme: string | undefined
): boolean => {
  const key = typeof ref === 'object' && ref !== null ? ref : null;

  if (key !== null && registeredWith.get(key) === native) {
    return true;
  }

  const node = getShadowNode(ref);

  if (!node) {
    return false;
  }

  pendingNodes.push(node);
  pendingProps.push(native);
  pendingIds.push(styleIdOf(native));
  pendingThemes.push(renderTheme);

  if (key !== null) {
    registeredWith.set(key, native);
  }

  scheduleFlush();

  return true;
};

export const ShadewindEngine = {
  /** Experimental: native tailwind-merge compatible class merge (see docs/ARCHITECTURE.md section 13). */
  loadClassTable(text: string): boolean {
    return getNative().loadClassTable(text);
  },
  mergeClasses(...parts: string[]): string | undefined {
    return getNative().mergeClasses(...parts);
  },
  /**
   * Installs the class table src/uniwind/styleTable.ts builds (Uniwind's stylesheet evaluated per theme) and the global host
   * function `__swResolve` (resolveClasses without Nitro's method wrapper) in this runtime.
   */
  loadStyleTable(json: string): StyleTableLoad {
    return getNative().loadStyleTable(json);
  },
  /** Uniwind's resolveStyles for a className, natively from the loaded table, or undefined: resolve it with Uniwind's JS. */
  resolveClasses(
    className: string,
    theme: string,
    screenWidth: number,
    isPressed?: unknown,
    isFocused?: unknown,
    isDisabled?: unknown
  ): ResolvedStyles | undefined {
    return getNative().resolveClasses(
      className,
      theme,
      screenWidth,
      isPressed,
      isFocused,
      isDisabled
    );
  },
  /** Declares the theme names in order (native slot ids). Returns the slot count and whether all names fit. */
  configure(names: string[]): { maxThemes: number; ok: boolean } {
    return getNative().configure(names);
  },
  /**
   * Binds a mounted view (its ref) to per-theme styles. `renderTheme`: the theme its props were rendered with, known only on the
   * view's first attach. Registrations are sent to native after the commit, all at once. Returns false when the ref is not a
   * Fabric host view.
   */
  register(ref: unknown, styles: ThemedStyles, renderTheme?: string) {
    // the same `styles` object is registered by every view of one className: convert it once
    let native = nativeByStyles.get(styles);

    if (!native) {
      native = Object.fromEntries(
        Object.entries(styles).map(([theme, style]) => [
          theme,
          toNativeProps(style),
        ])
      );
      nativeByStyles.set(styles, native);
    }

    return registerNative(ref, native, renderTheme);
  },
  /** Registers with props already converted by toNativeProps (used by the public useThemed). */
  registerRaw(
    ref: unknown,
    native: Record<string, Record<string, unknown>>,
    renderTheme?: string
  ) {
    return registerNative(ref, native, renderTheme);
  },
  /** Whether `ref` is bound (registered or about to be). */
  isRegistered(ref: unknown): boolean {
    return typeof ref === 'object' && ref !== null && registeredWith.has(ref);
  },
  /**
   * Unbinds a view that stays mounted (a pressed Pressable, styles the engine cannot take any more): React's props are right for
   * it from now on. An unmount needs no call.
   */
  unregister(ref: unknown) {
    if (typeof ref === 'object' && ref !== null) {
      registeredWith.delete(ref);
    }

    // keep the native order: a queued registration of this view goes first
    flushRegistrations();

    const node = getShadowNode(ref);

    if (node) {
      getNative().unregister(node);
    }
  },
  /** Applies a theme to every registered view without rendering any React component. */
  setTheme(
    name: string,
    strategy: ThemeStrategy = 'hookAsync',
    transition?: NativeThemeTransition
  ): ThemeTimings {
    flushRegistrations();

    // no third argument without a transition: the instant switch is exactly the call it always was
    return transition
      ? getNative().setTheme(name, strategy, transition)
      : getNative().setTheme(name, strategy);
  },
  /** Measurement: clears the longest main-thread busy period (iOS only; starts the run loop observer on first call). */
  resetMainBusy(): void {
    getNative().resetMainBusy();
  },
  /** Measurement: longest main-thread run loop busy period in ms since resetMainBusy (iOS only). */
  mainBusyMs(): number {
    return getNative().mainBusyMs();
  },
  /** Kept for compatibility; does nothing. */
  prepare(): void {
    getNative().prepare();
  },
  /** Debug only. Compares the committed tree, UIKit and the expected theme colours. */
  inspect(): InspectReport {
    flushRegistrations();

    return getNative().inspect();
  },
  getTheme(): string {
    return getNative().getTheme();
  },
};

/**
 * Callback ref that registers a view's per-theme style when it attaches. The registration outlives a Suspense/Activity hide (the
 * commit hook themes the view when it shows again) and goes away with the view.
 * Keep `styles` referentially stable (module constant or useMemo).
 */
export function useThemedRef(styles: ThemedStyles) {
  const stable = useMemo(() => styles, [styles]);

  return useCallback(
    (ref: unknown) => {
      if (ref) {
        ShadewindEngine.register(ref, stable);
      }
    },
    [stable]
  );
}
