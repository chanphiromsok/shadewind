import { type Ref, useLayoutEffect, useReducer, useRef } from 'react';
import { StyleSheet } from 'react-native';
import type { ThemedStyles } from '../internal';
import { atSwitchEnabled } from './atSwitch';
import { getInternals, installUniwind } from './install';

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
const withTheme = <T>(theme: string, fn: () => T): T => {
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
// with the current theme" there makes the engine skip it and the view stays on the old theme (measured: 77 of 174 views of a revealed
// tab). So the render theme is passed once per node; a re-attach lets the next commit apply the current theme.
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

  for (const theme of themes) {
    perTheme[theme] = withTheme(
      theme,
      () => UniwindStore.getStyles(className, props, state, context).styles
    );
  }

  // State variants (pressed, focused) change styles without a theme change. The resting state is bound to the engine; while the
  // view is pressed or focused it is unbound (React draws the state style, the engine must not paint over it). A Pressable
  // pauses and resumes the binding from onPressIn / onPressOut (see Pressable.tsx), a view with React state passes it in `state`.
  const stateful = !same(
    UniwindStore.getStyles(className, props, ALL_STATE, context).styles,
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
        perTheme[theme]![key] = 'transparent';
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

  const themed: Record<string, Record<string, unknown>> = {};

  for (const theme of themes) {
    themed[theme] = Object.fromEntries(
      differing.map((key) => [key, perTheme[theme]![key]])
    );
  }

  renderThemeOf.set(themed, UniwindStore.runtime.currentThemeName);

  if (__DEV__) {
    engine().label(themed, `className: "${className}"`);
  }

  return decide(themed as unknown as ThemedStyles, 'engine');
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

// Per styled view: 3 hooks, like Uniwind's useStyle (context, reducer, layout effect). With the engine active a theme change never
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

  const { active } = installUniwind();
  const { UniwindStore, UniwindListener, StyleDependency } =
    getInternals() ?? {};

  if (debugOn()) {
    const key = String(props.testID ?? className);

    renders.set(key, (renders.get(key) ?? 0) + 1);
  }

  const context = useContext();
  // re-render for what is not the theme (orientation, viewport, RTL, font scale), like Uniwind does
  const [, rerender] = useReducer(bump, 0);
  const current = UniwindStore!.getStyles(className, props, state, context);
  let hasInlineOverlap = false;

  if (props.style) {
    const flat = StyleSheet.flatten(props.style) as
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
  // engine inactive: nothing re-themes the view natively, so it re-renders on a theme switch like Uniwind's own components
  const deps = accent
    ? accentDeps(current, accent, StyleDependency!.Theme, active)
    : active
      ? nonThemeDeps(current, StyleDependency!.Theme)
      : current.dependencies;
  const accentColor = accent
    ? (accent.styles as { accentColor?: string }).accentColor
    : undefined;

  if (
    __DEV__ &&
    accentClassName?.trim() &&
    accentColor === undefined &&
    !warnedAccent
  ) {
    warnedAccent = true;
    console.warn(
      `[shadewind] selectionColorClassName '${accentClassName}' has no accent colour (use an accent-* class)`
    );
  }

  useLayoutEffect(
    () =>
      deps.length > 0 ? UniwindListener!.subscribe(rerender, deps) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deps]
  );

  return {
    style: current.styles,
    themed: planned.themed,
    onRegisterFailed: warnUnbound,
    accentColor,
  };
};

// `pause` / `resume` exist only on a pausable ref (a Pressable's): adding properties to a function object is slow on Hermes (about
// 0.7 us per view on a desktop VM, a third of a mount's registration work), so the other components get the plain function.
type EngineRef = ((node: unknown) => void) & {
  pause?(): void;
  resume?(): void;
};

type RefHolder = {
  themed: ThemedStyles;
  user: Ref<unknown> | undefined;
  ref: EngineRef;
  // a later render bound the view to other styles, or to none: this holder's detach unbinds
  superseded: boolean;
};

const makeHolder = (
  themed: ThemedStyles,
  user: Ref<unknown> | undefined,
  onRegisterFailed: (() => void) | undefined,
  pausable: boolean
): RefHolder => {
  let registered: unknown = null;
  let attached: unknown = null;

  const holder: RefHolder = {
    themed,
    user,
    superseded: false,
    ref: null as unknown as EngineRef,
  };

  const ref = (node: unknown) => {
    attached = node;

    if (node) {
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
      if (attached && !registered && engine().register(attached, themed)) {
        registered = attached;
      }
    },
  });

  return holder;
};

/**
 * The ref for an engine view: registers on attach and forwards to the user's ref. A view that is not bound gets the user's own
 * ref back unchanged, so React attaches nothing for it. With `pausable` the ref also carries `pause()` / `resume()` (Pressable).
 */
export const useEngineRef = (
  themed: ThemedStyles | null,
  userRef: Ref<unknown> | undefined,
  onRegisterFailed?: () => void,
  pausable = false
): any => {
  const holder = useRef<RefHolder | null>(null);

  if (!themed) {
    if (holder.current) {
      holder.current.superseded = true;
      holder.current = null;
    }

    return userRef;
  }

  let h = holder.current;

  if (!h || h.themed !== themed || h.user !== userRef) {
    if (h) {
      h.superseded = true;
    }

    h = holder.current = makeHolder(
      themed,
      userRef,
      onRegisterFailed,
      pausable
    );
  }

  return h.ref;
};

// Register at switch (atSwitch.ts): the view carries its styles as `$sw` and the walk before a switch binds it, so there is no ref to
// attach at mount. A render that changes the view's styles needs a ref once, because the engine keeps painting what it was bound
// with over React's new props until it is told otherwise: on that render the ref rebinds the view (or unbinds it) when it attaches.
// The ref only fires for a view the walk has bound; a first render, and every render with the same styles, attach nothing.
const useSwitchRef = (
  themed: ThemedStyles | null,
  userRef: Ref<unknown> | undefined
): any => {
  const last = useRef<ThemedStyles | null | undefined>(undefined);
  const before = last.current;

  last.current = themed;

  if (before === undefined || before === themed) {
    return userRef;
  }

  return (node: unknown) => {
    if (node) {
      engine().rebindHost(node, themed);
    }

    if (typeof userRef === 'function') {
      userRef(node);
    } else if (userRef && typeof userRef === 'object') {
      (userRef as { current: unknown }).current = node;
    }
  };
};

/**
 * The ref of a View or Text: with register at switch (atSwitch.ts) none unless the styles changed, otherwise useEngineRef. The flag
 * is fixed for the life of the app, so the hooks are the same on every render.
 */
export const useRegistration = (
  themed: ThemedStyles | null,
  userRef: Ref<unknown> | undefined,
  onRegisterFailed?: () => void
): any =>
  atSwitchEnabled()
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      useSwitchRef(themed, userRef)
    : // eslint-disable-next-line react-hooks/rules-of-hooks
      useEngineRef(themed, userRef, onRegisterFailed);
