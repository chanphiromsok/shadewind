# Local testing (instructions for an agent on a Mac)

How to verify a change to the engine on a machine with Xcode and the iOS simulator. Work through the steps in order, stop at the
first failure and report it with the exact output. Record every number in `docs/BENCHMARK.md` with the date, the commit, the
simulator and how many launches it is based on.

Code under test: `main` (the `engine/freeze-and-mount` work, merged at `c2509f7`). Baseline for every A/B: commit `44eb043`, the
code before it (`git worktree add ../shadewind-baseline 44eb043`); "baseline" below means that checkout.

## 0. Prerequisites

- macOS with Xcode, an iPhone 17 Pro simulator (iOS 26.x), CocoaPods (`bundle install` in `example/` and `example-real/`)
- Node 22 (`.nvmrc`), Docker Desktop
- Yarn comes with the repository: run it as `node .yarn/releases/yarn-4.11.0.cjs` if `yarn` is not set up
- Quiet machine: close other simulators and builds. Whole launches drift by several ms; compare only interleaved runs.

## 1. Native harness (5 minutes, no simulator)

```sh
docker build -f cpp/harness/Dockerfile -t shadewind-harness .
docker run --rm shadewind-harness
```

Pass: `[  PASSED  ] 18 tests` four times: the generic build, then the Android build (React Native's renderer built as on Android,
checked against what Android's mounting layer would send each Java view) in each of its three props modes. The 18 are the engine,
`ClassMerge`, and `StyleResolver.MatchesUniwind` (the native class resolver against 137,790 results of Uniwind's own
`resolveStyles`, with the device's table and the one Metro prebuilds), and in the benchmark the `current` column has `0` stale views in a reveal
commit. Paste the two benchmark tables into the report. See `cpp/harness/README.md` for what they measure.

## 2. JS checks

```sh
node .yarn/releases/yarn-4.11.0.cjs install
node .yarn/releases/yarn-4.11.0.cjs tsc --noEmit 2>&1 | grep -E '^(src|example|example-real)/'
node .yarn/releases/yarn-4.11.0.cjs eslint src
node .yarn/releases/yarn-4.11.0.cjs prepare        # bob build + nitrogen
```

Pass: no type errors in `src/` (the example files have a few old ones: compare with the baseline), no new lint errors in `src/`, the build
succeeds.

## 3. Package the library for the apps

`example-real` installs Shadewind from `example-real/vendor/shadewind-0.1.0.tgz` and runs the compiled `lib/module`, not `src/`.
After every change to `cpp/` or `src/`:

```sh
node .yarn/releases/yarn-4.11.0.cjs prepare
npm pack --pack-destination example-real/vendor        # writes shadewind-0.1.0.tgz
cd example-real && rm -rf node_modules/shadewind && npm install && cd ios && bundle exec pod install && cd ../..
```

Check that `example-real/node_modules/shadewind/cpp/ThemeEngine.hpp`, `.../cpp/css/StyleResolver.hpp` and
`.../metro-babel-transformer.cjs` exist (they do not at the baseline): if not, the app still runs the old engine.

## 4. Freeze correctness on the simulator (the reason for this branch)

App: `example-real` (bottom tabs and a native stack, both `freezeOnBlur: true`), Release build:

```sh
cd example-real && npx react-native run-ios --mode Release --simulator "iPhone 17 Pro"
```

The yellow probe (top right) prints `inspect()` when tapped: `reg`, `inTree`, `hidden` (views in frozen screens, themed when they
show), `treeOK`, `viewOK` (UIKit), `STALE` (views whose committed colour is wrong).

Run each sequence twice, tap the probe after each step and write down the line:

Tabs: Explore, Moment, Range, Notification, Account; the Light / Dark buttons are on Account.

1. Explore -> Account -> Dark -> Explore. Pass: on Explore, `treeOK == inTree - hidden`, `STALE` empty, and no wrong colour visible
   during the tab transition (record the screen: `xcrun simctl io booted recordVideo out.mov`, step through the frames around the
   tap).
2. Account -> Light, Dark, Light (fast, under 150 ms apart) -> Explore. Same pass criteria.
3. Stack: Explore -> tap a post (PostDetail is pushed, the tabs freeze) -> back -> Account -> Theme sheet (a form sheet over the
   frozen tabs) -> Dark -> close the sheet -> Explore -> tap a post -> back. Same pass criteria on every screen you land on.
4. Hold a card (Pressable pressed) while switching the theme from a second finger on the Account tab, release. Pass: the pressed
   colour shows while held, the theme colour after release.

Then the baseline: repeat 1 and 2 and note whether a wrong colour is visible in the recording right after the reveal. That frame is what
this branch removes.

## 5. Theme switch and mount on `example-real` (A/B with the baseline)

Launch argument `-realBench 1` runs the benchmark by itself 15 s after launch and shows the result on top of the app
(mount of 30 feed cards in three variants: className, no Pressable, static host; then idle and stall of 12 switches):

```sh
xcrun simctl launch --terminate-running-process booted org.reactjs.native.example.RealWorld -realBench 1
```

5 launches per arm, arms interleaved (current, baseline, current, baseline, ...), reinstalling between arms (step 3 with the other checkout).
Report per launch: `className` / `static` mount means, `className - static` (the in-launch statistic `docs/ARCHITECTURE.md` 17b
uses), idle and stall medians. Pass: `className - static` not worse than the baseline beyond the launch-to-launch spread; stall and idle
not worse; `tree a/b` equal.

Note: in the current code the class resolver (step 6) is on in the `className` arm from launch (its table is built by Metro). To
see its share, run the current arm a second time with the launch argument `-resolverOff 1` added (same build), and report both.

## 6. Native class resolution on `example-real`

Same app and build as step 5 (engine arm). The class table is built by Metro while it bundles (`withShadewind`): watch the Metro
or Xcode build output for `[shadewind] class table not prebuilt`, which means it was not (the reason follows; the app then builds
it on the device). Quick check without a device, in `example-real`:

```sh
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/ios.js --assets-dest /tmp/assets
grep -c 'registerPrebuiltStyleTable(' /tmp/ios.js     # 1
```

Launch argument `-resolveBench 1` shows one line on top of the app 5 s after launch:

```sh
xcrun simctl launch --terminate-running-process booted org.reactjs.native.example.RealWorld -resolveBench 1
```

- `LAUNCH`: the table in use and where it came from (`prebuilt` = from the bundle), its size and native load ms, how many of
  Uniwind's `getStyles` cache misses since launch were resolved `native` / by `uniwind` (the first screen included), the first feed
  layout ms.
- `RESOLVE`: parity of the table in use (every class of the stylesheet and 400 random combinations, every theme, resting and
  pressed, against Uniwind's own `resolveStyles`), then of a table built on the device, the device build and load ms (median of
  5), per-resolution µs for Uniwind and native on the cases native answers.

a. 3 launches, report the line. Pass: `table prebuilt`, `getStyles misses native` well above 0 and above `uniwind`, `parity
   mismatches 0` (if not, the `FIRST` text names the className: send it, it is a bug), the native µs below Uniwind's.
b. Cold-launch A/B of the first screen, one build: 10 launches alternating `-resolveBench 1` and `-resolveBench 1 -resolverOff 1`
   (the second launches with Uniwind's own resolution only), killing the app between launches. Report every `first feed layout`
   with its arm. It is a whole-launch number that drifts by several ms: report the medians and the spread, and claim nothing
   unless the difference is larger than the spread.
c. Note the table's size (`KB`) and load ms: both are on the startup path now.

## 7. uniwind-benchmarks (render and theme, the published comparison)

```sh
git clone https://github.com/uni-stack/uniwind-benchmarks && cd uniwind-benchmarks && bun install
```

Engine arm = their `apps/uniwind` plus Shadewind, nothing else changed:

1. `apps/uniwind/package.json`: add `"shadewind": "file:<path>/shadewind-0.1.0.tgz"` and `"react-native-nitro-modules": "0.37.1"`.
2. `apps/uniwind/metro.config.js`: wrap the export: `withShadewind(withUniwindConfig(config, ...))` with
   `const { withShadewind } = require('shadewind/metro')`.
3. `apps/uniwind/index.js` (or `App.tsx` before the first render): `import { installUniwind } from 'shadewind/uniwind'` and call
   `installUniwind()` after `import './global.css'`.
4. `cd apps/uniwind/ios && pod install`, then build Release with their script: `scripts/bench/build.sh uniwind` (add a config
   `uniwind-shadewind` pointing at the modified app if you keep both).

Measure with their harness, plain `uniwind` and the engine arm in the same run:

```sh
scripts/bench/measure.py ios <udid> uniwind uniwind-shadewind                  # render scenario
scripts/bench/measure.py ios <udid> uniwind uniwind-shadewind --scenario theme # theme scenario
```

Mount cost, three arms (render scenario, median of 6 warm launches each, first cold launch discarded, same simulator and build
type): plain `uniwind`; the engine arm with `globalThis.__SHADEWIND_ENGINE_OFF__ = true;` as the first line of `index.js` (the
adapter's components with no engine); the engine arm as is. Arm 2 minus arm 1 is the adapter's own pipeline. Arm 3 minus arm 2 is
everything the engine adds: the plan lookup per view, React attaching a ref (and creating the public instance) per themed view, the
JS and native registration, and the native class resolver, which may make the first (cold) of the 10 renders faster rather than
slower. Arm 2 is for the render scenario only: with the engine off, views do not follow a theme switch.

Check every launch on screen (header, "x 10 runs" / "x 10 theme changes"): a fixed sleep has captured wrong screens before. Report
medians next to `uniwind` from the same run. For the theme scenario note that `hookAsync` leaves the JS thread at once (their
metric), so also run the engine arm with the synchronous strategy (`Shadewind.setTheme(name, 'hook')`, or the example's
`-strategy hook`) and report both.

## 8. Theme-switch benchmark in `example` (2003 views, every strategy)

```sh
cd example && npx react-native run-ios --mode Release --simulator "iPhone 17 Pro"
xcrun simctl launch --terminate-running-process booted uniwindshadow.example -benchmarkScenario theme -strategy hook
xcrun simctl launch --terminate-running-process booted uniwindshadow.example -benchmarkScenario theme -strategy hookAsync
```

3 warm launches per strategy (discard the first cold one). Report JS-idle median, `visualMs` (hookAsync), and the
`treeOK / viewOK / layerOK` line, which must be 2002 / 2002 / 2002.

## 9. Android (optional, emulator)

Nothing of this branch has run on Android yet: the harness's Android build (step 1) covers the renderer and the engine as Android
builds them, not the NDK compile, JNI or Java. First check that it builds and works:

1. `example-real` (engine arm): `npx react-native run-android --mode release`. Report any native build error in full (the library's
   C++ is compiled for Android here for the first time on this branch).
2. Freeze sequences 1 and 2 of step 4 on the emulator, with a screen recording (`adb shell screenrecord /sdcard/out.mp4`): no wrong
   colour after a reveal. The yellow probe works on Android too (no `viewOK` / UIKit column).
3. example-real's benches (`-realBench`, `-resolveBench`, `-resolverOff`) read launch arguments through React Native's
   `Settings`, which is iOS-only (on Android `Settings.get` warns and returns null): they do not run on Android, and the resolver
   cannot be switched off there without a code change. Note in the report that they were not run.
4. `example`: `adb shell am start -a android.intent.action.VIEW -d "uwbench://theme?strategy=hook"`. Android commits on the JS
   thread and prewarms on a background thread now (it was on the JS thread). Report with a same-run plain Uniwind number only; the
   emulator's absolute numbers are not comparable across sessions.

## 10. Register at switch (the `-registerAtSwitch 1` flag): all arms in one session

What it is: with `globalThis.__SHADEWIND_REGISTER_AT_SWITCH__ = true`, `View` and `Text` of the Uniwind adapter attach no ref at mount
(so React creates no public instance for them and nothing is registered with the engine). They put their per-theme styles on the host
element as `$sw`; the engine walks React's committed tree once, just before a theme switch, and registers what it finds. Design,
limits and what was and was not checked: `docs/ARCHITECTURE.md` section 22. `TouchableOpacity`, the Pressable and `withUniwind` still
register through a ref (section 22 says why), so the flag's saving is on `View` and `Text`.

Where the flag is set:
- `example-real`: the launch argument `-registerAtSwitch 1` (`src/boot.ts`, which `scripts/arm.sh engine` regenerates; it is read before
  `installUniwind()`). With no argument the app behaves exactly as before.
- The `uniwind-benchmarks` app (its render / mount scenario is where 61.86 / 56.25 / 62.03 ms came from; it has no launch-argument
  code): put `globalThis.__SHADEWIND_REGISTER_AT_SWITCH__ = true;` on the first line of its `index.js`, above the `installUniwind()`
  call, the way step 7 sets `__SHADEWIND_ENGINE_OFF__`. `installUniwind()` has to run while the bundle loads (not at the first render):
  it wraps the app root for the walk, and a root that is already running cannot be wrapped afterwards.
- `example-real`'s own `-theirBench theme` and `-realBench` do not measure a 2003-view mount, they are for the switch and for a smaller
  mount (473 views). The 2003-view mount number comes from the app whose scenario you used for the earlier 61.86 / 56.25 / 62.03 ms
  rows. Use the same app and protocol as those rows; say in the report which one it was.

Build once (step 3, `scripts/arm.sh engine`, Release, `SHADEWIND_DEV_TOOLS=1`), install once, and run every arm below from that one
install, interleaved, in one session on one simulator (iPhone 17 Pro, iOS 26.5, nothing else running). Terminate the app between launches.

### 10a. Correctness first (nothing is timed until these pass)

Each item with the flag on; do the same with the flag off when it says "compare".
1. Dev build, flag on, open the app and switch the theme once: the console shows no `[shadewind] register at switch: no app root is
   known` warning, no "could not start", and no red box or yellow warning about an unknown prop `$sw`. (Release builds are silent: the
   absence of a wrong colour is the check there. A dev build is not representative for performance or for how often views rebind: in
   development the plan cache is off, so every render makes new styles. Time Release builds only.)
2. After the switch `-theirBench theme` ends with `registered=2003 treeOK=2003 viewOK=2003 layerOK=2003`, as the flag-off arm. A lower
   `registered` means the walk missed views.
3. Before any switch the same inspect reports `registered=0` with the flag on: views are registered at the first switch. That is
   expected, not a failure. Do not use a before-the-first-switch `inspect()` to judge the flag.
4. Freeze sequences 1-3 of step 4 with the flag on: `STALE` empty, `treeOK == inTree`, no wrong colour in the reveal frames. Compare
   with the flag off.
5. A modal open during a switch (the Account theme sheet is one), two different tabs frozen then revealed, a screen pushed over the tabs:
   no stale colour after the reveal.
6. Sequence 4 of step 4 (hold a card while switching from a second finger), and a press on a `TouchableOpacity`, after a switch: the
   pressed style shows while held, the theme colour after release (both use the ref path with the flag on).
7. After a switch, change a mounted `View`'s `className`: (a) between two theme-dependent classes (selected / unselected); (b) from a
   theme-dependent class to one that is not (`bg-card` to `bg-red-500`) and back; also a `Text` whose `color` class changes the same
   way. The new class's colour is on screen each time, not the previous one, and (b) stays right after the next switch. This is the
   case the rebinding ref and the pinned styles exist for (docs/ARCHITECTURE.md section 22); compare with the flag off.
8. System appearance change (`xcrun simctl ui booted appearance dark`) with the flag on: follows, no stale view.

If any of 1-8 fails, stop and report it with the probe line; do not time a path that is wrong.

### 10b. Mount, five arms

1 cold launch (discarded) + 6 warm launches per arm, median of the six; arms interleaved (1, 2, 3, 4, 5, 1, 2, ...) so drift hits all.

| Arm | What |
|---|---|
| 1 | plain Uniwind (no shadewind in the bundle: `REAL_PLAIN=1`, `scripts/arm.sh plain`, or the app's unmodified build) |
| 2 | the adapter with the engine off (`__SHADEWIND_ENGINE_OFF__`, step 7) |
| 3 | the engine, flag off (the current default) |
| 4 | the engine, flag off, `-resolverOff 1` (Uniwind's own class resolution, no native class table) |
| 5 | the engine, flag on (`-registerAtSwitch 1`) |

Optional arm 6: flag on and `-resolverOff 1` together. Reading: 3 - 4 is the native class resolver's share of the mount time; 3 - 5 is
what register-at-switch saves; the earlier 62.03 - 56.25 = 5.8 ms is the budget it can take from, and arm 5 near arm 2 is the best case
the design allows (it does not reach Uniwind Pro's ~45 ms: the remaining gap is per-view component work).

Also run `-realBench 1` (step 5, 473 views, `className - static`) for arms 3 and 5 as a second, smaller mount signal, in the same
interleaved order.

Report per arm: the six warm numbers, the median, and the spread (max - min). Claim a difference only when it is larger than the spread
of the arms compared. Check every launch on screen (the header and "x 10 runs" text): a fixed sleep has captured a wrong screen before.

### 10c. Theme switch, flag off vs on

The filmstrip as in `docs/BENCHMARK.md` ("On screen, frame by frame"): `-theirBench theme`, a screen recording (`xcrun simctl io booted
recordVideo`), the gap from the first changed frame to the cells changing, for each of the 10 switches. 1 cold + 6 warm launches per arm,
arms interleaved, flag off and flag on. Plus the result line (`JS idle avg / median`) of each launch.

Report the FIRST switch of each recording separately from the other nine, in both arms. With the flag on, the first switch does work
the others do not: the walk, the registration of every view, and building the props of the other theme (today a background thread
prewarms them after mount; with the flag nothing is registered until the first switch). `-theirBench` makes an unmeasured switch to
light first, so its ten measured switches leave that cost out: the recording's first switch (the unmeasured one, if the video starts
before it) is where it shows. With the debug timings (`ShadewindEngine.setThemeTimed`, a dev-tools build) report `propsMs`, `reused`,
`cloneMs`, `totalMs` for the first switch and for a later one, flag on and off. Pass: later switches no slower with the flag than
without, beyond the spread.

### 10d. What to send back for this step

- 10a: pass or fail per item, with the probe line and a frame for any failure.
- 10b: the table (six numbers, median, spread per arm), which app and scenario, and the arm 3 - 4 and 3 - 5 differences next to the spread.
- 10c: first switch and later switches, both arms, and the timings of the first switch.
- anything that failed, with the full output. Say what was not run.

## What to send back

- the harness tables (step 1)
- the freeze sequences with the probe lines and whether a wrong colour was visible, current and baseline (step 4)
- per-launch numbers for steps 5-8, with the spread, current and baseline side by side (step 6 on the current code only)
- step 10 (register at switch), as listed in 10d
- anything that failed, with the full output

## Release builds carry no debug code

What exists only to inspect and measure the engine is compiled out of release builds (`SHADEWIND_DEV_TOOLS`, `cpp/DevTools.hpp`):
`inspect()`, the timings `setTheme` returns, the main-thread busy probe (`resetMainBusy` / `mainBusyMs`), the Paragraph clone
counters and the timers in the commit hook, and the extra main-thread hop that measured a `hookAsync` switch. Debug builds have them.
An app that measures in release (as `example-real` and `example` do) opts in with `SHADEWIND_DEV_TOOLS=1` in the environment of
`pod install` (iOS) and `shadewindDevTools=true` in `android/gradle.properties`. Without them those `shadewind/internal`
functions throw an error that says so, and `ShadewindEngine.setTheme` returns `undefined`.
