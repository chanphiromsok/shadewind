import { useState, type ComponentType } from 'react';
import {
  TouchableOpacity as RNTouchableOpacity,
  type TouchableOpacityProps,
} from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { withUserStyle } from './native';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = TouchableOpacityProps & { className?: string };

export const TouchableOpacity: ComponentType<Props> = copyComponentProperties(
  RNTouchableOpacity,
  (props: Props) => {
    const [isPressed, setIsPressed] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const state = {
      isDisabled: Boolean(props.disabled),
      isPressed,
      isFocused,
    };
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props,
      state
    );
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed
    );

    return (
      <RNTouchableOpacity
        {...props}
        ref={ref}
        style={withUserStyle(style, props.style)}
        onPressIn={(event) => {
          setIsPressed(true);
          props.onPressIn?.(event);
        }}
        onPressOut={(event) => {
          setIsPressed(false);
          props.onPressOut?.(event);
        }}
        onFocus={(event) => {
          setIsFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setIsFocused(false);
          props.onBlur?.(event);
        }}
      />
    );
  }
);

export default TouchableOpacity;
