# Handoff (2026-10-17)

State of the `engine/freeze-and-mount` work, merged into `main`. Read this first, then `docs/LOCAL_TESTING.md`.

## Where things are

- `main` = `engine/freeze-and-mount` (fast-forwarded, no merge commits). Baseline for every A/B: commit `44eb043` (the code
  before this work): `git worktree add ../shadewind-baseline 44eb043`.
- Everything below is verified off-device only (Linux, Docker, Node). Nothing of this work has run on an iOS simulator, a device
  or Android yet.

## What was done

1. **Engine (theme switch, freeze, mount)**: `cpp/ThemeHook.hpp`, `cpp/ThemeEngine.hpp`, `cpp/HybridShadewind.cpp`,
   `src/internal.tsx`, `src/index.tsx`, `src/uniwind/useShadewindStyle.ts`. Bindings survive `freezeOnBlur` (a revealed screen is
   themed inside the reveal commit: 0 stale views, was 800), `display: none` subtrees are skipped, "proven" subtrees of the last
   committed root are skipped, one `registerMany` JSI call per commit. Harness numbers: mount of 2003 views (native part) 21.1 ms vs
   70.7 ms at 44eb043 (15.0 ms with no engine); unrelated React commit 0.26 ms vs 2.9 ms; the switch itself unchanged (~4.6 ms).
   Details: `docs/ARCHITECTURE.md` section 18.
2. **`cn` fix**: `cpp/css/ClassMerge.hpp`, order-sensitive modifiers are sort barriers like tailwind-merge 3.
3. **Native Tailwind class resolution** (the "Uniwind Pro 1 ms" idea): Uniwind's `resolveStyles` in C++.
   - `cpp/css/StyleResolver.hpp`: resolver over a per-theme table.
   - `src/uniwind/styleTable.ts`: builds the table from Uniwind's stylesheet (records every variable / runtime read).
   - `src/uniwind/nativeResolver.ts`: own `resolveStyles` on Uniwind's store in front of Uniwind's (native only with no scoped
     theme / variables and a current table); `nativeResolver.status() / rebuild() / setEnabled()` from `shadewind/uniwind`.
   - `metro-babel-transformer.cjs` + `metro.cjs`: `withShadewind` builds the table at bundle time (wraps the project's Babel
     transformer; appends a guarded `registerPrebuiltStyleTable(json, meta)` to Uniwind's CSS module), so the first screen
     resolves natively. Opt out: `withShadewind(config, { prebuildStyleTable: false })`.
   - Parity: 137,790 cases equal to Uniwind 1.12's own `resolveStyles` (`cpp/harness/fixtures/resolver`, generated with Uniwind's
     real bundler and Metro transformer); 25 resolver mutants all caught; `seam-check.mjs` 20 checks.
   - Real `react-native bundle` of example-real (iOS + Android): table in the bundle, `hermesc` compiles. Cost: 26 KB table,
     +29.6 KB JS bundle (+1.9 %), +26.2 KB Hermes bytecode (+1.2 %), parsed natively at startup.
   - Details: `docs/ARCHITECTURE.md` section 19.
4. **Native harness** (`cpp/harness`, README there): React Native 0.86.2's C++ renderer on Linux with a React stand-in; tests +
   benchmark; Docker. Also built **as on Android** (`HARNESS_ANDROID_STATE`): checks the colour each Java view would hold after
   Android's mount instructions, in all three React Native props modes. `docker run --rm shadewind-harness` runs everything
   (`run.sh`): `[  PASSED  ] 18 tests` four times, then the benchmark tables. Section 20 of ARCHITECTURE.

## What is NOT proven (do these next, in order)

Follow `docs/LOCAL_TESTING.md` (written for an agent on a Mac):

1. Step 1: `docker build -f cpp/harness/Dockerfile -t shadewind-harness . && docker run --rm shadewind-harness`.
2. Steps 2-3: JS checks, repack the library into `example-real/vendor`, `pod install`.
3. Step 4: freeze sequences on the iOS simulator (the main reason for this work): no wrong colour after a reveal.
4. Step 6: `-resolveBench 1` in example-real: expect `table prebuilt`, `getStyles misses native` > `uniwind`,
   `parity mismatches 0`. Then cold-launch A/B with `-resolverOff 1`: claim no first-screen speedup unless the median difference is
   larger than the launch-to-launch spread.
5. Steps 5, 7, 8: mount / switch A/B against `44eb043`, uniwind-benchmarks.
6. Step 9: Android. First NDK compile of this version (never done), freeze sequences on the emulator. example-real's
   launch-argument benches use iOS-only `Settings`: they do not run on Android.

No speed numbers from a device exist yet. Do not quote "faster than Uniwind Pro": their 1 ms benchmark is unknown.

## Known risks / open points

- Android: C++ never compiled with the NDK on this branch (folly json used by `StyleResolver` is in React Native's
  `folly_runtime`, by reading, not by build). JNI / Java paths untested.
- Expo: the Babel-transformer hook is the same mechanism but Expo's transform worker was never run.
- The device-side table build (when no prebuilt table) is one unchunked JS task; cost in Hermes unknown.
- The JSI glue of the resolver (`resolveClasses` / `__swResolve` in `cpp/HybridShadewind.cpp`) has only been compiled
  (syntax-checked against React Native and Nitro headers), never run: ResolveBench's parity line is its first end-to-end check.
- Uniwind version gate: 1.12.x only (`src/uniwind/install.ts`, `metro-babel-transformer.cjs`). Another version falls back to
  plain Uniwind.

## Regenerating fixtures

`cpp/harness/README.md` "Regenerating the resolver fixture": a scratch directory with `uniwind@1.12.0 tailwindcss@4.3.3
esbuild@0.25.10 metro@0.84.6 metro-config@0.84.6 metro-transform-worker@0.84.6 @react-native/metro-config@0.86.2
@react-native/metro-babel-transformer@0.86.2`, the package built (`bob build`), then `generate.mjs` and `seam-check.mjs`.

## Environment notes (cloud sessions)

- Yarn: `node .yarn/releases/yarn-4.11.0.cjs` (corepack download is blocked).
- `dl.google.com` is blocked by the cloud environment's network policy (no Android SDK / NDK there); allow it under the
  environment's Network access settings to build Android in a cloud session. No KVM: no emulator in the cloud.
- Docker in a cloud session needs `dockerd --iptables=false --bridge=none` and a base image with the session's proxy and CA;
  not needed on a normal machine.
