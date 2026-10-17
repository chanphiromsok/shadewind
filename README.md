# shadewind

Theme switching for React Native (Fabric) that does not re-render your components. A theme change is applied to the
already mounted views inside the shadow tree commit, so the JS thread stays free.

> **Status: experimental (0.x).** New Architecture only, React Native 0.86. iOS is the primary target; Android commits
> synchronously on the JS thread and has less testing (the native harness is built as on Android, and the theme switch was checked
> on an emulator in one app, not on a physical device). Uniwind support is verified against Uniwind 1.12.x.

Measured on 2003 views, 10 theme changes (`uniwind-benchmarks`, iOS simulator, Release, 2026-10-14; more in
[Benchmarks](#benchmarks)):

| | JS thread time per switch |
|---|---|
| Uniwind 1.12.0 | ~103 ms |
| Shadewind `hook` (synchronous) | ~3.5 ms |
| Shadewind `hookAsync` (default) | ~0.1 ms JS idle, about 11 ms until mounted |

Theme values only: `backgroundColor`, `borderColor`, `color` and `opacity`. Everything else keeps rendering through React.

With Uniwind, the adapter applies a switch with `hookDeferred`: the commit runs on the JS thread but is mounted together with
React's own commit, so views React re-renders (for example a `LinearGradient`'s `colors`) change in the same frame as the engine's.
It costs about 6 ms of JS time for 473 views (`example-real`, iOS simulator) against ~0.5 ms for `hookAsync`; see `docs/HANDOFF.md`.

## Install

```sh
npm install shadewind react-native-nitro-modules
# only for the Uniwind adapter: npm install uniwind
cd ios && pod install
```

## Plain React Native

```tsx
import { configure, setTheme, useThemed, ThemedView } from 'shadewind';

configure({ themes: ['light', 'dark'], initialTheme: 'light' });

const card = {
  light: { backgroundColor: '#fff', borderColor: '#e5e5e5' },
  dark: { backgroundColor: '#1c1c1e', borderColor: '#3a3a3c' },
};

function Card() {
  const themed = useThemed(card);

  return <View ref={themed.ref} style={[styles.card, themed.style]} />;
}

// or: <ThemedView themed={card} style={styles.card} />

setTheme('dark'); // no component re-renders
```

A view that uses anything the engine cannot handle (a key a theme does not define, an inline `style` that sets a registered
key, an undeclared theme) renders through React as usual and warns once in development. A binding always renders correctly.

## With Uniwind

```js
// metro.config.js
const { withUniwindConfig } = require('uniwind/metro');
const { withShadewind } = require('shadewind/metro');

module.exports = withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }));
```

Nothing in `node_modules` is patched and your `className` code does not change. What the engine takes over, of Uniwind's 22
components:

| | Theme switch without re-render (engine) | Native class resolution |
|---|---|---|
| `View`, `Text`, `Pressable`, `TouchableOpacity` | yes, for `backgroundColor`, `borderColor`, `color` | yes |
| your own components wrapped with `withUniwind(Component)` (no options; `className` / `*ClassName` passed down as `style`) | yes, same properties | yes |
| the other 18 (`ScrollView`, `Image`, `ImageBackground`, `TextInput`, `FlatList`, `SectionList`, `VirtualizedList`, `SafeAreaView`, `KeyboardAvoidingView`, `Modal`, `Switch`, `ActivityIndicator`, `Button`, `RefreshControl`, `InputAccessoryView`, `TouchableHighlight`, `TouchableNativeFeedback`, `TouchableWithoutFeedback`), and `withUniwind` with options | no: Uniwind's own behaviour (they re-render on a theme change, as with plain Uniwind) | yes |

Inside the four components, views the engine cannot take (state variants such as `active:`, scoped themes, inline colour
overrides, themes that differ in other properties) keep Uniwind's own behaviour too. More than 6 themes, or an unsupported
Uniwind version, turns the engine off and leaves plain Uniwind.

Uniwind's class resolution (what runs when its style cache misses) also goes native, from a class table `withShadewind` builds
while Metro bundles (so from the first screen on; `withShadewind(config, { prebuildStyleTable: false })` builds it on the device
when idle instead): same results as Uniwind's JS (checked on 137,790 cases), and every className with a class the table cannot
hold (shadows, transforms, safe-area and screen units, data / rtl variants) is still resolved by Uniwind. `nativeResolver` from
`shadewind/uniwind` reports its status and turns it off (`setEnabled(false)`).

## API

| Export | |
|---|---|
| `configure({ themes, initialTheme, onUnsupported })` | declare themes once, before the first render |
| `setTheme(name, { transition? })` / `getTheme()` | switch / read; `transition: { type: 'fade', durationMs }` cross-fades (see below) |
| `setDefaultTransition(t)`, `configure({ transition })` | the transition for every switch that passes none, Uniwind's `setTheme` included |
| `useTheme()` / `subscribe(fn)` | the current theme as React state, for UI the engine does not update |
| `followSystem(map?)` | follow the OS appearance (an explicit `setTheme` stops it) |
| `useThemed(styles)` | `{ ref, style, engine }` for one host view |
| `ThemedView`, `ThemedText`, `mergeRefs` | thin components and ref helper |
| `capabilities` | `maxThemes` (6), `supportedKeys`, `asyncCommit`, `platform` |
| `configureCn({ table, fallback })`, `cn(...)` | native `twMerge(clsx(...))`, byte-identical for every token in the table (generate it with `npx shadewind-cn-table <srcDir>`); about 21x faster than clsx+twMerge on Hermes (see `docs/ARCHITECTURE.md` section 13) |
| `shadewind/uniwind` | `installUniwind()`, adapter `View` / `Text` / `Pressable` / `TouchableOpacity`, `withUniwind` |
| `shadewind/metro` | `withShadewind(config)` |
| `shadewind/internal` | diagnostics and benchmark strategies, no semver guarantee |

Design: [docs/API.md](docs/API.md), [docs/DESIGN.md](docs/DESIGN.md), [docs/UNIWIND_INTEGRATION.md](docs/UNIWIND_INTEGRATION.md).

### Animated switch (optional, default instant)

`setTheme('dark', { transition: { type: 'fade', durationMs: 250 } })`, or once for everything (Uniwind too):
`setDefaultTransition({ type: 'fade', durationMs: 250 })`. A snapshot of the window is laid over the app, the theme is
switched underneath, and the snapshot fades out once Fabric reports the new theme mounted. The overlay takes no touches. It is
skipped (instant switch) with reduce motion on, with the app in the background or without a window, and when the picture cannot
be taken. Android's snapshot does not include `SurfaceView` / `TextureView` content (maps, video). Without the option nothing runs.

## Benchmarks

Three kinds of numbers, not comparable with each other: on the iOS simulator (whole app), in the native harness (React Native's
C++ renderer on Linux, native work only), and correctness checks. Full tables: `docs/BENCHMARK.md`; how to reproduce:
`docs/LOCAL_TESTING.md`.

**Theme switch, iOS simulator** (the table at the top, `uniwind-benchmarks`, 2003 views, measured 2026-10-14). The switch path has
not changed since (harness: 4.6 ms before, 4.7 ms after, native part).

**Native cost inside React Native's renderer** (`cpp/harness`, Docker on Linux, 2026-10-17, medians of 15, each arm in its own
process; React's render and JS are not included). `none` is React Native without the engine, `44eb043` the engine before the
freeze / mount work:

| 2003 views | none | 44eb043 | current |
|---|---|---|---|
| mount, total native | 15.0 ms | 70.7 ms | 21.1 ms |
| unrelated React commit | 0.22 ms | 2.94 ms | 0.26 ms |
| theme switch, sync | - | 4.58 ms | 4.72 ms |
| first React commit after a switch | 0.22 ms | 4.80 ms | 3.09 ms |

| 5 tabs x 400 cards, 4 frozen (`freezeOnBlur`) | none | 44eb043 | current |
|---|---|---|---|
| theme switch, sync / async | - | 3.54 / 3.08 ms | 2.91 / 2.83 ms |
| reveal a frozen tab after a switch (sync) | 11.0 ms | 20.3 ms | 12.4 ms |
| views with the old theme in the reveal commit | - | 800 | 0 |

Reproduce: `docker build -f cpp/harness/Dockerfile -t shadewind-harness . && docker run --rm shadewind-harness` (tests, the same
tests with the renderer built as on Android, then these tables).

**Uniwind class resolution in C++** (`nativeResolver`, `docs/ARCHITECTURE.md` section 19): correctness and size so far, no speed
yet.

| | |
|---|---|
| results equal to Uniwind 1.12's own `resolveStyles` | 137,790 of 137,790 cases (the rest of the classNames fall back to Uniwind on purpose) |
| class table (example-real), built by Metro | 26 KB, 123 classes |
| bundle size (example-real, iOS Release) | +29.6 KB JS (+1.9 %), +26.2 KB Hermes bytecode (+1.2 %) |
| speed vs Uniwind's JS, first screen | not measured yet: `-resolveBench 1` and the `-resolverOff 1` A/B in `docs/LOCAL_TESTING.md` step 6 |

**Not measured yet:** this version on a device or simulator (mount A/B against 44eb043, the resolver's speed and its effect on the
first screen), and anything on Android. No speed claim is made for these until those runs exist.

## Architecture

Shadewind has two parts: a **native engine** (shipped) and an **own style compiler** (design stage, not built yet).

```
BUILD (Node, Rust libs)  [planned]
  sources -> oxide scanner -> tailwind compile -> lightningcss visitor -> emit
                                                                     |-> binary native table
  Babel: className -> ids (AOT) -----------------------------------'-> JS module of class ids

JS THREAD                    NATIVE (C++, Nitro raw JSI)  [shipped]
  React render -> bind(ref)/ids --> registry: family -> per-theme props
  setTheme(name) -----------------> UIManagerCommitHook
                                       -> clone nodes, paragraph recolour (no layout) -> mount
  (binary table -.-> registry)
```

| Layer | State | Where |
|---|---|---|
| Commit hook: per-theme prop slots, text recolour without a layout pass, background commit, Android `rawProps` | shipped, iOS + Android | `cpp/ThemeHook.hpp`, `cpp/HybridShadewind.cpp` |
| Public API (`configure`, `setTheme`, `useThemed`, `useThemedProps`, `ThemedView`) | shipped | `src/index.tsx`, `docs/API.md` |
| Uniwind adapter (`shadewind/uniwind`, `shadewind/metro`) | shipped, bridge to be retired | `src/uniwind`, `metro.cjs` |
| Own Tailwind compiler (scan, compile, lower, binary table) | build chain measured on a real app (about 100 ms cold) and reviewed (first extractor was wrong, fixed), compiler not built | `docs/ARCHITECTURE.md` sections 8-9, `spikes/compiler-spike` |
| AOT `className` resolver | design | `docs/ARCHITECTURE.md` section 10 |
| SIMD family index | experiment, 2-4x per lookup on large trees, not wired in | `cpp/experiments` |
| Native CSS colour parser, native `cn` merge, `shadewind-cn-table` | shipped (iOS verified, Android build not run) | `cpp/css`, `bin/cn-table.mjs`, `docs/ARCHITECTURE.md` section 14 |
| Native Uniwind class resolution (`resolveStyles` from a per-theme table, prebuilt by Metro) | parity-tested against Uniwind in the native harness and through Uniwind's real Metro transformer, not yet built or measured on a device | `cpp/css/StyleResolver.hpp`, `src/uniwind/nativeResolver.ts`, `metro-babel-transformer.cjs`, `docs/ARCHITECTURE.md` section 19 |

Rules the design holds to:

1. No React state or subscriptions on the theme-apply path (`useTheme()` / `subscribe()` are an opt-in exception for UI the engine does not own).
2. Every themed value has a native route.
3. A view always renders correctly at mount; an unbound view is stale after a switch, with a dev warning.
4. JS never sits on the switch path: `setTheme` is a native call.

Measured, honestly (before the 2026-10-17 work; see [Benchmarks](#benchmarks)): on a 2003-view benchmark the engine is about 100x
faster than Uniwind. On a real app (tovtam, Release, iOS
simulator) the gain is small today (about one frame, no stale frames on returning to a hidden tab) because most remaining cost is
React consumers of theme values; see `docs/TOVTAM_PORT.md`, `docs/STRATEGY.md`, `docs/RENDER_CORE.md`.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [RENDER_CORE](docs/RENDER_CORE.md), [STRATEGY](docs/STRATEGY.md), [API](docs/API.md),
[DESIGN](docs/DESIGN.md), [BENCHMARK](docs/BENCHMARK.md), [TOVTAM_PORT](docs/TOVTAM_PORT.md).

## Known limits

- **Mount cost.** The switch is fast; mounting is not free, because every view registers with the engine. After the host-direct
  `View` / `Text` change, mounting 30 feed cards on a real-app benchmark (Release, iOS simulator) is level with plain Uniwind
  (64.4 ms against 65.3 ms, a tie, not a win); see `docs/ARCHITECTURE.md` section 17b.
- **Cost on every commit.** The commit hook runs in every commit. It skips the subtrees the previous commit already themed and
  `display: none` subtrees (frozen screens), so a React commit costs about what React changed; a mount commit still visits the new
  nodes once (`cpp/harness`, native only). After a theme switch made off the JS thread (iOS `hookAsync`), the first React commit
  themes the views again on the JS thread, once.

- Up to 6 themes; every theme must define every key a view registers.
- No state variants and no scoped themes on the fast path.
- `freezeOnBlur` (Suspense / Activity hiding a screen) and rapid toggles are covered by the native harness (`cpp/harness`: React
  Native's renderer, no device): a revealed screen is themed inside the commit that shows it. On a device they were verified
  manually on the iOS simulator (`docs/DESIGN.md`, `docs/LOCAL_TESTING.md`). Android: the harness also builds React Native's
  renderer as on Android and checks what its mounting layer sends each Java view (`rawProps`, in all three props modes). The package
  compiles with the NDK (arm64) and the theme switch ran on an emulator; physical Android devices and other ABIs were not tried.
- Relies on a private React Native API (`getNodeFromInternalInstanceHandle`) to find a view's shadow node.

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
