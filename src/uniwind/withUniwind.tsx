import { createElement, type ComponentType } from 'react';
import { withUniwind as uniwindWithUniwind } from 'uniwind-internal/hoc/withUniwind.native';
import { withUserStyle } from './native';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

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
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props
    );
    const ref = useEngineRef(themed, props.ref, onRegisterFailed);

    return createElement(Component, {
      ...props,
      ref,
      ...(props.className
        ? { style: withUserStyle(style, props.style) }
        : null),
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
