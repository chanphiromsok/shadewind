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

  // state variants (pressed, disabled, focused) change styles without a theme change: not handled by the engine
  if (
    !same(
      UniwindStore.getStyles(className, props, ALL_STATE, context).styles,
      current.styles
    )
  ) {
    return decide(null, 'state variants');
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

  return (entry[slot] ??= plan(
    className,
    props,
    state,
    context,
    current,
    hasInlineOverlap
  ));
};

export const useShadewindStyle = (
  className: string | undefined,
  props: Record<string, any>,
  state?: State
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

  return { style: current.styles, themed: planned.themed, onRegisterFailed };
};

/** Callback ref: registers the view with the engine while `themed` is set, and forwards to the user's ref. */
export const useEngineRef = (
  themed: ThemedStyles | null,
  userRef: Ref<unknown> | undefined,
  onRegisterFailed?: () => void
) => {
  const registered = useRef<unknown>(null);

  return useCallback(
    (node: unknown) => {
      if (registered.current) {
        engine().unregister(registered.current);
        registered.current = null;
      }

      if (node && themed) {
        if (engine().register(node, themed)) {
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
};
