# Plan

Status as of 2026-10-14. Working name is still `shadewind`; a new name without "uniwind" is undecided
(candidates: Tinter, Shadowtone, Chroma Shadow, Palette Swap, Hueshift, Skinswap).

## Goal

A theme-switch engine that sits on top of Uniwind: a theme change updates the already mounted views
through the Fabric shadow tree and does not re-render React components.

Target: beat plain Uniwind on the `uniwind-benchmarks` render and theme-change scenarios (2003 views) on iOS and Android.

## Where we are

| Area | State |
|---|---|
| iOS engine | works: commit hook, text colour without layout pass, `hook` / `hookAsync`, default `hookAsync` |
| Uniwind integration | not started (design below) |
| Android | builds and runs (Release arm64 emulator); `hook` 7.35 ms median vs free Uniwind 302.9 ms on the same emulator; see `docs/BENCHMARK.md` |
| Known gaps | rapid-toggle correctness re-check, commit-hook whole-tree walk, pre-built node buffer unused (`precloned 0`), `Text` state recolour is iOS-tested only |

## Phase 1: Android (first pass done, follow-ups below)

1. Build the example for Android (Release, arm64) and fix compile errors. The engine C++ is shared; platform code is in
   `HybridShadewind.cpp` (`#if defined(__APPLE__)` branches) and `ShadewindNative.cpp`.
2. `hookAsync` on Android: the iOS version posts the commit to a GCD queue and the mount completion to the main queue. Add the
   Android equivalents (a background thread for the commit; mount completion via the RN scheduler / `ALooper` main looper) or
   keep the synchronous commit until measured.
3. Text recolour (`recolorParagraph`): the Paragraph state type differs per platform (`android/ParagraphState.h` carries
   `AttributedString`, `ParagraphAttributes` and a measured layout). Verify it compiles and behaves; fall back to the normal
   clone path (layout runs) where the platform state cannot be rebuilt safely.
5. Correctness: tree check + pixel check (dark/light), frozen screen flow, rapid toggles.

Exit criteria: builds and runs on an arm64 emulator, theme switch correct in both directions including text colour, numbers
recorded in `docs/BENCHMARK.md`.

## Phase 2: Uniwind integration (adapter on top)

Long-term design (reviewed by Opus; spike A then B before building): `docs/UNIWIND_INTEGRATION.md` (thin versioned seam, engine Uniwind-agnostic, fallbacks, CI matrix, upstream asks).
The note below is the original sketch.


Findings in Uniwind 1.12.0 (MIT): `UniwindStore.getStyles(className, props, state, ctx)` resolves a className for any theme via
`ctx.scopedTheme`; `useStyle` subscribes every styled component to `StyleDependency.Theme`, which causes the re-render on a switch.

1. Resolve per theme at mount; if the only theme-dependent properties are supported (backgroundColor, borderColor, color,
   opacity) register the deltas with the engine and drop the Theme subscription for that component.
2. Hook `Uniwind.setTheme` to call `engine.setTheme` and skip the Theme notification for engine-handled components.
3. Keep every use of Uniwind internals in one file with a version check and fallback to normal rendering.
4. Prototype on `View` and `Text`, run the benchmark screen with real `className`s, compare with plain Uniwind.
5. Ask upstream for two extension points: a public per-theme resolve, and a per-component opt-out of the theme subscription.

Decision made: adapter on top plus an upstream request; fork-lite (vendor the small component wrappers only) is the fallback;
a full fork of Uniwind is not planned.

## Phase 3: engine hardening

- Commit hook walks the whole shadow tree on every commit: make it O(registered), e.g. prune subtrees without registered nodes.
- Make the pre-built node buffer effective (`precloned 0` today): item `View` with a themed child cannot use a buffered node;
  pre-build the pair, and keep the Yoga owner so React Native does not clone the child again.
- Re-run rapid-toggle, frozen screen and padding-change correctness on every engine change.
- Replace the Home/Settings manual checks with saved flows.
- Cleanup: `readBackgroundsOnMain` is debug only.

## Phase 4: product

- Pick the name; rename package, Nitro module, C++ namespace, JS exports, example bundle id and docs.
- Decide public API (`registerView` / hook / component) and what is documented as supported (style subset, platforms).

## Open decisions

1. New name.
2. Whether Android ships `hookAsync` or a synchronous commit first.
3. Whether to pursue the upstream extension points before or after the prototype.

## Reference

- `docs/DESIGN.md`: measurements, profiles, retractions.
- `docs/BENCHMARK.md`: the comparison table.

## Android follow-ups

- Background commit for `hookAsync` (executor + main-thread mount completion) so the JS thread is free like on iOS.
- UIKit-style probes for Android (view background via the mounted Java view) or rely on the tree check plus pixels.
- Physical device run; Pixel_9a-class emulator to compare with their published Android numbers.
  Uniwind ratio.

## Status: Uniwind integration spikes

- Spike A done (docs/UNIWIND_INTEGRATION.md): `scopedTheme` resolution is wrong for `light-dark()`; resolving with the runtime
  theme temporarily swapped to B and an unscoped call matches a real switch (0 mismatches).
- Next: spike B (adapter `View` in `uniwind-benchmarks/apps/uniwind`, test screens for state variants, inline style, ScopedTheme,
  7 themes, className change, updateCSSVariables, mount time).
- Spike B done (docs/UNIWIND_INTEGRATION.md): adapter View/Text works on Uniwind 1.12.0 on iOS; engine-handled components do not
  re-render on a switch and stay correct (updateCSSVariables, className change, ScopedTheme, fallbacks). Open: mount cost, className
  flash, nested Text collision, 7 themes, Android, list recycling, Metro file-path seam (spike C).
