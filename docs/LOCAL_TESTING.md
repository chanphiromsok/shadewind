# Local testing (instructions for an agent on a Mac)

How to verify a change to the engine on a machine with Xcode and the iOS simulator. Work through the steps in order, stop at the
first failure and report it with the exact output. Record every number in `docs/BENCHMARK.md` with the date, the commit, the
simulator and how many launches it is based on.

Branch under test: `engine/freeze-and-mount`. Baseline for every A/B: `main` at `44eb043`.

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

Pass: `[  PASSED  ] 18 tests` (the engine, `ClassMerge`, and `StyleResolver.MatchesUniwind`: the native class resolver against
137,790 results of Uniwind's own `resolveStyles`, with the device's table and the one Metro prebuilds), and in the benchmark the `current` column has `0` stale views in a reveal
commit. Paste the two benchmark tables into the report. See `cpp/harness/README.md` for what they measure.

## 2. JS checks

```sh
node .yarn/releases/yarn-4.11.0.cjs install
node .yarn/releases/yarn-4.11.0.cjs tsc --noEmit 2>&1 | grep -E '^(src|example|example-real)/'
node .yarn/releases/yarn-4.11.0.cjs eslint src
node .yarn/releases/yarn-4.11.0.cjs prepare        # bob build + nitrogen
```

Pass: no type errors in `src/` (the example files have a few old ones: compare with `main`), no new lint errors in `src/`, the build
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
`.../metro-babel-transformer.cjs` exist (they do not on `main`): if not, the app still runs the old engine.

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

Then `main`: repeat 1 and 2 and note whether a wrong colour is visible in the recording right after the reveal. That frame is what
this branch removes.

## 5. Theme switch and mount on `example-real` (A/B with `main`)

Launch argument `-realBench 1` runs the benchmark by itself 15 s after launch and shows the result on top of the app
(mount of 30 feed cards in four variants, then idle and stall of 12 switches):

```sh
xcrun simctl launch --terminate-running-process booted org.reactjs.native.example.RealWorld -realBench 1
```

5 launches per arm, arms interleaved (branch, main, branch, main, ...), reinstalling between arms (step 3 with the other checkout).
Report per launch: `className` / `static` mount means, `className - static` (the in-launch statistic `docs/ARCHITECTURE.md` 17b
uses), idle and stall medians. Pass: `className - static` not worse than `main` beyond the launch-to-launch spread; stall and idle
not worse; `tree a/b` equal.

Note: on this branch the class resolver (step 6) is on in the `className` arm once its table is built (at the first idle,
long before the 15 s mark). To see its share, run the branch arm a second time with the resolver off: add
`nativeResolver.setEnabled(false)` (from `shadewind/uniwind`) after `installUniwind()` in `example-real/src/boot.ts`, repackage
(step 3), and report both.

## 6. Native class resolution on `example-real`

Same app and build as step 5 (engine arm). The class table is built by Metro while it bundles (`withShadewind`): watch the Metro
or Xcode build output for `[shadewind] class table not prebuilt`, which means it was not (the reason follows; the app then builds
it on the device).

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

`example`: `npx react-native run-android --mode release`, then `adb shell am start -a android.intent.action.VIEW -d
"uwbench://theme?strategy=hook"`. Android commits on the JS thread and prewarms on a background thread now (it was on the JS
thread). Report with a same-run plain Uniwind number only; the emulator's absolute numbers are not comparable across sessions.

## What to send back

- the harness tables (step 1)
- the freeze sequences with the probe lines and whether a wrong colour was visible, branch and `main` (step 4)
- per-launch numbers for steps 5-8, with the spread, branch and `main` side by side (step 6 on the branch only)
- anything that failed, with the full output
