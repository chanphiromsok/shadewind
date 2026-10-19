# Example: the Uniwind benchmark app with Shadewind

This is the app of [uni-stack/uniwind-benchmarks](https://github.com/uni-stack/uniwind-benchmarks) (`apps/uniwind`, ISC licence,
commit `dc89364`) with Shadewind added, so it measures exactly what that benchmark publishes: a header card and 1000 items, 2003
views styled with Uniwind `className`s.

Shadewind comes in through two lines, the same as in any Uniwind app:

- `metro.config.js`: `withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }))`
- `index.js`: `installUniwind()` from `shadewind/uniwind`, after the app import

`src/App.tsx` and `src/benchmark/` are upstream's code (only import paths and formatting differ). The app uses this repository's
Shadewind source (`react-native-monorepo-config`, the `shadewind-source` condition), so library changes show up without a reinstall.

## Run it

```sh
yarn example start
yarn example ios          # or: yarn example android
```

For numbers, build Release (`cd example && npx react-native run-ios --mode Release`). Each launch runs one scenario by itself and shows
the result on screen:

| Scenario | iOS | Android | What one run is |
|---|---|---|---|
| render (default) | no argument | no data | re-mount the 1000 items |
| theme | `-benchmarkScenario theme` launch argument | VIEW intent with data `uwbench://theme` | one light/dark switch of the mounted list |

```sh
xcrun simctl launch --terminate-running-process booted uniwindshadow.example -benchmarkScenario theme
```

The number is the average of 10 runs, each timed from the state or theme change until the JavaScript thread is idle
(`requestIdleCallback`). It leaves out the main thread's work: the time until the new theme is on screen is measured separately, see
[docs/BENCHMARK.md](../docs/BENCHMARK.md). Discard the first (cold) launch.

On the iPhone 17 Pro simulator (iOS 26.5, Release) this app shows about 48 ms for render and 2.4 ms for theme; the published comparison
(Uniwind 1.12 64.31 ms and 105.86 ms, StyleSheet 38.94 ms, measured with upstream's `scripts/bench/measure.py`) is in the main README
and docs/BENCHMARK.md.

The previous example (the plain React Native API demos and the strategy benchmark, `BenchScreen`, `CnBench`, `TheirBench`) was
replaced by this app; it is in the history at commit `bd6638d`.
