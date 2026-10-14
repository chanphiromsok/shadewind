import { useCallback, useMemo, useRef } from 'react';
import { processColor, type ColorValue } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { UniwindShadow } from './UniwindShadow.nitro';

// Raw JSI methods registered natively in HybridUniwindShadow::loadHybridMethods.
type RawMethods = {
  register(shadowNode: unknown, propsByTheme: Record<string, object>): void;
  unregister(shadowNode: unknown): void;
  setTheme(name: string, strategy?: ThemeStrategy): ThemeTimings;
  flushPending(): void;
  prepare(): void;
  resetMainBusy(): void;
  mainBusyMs(): number;
  inspect(): InspectReport;
  refreshReactNodes(nodes: unknown[]): number;
};

const native = NitroModules.createHybridObject<UniwindShadow>(
  'UniwindShadow'
) as UniwindShadow & RawMethods;

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
 * How a theme change reaches the screen.
 * - 'hookAsync' (default): the commit runs on a background thread, so the JS thread is free right away (about 0.05 ms for
 *   2000 views); the screen updates about 3 ms later.
 * - 'hook': typed props applied inside a commit hook, so every commit (React's too) keeps the theme.
 *   No nativeProps overlay and no JS fiber walk.
 * - 'hookAsync': like 'hook' but the commit runs on a background thread (JS thread is free right away).
 *   scan/clone/commit/direct in the timings then belong to the previous call.
 * - 'stock': RN's UIManager::updateShadowTree (whole-tree walk)
 * - 'fast': one single-pass shadow-tree commit that clones only the touched nodes
 * - 'fastAsync': like 'fast' but the UI thread mounts it later instead of the caller waiting
 * - 'direct': update native views immediately, shadow tree catches up on the next React clone
 * - 'both': direct update now + single-pass commit
 */
export type ThemeStrategy =
  | 'hook'
  | 'hookAsync'
  | 'stock'
  | 'fast'
  | 'fastAsync'
  | 'direct'
  | 'both';

/** Style subset supported in v0: visual-only props that don't need a Yoga layout pass. */
export type ThemedStyle = {
  backgroundColor?: ColorValue;
  borderColor?: ColorValue;
  /** Text colour (Text only). Changing it makes React Native re-measure the paragraph. */
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
export function toNativeProps(style: ThemedStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(style) as Array<keyof ThemedStyle>) {
    const value = style[key];

    if (value === undefined) {
      continue;
    }

    out[key] = COLOR_KEYS.has(key) ? processColor(value as ColorValue) : value;
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
    native.refreshReactNodes(nodes);
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
    native.flushPending();

    if (needsReactRefresh) {
      refreshReact();
    }
  });
};

export const UniwindShadowEngine = {
  register(ref: unknown, styles: ThemedStyles) {
    const node = getShadowNode(ref);

    if (!node) {
      return false;
    }

    native.register(
      node,
      Object.fromEntries(
        Object.entries(styles).map(([theme, style]) => [
          theme,
          toNativeProps(style),
        ])
      )
    );

    registered.add(ref);
    scheduleFlush();

    return true;
  },
  unregister(ref: unknown) {
    const node = getShadowNode(ref);

    registered.delete(ref);

    if (node) {
      native.unregister(node);
    }
  },
  /** Applies a theme to every registered view without rendering any React component. */
  setTheme(name: string, strategy: ThemeStrategy = 'hookAsync'): ThemeTimings {
    const timings = native.setTheme(name, strategy);

    // the hook family fixes the tree inside the commit; only the older strategies need React's handles repointed
    needsReactRefresh =
      strategy !== 'hook' && strategy !== 'hookAsync';

    if (needsReactRefresh) {
      refreshReact();
    }

    return timings;
  },
  /** Measurement: clears the longest main-thread busy period (iOS only; starts the run loop observer on first call). */
  resetMainBusy(): void {
    native.resetMainBusy();
  },
  /** Measurement: longest main-thread run loop busy period in ms since resetMainBusy (iOS only). */
  mainBusyMs(): number {
    return native.mainBusyMs();
  },
  /**
   * Optional hint that a theme switch is probably coming (call it from `onPressIn` of a theme toggle). It reads, off the
   * JS thread, the memory the switch will use, so a switch after a long idle does not pay for cold caches. Changes nothing.
   */
  prepare(): void {
    native.prepare();
  },
  /** Debug only. Compares committed tree, nativeProps overlay and expected theme colours. */
  inspect(): InspectReport {
    return native.inspect();
  },
  getTheme(): string {
    return native.getTheme();
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
        UniwindShadowEngine.register(ref, stable);
      } else if (current.current) {
        UniwindShadowEngine.unregister(current.current);
        current.current = null;
      }
    },
    [stable]
  );
}
