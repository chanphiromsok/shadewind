# Unistyles 3 review (shadow tree usage)

Source: `jpudysz/react-native-unistyles` (HEAD 3aaf2c1, 2026-10-13), `packages/unistyles/cxx`. Read, not run.

## What it does

| Topic | Unistyles 3 | Shadewind |
|---|---|---|
| Update mechanism | **No commit hook.** `UIManager::updateShadowTree(tag -> folly::dynamic props)` from a JS microtask (`ShadowTreeManager.cpp`). The same public API Reanimated uses. | `UIManagerCommitHook::shadowTreeWillCommit` rewrites the tree inside every commit. |
| Node mapping | Babel plugin wraps components, ref callback calls `ShadowRegistry.link(ref, styles)` / `unlink(ref)`. | `register(ref, themedStyles)` per view; keyed by `ShadowNodeFamily*`. |
| Pending updates | `ShadowTrafficController`: mutex-guarded map family -> props; `std::shared_ptr<const ShadowNodeFamily>` **pins** the family so raw pointers stay valid. | Per-view entries with `weak_ptr`, expired entries skipped in the walk. |
| Survive React re-render | `mergeNativeProps(family, props)` (family native props) + `hasOutdatedNativeProps` at link time. | Hook re-applies on every commit (React cannot revert it). |
| Frozen screens | `suspend(ref)` marks the family; a later `link` clears the stale state. | Entries stay; the walk only sees what is in the tree. |
| Runtime reload | `generation` counter + `ownsRegistry()` guard on every entry point; replaced runtimes become no-ops. | Not done (open: hook ownership across Fast Refresh). |
| Stale JS node wrappers | `refreshReactNodes` repoints `ShadowNodeWrapper` to the committed node so React's next clone does not drop the update. | Not needed: JS never holds our nodes. |
| Diagnostics | `ShadowTreeDiagnostics::verify` | `inspect()` (treeOK / viewOK / layerOK). |

## Cost of their path (RN 0.86 `UIManagerUpdateShadowTree.cpp`)

- BFS over the **whole** tree until every tag is found (O(N)).
- `std::find_if` over the update list per node and per ancestor: O(N·k) worst case with k updated views.
- `cloneProps(RawProps(dynamic))` per node (props re-parsed from folly::dynamic).
- A normal commit afterwards: Text goes through layout, no paragraph shortcut.
- Not measured by us: expect it to be slower than the hook on 2003 views (hook: 3.6 ms), unverified.

## What to adopt

1. `generation` + `ownsRegistry()` guard at every JS entry point (fixes the Fast Refresh lifetime item).
2. Unlink on unmount from the ref callback (fixes the `ThemeRegistry._entries` leak) instead of relying only on `expired()`.
3. Check `nativeProps_DEPRECATED` on the family as a way to keep a theme across React re-renders without re-applying on every commit; measure before switching.
4. A `suspend` notion for frozen screens, only if inspect shows cost.

## What not to adopt

- Babel plugin: Uniwind has none, our Metro adapter is the right seam.
- `updateShadowTree` as the mechanism: whole-tree BFS plus full re-parse; the hook plus precomputed deltas is cheaper.
- Pinning families with `shared_ptr`: keeps nodes alive until unlink; fine for them because unlink is guaranteed by Babel-wrapped refs, riskier for us.

## Applied

- Hook, registry and theme state now live in one process-lifetime `State` shared by every `HybridShadewind` instance
  (Fast Refresh creates a new instance; the old one being collected can no longer leave a dangling hook in the UIManager).
- The hook registers once per UIManager, identified by its `ContextContainer`.
- Unlink on unmount already existed (`useThemedRef` -> `unregister` removes the registry and hook entries).
- iOS Release check: `hook` 3.35 ms median, treeOK/viewOK/layerOK 2002/2002, hookAsync run completes.
- Not covered: a real Fast Refresh test and Android re-run.
