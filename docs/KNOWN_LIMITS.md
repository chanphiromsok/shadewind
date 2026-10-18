# Known limits

What shadewind does not do yet, and where it is not fully proven. Back to the [README](../README.md).

## Performance

- **Mounting costs a little.** A theme switch is fast, but every themed view gets a ref and registers with the engine when it
  mounts (about 5.8 ms for 2003 views on the iOS simulator, measured against the adapter with the engine off). The adapter's lighter
  views offset it: mounting is level with plain Uniwind on the Uniwind benchmarks example (62.03 against 61.86 ms for 2003 views,
  [BENCHMARK.md](BENCHMARK.md)) and on a real-app benchmark (30 feed cards: 64.4 against 65.3 ms, [ARCHITECTURE.md](ARCHITECTURE.md)
  section 17b). A tie, not a win; one simulator, no device.
- **The commit hook runs on every commit.** It skips subtrees the previous commit already themed and `display: none` subtrees
  (frozen screens), so a React commit costs about what React changed. A mount commit still visits the new nodes once. After a switch
  made off the JS thread (iOS `hookAsync`), the first React commit themes the views again, once.

## What the fast path covers

- Up to 6 themes, and every theme must define every key a view registers.
- No state variants (such as `active:`) and no scoped themes on the fast path; those views keep Uniwind's own behaviour.

## How well it is tested

- **Frozen screens and rapid toggles** (`freezeOnBlur`, Suspense / Activity) are covered by the native harness in `cpp/harness`, which
  runs React Native's renderer without a device: a revealed screen is themed inside the commit that shows it. On a device they were
  checked by hand on the iOS simulator ([DESIGN.md](DESIGN.md), [LOCAL_TESTING.md](LOCAL_TESTING.md)).
- **Android:** the harness also builds the renderer as on Android and checks what the mounting layer sends each Java view (`rawProps`).
  The package compiles with the NDK (arm64) and the switch ran on an emulator. Physical Android devices and other ABIs were not tried.

## Internals

- It relies on a private React Native API, `getNodeFromInternalInstanceHandle`, to find a view's shadow node. A React Native update
  could change it.
