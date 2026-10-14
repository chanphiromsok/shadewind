# Spike B: Shadewind adapter on Uniwind 1.12.0 (free)

Run inside a copy of `uni-stack/uniwind-benchmarks/apps/uniwind` (iOS simulator, Release):

1. Symlink this repo into the app: `ln -s <repo> apps/uniwind/node_modules/shadewind`; add `react-native-nitro-modules` to the app;
   put `react-native.config.js` next to `package.json` (autolinking of the symlinked package), replace `metro.config.js`
   with the one here (watchFolders, `unstable_conditionNames: ['shadewind-source', 'react-native']`, blockList of the repo's own
   node_modules so there is one react-native), `pod install`.
2. Copy `adapter/*` to `node_modules/uniwind/src/shadewind/` (inside the Uniwind package, so the Uniwind resolver treats the
   files as internal and their `react-native` imports are not rewritten) and replace
   `node_modules/uniwind/src/components/native/{View,Text}.tsx` with re-exports of `../../shadewind/{View,Text}`.
   This is a patch-package style shortcut for the spike. The real seam (a Metro resolver wrapper matching the resolved file path)
   is the next spike.
3. Put `SpikeB.tsx` next to `App.tsx`, make `index.js` register it when launched with `-spikeB 1`.

`shadewind` is required lazily from the adapter and its native object is created on first use: Uniwind's component barrel is
evaluated while React Native is still setting up, before the native runtime is ready.
