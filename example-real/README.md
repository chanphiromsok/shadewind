# example-real

A real-app-shaped test bed for Shadewind on top of free Uniwind 1.12.0: bottom tabs (Explore, Moment, Range, Notification, Account) and
a native stack, both with `freezeOnBlur`, a feed of cards, a theme sheet, light and dark themes defined in `global.css`. It is
what the freeze, mount and class-resolution checks in `docs/LOCAL_TESTING.md` (steps 3-6 and 9) run on.

## Setup

Shadewind comes from `vendor/shadewind-0.1.0.tgz` (the compiled package, not the repository's `src/`), wired in as a Uniwind app
would do it:

- `metro.config.js`: `withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }))`. `withShadewind` also builds the
  native class resolver's table while Metro bundles.
- `src/boot.ts`: `installUniwind()` from `shadewind/uniwind`.

After a change to the library (`cpp/` or `src/` at the repository root), rebuild and repack it, then reinstall:

```sh
cd ..                                                   # repository root
node .yarn/releases/yarn-4.11.0.cjs prepare             # bob build + nitrogen
npm pack --pack-destination example-real/vendor
cd example-real && rm -rf node_modules/shadewind && npm install && cd ios && bundle exec pod install && cd ..
```

The app measures in Release, so it keeps Shadewind's dev tools there (`inspect`, the switch timings): `ios/Podfile` sets
`SHADEWIND_DEV_TOOLS=1` for `pod install` and `android/gradle.properties` has `shadewindDevTools=true`. A release app does not.

`npm install` (not `npm ci`: the lockfile is older than npm 10's resolution of one transitive package). Check that
`node_modules/shadewind/metro-babel-transformer.cjs` exists: otherwise the app runs an old package.

`package-lock.json` pins the tarball's hash, so a new tarball fails `npm install` with `EINTEGRITY` until the lockfile entry of
`node_modules/shadewind` carries the new `integrity` (`openssl dgst -sha512 -binary vendor/shadewind-0.1.0.tgz | base64`). Commit
that one line, not the rest of npm's rewrite of the lockfile.

## Arms

`scripts/arm.sh engine` (the committed state) or `scripts/arm.sh plain` writes `src/boot.ts`, `src/engineReport.ts`, `src/cn*.ts`
and `src/transitionArm.ts` for that arm. The plain arm also needs plain Metro: `REAL_PLAIN=1` when bundling or starting Metro.

## Run

```sh
npx react-native run-ios --mode Release --simulator "iPhone 17 Pro"
npx react-native run-android --mode release
```

## On-screen tools

- The yellow probe (top right): tap it for `inspect()`: registered views, views in the tree, views in frozen screens, views whose
  committed colour matches the theme, stale ones.
- Launch arguments, iOS only (they are read through React Native's `Settings`, which Android does not have):

| Argument | What it does |
|---|---|
| `-realBench 1` | 15 s after launch: mount of 30 feed cards in three variants (className, no Pressable, static host), then idle and stall of 12 theme switches |
| `-resolveBench 1` | 5 s after launch: where the class table came from, `getStyles` misses resolved natively vs by Uniwind, first feed layout, parity and per-resolution timing of the native resolver against Uniwind's own |
| `-resolverOff 1` | Uniwind's own class resolution only (no table loaded or built), for A/B launches of one build |
| `-themeTransition 250` | theme switches animate over 250 ms, plus the test row on Account (see Theme transition below) |
| `-themeTransitionType blur` | with `-themeTransition`: blur instead of fade |
| `-realDebug 1` | records why each className was or was not handed to the engine (Account > Engine report) |
| `-theirBench theme` | instead of the app: the uniwind-benchmarks theme scenario with `className`s (2003 views, 10 `Uniwind.setTheme` changes, each timed until the JS thread is idle), result in `their-result` (`src/bench/TheirBench.tsx`) |
| `-uniwindStrategy hookAsync` | with `-theirBench`: the engine applies Uniwind's switches with `hookAsync` instead of `hookDeferred` (measuring only) |
| `-theirBenchReader 1` | with `-theirBench`: adds one `Text` coloured with `useCSSVariable`, a component React re-renders on a switch |
| `-theirBenchNoText 1` | with `-theirBench`: the cells without their number (1003 views), to see how much of the time to the screen is text redrawing |

```sh
xcrun simctl launch --terminate-running-process booted org.reactjs.native.example.RealWorld -resolveBench 1
```

## Theme transition

Off by default: switches are instant and the Account screen is exactly what the meters were measured on. Turn it on with

- iOS: launch arguments `-themeTransition 250` and, for blur, `-themeTransitionType blur` (default fade);
- Android (no launch arguments): `SHADEWIND_TRANSITION=blur:250 bash scripts/arm.sh engine` (or `fade:250`), then rebuild the bundle;
  `bash scripts/arm.sh engine` without it turns it off again.

That sets the default transition of the Uniwind adapter (every `Uniwind.setTheme` animates) and shows a "Theme transition (test)" row
on Account: `hookDeferred` (Uniwind's setTheme), `hookAsync` (the engine alone, commit off the JS thread; Uniwind is not told, the
next Uniwind switch puts them back in step) and `Toggle ×3` (three switches within 150 ms). What to record and measure:
`docs/THEME_TRANSITION_TESTS.md` and `docs/THEME_TRANSITION_AGENT_REVIEW.md` at the repository root.
