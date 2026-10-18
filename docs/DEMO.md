# Run the 2003-view demo yourself

The benchmark in the [README](../README.md) uses an example published by the Uniwind team:
[`uni-stack/uniwind-benchmarks`](https://github.com/uni-stack/uniwind-benchmarks). One screen, 2003 views (a header card plus 1000
items). You can run the same test on your own machine and compare plain Uniwind with Uniwind plus shadewind.

Two scenarios in the same app, picked with a launch argument:

| Scenario | What it does | Launch argument |
|---|---|---|
| **Theme change** | mounts the list once, then switches light / dark 10 times; each change is timed until the JS thread is idle | `-benchmarkScenario theme` |
| **Rendering** | re-mounts the list 10 times; the average mount time is shown | none (the default) |

The app shows `Average`, `Min` and `Max` in milliseconds when it is done.

## 1. Get the example

```sh
git clone https://github.com/uni-stack/uniwind-benchmarks
cd uniwind-benchmarks
```

Install only the plain Uniwind app (the repository also has apps for other libraries that need their own setup):

```sh
# in the root package.json, set "workspaces" to ["apps/uniwind", "packages/*"], then
bun install
cd apps/uniwind/ios && pod install && cd ..
```

## 2. Measure plain Uniwind (the control)

```sh
bun run ios -- --mode Release
```

Use a **Release** build. Then terminate the app and launch it again from the simulator, with the theme scenario:

```sh
xcrun simctl launch booted org.reactjs.native.example.uniwind -benchmarkScenario theme
```

The first launch after an install is a cold launch: throw it away. Then terminate and relaunch **six** times, writing down the number
each time, and take the median of the six.

## 3. Add shadewind and measure again

shadewind is not on npm yet, so install it from a tarball built in this repository:

```sh
# in the shadewind repository
yarn prepare && npm pack          # writes shadewind-0.1.0.tgz
```

```sh
# in uniwind-benchmarks/apps/uniwind
npm install /path/to/shadewind-0.1.0.tgz react-native-nitro-modules@^0.37.1
cd ios && pod install && cd ..
```

Once shadewind is published, this step becomes `npm install shadewind react-native-nitro-modules@^0.37.1`.

Two small edits to the example, nothing else:

```diff
 // apps/uniwind/metro.config.js
 const { withUniwindConfig } = require('uniwind/metro')
+const { withShadewind } = require('shadewind/metro')
 ...
-module.exports = withUniwindConfig(mergedConfigs, { cssEntryFile: './global.css' })
+module.exports = withShadewind(withUniwindConfig(mergedConfigs, { cssEntryFile: './global.css' }))
```

```diff
 // apps/uniwind/index.js
 import { name as appName } from './app.json'
+import { installUniwind } from 'shadewind/uniwind'
+
+installUniwind()
```

Build in Release again and repeat the same launches (one cold launch discarded, six warm, median).

## 4. Check that you measured the right thing

- **The machine is comparable.** Plain Uniwind 1.12.0 should be near the numbers the example's authors publish for the same version
  (about 104 ms for the theme change, about 61 ms for rendering). If it is far off, something else is using the machine.
- **Same build, same device, same order.** Release builds, the same simulator, a quiet machine, control and shadewind measured back
  to back.
- **The engine is really active.** Check `installUniwind()` returns `{ active: true }`. In a Debug build, `shadewind/diagnostics`
  logs every view the engine binds (about 2000 for this screen).
- **The screen really switches.** Watch it, or record it: the colours should flip all the way, light to dark and back.

## What we measured

Our own run on one iOS simulator (iPhone 17 Pro, iOS 26.5, Release, React Native 0.86.3, median of six warm launches):

| | Plain Uniwind 1.12.0 | With shadewind |
|---|---|---|
| Theme change (JS thread idle) | 100.69 ms | **2.53 ms** |
| Rendering (2003 views mounted) | 61.86 ms | 62.03 ms |

Switching is much faster. Mounting is level with plain Uniwind: every view registers with the engine, which costs a little, and that
is offset by the adapter's lighter views. Full details and
caveats: [BENCHMARK.md](BENCHMARK.md).
