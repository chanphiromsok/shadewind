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

`npm install` (not `npm ci`: the lockfile is older than npm 10's resolution of one transitive package). Check that
`node_modules/shadewind/metro-babel-transformer.cjs` exists: otherwise the app runs an old package.

## Arms

`scripts/arm.sh engine` (the committed state) or `scripts/arm.sh plain` writes `src/boot.ts`, `src/engineReport.ts`, `src/cn*.ts`
and `src/aotImpl.ts` for that arm. The plain arm also needs plain Metro: `REAL_PLAIN=1` when bundling or starting Metro.

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
| `-realBench 1` | 15 s after launch: mount of 30 feed cards in four variants, then idle and stall of 12 theme switches |
| `-resolveBench 1` | 5 s after launch: where the class table came from, `getStyles` misses resolved natively vs by Uniwind, first feed layout, parity and per-resolution timing of the native resolver against Uniwind's own |
| `-resolverOff 1` | Uniwind's own class resolution only (no table loaded or built), for A/B launches of one build |
| `-realDebug 1` | records why each className was or was not handed to the engine (Account > Engine report) |

```sh
xcrun simctl launch --terminate-running-process booted org.reactjs.native.example.RealWorld -resolveBench 1
```
