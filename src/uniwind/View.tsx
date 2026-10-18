import type { ComponentType } from 'react';
import { View as RNView, type ViewProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { use } from 'react';
import {
  NativeView,
  TextAncestorContext,
  viewIsPlain,
  withUserStyle,
} from './native';
import { swProps } from './atSwitch';
import { useRegistration, useShadewindStyle } from './useShadewindStyle';

type Props = ViewProps & { className?: string };

// annotated: the inferred type would expose React Native's private generated types in the shipped .d.ts
export const View: ComponentType<Props> = copyComponentProperties(
  RNView,
  (props: Props) => {
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props
    );
    const rendered = withUserStyle(style, props.style);
    const ref = useRegistration(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed,
      rendered
    );

    // inside a Text, or with props View.js rewrites: React Native's own View. Otherwise the host component directly.
    if (!use(TextAncestorContext) && viewIsPlain(props)) {
      return (
        <NativeView
          {...props}
          ref={ref}
          style={rendered}
          {...swProps(themed)}
        />
      );
    }

    return (
      <RNView {...props} ref={ref} style={rendered} {...swProps(themed)} />
    );
  }
);

export default View;
