# Strategy after the tovtam port (Opus memo, 2026-10-14)

Question: keep extending the Uniwind adapter (A), build our own Tailwind resolver/compiler (B), or something else (C)?

## Diagnosis (from reading the tovtam source, not yet profiled)

What is left is mostly theme **values** read in JS, not classNames:

- `NavigationContainerTheme` -> `useThemeConfig` (`useUniwind` + `useResolveClassNames`) builds a new react-navigation theme object
  per switch, so every header, the tab bar and every `useTheme()` consumer re-renders.
- `ExploreItem` -> `useGradientColors` (`useResolveClassNames`) feeds a gradient `colors` array: each mounted row re-renders.
- `RichText` (in every ExploreItem) calls `useUniwind()` only to pick a colour that is already `DynamicColorIOS` on iOS.
- Counts in tovtam `src`: `useResolveClassNames` 12, `useUniwind` 5, `useCSSVariable` 4, `active:` classes 21;
  215 `className={...}`, 113 `cn(`, 28 `clsx`, 2 `twMerge` (much of the className input is dynamic).

Hypothesis (not shown): the ~60 ms stall, equal in both builds, is mostly these consumers. The rAF metric is already at its
floor, use the longest-stall metric.

## Options

| | A: extend adapter | B: own compiler | C: themed-value path + decouple consumers |
|---|---|---|---|
| Real-app gain | small | same as A for this app | largest if the ablation confirms (est. 20-40 ms of ~60, unverified) |
| Cost | days per component/hook | 8-12+ weeks | 1-2 weeks library + hours of app changes |
| Risk | Uniwind upgrades (private imports) | own Tailwind v4 parsing, Expo/Metro, web, migration; dynamic classNames force a runtime resolver, i.e. rebuild Uniwind | low, additive |

## Recommendation

C, gated by an ablation; keep A for maintenance; do not start B.

1. Day 1 ablation in the tovtam copy: constant navigation theme, constant gradient colours, no `useUniwind` in RichText;
   Release iOS sim, 12 switches, at least 5 runs per arm (plain, engine, engine + ablation), metric median longest JS stall.
   Go: engine + ablation <= 35 ms (at least 25 ms saved over engine alone). No-go: under 10 ms saved -> Instruments Time Profiler first.
2. Also: native probe in `ThemeHook` (entry/exit of `shadowTreeWillCommit`, commits, visited and cloned nodes per switch).
3. If go: `useThemedValue(tokens)` API that registers arbitrary colour props (gradient `colors`, custom view props) with the
   engine (feasibility for third-party view managers unknown; prototype with expo-linear-gradient), plus a "theme-switch
   hygiene" guide (stable navigation theme, no `useUniwind` where unnecessary).
4. Cheap, separate: raise `kMaxThemes` (fixed array is an implementation choice); per-state colour tables later.

If B anyway: Tailwind v4 candidate scan + `global.css` themes -> generated `{ classId -> { base, themed, states } }` table and a
native per-theme colour table; literals rewritten to `__sw(classId)`; conditional branches precompiled when all literals;
runtime resolver for the rest; unresolved class -> unthemed style + subscription (today's fallback); native nodes tagged by a
`themeClassId` prop (no JS ref registration).

## Gaps

Single simulator runs, stall cause inferred, mounted ExploreItem count and navigation propagation cost not measured, whether
`Uniwind.setTheme` flips the iOS trait collection not checked, no Android on tovtam.
