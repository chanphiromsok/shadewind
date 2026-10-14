import type { ComponentType } from 'react';
import { View as RNView, type ViewProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = ViewProps & { className?: string };

// annotated: the inferred type would expose React Native's private generated types in the shipped .d.ts
export const View: ComponentType<Props> = copyComponentProperties(
  RNView,
  (props: Props) => {
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props
    );
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed
    );

    return <RNView {...props} ref={ref} style={[style, props.style]} />;
  }
);

export default View;
