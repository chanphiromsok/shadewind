import { use, useState, type ComponentType } from 'react';
import { Platform, Text as RNText, type TextProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import {
  NativeText,
  TextAncestorContext,
  textIsPlain,
  nativeTextStyle,
  withUserStyle,
} from './native';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';
import { jsx } from 'react/jsx-runtime';

// read once at module load: Metro's inline requires would look each of these up on every render (see useShadewindStyle.ts)
const M = {
  use,
  useState,
  TextAncestorContext,
  textIsPlain,
  nativeTextStyle,
  withUserStyle,
  useEngineRef,
  useShadewindStyle,
  NativeText,
  RNText,
  jsx,
  accessible: Platform.OS === 'ios',
};

// one state object per combination: Uniwind's store reads the values only, so no new object per render
const STATES = [
  [
    { isPressed: false, isDisabled: false },
    { isPressed: false, isDisabled: true },
  ],
  [
    { isPressed: true, isDisabled: false },
    { isPressed: true, isDisabled: true },
  ],
] as const;

type Props = TextProps & {
  className?: string;
  selectionColorClassName?: string;
};

// annotated: the inferred type would expose React Native's private generated types in the shipped .d.ts
export const Text: ComponentType<Props> = copyComponentProperties(
  RNText,
  (props: Props) => {
    const [isPressed, setIsPressed] = M.useState(false);
    const state =
      STATES[isPressed ? 1 : 0][
        (props as { disabled?: boolean }).disabled ? 1 : 0
      ];
    const styled = M.useShadewindStyle(
      props.className,
      props,
      state,
      props.selectionColorClassName
    );
    const { style, accentColor: selectionColor } = styled;
    const ref = M.useEngineRef(styled, (props as { ref?: any }).ref);

    // plain text (primitive children, no press handlers or accessibility props, no clamp): the host component directly, with the
    // defaults Text.js would have set. Everything else keeps the full path below.
    if (
      !M.use(M.TextAncestorContext) &&
      !props.selectionColorClassName &&
      !props.onPressIn &&
      !props.onPressOut &&
      !(props as { onPress?: unknown }).onPress &&
      M.textIsPlain(props, style)
    ) {
      return M.jsx(M.NativeText, {
        ...props,
        ref,
        style: M.withUserStyle(M.nativeTextStyle(style), props.style),
        accessible: M.accessible,
        allowFontScaling: true,
        ellipsizeMode: props.ellipsizeMode ?? 'tail',
      });
    }

    return (
      <RNText
        {...props}
        ref={ref}
        style={withUserStyle(style, props.style)}
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
