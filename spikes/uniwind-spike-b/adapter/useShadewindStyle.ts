import { type Ref, useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { StyleSheet } from 'react-native'
import type { ThemedStyles } from 'shadewind/internal'
import { StyleDependency } from '../common/consts'
import { useUniwindContext } from '../core/context'
import { UniwindListener } from '../core/listener'
import { UniwindStore } from '../core/native'
import type { ComponentState } from '../core/types'

// Spike B: Uniwind's `useStyle` plus "register the per-theme colours with the Shadewind engine and stop re-rendering on a
// theme switch" for the components that are safe to hand over. Everything else keeps Uniwind's behaviour.

const SUPPORTED = ['backgroundColor', 'borderColor', 'color'] as const
const MAX_THEMES = 6
const ALL_STATE: ComponentState = { isDisabled: true, isFocused: true, isPressed: true }

// required on first use: this module is evaluated while React Native is still setting itself up (it is imported through the
// `react-native` View export), and the native engine is not available yet at that point
const engine = (): typeof import('shadewind').ShadewindEngine => require('shadewind').ShadewindEngine

/** debug: className -> 'engine' or the reason it fell back */
export const decisions = new Map<string, string>()
/** debug: testID (or className) -> number of renders of the styled component */
export const renders = new Map<string, number>()

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// UniwindStore.getStyles(..., { scopedTheme }) is wrong for light-dark() (spike A): make `theme` the runtime theme for the call.
const withTheme = <T,>(theme: string, fn: () => T): T => {
    const runtime = UniwindStore.runtime as { currentThemeName: string }
    const previous = runtime.currentThemeName

    runtime.currentThemeName = theme

    try {
        return fn()
    } finally {
        runtime.currentThemeName = previous
    }
}

type Plan = { themed: ThemedStyles | null; reason: string }

const plan = (
    className: string | undefined,
    componentProps: Record<string, any>,
    state: ComponentState | undefined,
    context: ReturnType<typeof useUniwindContext>,
    current: ReturnType<typeof UniwindStore.getStyles>,
    hasInlineOverlap: boolean,
): Plan => {
    const decide = (themed: ThemedStyles | null, reason: string): Plan => {
        decisions.set(String(componentProps.testID ?? className), reason)

        return { themed, reason }
    }

    if (!className) {
        return { themed: null, reason: 'no className' }
    }

    if (context.scopedTheme !== null) {
        return decide(null, 'scoped theme')
    }

    if (!current.dependencies.includes(StyleDependency.Theme)) {
        return decide(null, 'not theme dependent')
    }

    if ((current as { hasDataAttributes?: boolean }).hasDataAttributes) {
        return decide(null, 'data attributes')
    }

    const themes = Object.keys(UniwindStore.vars)

    if (themes.length > MAX_THEMES) {
        return decide(null, `more than ${MAX_THEMES} themes`)
    }

    if (hasInlineOverlap) {
        return decide(null, 'inline style overlaps')
    }

    const perTheme: Record<string, Record<string, unknown>> = {}

    for (const theme of themes) {
        perTheme[theme] = withTheme(theme, () => UniwindStore.getStyles(className, componentProps, state, context).styles) as Record<string, unknown>
    }

    if (!same(UniwindStore.getStyles(className, componentProps, ALL_STATE, context).styles, current.styles)) {
        return decide(null, 'state variants')
    }

    const keys = new Set<string>()

    for (const theme of themes) {
        for (const key of Object.keys(perTheme[theme]!)) {
            keys.add(key)
        }
    }

    const differing = [...keys].filter((key) => new Set(themes.map((theme) => JSON.stringify(perTheme[theme]![key]))).size > 1)

    if (differing.length === 0) {
        return decide(null, 'no difference between themes')
    }

    const unsupported = differing.filter((key) => !(SUPPORTED as readonly string[]).includes(key))

    if (unsupported.length > 0) {
        return decide(null, `unsupported: ${unsupported.join(',')}`)
    }

    if (themes.some((theme) => differing.some((key) => perTheme[theme]![key] === undefined))) {
        return decide(null, 'key missing in a theme')
    }

    const themed: ThemedStyles = {}

    for (const theme of themes) {
        themed[theme] = Object.fromEntries(differing.map((key) => [key, perTheme[theme]![key]])) as ThemedStyles[string]
    }

    return decide(themed, 'engine')
}

let installed = false

const install = () => {
    if (installed) {
        return
    }

    installed = true
    // one subscription: every theme change (setTheme, system scheme) goes to the engine
    UniwindListener.subscribe(() => {
        engine().setTheme((UniwindStore.runtime as { currentThemeName: string }).currentThemeName, 'hookAsync')
    }, [StyleDependency.Theme])
}

export const useShadewindStyle = (
    className: string | undefined,
    componentProps: Record<string, any>,
    state?: ComponentState,
) => {
    'use no memo'
    install()

    const debugKey = String(componentProps.testID ?? className)

    renders.set(debugKey, (renders.get(debugKey) ?? 0) + 1)

    const context = useUniwindContext()
    const [, rerender] = useReducer(() => ({}), {})
    const current = UniwindStore.getStyles(className, componentProps, state, context)
    const flat = StyleSheet.flatten(componentProps.style) as Record<string, unknown> | undefined
    const hasInlineOverlap = flat !== undefined && SUPPORTED.some((key) => flat[key] !== undefined)
    const planned = useMemo(
        () => plan(className, componentProps, state, context, current, hasInlineOverlap),
        // `current` is cached per theme/state by the store: a new object means a different resolution
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [current, hasInlineOverlap, context],
    )
    const dependencies = planned.themed
        ? current.dependencies.filter((dependency) => dependency !== StyleDependency.Theme)
        : current.dependencies

    useLayoutEffect(() => {
        if (__DEV__ || dependencies.length > 0) {
            return UniwindListener.subscribe(rerender, dependencies)
        }
    }, [dependencies.join(','), Boolean(planned.themed)])

    return { style: current.styles, themed: planned.themed }
}

/** callback ref that registers the view with the engine while `themed` is set, and forwards to the user's ref */
export const useEngineRef = (themed: ThemedStyles | null, userRef: Ref<unknown> | undefined) => {
    const registered = useRef<unknown>(null)

    return useCallback(
        (node: unknown) => {
            if (registered.current) {
                engine().unregister(registered.current)
                registered.current = null
            }

            if (node && themed && engine().register(node, themed)) {
                registered.current = node
            }

            if (typeof userRef === 'function') {
                userRef(node)
            } else if (userRef && typeof userRef === 'object') {
                ;(userRef as { current: unknown }).current = node
            }
        },
        [themed, userRef],
    )
}
