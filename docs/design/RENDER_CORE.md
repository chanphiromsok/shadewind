# Render core decision memo (Opus research, 2026-10-14)

> Decision memo (2026-10-14).

Markers: [V] verified by reading a file or URL, [I] inferred. Versions: RN 0.86.2 (repo) / 0.86.3 (tovtam), Reanimated 4.6.0,
Nitro 0.37.1.

## 1. Where a switch spends time

- Real app (tovtam): about 60 ms stall with or without the engine; ablating three React consumers took it to about 36 ms.
  Most of what remains is React re-rendering, which no native-core language change can touch [V TOVTAM_PORT.md].
- 2003-view micro-benchmark: engine commit 2-4 ms; of the hook, 115 of 136 samples were RN's `ShadowNode::clone`; `recolorParagraph`
  18; the hook's own logic about 5 % [V DESIGN.md]. Yoga was 74 % before the Paragraph-state trick and is gone.
  Main-thread mount about 11-12 ms, text redraw dominates (`RCTParagraphTextView drawRect:`).
- Unmeasured: `walkTree` visits every node of every commit (React commits, state updates, animation frames), ignoring `oldRoot`.

## 2. Rust or C++

- Nitro has no Rust target [V nitro.margelo.com]; uniffi-bindgen-react-native yields Turbo Modules, no commit hook access.
- The commit hook must be C++ (it subclasses RN C++ and builds RN Props/ShadowNodes). A Rust core would pay FFI per node for at
  most the ~5 % the hook owns. **Keep C++.**
- Build time already runs Rust through `@tailwindcss/oxide` and `lightningcss`; a custom napi-rs compiler only if the JS visitor
  walk exceeds about 1 s cold (unmeasured).

## 3. Unconventional options

| | Idea | Verdict |
|---|---|---|
| a | iOS custom `UITraitDefinition` + dynamic-provider UIColor in props; switch = `window.traitOverrides.theme = n`, no commit | only candidate for a step change, iOS only; blocked on whether `RCTViewComponentView` invalidates on a custom trait (it checks `hasDifferentColorAppearanceComparedToTraitCollection`); Android has no equivalent |
| b | direct mount-layer updates (`synchronouslyUpdateViewOnUIThread`) | RN's own AnimationBackend and Reanimated 4.6 do it with a commit hook that reapplies; per-view direct was 120 ms here; not a step change |
| c | data-oriented registry, subtree skipping by pointer diff + commit-source filter | the real lever is to skip unchanged subtrees; SoA only shrinks the 5 % |
| d | compositor tinting (alpha-mask text over a coloured layer) | only way to remove text redraw; forks the Paragraph view, 3+ weeks |
| e | Lynx / Flutter / Compose token tables | transfers as "resolve tokens natively", which the `classId x slot` table already is |
| f | React side: stable navigation theme, selectors | source of the 24 ms ablation gain |
| g | `enableFabricCommitBranching`, `ShadowTreeCommitSource::ReactRevisionMerge` (flag off) | correctness risk for any hook; test before RN flips it |

`ShadowNodeFragment.runtimeShadowNodeReference` (default true) is RN's official answer to what `refreshReactNodes` does by hand.

## 4. Does RN core need a patch?

| Extension point | Status |
|---|---|
| `UIManagerCommitHook` / `registerCommitHook` | public header, unstable C++ API (AnimationBackend uses it) |
| `ShadowTreeCommitOptions.source` | public; use to filter commits |
| `ShadowNodeFamily` ancestors | public |
| `Props::rawProps` (Android, `RN_SERIALIZABLE_STATE`) | public but fragile |
| `nativeProps_DEPRECATED` | hook path does not need it; drop |
| `synchronouslyUpdateViewOnUIThread` | public |
| `YogaAccess` (protected `yogaNode_` via pointer-to-member) | **most fragile thing shipped**, not public |
| node tagging prop | JS `validAttributes` drop unknown props; test an existing prop (`nativeID`/`testID`) as carrier |
| custom-trait invalidation | possibly a patch or swizzle |

Justified upstream PR: a Paragraph should not dirty measurement when only paint text attributes change
(`shouldNewRevisionDirtyMeasurement`, ParagraphShadowNode.h). It would remove `YogaAccess` and the hand-built state.

## 5. Ranking

| # | Approach | Gain | Risk | Effort | RN patch | Cheapest spike |
|---|---|---|---|---|---|---|
| 1 | fix React consumers (themed values, stable nav theme) | about 24 of 60 ms (one run) | low | 1-2 wk | N | 5 runs per arm of the ablation |
| 2 | pointer-diff walk + commit-source filter | removes O(tree) per non-theme commit, unmeasured | low | 2-3 d | N | hook us/commit scrolling a 5k-node list |
| 3 | iOS custom-trait dynamic colours | commit ~3 ms -> ~0, mount unchanged | med | 1 wk | maybe | one View + one Text, flip trait, check pixels |
| 4 | upstream Paragraph paint-only PR | correctness/maintenance | low | 1 wk | PR | patch locally, delete YogaAccess, re-run |
| 5 | text alpha-mask tinting | removes most of the 11 ms mount | high | 3+ wk | fork | one paragraph, measure main thread |
| 6 | batched direct updates | <= commit time, stale window | med | 1 wk | N | - |
| 7 | Rust core | <= 5 % of 3 ms, likely negative | med | 4+ wk | N | not worth a spike |

## 6. Target

```
build: oxide scan -> tailwind compile -> lightningcss visitor -> token table (JS + native)
runtime JS: resolver(classIds) -> base style + token refs -> bind(family)
native C++ (Nitro, raw JSI):
  registry SoA[family -> slots]
  setTheme(n) -+- iOS: window.traitOverrides = n (dynamic UIColors, colours only)
               +- commit tick -> hook: walk diff(old,new) U themed paths -> clone -> mount
  hook skips commits whose source is not React or self
```

Plan and kill criteria: (1) themed-value API, kill if under 10 ms saved over 5 runs; (2) pointer-diff walk, kill if the hook costs
under 0.2 ms/commit on a 5k-node scroll; (3) custom-trait spike, kill if text/layers do not repaint without a swizzle; (4) Paragraph
PR, keep YogaAccess until merged; (5) text tinting only if main-thread mount is still over 8 ms on device after 1-3.

Gaps: simulator runs, mostly single; Android not profiled on tovtam; custom-trait behaviour unverified.
