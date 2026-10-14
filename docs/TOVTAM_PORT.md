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
