# Spike A: is per-theme resolution through `scopedTheme` trustworthy?

Run inside a copy of `uni-stack/uniwind-benchmarks/apps/uniwind` (Uniwind 1.12.0): copy these files next to `App.tsx`, add
`extraThemes: ['ocean']` to the Metro config, and make `index.js` register `SpikeA` when launched with `-spikeA 1`
(iOS: `xcrun simctl launch <udid> <bundle> -spikeA 1`). The result is shown on screen and logged as `SPIKE_A_RESULT`.

It reads the private `UniwindStore` through a relative path (package `exports` block the deep import).
