# Spike B test app files

The adapter that this spike proved now ships in the package as `shadewind/uniwind` (`src/uniwind`), wired by `shadewind/metro`.
These files are the test screen and configs to run it inside a copy of `uni-stack/uniwind-benchmarks/apps/uniwind` (iOS, Release):

1. Symlink this repo into the app: `ln -s <repo> apps/uniwind/node_modules/shadewind`; add `react-native-nitro-modules`; put
   `react-native.config.js` next to `package.json` (autolinking of the symlinked package); `pod install`.
2. Replace the app's `metro.config.js` with the one here (it ends with `withShadewind(withUniwindConfig(...))`).
3. Put `SpikeB.tsx` next to `App.tsx`; make `index.js` register it when launched with `-spikeB 1`.

No file inside `node_modules/uniwind` is changed. Launch with `-benchmarkScenario theme` to run their benchmark with the engine.
