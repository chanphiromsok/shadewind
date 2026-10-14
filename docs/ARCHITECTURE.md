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

1. **No React state or subscriptions on a theme path.** A theme change never calls `setState`, never notifies a React listener.
2. **Every themed value has a native route** (style keys, non-style props, navigation chrome).
3. **A view that cannot be bound still renders correctly** (the current theme's value is in its first render; it may be stale
   after a later switch only if the user opted out, never silently wrong at mount).
4. **JS never sits on the switch path**: `setTheme` is a native call; React is not asked to render.
5. **Compatibility goal**: tovtam's existing `global.css` (`@variant light/dark`, `@theme`) and `className` strings compile
   unchanged. Migration = config swap, not a rewrite. (Promise is conditional on the spikes in section 6.)

## 3. ERD

```mermaid
erDiagram
  THEME ||--o{ TOKEN_VALUE : defines
  TOKEN ||--o{ TOKEN_VALUE : "has one per theme"
  UTILITY_CLASS ||--o{ CLASS_DECL : expands_to
  CLASS_DECL }o--|| TOKEN : "references (colour)"
  CLASS_DECL }o--o| MODIFIER : "guarded by"
  UTILITY_CLASS ||--|| COMPILED_STYLE : compiles_to
  COMPILED_STYLE ||--o{ THEMED_PROP : has
  COMPILED_STYLE ||--o{ STATE_VARIANT : has
  THEMED_PROP }o--|| TOKEN : "value is token"
  STATE_VARIANT }o--|| MODIFIER : "when"
  STYLE_TABLE ||--o{ COMPILED_STYLE : contains
  STYLE_TABLE ||--|| NATIVE_TABLE : "mirrored as"
  BINDING }o--|| SHADOW_NODE_FAMILY : "targets"
  BINDING }o--o{ COMPILED_STYLE : "applies"
  BINDING }o--o{ THEMED_VALUE : "applies"
  THEMED_VALUE }o--|| TOKEN : "token per theme"
  PLATFORM ||--o{ CLASS_DECL : "filters"

  THEME { string name PK
          int slot "0..N-1 (runtime sized)" }
  TOKEN { string name PK
          string kind "colour|number|string" }
  TOKEN_VALUE { string theme FK
                string token FK
                string value "resolved: colour as ARGB" }
  UTILITY_CLASS { string text PK "bg-card, p-4, dark:bg-black" }
  CLASS_DECL { string property
              string value
              string modifier FK }
  MODIFIER { string kind "theme|platform|pressed|focused|disabled|breakpoint" }
  COMPILED_STYLE { int classId PK
                   json baseStyle "static RN style"
                   bool layoutPerTheme "spike 4" }
  THEMED_PROP { string prop "backgroundColor|borderColor|color|..."
               string token FK }
  STATE_VARIANT { string modifier FK
                  json style }
  STYLE_TABLE { string buildId PK
               string source "global.css hash + candidates" }
  NATIVE_TABLE { string buildId PK
                bin colours "classId x slot" }
  BINDING { int id PK
            string mode "tagged|ref" }
  THEMED_VALUE { string prop
                 string kind "colour|colour[]|number" }
  SHADOW_NODE_FAMILY { ptr family PK }
  PLATFORM { string name PK }
```

Reading: a **utility class** compiles to one **compiled style** (static base style + themed props that point at **tokens** +
state variants). Tokens have one value per **theme**. A **binding** ties a shadow-node family to compiled styles and to
**themed values** (non-style props). The native table holds `classId x slot -> value` so the commit hook never calls JS.

## 4. Pipeline

```mermaid
flowchart TD
  subgraph BUILD["Build (Node, Metro transformer)"]
    A[global.css + @theme + @variant] --> C[Compiler]
    B[source scan: className candidates] --> C
    C --> T1[(JS StyleTable: classId -> base, themed, states)]
    C --> T2[(Native table: classId x slot -> value)]
  end
  subgraph XFORM["Transform (Babel/Metro)"]
    S1["className='bg-card p-4'"] --> S2["__sw(classId)"]
  end
  subgraph RUN["Runtime (JS thread)"]
    R1["cn()/clsx/twMerge/template strings"] --> R2[Resolver: pure, cached, no subscription]
    R2 --> R3[classIds -> merged style + themed props]
    R3 --> R4[Render host view with current-theme values + bind]
  end
  subgraph NATIVE["Native (C++)"]
    N1[registry: family -> classIds + themed values]
    N2[setTheme name -> slot]
    N3[UIManagerCommitHook: walk, clone, recolour paragraph]
    N4[mount, Yoga only if layout changed]
    N2 --> N3 --> N4
    N1 --> N3
  end
  T1 --> R3
  T2 --> N1
  S2 --> R3
  R4 -->|"bind (tag prop or ref)"| N1
  UI[app: setTheme] --> N2
  FALLBACK[unbindable view] -.-> R4
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
| Fallback | class not in table / unbindable | plain unthemed style + dev warning | JS |

## 5. Reuse and retire

- **Keep**: commit hook, paragraph recolour, Android `rawProps`, `configure`, per-theme slots, `useThemed`, `useThemedProps`,
  shared process-lifetime state.
- **New**: compiler (Tailwind v4 candidates + CSS theme blocks), StyleTable, runtime resolver, native table, node tagging
  (if spike 1 passes).
- **Uniwind seam** (`metro.cjs`, `src/uniwind`): decision needed. Recommended: keep as a *deprecated migration bridge* for one
  release (apps can adopt the engine before the compiler exists), then delete. Not extended further.

## 6. Open decisions: each needs a spike with a pass criterion (not answered from memory)

| Spike | Question | Pass criterion |
|---|---|---|
| 1 Node tagging | does a `themeClassId` prop reach C++ props or does the view config drop it? | lands in C++ props -> no private `getNodeFromInternalInstanceHandle` binding; dropped -> keep ref binding |
| 2 Third-party props | does `cloneProps` on raw props repaint `expo-linear-gradient` `colors`? | colours repaint without a React render; `useThemedProps` depends on this and is untested |
| 3 Interaction state | `active:`/`focus:`/`disabled:` (21 `active:` in tovtam) without React state | a native route exists; else a documented scoped exception to rule 1 |
| 4 Per-theme layout | `dark:p-8` | supported (dirty Yoga in the hook) or explicitly out of scope; pick one |
| 5 Slot count | `kMaxThemes = 6` fixed array | slots sized at runtime from `configure` |
| 6 Build pipeline | Tailwind v4 candidate extraction inside Metro/Expo + React Compiler + web | compiles tovtam's `global.css` and sources with no changes |

## 7. Housekeeping

- `useThemedProps` and `toNativePropsWith` are committed on this branch.
- The tovtam copy (`scratchpad/tovtam`) still has **ablation edits** in `useThemeConfig`, `useGradientColors` and `RichText`
  (originals in `/private/tmp/claude-501/*.orig.*`); it is **not a clean baseline**. Its numbers: plain 64.8 ms, engine 60.3 /
  59 ms, engine + ablation 36.1 ms median longest stall (single or two runs, indicative).
