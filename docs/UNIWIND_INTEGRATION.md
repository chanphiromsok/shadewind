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
| Uniwind Pro overlap | positioning | open source engine, Uniwind-agnostic core, free Uniwind adapter |
| Third-party components using `withUniwind` / `useResolveClassNames` | still re-render | documented; adapter wraps `withUniwind` output when possible |

## Build order

1. Engine compat header and startup probes (small, independent).
2. `ThemeStyleSource` + Uniwind adapter + `View`/`Text`; Metro wrapper; `installUniwind()`.
3. Drop it into `uniwind-benchmarks/apps/uniwind` with only the Metro config changed; compare with plain Uniwind on both OSes.
4. Remaining components (`Pressable`, `ScrollView`, `TextInput`, `Image`...) by template.
5. Jest tests, saved flows, CI matrix, perf gate.
6. Upstream proposals; docs.
