# Handoff (2026-10-18): why Shadewind on Uniwind is not faster at mount, and what to do next

> Historical handoff (2026-10-17/18). Numbers and branch names are those of the time; see [BENCHMARK.md](../BENCHMARK.md) for current ones.

Branch `claude/exciting-tesla-0ajx5i`. Read this section first; the 2026-10-17 handoff below is older.

## Numbers so far (owner's runs, iPhone 17 Pro simulator, iOS 26.5, RN 0.86, 2003 views, median of 6 warm launches)

| Arm | Mount |
|---|---|
| plain Uniwind 1.12 | 61.86 ms |
| shadewind adapter, `__SHADEWIND_ENGINE_OFF__` | 56.25 ms |
| shadewind, engine on | 62.03 ms |
| Uniwind Pro (their chart, their device and protocol; never run here) | ~45 ms |

Theme switch to pixels (filmstrip): plain Uniwind ~127-130 ms, shadewind ~58-63 ms. Pro's switch: not measured.

## Why the engine costs ~6 ms at mount

Metro (`shadewind/metro`) does the per-class work at build time: it swaps Uniwind's `View` / `Text` / `Pressable` /
`TouchableOpacity` / `withUniwind` for ours and prebuilds the C++ class table. It cannot do the per-view work: which native view gets
which className is known only when React mounts it. Today each themed view pays at mount, on the JS thread:

- a ref callback per view, which makes React create the view's public instance (`ReactNativeElement`). React creates it lazily, on
  the first ref access (`ReactFabric-prod.js:10361`); plain Uniwind views have no ref and never create one. Not measured.
- the JS register path (ref holder, WeakMaps, queue): 1.6-2.8 ms per 2003 views (Hermes `-O`, VM, logic copied).
- `registerMany` in C++: about 2 M instructions per mount (harness).
- the C++ class resolver: unmeasured at mount. `__SHADEWIND_ENGINE_OFF__` turns it off too, so it is mixed into the 5.8 ms.

The rest of the gap to Pro (56 ms vs 45 ms) is the component layers (Uniwind-style hooks per view, React, React Native), not
the engine.

## Next steps, in order

1. **Fourth arm (no code).** The engine build with `-resolverOff 1` added to the TheirBench render launch args, same protocol, same
   session as the other three. Arm 3 minus arm 4 = the resolver's mount cost. If it costs, the cheap fix is to keep it off for the
   first mount.
2. **Register at switch time instead of at mount (the real fix; not started).** Remove the per-view ref and registration:
   - the component passes the per-theme colours as an extra prop on the host element (e.g. `$sw={themed}`). React Native filters props
     through the view config before they reach native (`createAttributePayload(newProps, validAttributes)`,
     `ReactFabric-prod.js:7099`), so it costs nothing natively. It stays on the fiber (`memoizedProps`,
     `stateNode.canonical.currentProps`), and `stateNode.node` is the shadow node (`ReactFabric-prod.js:7104-7118`).
   - on `setTheme`, JS walks the React tree from the root (one ref per app root through
     `AppRegistry.setWrapperComponentProvider`), collects `{ node, themed }` for each host fiber that carries the prop, and calls
     `registerMany` once, then applies the theme as today.
   - walk cost: 0.42 ms per walk of a synthetic 8,013-fiber tree (2003 cells; Hermes `-O`, VM). Not a real React tree.
   - deletes: `useEngineRef` / ref holders, the Pressable `pause` / `resume`, `registeredWith` / `attachedNodes`, the render-theme
     re-attach logic.
   - to check before trusting it: hidden subtrees (Activity, Suspense, `freezeOnBlur`) still themed when shown; walk the current
     tree (`root.current`), not the work-in-progress tree; modals and other separately registered roots; a view mounted between the
     walk and the native commit (it rendered with the new theme, so expected fine); React internals are a private API (the engine
     already uses `__internalInstanceHandle` and `RendererProxy`).
   - prototype behind a launch flag (`-registerAtSwitch 1`), harness and JS checks first, then the owner's mount and switch arms with
     and without the flag. Ceiling: at best removes the engine's ~6 ms (near the engine-off 56 ms), it does not reach 45 ms.
3. **Component layers (only path toward ~45 ms).** View and Text already render the host components directly (`NativeView`,
   `NativeText`). What is left per view is the hooks (context, reducer, layout effect + subscribe) and `getStyles`. Profile one mount
   with the Hermes sampling profiler before changing anything.
4. **Switch tail (~60 ms to pixels).** Pending recordings: the example TheirBench without the adapter, and `-theirBenchNoText 1`.
   Hypothesis: main-thread mount and text redraw, not the engine.

## Done in this session (2026-10-18)

- Yoga configured flag kept on themed clones; next React commit after a switch 4.2-5.0 ms -> 1.3-1.4 ms (harness).
- `hookDeferred` rides React's commit (Low-priority fallback commit); the Uniwind driver uses it by default.
- Registration: `addMany`, 4-slot style memo, graveyard freed off the JS thread.
- Adapter trim: Text 8 -> 5 hooks, one style object without a `style` prop, `shadewind/uniwind/aot` removed.
- Engine inactive (`__SHADEWIND_ENGINE_OFF__` or any inactive reason): views now subscribe to the theme like Uniwind's own
  components (they stayed stale on a switch before). JS check added (40 checks pass). Typecheck: no errors in `src/`; the 34 errors
  in `spikes/` were there before. Not run on a simulator.
- Not verified anywhere: a device; Android for the 2026-10-18 changes; the resolver's mount cost.

# Handoff (2026-10-17)

State of the `engine/freeze-and-mount` work, merged into `main`. Read this first, then `docs/LOCAL_TESTING.md`.

## Where things are

- `main` = `engine/freeze-and-mount` (fast-forwarded, no merge commits). Baseline for every A/B: commit `44eb043` (the code
  before this work): `git worktree add ../shadewind-baseline 44eb043`.
- The sections "What was done" and "What is NOT proven" below were written when everything was verified off-device only (Linux, Docker,
  Node). Since then it ran on the iOS simulator and an Android emulator: read "Update, later on 2026-10-17" first.

## Update, later on 2026-10-17: tovtam, iOS and Android devices

Branch `fix/android-colours-deferred-theme-mount` (two commits on top of `main`): the engine fix and the repacked `example-real`
tarball. Not merged, not pushed. Tovtam (`~/Desktop/tovtam`, branch `feat/trip-plan-figma-v2`) is NOT committed: its working tree has
the integration (`metro.config.js`, `package.json` + `yarn.lock` for `shadewind`, `vendor/shadewind-0.1.0.tgz`,
`src/components/sheet/SheetChrome.tsx`, `DynamicBottomSheet.tsx`) next to the owner's own `@legendapp/list` bump; stage by hunk.

What changed (all in the branch above):

1. **Android colours** (`cpp/ThemeEngine.hpp`): CSS-string colours are stored as signed int32 under `RN_SERIALIZABLE_STATE`. Java reads a
   colour prop as a `Double` and narrows it with `toInt()`, which saturated every unsigned ARGB to `0x7FFFFFFF` (white at 50% alpha):
   every re-themed view on Android turned into a 50% white layer after the first switch (a bottom sheet looked see-through). Found by
   an on-device A/B (signed vs unsigned), confirmed in RN's `ReadableNativeMap.cpp` and `ColorPropConverter.kt`.
2. **`hookDeferred`** (new `setTheme` strategy, `cpp/HybridShadewind.cpp`, `src/internal.tsx`, `applyUniwindTheme` in `src/index.tsx`,
   used by `src/uniwind/install.ts`): the commit runs on the JS thread but is mounted with `mountSynchronously = false`, i.e. queued on the
   RuntimeScheduler with React's own commit of the same task. Engine-bound views and views React re-renders (LinearGradient colours)
   then change in the same frame. It is applied on iOS and Android. The public `setTheme` default is still `hookAsync`
   (with the Uniwind adapter active, `setTheme` goes through `Uniwind.setTheme` and so uses `hookDeferred` too).
3. **Podspec / package.json**: `cpp/harness`, `cpp/tests`, `cpp/experiments` are no longer compiled into the app (the gtest files broke
   the first iOS app build) nor packed.
4. **Harness**: Android mode feeds signed colours and decodes them as Java does; new test `AndroidColours.CssStringsSurviveJavaDoubleToInt`.
   **Not run: there was no Docker on the machine.** Run `docker build -f cpp/harness/Dockerfile -t shadewind-harness . && docker run --rm shadewind-harness`
   first thing; the harness never covered `mountSynchronously = false` under `HARNESS_ANDROID_STATE` either (add a test).

Verified on devices (tovtam, Release builds, simulator iPhone 17 Pro and emulator Pixel_8_Pro arm64, 30 fps screen recordings
analysed per frame with ffmpeg; one run each, 30 fps cannot resolve less than 33 ms):

- iOS and Android: switching in the Account theme sheet flips the page, the banner `LinearGradient`, the icon gradients and the sheet in
  the same frame, both directions (before: Android gradients were 4-8 frames = 133-267 ms late; the first `hookDeferred` build only
  deferred on iOS, Android ignored it until `commitTick(*ui, !deferred)` was made unconditional).
- Both: switching while Explore is hidden (freezeOnBlur), then revealing it, shows no stale frame.
- Android sheet is solid in both themes (255 / 17) after the colour fix. The Android NDK compile of this branch succeeds (`libshadewind.so`).
- example-real freeze sequences 1-3 (LOCAL_TESTING step 4) on the iOS simulator, Release: `STALE` empty, `treeOK == inTree`, no wrong
  colour in the reveal frames. Sequence 4 (pressed card + second finger) and the baseline comparison at `44eb043` were not done.

Performance of `hookDeferred` vs `hookAsync` on the Uniwind path (example-real, iOS simulator Release, 473 views, the Account "Measure 12 theme
switches" meter, 3 runs each, same native code, only install.ts's strategy differs; simulator, one session, noisy):

| | `hookAsync` (before) | `hookDeferred` (after) |
|---|---|---|
| JS time inside `setTheme` | 0.48-0.51 ms | 6.3-7.4 ms |
| idle (until the JS thread is free) | 18.5-19.4 ms | 15.0-15.4 ms |
| stall median / worst | 18.5-19.5 / 21.9-22.7 ms | 17.6 / 17.7-18.4 ms |
| tree check | 473/473 | 473/473 |

The engine commit now costs the JS thread (about 6 ms for 473 views; tovtam registers 26-108, so roughly 1-2 ms, an estimate), but the
screen settles about 3.8 ms sooner and the worst stall drops about 4 ms (the guess, untested: one commit and one mount instead of two
competing ones). Android has no meter: not measured.

Not verified / open:

- **Physical devices** (none tested; the Release build to the owner's iPhone failed at signing: no provisioning profile for
  `com.angkor.tovtam.dev`; it needs `-allowProvisioningUpdates` or signing in Xcode, which touches the Apple account, so it was left).
- **System appearance changes** after the latest changes (Opus recorded it before: no stale frames on iOS; Android hides differences because the
  system redraws on a config change).
- **One unexplained crash** (iOS Debug, tovtam): `ShadowTree::commit` asserted `attempts < 1024` after the Range tab froze for ~20 s;
  only the JS thread was inside a commit when it aborted. Not reproduced in 3 tries with Shadewind on. Release builds compile the assert out
  (a livelock would be a hang there).
- **`hidden` reads 0** in every `inspect()` state, including on a pushed PostDetail (tabs frozen). If frozen screens are not marked
  hidden in the committed tree, every switch clones every tab (performance only; colours are right). ARCHITECTURE section 18 says hidden
  subtrees are skipped: check on device whether that holds.
- **Probe numbers explained (Opus, partly inferred):** `notInTree` counts registered views whose family is still alive but not in the
  committed tree (unmounted views are never unregistered by design; a memory-warning GC took it to 0), `viewOK` only counts views attached to
  a window (inactive tabs read -1). Neither causes a wrong colour. Suggested probe change: report off-window views separately and count `viewOK` only
  over in-window views with a background delta.
- Remaining cosmetic items in tovtam: the theme-sheet row dims and the check mark moves 1-3 frames late (press feedback of `TouchableOpacity`),
  other sheets still use `useBottomSheetTheme` style props (`MomentCommentSheet`, `ExploreDetailCommentSheet`, `UseMapBottomSheet`,
  `FullOverlay*`, `DateRangePickerBottomSheet`); the Explore search bar background comes from `useBoxShadow` and `MMKV`, not from Uniwind, so a
  `Uniwind.setTheme` alone (without the app's `setSelectedTheme`) leaves it stale.
- Optional performance work: make gradient `colors` engine-bound (Uniwind's `withUniwind` option map cannot carry an array and
  `LinearGradient` gives no ref to its native view, so it needs a `ThemedLinearGradient` using `useThemedProps` / `registerRaw`);
  measure the real cost of `hookDeferred` (the engine commit now runs on the JS thread; harness 4.6 ms for 2003 views, tovtam registers 26-108 views).

How to reproduce the checks: build tovtam with `shadewind` from the tarball (`node .yarn/releases/yarn-4.11.0.cjs prepare`, `npm pack --pack-destination
<app>/vendor`, then in the app `rm -rf node_modules/shadewind && yarn install`, `pod install` or Gradle `app:assembleRelease
-PreactNativeArchitectures=arm64-v8a` with the debug keystore passed by `-PMYAPP_RELEASE_*`), record the Account > Theme sheet switch with the argent
screen recorder (`trimStatic: false`) and compare the frame where each region changes (`ffmpeg ... signalstats`). Recordings are
in `.argent/recordings` (git-ignored). Environment: `ASDF_RUBY_VERSION=3.2.0` for `pod` in `example-real/ios`; example-real needs
`bash scripts/arm.sh engine` (writes git-ignored `src/cnImpl.ts` etc.); the emulator was nearly full (use `adb shell pm uninstall -k <app>`
then `adb install` to keep app data).

## What was done

1. **Engine (theme switch, freeze, mount)**: `cpp/ThemeHook.hpp`, `cpp/ThemeEngine.hpp`, `cpp/HybridShadewind.cpp`,
   `src/internal.tsx`, `src/index.tsx`, `src/uniwind/useShadewindStyle.ts`. Bindings survive `freezeOnBlur` (a revealed screen is
   themed inside the reveal commit: 0 stale views, was 800), `display: none` subtrees are skipped, "proven" subtrees of the last
   committed root are skipped, one `registerMany` JSI call per commit. Harness numbers: mount of 2003 views (native part) 21.1 ms vs
   70.7 ms at 44eb043 (15.0 ms with no engine); unrelated React commit 0.26 ms vs 2.9 ms; the switch itself unchanged (~4.6 ms).
   Details: `docs/archive/RENDER_PIPELINE_DESIGN.md` section 18.
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
   - Details: `docs/archive/RENDER_PIPELINE_DESIGN.md` section 19.
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

- Android: the C++ now compiles with the NDK (arm64-v8a, tovtam Release) and runs on an emulator; only the tovtam theme sheet flow was
  exercised (see the update above). example-real on Android, other ABIs and physical devices were not tried.
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
