# Shadewind render pipeline: architecture and ERD (own Tailwind compiler)

Status: design, not implemented. Decision (2026-10-14): Shadewind no longer sits on top of Uniwind; it owns the style
pipeline. The Opus memo (docs/STRATEGY.md) advised against building a compiler; that evidence is kept here as *requirements*.

## 1. Requirements taken from the evidence

| Evidence (tovtam, iOS sim, Release, single runs) | Requirement |
|---|---|
| JS-value consumers (navigation theme, gradient `colors`, RichText `useUniwind`) dominate what is left after covering host views. Ablation (indicative, one run): median longest stall 60 ms -> 36 ms | every themed value needs a native route, not only `style` |
| 215 `className={...}`, 113 `cn(`, 28 `clsx`, 2 `twMerge` | dynamic class strings are the normal case: a pure, cached runtime resolver is mandatory |
| 21 `active:` classes | interaction state needs a design (open spike) |
| Stale frames returning to a frozen tab with plain Uniwind (~0.3 s), none with the engine | the commit hook stays the single place themes are applied |
| Uniwind private imports, Expo/Metro changes, React Compiler | no dependency on another library's internals |

## 2. Hard rules

1. **No React state or subscriptions on the theme-apply path.** `setTheme` never calls `setState` and never notifies a React
   listener to re-render styled views. *Scoped exception:* `useTheme()` / `subscribe()` (a `useSyncExternalStore` read) exist for
   UI the engine does not own (status bar, a text label showing the theme name). They are opt-in, never used by the compiler's
   output, and the old `useThemed` fallback subscription is **dropped**.
2. **Every themed value has a native route**: style keys (hook), non-style props (`useThemedProps`), paragraph colour (state
   rebuild). *Navigation chrome* is **not** claimed here: react-navigation's theme is a JS context object with no engine path.
   Mechanism: keep the theme object identity stable and theme chrome through bound host views and native tab/header props via
   `useThemedProps`; anything that cannot be done this way is out of scope until a spike says otherwise (spike 7).
3. **A view always renders correctly at mount** (its first render uses the current theme's resolved value). *After a later switch*
   an unbound view is **stale, with a dev warning**: there is no subscription to fix it (rule 1). The guarantee that this
   never happens in practice depends on spike 1 (every host view bindable); until it passes, binding is by ref and views that
   hide their ref (custom components that do not forward it) are the stale case.
4. **JS never sits on the switch path**: `setTheme` is a native call; React is not asked to render.
5. **Compatibility goal**: tovtam's existing `global.css` (`@variant light/dark`, `@theme`) and `className` strings compile
   unchanged. Migration = config swap, not a rewrite. (Conditional on the spikes in section 6.)

## 2b. Who merges (single source of truth)

- **Merging is JS**: `cn()` / `clsx` / `twMerge` / template strings are resolved by the runtime resolver in JS, with Tailwind
  conflict rules, producing one merged style + the themed props per theme.
- A **binding carries per-theme deltas** (today's `register` path: `{ theme -> props }`). The commit hook applies those.
- The **native `classId x slot` table is only an optimisation** and only exists if spike 1 (node tagging) passes: then a
  literal class id can be read natively without a JS merge. It never merges; dynamic strings always go through the JS resolver.
- Unknown pieces: a dynamic string built from known utilities (`cn('bg-card', cond && 'border-primary')`) resolves from the
  token table at runtime. Only a truly unknown utility falls back (unthemed style + dev warning).

## 3. ERD

```
 THEME (name PK, slot 0..N-1)
   | 1                                  PLATFORM (name PK)
   | has many                               | filters
   v *                                      v *
 TOKEN_VALUE (theme FK, token FK, value) <-- TOKEN (name PK, kind colour|number|string)
                                              ^ 1            ^ 1             ^ 1
                          references (colour) |   value is    |   token per   |
                                              |   token       |   theme       |
 UTILITY_CLASS (text PK) 1--* CLASS_DECL (property, value, modifier FK) *--0..1 MODIFIER
   | 1 compiles to 1                                  (theme|platform|pressed|focused|
   v                                                   disabled|breakpoint)
 COMPILED_STYLE (classId PK, baseStyle json, layoutPerTheme)        ^ when
   | 1--* THEMED_PROP (prop, token FK) ----------------> TOKEN        |
   | 1--* STATE_VARIANT (modifier FK, style json) ------------------'
   ^ * contains
   | 1
 STYLE_TABLE (buildId PK) 1--1 NATIVE_TABLE (buildId PK, colours: classId x slot)

 BINDING (id PK, mode tagged|ref)
   *--1 SHADOW_NODE_FAMILY (ptr PK)          "targets"
   *--* COMPILED_STYLE                        "applies"
   *--* THEMED_VALUE (prop, kind) *--1 TOKEN  "token per theme"
```

Reading: a **utility class** compiles to one **compiled style** (static base style + themed props that point at **tokens** +
state variants). Tokens have one value per **theme**. A **binding** ties a shadow-node family to compiled styles and to
**themed values** (non-style props). The native table holds `classId x slot -> value` so the commit hook never calls JS.

## 4. Pipeline

```
BUILD (Node, Metro transformer)
  global.css + @theme + @variant --\
                                    +--> Compiler --> JS StyleTable   (classId -> base, themed, states)
  source scan: className candidates /              \-> Native table    (classId x slot -> value)

TRANSFORM (Babel/Metro)
  className="bg-card p-4"  ---->  __sw(classId)

RUNTIME (JS thread)
  cn() / clsx / twMerge / templates
        |
        v
  Resolver (pure, cached, no subscription)
        |
        v
  classIds -> merged style + themed props
        |
        v
  render host view with current-theme values + bind (tag prop or ref)
        |                                  . unbindable view -> fallback
        v
NATIVE (C++)
  registry: family -> classIds + themed values
        |
  app: setTheme(name) -> slot
        |
        v
  UIManagerCommitHook: walk, clone, recolour paragraph
        |
        v
  mount (Yoga only if layout changed)

  JS StyleTable feeds the resolver; Native table feeds the registry.
```

| Stage | Input | Output | Owner / thread |
|---|---|---|---|
| Build: compile | global.css, candidates | JS StyleTable + native table | Node, build time |
| Transform | literal `className` | class id call | Babel/Metro, build time |
| Resolve | class string(s) | merged style + themed props | JS, render, pure function with a cache keyed by the string |
| Bind | host ref or tag prop | family -> ids in registry | JS render -> C++ registry (mutex) |
| Switch | `setTheme(name)` | slot id, epoch++ | JS call -> C++, returns immediately |
| Apply | commit | cloned nodes with theme values | C++ commit hook (JS thread sync, or background) |
| Interaction state | press/focus/disabled | state variant applied | open spike 3 |
| Fallback | truly unknown utility, or unbindable host | current-theme value at mount, stale after a switch, dev warning (rule 3) | JS |

## 5. Reuse and retire

- **Keep**: commit hook, paragraph recolour, Android `rawProps`, `configure`, per-theme slots, `useThemed`, `useThemedProps`,
  shared process-lifetime state.
- **New**: compiler (Tailwind v4 candidates + CSS theme blocks), StyleTable, runtime resolver, native table, node tagging
  (if spike 1 passes).
- **Uniwind seam** (`metro.cjs`, `src/uniwind`): **open question for the owner.** You said you no longer want to run on top of
  Uniwind. Default in this doc: retire it (delete) once the compiler can compile tovtam. The alternative is a deprecated bridge
  for one release. Not extended further either way.

## 6. Open decisions: each needs a spike with a pass criterion (not answered from memory)

| Spike | Question | Pass criterion |
|---|---|---|
| 1 Node tagging | does a `themeClassId` prop reach C++ props or does the view config drop it? | lands in C++ props -> no private `getNodeFromInternalInstanceHandle` binding; dropped -> keep ref binding |
| 2 Third-party props | does `cloneProps` on raw props repaint `expo-linear-gradient` `colors`? | colours repaint without a React render; `useThemedProps` depends on this and is untested |
| 3 Interaction state | `active:`/`focus:`/`disabled:` (21 `active:` in tovtam) without React state | a native route exists; else a documented scoped exception to rule 1 |
| 4 Per-theme layout | `dark:p-8` | supported (dirty Yoga in the hook) or explicitly out of scope; pick one |
| 5 Slot count | `kMaxThemes = 6` fixed array | slots sized at runtime from `configure` |
| 7 Navigation chrome | can react-navigation's theme be driven natively (stable theme object + bound chrome + `useThemedProps`)? | header and tab bar repaint on a switch with no `NavigationContainer` re-render, or documented out of scope |
| 6 Build pipeline | Tailwind v4 candidate extraction inside Metro/Expo + React Compiler + web | compiles tovtam's `global.css` and sources with no changes |

## 7. Housekeeping

- `useThemedProps` and `toNativePropsWith` are committed on this branch.
- The tovtam copy (`scratchpad/tovtam`) still has **ablation edits** in `useThemeConfig`, `useGradientColors` and `RichText`
  (originals in `/private/tmp/claude-501/*.orig.*`); it is **not a clean baseline**. Its numbers: plain 64.8 ms, engine 60.3 /
  59 ms, engine + ablation 36.1 ms median longest stall (single or two runs, indicative).

## 8. Build toolchain (validated by Opus, 2026-10-14)

Nothing in 2026 is meaningfully faster or better suited than Lightning CSS for "parse + typed values + Node visitor", and CSS
parsing is not the bottleneck (small `global.css`; the cost is candidate scanning).

Corrections to the first answer: Tailwind v4's `compile` does **not** use Lightning CSS (own JS parser and AST); only
`@tailwindcss/node`'s `optimize()` does, with LightDark excluded. Vite 8 (not Rolldown) uses Lightning CSS as its default
minifier. `oxc-css-parser` exists but has no Node binding or visitor API. Uniwind's own dependencies are
`@tailwindcss/node`, `@tailwindcss/oxide`, `lightningcss`, `culori`: a proven stack.

Pipeline:

1. `@tailwindcss/oxide` `new Scanner({ sources })`, `.scan()` (incremental `.scanFiles(changed)` in the Metro transformer).
2. `@tailwindcss/node` `compile(globalCss, { base, onDependency })`, then `.build(candidates)` for the raw CSS. Skip `optimize()`
   (it applies targets and rewrites the input).
3. `lightningcss.transform({ code, visitor, customAtRules: { variant: ... } })` with **no `targets`** (otherwise `light-dark()` is
   lowered to `--lightningcss-light/dark` variables). Walk `layer-block`, `style`, `custom` and `light-dark` nodes into the
   per-theme tables.
4. `culori` to normalise oklch and other colours into RN-ready values.
5. Cache by hash of `global.css` + Tailwind version + sorted candidates; invalidate through `onDependency`.

API surface verified in the 4.3.3 / 1.33.0 typings: `tailwindcss` `compile`/`compileAst`/`__unstable__loadDesignSystem`
(`candidatesToCss`, `candidatesToAst`); Lightning CSS `Declaration.custom`, `CssColor` `light-dark`, `Rule.custom`,
`Rule.unknown`, `customAtRules`, `composeVisitors`.

## 9. Pipeline v2 (updated 2026-10-14)

### Spike 6 result (build chain on tovtam, run once, cold, `spikes/compiler-spike`)

| Step | Result |
|---|---|
| Oxide `Scanner` over `src/**` | 13,437 candidates in 48.8 ms |
| `@tailwindcss/node` `compile(global.css)` + `build(candidates)` | 48.1 ms, 45 KB CSS, 246 custom properties, 557 rules |
| Lightning CSS visitor over that CSS | 5.6 ms to walk it and extract tokens |
| Per-theme tokens found | **superseded, see section 11**: the first extractor was wrong (light map held dark values) |
| Colour path | **superseded, see section 11**: with no `targets` Lightning CSS keeps `oklch`; `culori` converts every token |

Findings that change the design:

- The theme blocks come out as `:root:where(.light, .light *) { --color-...: ... }`. Extraction = match selectors of that shape
  and read the custom properties; the theme name is the class.
- `@variant light/dark` is **not** a Tailwind built-in: `global.css` gets it from `@import "uniwind"` (`uniwind.css` defines the
  `@custom-variant`s and `@utility`s such as `m-safe`). Our compiler therefore ships its own small preset CSS (theme variants,
  platform variants `ios`/`android`/`native`, safe-area utilities) so `global.css` keeps working with `@import "shadewind"`
  instead of `@import "uniwind"` (the one-line config swap).
- `--color-*: unset` placeholders appear from `@theme`; they are defaults, not values.
- Whole build about 100 ms cold for a 13k-candidate app; not a bottleneck, caching by content hash is enough.

### Updated stage list

| # | Stage | Input -> output | Owner | Change from v1 |
|---|---|---|---|---|
| 1 | Scan | sources -> candidates | Rust (oxide) via Node | unchanged, measured |
| 2 | Compile | `global.css` + preset + candidates -> CSS | `@tailwindcss/node` | new preset replaces `@import "uniwind"` |
| 3 | Lower | CSS -> theme token maps + class declarations | Lightning CSS visitor (no `targets`) | measured 5.6 ms |
| 4 | Colour | oklch/color-mix -> ARGB `uint32` | Lightning CSS first, `culori` for what it does not lower | unchanged |
| 5 | Emit | -> **binary** native table (`classId x slot`, `uint32` ARGB, token dictionary) + small JS module (classIds, base styles) | Node | **new: no JSON/strings parsed at runtime** |
| 6 | Load | binary table -> native memory | C++ at startup (mmap/memcpy) | **new** |
| 7 | Bind | JS passes packed ids (ints / `Int32Array`), not objects | JSI | **new: no per-view `folly::dynamic` conversion** |
| 8 | Index | `family -> binding` | C++ flat SIMD index (`cpp/experiments/FamilyIndex.hpp`) | **new**, 2-4x per lookup on big trees |
| 9 | Walk | commit -> changed subtrees only (pointer diff vs previous root, skip non-React/non-self commit sources) | C++ hook | **new** (RENDER_CORE.md rank 2) |
| 10 | Apply | slot -> cloned props; iOS option: custom-trait dynamic colours (no commit) | C++ / UIKit | iOS spike 3 |

### Pipeline (v2)

```
BUILD (Node, Rust libs)
  sources -> oxide Scanner --\
  global.css + preset ------> tailwindcss compile().build()
                                   -> lightningcss visitor (no targets)
                                   -> culori for leftovers
                                   -> emit
                                        |-> binary table: classId x slot -> ARGB
                                        '-> JS module: classIds, base styles

RUNTIME
  JS module -> resolver cn/clsx/twMerge (pure, cached) -> packed ids -> bind(ref) --\
  binary table --(mmap)--> C++ registry (SIMD family index) <-----------------------'
  setTheme --> commit hook (pointer-diff walk) <-- registry
        -> clone + paragraph recolour -> mount
  setTheme -.iOS only.-> window.traitOverrides: dynamic UIColor
```

### Not in this pipeline (decided)

- A Rust runtime core (no Nitro Rust target, FFI per node, <= 5 % of a ~3 ms commit).
- Anything that parses JSON or colour strings on the JS thread at runtime.

## 10. AOT resolver (design, 2026-10-14)

Goal: the runtime resolver does table lookups on integers, never parses class strings, never runs tailwind-merge.

### What tovtam actually contains (1,769 `className=` sites, counted by a script over `src/`)

| Form | Sites | Share | AOT treatment |
|---|---|---|---|
| `className="a b c"` literal | 1,554 | 87.8 % | compile-time class id, hoisted constant |
| `className={"a b"}` | 76 | 4.3 % | same |
| `` className={`a b`} `` (no `${}`) | 1 | 0.1 % | same |
| `cn("a", "b")` all literals | 4 | 0.2 % | same, merged at build |
| `cn("a", cond && "b", className)` | 79 | 4.5 % | segment ids + variant table / id merge |
| `cn("a", className)` (identifier) | 28 | 1.6 % | id + runtime id merge |
| identifier / prop | 12 | 0.7 % | runtime id-or-string path |
| ternary | 10 | 0.6 % | two precompiled ids, select at runtime |
| template with `${}` | 5 | 0.3 % | runtime path |

Fully static: **92.4 %**. Dynamic forms (about 7.6 %) are mostly literal segments plus one or two runtime inputs.

### Transform (Babel plugin / Metro transformer, runs before React Compiler)

```tsx
// in
<View className={cn("flex-row p-4", active && "bg-card", className)} />
// out (class table values are build-time facts)
const _a = __sw.s(12);            // "flex-row p-4"        -> hoisted frozen style + themed refs
const _b = __sw.s(31);            // "bg-card"
<View {...__sw.cn(_a, active ? _b : 0, className)} />   // className is a string or an id; ids are ints
```

1. **Literals** -> `__sw.s(id)`; the id indexes the generated table (base RN style, themed props as token refs, state variants).
2. **Known conflicts resolved at build**: for segments that are all literals the `twMerge` result is computed at build time.
   Between a literal and a runtime value, each class id carries a *property-group bitset* (which RN style props it sets), so
   the runtime merge is "last wins per group" over a small int array, not string parsing.
3. **Bounded variant tables**: for `cn("a", c1 && "b", c2 && "c")` with at most 3 independent boolean inputs, emit the
   `2^n` merged ids as a switch: zero runtime merge.
4. **Interning**: merged results are memoised by the id tuple and frozen, so React sees stable prop identity.
5. **Boundary**: a literal passed down as a `className` prop travels as a branded id (number); `cn` and the host-component
   adapter accept id or string. A string reaching the runtime is looked up in a prebuilt `Map<string, id>` (O(1)); only an
   unknown string is parsed (dev warning, unthemed fallback).
6. **Dev**: Fast Refresh keeps working because the table module is regenerated and the plugin only emits ids and a `__sw`
   import; in dev the string path is allowed everywhere.

### Why this is the right place to spend effort

- It removes per-render string work and allocation on the JS thread (what Uniwind's `useStyle` does per component today).
- It makes the binding payload a few ints, which is what the native table and the SIMD index want (section 9, stages 5-8).
- Risk: React Compiler ordering, third-party components that stringify `className`, and `twMerge` edge cases (arbitrary values,
  important modifiers). Spike 8 below proves it on tovtam's 1,769 sites.

### Spike 8: AOT transform on tovtam

Pass when: the plugin rewrites at least 90 % of `className` sites to ids (target 92.4 %), the app renders pixel-identical on
the screens already recorded, and the runtime resolver's per-render cost is under a measured threshold (single-digit
microseconds per component in a Release build) versus plain Uniwind's `useStyle`.


## 11. Parser pipeline review (Opus, 2026-10-14): corrections

The review re-ran the chain against `out.css` (1,951 lines; Tailwind 4.3.3; lightningcss 1.30.2). Verdict: **go on the chain
(oxide -> `@tailwindcss/node` -> lightningcss, no targets -> culori); no-go on the first `extract.mjs`; section 9's token and
colour claims were wrong and are superseded.**

| Sev | Defect | Fix |
|---|---|---|
| Critical | the "light" map held dark values: the regex took the first class name in the selector JSON, and the `@media (prefers-color-scheme: dark) :root:not(:where(.light...))` block names `light` first. 18 of 27 tokens were visibly wrong in light mode; "27 per theme" hid it | classify selectors on the AST; treat `:not(:where...)` blocks as *system twins* and assert they equal the explicit theme |
| Critical | section 9 said Lightning CSS lowers oklch to rgb: with no targets it stays `oklch`; the rgb sample was the dark brand (written as `rgb()` in `global.css`) leaking in; "culori agrees" converted a hard-coded literal | culori converts every token |
| High | ARGB packing had no clamp (out-of-gamut yellow packed to `ffffffb2`, correct `ffffd700`) and alpha was hard-coded | clamp each channel, pack real alpha |
| High | colour parity undefined: lightningcss lowering vs Uniwind (culori clamp + `formatHex`) max channel delta 3 (yellow); Uniwind's `colorMix` ignores `in oklab` (alpha-only for transparent mixes, sRGB interpolation otherwise) | match Uniwind, write the policy down, pixel-test |
| High | opacity variants carry broken fallbacks (`color-mix(in srgb, unset N%, transparent)`, `--tw-shadow-color: unset`); only the nested `@supports` branch is correct | walk `@supports` and nested rules, later declaration wins, fold per theme |
| Medium | non-colour and base tokens dropped (`:root, :host` has 58 custom properties: 37 non-colour, 20 `unset` placeholders) | base map that each theme overlays |
| Medium | partial themes (an `ocean` block with 1 token leaves 26 missing; CSS cascade falls through to the system twin) | require full themes or a declared base scheme; warn on missing tokens |
| Medium | scanner ignores `@source`; `onDependency` is a no-op, so imported-CSS edits never invalidate | scan `[...compiler.sources, {base: dirname(css)}]` like Uniwind; cache key = all dependency hashes + versions |
| Medium | scan scope: `src/**` 589 files / 13,437 candidates; project root 23,639 files / 259k candidates / 7.35 s because untracked `ddrel/` (Xcode DerivedData) is not ignored | scan root plus `@source`, ignore build dirs, warn on large counts |
| Low | lightningcss versions disagree (1.30.2 top, 1.30.1 inside Uniwind) and the folded AST value of `color-mix(in oklab, ...)` differs from lowering and culori | pin one version; do not trust folded AST colour values |

Facts to design against (verified in the review): all token blocks have equal specificity (0,1,0); the cascade key is
(layer rank, source order), not visitor order alone; token blocks are emitted after utilities but live in `@layer theme`;
with no `targets`, `light-dark()` stays `light-dark` in custom properties and declarations, and `@theme inline` puts it directly
into utilities (so utilities need the same resolver); `env()`, `max()`, `hairlineWidth()`, `@media ios/android` and `@container`
pass through raw and need runtime handling; Tailwind >= 4.3.3 flattens selectors to `[class, where(...)]`.

Three riskiest unknowns remaining: (1) matching Uniwind's colours exactly (clamp vs gamut mapping, sRGB vs oklab mixing, alpha
folding) without a pixel test; (2) themes beyond light/dark (partial themes, which scheme `light-dark` uses for `ocean`,
system-follow done at runtime instead of through CSS twins); (3) values that cannot be precomputed and Tailwind-output drift
across versions, plus cache invalidation.

Reviewed extractor output on tovtam: light `primary` `ff1a1a1a`, dark `ffe0e0e0`, yellow `ffffd700`, 28 colour tokens per theme,
37 non-colour base tokens, system twins equal to their themes, no issues.

## 12. Parser work moved to C++ (2026-10-14)

`cpp/css/ColorParser.hpp` parses CSS colours natively (`#rgb[a]`, `#rrggbb[aa]`, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`,
`transparent`, `white`, `black`; comma and `space / alpha` syntaxes; percentages). `HybridShadewind::registerNode` converts
colour strings (keys named `color`, `*Color`, `colors`) to unsigned ARGB before building typed deltas, so JS no longer calls
`processColor` for those values; unsupported values (named colours, `PlatformColor`, `DynamicColorIOS`) still use `processColor`.

Parity (`cpp/tests`, 3,209 generated cases vs `culori`, same clamp policy): 3,205 exact, 4 within one channel step, 0 worse,
0 parse failures (out-of-gamut `oklch` included). Example app, Release, iOS simulator, `hook`, 2003 views: median 2.38 ms,
treeOK / viewOK / layerOK 2002 / 2002 / 2002.

Stays out of C++ (decided): Tailwind compile and the Lightning CSS walk (JS/Rust at build time). Candidates next: binary token
table loader, `var()` / `light-dark()` resolver for runtime variable updates, `color-mix` folding.

## 13. `cn` measured: tailwind-merge vs cnfast vs C++ (2026-10-14)

Corpus: 5,603 cases built from tovtam's real class strings (840 distinct literals, 103 real `cn(` calls with literals, plus
random pairs and triples). Reference = `twMerge(clsx(parts))` (clsx 2.1.1, tailwind-merge 3.7.0). Output checked for byte
equality on every case.

| Implementation | Node/V8 (macOS arm64) | Hermes, Release, iOS simulator | Output vs reference |
|---|---|---|---|
| `clsx + twMerge` | ~2,900 ns | **18,286 ns** | reference |
| `cnfast` 0.2.0 (pure JS rewrite) | ~650-800 ns | **2,038 ns** | 0 mismatches / 5,603 |
| native C++ via JSI (`mergeClasses`) | - | **998 ns** | **0 mismatches, 0 fallbacks** |
| JSI call floor (1 short string, trivial merge) | - | 586 ns | - |
| standalone C++, strings in/out | 371 ns | - | 0 mismatches |
| standalone C++, pre-parsed ids | 57 ns | - | 0 mismatches |

Reading:

- On Hermes the reference is 18 us per call; `cnfast` is about 9x faster; native C++ is about 18x faster than the reference and
  about 2x faster than `cnfast`. cnfast's "25x" claim did not reproduce on this corpus (3.6-4.3x on V8, 9x on Hermes).
- The JSI crossing is 586 ns of the 998 ns: the merge itself is about 400 ns. Anything per-call over JSI is bounded below by
  about 0.6 us; the way past that is to not call at all (AOT: ids resolved at build time, section 10) or to batch many merges
  into one call.
- The C++ merge is equivalent to the reference *by construction*: the conflict table (`tools/cn-table`) is generated with
  tailwind-merge as the oracle (354 known tokens, 65 groups on this corpus) and an unknown token returns `undefined`, so the
  caller falls back to the JS reference.
- Not covered: tokens outside the corpus (arbitrary values `w-[10px]`, `[&>*]:...`, postfix `text-lg/7`) fall back by design; the
  table must be generated from the full candidate set of the app at build time (13k candidates in tovtam), which is also what
  makes it usable; device numbers will be slower than the simulator's; one machine, best of 3 passes.

### 13b. Exposed in the package, and what made it faster (Hermes, Release, iOS simulator, byte-equality checked)

Public API: `configureCn({ table, fallback })` and `cn(...inputs)` in `shadewind`; table generator `npx shadewind-cn-table <srcDir>`
(tailwind-merge is a peer dependency of the tool only). `cn` has clsx semantics (strings, numbers, arrays, objects), uses the native
merge for every token in the table and `fallback` (normally `(...a) => twMerge(clsx(a))`) otherwise.

| Variant | ns/call | vs previous step | Mismatches |
|---|---|---|---|
| `clsx + twMerge` | ~18,000 | - | reference |
| `cnfast` | ~2,030 | 9x faster | 0 |
| native via Nitro raw method, `utf8()` copies | 998 | - | 0 |
| native via Nitro raw method, zero-copy `getStringData` (+ same JS string returned when unchanged) | 920-934 | -6 % | 0 |
| native via plain global host function `__swCn` (no Nitro wrapper) | 699-721 | -23 % | 0 |
| native + native result cache | 841 | **slower**: hashing/joining costs more than merging; removed | 0 |
| public `cn(...)` (first version: rest array + flatten) | 961 | - | 0 |
| public `cn(...)` (allocation-free path for <= 4 string/falsy args) | **867** | -10 % | 0 |
| floor: global host function, one short string | 328-339 | - | - |
| floor: Nitro method, one short string | 507-523 | - | - |

So: about 21x faster than the reference and about 2.3x faster than `cnfast` on Hermes. Of the 867 ns, about 335 ns is the JSI
crossing and about 365 ns is the merge itself (token parse plus lookups plus output string); the rest is the JS wrapper.

CLI-generated table from the whole tovtam `src/` (6,178 candidate tokens: 377 Tailwind tokens in 73 groups, 5,736 non-Tailwind
tokens): same 5,603-case equivalence test, 0 mismatches, 0 fallbacks.

What would make it faster still, in order of expected value (none measured yet):

1. **Do not call.** AOT (section 10): static `className` sites become ids at build time (92.4 % of tovtam's sites); the standalone
   id merge is 57 ns, with no crossing.
2. **Batch.** One JSI call for all merges of a render pass removes the 335 ns crossing per merge.
3. **Cheaper merge core**: precomputed per-string token lists (a table keyed by the interned class string) instead of parsing on
   every call; SIMD or a perfect hash for the token lookup.
4. **JS-side memo for repeated inputs** (React re-renders pass identical strings): a `Map` hit in Hermes is likely cheaper than a
   crossing; to be measured against the crossing floor, not assumed.

## 14. Pipeline v3 (2026-10-14): what is shipped vs planned

```
BUILD (Node, Rust libs)                          [planned unless marked]
  sources -> oxide Scanner -> tailwind compile -> lightningcss visitor -> emit
     |                                                                     |
     |-- shadewind-cn-table [shipped] --> cn table (.tsv)                  v
     '-- className -> ids (AOT) [design]                     binary class table
                                                                           .
JS THREAD                                                                  .
  cn(...) [shipped] --- __swCn, ~870 ns ---+                               .
  useThemed / bind(ref) ---+               |                               .
  setTheme(name) ----+     |               |                               .
                     |     |               |                               .
NATIVE (C++, Nitro raw JSI) [shipped]      v                               .
  ClassMerge <----------------- cn table (oracle-derived)                  .
  ColorParser (CSS colour -> ARGB) <--- bind                               .
  registry: family -> per-theme slots <..... planned load ..................'
        |                          
        v                          
  UIManagerCommitHook <---- setTheme
        |
        v
  clone nodes + paragraph recolour (no layout) -> mount
```

| Stage | State |
|---|---|
| Commit hook, per-theme slots, text recolour without layout | shipped (iOS + Android) |
| Native CSS colour parser (3,209-case parity vs culori) | shipped, iOS verified |
| Native `cn` merge, byte-equal to `twMerge(clsx())` on 5,603 cases; public `cn` / `configureCn` | shipped, iOS Release verified |
| `shadewind-cn-table` CLI | shipped |
| Own Tailwind compile to binary table | build chain measured, compiler not built |
| AOT `className` -> ids (removes the JSI crossing for static sites) | design |
| SIMD family index, pointer-diff walk, batched merges | experiment / unmeasured |

Open: Android build of ColorParser, ClassMerge and `__swCn` has not been run; the Uniwind bridge is still shipped and its
retirement is undecided.

## 15. Render path vs theme-switch path, measured on Uniwind's own benchmark app (2026-10-15)

Their app (`apps/uniwind`, `App.tsx` and `useBenchmark` untouched), Release, iPhone 17 Pro simulator, 2003 views, average of 10 per
launch. Engine arm = their app plus `withShadewind` and `installUniwind()`.

| Scenario | Plain Uniwind | Engine arm (before `b16ac9f`) |
|---|---|---|
| Render (re-mount 2003 views) | ~63 ms (62.9, 63.2, 62.6) | 74.4 ms (one valid launch) |
| Theme switch | ~110 ms warm (109.9, 110.1, 103.0) | not yet measured on this app |

Finding: the engine is slower than plain on mount (about +11 ms, +18 %, single launch). A theme switch is where it wins; the
cost is paid at mount. This is the context their chart measures twice (render and theme), and our earlier numbers covered only
the switch.

Cause (read from the code, not yet profiled): `useShadewindStyle` built a full plan per mounted view (resolve per theme, compare
as JSON) and `register` converted the same per-theme styles to native props per view, about 2,003 times for a few classNames.
Change `b16ac9f`: the plan is cached on the object Uniwind's store returns for a repeated className (`WeakMap`), and the native
conversion is cached per styles object. Not yet measured; the next suspect, if render stays above plain, is the native
`scheduleFlush` after mount (a commit that is pointless at mount because React's style already carries the current theme).

Method notes: the engine arm must be checked to contain the commit under test (compare packed `lib/` with the repo) and each launch
must be validated on screen (header and the "x 10 runs" / "x 10 theme changes" label); scripted fixed sleeps captured mid-run and
wrong-app screens. Plain and engine blocks should be interleaved (the machine drifted 3.2 -> 4.5 ms within hours).

### 15b. Render path, engine arm, step by step (Uniwind's own app, Release, iPhone 17 Pro simulator, average of 10 re-mounts of 2003 views)

Single valid launch per row, validated on screen; plain Uniwind was 60.6 ms (and 62.6-63.2 ms earlier the same day).

| Engine arm change | Render avg | vs plain (60.6) |
|---|---|---|
| bridge as it was | 74.4 / 72.05 ms | +11.5 to +13.8 |
| JS plan cache (`b16ac9f`) | 72.05 ms | +11.5 |
| + native style-id cache (`9cd1160`) | 70.31 ms | +9.7 |
| + mark as applied when rendered with the current theme (`42b95cb`) | 68.22 ms | +7.6 |

Each step helped a little; the engine is still above plain Uniwind on mount. Argent native profiler (xctrace attached after launch)
caught the main thread only: 91 ms of `-[RCTViewComponentView unmountChildComponentView:index:]` and 19 ms of
`mountChildComponentView` over the 10 re-mounts (common to both arms), and only 21 ms of JS-thread samples with no Hermes symbols,
so it does not yet say where the remaining ~7.6 ms of JS-thread work is. A profile needs the app to start the scenario after
the profiler is attached (gate the mount), or in-app counters around `register`.

## 16. `example-real`: a tovtam-like app, plain Uniwind vs the engine (2026-10-15)

`example-real/` is a bare RN 0.86.3 app on Uniwind 1.12 with `className` everywhere: root native stack (tabs, pushed detail and
profile screens, a full-screen modal, a form sheet), five lazily-not-lazy tabs, a 120-card feed (about 30 styled views per card,
`Pressable` with `active:` states), a `NavigationContainer` theme derived from `useUniwind` / `useCSSVariable` (a React consumer of the
theme, as in tovtam). Mock data only. Same code for both arms: `scripts/build.sh engine|plain`.

Stall benchmark (Account > Run switch benchmark, or `-realBench 1`; 12 switches 300 ms apart, longest JS-thread gap in the 350 ms
after each; median of the 11 warm switches; Release, iPhone 17 Pro simulator, 3 launches per arm, interleaved):

| Arm | Launch medians (ms) | Median | Worst single stall |
|---|---|---|---|
| Plain Uniwind | 154.6, 127.1, 119.7 | **127.1** | 166.7 |
| Engine (bound views, state variants resting-bound) | 35.4, 37.8, 36.7 | **36.7** | 46.4 |

Correctness checked on screen: after Dark, the hidden Explore tab, its cards, chips and FAB are dark when revealed.

What the first runs taught (kept because they were wrong in instructive ways):

- The first engine reading (16.8 ms) was invalid: `installUniwind()` ran before `global.css` filled Uniwind's store, got "store is
  empty", and cached the failure, so the engine was off and unbound screens (no subscription, rule 1) stayed light. Fixed in the
  library: an empty store is "not yet" and is retried.
- With the engine on, 10 of 63 distinct classNames fell back as "state variants" (every `Pressable` with `active:`), which would be
  stale after a switch. Now the resting state is bound and a `Pressable` unbinds on `onPressIn` and rebinds on `onPressOut`
  (native calls only).
- Remaining 36.7 ms is React work the engine does not remove (the navigation theme, `useUniwind` consumers), not the colour pass.

## 17. Initial render on `example-real`: what moved and what did not (2026-10-15)

Metric: mount 30 feed cards (about 30 styled views each), 10 times in one launch, mean of the last 9 (`-realBench 1`, Release,
iPhone 17 Pro simulator, 3 interleaved launches per arm). Plain Uniwind is the reference.

| Engine arm | Mount mean (ms) | vs plain (60.2-60.7) |
|---|---|---|
| ref machinery + register per view (11 hooks) | 64.3 | +3.6 |
| 4 hooks per view, unbound views get no ref | 62.3 | **+2.1** |

What the experiments ruled out (all measured, same app):

- Registration is not the cost: an arm that attached the refs but never called the engine was as slow as the full engine.
- Refs are not the cost either: the `nativeID` carrier (no ref, no per-view call, the commit hook finds the view) came out slower
  (148-173 ms first feed layout vs plain 140-146) and is reverted. Cause found by reading RN: any non-empty `nativeId` makes a
  view form a stacking context (`ViewShadowNode.cpp:53`), which changes flattening; do not use `nativeID`/`testID` as a carrier.
- The remaining cost is per-view adapter JS (Uniwind's `useStyle` is 3 hooks; ours were 11, now 4).

Switch on the same app (engine vs plain): `setTheme` sync 0.3 ms vs 9.6-10.4 ms; microtask free at 0.4 ms vs 9.4-10.5 ms;
call to JS idle about 25-27 ms vs 112-116 ms (the engine's wait is the native commit and mount, not JS).

Opus research on the RN render pipeline (RN 0.86.2 sources): per styled View/Text the JS thread pays three fibers, style
flatten/attribute payload, colour `process`, `createNode` raw-props preparse (about 150 ViewProps fields read per view), then
Yoga; the main thread pays create/recycle/mount per native view. A library cannot remove the native view count or the C++ props
parse. What can make mount faster than plain is removing the adapter fiber and per-render work: an AOT transform that turns a
literal `className` into a frozen style object and renders the host component directly with no hooks (estimated 3-5 ms of the
60 ms for 30 cards), plus colours as RRGGBBAA numbers. Not yet built. Caveat from the same review: the mount metric re-mounts the
same cards, so recycled views and the text-measure cache flatter the main thread; a cold first launch costs more on both arms.

### 17b. Host-direct View/Text for plain cases (2026-10-15)

`View` and `Text` render React Native's native components (`ViewNativeComponent`, `TextNativeComponent`) directly when React
Native's own wrapper would do nothing: no accessibility/aria/id/tabIndex rewrites for `View`; a primitive-children, plain-props
`Text` with no nested-text ancestor. Anything else still goes through `RNView`/`RNText`. Guarded in `src/uniwind/native.ts`.

Measured with three arms interleaved, 5 launches each (iPhone 17 Pro simulator, release build). The statistic is
`className - static host` inside one launch, because whole launches drift by a few ms (one earlier launch ran 57.8 ms with a
37 ms control) and the control cancels that.

| arm | MOUNT 30 cards, ms (5 launches) | mean | className - static host | first feed layout (mean) |
| --- | --- | --- | --- | --- |
| engine before (87af955) | 63.7, 66.4, 67.4, 65.8, 66.9 | 66.0 | 22.7 | 146.8 |
| engine + host-direct | 62.7, 64.9, 65.2, 63.7, 65.7 | 64.4 | 21.2 | 145.6 |
| plain Uniwind | 64.4, 64.7, 65.9, 65.1, 66.6 | 65.3 | 21.4 | 144.8 |

- The change is worth about 1.5 ms, and it was lower than the old engine in 5 of 5 launches.
- Against plain the engine is now level: -0.9 ms raw mean, -0.2 ms normalized, lower in 4 of 5 launches. That is a tie, not a win.
- Theme switch is unchanged: 0.25-0.47 ms sync, stall median 26-28 ms vs 117-148 ms for plain.
- The static-host control (41.6-45.3 ms) bounds what is left: about 21 ms per 30 cards is per-view adapter JS. Only an AOT
  transform (literal `className` to frozen style object, host component, no hooks) can remove it.

Opus review of the C++ side (RN 0.86.2): a library has no lever to make `createNode` props parsing cheaper (it runs before any
commit hook and payload objects are fresh per node); the app-level flag `enableCppPropsIteratorSetter` would, for both arms. A
pass-through `MountingOverrideDelegate` probe is the way to split the ~43 ms into createNode / commit+layout / diff / mount.

### 17c. AOT arm measured: no gain (2026-10-15)

`-realBench 1`, one launch, Release, iPhone 17 Pro simulator, 40 mounts of 30 feed cards with the variants interleaved, mean of the last
9 per variant: `className` 47.8 ms, `aot` 47.1 ms, no `Pressable` 47.4 ms, static host 34.4 ms. AOT is 0.7 ms (1.5 %) faster than
`className`, inside the noise of a single launch; the 13 ms down to the static-host floor is not removed by it. Do not advertise `aot` or
`LightPressable` as performance features. Not measured: several launches, a device, the JS-thread-only time.

### 17d. Where the remaining mount time is, and the lighter Pressable (2026-10-15)

Timers inside the adapter (a measurement build, not shipped), 30 cards, `className` path, app state before `freezeOnBlur`: React
render+commit 41.9 ms against 17.9 ms for the static host, from two launches; the mount that follows (main thread to `onLayout`) read
the same for both, about 23 ms. So the gap is JS. The adapter bodies sum to 9.7-10.4 ms over 632 calls (View 5.3, Text 5.1) and ref
callbacks to 1.0 ms over 361. Inside `useShadewindStyle`: install 0.4, hooks 1.2, `getStyles` 1.0, flatten 0.2, plan 0.4, layout effect
0.5 ms. These figures include the timers' own cost (about 14 `performance.now()` calls per adapter), which was not isolated.
The remaining roughly 13 ms is React work for the extra fibers and larger host props, not attributed.

Measured, not a lever: an ahead-of-time arm resolved once per literal (`aot`), about 1 ms under a control with the same restructured
feed (see 17c). A lighter `Pressable` on `Pressability` (`LightPressable`): 4.3 ms under `className`, while the control arm with the
plain Pressable in that slot read 2.8 ms under `className` as well, so the effect is about 1.5 ms over 3 launches whose spread was 3 ms.
Not advertised, not exported.

Confounded: the variants run in the same order every cycle, so the no-`Pressable` arm (third) and the static arm (fourth) carry a slot
effect of unknown size. The gap between `className` and no-`Pressable` read 9.5 ms in one run and 3.2 ms in another, so "the 60
Pressables are worth 7-9 ms" is not established. Settling it needs the variant order rotated per cycle (each variant in each slot equally
often, first cycle dropped), 5 or more launches. Not done.

The theme-switch figures depend on the app state: before `freezeOnBlur` plain reached JS idle in 112-116 ms; with the freeze it reads
about 49 ms, and the engine 0.39 ms (sync 0.33), which relies on frozen hidden tabs still theming correctly.
Run-to-run noise is the limit of this method: whole launches differ by up to 5 ms, so a result under about 3 ms needs 5 or more
launches and the in-launch `className - static host` statistic.

### 17e. Rotated-order run: Pressable is a lever, and the engine is slightly behind plain (2026-10-15)

The bench harness now rotates the variant order every cycle (48 mounts, each variant in each slot equally often, first mount of each
dropped). 5 launches per arm, engine and plain interleaved, Release, iPhone 17 Pro simulator, app with `freezeOnBlur`. Per launch,
in ms (className / no Pressable / static host), then the in-launch differences:

| launch | engine | cls - static | nopress - static | plain | cls - static | nopress - static |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 63.5 / 57.0 / 45.2 | 18.3 | 11.8 | 61.6 / 53.1 / 43.9 | 17.7 | 9.2 |
| 2 | 63.1 / 54.7 / 47.1 | 16.0 | 7.6 | 64.9 / 57.4 / 45.1 | 19.8 | 12.3 |
| 3 | 65.2 / 58.0 / 43.9 | 21.3 | 14.1 | 56.7 / 53.1 / 43.9 | 12.8 | 9.2 |
| 4 | 62.5 / 56.7 / 45.0 | 17.5 | 11.7 | 44.2 / 42.2 / 33.4 | 10.8 | 8.8 |
| 5 | 47.8 / 43.5 / 31.9 | 15.9 | 11.6 | 47.3 / 44.3 / 31.9 | 15.4 | 12.4 |
| mean | | 17.8 | 11.4 | | 15.3 | 10.4 |

- Pressable, with the slot effect removed: `className - no Pressable` is 6.4 ms on the engine arm and 4.9 ms on plain, for the 60
  Pressables of 30 cards (80-105 us each). It is a real lever of about 5-6 ms, and our Pressable wrapper costs about 1.5 ms more than
  Uniwind's. The earlier "LightPressable: about 1.5 ms" prototype took roughly that wrapper overhead and no more.
- Initial load against plain: `className - static host` is 17.8 ms for the engine and 15.3 ms for plain, so the engine is about
  2.5 ms behind in this run (17.8 against 21.2-21.4 for both in the earlier 5-launch run). The spread is wide (plain 10.8-19.8), whole
  launches ranged from 44 to 65 ms, so the honest reading is: level with plain to about 2 ms behind, not faster.
- Both arms moved a lot between launches (launch 4 and 5 ran 15-20 ms faster for the whole process), which is why only in-launch
  differences are used.

## 18. Bindings that survive a freeze, proven subtrees, native harness (2026-10-17)

Measured in `cpp/harness` (React Native 0.86.2's C++ renderer on Linux, the engine's commit hook in real `ShadowTree` commits, a
stand-in for React's Fabric renderer; Docker, one machine, each arm in its own process, medians of 15). Native work only: React's
render and the adapter hooks are not in these numbers. Reproduce with `docker run --rm shadewind-harness` (`cpp/harness/README.md`).

What changed and why:

- **Freeze.** React detaches the refs of a subtree it hides (Suspense / Activity, so `freezeOnBlur`) and the refs unregistered the
  views. The reveal commit then held the old theme and a second commit, after the refs re-attached, fixed it: a possible stale
  frame (harness: 800 stale views in the reveal commit of a 400-card tab at 44eb043). Now a detach keeps the binding (an unmount
  frees it with the shadow node family; a view unbinds only when its styles stop being themeable or a Pressable is pressed), a
  re-attach with the same styles costs nothing, and the hook themes the revealed subtree inside the reveal commit: 0 stale views,
  no extra commit. A switch skips `display: none` subtrees; they are themed when they show.
- **Proven subtrees.** The committed root is the object the hook returned (`ShadowTree::tryCommit`). The hook remembers which
  roots it produced for which theme epoch and registration generation; a subtree of the new tree that is the very node of such a
  root needs nothing and is skipped. An unrelated React commit on the 2003-view screen: 0.26 ms against 0.22 ms with no engine
  (44eb043: 2.9 ms).
- **React's handles.** Clones made off the JS thread (iOS `hookAsync`) do not repoint React's node handles, so the first React
  commit after such a switch themes the views again (7.9 ms on 2003 views, 44eb043 9.3 ms); clones on the JS thread do repoint
  them (`transferRuntimeShadowNodeReference`), so the second commit is cheap again (0.7 ms; 44eb043 1.5 ms).
- **Registration.** One `registerMany` call per commit instead of one JSI call per view; a style table shared by every view of a
  style; a smaller entry in a folly F14 map; prewarm incremental and off the JS thread on Android too; expired views and styles are
  purged as the maps grow. Mount of the 2003-view screen, native part: 21.1 ms against 15.0 ms with no engine (44eb043: 70.7 ms in
  the same run, which grows with every re-mount because its registry and prewarmed props of unmounted views live until a purge
  every 128 commits).
- **Unchanged:** the switch itself (clone every themed view): about 4.6 ms for 2003 views in both engines.

Tried and dropped:

- Forcing layout in the switch commit, so Yoga configures the clones and the next React commit does not clone them again: the next
  commit went from 1.9 to 0.5 ms, but with frozen tabs every switch paid Yoga's `zeroOutLayoutRecursively` over the hidden
  subtrees (2.8 -> 10.7 ms).
- Skipping subtrees newer than the last registration by tag: React creates parents after their children, so a new container's
  tag is above the tags of the views registered inside it; it skipped whole screens (caught by the harness tests).

Not measured yet: the JS side of mount on a device (fewer JSI calls should show in `className - static`), and Android.
`docs/LOCAL_TESTING.md` lists the device runs.

## 19. Uniwind's class resolution in C++ (2026-10-17)

Uniwind caches the result of a className per state and theme (`UniwindStore.getStyles`); on a miss, `resolveStyles` splits the
className, walks the styles of every class, keeps the winning style per property and calls every winning value's getter (a JS
function of the theme's CSS variables). Misses happen on the first render of a className, a new pressed / focused state, a new
theme, a new screen width, and in Shadewind's adapter once per theme for every themed className (it needs every theme's props
for the engine). That is what now runs natively when it can.

- **Table** (`src/uniwind/styleTable.ts`): every value of the stylesheet evaluated for every theme, at bundle time (see "Built by
  Metro" below) or on the device when the JS thread is first idle. Each evaluation records every variable it reads (a Proxy over the variables) and every read of the
  runtime's changing fields (screen, insets, font scale, orientation, rtl, colour scheme: accessors installed on Uniwind's runtime
  object for the build and removed after). Inline variables a class sets (`--tw-leading`, `--uniwind-em`, ...) are definitions: a
  value that reads one is evaluated once per definition and once with none, and the resolver picks the definition that wins in
  the className. A class falls back (stays with Uniwind's JS) when a value reads a changing runtime field or `currentColor`, reads
  more than one inline variable, or needs Uniwind's post-processing (shadows, transforms, gradients, text shadow, font variant),
  or when a style has data / rtl / orientation conditions. Width, theme and pressed / focused / disabled stay conditions.
- **Resolver** (`cpp/css/StyleResolver.hpp`): Uniwind's split (`' '`, or `/\s+/` with a newline), conditions, precedence
  (minWidth, complexity, important), inline-variable winners, key order (first set) and the post-processing table values need
  (lineHeight under 6 times fontSize, `visibility: hidden` -> `display: none`, default border and outline colour). A className
  with a fallback class, non-ASCII text, or an Object.prototype name returns undefined.
- **Seam** (`src/uniwind/nativeResolver.ts`): an own `resolveStyles` on the store instance in front of Uniwind's (kept and called
  for everything else). Native only with no scoped theme, no scoped variables, a table built from the stylesheet and variables the
  store holds now; `Variables` (updateCSSVariables) marks it stale until an idle rebuild. `nativeResolver.setEnabled(false)` turns
  it off. The JSI entry is the global host function `__swResolve` (the `__swCn` pattern: no Nitro method wrapper).

Verified:

- `cpp/harness/fixtures/resolver`: the table and Uniwind's own `resolveStyles` results come from Uniwind 1.12's bundler and store
  in Node (example-real's CSS plus a third theme and the variants the app does not use: responsive, theme, state, important,
  relative line heights, em letter spacing, pixel ratio / hairline values, fallback classes). 1531 classNames (app literals, every
  ordered pair of classes that set the same property, random combinations) x 3 themes x 5 widths (the breakpoints exactly and
  below) x 6 states: 137,790 cases, 114,930 resolved natively, all equal in keys, order, values, dependencies and sum; the rest
  fall back exactly where a class is not in the table. 25 hand-made mutants of the resolver (precedence, conditions, order,
  post-processing) all fail it.
- `seam-check.mjs`: the seam in front of the real store, with a stand-in native function (20 checks; removing a guard fails it).
- On a device: `-resolveBench 1` in example-real compares both on every case (parity count) and times them
  (`docs/LOCAL_TESTING.md` step 6). No device numbers yet.

Built by Metro (so the first screen is covered): `withShadewind` wraps the project's Babel transformer with
`metro-babel-transformer.cjs`. Uniwind's Metro transformer turns the CSS entry into a module
(`Uniwind.__reinit(rt => <stylesheet>, <themes>, <fingerprint>)`) and hands it to Babel; on iOS and Android, ours evaluates that
stylesheet in Node the way Uniwind's store does on the device (Uniwind's own runtime helpers, the platform's variables, each
theme's on a clone), builds the table with the same `styleTable.ts` (from `lib/module`), treating `pixelRatio` and
`hairlineWidth` as unknown, and appends one guarded statement: `try { require('shadewind/uniwind').registerPrebuiltStyleTable(json,
meta) } catch (e) {}`. It runs right after Uniwind loaded the stylesheet; install loads the table natively (a parse, no JS
evaluation) if the store still holds that stylesheet, those variables and that variables revision, on that platform (not TV) and
Uniwind version. Classes that read the pixel ratio or hairline width fall back in it; if there are any, the device rebuilds the
table when idle and adds them. Another Uniwind version, a stylesheet that reads the runtime while it is created, or any error:
the module is left unchanged and the device builds the table as before. `withShadewind(config, { prebuildStyleTable: false })`
turns it off.

- `generate.mjs` builds the bundle's table through the app's own path: `getDefaultConfig` -> `withUniwindConfig` ->
  `withShadewind`, then Uniwind's Metro transformer on the CSS entry, with React Native 0.86's Babel transformer behind ours. The
  output depends on `shadewind/uniwind`, registers the table when evaluated, and the table equals the device's class for class
  except exactly the two pixel-ratio / hairline classes of the fixture; the parity test checks it on every case
  (`table.prebuilt.json`). `seam-check.mjs` covers install with it (used, no device build), with device-dependent classes (idle
  rebuild), a variables change before install (not used), the resolver off (nothing loaded), a CSS reload after install.
- A real Release bundle of example-real (`react-native bundle`, React Native 0.86.3, iOS and Android, with the packed library):
  one `registerPrebuiltStyleTable(...)` right after `Uniwind.__reinit(...)` in a `try`, no "not prebuilt" warning, the same
  bundle again from a warm Metro cache, and `hermesc` compiles both.
- Not tested: Expo's transform worker (same Babel hook, not run), and any device: `-resolveBench 1` reports where the table came
  from and how many `getStyles` misses since launch went native; `-resolverOff 1` is the A/B switch for cold launches
  (`docs/LOCAL_TESTING.md` step 6).
- Cost, example-real: a 26 KB table (123 classes, 2 fall back, none device-dependent), the iOS bundle 29.6 KB larger (1,546,984
  against 1,517,337 bytes with `prebuildStyleTable: false`, +1.9 %), Hermes bytecode 26.2 KB larger (+1.2 %). It is parsed
  natively at install, on the startup path (`-resolveBench 1` reports the load ms).

The theme switch is not affected: the engine re-themes registered views natively without resolving classes again.

## 20. Android: what the engine relies on, and what is checked (2026-10-17)

React Native 0.86's Android mounting layer does not send a view's typed props to Java. `FabricMountingManager::getProps` sends,
for each created or updated view, by default the new props' `rawProps` dynamic (`enableAccumulatedUpdatesInRawPropsAndroid`: the
diff of the old and new `rawProps`; `enablePropsUpdateReconciliationAndroid`: the typed diff, View only), and the Java view
applies it on top of what it holds. A clone that changes only typed fields never reaches the screen there. So under
`RN_SERIALIZABLE_STATE` (Android's build) the hook also writes the themed values into the clone's `rawProps`, on top of what React
last sent (`ThemeHook::applyRawFields`).

Checked in `cpp/harness` (`-DHARNESS_ANDROID_STATE=ON`, part of `docker run --rm shadewind-harness`): React Native's renderer and
the engine built as on Android (`RN_SERIALIZABLE_STATE`, `ANDROID`, Android's platform code for colours, views and text), and
`App::check()` replays the mount instructions Android would get (`calculateShadowViewMutations`, then what `getProps` sends) and
requires the colour each Java view holds to be the theme's. All 18 tests pass in each of the three props modes; with
`applyRawFields` disabled, 5 of the 12 engine tests fail.

Not checked: the NDK compile of this version, JNI, Java, a device or emulator (`docs/LOCAL_TESTING.md` step 9). The class resolver's
Android bundle is built and compiled by `hermesc` (section 19), not run. example-real's launch-argument benches use `Settings`,
which is iOS-only.

## 21. Performance review of the C++ paths, measured with callgrind (2026-10-18)

Method: `BENCH_PROFILE=1 cpp/harness/build/harness_bench --runs 3` (the current engine on the 2003-view screen, one process) under
`valgrind --tool=callgrind`, with `--toggle-collect` on one function at a time; instruction counts are stable on a noisy VM, wall
times are medians of 3 runs (x86 Linux VM; a phone is slower). A temporary micro-benchmark timed the class resolver.

Changed: **prewarm reuses the props React rendered.** A view registered with the theme React rendered it with already holds that
theme's props (`ThemeHook::add`, `renderedWithCurrentTheme`), yet prewarm built a second copy of them through React Native's props
parser (`copyProps`: the `Props(context, source, rawProps)` constructor walks every prop key with string comparisons; its copy
constructor is deleted). Now `produced[currentTheme] = base` there, and only there (props React gives later may carry an older
theme). Harness test `SwitchBackReusesTheRenderedPropsWithoutACopy`; a mutant without the guard fails
`ThemeChangeBeforeRefAttachIsAppliedByTheFlush`.

| | before | after |
|---|---|---|
| prewarm instructions (5 mounts) | 948.6 M | 480.3 M (-49 %) |
| props copies View / Text (5 mounts) | 10,010 / 10,030 | 5,005 / 5,015 |
| prewarm wall time, median | 18.8-19.4 ms | 10.3-10.7 ms |
| mount: refs attach + flush | 4.6-5.4 ms | 4.3-4.6 ms |
| peak RSS of the run | 65.6 MB | 55.5 MB |
| commit hook instructions (all commits of the run) | 216.25 M | 216.08 M (unchanged) |
| switch, sync | 5.4-6.3 ms | 5.4-6.7 ms (unchanged: the cache hit either way) |

Profiled and left alone:

- **Class resolver** (`cpp/css/StyleResolver.hpp`): 0.155 us per `resolve` (about 340 instructions) over the 1531 class names of the
  parity fixture, no allocation (F14's heterogeneous lookup takes the `string_view` tokens). Nothing worth changing.
- **Theme switch commit**: about a third of the hook's instructions are React Native's own clone work, `yoga::Style::operator==`
  in `YogaLayoutableShadowNode::updateYogaProps` (every clone with new props compares the whole Yoga style) and
  `updateYogaChildren` for the ancestors cloned with new child lists. The engine's walk is about 5 %, `cloneThemed` under 1 %.
- **Registration**: about 4 M instructions per mount, mostly freeing the entries of the previous mount (fewer props objects now).
- **Done after Hermes was built here (same day):** the resolver's JSI glue created a `jsi::PropNameID` from a C string for every
  key of every result. It now takes them from a per-runtime cache kept as JSI runtime data (`cpp/ResolveGlue.hpp`), which the
  runtime releases when it is destroyed (Hermes does that first in its destructor, while the heap exists), rebuilt when another
  table is loaded (`StyleResolver::generation`). Measured with `cpp/harness/hermes/glue.cpp` on the Hermes React Native 0.86.2 pins
  (hermes-v250829098.0.16, Release, x86 VM), 3831 resolvable calls x 40 x 7 rounds: 952-1118 ns per call without the cache,
  586-654 ns with it (-38 to -41 % over three runs; the C++ resolve itself is about 155 ns). Same program: first end-to-end run of
  the glue's JS objects, 137,790 cases, 0 mismatches with Uniwind (a mutant of the glue makes all 114,930 resolved cases mismatch);
  the cached glue returns the same objects as the uncached one on every call, also after a table reload; a second runtime created
  and destroyed meanwhile; valgrind memcheck over a short run including both runtimes' teardown: 0 errors. JavaScriptCore was not
  tried (the cache relies on JSI runtime data, which every JSI runtime implements).

Release gating (same day): everything that exists to inspect or measure is now compiled only with `SHADEWIND_DEV_TOOLS`
(`cpp/DevTools.hpp`; on in Debug, opt-in for measuring release builds). Checked in the harness: a release-configuration build
(`-DHARNESS_RELEASE_CONFIG=ON`) passes 21 tests and skips the 10 that read stats or the recorder, by name; its binary has no
`gReasons` / `gRecolored` symbols of the engine and no clock call in `ThemeHook::shadowTreeWillCommit` (the remaining ones belong to
the frozen baseline engine); the hook runs 215.96 M instructions against 216.14 M with the tools in (the timers and counters were
cheap, the point is that they do not ship). `HybridShadewind.cpp` and `ShadewindNative.cpp` compile with `-Wall` in both settings.
Not measurable here: the iOS main-thread hop per hookAsync switch that only measured `visualMs`, now gone from release.

Memory profile (valgrind massif, x86 VM, same day):

- Growth: 900 cycles of mount / prewarm / two switches / unmount (102 themed views): the heap swings 1.3-5.2 MB inside each cycle;
  the floor after unmount is 1.30 MB in the middle third and 1.33 MB in the last (purge thresholds settling), the peaks 4.8-5.2 MB
  throughout. No growth. Test: `MemoryStaysFlatAcrossMountSwitchUnmountCycles`.
- Peak of the 2003-view screen (33.9 MB, `BENCH_PROFILE=1`): the engine holds 6.7 MB of prewarmed props (3.6 MB Paragraph, 3.1 MB
  View: one copy per view for the theme not on screen, about 3.1-3.6 KB each: a React Native props object is large) and 0.77 MB of
  registry entries; React Native's own nodes and props of the screen about 10 MB. The prewarm cache is what makes a switch a cache
  hit; its cost grows with the number of themes (one copy per view per other theme: about 16 KB per view with six themes). Building
  lazily on the first switch, or only for the next likely theme, would trade switch time for this memory; not done.
- Leak checks: valgrind --leak-check=full over harness_tests and hermes_glue: 0 bytes lost; AddressSanitizer + LeakSanitizer + UBSan
  (`-DHARNESS_SANITIZE=ON`) over all harness tests and the current engine's bench: clean, after fixing a test that destroyed a commit
  hook before the fake React's last commit (stack-use-after-scope in test code, not in the engine).

`setTheme` no longer takes the hook's lock (same day). It publishes `(epoch << 8) | theme` in one atomic word; a commit folds it in
once, at the start of its walk, and registration folds it in before it reads the theme. A background (iOS hookAsync) walk holds
the lock for its whole duration, and setTheme used to wait for it: under continuous background commits on 2003 views, p99 6.5-7.1 ms,
max 16.7-18.0 ms, about 350 of 1500 calls over 1 ms; now p99 1.6-2.1 us, max 25-57 us, none over 1 ms. Only iOS hookAsync gains:
hookDeferred (the Uniwind adapter) and Android commit on the JS thread, which takes the lock anyway; registration and
`flushPending` still wait for a background walk. Tests: `SetThemeDoesNotWaitForABackgroundWalk` (fails with the lock put back:
setTheme took 122 ms), `ViewRegisteredAfterAnUncommittedSwitchIsFiledUnderThatTheme` (fails if registration does not fold the
published theme in). ThreadSanitizer over all tests: no race (a non-atomic mutant of the published word is reported).
