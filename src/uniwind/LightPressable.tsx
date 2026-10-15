// A cheaper Pressable for the common case. React Native's own Pressable is a memo fiber, a config memo, three accessibility
// objects, a Pressability instance and a View fiber per instance; at mount that is the biggest single item of a feed of cards.
// This one runs the same Pressability state machine (press delay, retention, long press, cancel) and renders the host component.
// Any prop it does not handle (aria-*, accessibilityState, android_ripple, unstable_pressDelay, testOnly_pressed, ...) renders
// React Native's Pressable as before, so behaviour is the same.
import { useState, type ComponentType } from 'react';
import { Pressable as RNPressable, type PressableProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useUniwindContext } from 'uniwind-internal/core/context';
import { getInternals } from './install';
import { NativeView } from './native';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = PressableProps & { className?: string };

const usePressability = (
  require('react-native/Libraries/Pressability/usePressability') as {
    default: (
      config: Record<string, unknown> | null
    ) => Record<string, unknown> | null;
  }
).default;

const HANDLED = new Set([
  'className',
  'children',
  'style',
  'onPress',
  'onPressIn',
  'onPressOut',
  'onLongPress',
  'delayLongPress',
  'disabled',
  'hitSlop',
  'testID',
  'accessibilityLabel',
  'accessibilityRole',
  'accessibilityHint',
  'accessible',
  'focusable',
  'ref',
  'key',
  'onLayout',
]);

const isLight = (props: Record<string, unknown>) => {
  for (const key in props) {
    if (!HANDLED.has(key) && props[key] !== undefined) {
      return false;
    }
  }

  return true;
};

export const LightPressable: ComponentType<Props> = copyComponentProperties(
  RNPressable,
  (props: Props) => {
    const light = isLight(props);
    const disabled = Boolean(props.disabled);
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props,
      { isDisabled: disabled }
    );
    const context = useUniwindContext();
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed
    );
    const [pressed, setPressed] = useState(false);
    const handlers = usePressability(
      light
        ? {
            disabled: props.disabled,
            hitSlop: props.hitSlop,
            onLongPress: props.onLongPress,
            onPress: props.onPress,
            delayLongPress: props.delayLongPress,
            onPressIn: (event: unknown) => {
              (ref as { pause?: () => void } | undefined)?.pause?.();
              setPressed(true);
              props.onPressIn?.(event as never);
            },
            onPressOut: (event: unknown) => {
              (ref as { resume?: () => void } | undefined)?.resume?.();
              setPressed(false);
              props.onPressOut?.(event as never);
            },
          }
        : null
    );

    const resolve = (state: { pressed: boolean }) => {
      const user =
        typeof props.style === 'function' ? props.style(state) : props.style;

      if (state.pressed) {
        return [
          getInternals()!.UniwindStore.getStyles(
            props.className,
            props,
            { isDisabled: disabled, isPressed: true, isFocused: false },
            context
          ).styles,
          user,
        ];
      }

      return [style, user];
    };

    if (!light) {
      return (
        <RNPressable
          {...props}
          ref={ref}
          onPressIn={(event) => {
            (ref as { pause?: () => void } | undefined)?.pause?.();
            props.onPressIn?.(event);
          }}
          onPressOut={(event) => {
            (ref as { resume?: () => void } | undefined)?.resume?.();
            props.onPressOut?.(event);
          }}
          style={resolve as never}
        />
      );
    }

    const state = { pressed };

    return (
      <NativeView
        {...props}
        {...handlers}
        ref={ref}
        style={resolve(state)}
        accessible={props.accessible !== false}
        focusable={props.focusable !== false && !disabled}
        accessibilityState={disabled ? { disabled: true } : undefined}
      >
        {typeof props.children === 'function'
          ? props.children(state)
          : props.children}
      </NativeView>
    );
  }
);

export default LightPressable;
