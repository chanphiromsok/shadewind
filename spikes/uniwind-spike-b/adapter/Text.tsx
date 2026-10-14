import { useState } from 'react'
import type { TextProps } from 'react-native'
import { Text as RNText } from 'react-native'
import { copyComponentProperties } from '../components/utils'
import { useAccentColor } from '../components/native/useAccentColor'
import type { ComponentState } from '../core/types'
import { useEngineRef, useShadewindStyle } from './useShadewindStyle'

type StyleWithWebkitLineClamp = {
    WebkitLineClamp?: number
}

export const Text = copyComponentProperties(RNText, (props: TextProps) => {
    const [isPressed, setIsPressed] = useState(false)
    const state = {
        isPressed,
        isDisabled: Boolean(props.disabled),
    } satisfies ComponentState
    const { style, themed } = useShadewindStyle(props.className, props, state)
    const selectionColor = useAccentColor(props.selectionColorClassName, props, state)
    const ref = useEngineRef(themed, (props as { ref?: any }).ref)

    return (
        <RNText
            {...props}
            ref={ref}
            style={[style, props.style]}
            selectionColor={props.selectionColor ?? selectionColor}
            numberOfLines={(style as StyleWithWebkitLineClamp).WebkitLineClamp ?? props.numberOfLines}
            onPressIn={event => {
                setIsPressed(true)
                props.onPressIn?.(event)
            }}
            onPressOut={event => {
                setIsPressed(false)
                props.onPressOut?.(event)
            }}
        />
    )
})

export default Text
