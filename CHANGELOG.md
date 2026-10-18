# Changelog

## 0.1.0 (unreleased)

First public release. Experimental: New Architecture only, React Native 0.86.x, iOS is the primary target.

- Commit-hook theme engine: `setTheme` applies per-theme `backgroundColor`, `borderColor`, `color` and `opacity` to mounted views inside
  the shadow tree commit; text colour changes skip the layout pass.
- API: `configure`, `setTheme`, `getTheme`, `useTheme`, `subscribe`, `followSystem`, `useThemed`, `useThemedProps`, `ThemedView`,
  `ThemedText`, `cn` / `configureCn` (native `twMerge(clsx())`), `shadewind-cn-table` CLI.
- Uniwind adapter (`shadewind/uniwind`, `shadewind/metro`), verified against Uniwind 1.12.x.
- Fixed: a screen revealed after `freezeOnBlur` could keep the previous theme when the theme changed more than once while it was
  frozen (views re-registered with a render-theme claim that the tree no longer matched). Verified on the iOS simulator through the
  Uniwind adapter, with bottom tabs and a native stack; see `docs/DESIGN.md`. The public `useThemed` / `ThemedView` path got the same
  change but has not been verified on a device.
- Fixed: with the Uniwind adapter active, `setTheme` (with or without a transition) switched only the engine; Uniwind stayed on the
  old theme (half-switched screen) and the next `Uniwind.setTheme` to that old theme was ignored. `setTheme` now goes through
  `Uniwind.setTheme`, so both switch together (strategy `hookDeferred`, Uniwind's subscribers re-render as with `Uniwind.setTheme`).
- `shadewind/diagnostics` (development only): `enableDiagnostics({ reportMounts, reportUnmounts, reportUpdates })` logs every view
  bound to the engine, every bound view released or unbound (with the live count, for leak hunting), and every commit that themed
  views with the props each one got. Recorded by the commit hook natively, compiled into Debug builds only.
- Known limits: up to 6 themes, every theme must define every key a view registers, no state variants or scoped themes on the fast
  path, Android less tested (commits synchronously on the JS thread), relies on a private React Native API to find a view's shadow node.
