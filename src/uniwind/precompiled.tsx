// The runtime half of `withShadewind(config, { precompileClassNames: true })` (metro-precompile-plugin.cjs).
//
// The Babel plugin replaces `<View className="literal" ...>` / `<Text className="literal" ...>` (from `react-native` or
// `shadewind/uniwind`, no spread, no style / ref, and for Text only the props the direct host path allows) with a component made
// here once per className and module:
//
//   const _SwView = _sw.view("h-25 w-[32%] items-center ...");   // module scope
//   <_SwView key={i}>...</_SwView>
//
// What that component does per view: two context reads (Text ancestor, Uniwind's scoped theme / variables) and one host element.
// No hooks, no getStyles call, no plan, no subscription. The className is resolved once (first render) per theme with Uniwind's own
// getStyles and the adapter's own engine plan (cachedPlan), so values and engine decisions are the adapter's by construction.
//
// Contract of the opt-in (what differs from the adapter's components):
// - a compiled view does not re-render when Uniwind.updateCSSVariables changes a variable it reads (the adapter's views do, through
//   their Variables subscription). Views rendered after the change get the new values (the resolutions are dropped on every
//   Variables notification); mounted ones keep the old ones until they re-render (a view that was bound to the engine and whose
//   className no longer is gets unbound by that re-render, see `unbind`).
// - `className={expression}` (cn(), a conditional, a variable) is compiled too: one component per kind and file, the className read
//   from the props and resolved once per distinct string. A value that toggles to nothing (undefined, false, '') keeps the same host
//   element (no remount); a toggle into a className the adapter handles (the next item) swaps the element type, which remounts the
//   subtree, as it does in the adapter's own View when a prop makes View.js necessary.
// - everything else falls back to the adapter's component (same element type for the life of a view, see `slowPath`): the engine
//   inactive, a className with data attributes or a dependency other than the theme and variables (breakpoints, orientation, rtl,
//   insets, font scale, color scheme), a Text whose resolved style needs Text.js (line clamp, userSelect, verticalAlign), a Text with
//   non-primitive children, a view inside a Text, a scoped theme or scoped variables.
import { use, useRef } from 'react';
import { Platform } from 'react-native';
import { jsx } from 'react/jsx-runtime';
import { UniwindContext } from 'uniwind-internal/core/context';
import type { ThemedStyles } from '../internal';
import { getInternals, installUniwind } from './install';
import {
  NativeText,
  NativeView,
  TextAncestorContext,
  nativeTextStyle,
  styleIsPlain,
  textIsPlain,
} from './native';
import { Text } from './Text';
import { resolveUncached, stylesByTheme } from './uniwindAccess';
import { cachedPlan, decisions, nudgeUnbound, same } from './useShadewindStyle';
import { View } from './View';

// read once at module load (Metro's inline requires, see useShadewindStyle.ts)
const M = {
  use,
  useRef,
  jsx,
  UniwindContext,
  TextAncestorContext,
  NativeView,
  NativeText,
  View,
  Text,
  textIsPlain,
  nativeTextStyle,
  accessible: Platform.OS === 'ios',
};

const engine = () =>
  (require('shadewind/internal') as typeof import('../internal'))
    .ShadewindEngine;

const debugOn = () =>
  __DEV__ ||
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ ===
    true;

type Kind = 'view' | 'text';

const SLOW = 0; // the adapter's component
const STATIC = 1; // the same style in every theme
const ENGINE = 2; // bound to the engine: the render theme's style, the engine paints the others

type Resolved = {
  generation: number;
  mode: typeof SLOW | typeof STATIC | typeof ENGINE;
  /** the style per theme (Text: after nativeTextStyle) */
  byTheme: Record<string, unknown>;
  /** ENGINE: one ref per theme, the theme of the render it was handed to */
  refs: Record<string, (node: unknown) => void> | null;
  /** ENGINE: the styles the refs bind (what tells a view that moved to another className from one re-rendered under another theme) */
  themed: ThemedStyles | null;
};

const ROOT_CONTEXT = { scopedTheme: null, rtl: null, variables: null };
const NO_PROPS = {};
// the adapter's Text resolves with this state when it is not pressed and not disabled (Text.tsx STATES[0][0])
const TEXT_STATE = { isPressed: false, isDisabled: false };

// bumped on every Variables notification (updateCSSVariables, and a CSS reload in development, which notifies everything)
let generation = 0;
let subscribed = false;
// the theme of the ref that last attached each view (see engineRefs)
const attachedWith = new WeakMap<
  object,
  { theme: string; themed: ThemedStyles }
>();
// views a compiled component bound to the engine
const boundNodes = new WeakSet<object>();

// A component whose className was bound and no longer is (a Variables change made it the same in every theme, or something the
// engine cannot paint): a view it bound before keeps that binding when it re-renders, and the engine would paint the old colours
// on the next switch. The adapter unbinds a superseded holder; this ref does it for the compiled views.
const unbind = (node: unknown) => {
  if (typeof node === 'object' && node !== null && boundNodes.has(node)) {
    boundNodes.delete(node);
    // a later binding of this view is a first attach again (it has a render theme), not a reveal
    attachedWith.delete(node);
    engine().unregister(node);
  }
};

const resolve = (className: string, kind: Kind): Resolved | null => {
  // first: install fills the internals
  const { active } = installUniwind();
  const internals = getInternals();

  if (!internals || Object.keys(internals.UniwindStore.vars).length === 0) {
    return null; // the stylesheet is not loaded yet: the adapter's component, asked again next render
  }

  const slow: Resolved = {
    generation,
    mode: SLOW,
    byTheme: {},
    refs: null,
    themed: null,
  };
  const decide = (resolved: Resolved, reason: string) => {
    if (debugOn()) {
      decisions.set(`precompiled ${kind}: ${className}`, reason);
    }

    return resolved;
  };

  if (!active) {
    return decide(slow, 'engine inactive');
  }

  const { UniwindStore: store, UniwindListener, StyleDependency } = internals;

  if (!subscribed) {
    subscribed = true;
    UniwindListener.subscribe(() => {
      generation++;
    }, [StyleDependency.Variables]);
  }

  const state = kind === 'text' ? TEXT_STATE : undefined;
  // Not through Uniwind's cache: this resolution is kept in `entries` (one per className), so a cache entry (and its listener
  // subscription, most of its cost) would only duplicate it for the life of the app.
  const current = resolveUncached(className, NO_PROPS, state, ROOT_CONTEXT);

  if (current.hasDataAttributes) {
    return decide(slow, 'data attributes');
  }

  const other = current.dependencies.filter(
    (dependency) =>
      dependency !== StyleDependency.Theme &&
      dependency !== StyleDependency.Variables
  );

  if (other.length > 0) {
    return decide(slow, `depends on ${other.join(',')}`);
  }

  const themes = Object.keys(store.vars);
  const raw = stylesByTheme(className, NO_PROPS, state, ROOT_CONTEXT, current);

  const byTheme: Record<string, unknown> = {};

  for (const theme of themes) {
    const style = raw[theme]!;

    if (kind === 'text') {
      // the adapter's direct Text path (textIsPlain): a numeric weight is converted, the rest needs Text.js
      if (!styleIsPlain(style, true)) {
        return decide(slow, 'style needs Text.js');
      }

      byTheme[theme] = nativeTextStyle(style);
    } else {
      byTheme[theme] = style;
    }
  }

  const first = raw[themes[0]!];

  if (themes.every((theme) => same(raw[theme], first))) {
    return decide(
      { generation, mode: STATIC, byTheme, refs: null, themed: null },
      'static'
    );
  }

  // the adapter's own engine decision for this className (no inline style: the plugin compiles no `style` prop)
  const { themed, reason } = cachedPlan(
    className,
    NO_PROPS,
    state,
    ROOT_CONTEXT,
    current,
    false
  );

  // differs between themes in what the engine cannot paint: the adapter's component, which re-renders the view on a theme switch
  if (!themed) {
    return decide(slow, `the engine cannot paint it (${reason})`);
  }

  return decide(
    {
      generation,
      mode: ENGINE,
      byTheme,
      refs: engineRefs(themed, themes),
      themed,
    },
    'engine'
  );
};

// One ref per theme, shared by every view of the className: React hands the one of the render's theme to the view, so React calls
// a view's ref again only when it is attached again or re-rendered under another theme. A plain detach keeps the binding (the
// adapter's rule: the commit hook themes a hidden subtree when it shows, an unmount takes the entry with it).
//
// - first attach: React's props are this render's, of `theme` (the adapter's renderThemeFor rule).
// - the same theme's ref again: a re-attach (a reveal), which finds whatever the tree holds: no render theme, and no native call
//   (ShadewindEngine.register returns at once for a view registered with these styles).
// - another theme's ref: React re-rendered the view after a switch and replaced its props with that theme's. The engine's commit
//   hook then drops its per-theme props built from the old ones and builds them again only after a registration (prewarm); without
//   one the next switch builds every such view's props on the JS thread (the 2003-view theme screen went from 2.8 to 7.8 ms per
//   switch when its parent re-rendered between switches). So the view is registered again (forced: same styles), with no render
//   theme, as the adapter's views are (their plan object is new after a switch, see useEngineRef).
const engineRefs = (themed: ThemedStyles, themes: string[]) => {
  const refs: Record<string, (node: unknown) => void> = {};

  for (const theme of themes) {
    refs[theme] = (node: unknown) => {
      if (typeof node !== 'object' || node === null) {
        return;
      }

      const previous = attachedWith.get(node);

      attachedWith.set(node, { theme, themed });

      // - first attach of the view: React's props are this render's, of `theme` (the adapter's renderThemeFor rule).
      // - the same styles again: a re-attach (a reveal, no render theme), or a re-render under another theme (forced).
      // - other styles (an expression className changed on a mounted view): the old registration is dropped and the view is registered
      //   as a new one, like the adapter's superseded holder (a bare re-registration left the previous className's colour on the view
      //   in the pixel test, scripts/edge-cases.py). No render theme: the engine applies the new styles itself.
      let registered: boolean;

      if (previous === undefined) {
        registered = engine().register(node, themed, theme);
      } else if (previous.themed === themed) {
        registered = engine().register(
          node,
          themed,
          undefined,
          previous.theme !== theme
        );
      } else {
        engine().unregister(node);
        registered = engine().register(node, themed, undefined);
      }

      if (registered) {
        boundNodes.add(node);
      } else if (debugOn()) {
        console.warn('[shadewind] could not bind a precompiled view');
      }
    };
  }

  return refs;
};

type Props = Record<string, unknown> & { children?: unknown };

// A view whose className is an expression can be bound with one className's styles and, after a render, need another's. The old
// binding must be dropped BEFORE the shadow tree of that React commit is built (the commit hook would paint the old styles over the
// props React just rendered): React detaches the old ref in its mutation phase, before that commit, so the detach is where it is
// dropped. Only the render knows whether the view moved on, so every such view has an instance record the render writes (as the
// adapter's holder, useEngineRef): `current` is the wrapper of the newest render, and a wrapper detached while it is no longer
// `current` unbinds its view. A plain hide or unmount (still `current`) keeps the binding.
type Wrapper = {
  fn: (node: unknown) => void;
  base: (node: unknown) => void;
  themed: ThemedStyles;
  node: object | null;
};
type Instance = { current: Wrapper | null };
// an instance that was engine-bound once: every later render that leaves it unbound sends its colours again (nudgeUnbound), also a repeated
// one (StrictMode, a restarted render)
const boundOnce = new WeakSet<Instance>();

const wrapperFor = (
  instance: Instance,
  base: (node: unknown) => void,
  themed: ThemedStyles
): Wrapper => {
  const wrapper: Wrapper = {
    base,
    themed,
    node: null,
    fn: (node) => {
      if (typeof node === 'object' && node !== null) {
        wrapper.node = node;
        base(node);

        return;
      }

      // the newest wrapper binds other styles (or none): this view moved on. The same styles under another theme is a re-render of the
      // same className: the new wrapper's attach registers it again (forced), nothing to drop.
      if (
        wrapper.node !== null &&
        instance.current !== wrapper &&
        instance.current?.themed !== wrapper.themed
      ) {
        unbind(wrapper.node);
      }

      wrapper.node = null;
    },
  };

  return wrapper;
};

// An expression component keeps the resolutions of this many distinct classNames (least recently rendered dropped first). A className
// built from unbounded values (`w-[${px}px]`) would otherwise keep one per value for the life of the app. A dropped className that
// renders again is resolved again: a new `themed` unless interned (useShadewindStyle.ts), so a mounted view of it is registered once more.
const EXPRESSION_ENTRIES = 256;

// `fixed`: the className literal the plugin saw; null for `className={expression}`, read from the props of each render (one
// resolution per distinct string, the most recent EXPRESSION_ENTRIES kept)
const make = (fixed: string | null, kind: Kind) => {
  type Entry = { resolved: Resolved | null; wasBound: boolean };
  const entries = new Map<string, Entry>();

  const Compiled = (allProps: Props) => {
    // resolves once per className (and per Variables change) during a render, on purpose: never compiled
    'use no memo';

    const adapter = kind === 'view' ? M.View : M.Text;
    // one record per view with an expression className (`fixed` never changes for a component type, so the hook order is stable)
    const instance: Instance | null =
      // eslint-disable-next-line react-hooks/rules-of-hooks
      fixed === null ? M.useRef<Wrapper | null>(null) : null;
    const context = M.use(M.UniwindContext);
    const inText = M.use(M.TextAncestorContext);
    let className = fixed;
    let props = allProps;

    if (className === null) {
      const given = allProps.className;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { className: _className, ...rest } = allProps;

      props = rest;
      className =
        typeof given === 'string' && given.trim() !== '' ? given : null;
    }

    // what the host element cannot do: the adapter's component (its element type at this position does not change: see the header)
    const hostBlocked =
      context.scopedTheme !== null ||
      context.variables !== null ||
      inText ||
      (kind === 'text' && !M.textIsPlain(props, null));

    // `className={cond ? 'x' : undefined}`: no className now, but the same host element as with one, so the subtree is not remounted
    // when the expression toggles. A binding the view had is dropped (`unbind`).
    if (instance !== null && (className === null || hostBlocked)) {
      instance.current = null;
    }

    if (className === null) {
      if (hostBlocked) {
        return M.jsx(adapter as any, allProps);
      }

      return kind === 'view'
        ? M.jsx(M.NativeView, props)
        : M.jsx(M.NativeText, {
            ...props,
            style: M.nativeTextStyle(undefined),
            accessible: M.accessible,
            allowFontScaling: true,
            ellipsizeMode: props.ellipsizeMode ?? 'tail',
          });
    }

    let entry = entries.get(className);

    if (entry === undefined) {
      entry = { resolved: null, wasBound: false };

      // only an expression component sees more than one className
      if (fixed === null && entries.size >= EXPRESSION_ENTRIES) {
        entries.delete(entries.keys().next().value!);
      }

      entries.set(className, entry);
    } else if (fixed === null && entries.size > 1) {
      // most recently rendered last (a Map keeps insertion order)
      entries.delete(className);
      entries.set(className, entry);
    }

    if (entry.resolved === null || entry.resolved.generation !== generation) {
      entry.resolved = resolve(className, kind);
      entry.wasBound ||= entry.resolved?.mode === ENGINE;
    }

    const r = entry.resolved;

    const theme = getInternals()?.UniwindStore.runtime.currentThemeName;
    const style =
      r === null || theme === undefined ? undefined : r.byTheme[theme];

    if (r === null || r.mode === SLOW || hostBlocked || style === undefined) {
      if (instance !== null) {
        instance.current = null;
      }

      return M.jsx(adapter as any, { ...props, className });
    }

    let ref: ((node: unknown) => void) | undefined;
    // the style of the render that unbinds a view the engine painted: its colours are sent again (nudgeUnbound)
    let sent = style;

    if (instance !== null) {
      const base = r.refs ? r.refs[theme!] : undefined;

      if (base) {
        let wrapper = instance.current;

        if (wrapper === null || wrapper.base !== base) {
          wrapper = wrapperFor(instance, base, r.themed!);
          instance.current = wrapper;
          boundOnce.add(instance);
        }

        ref = wrapper.fn;
      } else {
        // not engine-bound now: a wrapper from an earlier render is no longer current and unbinds its view when React detaches it
        sent = boundOnce.has(instance) ? nudgeUnbound(style) : style;
        instance.current = null;
      }
    } else {
      ref = r.refs ? r.refs[theme!] : entry.wasBound ? unbind : undefined;

      if (!r.refs && entry.wasBound) {
        sent = nudgeUnbound(style);
      }
    }

    if (kind === 'view') {
      return M.jsx(
        M.NativeView,
        ref ? { ...props, style: sent, ref } : { ...props, style: sent }
      );
    }

    // what the adapter's direct Text path passes (Text.tsx)
    const text: Record<string, unknown> = {
      ...props,
      style: sent,
      accessible: M.accessible,
      allowFontScaling: true,
      ellipsizeMode: props.ellipsizeMode ?? 'tail',
    };

    if (ref) {
      text.ref = ref;
    }

    return M.jsx(M.NativeText, text);
  };

  Compiled.displayName = kind === 'view' ? 'View' : 'Text';

  return Compiled;
};

/** Used by code shadewind/metro's precompile plugin generates (metro-precompile-plugin.cjs); not an API. */
export const precompiled = {
  view: (className: string | null = null) => make(className, 'view'),
  text: (className: string | null = null) => make(className, 'text'),
};
