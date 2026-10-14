# Port to a real app: tovtam (2026-10-14)

App: `~/Desktop/tovtam` (Expo, RN 0.86.3, Uniwind 1.12.0, React Compiler, Sentry, hot-updater). Worked on a copy-on-write copy in the
scratchpad; the original was not touched. iOS simulator (iPhone 17 Pro), **Debug** build (dev mode renders are ~3x slower).

## What the port needed

1. `withShadewind(withUniwindConfig(...))` in `metro.config.js` (inside `withRozenite`).
2. `shadewind` listed in the app's `package.json` dependencies: CocoaPods autolinking (`use_native_modules!`) only links packages
   the app declares. Without it `pod install` silently skips Shadewind. (README now says so? no: add to install notes.)
3. `pod install`, rebuild. No source change in the app.

## Issues found

| # | Issue | Caused by Shadewind? |
|---|---|---|
| 1 | Autolinking needs the dependency in package.json (see above) | install docs gap |
| 2 | `react-native-date-picker@5.0.13` declares `codegenConfig.ios.modulesProvider` -> `RNDatePickerManager` (an `RCTViewManager`), RN 0.86 raises "Module provider RNDatePickerManager does not conform to RCTModuleProvider" at startup | no, library vs RN 0.86; workaround in the copy: drop `modulesProvider` from its package.json |
| 3 | Metro in `CI=1` mode serves stale files (no watching); use normal mode | test setup |
| 4 | About 116 `Anonymous` components (Uniwind's `withUniwind` HOC), `TouchableOpacity`, `Pressable`, `Animated(View)`, icon components still re-render: the adapter only replaces `View` and `Text` | design limit, biggest finding |
| 5 | Only 26 views registered; className decisions: 3 engine, 4 inline-style overlap, 3 no difference between themes | app style |

## Engine confirmed active (from the running app)

`installUniwind()` -> `{ active: true }`, `getTheme()` light, `inspect()`: registered 26, inTree 26, treeMatchesExpected 26,
nativePropsMatchExpected 26, layerMatchesExpected 25.

## React profiler, 6 Uniwind.setTheme calls in one tick (dark, light, ...), same screen (Explore feed)

| | Plain Uniwind | With Shadewind | Change |
|---|---|---|---|
| React commits | 2 | 2 | same |
| Commit durations (dev) | 32.04 ms, 29.41 ms | 29.26 ms, 25.85 ms | about -9 to -12 % (inside the 10-15 % noise band) |
| Fiber renders captured | 996 | 872 | -12 % |
| `Text` renders | 236 | 136 | -42 % |
| `Anonymous` (withUniwind etc.) renders | 232 | 232 | 0 |
| `RCTView` / `TouchableOpacity` / `Icon` | 88 / 36 / 38 | 88 / 36 / 38 | 0 |

Honest reading: on this app the engine removed the re-renders of host `Text` (and the plain `View`s it handles) but not
the wrapped components, so the end-to-end gain is about 10 % in dev, nothing like the benchmark's 100x. The synchronous
`Uniwind.setTheme` call itself is cheap either way (3-7 ms), because plain Uniwind only schedules the re-renders.

## What would move the number

- Cover `withUniwind(Component)` HOC output, `Pressable`/`TouchableOpacity`/`Animated(View)` and icon components: the same
  className -> engine registration for components that pass `style` through to a host `View`/`Text`.
- Only then compare in a Release build.

## Round 2: `withUniwind` HOC adapter + a native race fix (2026-10-14)

Changes: `shadewind/metro` also replaces Uniwind's `hoc/withUniwind.native.tsx` with `shadewind/uniwind/withUniwind` (engine path
for components that take only `className` and pass `style` and `ref` to a host view; several `*ClassName` props or a manual
options map use Uniwind's own HOC). A view whose registration fails (the ref never reaches a host view) puts the Theme
subscription back instead of freezing.

Engine bug found by this port (and fixed): `ThemeHook::emptyRawProps` returned one shared, mutable `RawProps`; reading it moves
`keyIndexCursor_`, so the prewarm thread and the commit thread raced and an out-of-range index aborted in a Debug build
(`RawPropsParser::at`, `vector<unsigned short>::operator[]`). It was latent in Release builds. `copyProps` now builds one
`RawProps` per call; the prepared parser stays shared (read-only).

Same scenario, same screen, 6 `Uniwind.setTheme` calls in one tick (Debug build, single run each):

| | Plain Uniwind | Engine, View/Text only | Engine, + HOC adapter |
|---|---|---|---|
| Registered views | 0 | 26 | 108 (all tree/native correct) |
| React commits | 2 | 2 | 1 |
| Commit time (dev) | 32.0 + 29.4 ms | 29.3 + 25.9 ms | 22.8 ms |
| Fiber renders | 996 | 872 | 277 (-72 %) |

Still re-rendering: `Text` x68 (state/pressed variants and parent renders), `TouchableOpacity` x18, `Animated(View)` x6,
and `Engine` x39 where the view was not handed to the engine. Single runs in a Debug build: treat as indicative, not a
benchmark. Release build and Android on tovtam are still open.
