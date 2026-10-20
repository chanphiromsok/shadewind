# Guide

Everything beyond the quick start in the [README](../README.md).

- [Plain React Native](#plain-react-native)
- [With Uniwind](#with-uniwind)
- [Animated switch](#animated-switch-optional-default-instant)
- [Diagnostics](#diagnostics-development-only)

## Plain React Native

```tsx
import { configure, setTheme, useThemed, ThemedView } from 'shadewind';

configure({ themes: ['light', 'dark'], initialTheme: 'light' });

const card = {
  light: { backgroundColor: '#fff', borderColor: '#e5e5e5' },
  dark: { backgroundColor: '#1c1c1e', borderColor: '#3a3a3c' },
};

function Card() {
  const themed = useThemed(card);

  return <View ref={themed.ref} style={[styles.card, themed.style]} />;
}

// or: <ThemedView themed={card} style={styles.card} />

setTheme('dark'); // no component re-renders
```

A view that uses anything the engine cannot handle (a key a theme does not define, an inline `style` that sets a registered
key, an undeclared theme) renders through React as usual and warns once in development. A binding always renders correctly.

## With Uniwind

```js
// metro.config.js
const { withUniwindConfig } = require('uniwind/metro');
const { withShadewind } = require('shadewind/metro');

module.exports = withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }));
```

Nothing in `node_modules` is patched and your `className` code does not change. Which of Uniwind's 22 components the engine takes over:

<details>
<summary>Components the engine takes over</summary>

| | Theme switch without re-render (engine) | Native class resolution |
|---|---|---|
| `View`, `Text`, `Pressable`, `TouchableOpacity` | yes, for `backgroundColor`, `borderColor`, `color` | yes |
| your own components wrapped with `withUniwind(Component)` (no options; `className` / `*ClassName` passed down as `style`) | yes, same properties | yes |
| the other 18 (`ScrollView`, `Image`, `ImageBackground`, `TextInput`, `FlatList`, `SectionList`, `VirtualizedList`, `SafeAreaView`, `KeyboardAvoidingView`, `Modal`, `Switch`, `ActivityIndicator`, `Button`, `RefreshControl`, `InputAccessoryView`, `TouchableHighlight`, `TouchableNativeFeedback`, `TouchableWithoutFeedback`), and `withUniwind` with options | no: Uniwind's own behaviour (they re-render on a theme change, as with plain Uniwind) | yes |

</details>

Inside the four components, views the engine cannot take (state variants such as `active:`, scoped themes, inline colour
overrides, themes that differ in other properties) are not registered: they re-render on a theme switch like plain Uniwind's. More than 6 themes, or an unsupported
Uniwind version, turns the engine off and leaves plain Uniwind.

Uniwind's class resolution (what runs when its style cache misses) also goes native, from a class table `withShadewind` builds
while Metro bundles (so from the first screen on; `withShadewind(config, { prebuildStyleTable: false })` builds it on the device
when idle instead): same results as Uniwind's JS (checked on 137,790 cases), and every className with a class the table cannot
hold (shadows, transforms, safe-area and screen units, data / rtl variants) is still resolved by Uniwind. `nativeResolver` from
`shadewind/uniwind` reports its status and turns it off (`setEnabled(false)`).

`withShadewind(config, { cacheColors: true })` (off by default) also puts a bounded cache (512 entries) in front of React Native's
colour parser, for apps that write colours as strings in `StyleSheet` styles: the same string is parsed once instead of for every view
of every render (about 19 ms of a 2003-view re-mount on the Android emulator). It changes no result, and it does nothing for views the
engine themes.

## Animated switch (optional, default instant)

`setTheme('dark', { transition: { type: 'fade', durationMs: 250 } })`, or once for everything (Uniwind too):
`setDefaultTransition({ type: 'fade', durationMs: 250 })`. `type: 'blur'` blurs the old screen for the first half of the time and
then fades it (Android below 12: plain fade). A snapshot of the window is laid over the app, the theme is
switched underneath, and the snapshot fades out once Fabric reports the new theme mounted. The overlay takes no touches. It is
skipped (instant switch) with reduce motion on, with the app in the background or without a window, and when the picture cannot
be taken. Android's snapshot does not include `SurfaceView` / `TextureView` content (maps, video). Without the option nothing runs.

## Diagnostics (development only)

```tsx
import { enableDiagnostics } from 'shadewind/diagnostics';

enableDiagnostics({ reportMounts: true, reportUnmounts: true, reportUpdates: true });
```

```
Shadewind (5): 🟢 ShadowNodeRegistered for tag 42 (View) and className: "flex-1 bg-card"
Shadewind (4): 🟡 ShadowNodeUnregistered for tag 42
Shadewind 🌳 Performed shadow tree update for 198 nodes (theme 'dark', 1.84 ms)
  🔥 C++ updates (198):
    View (42) { backgroundColor: "#1C1C1E" }
    Paragraph (43) { color: "#F2F2F7" } · text without layout
    // ... and 178 more nodes
```

The count in parentheses is the number of views bound to the engine. 🟡: a bound view was unmounted and released (reported at a
later commit, once React Native and the JS garbage collector let go of it); 🟠: a mounted view was unbound and left to React
(pressed, or its style no longer suits the engine). Screens that stay mounted (inactive tabs, frozen screens, suspended content) keep
their views, so leaving a tab does not lower the count. An update line notes `React replaced its props` when the hook re-themed a
view React re-rendered, and `text without layout` when a text colour changed without a layout pass.

Development only, on both sides: the functions do nothing outside `__DEV__`, and the native recorder is compiled into Debug builds
only (`SHADEWIND_DIAGNOSTICS`, set by the podspec for the Debug configuration and by `android/CMakeLists.txt` for CMake's Debug
build type, which is what a debug variant uses). An app configuration with another name (`Staging`, say) gets no recorder.
Compiled in but not enabled, it costs one atomic load per commit.

What is compiled out of release builds, and how to opt in, is described in [LOCAL_TESTING.md](LOCAL_TESTING.md#release-builds-carry-no-debug-code).
