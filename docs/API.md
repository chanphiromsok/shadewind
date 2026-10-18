# Shadewind public API (1.0 design)

Status: core implemented on branch `feat/theme-engine-android-benchmark` (configure, setTheme, getTheme, subscribe, useTheme,
followSystem, capabilities, useThemed, ThemedView/ThemedText, mergeRefs, `shadewind/internal`). Not yet: `shadewind/uniwind`,
`shadewind/metro`, `whenApplied`. Reviewed by Opus on 2026-10-14. Contract: **a binding always renders correctly; the fast
path is an optimisation and never changes behaviour.**

## Facts in the code that shape it

- Theme slots go to the first 6 names seen (`ThemeHook::internTheme`), in first-seen order across `register` and `setTheme`.
  A typo like `setTheme('drak')` uses a slot; a 7th theme is dropped silently. Themes must be declared first, which needs a new
  native `configure` that interns names in declared order.
- Nothing happens before the first `setTheme` (`getTheme()` returns `''`), so `initialTheme` is required.
- `useThemedRef` returns only a ref; a view mounting after a switch shows React's style until the `flushPending` microtask.
  `useMemo(() => styles, [styles])` does nothing, so inline objects re-register every render.
- `opacity` is in the type but ignored natively. Drop it.
- `package.json` exports only `"."`.

## Surface

| Entry | Stable | Contents |
|---|---|---|
| `shadewind` | yes | `configure`, `setTheme`, `getTheme`, `subscribe`, `useTheme`, `followSystem`, `capabilities`, `useThemed`, `ThemedView`, `ThemedText`, `mergeRefs`, types, `ShadewindError` |
| `shadewind/uniwind` | yes | `installUniwind`, `View`, `Text`, `useShadewindStyle`, `ThemeStyleSource` |
| `shadewind/metro` | yes (CJS) | `withShadewind(config, { uniwind })` |
| `shadewind/diagnostics` | yes, development only | `enableDiagnostics({ reportMounts, reportUnmounts, reportUpdates })`, `disableDiagnostics`, `flushDiagnostics`; no-ops outside `__DEV__`, native recorder in Debug builds only (`cpp/Diagnostics.hpp`) |
| `shadewind/internal` | no semver | raw `register`/`unregister`, `setThemeWithStrategy`, `ThemeStrategy`, `ThemeTimings`, `inspect`, `prepare`, `resetMainBusy`, `mainBusyMs`, `refreshReactNodes`, `flushPending` |

Benchmark strategies (`stock`, `fastAsync`, `direct`, `both`) move to the example app or a build flag. No `strategy` parameter on
the public `setTheme`; the native side picks by capability.

## Theme model

`configure({ themes, initialTheme, onUnsupported })`, once, before first render.

- Throws `ShadewindError`: `TOO_MANY_THEMES`, `DUPLICATE_THEME`, `UNKNOWN_THEME` (also for `setTheme` with an undeclared name),
  `NOT_CONFIGURED`, `UNSUPPORTED_ARCH`. `initialTheme` must be in `themes`.
- Same list again: no-op. Different list in `__DEV__` (Fast Refresh): warn that a reload is required.
- Per binding (JS, in `useThemed`), all-or-nothing: any key outside `capabilities.supportedKeys`, any key a theme does not
  define, an undeclared theme, or an inline `style` overriding a registered key makes the view take the **fallback**
  (subscribes to the theme, re-renders through React, one `__DEV__` warning per call site).
- `onUnsupported: 'warn' | 'throw' | 'silent'`, default `'warn'`.
- Theme names typed by `interface Register { themes: 'light' | 'dark' }` augmentation, `string` otherwise.

## Binding

- `useThemed(styles) -> { ref, style, engine }`. `style` is the current theme's style so mount, switch and fallback render the
  right colour. `ref` registers on attach and unregisters on cleanup (React 19 callback ref cleanup).
- No stability rule for callers: registration keyed on a hash of the processed native values; inline objects are fine.
- `ThemedView` / `ThemedText` take `themed={...}`, merge before the user's `style`.
- `mergeRefs(a, b)` for composition. No state variants in 1.0 (use `style`, do not register those keys).

## Switching

- `setTheme(name): void`, queued, idempotent, last call wins. No mounted promise in 1.0 (Android has no background executor or
  mount hook yet; a future `whenApplied()` is a minor release). With the Uniwind adapter active it calls `Uniwind.setTheme` (one source
  of truth), whose listener applies the engine with `hookDeferred` and the call's transition; Uniwind's subscribers re-render.
- `subscribe` / `useTheme()` (`useSyncExternalStore`) for UI the engine does not update (status bar, navigation theme).
- `followSystem({ map })` on top of `Appearance`, returns unsubscribe; an explicit `setTheme` stops following.
- No persistence: the app passes the stored value as `initialTheme`.
- New views after a switch: correct via `style` plus the commit hook. Frozen screens: fixed by the hook on their next commit.

## Adapters

- `installUniwind()` probes store instance, version range, runtime-swap correctness (spike A); forwards
  `Uniwind.setTheme` to `setTheme`; returns `{ active, reason? }`. Outside the tested range it turns itself off.
- `ThemeStyleSource.resolveThemed({ className, props, state })` resolves all themes in one call and returns
  `{ kind: 'engine', current, perTheme, otherDependencies } | { kind: 'fallback', current, reason }`. (The old per-theme
  `resolve(..., theme)` assumed `scopedTheme`, which spike A showed is wrong.)
- `withShadewind` chains the existing resolver and matches by resolved file path.

## Versioning

`capabilities` is frozen: `{ version, maxThemes, supportedKeys, asyncCommit, textRecolor, platform }`. Adapters read it, never
hard-code. Experimental options use an `unstable_` prefix. Adding a key, raising `maxThemes`, adding a capability field: minor.
Removing a key, changing fallback meaning or a return type: major.

## Signatures

```ts
export interface Register {}
export type ThemeName = Register extends { themes: infer T extends string } ? T : string;
export type ThemedStyle = { backgroundColor?: ColorValue; borderColor?: ColorValue; color?: ColorValue };
export type ThemedStyles = Readonly<Record<ThemeName, ThemedStyle>>;
export type Capabilities = Readonly<{
  version: string; maxThemes: number;
  supportedKeys: readonly ('backgroundColor' | 'borderColor' | 'color')[];
  asyncCommit: boolean; textRecolor: boolean; platform: 'ios' | 'android';
}>;

export function configure(o: { themes: readonly ThemeName[]; initialTheme: ThemeName;
  onUnsupported?: 'warn' | 'throw' | 'silent' }): void;
export function setTheme(name: ThemeName): void;
export function getTheme(): ThemeName;
export function subscribe(l: (t: ThemeName) => void): () => void;
export function useTheme(): ThemeName;
export function followSystem(map?: { light: ThemeName; dark: ThemeName }): () => void;
export function useThemed<T extends object = ViewStyle>(s: ThemedStyles):
  { ref: RefCallback<unknown>; style: T; engine: boolean };
export function mergeRefs<T>(...r: (Ref<T> | undefined)[]): RefCallback<T>;
```

Plain RN:

```tsx
configure({ themes: ['light', 'dark'], initialTheme: 'light' });
const card = { light: { backgroundColor: '#fff' }, dark: { backgroundColor: '#111' } };
function Card() { const t = useThemed(card); return <View ref={t.ref} style={[s.card, t.style]} />; }
```

Uniwind:

```js
module.exports = withShadewind(withUniwindConfig(getDefaultConfig(__dirname), {}), { uniwind: true });
installUniwind(); // Uniwind.setTheme('dark') now goes through the engine
```

## Migration

| Current | 1.0 |
|---|---|
| `ShadewindEngine.register/unregister` | `useThemed` / `ThemedView`; raw form in `shadewind/internal` |
| `ShadewindEngine.setTheme(name, strategy)` returning timings | `setTheme(name): void`; strategy and timings in `internal` |
| `getTheme()` returning `''` | always a declared theme |
| `useThemedRef(styles)` | `useThemed(styles).ref` plus `.style` |
| `ThemedStyles` with `opacity` | three keys, typed names |
| `inspect`, `prepare`, `mainBusyMs`, `resetMainBusy` | `shadewind/internal` |
| no declaration | `configure({ themes, initialTheme })` (new native method) |
| `exports: { "." }` | `.`, `./uniwind`, `./metro`, `./internal` |

## Hard to change after 1.0

`Register` augmentation; `useThemed` returning `{ ref, style }`; the all-or-nothing fallback contract; `setTheme` returning
`void`; the `ThemeStyleSource` shape; theme order in `configure` mapping to native slots.

## Left out of 1.0

Mounted promise, strategy parameter, `opacity`, state variants, more than 6 themes, persistence helpers, scoped themes on the
fast path, components beyond `View`/`Text`.

## Risks and open questions

1. Rapid toggles on `hookAsync` unverified: blocks calling the async default production-ready; fall back to sync `hook` when
   `capabilities.asyncCommit` is false, consider defaulting to it everywhere.
2. `configure` and Fast Refresh with a changed theme list: native state lives for the process; re-interning could mismatch
   slots. Decide: reset-safe or reload required (design says reload required).
3. Every binding relies on private `getNodeFromInternalInstanceHandle`: needs a startup probe, fallback, upstream ask.
4. Mount cost of the Uniwind adapter, scrolling and FlatList recycling unmeasured.
5. Nested `Text` recolour where an inner explicit colour equals the old colour has no targeted test.
6. Android: `asyncCommit` false and no `viewOK`/`layerOK` probes; `capabilities` must be truthful.

## Implementation notes (core)

- Native `configure(names)` interns theme names in order and returns `{ maxThemes, ok }`; `capabilities.maxThemes` is 6 (JS const,
  kept equal to `ThemeHook::kMaxThemes`).
- `setTheme` validates names in JS (`UNKNOWN_THEME`), so a typo can no longer take a native slot.
- `capabilities` has no `version`/`textRecolor` yet.
- iOS Release check with the public API (Settings: Dark, Light, Rapid x7, back to frozen Home, Inspect): screen and cards dark,
  `treeOK 31/31 viewOK 31/31`. The saved rapid-toggle flow and Android are still open.

## Fresh-app install check (2026-10-14)

`npx @react-native-community/cli init FreshApp --version 0.86.3`, then `npm i shadewind-0.1.0.tgz react-native-nitro-modules`,
`pod install` (autolinked Shadewind and NitroModules), Release build for the iOS simulator: builds, `configure` + `useThemed` +
`ThemedView` + `ThemedText` + `useTheme` work, 5 taps 90 ms apart (dark, light, dark, light, dark) end fully dark with every
card `engine=true`. Notes: the generated `ios/.tool-versions` (ruby 3.2.0) must be removed or satisfied before `pod install`
with an asdf shim. Not covered: Android fresh app, Fast Refresh (needs a dev build), saved flows.
