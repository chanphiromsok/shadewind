import { type Ref, useLayoutEffect, useReducer, useRef } from 'react';
import { StyleSheet } from 'react-native';
import type { ThemedStyles } from '../internal';
import { getInternals, installUniwind } from './install';

// Metro's inline requires turn every use of an imported binding into a module lookup at the call site (`_$$_REQUIRE(...)`), once
// per render of every view. The per-view functions below read them from this object instead, filled once at module load.
const R = {
  useLayoutEffect,
  useReducer,
  useRef,
  StyleSheet,
  getInternals,
  installUniwind,
};

// Uniwind's `useStyle`, plus: register the per-theme colours with the engine and stop re-rendering on a theme switch, for the
// components that are safe to hand over. Everything else (and everything when the engine is inactive) keeps Uniwind's behaviour.

export type State = Record<string, boolean>;

const SUPPORTED = ['backgroundColor', 'borderColor', 'color'] as const;
export const ALL_STATE: State = {
  isDisabled: true,
  isFocused: true,
  isPressed: true,
};

// lazy: this module is evaluated before the native runtime exists
const engine = () =>
  (require('shadewind/internal') as typeof import('../internal'))
    .ShadewindEngine;

/** Dev diagnostics: className -> 'engine' or why it fell back. Collected only when `__SHADEWIND_DEBUG__` or __DEV__. */
export const decisions = new Map<string, string>();
/** Dev diagnostics: testID or className -> render count. */
export const renders = new Map<string, number>();

const debugOn = () =>
  __DEV__ ||
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ ===
    true;

export const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

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

// the theme a plan was resolved for: passed at register so C++ knows React's props are already current
export const renderThemeOf = new WeakMap<object, string>();

// Only a view's first attach is a fresh render of the current props. A re-attach (screen revealed after a freeze, Activity shown
// again) finds whatever the tree holds now, which the commit hook may have re-themed while the view was unbound: claiming "rendered
// with the current theme" there makes the engine skip it and the view stays on the old theme. So the render theme is passed once per
// node; a re-attach lets the next commit apply the current theme.
const attachedNodes = new WeakSet<object>();

export const renderThemeFor = (
  node: unknown,
  themed: object
): string | undefined => {
  if (typeof node !== 'object' || node === null || attachedNodes.has(node)) {
    return undefined;
  }

  attachedNodes.add(node);

  return renderThemeOf.get(themed);
};

type Resolved = ReturnType<
  NonNullable<ReturnType<typeof getInternals>>['UniwindStore']['getStyles']
>;
type Plan = { themed: ThemedStyles | null; reason: string };

// What getStyles would return for this className, state and (runtime) theme, without putting it in Uniwind's cache. A plan probes the
// other themes and ALL_STATE once per className; through getStyles every probe stayed in Uniwind's cache with its own listener
// subscription, three entries per className instead of the view's one, never read again (docs/BENCHMARK.md, memory). Same guards as getStyles (no className, a theme without
// a cache). The instance's own resolveStyles is the native resolver when the class table is loaded (nativeResolver.ts).
export const resolveUncached = (
  className: string,
  props: Record<string, any>,
  state: State | undefined,
  context: { scopedTheme: string | null }
): Resolved => {
  const store = getInternals()!.UniwindStore as unknown as {
    cache?: Record<string, unknown>;
    runtime: { currentThemeName: string };
    resolveStyles?: (...args: unknown[]) => Resolved;
    getStyles: (...args: unknown[]) => Resolved;
  };
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

// One `themed` object per distinct per-theme colours (and render theme): every className whose theme-dependent part is `bg-card`
// shares it, so the native conversion (nativeByStyles), the style id and the native ThemeStyle are made once, and a view that moves to
// another className with the same colours keeps its binding. Bounded: an evicted set is simply made again (a new style id).
const INTERN_LIMIT = 512;
const interned = new Map<string, ThemedStyles>();

const intern = (
  themed: Record<string, Record<string, unknown>>
): ThemedStyles => {
  const key = `${getInternals()!.UniwindStore.runtime.currentThemeName}\u0000${JSON.stringify(themed)}`;
  const found = interned.get(key);

  if (found) {
    return found;
  }

  if (interned.size >= INTERN_LIMIT) {
    interned.delete(interned.keys().next().value!);
  }

  interned.set(key, themed as unknown as ThemedStyles);

  return themed as unknown as ThemedStyles;
};

const plan = (
  className: string | undefined,
  props: Record<string, any>,
  state: State | undefined,
  context: { scopedTheme: string | null },
  current: Resolved,
  hasInlineOverlap: boolean
): Plan => {
  const decide = (themed: ThemedStyles | null, reason: string): Plan => {
    if (debugOn()) {
      decisions.set(String(props.testID ?? className), reason);
    }

    return { themed, reason };
  };
  const { UniwindStore, StyleDependency } = getInternals()!;

  if (!className) {
    return { themed: null, reason: 'no className' };
  }

  if (context.scopedTheme !== null) {
    return decide(null, 'scoped theme');
  }

  if (!current.dependencies.includes(StyleDependency.Theme)) {
    return decide(null, 'not theme dependent');
  }

  if (current.hasDataAttributes) {
    return decide(null, 'data attributes');
  }

  if (hasInlineOverlap) {
    return decide(null, 'inline style overlaps');
  }

  const themes = Object.keys(UniwindStore.vars);
  const perTheme: Record<string, Record<string, unknown>> = {};

  const renderTheme = UniwindStore.runtime.currentThemeName;

  for (const theme of themes) {
    // the render theme's style is `current` (what getStyles returned for this render); the others are probed without caching
    perTheme[theme] =
      theme === renderTheme
        ? current.styles
        : withTheme(
            theme,
            () => resolveUncached(className, props, state, context).styles
          );
  }

  // State variants (pressed, focused) change styles without a theme change. The resting state is bound to the engine; while the
  // view is pressed or focused it is unbound (React draws the state style, the engine must not paint over it). A Pressable
  // pauses and resumes the binding from onPressIn / onPressOut (see Pressable.tsx), a view with React state passes it in `state`.
  const stateful = !same(
    resolveUncached(className, props, ALL_STATE, context).styles,
    current.styles
  );

  if (stateful && (state?.isPressed || state?.isFocused)) {
    return decide(null, 'interacting');
  }

  const keys = new Set<string>();

  for (const theme of themes) {
    Object.keys(perTheme[theme]!).forEach((key) => keys.add(key));
  }

  const differing = [...keys].filter(
    (key) =>
      new Set(themes.map((theme) => JSON.stringify(perTheme[theme]![key])))
        .size > 1
  );

  if (differing.length === 0) {
    return decide(null, 'no difference between themes');
  }

  const unsupported = differing.filter(
    (key) => !(SUPPORTED as readonly string[]).includes(key)
  );

  if (unsupported.length > 0) {
    return decide(null, `unsupported: ${unsupported.join(',')}`);
  }

  // `light:bg-x` defines the background in one theme only; in the others it is simply not painted. An unset background is
  // transparent, so that is a value the engine can apply. (An unset colour or border colour has platform defaults: not folded.)
  for (const theme of themes) {
    for (const key of differing) {
      if (key === 'backgroundColor' && perTheme[theme]![key] === undefined) {
        // a copy: perTheme[renderTheme] is the style object Uniwind cached and React renders
        perTheme[theme] = { ...perTheme[theme]!, [key]: 'transparent' };
      }
    }
  }

  if (
    themes.some((theme) =>
      differing.some((key) => perTheme[theme]![key] === undefined)
    )
  ) {
    return decide(null, 'key missing in a theme');
  }

  const fresh: Record<string, Record<string, unknown>> = {};

  for (const theme of themes) {
    fresh[theme] = Object.fromEntries(
      differing.map((key) => [key, perTheme[theme]![key]])
    );
  }

  const themed = intern(fresh);

  renderThemeOf.set(themed, renderTheme);

  if (__DEV__ && themed === (fresh as unknown)) {
    engine().label(themed, `className: "${className}"`);
  }

  return decide(themed, 'engine');
};

// The store returns the same object for the same className / state / theme (and a new one after it invalidates its cache), so a
// plan is a pure function of that object, the inline-overlap flag and the scoped-theme flag. Without this every mounted view
// re-resolves the style once per theme and compares them as JSON: thousands of identical plans for a handful of classNames.
const planCache = new WeakMap<object, [Plan | undefined, Plan | undefined]>();

export const cachedPlan = (
  className: string | undefined,
  props: Record<string, any>,
  state: State | undefined,
  context: { scopedTheme: string | null },
  current: Resolved,
  hasInlineOverlap: boolean
): Plan => {
  if (
    !className ||
    context.scopedTheme !== null ||
    current.hasDataAttributes ||
    debugOn()
  ) {
    return plan(className, props, state, context, current, hasInlineOverlap);
  }

  const slot = hasInlineOverlap ? 1 : 0;
  let entry = planCache.get(current);

  if (!entry) {
    entry = [undefined, undefined];
    planCache.set(current, entry);
  }

  const made = (entry[slot] ??= plan(
    className,
    props,
    state,
    context,
    current,
    hasInlineOverlap
  ));

  return made;
};

const bump = (n: number) => n + 1;

// A plan that left a theme-dependent className to React: the engine does not paint it and nothing else changes it on a switch. (A
// className that does not depend on the theme, or has the same style in every theme, a scoped theme, and a view being pressed need no
// re-render for a switch.)
const needsThemeRerender = (result: Plan): boolean =>
  result.themed === null &&
  (result.reason === 'data attributes' ||
    result.reason === 'inline style overlaps' ||
    result.reason === 'key missing in a theme' ||
    result.reason.startsWith('unsupported'));
const NO_PLAN: Plan = { themed: null, reason: 'engine inactive' };

// the dependencies of a resolved style without the theme, computed once per resolution (the store reuses `current`)
const depsCache = new WeakMap<object, number[]>();
export const nonThemeDeps = (current: Resolved, theme: number): number[] => {
  let deps = depsCache.get(current);

  if (!deps) {
    deps = current.dependencies.filter((dependency) => dependency !== theme);
    depsCache.set(current, deps);
  }

  return deps;
};

// The subscription of a view with an accent className (Text's selectionColorClassName): the non-theme dependencies of its style plus
// every dependency of the accent, the theme included (Uniwind's useAccentColor re-renders on a theme change, so does this). One array
// per pair of resolutions, so the layout effect does not subscribe again on every render.
type DepsCache = WeakMap<object, WeakMap<object, number[]>>;
const accentDepsCache: DepsCache = new WeakMap();
// engine inactive: the style's own theme dependency is kept too (a separate cache, the arrays differ)
const inactiveAccentDepsCache: DepsCache = new WeakMap();
const accentDeps = (
  current: Resolved,
  accent: Resolved,
  theme: number,
  active = true
): number[] => {
  const cache = active ? accentDepsCache : inactiveAccentDepsCache;
  let byAccent = cache.get(current);

  if (!byAccent) {
    byAccent = new WeakMap();
    cache.set(current, byAccent);
  }

  let deps = byAccent.get(accent);

  if (!deps) {
    const own = active ? nonThemeDeps(current, theme) : current.dependencies;

    deps = [...new Set([...own, ...accent.dependencies])];
    byAccent.set(accent, deps);
  }

  return deps;
};

let warnedAccent = false;

// once per app: a helper, so a render only calls it (the flag is a module variable)
const warnNoAccent = (accentClassName: string) => {
  if (!warnedAccent) {
    warnedAccent = true;
    console.warn(
      `[shadewind] selectionColorClassName '${accentClassName}' has no accent colour (use an accent-* class)`
    );
  }
};

const warnUnbound = () => {
  if (debugOn()) {
    console.warn(
      '[shadewind] could not bind a view: stale after a theme switch'
    );
  }
};

let contextHook: (() => { scopedTheme: string | null }) | undefined;
const useContext = () =>
  (contextHook ??= (
    require('uniwind-internal/core/context') as typeof import('uniwind-internal/core/context')
  ).useUniwindContext)();

// One Uniwind subscription per distinct dependency list, shared by every view that has it: a view's layout effect then adds its
// `rerender` to a Set instead of calling UniwindListener.subscribe, which builds a Map, a dispose closure and a closure per
// dependency for each view. The shared listener is subscribed to the same dependencies, so a
// notify reaches each view as often as its own subscription would have.
// Order: Uniwind's store adds its cache-delete listeners during render, so a group subscribed earlier is called before a newer
// cache entry is dropped within the same notify. That is fine only because `rerender` schedules a React update and renders later.
type Group = { views: Set<() => void>; dispose: () => void };
const groups = new Map<string, Group>();
const groupKeys = new WeakMap<number[], string>();

export const depsKey = (deps: number[]): string => {
  let key = groupKeys.get(deps);

  if (key === undefined) {
    key = deps.join(',');
    groupKeys.set(deps, key);
  }

  return key;
};

export const subscribeShared = (
  rerender: () => void,
  deps: number[]
): (() => void) => {
  const key = depsKey(deps);
  let group = groups.get(key);

  if (!group) {
    const views = new Set<() => void>();

    group = {
      views,
      dispose: R.getInternals()!.UniwindListener.subscribe(
        () => views.forEach((view) => view()),
        deps
      ),
    };
    groups.set(key, group);
  }

  const joined = group;

  joined.views.add(rerender);

  return () => {
    joined.views.delete(rerender);

    // the last view of the group is gone: let Uniwind drop the shared listener (a remount subscribes again)
    if (joined.views.size === 0 && groups.get(key) === joined) {
      joined.dispose();
      groups.delete(key);
    }
  };
};

// Per styled view: context and reducer here, the subscription in the ref (useEngineRef); Uniwind's useStyle has a layout effect too. With the engine active a theme change never
// re-renders a view (rule 1): an engine view is kept right by the commit hook, a view the engine cannot take is correct at mount and
// stale after a later switch. With the engine inactive the view subscribes to the theme like Uniwind's own components.
export const useShadewindStyle = (
  className: string | undefined,
  props: Record<string, any>,
  state?: State,
  // Text's selectionColorClassName, resolved here rather than with Uniwind's useAccentColor: that is three more hooks and a layout
  // effect for every Text, used or not
  accentClassName?: string
) => {
  'use no memo';

  const { active } = R.installUniwind();
  const { UniwindStore, StyleDependency } = R.getInternals() ?? {};

  if (debugOn()) {
    const key = String(props.testID ?? className);

    renders.set(key, (renders.get(key) ?? 0) + 1);
  }

  const context = useContext();
  // re-render for what is not the theme (orientation, viewport, RTL, font scale), like Uniwind does
  const [, rerender] = R.useReducer(bump, 0);
  const current = UniwindStore!.getStyles(className, props, state, context);
  let hasInlineOverlap = false;

  if (props.style) {
    const flat = R.StyleSheet.flatten(props.style) as
      Record<string, unknown> | undefined;

    hasInlineOverlap =
      flat !== undefined && SUPPORTED.some((key) => flat[key] !== undefined);
  }

  const planned = active
    ? cachedPlan(className, props, state, context, current, hasInlineOverlap)
    : NO_PLAN;
  const accent = accentClassName
    ? UniwindStore!.getStyles(accentClassName, props, state, context)
    : null;
  // The theme dependency is dropped only for a view the engine paints (planned.themed). Engine inactive, or a className the engine
  // cannot take (an inline style over a painted key, a property the engine does not paint, a scoped theme...): nothing re-themes the
  // view natively, so it re-renders on a theme switch like Uniwind's own components. (Dropping it for those left the view with the style
  // of the theme it first rendered under: a search bar with `border-divider` and an inline background kept the dark theme's border
  // after the app switched to light at start-up.)
  const engineHandles = active && !needsThemeRerender(planned);
  const deps = accent
    ? accentDeps(current, accent, StyleDependency!.Theme, engineHandles)
    : engineHandles
      ? nonThemeDeps(current, StyleDependency!.Theme)
      : current.dependencies;
  const accentColor = accent
    ? (accent.styles as { accentColor?: string }).accentColor
    : undefined;

  if (__DEV__ && accentClassName?.trim() && accentColor === undefined) {
    warnNoAccent(accentClassName);
  }

  // no layout effect: the view subscribes from its ref (useEngineRef), which attaches and detaches at the same moments (commit,
  // unmount, a Suspense / Activity / freeze hide and reveal); one effect less per view. A caller whose ref may never attach
  // (withUniwind wraps any component) subscribes with useEffectSubscription instead.
  return {
    style: current.styles,
    themed: planned.themed,
    onRegisterFailed: warnUnbound,
    accentColor,
    deps,
    rerender: rerender as () => void,
  };
};

// `pause` / `resume` exist only on a pausable ref (a Pressable's): adding properties to a function object is slow on Hermes (about
// 0.7 us per view on a desktop VM, a third of a mount's registration work), so the other components get the plain function.
type EngineRef = ((node: unknown) => void) & {
  pause?(): void;
  resume?(): void;
};

type RefHolder = {
  themed: ThemedStyles | null;
  user: Ref<unknown> | undefined;
  depsKey: string;
  ref: EngineRef;
  // a later render bound the view to other styles, or to none: this holder's detach unbinds
  superseded: boolean;
};

const makeHolder = (
  themed: ThemedStyles | null,
  user: Ref<unknown> | undefined,
  onRegisterFailed: (() => void) | undefined,
  pausable: boolean,
  deps: number[],
  rerender: () => void
): RefHolder => {
  let registered: unknown = null;
  let attached: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const holder: RefHolder = {
    themed,
    user,
    depsKey: depsKey(deps),
    superseded: false,
    ref: null as unknown as EngineRef,
  };

  const ref = (node: unknown) => {
    attached = node;

    // re-render for what the engine does not handle (variables, viewport, RTL, font scale; the theme too when it is inactive)
    if (node && !unsubscribe && deps.length > 0) {
      unsubscribe = subscribeShared(rerender, deps);
    } else if (!node && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    if (!themed) {
      // not bound to the engine: the ref only subscribes
    } else if (node) {
      // another host instance under the same holder (the element type changed): the old one is unmounted, forget it
      if (registered && registered !== node) {
        registered = null;
      }

      // a re-attach of the same view (Suspense/Activity reveal) is already registered: register() returns at once
      if (engine().register(node, themed, renderThemeFor(node, themed))) {
        registered = node;
      } else {
        onRegisterFailed?.();
      }
    } else if (holder.superseded && registered) {
      // React's own props are right for the view now. A plain detach (a hide, an unmount) keeps the binding: the commit hook
      // themes a hidden subtree when it shows, and an unmounted view takes its entry with it.
      engine().unregister(registered);
      registered = null;
    }

    if (typeof user === 'function') {
      user(node);
    } else if (user && typeof user === 'object') {
      (user as { current: unknown }).current = node;
    }
  };

  if (!pausable) {
    holder.ref = ref;

    return holder;
  }

  holder.ref = Object.assign(ref, {
    // a Pressable unbinds the view while it is pressed (React draws the pressed style) and binds it again on release
    pause() {
      if (registered) {
        engine().unregister(registered);
        registered = null;
      }
    },
    resume() {
      // no render theme: the props React has now may still be the pressed ones, so let the next commit apply the theme
      if (
        attached &&
        !registered &&
        themed &&
        engine().register(attached, themed)
      ) {
        registered = attached;
      }
    },
  });

  return holder;
};

/**
 * The subscription as a layout effect, for a caller that cannot rely on its ref attaching (withUniwind: the wrapped component may
 * ignore `ref`). Pass `NO_DEPS` to useEngineRef with it, so the ref does not subscribe a second time.
 */
export const useEffectSubscription = (styled: {
  deps: number[];
  rerender: () => void;
}) => {
  R.useLayoutEffect(
    () =>
      styled.deps.length > 0
        ? subscribeShared(styled.rerender, styled.deps)
        : undefined,

    [styled.deps]
  );
};

export const NO_DEPS: number[] = [];

/** What useShadewindStyle returns and the ref needs. */
type Styled = {
  themed: ThemedStyles | null;
  onRegisterFailed?: () => void;
  deps: number[];
  rerender: () => void;
};

/**
 * The ref for a styled view: subscribes it to what re-renders it, registers it with the engine when it is bound, and forwards to
 * the user's ref. A view with neither gets the user's own ref back unchanged, so React attaches nothing for it. With `pausable`
 * the ref also carries `pause()` / `resume()` (Pressable).
 */
export const useEngineRef = (
  styled: Styled,
  userRef: Ref<unknown> | undefined,
  pausable = false
): any => {
  // Writes the holder during render on purpose, so never compiled. The old ref's detach runs in React's mutation phase, before
  // the shadow tree commits, and must know by then whether this render replaced its binding (unbind) or not (a hide or an
  // unmount keeps it); only the render knows, and the other carrier, a layout effect per view, is the mount cost the ref
  // subscription removed. A render React throws away heals: every attach registers again.
  'use no memo';

  const holder = R.useRef<RefHolder | null>(null);
  const { themed, deps } = styled;

  /* eslint-disable react-hooks/immutability -- the render-time holder hand-over above */
  if (!themed && deps.length === 0) {
    if (holder.current) {
      holder.current.superseded = true;
      holder.current = null;
    }

    return userRef;
  }

  let h = holder.current;
  const key = depsKey(deps);

  if (!h || h.themed !== themed || h.user !== userRef || h.depsKey !== key) {
    if (h) {
      // only the dependencies changed: keep the engine binding, the new holder finds the view registered
      h.superseded = h.themed !== themed || h.user !== userRef;
    }

    h = holder.current = makeHolder(
      themed,
      userRef,
      styled.onRegisterFailed,
      pausable,
      deps,
      styled.rerender
    );
  }
  /* eslint-enable react-hooks/immutability */

  return h.ref;
};
