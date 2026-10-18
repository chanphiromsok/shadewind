# Native harness

The engine (`cpp/ThemeHook.hpp`, `cpp/ThemeEngine.hpp`) running inside React Native 0.86.2's own C++ renderer: real `ShadowTree`
commits with the commit hook, Yoga layout, props parsing and Paragraph state, on the "cxx" platform and built as on Android,
without an app, a simulator, JSI or Hermes. A small stand-in for React's Fabric renderer (`FakeReact.hpp`) creates and clones nodes the way `UIManager` does,
keeps React's node handles the way `UIManagerBinding` does, and hides / reveals subtrees the way Suspense and Activity do
(`freezeOnBlur`).

It answers two questions without a device: is every view on screen in the right theme after each commit, and what does the
engine cost natively.

## Run

Docker (any machine):

```sh
docker build -f cpp/harness/Dockerfile -t shadewind-harness .    # from the repository root, about 2 minutes
docker run --rm shadewind-harness                                 # tests (run.sh: both builds), then the benchmark
docker run --rm shadewind-harness build/harness_bench --runs 30   # benchmark only
```

Linux without Docker (Ubuntu 24.04: `clang cmake ninja-build unzip openjdk-21-jdk-headless libgoogle-glog-dev
libdouble-conversion-dev libboost-dev libgflags-dev libgtest-dev`):

```sh
cd cpp/harness
./fetch-deps.sh          # React Native from npm, folly / fmt / fast_float at the versions RN 0.86 pins, fbjni's headers
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
cmake --build build
cmake -S . -B build-android -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang \
  -DHARNESS_ANDROID_STATE=ON
cmake --build build-android --target harness_tests
./run.sh                 # tests (both builds, Android in each props mode), then the benchmark
```

On macOS use Docker: folly and glog from Homebrew do not match the versions React Native pins.

## What is in it

| File | |
|---|---|
| `FakeReact.hpp` | React's side: createNode / cloneNode, child sets from React's handles, `cloneHiddenInstance` (`display: none`), reveal, `completeRoot`, commits from the JS thread and from another thread |
| `Engines.hpp` | the engine as JS drives it, three arms: `none` (plain React Native), `baseline` (44eb043 and its JS ref policy, kept in `baseline/`), `current` (this branch) |
| `App.hpp` | themed views rendered with the current theme, refs attached after a commit and detached on hide, the JS microtask after each commit, and `check()`: every visible bound view must hold the current theme (props, and for text the drawn attributed string) |
| `tests.cpp` | correctness: mount, switches, freeze / reveal (sync and async switch), rapid toggles while frozen, React commits after a switch, pressed views, late registration, unmount clean-up, layout equal to plain React Native, a deferred switch riding the React commit |
| `run.sh` | every test run (the generic build, then the Android build in each of React Native's props modes), then the benchmark |
| `android_stubs.cpp` | the Android build's JNI ends (state and props handed to Java), never reached: the harness does not run Java |
| `class_merge_tests.cpp` | `css::ClassMerge` byte-for-byte against tailwind-merge 3.7.0 (`fixtures/classmerge`, regenerate with `generate.mjs`) |
| `style_resolver_tests.cpp` | `css::StyleResolver` against Uniwind 1.12's own `resolveStyles` (`fixtures/resolver`: 137,790 cases from Uniwind's bundler and store), with the device's table and the one Metro prebuilds (`table.prebuilt.json`); regenerate with `generate.mjs`, see below |
| `bench.cpp` | native cost per arm, each arm in its own process: mount (commit, registrations), theme switch (sync and async), the React commits after a switch, frozen tabs and their reveal |

## Release configuration and the Hermes glue check

`-DHARNESS_RELEASE_CONFIG=ON` builds the engine as a release app does (`SHADEWIND_DIAGNOSTICS=0`, `SHADEWIND_DEV_TOOLS=0`):
the tests that read the hook's stats or the diagnostics recorder skip themselves by name, the rest must pass.

`hermes_glue` runs the class resolver's JSI glue (`cpp/ResolveGlue.hpp`, what `__swResolve` runs) in a real Hermes runtime: parity
of the returned JS objects with Uniwind on every fixture case, the property-name cache against the glue without it, a table
reload, a second runtime created and destroyed, and a bench. It needs the Hermes React Native pins
(`node_modules/react-native/sdks/.hermesv1version`):

```sh
git clone --depth 1 --branch hermes-v250829098.0.16 https://github.com/facebook/hermes <dir>/hermes   # apt: libicu-dev
cmake -S <dir>/hermes -B <dir>/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_INTL=OFF -DHERMES_ENABLE_TEST_SUITE=OFF
ninja -C <dir>/build hermesvm
cmake -S . -B build -DHERMES_DIR=<dir>/hermes -DHERMES_BUILD=<dir>/build && cmake --build build --target hermes_glue
build/hermes_glue                                    # GLUE_QUICK=1 for a short run, e.g. under valgrind
```

## The scheduler order hookDeferred relies on

With `HERMES_DIR` / `HERMES_BUILD` set (see above), `cmake --build build --target scheduler_order && ./build/scheduler_order` runs
React Native's `RuntimeScheduler_Modern` on a Hermes runtime and checks that a Low task scheduled by a switch runs after the
UserBlocking and Normal tasks React schedules for the re-render (and a continuation of it), and before an Idle one. Prints
`ORDER OK` and exits 0, or `ORDER DIFFERS` and exits 1. Mutant: schedule the fallback at Normal priority, expect `ORDER DIFFERS`.

## Memory: leaks and growth

Three checks, because they find different things:

- **Memory never freed, use after free, overflows:** `-DHARNESS_SANITIZE=ON` builds the engine and React Native's renderer with
  AddressSanitizer, LeakSanitizer and UBSan; `ASAN_OPTIONS=detect_leaks=1 build-asan/harness_tests` fails on any of them (LeakSanitizer
  reports at exit). Without that build: `valgrind --leak-check=full --error-exitcode=9 build/harness_tests` (slower).
- **Memory kept but no longer needed** (the usual leak with smart pointers: a cache or a map that holds what unmounted views left):
  the test `MemoryStaysFlatAcrossMountSwitchUnmountCycles` mounts, prewarms, switches twice and unmounts 900 times and fails if the
  live heap grows by 64 KB over the last 300 cycles or the registry passes its purge threshold.
- **Data races** (the commit hook runs on the JS thread and, for iOS hookAsync, on a background thread): `-DHARNESS_TSAN=ON` in its
  own build directory, then `TSAN_OPTIONS=history_size=7 build-tsan/harness_tests`. The longer history matters: with the default,
  a race against an access made millions of accesses earlier in a long walk is not reported (checked: a non-atomic copy of the
  theme setTheme publishes is reported only with it).
- **The JSI glue and its per-runtime cache:** `GLUE_QUICK=1 valgrind --leak-check=full build/hermes_glue` (two runtimes created and
  destroyed).

The iOS and Android overlays (`ios/ShadewindNative.mm`, `ThemeTransitionOverlay.kt`) are not reached by any of these: check them on a
device (docs/THEME_TRANSITION_AGENT_REVIEW.md, "Memory on a device").

## Regenerating the resolver fixture

`fixtures/resolver/generate.mjs` compiles example-real's CSS with Uniwind's own bundler and records Uniwind's own results, so it
needs Uniwind, Tailwind, esbuild and Metro (the bundle's table goes through Uniwind's real Metro transformer and `withShadewind`) at
the versions the fixture was made with, in a directory of its own, and the package built (`bob build`: the Metro transformer loads
`lib/module`):

```sh
mkdir resolvergen && cd resolvergen && npm init -y
npm install --legacy-peer-deps uniwind@1.12.0 tailwindcss@4.3.3 esbuild@0.25.10 metro@0.84.6 metro-config@0.84.6 \
  metro-transform-worker@0.84.6 @react-native/metro-config@0.86.2 @react-native/metro-babel-transformer@0.86.2
node <repo>/cpp/harness/fixtures/resolver/generate.mjs <repo>     # writes table.json, cases.jsonl, summary.json
node <repo>/cpp/harness/fixtures/resolver/seam-check.mjs <repo>   # src/uniwind/nativeResolver.ts in front of the real store
```

## The Android build

`-DHARNESS_ANDROID_STATE=ON` builds React Native's renderer and the engine the way an Android app does: `RN_SERIALIZABLE_STATE`
and `ANDROID` defined, Android's platform code for colours (an int32), views and text (`ParagraphState` serialized to a
MapBuffer), fbjni's headers. Text layout stays generic (Android's measures in Java). On Android the mounting layer does not read
the typed props: `FabricMountingManager::getProps` sends each created or updated view, by default, the new props' `rawProps`
dynamic, which the Java view applies on top of what it holds. `App::check()` models exactly that (`sentToJava`, `mountOnAndroid`)
and requires the colour each Java view would hold to be the theme's. `HARNESS_ANDROID_PROPS=accumulated|reconciliation` runs the
same tests with React Native's two other props modes (the rawProps diff, the typed diff of View). Without the engine's
`rawProps` sync (`ThemeHook::applyRawFields`), 5 of the 12 engine tests fail in this build: that is the Android-only path, and it is
what this build checks. It is not an Android device: no Java, no JNI, no NDK toolchain.

## Layout tests and their mutants

`Layout.ThemeSwitchesLeaveTheLayoutOfPlainReactNative*` run the same React operations with no engine and with the current engine
and compare every node's `LayoutMetrics`: at point scale 1, at 2.625 and in RTL at 3 with `swapLeftAndRightInRTL`
(`Screen` in `FakeReact.hpp`). They exist for `keepYogaConfigured` in `ThemeHook.hpp`, which writes a private React Native flag;
re-run these mutants after any React Native upgrade or change there (edit, rebuild, run `--gtest_filter='Layout.*'`, restore):

| mutant in `keepYogaConfigured` | expected |
|---|---|
| copy the flag even when the source is not configured (drop `from.*configured`) | the 2.625 test fails (a new child keeps point scale 1) |
| copy it from an RTL-swapped source too (drop `!wasLeftAndRightSwapped`) | the RTL test fails |
| remove both calls | all tests pass; the benchmark's `next React commit` goes back from about 1.4 ms to about 4.5 ms |

## Reading the benchmark

- Only native work is measured. React's render, the adapter hooks and Uniwind's style resolution run in JS and are not here; the
  registration column stands in for the JSI calls (one per view at 44eb043, one per commit now).
- `none` is the floor. Compare arms within one run; absolute numbers depend on the machine.
- The 44eb043 arm gets slower the longer it runs (its registry and prewarmed props for unmounted views live until a purge every
  128 commits), so its mount numbers grow with `--runs`.

## React Native facts this relies on (0.86.2, checked in the sources)

- React's Fabric renderer hides a suspended subtree with `cloneHiddenInstance`: a clone of the top host nodes with
  `display: none` in the parent's child set; on reveal the child set holds React's original node again. On hide it also detaches
  the refs of every host component in the subtree (`recursivelyTraverseDisappearLayoutEffects` -> `safelyDetachRef`).
- `UIManagerBinding` binds every node it hands to JS to its JS wrapper (`valueFromShadowNode(..., true)`). A clone made by
  anything but React on the JS thread repoints that wrapper to the clone (`ShadowNode::transferRuntimeShadowNodeReference`; the
  thread flag is set by `ReactInstance` before it runs JS). So the hook's clones on the JS thread become React's handles; clones
  on another thread (iOS `hookAsync`) do not, until the next React commit themes those views again on the JS thread.
- `ShadowTree::tryCommit` stores the root the commit hooks return as the committed root, which is what lets the hook recognise
  the previous tree and skip subtrees React did not change.
- A clone with new props or children loses Yoga's "configured" flag, and the next layout clones it again when its new parent does
  not own it (`configureYogaTree` -> `cloneChildInPlace`). That was most of the extra cost of the first React commit after a
  switch (`next React commit` row); the hook now keeps the flag of a configured source on its clones (`keepYogaConfigured` in
  `ThemeHook.hpp`, guarded by the `Layout.*` tests below). Forcing layout in the switch commit would avoid it but costs far more
  with frozen tabs: Yoga's
  `zeroOutLayoutRecursively` clones every node of every `display: none` subtree on any root layout (that is also why an unrelated
  React commit costs about 8-11 ms with no engine at all in the tabs scenario).
