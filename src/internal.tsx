import { useCallback, useMemo, useRef } from 'react';
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
  defineStyle(id: number, propsByTheme: Record<string, object>): void;
  unregister(shadowNode: unknown): void;
  configure(names: string[]): { maxThemes: number; ok: boolean };
  loadClassTable(text: string): boolean;
  mergeClasses(...parts: string[]): string | undefined;
  setTheme(name: string, strategy?: ThemeStrategy): ThemeTimings;
  flushPending(): void;
  prepare(): void;
  resetMainBusy(): void;
  mainBusyMs(): number;
  inspect(): InspectReport;
  refreshReactNodes(nodes: unknown[]): number;
};

// Created on first use, not at import: a styling library that imports the engine from a component module can be evaluated before
// React Native has finished its own setup (the native runtime is not ready then).
let nativeInstance: (Shadewind & RawMethods) | undefined;

const getNative = () =>
  (nativeInstance ??= NitroModules.createHybridObject<Shadewind>(
    'Shadewind'
  ) as Shadewind & RawMethods);

/** Debug report: where a stale colour comes from. All counts refer to backgroundColor of registered views. */
export type InspectReport = {
  theme: string;
  registered?: number;
  inTree?: number;
  notInTree?: number;
  treeMatchesExpected?: number;
  /** iOS: registered views whose UIView.backgroundColor equals the expected theme colour. */
  nativePropsMatchExpected?: number;
  /** iOS: registered views whose layer was painted with the expected theme colour. */
  layerMatchesExpected?: number;
  samples?: string;
};

/** Native-side breakdown of one setTheme call, in milliseconds. */
export type ThemeTimings = {
  views: number;
  /** 'hook' strategy: time spent finding views that need an update inside the commit hook. */
  scanMs: number;
  /** 'hook' strategy: time spent building typed props and cloning the nodes. */
  cloneMs: number;
  /** 'hook' strategy: part of cloneMs spent building the typed props. */
  propsMs: number;
  /** 'hook' strategies: views whose props came from the per-view cache instead of being rebuilt. */
  reused?: number;
  /** 'hook' strategies: views whose node was taken from the pre-built buffer (no clone on the critical path). */
  precloned?: number;
  /** 'hook' strategies: why nodes missed the pre-built buffer, as notOurs/noBuffer/source/props/children counts. */
  misses?: string;
  /** 'hookAsync': time from the previous setTheme call until the main thread finished mounting it. */
  visualMs?: number;
  collectMs: number;
  directMs: number;
  commitMs: number;
  totalMs: number;
};

/**
 * How a theme change reaches the screen. Unknown names throw.
 * - 'hookAsync' (default): typed props are applied inside a commit hook (so every commit, React's too, keeps the theme) and the
 *   commit runs on a background thread: the JS thread is free right away (about 0.05 ms for 2000 views), the screen updates a few
 *   ms later. On Android the commit is currently synchronous.
 * - 'hook': the same, but the commit runs synchronously on the JS thread (about 4-8 ms for 2000 views).
 * - 'stock': React Native's UIManager::updateShadowTree (whole-tree walk). Benchmark baseline.
 * - 'fastAsync': one single-pass shadow-tree commit that clones only the touched nodes; the UI thread mounts it later.
 * - 'direct': update the native views immediately, the shadow tree catches up on the next React clone. Benchmark baseline.
 * - 'both': direct update now plus a single-pass commit. Benchmark baseline.
 * The last four are measurement baselines and are not supported for production use.
 */
export type ThemeStrategy =
  'hook' | 'hookAsync' | 'stock' | 'fastAsync' | 'direct' | 'both';

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
const getShadowNode = (ref: unknown): unknown => {
  const handle = (ref as { __internalInstanceHandle?: unknown } | null)
    ?.__internalInstanceHandle;

  if (!handle) {
    return null;
  }

  const {
    getNodeFromInternalInstanceHandle,
  } = require('react-native/Libraries/ReactNative/RendererProxy');

  return getNodeFromInternalInstanceHandle(handle);
};

// Views we manage. Used to find React's own handles to their nodes (fiber.stateNode.node).
const registered = new Set<unknown>();

type Fiber = {
  tag: number;
  return: Fiber | null;
  alternate: Fiber | null;
  stateNode?: { node?: unknown };
};

const HOST_COMPONENT_TAG = 5;

// React rebuilds its tree from these handles, so after a native update they must point at the committed nodes,
// for the views we changed and for every host ancestor (their child lists come from React's handles too).
// Private React internals: isolated here, can change between React versions.
const refreshReact = () => {
  const nodes: unknown[] = [];
  const seenNodes = new Set<unknown>();
  const seenFibers = new Set<Fiber>();

  registered.forEach((ref) => {
    let fiber =
      (ref as { __internalInstanceHandle?: Fiber }).__internalInstanceHandle ??
      null;

    while (fiber && !seenFibers.has(fiber)) {
      seenFibers.add(fiber);

      if (fiber.tag === HOST_COMPONENT_TAG) {
        for (const candidate of [fiber, fiber.alternate]) {
          const node = candidate?.stateNode?.node;

          if (node && !seenNodes.has(node)) {
            seenNodes.add(node);
            nodes.push(node);
          }
        }
      }

      fiber = fiber.return;
    }
  });

  if (nodes.length > 0) {
    getNative().refreshReactNodes(nodes);
  }
};

// Only the older strategies rely on React's handles being repointed; 'hook' fixes the tree inside the commit.
let needsReactRefresh = false;

let flushScheduled = false;

// Refs attach during React's commit; the microtask runs right after it, when the nodes are in the committed tree.
const scheduleFlush = () => {
  if (flushScheduled) {
    return;
  }

  flushScheduled = true;
  Promise.resolve().then(() => {
    flushScheduled = false;
    getNative().flushPending();

    if (needsReactRefresh) {
      refreshReact();
    }
  });
};

const nativeByStyles = new WeakMap<
  object,
  Record<string, Record<string, unknown>>
>();
// One id per distinct native styles object: C++ builds its typed props once per id, not once per view.
const styleIds = new WeakMap<object, number>();
const definedStyles = new Set<number>();
let nextStyleId = 1;
const styleIdOf = (native: object): number => {
  let id = styleIds.get(native);

  if (id === undefined) {
    id = nextStyleId++;
    styleIds.set(native, id);
  }

  return id;
};

export const ShadewindEngine = {
  /** Experimental: native tailwind-merge compatible class merge (see docs/ARCHITECTURE.md section 13). */
  loadClassTable(text: string): boolean {
    return getNative().loadClassTable(text);
  },
  mergeClasses(...parts: string[]): string | undefined {
    return getNative().mergeClasses(...parts);
  },
  /** Declares the theme names in order (native slot ids). Returns the slot count and whether all names fit. */
  configure(names: string[]): { maxThemes: number; ok: boolean } {
    return getNative().configure(names);
  },
  /**
   * The nativeID that makes a view discoverable by the commit hook (no ref, no per-view call): defines the style natively once
   * per distinct styles object and returns `sw:<id>`.
   */
  carrier(styles: ThemedStyles): string {
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

    const id = styleIdOf(native);

    if (!definedStyles.has(id)) {
      definedStyles.add(id);
      getNative().defineStyle(id, native);
    }

    return `sw:${id}`;
  },
  register(ref: unknown, styles: ThemedStyles, renderTheme?: string) {
    const node = getShadowNode(ref);

    if (!node) {
      return false;
    }

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

    getNative().register(node, native, styleIdOf(native), renderTheme);

    registered.add(ref);
    scheduleFlush();

    return true;
  },
  /** Registers with props already converted by toNativeProps (used by the public useThemed). */
  registerRaw(
    ref: unknown,
    native: Record<string, Record<string, unknown>>,
    renderTheme?: string
  ) {
    const node = getShadowNode(ref);

    if (!node) {
      return false;
    }

    getNative().register(node, native, styleIdOf(native), renderTheme);
    registered.add(ref);
    scheduleFlush();

    return true;
  },
  unregister(ref: unknown) {
    const node = getShadowNode(ref);

    registered.delete(ref);

    if (node) {
      getNative().unregister(node);
    }
  },
  /** Applies a theme to every registered view without rendering any React component. */
  setTheme(name: string, strategy: ThemeStrategy = 'hookAsync'): ThemeTimings {
    const timings = getNative().setTheme(name, strategy);

    // the hook family fixes the tree inside the commit; only the older strategies need React's handles repointed
    needsReactRefresh = strategy !== 'hook' && strategy !== 'hookAsync';

    if (needsReactRefresh) {
      refreshReact();
    }

    return timings;
  },
  /** Measurement: clears the longest main-thread busy period (iOS only; starts the run loop observer on first call). */
  resetMainBusy(): void {
    getNative().resetMainBusy();
  },
  /** Measurement: longest main-thread run loop busy period in ms since resetMainBusy (iOS only). */
  mainBusyMs(): number {
    return getNative().mainBusyMs();
  },
  /**
   * Optional hint that a theme switch is probably coming (call it from `onPressIn` of a theme toggle). It reads, off the
   * JS thread, the memory the switch will use, so a switch after a long idle does not pay for cold caches. Changes nothing.
   */
  prepare(): void {
    getNative().prepare();
  },
  /** Debug only. Compares committed tree, nativeProps overlay and expected theme colours. */
  inspect(): InspectReport {
    return getNative().inspect();
  },
  getTheme(): string {
    return getNative().getTheme();
  },
};

/**
 * Callback ref that registers a view's per-theme style on mount and unregisters on unmount.
 * Keep `styles` referentially stable (module constant or useMemo), or the view re-registers every render.
 */
export function useThemedRef(styles: ThemedStyles) {
  const current = useRef<unknown>(null);
  const stable = useMemo(() => styles, [styles]);

  return useCallback(
    (ref: unknown) => {
      if (ref) {
        current.current = ref;
        ShadewindEngine.register(ref, stable);
      } else if (current.current) {
        ShadewindEngine.unregister(current.current);
        current.current = null;
      }
    },
    [stable]
  );
}
