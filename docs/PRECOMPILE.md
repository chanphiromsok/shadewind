# `precompileClassNames` (experimental, off by default)

An opt-in build step that makes mounting styled `View`s and `Text`s cheaper. Back to the [docs index](README.md); where it sits in the
system: [ARCHITECTURE.md](ARCHITECTURE.md). Numbers: [BENCHMARK.md](BENCHMARK.md).

## Why

With the adapter alone, every styled view runs a small set of hooks on every render (style plan lookup, a ref holder, context reads),
plus React Native's own `View` / `Text` wrapper work when the view needs it. For a screen of thousands of views that is most of the
mount cost the adapter adds over `StyleSheet`. Most `className`s are known when the app is built, so the build can remove that work
from the views where it is provably unnecessary.

## Turn it on

```js
// metro.config.js
module.exports = withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }), {
  precompileClassNames: true,
});
```

Restart Metro with a cleared cache (`--reset-cache`): the option is part of the transform cache key, but a stale bundle is the first
thing to rule out. It applies to your own files only (not `node_modules`, not shadewind), on iOS and Android, and while the engine is
inactive the compiled components use the adapter's own (which behave as plain Uniwind).

## What the build does

A Babel plugin (`metro-precompile-plugin.cjs`, added to the transformer by `metro-babel-transformer.cjs`) rewrites an element when it is
`View` or `Text` imported from `react-native` or `shadewind/uniwind`, carries a `className`, and has no `style`, `ref` or spread
attribute:

```tsx
import { View, Text } from 'react-native';

<View className="h-25 w-[32%] items-center rounded-2xl bg-primary">
  <Text className="text-2xl font-bold">{i}</Text>
</View>;

// becomes (the import and the two constants are added once per file)
import { precompiled as _sw } from 'shadewind/uniwind';
const _SwView = _sw.view('h-25 w-[32%] items-center rounded-2xl bg-primary');
const _SwText = _sw.text('text-2xl font-bold');

<_SwView>
  <_SwText>{i}</_SwText>
</_SwView>;
```

- A **literal** `className` (a string, or a template literal without expressions) gets one component per className and file.
- A **`className={expression}`** (`cn(...)`, a conditional, a variable) gets one component per kind and file; the className is read from
  the props of each render and resolved once per distinct string.
- `View` elements with props React Native's `View.js` rewrites (`aria-*`, `id`, `tabIndex`, `accessibilityState`,
  `accessibilityValue`) are left as written, as are `Text` elements with anything beyond `numberOfLines`, `testID` and `ellipsizeMode`.

The plugin decides from syntax only. It does not resolve a style at build time.

## What the runtime does (`src/uniwind/precompiled.tsx`)

The first time a compiled component renders with a className it resolves it with Uniwind's own store, once per theme, and asks the
adapter's own plan (`cachedPlan`) whether the engine can paint it. The result is one of:

| Mode | When | The view |
|---|---|---|
| static | the same style in every theme | host element with that style, no ref |
| engine | differs between themes in what the engine paints | host element with the current theme's style, bound to the engine through a shared ref |
| current | differs in something the engine cannot paint | host element with the current theme's style, stale after a switch (as the adapter's) |
| adapter | data attributes, breakpoints, orientation, insets, font scale, colour scheme, a style that needs `Text.js` (line clamp, `userSelect`, `verticalAlign`), a `Text` with non-primitive children, a view inside a `Text`, a scoped theme or scoped variables, the engine inactive | the adapter's own `View` / `Text` |

A value that toggles to nothing (`undefined`, `false`, `''`) keeps the same host element, so the subtree is not remounted.

A view whose `className` is an expression can be bound with one className's styles and need another's after a render. React detaches the
old ref before it builds the shadow tree of that commit, and the engine's commit hook would paint the old styles over the props React
just rendered, so such a view carries a small per-instance record (`useRef`, the one hook of that path): the render marks the newest
ref as current, and a ref that React detaches while it is no longer current drops the view's registration at that moment. A plain hide
or unmount keeps it. Views with a literal `className` never change className and have no such record.

## What differs from the adapter's components

- **`Uniwind.updateCSSVariables`** does not re-render mounted compiled views. Views rendered after the call get the new values; mounted
  ones keep the old until they re-render. (The adapter's views subscribe to variable changes.) Theme switches are not affected.
- **A className that toggles into an adapter case** (a breakpoint or data-attribute class) swaps the element type, which remounts the
  subtree, as the adapter's own `View` does when a prop makes `View.js` necessary.
- **Spread props are not compiled.** `<View className={...} {...props}>` is left as written, so wrapper components that forward
  `...props` get no benefit unless they stop spreading into the styled element.
- **`Pressable`, `TouchableOpacity` and `withUniwind` components are not compiled.**
- **Components whose leaf is not `View` / `Text` from `react-native`** (a custom `RCTView` wrapper, `withUniwind(...)`) are not
  compiled.

## Check that it applies

Bundle with the option on and off and count the call sites:

```sh
SHADEWIND_PRECOMPILE=1 npx react-native bundle --platform ios --dev false --minify false \
  --entry-file index.js --bundle-output /tmp/on.js --reset-cache
grep -c '\.precompiled\.\(view\|text\)(' /tmp/on.js   # 0 means nothing was rewritten
```

(`SHADEWIND_PRECOMPILE` is a variable your own `metro.config.js` reads, as `example-real` does; shadewind itself reads the option.)
In a development build with diagnostics on, `decisions` records the mode chosen for each className (`precompiled view: <className>`).

## Tests

`example-real/scripts/edge-cases.py` compares builds pixel by pixel on a screen of 28 cases (`-edgeCases 1`, `src/bench/EdgeCases.tsx`:
themed and static colours, classNames that change with state, a className that is `undefined` in some phases, a keyed list that
reorders, mount, hide and reveal, nested `Text`, scoped themes, breakpoints, `style` and spread props) while it steps through theme
switches and className changes. It runs plain Uniwind, the adapter and the precompiled build and compares every cell in every phase.
It found the className-change bug described above.

`node tools/precompile-check.cjs <app dir>` checks the plugin (what it rewrites and what it leaves alone, through Metro's transformer)
and the runtime (the mode per className, the engine registrations, element type stability, unbinding) against Uniwind's real store.

## Status

Measured on the iOS simulator only (Release); not on a device, Android or a Debug build. See [KNOWN_LIMITS.md](KNOWN_LIMITS.md).
