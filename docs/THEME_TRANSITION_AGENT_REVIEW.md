# Theme transition: handover for a reviewing / testing agent

Branch `claude/exciting-tesla-0ajx5i` (not merged, no PR). Read `docs/THEME_TRANSITION_TESTS.md` for the device checks; this file is
what an agent needs to review the code and to re-run what can be run without a device.

## What it is

An optional animated theme change, default instant. `setTheme(name, { transition: { type: 'fade' | 'blur', durationMs } })`,
`setDefaultTransition()`, `configure({ transition })`; the Uniwind adapter uses the default. A snapshot of the window is laid
over the app, the engine switches the theme underneath it, and the overlay animates away once the new theme is mounted.

| Piece | File |
|---|---|
| JS API, validation, defaults | `src/index.tsx`, `src/internal.tsx` |
| Third raw-JSI argument of `setTheme` (the Nitro spec is unchanged on purpose) | `cpp/HybridShadewind.cpp` |
| "Is the new theme mounted?" gate (a Fabric `UIManagerMountHook`) | `cpp/ThemeTransition.hpp` |
| Which epoch each returned root carries (`watchMounts`, `rootCarries`, lock-free `epoch()`) | `cpp/ThemeHook.hpp` |
| Native overlay interface (`themeTransitionBegin/Run`) | `cpp/ShadewindNative.hpp` |
| iOS overlay: `snapshotViewAfterScreenUpdates:NO`, `UIVisualEffectView` for blur | `ios/ShadewindNative.mm` |
| Android overlay: `decorView.draw` into a Bitmap, `RenderEffect` blur (API 31+), JNI | `android/.../ThemeTransitionOverlay.kt`, `cpp/ShadewindNative.cpp` |
| Harness tests of the mount signal | `cpp/harness/tests.cpp` (end of file) |

Flow: JS `setTheme` -> native `begin` queues the snapshot on the main/UI thread BEFORE the commit (main-queue FIFO on iOS; an
asynchronous message on Android) -> the engine commits -> Fabric mounts and calls the mount hook on the main/UI thread -> if the
mounted root is a tree `ThemeHook` returned for the new epoch, `run(id)` starts the animation (Android waits one Choreographer
frame callback first) -> overlay removed by identity at the end. A native 1 s timer animates and removes any overlay that never got
its signal. Rapid toggles: a new `begin` snapshots (including what is left of the old overlay) and then removes the old overlay.

## Rules for any agent working here

- Clean room: do not read any Uniwind Pro package or tarball, and do not copy code from other transition libraries. The
  implementation is this repo's own.
- No Docker (denied in the cloud sessions); the harness builds natively (below).
- No attribution lines in commit messages. Commit on this branch only; never push to `main`; no PR unless the owner asks.
- Report what you did not verify. No device result may be claimed without a recording.

## What can be re-run without a device (all passed at `7b2969f`)

```sh
# JS: typecheck (34 pre-existing errors in example/ and spikes/, none may be in src/), lint, format
node .yarn/releases/yarn-4.11.0.cjs install && git checkout yarn.lock
node .yarn/releases/yarn-4.11.0.cjs typecheck 2>&1 | grep -c "error TS"      # 34, and: ... | grep "^src/" is empty
node .yarn/releases/yarn-4.11.0.cjs prettier --check src/index.tsx src/internal.tsx
node tools/theme-transition-js-check.cjs                                       # 16 checks on the real src/index.tsx

# Native harness: React Native 0.86.2's real C++ renderer on Linux
apt-get install -y libgoogle-glog-dev libdouble-conversion-dev libboost-dev libgflags-dev libgtest-dev
cd cpp/harness && bash fetch-deps.sh                                           # needs network (npm registry, github, maven)
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
cmake --build build --target harness_tests && ./build/harness_tests            # 24 tests
cmake -S . -B build-android -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang -DHARNESS_ANDROID_STATE=ON
cmake --build build-android --target harness_tests
for m in default accumulated reconciliation; do HARNESS_ANDROID_PROPS=$m ./build-android/harness_tests; done   # 25 tests each
```

First build is long (about 10 minutes per configuration on 4 cores). `.deps/`, `build/`, `build-android/` are git-ignored.

The new harness tests (`MountedRootCarries*`, `Transition*`, `RapidToggles*`, `AnotherHookThatClones*`, `NothingIsRecorded*`) use real
`ShadowTree` commits and simulate a mount the way `UIManager::reportMount` does (pull the transaction, pass the base revision's
root). A mutant check showed they fail when `rootCarries` ignores the epoch (edit `ThemeHook.hpp`, rebuild, expect 2 failures,
restore). Keep that habit: a test that cannot fail proves nothing.

Kotlin compile check (no Gradle needed): kotlinc 2.0.21 (`kotlin-compiler-embeddable`, stdlib, script-runtime, daemon-embeddable,
trove4j, annotations-13, coroutines-core-jvm 1.6.4 from Maven Central) with the Robolectric `android-all-14` jar on the classpath,
plus tiny stubs for `com.margelo.nitro.NitroModules` (`@JvmStatic var applicationContext: ReactApplicationContext?`),
`com.facebook.react.bridge.ReactApplicationContext` (`currentActivity`) and `com.facebook.proguard.annotations.DoNotStrip`.
Expected: no errors; `javap -s` shows `begin (JID)V` and `run (J)V`, which `cpp/ShadewindNative.cpp` calls through fbjni.

C++ syntax check of the JNI glue: `clang++ -std=c++20 -fsyntax-only -D__ANDROID__` on `cpp/ShadewindNative.cpp` with fbjni 0.7.0
headers (from `cpp/harness/.deps/fbjni/include`), the JDK's `jni.h`, and stubs for `android/log.h` and two React Native headers.
Prove the check can fail by introducing a typo in a copy.

## Measured here (x86 Linux VM, one machine; a phone is slower)

- Plain commit through the hook, ~2000 views: 0.768 us armed vs 0.764 us never armed (median of 8 runs); React commit on ~2000
  views about 280-300 us either way; the ring write under its lock 2.7-3.0 ns; mount hook 0.8 ns idle, 6-14 ns armed.
- Contention (main thread calling `rootCarries` every 8 ms while commits run): commits unchanged. A 5M calls/s tight loop slows
  commits 2.5x, which is not realistic.
- Fixed at `7b2969f`: `ThemeHook::epoch()` took the mutex a background (hookAsync) commit holds for its whole walk, so `setTheme`
  on the JS thread blocked 2.6-3.7 ms in 2-6 of 1500 calls; it is lock-free now (0 of 1500 blocked).
- Still true and older than this branch: `hook.setTheme()` waits on that same mutex under continuous background commits
  (p50 about 2 ms on ~2000 views).

## NOT verified (nothing below has run on iOS or Android)

- `ios/ShadewindNative.mm` has never been compiled. `ThemeTransition.hpp`/`ThemeHook.hpp` are compiled and tested by the harness
  but not in an app build. No Gradle or Xcode build was made.
- No recording exists: acceptance items 1-7 of the task (cross-fade brightness, taps through the overlay, three toggles within 150
  ms leaving no orphan, both strategies, reduce motion, unchanged cost, hidden-tab reveal) are all open. F8 is not ticked
  (`docs/TASKS.md` is not in this checkout).
- Snapshot time and memory on a phone, GPU blur cost, dropped frames.

## Review focus (where a bug is most likely)

1. Pointer identity: the mount hook compares the mounted root with the root `ThemeHook` returned. Any commit hook registered
   after `ThemeHook` that returns a new root (Reanimated, MutationObserver, ViewTransition) defeats it; the fade then waits for the
   1 s timer. Known and demonstrated by the harness test `AnotherHookThatClonesTheRootDefeatsTheMountSignal`.
2. Android ordering: the snapshot is an asynchronous message sent at `setTheme` time; the mount report is posted at the front of
   the queue and C++ pulls the transaction on the committing thread. `mountedId` skips a snapshot the mount overtook, and `run`
   waits one Choreographer frame callback. Read `FabricUIManager.java` (`DispatchUIFrameCallback`, `reportMount`) in
   `node_modules/react-native/ReactAndroid` before changing either.
3. `_armed` is not cleared by the native 1 s timer; a stale armed state costs 14 ns per mount, but a frozen overlay stays 1 s.
4. Android bitmap: `decor.draw` on the UI thread, 10.4 MB at 1080x2400, 16-22 MB on tablets and foldables; hardware bitmaps in the
   tree probably throw (caught, so the transition is skipped after its cost is paid); `SurfaceView`/`TextureView` content and
   native `Modal` windows are not captured.
5. iOS blur tint follows the SYSTEM appearance (`UIBlurEffectStyleSystemMaterial`), not the app theme: a dark theme on a light OS
   may flash a light tint. A snapshot taken while a previous blur is on screen may not contain the blur.
6. The `dispatch_after` block keeps each iOS snapshot alive up to 1 s after it was removed.
7. The mount recording and hook registration stay on for the life of the process after the first animated switch.

## Device measurement plan (owner / agent with a device)

- Android: mid-range phone and a tablet, 20 toggles each of fade, blur and none. Perfetto with a temporary `Trace.beginSection`
  around bitmap create + draw, plus `dumpsys gfxinfo framestats`. Pass: snapshot p90 <= 8 ms at 60 Hz (<= 4 ms at 120 Hz); janky
  frames <= baseline + 1; `dumpsys meminfo` back to baseline about 2 s after 10 rapid toggles. Consider a half-size snapshot for
  blur only if it fails (blur hides detail; keep fade at full size).
- iOS: real device, same scenario. Instruments Animation Hitches with an `os_signpost` around the snapshot; VM Tracker under rapid
  toggles. Pass: hitch ratio < 5 ms/s, snapshot < 2 ms.
- Then run the numbered checks in `docs/THEME_TRANSITION_TESTS.md` (30 fps recordings, per-frame `signalstats` YAVG, view hierarchy
  check for orphan overlays, reduce motion on and off, restore any simulator/emulator setting you change).

## Possible next steps (not started)

- Make the transition independent of the theme switch: `withTransition(() => anyChange(), options)` with a pluggable mount gate
  (strict epoch gate for theme switches, generic "first mount after the callback plus a settle" for other changes), `setTheme`
  as a thin wrapper, and the recording ring moved out of `ThemeHook`.
- iOS: snapshot every visible window of the foreground scene, not only the key window. Android: capture `Modal` dialog windows.
- Clear `_armed` when the failsafe fires.
