import type { ComponentType } from 'react';
import { Pressable as RNPressable, type PressableProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { useUniwindContext } from 'uniwind-internal/core/context';
import { getInternals } from './install';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';

type Props = PressableProps & { className?: string };

// Uniwind's Pressable plus the engine registration. The style function keeps Uniwind's pressed/focused resolution: a className
// with `active:` or `focus:` variants is bound in its resting state and unbound while pressed (onPressIn / onPressOut).
export const Pressable: ComponentType<Props> = copyComponentProperties(
  RNPressable,
  (props: Props) => {
    const { style, themed, onRegisterFailed } = useShadewindStyle(
      props.className,
      props,
      { isDisabled: Boolean(props.disabled) }
    );
    const context = useUniwindContext();
    const ref = useEngineRef(
      themed,
      (props as { ref?: any }).ref,
      onRegisterFailed
    );

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
        style={(state) => {
          const user =
            typeof props.style === 'function'
              ? props.style(state)
              : props.style;

          if (state.pressed || (state as { focused?: boolean }).focused) {
            return [
              getInternals()!.UniwindStore.getStyles(
                props.className,
                props,
                {
                  isDisabled: Boolean(props.disabled),
                  isPressed: state.pressed,
                  isFocused: Boolean((state as { focused?: boolean }).focused),
                },
                context
              ).styles,
              user,
            ];
          }

          return [style, user];
        }}
      />
    );
  }
);

export default Pressable;
