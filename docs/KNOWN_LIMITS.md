# Known limits

What shadewind does not do yet, and where it is not fully proven. Back to the [README](../README.md).

## Performance

- **Mounting is not free.** A theme switch is fast, but every themed view gets a ref and registers with the engine when it mounts.
  On the iOS simulator (2003 views) Shadewind mounts in 49.93 ms against 64.31 ms for plain Uniwind and 38.94 ms for `StyleSheet`; on
  the Android emulator it is 59 to 61 ms against 55.38 ms for a numeric `StyleSheet` app, and 37.17 ms for bare host components with
  no styling library, which is the floor there ([BENCHMARK.md](BENCHMARK.md)). The engine's own share of an Android mount is up to
  about 11 ms of JS; the rest is Uniwind and React Native. Every className in the benchmark reads CSS variables, so every view keeps
  its re-render subscription, and no cheaper path for theme-only classNames applies. One simulator and one emulator, no device.
- **The commit hook runs on every commit.** It skips subtrees the previous commit already themed and `display: none` subtrees
  (frozen screens), so a React commit costs about what React changed. A mount commit still visits the new nodes once. After a switch
  made off the JS thread (`hookAsync`: the iOS queue, and the Android worker since 0.2.0), the first React commit themes the views
  again, once. That re-theme was measured on iOS; on Android it is the same mechanism, not measured.

## What the fast path covers

- Up to 6 themes, and every theme must define every key a view registers.
- No state variants (such as `active:`) and no scoped themes on the fast path; those views keep Uniwind's own behaviour.

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
