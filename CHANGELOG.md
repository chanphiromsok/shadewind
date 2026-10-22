# Changelog

## Unreleased

- Fix: a view the engine had painted kept the engine's colour when a render left it unbound with a colour equal to the one React had sent before (a tab bar that rendered under dark, was painted light, then took a class that is the same in both themes stayed light). The render that unbinds a view now sends its colours again, as 8-digit hex.

## 0.3.4

No change in behaviour for apps; the code is easier to change.

- `shadewind/internal`: `prepare()` is removed. It did nothing (it warmed pre-built nodes that no longer exist) and nothing in the package called it.
- Internal: the Uniwind adapter's style helpers (`withTheme`, `resolveUncached`, the per-theme styles) are one module, `cn` is its own file, and the stale "SPIKE" label on the
  precompiled runtime is gone.
- Native: the Paragraph recolor counters (development builds) belong to the hook, not the process; the `ThemeHook` members that need its mutex take a proof of the lock, so a call
  without it no longer compiles; React Native 0.86's deprecated `SharedListOfShared` alias is spelled out; and React Native's own `@deprecated` documentation warning no longer
  shows in the library's iOS (clang) builds.

## 0.3.3

- Uniwind 1.13 is supported: the engine, the bounded style cache and `precompileClassNames` (the edge-case screen is pixel-identical to plain Uniwind 1.13.0;
  the 1.12.2 checks pass too). The native class resolver is not: Uniwind 1.13 compiles each style to a `matches()` function and drops the fields the class table
  builder reads, which used to leave an empty table without a word. `buildStyleTable` now refuses that format with a reason (`status()` reports it, Metro warns
  once) and Uniwind resolves every class itself. The `uniwind` peer range is `>=1.12.0 <1.14.0`.

## 0.3.2

- Fix: memory. Every distinct className stayed in Uniwind's style cache for the life of the app, and the adapter's plan added two more cache entries per className
  (the other themes, the pressed state), each with its own listener subscription. A className built from unbounded values (`w-[${px}px]`) grew the Hermes heap
  without bound (80,000 distinct classNames: about 460 MB with plain Uniwind, 760 MB with the adapter). Now: the plan probes without caching, `themed` objects are
  shared per distinct colour set, `precompileClassNames` keeps the 256 most recently rendered classNames per expression component, and Uniwind 1.12's style cache is
  replaced on the store instance by a bounded one (4096 per theme, one listener per dependency; `globalThis.__SHADEWIND_STYLE_CACHE_LIMIT__`, `0` leaves Uniwind's
  alone). The same soak stays flat. The 2003-view mount benchmark is unchanged (48.3 to 48.8 ms adapter, 41.9 to 42.2 ms precompile). `example-real`: `-soak 1`,
  `-soakUnique N`, `-soakTheme 1` and `scripts/memory-soak.sh`.

## 0.3.1

- Fix: while the engine was active the adapter dropped the Theme dependency from every view's subscription, including views the engine does not
  paint (an inline `style` over a painted key, a property the engine does not paint such as `dark:opacity-40`, a key missing in a theme, data
  attributes). Such a view kept the style of the theme it first rendered under after a switch: a search bar with `border border-divider` and an
  inline background showed the dark theme's border after the app switched to light at start-up. Those views now re-render on a theme switch as plain
  Uniwind's do. With `precompileClassNames`, such a className is rendered by the adapter's component.

## 0.3.0

- `withShadewind(config, { precompileClassNames: true })` (off by default, experimental): a Babel plugin compiles `View` / `Text` elements
  with a literal or expression `className` (from `react-native` or `shadewind/uniwind`, no spread, `style` or `ref`) into components that
  resolve the style once per className and render the host element without hooks. Everything else keeps the adapter's path. A mounted
  compiled view does not re-render on `Uniwind.updateCSSVariables`. See `docs/PRECOMPILE.md`. Checked by `tools/precompile-check.cjs` and, on a
  device screen, by `example-real/scripts/edge-cases.py` (pixel comparison with plain Uniwind and the adapter).
- `ShadewindEngine.register` takes a `force` argument: register a view again with the same styles (a view React re-rendered under another
  theme, so the engine rebuilds its per-theme props from React's).
- `example-real`: `-mountBench render` (the uniwind-benchmarks render scenario), `-mountBench feed`, `-engineOff 1`, and
  `SHADEWIND_PRECOMPILE=1` in its Metro config.
- Docs: a current `docs/ARCHITECTURE.md`, a docs index, `docs/PRECOMPILE.md`; design notes moved to `docs/design/` and dated memos and the
  own-compiler design to `docs/archive/`. The README and `docs/BENCHMARK.md` carry the 2026-10-20 mount numbers measured in the benchmark
  repository's own apps.

## 0.2.1

- `capabilities.asyncCommit` is `true` on Android too (it was `false` there while `hookAsync` committed on the JS thread). 0.2.0 shipped
  the worker thread but still reported `false`.
- Docs: the README benchmark is one table (iOS and Android), and the API, guide, known-limits, overview and architecture docs match the
  code (the `withShadewind` options, the Android worker thread, current mount numbers).

## 0.2.0

- Android: `hookAsync` commits on a worker thread (`sw-commit`) instead of the JS thread. A theme switch now costs the JS thread about
  0.14 ms instead of about 8.2 ms (2003 views, Android Release, emulator). Switches made while the worker is busy coalesce into one
  commit of the newest theme. Time to the screen is unchanged (React Native's main-thread mount, about 47 ms for 2003 views); the
  re-mount scenario is unchanged. The queue has its own tests (`cpp/harness/run-commit-worker-tests.sh`, under ThreadSanitizer,
  AddressSanitizer and UBSan). iOS is unchanged.
- `withShadewind(config, { cacheColors: true })` (off by default): a bounded cache in front of React Native's colour parser, for apps
  that write colours as strings in `StyleSheet` styles (about 19 ms less for a 2003-view re-mount). No effect for Uniwind with
  Shadewind.
- Docs: measured Android findings in `docs/BENCHMARK.md`: where a re-mount's time goes (JS thread per function, a native trace), the
  floor for 2003 views (37 ms on the emulator, against 61 ms for the current tree), and what did not help (view recycling, skipping
  prewarm, a cheap path for theme-only classNames, which every className here fails because each reads CSS variables).
- `cn()` (the native class merge) is about 10% faster per call (about 236 ns to about 213 ns on the test suite's cases): a first-character
  check before the order-sensitive modifier lookup, one output resize instead of per-token appends, no sort for fewer than two
  modifiers. The output is unchanged byte for byte (the 3,000-case `tailwind-merge` fixture suite, under AddressSanitizer and UBSan).
- Not changed: re-mount time. Registering views by a prop instead of a ref was only checked to be possible (the prop reaches the C++
  props once it is in the host view config's attributes); it is not built.

## 0.1.0 (unreleased)

First public release. Experimental: New Architecture only, React Native 0.86.x, iOS is the primary target.

- Commit-hook theme engine: `setTheme` applies per-theme `backgroundColor`, `borderColor`, `color` and `opacity` to mounted views inside
  the shadow tree commit; text colour changes skip the layout pass.
- API: `configure`, `setTheme`, `getTheme`, `useTheme`, `subscribe`, `followSystem`, `useThemed`, `useThemedProps`, `ThemedView`,
  `ThemedText`, `cn` / `configureCn` (native `twMerge(clsx())`), `shadewind-cn-table` CLI.
- Uniwind adapter (`shadewind/uniwind`, `shadewind/metro`), verified against Uniwind 1.12.x.
- Fixed: a screen revealed after `freezeOnBlur` could keep the previous theme when the theme changed more than once while it was
  frozen (views re-registered with a render-theme claim that the tree no longer matched). Verified on the iOS simulator through the
  Uniwind adapter, with bottom tabs and a native stack; see `docs/design/DESIGN.md`. The public `useThemed` / `ThemedView` path got the same
  change but has not been verified on a device.
- Fixed: with the Uniwind adapter active, `setTheme` (with or without a transition) switched only the engine; Uniwind stayed on the
  old theme (half-switched screen) and the next `Uniwind.setTheme` to that old theme was ignored. `setTheme` now goes through
  `Uniwind.setTheme`, so both switch together (strategy `hookDeferred`, Uniwind's subscribers re-render as with `Uniwind.setTheme`).
- Changed: `hookDeferred` (the Uniwind adapter) makes no commit of its own; the React commit of the re-render the switch causes carries
  it, and a low-priority task commits if none does. Meant for colours React renders (`useResolveClassNames`, `useCSSVariable`,
  gradients) that were reported changing after the engine's views. The likely cause, inferred from the React and React Native sources
  and not reproduced: a switch from outside a press handler (system appearance, effects, timers) lets React render in a later task
  than the engine's own commit. Harness-tested; not verified on a device.
- Removed: `shadewind/uniwind/aot` (an undocumented ahead-of-time `className` path). It measured no faster than the adapter's
  components (docs/archive/RENDER_PIPELINE_DESIGN.md section 17c) and was a second code path to keep right.
- The adapter's components pass the resolved `className` style as a single object when there is no `style` prop, instead of a
  new two-element array per render.
- `shadewind/diagnostics` (development only): `enableDiagnostics({ reportMounts, reportUnmounts, reportUpdates })` logs every view
  bound to the engine, every bound view released or unbound (with the live count, for leak hunting), and every commit that themed
  views with the props each one got. Recorded by the commit hook natively, compiled into Debug builds only.
- Known limits: up to 6 themes, every theme must define every key a view registers, no state variants or scoped themes on the fast
  path, Android less tested (commits synchronously on the JS thread), relies on a private React Native API to find a view's shadow node.
