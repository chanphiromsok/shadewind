import type { ViewProps } from 'react-native'
import { View as RNView } from 'react-native'
import { copyComponentProperties } from '../components/utils'
import { useEngineRef, useShadewindStyle } from './useShadewindStyle'

export const View = copyComponentProperties(RNView, (props: ViewProps) => {
    const { style, themed } = useShadewindStyle(props.className, props)
    const ref = useEngineRef(themed, (props as { ref?: any }).ref)

    return (
        <RNView
            {...props}
            ref={ref}
            style={[style, props.style]}
        />
    )
})

export default View
