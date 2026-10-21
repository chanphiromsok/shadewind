import { createElement, type ComponentType } from 'react';
import { withUniwind as uniwindWithUniwind } from 'uniwind-internal/hoc/withUniwind.native';
import { withUserStyle } from './native';
import {
  NO_DEPS,
  useEffectSubscription,
  useEngineRef,
  useShadewindStyle,
} from './useShadewindStyle';

// Uniwind's `withUniwind(Component)` for the common case: a component that takes `className` and passes `style` (and `ref`)
// down to a host view (`<NativeText {...props} />`). Anything else (several *ClassName props, a manual options map) uses
// Uniwind's own HOC unchanged.

type AnyProps = Record<string, any>;

const isClassProp = (name: string) =>
  name === 'className' || name.endsWith('ClassName');

export const withUniwind = (
  Component: ComponentType<any>,
  options?: Record<string, unknown>
) => {
  const Original = uniwindWithUniwind(
    Component,
    options as never
  ) as ComponentType<AnyProps>;

  if (options) {
    return Original;
  }

  const Engine = (props: AnyProps) => {
    const styled = useShadewindStyle(props.className, props);
    const { style } = styled;
    // the wrapped component may never attach `ref`: subscribe with an effect, the ref only binds the engine
    useEffectSubscription(styled);
    const ref = useEngineRef({ ...styled, deps: NO_DEPS }, props.ref);

    // className is resolved here and handed down as `style`: forwarded too, the host view inside (an icon's Text) would resolve it again,
    // find the same colours in the inline style and re-render itself on every switch ("inline style overlaps").
    const { className, ...rest } = props;

    return createElement(Component, {
      ...rest,
      ref,
      ...(className ? { style: withUserStyle(style, props.style) } : null),
    });
  };

  const Wrapped = (props: AnyProps) => {
    const simple = Object.keys(props).every(
      (name) => !isClassProp(name) || name === 'className'
    );

    return createElement(simple ? Engine : Original, props);
  };

  Wrapped.displayName = `withUniwind(${Component.displayName ?? Component.name ?? 'Component'})`;

  return Wrapped;
};

export default withUniwind;
