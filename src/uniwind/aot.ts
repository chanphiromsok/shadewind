// Ahead-of-time className support: a literal `className` resolved once per literal instead of once per view per render, rendered
// straight to the host component. There is no adapter fiber and no hook for the element: `p()` is a plain function the element's
// parent calls while it renders (`use` is allowed there), `T` is the host component, or the regular adapter when the className
// cannot be handled this way (non-theme dependencies, state variants, data attributes, an engine that is not active).
//
//   const a = aot('flex-row bg-card', 'view');
//   <a.T {...a.p()} onLayout={...}>...</a.T>
import { use, type ComponentType, type Context } from 'react';
import { Platform } from 'react-native';
import { getInternals, installUniwind } from './install';
import { NativeText, NativeView, styleIsPlain } from './native';
import { Text } from './Text';
import { View } from './View';
import {
  ALL_STATE,
  cachedPlan,
  nonThemeDeps,
  renderThemeFor,
  same,
} from './useShadewindStyle';

type Kind = 'view' | 'text';
type HostProps = Record<string, unknown>;
type UniwindContextValue = {
  scopedTheme: string | null;
  rtl: boolean | null;
  variables: unknown;
};

export type Aot = {
  /** The host component, or the Uniwind adapter when this className is not handled ahead of time. */
  readonly T: ComponentType<any>;
  /** Props for `T`: `{ style, ref }` (plus Text defaults), or `{ className }` for the adapter. */
  p(): HostProps;
};

const engine = () =>
  (require('shadewind/internal') as typeof import('../internal'))
    .ShadewindEngine;

let contextObject: Context<UniwindContextValue> | undefined;
const uniwindContext = () =>
  (contextObject ??= (
    require('uniwind-internal/core/context') as {
      UniwindContext: Context<UniwindContextValue>;
    }
  ).UniwindContext);

// one ref per themed-style object, shared by every view that uses it. No cleanup: the binding outlives a Suspense/Activity hide
// (the commit hook themes the view when it shows) and goes away with the view; other styles register over it, and a className
// the engine cannot take renders the adapter instead (another element type, so another view)
const refs = new WeakMap<object, (node: unknown) => void>();

const sharedRef = (themed: object) => {
  let ref = refs.get(themed);

  if (!ref) {
    ref = (node) => {
      if (node) {
        engine().register(node, themed as never, renderThemeFor(node, themed));
      }
    };
    refs.set(themed, ref);
  }

  return ref;
};

const TEXT_DEFAULTS = {
  accessible: Platform.OS === 'ios',
  allowFontScaling: true,
  ellipsizeMode: 'tail',
};

const NO_PROPS = {};

export const aot = (className: string, kind: Kind): Aot => {
  const fallback = kind === 'view' ? View : Text;
  const host = kind === 'view' ? NativeView : NativeText;
  const fallbackProps = { className };
  // undefined: not decided yet. false: handled by the adapter. true: handled here.
  let decided: boolean | undefined;
  const byResolved = new WeakMap<object, HostProps>();

  const decide = (): boolean => {
    const internals = getInternals();
    const { active } = installUniwind();

    if (!active || !internals) {
      // not decided: the store may simply not be ready yet (the adapter is correct either way)
      return false;
    }

    const { UniwindStore, StyleDependency } = internals;
    // called while rendering the component that owns this plan, so `use` is valid here
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const context = use(uniwindContext());
    const current = UniwindStore.getStyles(
      className,
      NO_PROPS,
      undefined,
      context
    );
    let ok =
      !current.hasDataAttributes &&
      nonThemeDeps(current as never, StyleDependency.Theme).length === 0 &&
      same(
        UniwindStore.getStyles(className, NO_PROPS, ALL_STATE, context).styles,
        current.styles
      );

    if (ok && kind === 'text') {
      ok = styleIsPlain(current.styles);
    }

    decided = ok;

    return ok;
  };

  const handled = () => decided ?? decide();

  const self: Aot = {
    get T() {
      return handled() ? host : fallback;
    },
    p() {
      if (!handled()) {
        return fallbackProps;
      }

      const { UniwindStore } = getInternals()!;
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const context = use(uniwindContext());
      const current = UniwindStore.getStyles(
        className,
        NO_PROPS,
        undefined,
        context
      );

      if (context.scopedTheme !== null) {
        // inside a ScopedTheme: the style for that theme, not bound to the engine
        return kind === 'text'
          ? { ...TEXT_DEFAULTS, style: current.styles }
          : { style: current.styles };
      }

      let props = byResolved.get(current);

      if (!props) {
        const planned = cachedPlan(
          className,
          NO_PROPS,
          undefined,
          context,
          current as never,
          false
        );

        props = {
          ...(kind === 'text' ? TEXT_DEFAULTS : null),
          style: current.styles,
          ref: planned.themed ? sharedRef(planned.themed) : undefined,
        };
        byResolved.set(current, props);
      }

      return props;
    },
  };

  return self;
};
