# Shadewind on top of Uniwind: long-term design

Status: design, not implemented. Written against Uniwind 1.12.0 (MIT) and React Native 0.86.

## Goal

Make a theme switch in a Uniwind app update mounted views through the Fabric shadow tree instead of re-rendering every styled
component, and keep doing so across Uniwind and React Native upgrades with a bounded maintenance cost.

## What Uniwind does today (relevant parts)

- **No Babel plugin.** Everything is Metro.
- **Transformer** (`transformer.cjs`, wraps `metro-transform-worker`): compiles the `global.css` entry with Tailwind into JS,
  `Uniwind.__reinit(rt => ({stylesheet, vars, scopedVars}), themes, fingerprint)`.
- **Resolver** (`nativeResolver`): redirects `react-native` and deep RN Library imports of supported components to
  `uniwind/components/<Name>`; imports from inside the `uniwind` package are left alone.
- **Runtime:** `UniwindStore.getStyles(className, props, state, ctx)` resolves a className for a theme (cache per theme,
  `ctx.scopedTheme` selects any theme). `useStyle` in every native component subscribes to the dependencies it returns, including
  `StyleDependency.Theme`; a switch notifies `Theme` and every styled component re-renders.

## Principles

1. **Never break a Uniwind app.** Every Shadewind path must fall back to Uniwind's own behaviour. Unsupported Uniwind or RN
   version, failed feature probe, unsupported style property: render exactly as plain Uniwind would.
2. **One thin seam per upstream.** All knowledge of Uniwind internals lives in one package entry; all RN-version-specific C++
   lives behind one compat header. Nothing else may import either.
3. **The engine knows nothing about Uniwind.** Its contract is `register(view, {theme -> {backgroundColor, borderColor, color,
   opacity}})` and `setTheme(name)`. A different style source (a future own Tailwind compiler, StyleSheet themes) plugs in the
   same way.
4. **Correctness is checked at runtime in dev.** After a switch, compare the committed tree with what the style source resolves
   (the `inspect()` tree check, as a `__DEV__` warning). Upgrades that change behaviour are caught by users and CI, not by guesses.
5. **Prefer upstream extension points to private imports.** Private imports are a bridge, not the destination.

## Package layout

| Entry | Contents | Depends on |
|---|---|---|
| `shadewind` | engine: Nitro module, `register` / `setTheme`, `useThemedRef`, tree and UIKit probes | RN, nitro-modules |
| `shadewind/uniwind` | style-source adapter and wrapped components (`View`, `Text`, ...), `installUniwind()` | `uniwind` (peer range) |
| `shadewind/metro` | `withShadewind(config)`: wraps the resolver so Uniwind's component imports resolve to the adapter | Metro |

## The style-source interface

```ts
interface ThemeStyleSource {
  themes(): string[];
  /** style for a className in a given theme, plus the dependencies it has besides the theme */
  resolve(className: string, props: object, state: object, theme: string | null): {
    style: object;
    dependencies: number[];
    dependsOnTheme: boolean;
  };
  subscribeTheme(listener: (themeName: string) => void): () => void;
}
```

The Uniwind adapter implements it with `UniwindStore.getStyles` (per theme through `scopedTheme`) and `UniwindListener`.
A component is engine-handled only when the styles of all themes differ solely in supported colour properties; otherwise it
keeps Uniwind's `Theme` subscription.

## How the seam is kept small

- Wrap, do not copy: the adapter wraps Uniwind's own component for everything that is not a `View`/`Text`-class host and only
  adds the ref registration. Components are generated from one template, not hand-maintained.
- One private import file (`uniwind-internals.ts`) re-exports `UniwindStore`, `UniwindListener`, `useUniwindContext`,
  `StyleDependency`. `withShadewind` aliases them (`uniwind/internals/*`) to files inside the installed Uniwind. If the files are
  missing or the version is outside the tested range the adapter turns itself off (feature probe) and logs once in dev.
- The Metro wrapper chains the existing resolver (`config.resolver.resolveRequest`) and treats the adapter directory as
  "internal" so its own `react-native` imports are not rewritten.

## Compatibility and testing

- **Matrix:** React Native {0.85, 0.86, next}, Uniwind {1.12.x, latest}, iOS and Android. CI builds the example for each cell.
- **Unit tests** (Jest): adapter with a mocked store: per-theme diff, fallback decisions, subscription changes.
- **E2E** (saved Argent flows): Home/Settings/frozen-screen, rapid toggles, text colour, padding change, list recycling.
- **Perf gate:** the `uniwind-benchmarks` theme screen on a fixed simulator; fail when the median is more than 25% above the
  stored baseline (the baseline is the same-run free Uniwind ratio, not an absolute number).
- **Probe at startup:** engine reports which fast paths are active (Paragraph state recolour, rawProps, Yoga access). A missing
  path falls back to the normal clone path (layout runs) instead of failing.

## Upstream (ask Uniwind for these, in order of value)

1. A public per-theme resolve: `UniwindStore.resolve(className, {theme, props, state})`.
2. A per-component opt-out of the theme subscription (or a documented `useStyle` replacement hook).
3. A stable `Uniwind.addThemeListener`.
Each one removes a private import. Until accepted, the version-pinned bridge above is what ships.

## Risks and owners

| Risk | Impact | Mitigation |
|---|---|---|
| Uniwind internals change | adapter disabled, app still correct | version range, probe, CI matrix, upstream asks |
| React Native Fabric C++ changes (ParagraphState, Yoga, rawProps) | text fast path off, layout runs | compat header, probes, per-RN CI cell |
| Third-party components using `withUniwind` / `useResolveClassNames` | still re-render | documented; adapter wraps `withUniwind` output when possible |

## Build order

1. Engine compat header and startup probes (small, independent).
2. `ThemeStyleSource` + Uniwind adapter + `View`/`Text`; Metro wrapper; `installUniwind()`.
3. Drop it into `uniwind-benchmarks/apps/uniwind` with only the Metro config changed; compare with plain Uniwind on both OSes.
4. Remaining components (`Pressable`, `ScrollView`, `TextInput`, `Image`...) by template.
5. Jest tests, saved flows, CI matrix, perf gate.
6. Upstream proposals; docs.

## Review findings (Opus review of this design, 2026-10-14) and changes to the design

Verified against the Uniwind 1.12.0 source: `lightDark()` in `core/native/native-utils.ts` reads the global
`currentThemeName`, and the native `uniwind/components` barrel `require`s `./native/View` relative to itself.

The design above is **not ready to build as written**. Corrections, in priority order:

1. **Scoped resolution is not a safe "style of theme B".** `lightDark()` ignores `scopedTheme`, so a `light-dark()` colour resolved for
   theme B while A is current returns A's value, and it is cached under B with no Theme invalidation. Also `store.ts` drops the
   `Theme` dependency for scoped calls, so `dependsOnTheme` must come from the unscoped call.
   Required: the spike below must diff scoped vs real-switch results for every className; mismatching classNames go on a
   fallback list (or need an upstream fix).
2. **The commit hook overwrites colours React set on purpose.** It re-applies the registered delta on any commit where the props
   object is not ours (pressed/disabled state variants, inline `style` overrides, animated opacity). Rule: register only when
   the component has no state variants, the inline `style` touches none of the delta keys, and `ctx.scopedTheme === null`.
   Drop `opacity` from the supported set (TouchableOpacity, Animated, Reanimated).
3. **One-theme-only properties are never reset.** `dark:bg-black` with nothing for light keeps black after switching back.
   Rule: every theme must define every registered key, or the adapter emits an explicit reset, or falls back.
4. **More than 6 themes fails silently** (`kMaxThemes = 6`, extra themes fall to `kNoTheme`). Rule: fall back when
   `themes.length > 6`; raise the engine limit later.
5. **Re-render ordering:** a className / state / data-attribute change goes through the hook before the ref callback re-registers,
   so expect a one-frame stale colour and extra churn (every `add()` resets the entry and triggers a commit). Per-theme resolution
   has to run on every render and compare by value; data-attribute results are never cached by Uniwind.
6. **Nested `Text` recolour heuristic** (fragments whose colour equals the paragraph's previous colour) turns an explicit
   equal colour into the new colour. Needs a marker for inherited colour, or a fallback when a nested Text sets `color`.
7. **ScopedTheme / ScopedVariables:** never register under a scoped theme; keep the Variables, Dimensions and Rtl subscriptions;
   `Uniwind.updateCSSVariables(inactiveTheme, ...)` must re-resolve every theme; in dev `__reinit` uses `notifyAll`, so a
   Theme-only subscription loses hot-reload refresh.
8. **The Metro seam as written never intercepts the main path.** `import { View } from 'react-native'` resolves to the barrel
   `uniwind/components`; it is the resolved *file path* (`.../uniwind/src/components/native/View.tsx`) that has to be matched,
   with an origin exemption for the adapter. Uniwind captures the inner resolver in a closure, so an outer wrapper cannot see its
   internal re-resolves. Duplicate-store hazard: if the internals alias resolves to a different copy than app code, two
   `UniwindStore` instances exist and the adapter views lose all styling; alias to the exact `src` files and probe
   "same instance and populated" at startup. Web/Vite: adapter is `.native` only and disabled elsewhere.
9. **"Wrap, do not copy" is not possible** for engine-handled components: the Theme subscription lives inside `useStyle`.
   View and Text must be reimplemented (Text's `isPressed`, line-clamp mapping, `selectionColorClassName`/`useAccentColor`). That
   contradicts "one private import file" and must be stated as upkeep, or removed by upstream ask 2.
10. **Rapid toggles on `hookAsync` are still unverified** (commits run on a concurrent queue); blocks shipping, not the spike.

Also: the perf gate must include mount and scroll cost (the adapter adds N scoped resolves and a JSI `register` per view).

### Revised build order

1. **Spike A (pure JS, no native):** for every className in the compiled stylesheet, resolve theme B via `scopedTheme` while A
   is current, really switch to B, resolve unscoped, diff. Produces the fallback list or kills the approach.
2. **Spike B:** adapter `View` only, intercepted by file path in `uniwind-benchmarks/apps/uniwind`, with the store-instance probe
   and the fallback rules from 2-4 and 7. Test screens with known colours checked with `inspect()`: `active:` Text, inline
   `style` override, `dark:`-only class, TouchableOpacity, ScopedTheme subtree, 7 themes, nested Text with equal explicit
   colour, className changing after a switch (flash), `updateCSSVariables` on the inactive theme, mount time of 2003 views.
3. Only then: `Text`, remaining components, Metro wrapper hardening, tests, CI matrix, upstream asks.

## Spike A result (2026-10-14, Uniwind 1.12.0, iOS simulator, `spikes/uniwind-spike-a`)

Setup: themes `light`, `dark`, `ocean` (custom), 81 classNames in the compiled stylesheet (22 differ between themes), all 6
ordered theme pairs. For each pair: resolve B while A is current (A -> B), then really switch to B and resolve unscoped.

| Method | Mismatching resolutions (of 6 pairs x 81 classes) |
|---|---|
| `getStyles(..., {scopedTheme: B})` while A is current | **12**, all `light-dark()` classNames (3 classNames x 4 pairs); 19 of 22 themed classNames were correct |
| runtime theme temporarily set to B, then the normal unscoped call | **0** |
| runtime theme set to B + `scopedTheme: B` | 12 (the wrong values from the first method were cached under the scoped key and survive) |

Findings:
- Risk 1 from the review is real: `lightDark()` reads the global runtime theme, so scoped resolution returns the current theme's
  value for `light-dark()`, and it is cached.
- **Fix that works:** do not use `scopedTheme` at all. Set `UniwindStore.runtime.currentThemeName = B` synchronously, call
  `getStyles(className, props, state, ctx)` unscoped, restore it in a `finally`. Result equals a real switch (0 mismatches) and the
  cache entry is the same one a real switch would create, with the normal Theme invalidation. JS is single-threaded, so the swap is
  not observable by other code. This mutates one private field; the startup probe must verify the result against a real switch
  on a known className.
- The dependency list is reliable for detection: no className that differs between themes was missing the `Theme` dependency
  (0 of 22).
- `light-dark()` inside an `@theme` variable (`--color-ld: light-dark(...)`) fails to compile in Uniwind itself ("Failed to convert
  color ... type light-dark"); only the arbitrary-value form `bg-[light-dark(...)]` works.
- Not covered by this spike (spike B): state variants, inline `style` overlap, ScopedTheme, more than 6 themes, className changes.

## Spike B result (2026-10-14, Uniwind 1.12.0, iOS simulator, Release, `spikes/uniwind-spike-b`)

Adapter `View` and `Text` (the planning rules from the review: no scoped theme, no state variants, no inline overlap on the
registered keys, at most 6 themes, every theme defines every key, runtime-swap resolution from spike A), dropped into the
benchmark app with a throw-away source patch (see the README there).

| Case | Decision | Result across light / dark / ocean and back |
|---|---|---|
| `bg-primary` | engine | correct in every theme; 1 render + 0 renders for 3 theme switches |
| `bg-white dark:bg-black`, `bg-[light-dark(...)]`, `dark:bg-black`-only | fell back (my test rows had inline `borderColor`) | correct (normal Uniwind path), re-rendered on every switch |
| `text-black active:text-primary` | fell back (state variants) | correct |
| `bg-primary` + inline `backgroundColor` | fell back (inline overlap) | stayed red, correct |
| `TouchableOpacity bg-primary` | Uniwind's own component | correct |
| `ScopedTheme theme="dark"` subtree | not registered (scoped) | stayed dark, did not re-render |
| className toggled (`bg-primary` / `bg-gray`) after a switch | engine | correct after toggle and after the next switch |
| outer `text-typography` + nested `text-black` | engine (outer) | outer white in dark, inner stayed dark; the review's nested-colour collision was NOT reproduced (see below) |
| `updateCSSVariables('dark', {primary: red})` while light, then dark | engine | red in dark, as expected |

Evidence that the engine path really skips React: render counts per component after dark, light, dark (3 switches):
engine-handled rows 2 renders (initial + one forced parent render), fallback rows 8, scoped row 2.

Notes and open items:
- The nested-Text collision case was only tried light -> dark with the inner colour equal to the outer's previous colour; the
  inner stayed dark, so either the fragment colour differs from the paragraph's previous colour in that tree or the recolour did
  not run. Needs a targeted native test before relying on it.
- Mount cost, the one-frame flash on a className change, 7 themes, Android, FlatList recycling and the Metro file-path seam are
  not tested yet.
- A runtime bug found: the library created its native object at import time and crashed the app during React Native setup when
  imported from a component module ("runtime not ready"). It is created on first use now (`getNative()`), and the adapter requires
  the engine lazily.
- Metro config: dropping the default `react-native` condition from `unstable_conditionNames` breaks React Native's own setup; keep
  `['shadewind-source', 'react-native']`.


## Status: `shadewind/uniwind` + `shadewind/metro` (implemented)

- `shadewind/metro` `withShadewind(config)`, outermost after `withUniwindConfig`: (1) `uniwind-internal/*` specifiers resolve to the
  files Uniwind itself loads (`<uniwind>/src/...`); (2) imports from inside the shadewind package bypass Uniwind's resolver
  (real `react-native`, no cycle); (3) a resolved `.../uniwind/src/components/native/{View,Text}.tsx` is replaced by
  `shadewind/uniwind/{View,Text}`, resolved like an app import so the `shadewind-source`/default condition picks src or lib.
- `shadewind/uniwind` `installUniwind()` probes version (1.12.x), store/Uniwind agreement, non-empty `vars`, theme count,
  calls `configure`, subscribes once to Uniwind's Theme dependency. It never throws; when inactive the components keep the
  Theme subscription and behave like Uniwind's own.
- iOS Release, unpatched Uniwind 1.12.0, simulator: SpikeB decisions as in spike B (A/I/J engine; B/C/D/F inline overlap;
  E state variants; H scoped; text-black not theme dependent), the engine row does not re-render on a switch, fallbacks do.
  Their `-benchmarkScenario theme` with the unmodified app: JS-idle average 0.12 ms (min 0.08, max 0.29) for 2003 views,
  default `hookAsync`.
- Not done: Android run, spike C items (mount cost, className-change flash, list recycling), Uniwind > 1.12, forced
  fallback regression test in CI, pixel check of every switch in their benchmark.
