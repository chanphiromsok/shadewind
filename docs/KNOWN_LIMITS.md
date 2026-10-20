# Known limits

What shadewind does not do yet, and where it is not fully proven. Back to the [README](../README.md).

## Performance

- **Mounting is not free.** A theme switch is fast, but every themed view gets a ref and registers with the engine when it mounts.
  In the benchmark repository's own apps on the iOS simulator (2003 views, three launches each) Shadewind mounts in 47.5 ms against
  60.3 ms for plain Uniwind and 37.2 ms for `StyleSheet`, and with `precompileClassNames` in 40.7 ms ([BENCHMARK.md](BENCHMARK.md),
  2026-10-20). On the Android emulator (2026-10-19 protocol, not re-measured since) it is 59 to 61 ms against 55.38 ms for a numeric
  `StyleSheet` app, and 37.17 ms for bare host components with no styling library, which is the floor there. The engine's own share of
  an Android mount is up to about 11 ms of JS; the rest is Uniwind and React Native. Every className in the benchmark reads CSS
  variables, so every view keeps its re-render subscription, and no cheaper path for theme-only classNames applies. One simulator and
  one emulator, no device.
- **The commit hook runs on every commit.** It skips subtrees the previous commit already themed and `display: none` subtrees
  (frozen screens), so a React commit costs about what React changed. A mount commit still visits the new nodes once. After a switch
  made off the JS thread (`hookAsync`: the iOS queue, and the Android worker since 0.2.0), the first React commit themes the views
  again, once. That re-theme was measured on iOS; on Android it is the same mechanism, not measured.

## `precompileClassNames` (experimental, off by default)

See [PRECOMPILE.md](PRECOMPILE.md) for the mechanism.

- **Mounted compiled views do not re-render on `Uniwind.updateCSSVariables`**; views rendered afterwards get the new values.
- **A className that toggles into one the adapter handles** (a breakpoint or data-attribute class) swaps the element type and remounts
  the subtree. Toggling to nothing (`undefined`, `false`, `''`) does not.
- **Spread props, `Pressable`, `TouchableOpacity`, `withUniwind` components and custom host wrappers are not compiled.** An app whose
  styled elements all go through its own wrappers (the tovtam app: `VStack`, `HStack`, `TextFigtree` forward `{...props}`) gets no
  compiled views until those wrappers change; bundling it with the option on rewrote none.
- **Measured on the iOS simulator in Release only.** Not on a physical device, on Android or in a Debug build. On the 30-card feed of
  `example-real` it was in line with `StyleSheet` ([BENCHMARK.md](BENCHMARK.md)); the gain depends on how many classNames are static.

## What the fast path covers

- Up to 6 themes, and every theme must define every key a view registers.
- No state variants (such as `active:`) and no scoped themes on the fast path; those views are not registered.
- A className whose themes differ in a property other than `backgroundColor`, `borderColor` or `color` (for example `dark:opacity-40`) is
  not repainted by a theme switch: the view keeps the style of the theme it rendered under until something re-renders it. Found by
  comparing builds pixel by pixel (`example-real/scripts/edge-cases.py`); it is the same in the adapter with and without
  `precompileClassNames`, and plain Uniwind does not have it.

## How well it is tested

- **Frozen screens and rapid toggles** (`freezeOnBlur`, Suspense / Activity) are covered by the native harness in `cpp/harness`, which
  runs React Native's renderer without a device: a revealed screen is themed inside the commit that shows it. On a device they were
  checked by hand on the iOS simulator ([DESIGN.md](design/DESIGN.md), [LOCAL_TESTING.md](LOCAL_TESTING.md)).
- **Android:** the harness also builds the renderer as on Android and checks what the mounting layer sends each Java view (`rawProps`).
  The package compiles with the NDK (arm64) and the switch ran on an emulator. Physical Android devices and other ABIs were not tried.
- **The Android commit worker** (`sw-commit`, `cpp/CommitWorker.hpp`) has 17 native tests under ThreadSanitizer, AddressSanitizer and
  UBSan, and a soak of about 2,100 switches on the emulator without a crash. It was not tested across a JS reload or app teardown,
  where the worker's last reference to the engine could be released on its thread.

## Internals

- It relies on a private React Native API, `getNodeFromInternalInstanceHandle`, to find a view's shadow node. A React Native update
  could change it.
