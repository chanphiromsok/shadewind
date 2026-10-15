import {
  type Ref,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { StyleSheet } from 'react-native';
import type { ThemedStyles } from '../internal';
import { getInternals, installUniwind } from './install';

// Uniwind's `useStyle`, plus: register the per-theme colours with the engine and stop re-rendering on a theme switch, for the
// components that are safe to hand over. Everything else (and everything when the engine is inactive) keeps Uniwind's behaviour.

type State = Record<string, boolean>;

const SUPPORTED = ['backgroundColor', 'borderColor', 'color'] as const;
const ALL_STATE: State = {
  isDisabled: true,
  isFocused: true,
  isPressed: true,
};

// lazy: this module is evaluated before the native runtime exists
const engine = () =>
  (require('shadewind/internal') as typeof import('../internal'))
    .ShadewindEngine;
const useContext = () =>
  (
    require('uniwind-internal/core/context') as typeof import('uniwind-internal/core/context')
  ).useUniwindContext();

/** Dev diagnostics: className -> 'engine' or why it fell back. Collected only when `__SHADEWIND_DEBUG__` or __DEV__. */
export const decisions = new Map<string, string>();
/** Dev diagnostics: testID or className -> render count. */
export const renders = new Map<string, number>();

const debugOn = () =>
  __DEV__ ||
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ ===
    true;

const same = (a: unknown, b: unknown) =>
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
const renderThemeOf = new WeakMap<object, string>();

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

  return decide(themed as unknown as ThemedStyles, 'engine');
};

// The store returns the same object for the same className / state / theme (and a new one after it invalidates its cache), so a
// plan is a pure function of that object, the inline-overlap flag and the scoped-theme flag. Without this every mounted view
// re-resolves the style once per theme and compares them as JSON: thousands of identical plans for a handful of classNames.
const planCache = new WeakMap<object, [Plan | undefined, Plan | undefined]>();

const cachedPlan = (
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

export const useShadewindStyle = (
  className: string | undefined,
  props: Record<string, any>,
  state?: State,
  // true for components that render a host view directly (View, Text, Pressable, TouchableOpacity): the style id then travels
  // as `nativeID` and the commit hook finds the view, with no ref and no per-view call. A user `nativeID` keeps the ref path.
  allowCarrier = false
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
  const [, rerender] = useReducer(() => ({}), {});
  const current = UniwindStore!.getStyles(className, props, state, context);
  const flat = StyleSheet.flatten(props.style) as
    Record<string, unknown> | undefined;
  const hasInlineOverlap =
    flat !== undefined && SUPPORTED.some((key) => flat[key] !== undefined);
  const planned = useMemo(
    () =>
      active
        ? cachedPlan(
            className,
            props,
            state,
            context,
            current,
            hasInlineOverlap
          )
        : { themed: null, reason: 'engine inactive' },
    // `current` is cached per theme/state by the store: a new object means a different resolution
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, current, hasInlineOverlap, context]
  );
  const dependencies = current.dependencies.filter(
    (dependency) => dependency !== StyleDependency!.Theme
  );

  useLayoutEffect(() => {
    if (dependencies.length > 0) {
      return UniwindListener!.subscribe(rerender, dependencies);
    }

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependencies.join(',')]);

  // Rule 1: a theme change never re-renders a styled view. An engine view is kept right by the commit hook; a view the engine
  // cannot take is correct at mount and stale after a later switch (dev warning from `plan`).
  const onRegisterFailed = useCallback(() => {
    if (debugOn()) {
      console.warn(
        `[shadewind] could not bind ${String(props.testID ?? className)}: stale after a theme switch`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nativeID =
    allowCarrier && planned.themed && !props.nativeID
      ? engine().carrier(planned.themed)
      : undefined;

  return {
    style: current.styles,
    themed: planned.themed,
    onRegisterFailed,
    nativeID,
  };
};

/**
 * Callback ref: registers the view with the engine while `themed` is set, and forwards to the user's ref. The returned function
 * also carries `pause()` / `resume()`: a Pressable unbinds the view while it is pressed (React draws the pressed style) and
 * binds it again on release, with native calls only (no React state).
 */
// Debug only (measurement arm): keep the ref machinery, skip the engine call. `-armB 1` in example-real sets it.
const skipRegister = () =>
  (globalThis as { __SHADEWIND_SKIP_REGISTER?: boolean })
    .__SHADEWIND_SKIP_REGISTER === true;

export const useEngineRef = (
  themed: ThemedStyles | null,
  userRef: Ref<unknown> | undefined,
  onRegisterFailed?: () => void,
  carrier?: string
) => {
  const registered = useRef<unknown>(null);
  const attached = useRef<unknown>(null);
  const themedRef = useRef(themed);

  themedRef.current = themed;

  const ref = useCallback(
    (node: unknown) => {
      attached.current = node;

      if (registered.current) {
        engine().unregister(registered.current);
        registered.current = null;
      }

      if (node && themed && !skipRegister()) {
        if (engine().register(node, themed, renderThemeOf.get(themed))) {
          registered.current = node;
        } else {
          onRegisterFailed?.();
        }
      }

      if (typeof userRef === 'function') {
        userRef(node);
      } else if (userRef && typeof userRef === 'object') {
        (userRef as { current: unknown }).current = node;
      }
    },
    [themed, userRef, onRegisterFailed]
  );

  const pause = useCallback(() => {
    if (registered.current) {
      engine().unregister(registered.current);
      registered.current = null;
    }
  }, []);

  const resume = useCallback(() => {
    const node = attached.current;
    const styles = themedRef.current;

    // no render theme: the props React has right now may still be the pressed ones, so let the next commit apply the theme
    if (
      node &&
      styles &&
      !registered.current &&
      engine().register(node, styles)
    ) {
      registered.current = node;
    }
  }, []);

  // carrier mode: the view is found by its nativeID, so no ref is attached for the engine (the user's own ref passes through)
  if (carrier) {
    return userRef as any;
  }

  return Object.assign(ref, { pause, resume });
};
