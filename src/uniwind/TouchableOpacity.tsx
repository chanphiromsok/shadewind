import { useState, type ComponentType } from 'react';
import {
  TouchableOpacity as RNTouchableOpacity,
  type TouchableOpacityProps,
} from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
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
    const { style, themed, onRegisterFailed, nativeID } = useShadewindStyle(
      props.className,
      props,
      state,
      true
    );
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed,
      nativeID
    );

    return (
      <RNTouchableOpacity
        {...props}
        ref={ref}
        nativeID={nativeID ?? props.nativeID}
        style={[style, props.style]}
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
