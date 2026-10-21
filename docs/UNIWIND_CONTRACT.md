# The Uniwind contract

shadewind is a layer on Uniwind, and Uniwind's internals are not an API. This file lists every private thing shadewind relies on, where, and what
happens when it changes. `tools/uniwind-contract-check.cjs` checks each item against Uniwind's real code, in Node, in seconds:

```sh
node tools/uniwind-contract-check.cjs [app dir]          # default example-real
node tools/uniwind-contract-check.cjs tools/contract-fixture   # see its README
```

CI (`.github/workflows/uniwind-contract.yml`) runs it on every change to the adapter, daily, and on demand, against `uniwind@~1.12`, `~1.13`
and `latest`. A red `latest` row is the early warning: nothing is released from it, but the item that moved is named.

## Items

| # | Item | Used by | If it changes |
|---|------|---------|---------------|
| 1 | `uniwind/src/{core/native,core/listener,core/context,common/consts,components/utils,components/native/useAccentColor,hoc/withUniwind.native}` exist; `shadewind/metro` maps `uniwind-internal/*` to them | `metro.cjs` (`PREFIX`), `uniwind-internal.d.ts` | the bundle fails to resolve |
| 2 | `components/native/{View,Text,Pressable,TouchableOpacity}.tsx` and `hoc/withUniwind.native.tsx` exist and export `View`, `Text`, `Pressable`, `TouchableOpacity`, `withUniwind` | `metro.cjs` (`REPLACED`) | the replacement silently stops applying: views are Uniwind's own, the engine sees no registered node |
| 3 | The CSS module is `const { Uniwind } = require('uniwind');Uniwind.__reinit(rt => …`, calling `__reinit(generate, themes[, fingerprint])` | `metro-babel-transformer.cjs` (`CSS_MODULE`), the prebuilt class table | no prebuilt table (reason logged); the runtime builds it on the device |
| 4 | `UniwindStore`: `vars` (object per theme), `runtime.currentThemeName`, `runtime.screen.width`, `stylesheet`, `cache` (a `Map` per theme), `resolveStyles`, `getStyles` on the prototype | `install.ts`, `styleCache.ts`, `nativeResolver.ts`, `useShadewindStyle.ts` | the bounded cache or the native resolver refuses with a reason and Uniwind's own runs |
| 5 | `getStyles(className, props, state, context)` returns `{ styles, dependencies: number[], dependencySum: number, hasDataAttributes? }` | everything | wrong or missing styles |
| 6 | `StyleDependency` is a numeric enum with `Theme`, `Variables`; each value is a bit (`< 31`) of `dependencySum` | `styleCache.ts` (`1 << dep`), `useShadewindStyle.ts` | stale styles after a theme switch: the worst failure, because it is silent |
| 7 | The cache key is `` `${className}${isDisabled}${isFocused}${isPressed}${scoped}${rtl}${variablesKey}` `` in `store.cache[scopedTheme ?? currentTheme]` | `styleCache.ts` | duplicates, never wrong styles (the key is only an identity) |
| 8 | An entry goes when a dependency of it notifies | `styleCache.ts` (one listener per dependency) | stale styles, or a leak |
| 9 | `UniwindListener.subscribe(fn, deps)` returns a dispose, `notify(deps)` calls `fn`, `getSnapshot(deps)` counts notifies | `install.ts`, `precompiled.tsx`, `useShadewindStyle.ts`, `nativeResolver.ts` | theme switches do not reach the engine |
| 10 | The compiled style format (1.12: `entries`, `minWidth`, `maxWidth`, `theme`, `active`, `focus`, `disabled`, `dataAttributes`, …; 1.13: `matches()`) | `styleTable.ts` | an unknown format is **refused with a reason** (`assertStyleFormat`); a known one must give a table with classes. Never an empty table |
| 11 | `install.ts` `TESTED` and the `uniwind` peer range | `install.ts`, `package.json` | outside the range the adapter turns itself off with a reason |

Anything not on this list is not relied on. A new use of a Uniwind internal adds a row here **and** a check there, in the same change.

## Reading a failure

The check names the item. Typical outcomes:

- **Items 1–3, 5–9 fail**: the Uniwind release is not supported. Keep it out of `TESTED` and the peer range; shadewind already turns itself off for it
  (`installUniwind()` returns `{ active: false, reason }`). Adapt the item, re-run, then widen the range.
- **Item 10 reports a refusal**: expected on 1.13 (the native class resolver is off there, the engine and precompile work). Not a failure.
- **All pass on `latest`**: the contract held; this proves the private surface, not behaviour. The behavioural proof is the device run
  (`example-real`, `docs/LOCAL_TESTING.md`) before a range is widened.

## What this does not cover

- Behaviour on a device (pixel parity, memory, theme-switch timing): `example-real` scripts.
- Public API changes (`Uniwind.setTheme`, `withUniwindConfig` options): Uniwind's changelog; the fixture app does not exercise Metro.
- Uniwind's CSS compiler output beyond the shape above (a new unit or function resolving differently): `ResolveBench` parity in `example-real`.
