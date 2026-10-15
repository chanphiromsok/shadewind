import { useState, type ComponentType } from 'react';
import { Text as RNText, type TextProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useAccentColor } from 'uniwind-internal/components/native/useAccentColor';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = TextProps & {
  className?: string;
  selectionColorClassName?: string;
};

// annotated: the inferred type would expose React Native's private generated types in the shipped .d.ts
export const Text: ComponentType<Props> = copyComponentProperties(
  RNText,
  (props: Props) => {
    const [isPressed, setIsPressed] = useState(false);
    const state = {
      isPressed,
      isDisabled: Boolean((props as { disabled?: boolean }).disabled),
    };
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props,
      state
    );
    const selectionColor = useAccentColor(
      props.selectionColorClassName,
      props,
      state
    );
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed
    );

    return (
      <RNText
        {...props}
        ref={ref}
        style={[style, props.style]}
        selectionColor={props.selectionColor ?? selectionColor}
        numberOfLines={
          (style as { WebkitLineClamp?: number }).WebkitLineClamp ??
          props.numberOfLines
        }
        onPressIn={(event) => {
          setIsPressed(true);
          props.onPressIn?.(event);
        }}
        onPressOut={(event) => {
          setIsPressed(false);
          props.onPressOut?.(event);
        }}
      />
    );
  }
);

export default Text;
