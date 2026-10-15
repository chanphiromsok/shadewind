import { use, useState, type ComponentType } from 'react';
import { Platform, Text as RNText, type TextProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useAccentColor } from 'uniwind-internal/components/native/useAccentColor';
import { NativeText, TextAncestorContext, textIsPlain } from './native';
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

    // plain text (primitive children, no press handlers or accessibility props, no clamp): the host component directly, with the
    // defaults Text.js would have set. Everything else keeps the full path below.
    if (
      !use(TextAncestorContext) &&
      !props.selectionColorClassName &&
      !props.onPressIn &&
      !props.onPressOut &&
      !(props as { onPress?: unknown }).onPress &&
      textIsPlain(props, style)
    ) {
      return (
        <NativeText
          {...props}
          ref={ref}
          style={[style, props.style]}
          accessible={Platform.OS === 'ios'}
          allowFontScaling
          ellipsizeMode={props.ellipsizeMode ?? 'tail'}
        />
      );
    }

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
