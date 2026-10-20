# Fabric, ShadowNode, ShadowTree: what this library relies on, with the source lines

All references: facebook/react-native tag `v0.86.2`, `packages/react-native/ReactCommon/react/renderer/`. Every line number below was
checked against the upstream files fetched from raw.githubusercontent.com at that tag (2026-10-15), not only the local copy.
Statements marked *not verified* were not checked against source.

## The objects

| Object | What it is | Evidence |
|---|---|---|
| `ShadowNode` | Immutable node: `props_`, `children_`, `state_`, `family_` | `core/ShadowNode.h:233-265` |
| `ShadowNodeFamily` | Identity that survives clones: `tag_`, `surfaceId_`, `eventEmitter_`. Every clone of a view shares one family | `core/ShadowNodeFamily.h:155-170` |
| `ShadowTree` | One per surface. Holds the current root revision, commits new roots | `mounting/ShadowTree.cpp` |
| Commit | `tryCommit` builds a new root, runs the hooks, lays out, pushes a revision for the mounting layer | `ShadowTree.cpp:329-480` |

Nothing is mutated. To change a prop you clone the node with new props and every ancestor up to the root gets a new children
list. Unchanged subtrees are shared between revisions, which is why a theme switch only needs to clone the themed nodes and
their ancestors.

## The order inside one commit (`ShadowTree::tryCommit`)

1. `shadowTreeWillCommit(...)` runs every registered `UIManagerCommitHook` (`ShadowTree.cpp:393`). This is the engine's entry point.
   The hook returns a replacement root, so whatever it returns is what is laid out and mounted.
2. `layoutIfNeeded(...)` runs Yoga on dirty nodes (`ShadowTree.cpp:409`).
3. The revision is pushed to the `MountingCoordinator` (`ShadowTree.cpp:478`) and the platform mounts it on the main thread.

Hooks run before layout (`:393` then `:409`), so a hook can change props and have layout see them in the same commit.
*Not verified:* which thread each commit runs on. The hook keeps its state behind a mutex either way.

## Why a theme switch costs what it costs

- `YogaLayoutableShadowNode::completeClone` (`YogaLayoutableShadowNode.cpp:155-166`) marks a clone dirty only for nodes with the
  `MeasurableYogaNode` trait, and then when `fragment.children` is set or `shouldNewRevisionDirtyMeasurement` returns true. The base
  implementation returns `true` (`:322-326`); `ParagraphShadowNode` overrides it to `fragment.props != nullptr`
  (`ParagraphShadowNode.cpp:64-68`). So a Paragraph clone with new props, or with new children, is dirty; one that only gets new state is not. That is the reason `recolorParagraph` in `ThemeHook.hpp` builds the new `ParagraphState`
  itself and clears the dirty flag: it avoids the layout pass that dominated the 8.6 ms switch (docs/design/DESIGN.md, deep dive).
- `updateYogaChildren` sets a node dirty when any child yoga node is dirty (`YogaLayoutableShadowNode.cpp:366-375`), so one dirty Text puts the whole path to the root in the layout pass.

Note on an older claim: `docs/design/DESIGN.md` says every `MeasurableYogaNode` clone is dirtied unconditionally. Per the source above that
holds for new props or new children, which covers a colour change, so its conclusion stands but the wording was too broad.

## Where each piece of this library sits

| Concern | Place |
|---|---|
| Find registered views in a new tree | `ThemeHook::walkTree`, pointer-keyed lookup on `ShadowNodeFamily*` |
| Never apply stale props | `current != entry->appliedProps` compares the node's props pointer with what the hook last produced |
| Survive freeze / reveal | the hook runs inside every commit, React's too, so a re-attached subtree is fixed before it is mounted |
| JS thread cost | `setTheme` only bumps an epoch; the walk happens in the next commit |

## Measuring it: `ThemeSwitchMeter`

`example-real/src/bench/ThemeSwitchMeter.tsx` is a drop-in component. Tap it and it switches theme N times, 300 ms apart, and shows
the median of the warm runs:

- `sync`: JS time inside the `setTheme` call
- `idle`: call until the JS thread is idle (the uniwind-benchmarks metric)
- `stall`: longest gap between timer ticks during the next 350 ms (the longest dropped JS frame)
- `tree a/b`: registered views whose shadow-tree background equals the current theme, taken from `inspect()`; `a` must equal `b`

Reading it: a small `idle` with a large `stall` means the work moved to a place that still blocks JS (a sync commit). A small
`idle` and `stall` with `tree a/b` equal means the async commit landed correctly.

Not measured by it: main-thread mount time (use `mainBusyMs` / Instruments) and Android.
