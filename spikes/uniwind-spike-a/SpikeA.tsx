import './global.css'
import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Uniwind } from 'uniwind'
import { StyleDependency } from './node_modules/uniwind/src/common/consts'
import { UniwindStore } from './node_modules/uniwind/src/core/native/store'
import { SPIKE_CLASSES } from './SpikeClasses'

// Spike A: is `getStyles(..., { scopedTheme: B })` while A is current the same as really switching to B and resolving?
// For every className in the compiled stylesheet and every ordered pair of themes (A, B).

type Mismatch = { cn: string; a: string; b: string; scoped: string; real: string; dep: boolean }
type Report = {
  swapMismatches: number
  swapScopedMismatches: number
  themes: string[]
  total: number
  themed: number
  mismatches: Mismatch[]
  noThemeDepButDiffer: number
  pairs: number
  note: string
}

const ctx = (scopedTheme: string | null) => ({ scopedTheme, rtl: null, variables: null }) as any
const stable = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  )

const run = (): Report => {
  const store = UniwindStore as any
  const names = Object.keys(store.stylesheet as Record<string, unknown>)
  const themes = Object.keys(store.vars as Record<string, unknown>)
  const mismatches: Mismatch[] = []
  let themed = 0
  let noThemeDepButDiffer = 0
  let swapMismatches = 0
  let swapScopedMismatches = 0
  let pairs = 0

  // temporarily make `b` the runtime's current theme (lightDark() reads it), then resolve
  const withTheme = <T,>(b: string, fn: () => T): T => {
    const rt = store.runtime
    const prev = rt.currentThemeName

    rt.currentThemeName = b

    try {
      return fn()
    } finally {
      rt.currentThemeName = prev
    }
  }

  // which classNames differ at all between themes (real, unscoped) = "themed"
  const realByTheme: Record<string, Record<string, string>> = {}

  for (const theme of themes) {
    Uniwind.setTheme(theme as any)
    realByTheme[theme] = {}

    for (const cn of names) {
      realByTheme[theme][cn] = stable(UniwindStore.getStyles(cn, {}, undefined, ctx(null)).styles)
    }
  }

  for (const cn of names) {
    if (new Set(themes.map((t) => realByTheme[t][cn])).size > 1) {
      themed++
    }
  }

  for (const a of themes) {
    for (const b of themes) {
      if (a === b) {
        continue
      }

      pairs++
      Uniwind.setTheme(a as any)

      const scoped: Record<string, string> = {}
      const swapped: Record<string, string> = {}
      const swappedScoped: Record<string, string> = {}
      const deps: Record<string, boolean> = {}

      for (const cn of names) {
        scoped[cn] = stable(UniwindStore.getStyles(cn, {}, undefined, ctx(b)).styles)
        deps[cn] = UniwindStore.getStyles(cn, {}, undefined, ctx(null)).dependencies.includes(StyleDependency.Theme)
        swapped[cn] = withTheme(b, () => stable(UniwindStore.getStyles(cn, {}, undefined, ctx(null)).styles))
        swappedScoped[cn] = withTheme(b, () => stable(UniwindStore.getStyles(cn, {}, undefined, ctx(b)).styles))
      }

      Uniwind.setTheme(b as any)

      for (const cn of names) {
        const real = stable(UniwindStore.getStyles(cn, {}, undefined, ctx(null)).styles)

        if (real !== swapped[cn]) {
          swapMismatches++
        }

        if (real !== swappedScoped[cn]) {
          swapScopedMismatches++
        }

        if (real !== scoped[cn]) {
          mismatches.push({ cn, a, b, scoped: scoped[cn], real, dep: deps[cn] })
        }

        if (real !== realByTheme[a][cn] && !deps[cn]) {
          noThemeDepButDiffer++
        }
      }
    }
  }

  return {
    swapMismatches,
    swapScopedMismatches,
    themes,
    total: names.length,
    themed,
    mismatches,
    noThemeDepButDiffer,
    pairs,
    note: `requested ${SPIKE_CLASSES.length} classes`,
  }
}

export default function SpikeA() {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const result = run()

      console.log('SPIKE_A_RESULT ' + JSON.stringify(result))
      setReport(result)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const byClass = new Map<string, Mismatch[]>()

  report?.mismatches.forEach((m) => byClass.set(m.cn, [...(byClass.get(m.cn) ?? []), m]))

  return (
    <ScrollView style={{ marginTop: 60, paddingHorizontal: 12 }}>
      <Text style={{ fontWeight: 'bold', fontSize: 16 }}>Spike A: scoped vs real resolution</Text>
      {error ? <Text>{`ERROR ${error}`}</Text> : null}
      {report ? (
        <View>
          <Text>{`themes: ${report.themes.join(', ')} | classNames in stylesheet: ${report.total} | differ between themes: ${report.themed}`}</Text>
          <Text>{`theme pairs: ${report.pairs} | mismatching classNames: ${byClass.size} (${report.mismatches.length} pair-cases)`}</Text>
          <Text>{`classNames that differ between themes but report no Theme dependency: ${report.noThemeDepButDiffer}`}</Text>
          <Text>{`${report.note}`}</Text>
          <Text>{`SWAP fix (runtime theme set to B, unscoped call): mismatches ${report.swapMismatches}; (runtime B + scopedTheme B): ${report.swapScopedMismatches}`}</Text>
          {[...byClass.entries()].slice(0, 12).map(([cn, list]) => (
            <Text key={cn} style={{ marginTop: 6 }}>
              {`MISMATCH ${cn} [${list.map((m) => `${m.a}->${m.b}${m.dep ? '' : ' (no Theme dep)'}`).join(', ')}] scoped=${list[0]!.scoped} real=${list[0]!.real}`}
            </Text>
          ))}
          <Text style={{ marginTop: 8 }}>{byClass.size === 0 ? 'RESULT: no mismatch' : 'RESULT: MISMATCHES FOUND'}</Text>
        </View>
      ) : null}
    </ScrollView>
  )
}
