# Architecture overview

A short tour of how shadewind is built and how far along each part is. Paths in the tables are relative to the repository root; the full design is in [ARCHITECTURE](ARCHITECTURE.md).

Shadewind has two parts: a **native engine** (shipped) and an **own style compiler** (design stage, not built yet).

```
BUILD (Node, Rust libs)  [planned]
  sources -> oxide scanner -> tailwind compile -> lightningcss visitor -> emit
                                                                     |-> binary native table
  Babel: className -> ids (AOT) -----------------------------------'-> JS module of class ids

JS THREAD                    NATIVE (C++, Nitro raw JSI)  [shipped]
  React render -> bind(ref)/ids --> registry: family -> per-theme props
  setTheme(name) -----------------> UIManagerCommitHook
                                       -> clone nodes, paragraph recolour (no layout) -> mount
  (binary table -.-> registry)
```

| Layer | State | Where |
|---|---|---|
| Commit hook: per-theme prop slots, text recolour without a layout pass, background commit, Android `rawProps` | shipped, iOS + Android | `cpp/ThemeHook.hpp`, `cpp/HybridShadewind.cpp` |
| Public API (`configure`, `setTheme`, `useThemed`, `useThemedProps`, `ThemedView`) | shipped | `src/index.tsx`, `docs/API.md` |
| Uniwind adapter (`shadewind/uniwind`, `shadewind/metro`) | shipped, bridge to be retired | `src/uniwind`, `metro.cjs` |
| Own Tailwind compiler (scan, compile, lower, binary table) | build chain measured on a real app (about 100 ms cold) and reviewed (first extractor was wrong, fixed), compiler not built | `docs/ARCHITECTURE.md` sections 8-9, `spikes/compiler-spike` |
| AOT `className` resolver | design | `docs/ARCHITECTURE.md` section 10 |
| SIMD family index | experiment, 2-4x per lookup on large trees, not wired in | `cpp/experiments` |
| Native CSS colour parser, native `cn` merge, `shadewind-cn-table` | shipped (iOS verified, Android build not run) | `cpp/css`, `bin/cn-table.mjs`, `docs/ARCHITECTURE.md` section 14 |
| Native Uniwind class resolution (`resolveStyles` from a per-theme table, prebuilt by Metro) | parity-tested against Uniwind in the native harness and through Uniwind's real Metro transformer, not yet built or measured on a device | `cpp/css/StyleResolver.hpp`, `src/uniwind/nativeResolver.ts`, `metro-babel-transformer.cjs`, `docs/ARCHITECTURE.md` section 19 |

Rules the design holds to:

1. No React state or subscriptions on the theme-apply path (`useTheme()` / `subscribe()` are an opt-in exception for UI the engine does not own).
2. Every themed value has a native route.
3. A view always renders correctly at mount; an unbound view is stale after a switch, with a dev warning.
4. JS never sits on the switch path: `setTheme` is a native call.

Docs: [ARCHITECTURE](ARCHITECTURE.md), [RENDER_CORE](RENDER_CORE.md), [STRATEGY](STRATEGY.md), [API](API.md),
[DESIGN](DESIGN.md), [BENCHMARK](BENCHMARK.md), [TOVTAM_PORT](TOVTAM_PORT.md).
