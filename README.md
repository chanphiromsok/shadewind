# shadewind

Theme switching for React Native (Fabric) that does not re-render your components. A theme change is applied to the
already mounted views inside the shadow tree commit, so the JS thread stays free.

> **Status: experimental (0.x).** New Architecture only, React Native 0.86. iOS is the primary target; Android works but
> commits synchronously on the JS thread and has less testing. Uniwind support is verified against Uniwind 1.12.x.

Measured on 2003 views, 10 theme changes (`uniwind-benchmarks`, iOS simulator, Release; see `docs/BENCHMARK.md`):

| | JS thread time per switch |
|---|---|
| Uniwind 1.12.0 | ~103 ms |
| Shadewind `hook` (synchronous) | ~3.5 ms |
| Shadewind `hookAsync` (default) | ~0.1 ms JS idle, about 11 ms until mounted |

Theme colours only: `backgroundColor`, `borderColor`, `color`. Everything else keeps rendering through React.

## Install

```sh
npm install shadewind react-native-nitro-modules
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

`View` and `Text` from Uniwind become engine-aware. Nothing in `node_modules` is patched and your `className` code does not
change. Views the engine cannot take (state variants such as `active:`, scoped themes, inline colour overrides, themes that
differ in other properties) keep Uniwind's own behaviour. More than 6 themes, or an unsupported Uniwind version, turns the
engine off and leaves plain Uniwind.

## API

| Export | |
|---|---|
| `configure({ themes, initialTheme, onUnsupported })` | declare themes once, before the first render |
| `setTheme(name)` / `getTheme()` | switch / read |
| `useTheme()` / `subscribe(fn)` | the current theme as React state, for UI the engine does not update |
| `followSystem(map?)` | follow the OS appearance (an explicit `setTheme` stops it) |
| `useThemed(styles)` | `{ ref, style, engine }` for one host view |
| `ThemedView`, `ThemedText`, `mergeRefs` | thin components and ref helper |
| `capabilities` | `maxThemes` (6), `supportedKeys`, `asyncCommit`, `platform` |
| `configureCn({ table, fallback })`, `cn(...)` | native `twMerge(clsx(...))`, byte-identical for every token in the table (generate it with `npx shadewind-cn-table <srcDir>`); about 21x faster than clsx+twMerge on Hermes (see `docs/ARCHITECTURE.md` section 13) |
| `shadewind/uniwind` | `installUniwind()`, adapter `View` / `Text` |
| `shadewind/metro` | `withShadewind(config)` |
| `shadewind/internal` | diagnostics and benchmark strategies, no semver guarantee |

Design: [docs/API.md](docs/API.md), [docs/DESIGN.md](docs/DESIGN.md), [docs/UNIWIND_INTEGRATION.md](docs/UNIWIND_INTEGRATION.md).

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

Rules the design holds to:

1. No React state or subscriptions on the theme-apply path (`useTheme()` / `subscribe()` are an opt-in exception for UI the engine does not own).
2. Every themed value has a native route.
3. A view always renders correctly at mount; an unbound view is stale after a switch, with a dev warning.
4. JS never sits on the switch path: `setTheme` is a native call.

Measured, honestly: on a 2003-view benchmark the engine is about 100x faster than Uniwind. On a real app (tovtam, Release, iOS
simulator) the gain is small today (about one frame, no stale frames on returning to a hidden tab) because most remaining cost is
React consumers of theme values; see `docs/TOVTAM_PORT.md`, `docs/STRATEGY.md`, `docs/RENDER_CORE.md`.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [RENDER_CORE](docs/RENDER_CORE.md), [STRATEGY](docs/STRATEGY.md), [API](docs/API.md),
[DESIGN](docs/DESIGN.md), [BENCHMARK](docs/BENCHMARK.md), [TOVTAM_PORT](docs/TOVTAM_PORT.md).

## Known limits

- **Mount cost.** The switch is fast; mounting is not free. On Uniwind's own benchmark app (2003 views, Release, iOS
  simulator) the Uniwind bridge rendered in about 72 ms against about 61-63 ms for plain Uniwind (about +11 ms), because every
  view registers with the engine at mount. A change that builds each distinct style once is in progress and not yet measured; see
  `docs/ARCHITECTURE.md` section 15.

- Up to 6 themes; every theme must define every key a view registers.
- No state variants, no `opacity`, no scoped themes on the fast path.
- Rapid-toggle behaviour of the async default is verified manually, not yet by a saved test.
- Relies on a private React Native API (`getNodeFromInternalInstanceHandle`) to find a view's shadow node.

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
