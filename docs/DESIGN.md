# Design notes

Zero-re-render style updates for React Native (Fabric), written from React Native's own public C++ APIs.
No dependency on Unistyles.

## Idea
Style changes that don't need React (theme switch, color scheme, dimensions, ...) are pushed straight to the
Fabric shadow tree instead of re-rendering components.

## Building blocks (all from RN 0.86 sources)
1. **Commit** — `UIManager::updateShadowTree(std::unordered_map<Tag, folly::dynamic>&&)`
   (`react/renderer/uimanager/UIManager.h`). Clones each affected node once, children before ancestors, then commits.
2. **Keep React from overwriting** — `ShadowNodeFamily::nativeProps_DEPRECATED` (+ `nativePropsMutex` from RN 0.86.1).
   RN marks it as "will be removed": this is the main long-term risk, so all access lives in one file (`cxx/NativeProps.h`).
3. **Registry** — views we manage, keyed by `ShadowNodeFamily*`, held with `shared_ptr<const ShadowNodeFamily>` while an update is pending.
4. **Batching** — one mutex-guarded map of pending updates, flushed once per frame.
5. **React fiber sync (JS)** — after a commit, make React's fibers point at the committed nodes so the next React commit doesn't restore an older subtree.

## Do we need a custom ShadowNode subclass?
No, not for styling existing View/Text. A `ConcreteShadowNode` is only needed for a new native component with its own
layout/measure/state. Decide that separately.

## Layout
- `cxx/`  C++ core (registry, batcher, native-props access, commit)
- `src/`  TypeScript API
- `docs/` notes and verification results

## Status
v0 scaffolded with create-react-native-library (nitro-module) and a C++ core in `cpp/`. Verified so far: nitrogen codegen OK, TypeScript typecheck OK, lint OK (0 errors), C++ core
(`cpp/HybridShadewind.cpp` + generated spec) passes a clang `-fsyntax-only` compile against RN 0.86.3 + Nitro 0.37.1 headers.
NOT verified: linking, running on a device, whether theme props survive React re-renders, performance (nothing measured).

## v0 limits
- Only visual props (`backgroundColor`, `borderColor`, `opacity`), no layout props, no Text styles.
- Uses stock `UIManager::updateShadowTree` (RN walks the whole tree and de-duplicates linearly per call).
  A custom single-pass commit is the planned optimisation, to be done only after measuring.
- Uses private RN JS API `RendererProxy.getNodeFromInternalInstanceHandle` and the deprecated `nativeProps_DEPRECATED`.
- Android: CMake includes `cpp/*.cpp`, but the React Native renderer libraries are not linked yet.
- No React fiber re-sync after commit.

## Measurements (Release build, iPhone 17 Pro simulator, 1500 views, median of 10 switches)

Method: example app `Bench x12`. One build, strategies picked at runtime. Noise between runs is about ±15%.

| Approach | JS call | commit | worst frame gap | row re-renders |
|---|---|---|---|---|
| React context (baseline) | n/a | n/a | 61.2 ms | 1500 |
| `stock` (UIManager::updateShadowTree) | 52.5 ms | 48.6 ms | 60.1 ms | 0 |
| `fast` (ShadowTree::commit + cloneMultiple) | 12.6 / 14.7 ms | 11.7 / 12.3 ms | 25.8 / 26.1 ms | 0 |
| `fastAsync` (same, async mount) | 15.8 ms | 13.2 ms | 27.6 ms | 0 |
| `direct` (synchronouslyUpdateViewOnUIThread per view) | 120 / 136 ms | n/a | 138 / 155 ms | 0 |

- `fast` is the default. About 4x faster than `stock`, per view roughly 8-10 us.
- `direct` is much worse: each call waits for the main thread, so 1500 views = 1500 round trips.
- `fastAsync` gives no gain: the cost is the clone and the props parsing, not waiting for the mount.
- Published Uniwind benchmark (their machine, their metric: until JS is idle): Pro 1.8.1 7.7 ms, Pro 1.0.1 17.1 ms, Tamagui 25.9 ms, Unistyles 47.1 ms, Uniwind 93.2 ms for 2003 views. NOT the same machine, so only indicative: Pro 1.8.1 is roughly 3.8 us/view.

## Verified bugs fixed
- Views frozen (Suspense/react-freeze style) or hidden (Activity) while the theme changed came back with the old theme.
  Fix: views that register are collected and the current theme is applied to them in one batched commit (`flushPending`).

## Real navigation + freeze (react-native-screens 4.30, native stack, `freezeOnBlur: true`)

Flow: Home (light) -> Settings -> Dark -> Back.

- Before the fix, Home came back wrong in 2 of 3 runs (stale cards, or the whole screen reverted after the transition).
- Debug call `inspect()` showed why: our `nativeProps_DEPRECATED` overlay had the dark colour for 31/31 views, but the
  committed shadow tree had it for only 1/31. React had re-attached its own old node handles (`fiber.stateNode.node`).
  A later React re-render of the screen made the cards dark again, because React's clone re-applies the overlay.
- `updateRuntimeShadowNodeReference` on our clones did nothing: RN only links the JS wrapper to the node when the
  `updateRuntimeShadowNodeReferences*` feature flags are on, and they are off by default in 0.86.
- Fix: `refreshReactNodes` (C++) repoints the `ShadowNodeWrapper` React holds at the committed node; JS collects the
  wrappers of registered views and their host ancestors from the fibers. Called after every setTheme and flushPending.
  After the fix: `treeOK=31 nativeOK=31`, Home renders stay at 1-2, 3 rapid round trips end in the right theme,
  and a recording of the back transition shows no wrong colour (8 fps sampling).
- Cost: with the fiber walk, `fast` at 1500 views measured JS call 27.1 ms / worst gap 47.3 ms
  (before the fix: 12.6-14.7 ms / 26 ms). Part of that may be the larger tree (nav stack + frozen Home), not yet separated.

Uses private React internals (`__internalInstanceHandle`, fiber tags) and the deprecated `nativeProps_DEPRECATED`.

## Commit-hook engine ('hook', default) — replaces the nativeProps overlay + JS fiber walk

`ThemeHook` (cpp/ThemeHook.hpp) is a `UIManagerCommitHook`. `setTheme` bumps an epoch and makes one near-empty commit;
inside `shadowTreeWillCommit` it walks the new tree once, finds registered views that are out of date (theme changed, or
the props object is not the one we produced), builds typed props and clones only those nodes with `cloneMultiple`.
Every commit passes through it, React's too, so a frozen screen re-attached from stale handles is corrected before it
is committed. No `nativeProps_DEPRECATED`, no `__internalInstanceHandle`, no JS work.

Typed props: `Props` is not copyable (`Props(const Props&) = delete`). We call the props constructor with an empty
RawProps that has a prepared `RawPropsParser` attached (a RawProps without a parser crashes inside the constructor,
this crashed the app once), which copies every field, then set `backgroundColor`, `borderColors.all`, `opacity`
(View) and `textAttributes.foregroundColor` (Paragraph). Other components fall back to `cloneProps`.
Text colour path is implemented but NOT tested.

Measured (Release, iPhone 17 Pro simulator, 1500 views inside the navigation stack, median of 10):

| Engine | JS call | worst frame gap | notes |
|---|---|---|---|
| 'fast' + nativeProps overlay + JS fiber refresh | 27.1 ms | 47.3 ms | commit 18.0 + ~6.5 JS walk |
| 'hook' v1 (per-view getAncestors scan) | 18.1 ms | 38.6 ms | scan 5.8, clone 10.0 |
| 'hook' (one tree walk scan) | 16.2 ms | 35.6 ms | scan 3.0, clone 10.6 (typed props 6.3) |

About 10.8 us per view. Published Pro 1.8.1 is about 3.8 us per view (2003 views, 7.7 ms, other machine and metric).
Correctness: Home -> Settings -> Dark -> Back with freezeOnBlur ends fully dark, Home renders stay 1; rapid
Light/Dark/Light round trips end in the right theme.

Where the remaining time goes: tree scan about 2 us/view, typed props about 4 us/view, node clone about 3 us/view.
Next ideas: skip the Fabric clone for visual-only props by updating the native views in one main-thread batch
(iOS Obj-C++/Swift, Android JNI) and committing the shadow tree off the JS thread.

## iOS fast paths ('hookAsync' is now the default)

Measured on the same build (Release, iPhone 17 Pro simulator, 1500 views, median of 10, inside the nav stack):

| Strategy | JS thread blocked | worst frame gap | where the work goes |
|---|---|---|---|
| `hook` (sync commit in the hook) | 15.4 ms | 34.6 ms | scan 3.0 + clone 9.9 (props 6.2) on the JS thread |
| **`hookAsync`** (default) | **0.08 ms** | **25.0 ms** | same commit (14.8 ms) on a background thread |
| `native` (UIKit pass + background commit) | 1.2 ms | 26.3 ms | UIKit pass 4.4 ms on main, commit 14.1 ms in background |

- `hookAsync`: `setTheme` bumps the hook's epoch and dispatches the near-empty commit to a background queue; the hook does
  the scan and clone there. ShadowTree::commit is thread-safe; React's own commits still pass through the hook.
- `native` (iOS only, ios/ShadewindNative.mm): walks the window hierarchy once on the main thread and sets
  `backgroundColor` on views found by `UIView.tag` (Fabric stores the React tag there), then the same background commit
  keeps the shadow tree exact. It makes the colour appear sooner (4.4 ms of main-thread work instead of waiting for the
  commit + mount) but does NOT reduce main-thread load, so the frame gap is unchanged. The "sooner" part is inferred
  from those numbers, not measured. Background colour only.
- RN's own `synchronouslyUpdateViewOnUIThread` is not a cheap alternative: on iOS it re-runs cloneProps + updateProps per view.
- Verified on the real navigation flow (react-native-screens, freezeOnBlur): hookAsync, native and mixed rapid
  round trips all end in the right theme with Home renders staying at 1. Default path re-verified after the switch.
- Not done: Android (the async dispatch falls back to a synchronous commit there), Text colour is untested, only
  visual props (backgroundColor, borderColor, opacity, text colour) are supported, no automated tests.

## Native profile (Instruments / xctrace, iOS simulator, hookAsync, 1500 views, 12 switches)

- CPU by thread: Main 93.1% (6.3 s), React JS thread 4.7% (321 ms), the background commit thread ~2.2% (146 ms).
  The engine's own work (JS + background) is small; what is left is the main thread.
- The ~600 ms "hangs" are `-[RCTParagraphComponentView accessibilityElements]` (accessibility traversal), recorded well
  after the switches finished. They come from the test harness's own accessibility-tree reads on a 1500-row screen, not
  from the theme code. Ignore them.
- Top main-thread hotspot during the switches: `RCTGetBorderImage` (9.8% of all samples) from
  `RCTViewComponentView invalidateLayer` -> `RCTAddContourEffectToLayer`, rendering a bitmap per bordered view
  (`UIGraphicsImageRenderer imageWithActions:`). React Native only uses the cheap Core Animation border when the view clips
  to bounds (RCTViewComponentView.mm:1044), so the theory was that `overflow: 'hidden'` would help.
- It did NOT help. With `overflow: 'hidden'` the profile no longer shows `RCTGetBorderImage`, but an interleaved A/B on the
  same build (noclip, clip, noclip, clip) gave worst frame gap 26.2 / 31.1 / 26.6 / 31.3 ms and engine commit
  14.5 / 19.1 / 14.1 / 21.1 ms: clipping is consistently SLOWER (about +5 ms gap) in this scenario. Reason not investigated.
  Lesson: a sampling profiler hotspot is not the same as the metric you care about; always A/B.
- Comparing runs minutes apart is unreliable here: the same engine code measured scan 2.6 vs 4.2 ms an hour apart.
  Use the in-app clip toggle (same build, interleaved) or similar.

## Goal: theme switch of 1500 views under 10 ms (iOS) — met for the steady-state native commit

What is measured: the whole background commit of `hookAsync` (`commitMs`: scan + clone + commit, everything the engine does
for the switch), median of 10 switches after 2 warm-up switches, 1500 views, Release, iPhone 17 Pro simulator.

| Samples (commit) | Build |
|---|---|
| 9.18, 8.34 ms | before the cache-invalidation fix |
| 6.11, 9.47, 6.10 ms | final build |

(scan 0.9–1.9, clone 3.1–5.0, props rebuilt 0.1, 1533/1533 views reused from cache; JS thread blocked 0.04–0.08 ms).
History for the same scenario: 52 ms (stock) -> 27 (fast + JS fiber refresh) -> 16 ms (hook) -> ~14.5 (hookAsync, off the JS thread)
-> 6–9.5 ms (this change).

What changed: (1) a theme change skips the tree walk (cloneMultiple finds nodes through the families' parent links and ignores
families that are not in the tree); (2) each view keeps the props objects we built per theme and reuses them while the node still
holds one of ours, so steady-state switches build no props at all; (3) the per-view work list no longer allocates.

NOT covered by the number:
- The first switch of a theme pair (cache cold) still builds props: roughly 14-16 ms (the earlier no-cache figure; not re-measured).
- Worst frame gap stayed 21-26 ms: React Native's mount of 1500 updated views on the main thread. A frame gap under 10 ms is not
  reachable at 60 Hz, so the goal is only about the engine's work.
- Simulator, one scenario; run-to-run spread is large (6.1 to 9.5 ms on the same build).

Bug found by testing the cache (fixed): cache reuse assumed nothing but our fields could differ between our own props objects.
When React changed another prop (padding 16 -> 40) and the theme was switched afterwards, the cached props of the other theme
(built with padding 16) were reused and silently reverted the padding. Fix: when props are rebuilt from a node that did not
hold one of ours, that view's cache for the other themes is dropped. Verified with Dark/Light/Dark, padding change, Light, Dark,
padding back, Light (Home -> Settings -> Back with freezeOnBlur): theme and padding both correct each time.

Reanimated feature flags (docs.swmansion.com/react-native-reanimated/docs/guides/feature-flags/) configure Reanimated's own commit
hook, not this module. `IOS_/ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` is the same idea as our `direct` strategy (slow here, and the docs
warn about touch and commit desync). Running this hook alongside Reanimated's hook was NOT tested.

## Goal follow-up: cold switch and stability (final build)

Everything below is the engine's native commit for 1500 views (`commitMs`), Release, iPhone 17 Pro simulator.

New in this round
1. Props pre-warm: when views register, their props for every theme are built on a background thread from the props they
   registered with, so the FIRST switch needs no props building (cold: 17.95 ms -> ~10.4-11.7 ms, props 7.3 -> 0.2 ms).
2. Pre-built node buffer (double buffering): after each applied switch, a background job clones the live node of every view
   with the other theme's props. The next switch takes that node instead of cloning (`pre-built 1500-1532 of 1533`).
   Safety: a pre-built node is used only if the live node is still exactly the node it was cloned from (pointer identity),
   the node still holds props we produced, and the children are not being replaced (`fragment.children` is null). Anything else
   (React changed the node, a view with registered children, a lineage reset) takes the normal clone path. A lineage reset
   (React changed non-theme props) clears the buffer.
3. Background commit uses `mountSynchronously = false` (like React's own commits) so it does not wait for the main-thread mount.
4. Clone callback looks views up directly instead of building a per-view work map (scan 2.2 -> 0.3-0.9 ms).

Samples on the final build (commit ms):
- warm (median of 10 switches, hookAsync): 5.79, 4.25, 7.04, 4.35 (+ 5.48 under the profiler)
- cold (first switch after remounting 1500 rows, `cold` button): 11.01, 3.41, 2.62, 8.52
- The 11.01 ms cold sample was taken while another app (BS One) was running on the same simulator; the same build gave 3.4 and 2.6
  ms when the machine was quiet. Run-to-run spread on this machine is large (about 2.6 to 11 ms), so treat the number as a range.
  Not every sample is under 10 ms.

Profile of the background commit (Instruments, 12 switches, before the node buffer): ~53 samples, i.e. ~4.4 ms per switch:
`cloneMultiple` ~52% (of which `ShadowNode::clone` -> `ViewShadowNode` / `YogaLayoutableShadowNode` constructors ~33%),
`RootShadowNode::layoutIfNeeded` -> `layoutTree` -> `configureYogaTree` ~20% (replacing the parent's children dirties it),
the hook's own bookkeeping ~5%. The node buffer removes most of the per-view clone cost.

Not changed: worst frame gap stays 17-26 ms; that is React Native mounting 1500 updated views on the main thread, which this
engine does not control, and a frame gap under 10 ms is not reachable at 60 Hz.

Correctness re-tested with the node buffer: Home -> Settings -> switch -> Back with freezeOnBlur; padding changed through React
between switches (Dark, padding 40, Light: light AND tall; Dark: dark and tall; padding 16, Light: light and tight);
5 switches in about 1 s ending dark. Not tested: more than two themes, Android, nested registered views, memory growth over long sessions.

Known costs/risks of the buffer: each registered view keeps an extra node and the source node it came from alive (memory roughly
doubles for registered view nodes); the build job is ~1500 clones of background CPU after every switch; a hook registered on a
UIManager is never unregistered when the module object is destroyed (pre-existing, e.g. across a JS reload).

## Distribution measurements and the cold-after-idle floor (builds 37-40)

Goal: "theme switch 1500 under 10 ms". Release build, iPhone 17 Pro simulator, 1500 registered views, `hookAsync`.
`commit` = background thread time inside `commitTick` (hook + RN diff/layout/mount dispatch). "Cold" = first switch after N ms idle.

| build | change | cold x10, 3 s idle (median, >=10 ms) | clone phase when slow |
|---|---|---|---|
| 36 | previous | ~10-11.4 ms, 5-6/10 | ~5.5 ms |
| 37 | lean clone callback (one lookup, fewer shared_ptr copies) | 7.64 ms, 4/10 and 11.78 ms, 8/10 (two runs) | 5.8-6.3 ms |
| 38 | flat per-theme slots (interned theme ids instead of string-keyed maps) | 10.57 ms, 7/10 | 4.7-6.4 ms |
| 39 | own single-pass tree walk instead of `cloneMultiple` + separate scan | 9.90 ms, 4/10 | 6.0-7.5 ms |
| 39 + 4 busy host cores | control for CPU clock ramp | 9.76 ms, 4/10 (range 7.0-10.7) | 4.2-6.8 ms |
| 40 | cache-line-sized slots, non-owning `appliedProps`, no family refcount copies, no per-view clocks, children list built without copy-then-overwrite | 9.48 ms, 4/10 (range 5.2-11.0) | 3.1-7.0 ms |

Warm (back-to-back switches, `warm x30`), build 40: min 1.72, median 2.03, p90 2.46, max 8.99 ms, 0/30 >= 10 ms.
Short idle (400 ms) cold x10 on the earlier build: ~2.0 ms, 0/10.

What the experiments say:
- The engine's decisions are identical in every trial (1500 of 1500 nodes taken from the buffer, props rebuild ~0.1 ms). Only the time per view changes:
  ~1 us/view hot, ~4 us/view after 3 s idle. The same work is 3-4x slower, in whole trials, not gradually.
- Busy-looping 4 host cores (to hold CPU clocks up) did not produce the hot 2-3 ms state, so the slowdown is not clock ramp. It is consistent with
  cold caches/TLB: after idle each registered view costs ~15-20 cold cache lines (node, children vector header, family control block,
  entry, props, pre-built node and their refcounts). Builds 38-40 shrank that footprint; build 40's best trials (5.2 ms) show the
  effect, but the median did not move below 10 ms reliably.
- Not controllable from this module: RN's own diff, Yoga `configureYogaTree`/layout (the parent is cloned with a new children list, which
  dirties it; ~20% in the earlier Instruments profile) and the main-thread mount of 1500 updated views. About 3.5-4 ms of the cold
  commit is that RN-side work.
- QoS is not the cause: the commit already runs on a USER_INTERACTIVE queue (the pre-build job is UTILITY on purpose).

Statement that holds on this machine: warm switches are under 10 ms (30/30, median 2.0 ms); cold-after-short-idle switches are under
10 ms (10/10); cold-after-3-s-idle switches are about 9.5-10.5 ms median with 4-8 of 10 at or above 10 ms. The goal is therefore met for
warm and short-idle cases and NOT reliably met for the first switch after several seconds of idle. Worst frame gap (17-26 ms) is
React Native's main-thread mount plus the demo's own React re-render and is not covered by the "under 10 ms" claim.

Build 40 correctness (freezeOnBlur Home): Settings -> Dark -> Back: Home dark with `Home renders: 1`; padding 16 -> 40 via React then
Light: light and padding 40, renders 2; 5 alternating switches in ~0.6 s ending dark: dark, padding 40.

Diagnostics added: `misses` (notOurs/noBuffer/source/props/children) in the timings object and in the cold-trial detail when fewer
than all nodes were pre-built. The earlier single trial with 0 pre-built nodes (12.6 ms) has not reproduced in builds 38-40 (all 1500 each time).

Ideas from the SWM "tricky parts" posts (custom shadow nodes, native state, commit hooks): the commit hook is what this engine already uses.
A custom ShadowNode whose component descriptor `adopt` applies the theme would remove the post-mount registration step and the first-frame
flicker for components we own, but not the clone/mount cost, so it would not change the numbers above.

## Build 41 (final): host load was the dominant noise, plus the `prepare()` hint

Build 41 = build 40 + `_lastRoot` (the hook keeps the last committed tree) + `ShadewindEngine.prepare()` (a read-only warm-up pass the
app may call from `onPressIn`; nothing in the unhinted runs below calls it).

Host load matters a lot. `uptime` at the start of the build 41 runs showed load averages 23 / 46 / 38 (Xcode builds and other apps on the
Mac); the build 37-40 cold runs were taken straight after builds, i.e. under that load, which explains the 4-8 of 10 results at or above 10 ms there.

Build 41, Release, iPhone 17 Pro simulator, 1500 views, `hookAsync`, 3 s idle before each cold switch (commit ms):

| run | notes | min | median | max | >= 10 ms |
|---|---|---|---|---|---|
| unhinted 1 | | 1.74 | 1.88 | 2.25 | 0/10 |
| unhinted 2 | | 2.13 | 6.39 | 9.92 | 0/10 |
| hinted (`prepare()` 80 ms before) | | 1.90 | 5.05 | 6.12 | 0/10 |
| unhinted 3 | | 2.34 | 5.10 | 5.25 | 0/10 |
| unhinted 4 | 4 busy host cores (same load as the build 39 control: median 9.76, 4/10) | 1.82 | 5.22 | 7.10 | 0/10 |
| unhinted 5 | | 4.76 | 5.14 | 6.52 | 0/10 |

Unhinted: 50 cold trials, none at or above 10 ms, worst 9.92 ms. Warm x30 on build 41: min 1.84, median 1.96, p90 2.23, max 5.20, 0/30 at or above 10 ms
(its "to screen" marker had one 11.75 ms outlier, 1/30; the marker is a main-queue FIFO block and is not a verified presentation time).

What can and cannot be concluded:
- The matched-load comparison (4 busy cores: build 39 median 9.76 with 4/10 at or above 10 ms, build 41 median 5.22 with 0/10, max 7.10) is the
  cleanest evidence that builds 40/41 are faster than 39 under the same conditions. It is one run per side.
- The hint did not separate itself from the unhinted runs (hinted median 5.05 vs unhinted 1.9-6.4); with this run-to-run spread the effect, if any,
  is not demonstrated. The API stays as an optional, harmless hint; the numbers above do not depend on it.
- One unhinted trial reported `applied=2, precloned=0, miss[2/0/0/0/0]` with a 2.7 ms commit: the stats object is overwritten by whichever hook
  commit last changed something, so that is a stats-read artifact of a small React commit landing in between, not a failed switch.

Correctness on build 41 (freezeOnBlur Home): Light then Dark via Settings -> Home dark, renders 1; padding 16 -> 40 then Light -> light, padding 40,
renders 2; five alternating switches in ~0.6 s ending dark -> dark, padding 40.

Still true: simulator only, iOS only, one scenario (1500 registered plain Views in a flat list), frame gap 17-26 ms is React Native's main-thread mount
plus the demo's own React re-render, memory roughly doubles per registered view node (pre-built buffer) and the hook now also retains the last tree.

## "To screen" follow-up (build 42 = build 41 + per-trial `v` values in the bench output)

Stop-hook review pointed out that the first build 41 cold run showed `to screen ... p90 548.09 max 548.09 | >=10ms: 2/10` and that I left it out of the
summary, and that a warm run had an 11.75 ms `to screen` outlier. Both are real observations from build 41; they are reported here.

What `to screen` is: setTheme call -> a block queued on the main queue behind the commit's mount runs. It marks "the main thread finished mounting the
updated views", not a presented frame. At 60 Hz a visible change cannot be earlier than the next vsync (up to 16.7 ms later), so a literal
"on the glass within 10 ms" is not something this engine or any JS-triggered update can promise.

Build 42 re-runs (Release, simulator, 1500 views, hookAsync, host load average 5.8 at start, down from 23-46 during the build 41 runs):

| run | commit min / median / max | to screen min / median / max | >= 10 ms (commit, to screen) |
|---|---|---|---|
| cold x10 #1, right after app launch (the situation of the 548 ms run) | 1.74 / 2.07 / 6.69 | 1.75 / 2.10 / 6.78 | 0/10, 0/10 |
| cold x10 #2 | 4.57 / 5.70 / 6.70 | 4.61 / 5.78 / 6.80 | 0/10, 0/10 |
| warm x30 | 1.72 / 1.84 / 6.99 | 1.75 / 1.88 / 7.07 | 0/30, 0/30 |

Per trial, `to screen` equals commit time plus 0.0-0.1 ms in every cold trial (e.g. 6.7c/6.8v, 6.1c/6.2v, 5.7c/5.8v) and in the three worst warm trials
(7.0c/7.1v, 2.7c/2.8v, 2.3c/2.3v): the main-thread mount runs concurrently with the commit, so the marker finishes with the commit.

The 548 ms (2 of 10 trials >= 10 ms) and 11.75 ms (1 of 30) values seen on build 41 were not reproduced in these runs and I do not know their cause.
Because the first build 41 cold run did not print per-trial values, I cannot say which trials they were. Tally of `to screen` samples at or above 10 ms
on builds 41-42: 3 (2 in that cold run, 1 warm) out of about 140 (build 41: 6 cold runs x 10 + warm x30 + hinted; build 42: 2 cold runs x 10 + warm x30).
Commit-time samples on the same builds: none at or above 10 ms (worst 9.92 ms).

## Correction: what the earlier "under 10 ms" numbers did and did not measure (builds 45-48)

**Retracted.** Two measurements I reported earlier cannot see main-thread work and must not be read as user-visible latency:
- *Frame gap (rAF).* React Native's `requestAnimationFrame` is a JS-thread timer. It reported 17-18 ms gaps and "0/10 dropped frames" while the main thread was busy for 120+ ms. It only measures JS-thread stalls.
- *"to screen" (`visualMs`).* A block queued on the main queue after the commit. It tracked commit time to within ~0.1 ms because it does not wait behind the mount, so it is not "mount finished" either.

**What is measured now.** A native main run-loop observer (`resetMainBusy()` / `mainBusyMs()`): the longest stretch the main run loop stays awake without returning to sleep, including a period still in progress. Validated on a known-heavy operation: the 1500-row remount reads 190-1500 ms (`R`), so the probe does see heavy main-thread work.

**Findings (Release, iPhone 17 Pro simulator, 1500 registered views, cold switch after 3 s idle, 10 trials per run):**

| configuration | main-thread busy after the switch (max within 1.5 s) |
|---|---|
| hookAsync, bordered cards without clipping (`overflow` visible) | 117-174 ms (one 777 ms) |
| hookAsync, `overflow: 'hidden'` ("clip") | 13-39 ms (one 1215 ms stall in 10 trials) |

Cause of the large cost: for a view with `borderWidth > 0` and an opaque border colour that is not clipped, RCTViewComponentView takes the bitmap border path (`RCTGetBorderImage` through `RCTAddContourEffectToLayer`) on every `invalidateLayer`. With `clipsToBounds` it uses `layer.borderColor`/`cornerRadius` instead. My earlier "overflow hidden is slower" result was measured with commit-thread timing, which cannot see this, so it was wrong. Recommendation: clip themed views that carry a border.

**Paint-first path (`setTheme(name, 'native')`).** A UIKit pass on the main thread sets `backgroundColor` on the mounted views by React tag; the shadow-tree commit follows in the background. New timing `paintMs` = setTheme call to that pass finishing.

Per-run results (clip on, native colour pass, cold x10, main-thread-quiet precondition):

| run | call to colours applied (min / median / max) | at or above 10 ms | main busy in first 300 ms (max) | busy over 16.7 ms |
|---|---|---|---|---|
| build 48 run 1 (fresh launch) | 1.45 / 7.40 / 1167.9 | 1/10 (trial 1) | 317.6 | 1/10 (trial 1) |
| build 48 run 2 (warm process) | 2.88 / 6.72 / 7.81 | 0/10 | 226.9 (trial 1) | 1/10 (trial 1) |
| build 48 run 3 (fresh launch) | 1.50 / 7.30 / 8.00 | 0/10 | 7.1 | 0/10 |
| saved flow `qa-theme-switch-paint`, 4 consecutive runs, fresh launch each | every check passed (0/10 at or above 10 ms, 0/10 busy over one frame) | 0/40 | - | 0/40 |

So 5 of 7 runs were clean and 2 had a stall in their first trial (the one that delayed paint by 1.17 s, the other 227 ms of main-thread work after the paint). Both stalled runs came before the 4 saved-flow runs and 1 clean run; the cause is not identified. A profile taken to find it was spoiled by BS One (another app) coming to the foreground, so no cause is claimed. Hypotheses not tested: first-time creation of 1500 native views (recycling pool) and one-time Core Animation layer work.

The Fabric mount that follows the paint still keeps the main thread busy for about 25-39 ms (clip on). Colours are already on screen by then, but the main thread cannot render a frame during it, so scrolling or animation can hitch for 1-3 frames right after a switch.

**What the user-visible claim is, precisely.** With `'native'` strategy, clipped bordered views and the main thread free, the colours of 1500 views are applied within about 1.5-8 ms of the `setTheme` call in 69 of 70 measured cold trials (3 build 48 runs plus 4 saved-flow runs); the one miss is trial 1 of build 48 run 1 (1167.9 ms), and trial 1 of run 2 also had a 227 ms main-thread block after its paint. The native pass sets `backgroundColor` only; border and text colours change when the shadow-tree commit mounts (~30-40 ms later), and nothing is painted by it for views that are not mounted. The default strategy remains `hookAsync` (commit in about 2-10 ms, visible change after the full mount); `'native'` is opt-in.

**Saved QA flow.** `.argent/flows/qa-theme-switch-paint.yaml` (replaces the earlier cold flow that asserted the invalid metrics). It records launch -> Benchmark -> 1500 views -> clip on -> cold x10 native, waits 80 s without reading the tree (tree reads load the main thread), then hard-checks the report: `>=10ms: 0/10 | commit n=10` (the to-paint 0/10 clause) and `(a dropped frame): 0/10;`. Run with `flow-execute` on this device; both checks fail the flow if any trial misses. Two consecutive passes after a service recycle, then two more passes: 4 of 4.

## Build 49: paint-first is now the default

`setTheme(name)` now defaults to `'native'` (UIKit colour pass, then the background commit); `hookAsync` remains available explicitly. The native pass only touches `RCTViewComponentView` instances, so a UIKit-owned view with the same `tag` is never recoloured.

Flow `qa-theme-switch-paint` on build 49: first run after the fresh install FAILED (the tap on `bench-cold10-native` landed on the `react` mode button, "mode changed", so the cold run never started: an automation mis-tap, not a measurement); the immediate re-run of the unchanged YAML PASSED. Earlier on build 48: 4 of 4 passed. Tally for this flow: 5 passes, 1 failure.

Not done: numeric assertions on the report's `max` values (to-paint max single digit, main busy max < 17 ms) were planned but not added; the correctness flow (frozen Home, padding, rapid toggles) was not re-verified on the new default; the first-trial stall cause is still unknown; Android, more than two themes and the border/text colour path of the native pass are untested.

## Correctness re-check on build 49 (default `native` strategy), iPhone 17 Pro simulator

Manual run through the Inspect probe on the frozen Home (freezeOnBlur):

- Dark -> Light via Settings -> Back: Home light, renders unchanged while frozen, `treeOK=31 nativeOK=31`. Pass.
- Single Light switch after a 1.5 s idle (second run): `theme=light treeOK=31 nativeOK=31`. Pass.
- Padding 40 then Dark -> Light -> Dark within about 0.5 s (rapid toggles), Back, Inspect: **fails**. `theme=dark`, `treeOK=31` then `treeOK=30` on a second Inspect with no theme change (tag 218, the screen background, read light while the theme is dark), and `nativeOK=0`: the UIKit background of 10 registered views read white while expected dark. The screen looked dark in the screenshots, so this is a state mismatch the eye did not show, but it is a real inconsistency.

Status: rapid toggles on the new default path are not correct yet; the earlier "rapid toggles pass" result came from the old default (`hookAsync`). Not investigated further: whether the stale native colour comes from a superseded native pass finishing after the newer one (needs a generation counter on the pass) or from the Inspect probe reading mid-commit. Android, more than two themes and the text/border colour path remain untested.

Reading `setTheme` (cpp/HybridShadewind.cpp) and `applyBackgroundsOnMain` (ios/ShadewindNative.mm) for the rapid-toggle failure: the native passes are FIFO on the main queue and capture their colours at call time, so they cannot reorder among themselves. The commits, however, run on a concurrent global queue (`QOS_CLASS_USER_INTERACTIVE`), and each reads the hook's theme when it executes, then queues its mount on the main queue. A commit that read `light` can mount after the last `dark` native pass and restore light UIKit backgrounds, with no later write fixing them if the final commit's diff against the shadow tree is empty. This is a hypothesis, not confirmed. Next step: log (theme at commit, theme at mount) per commit during a rapid dark/light/dark, or serialise the commits on one serial queue and re-run the three-toggle check.

## Port of the uniwind-benchmarks theme scenario (example/src/TheirBench.tsx)

Their screen (header card + 1000 items, 2003 views), their config (10 theme changes, 100 ms apart), their timing
(`performance.now()` at the theme call until `requestIdleCallback`), their colours (apps/uniwind/global.css), including the
Text colour of every item. Launched at the root, no navigation stack, with `-theirBench 1`. Release, iPhone 17 Pro simulator
(iOS 26.5), one launch per strategy (their protocol is the median of 6 warm launches; this is not that).

| strategy | their metric (call -> JS idle), avg of 10 | call -> mounted on main (visualMs), avg / max | correctness after run |
|---|---|---|---|
| `hook` (sync commit on the JS thread) | 8.67 ms (min 8.40, max 9.10) | n/a (the commit is done when the call returns) | treeOK 2002/2002 |
| `hookAsync` | 0.04 ms | 13.78 / 59.24 ms | treeOK 2007/2007 |
| `native` | 0.26 ms | 12.05 / 32.78 ms | treeOK 2007/2007 |

Tamagui 25.9 ms, Unistyles 47.1 ms, Uniwind 93.2 ms.

Caveats: different host and simulator; one launch; the async strategies return to JS almost immediately, so "their metric"
understates them, which is why visualMs is reported; the three-toggle failure above is not exercised here (switches are 100 ms
apart and the runs ended consistent).

### Same-machine comparison with their free Uniwind app

Built `apps/uniwind` of uniwind-benchmarks (Uniwind 1.12.0, Release) and ran its theme scenario (`-benchmarkScenario theme`) on the
same iPhone 17 Pro simulator as the port above: 91.61 ms and 102.63 ms (two warm launches, min 67.6 / 85.0, max 110.7 / 119.1).
Their published number for this app is 93.19 ms, so this machine is close to theirs for this workload.

| | theme switch, 2003 views, their metric |
|---|---|
| Uniwind 1.12.0 (their app, this machine) | 91.6 / 102.6 ms |
| this engine, `hook` | 8.67 ms |
| this engine, `hookAsync` / `native` | 0.04 / 0.26 ms to JS idle; 13.8 / 12.1 ms until mounted |

### Correction (Opus review of the rapid-toggle claim): the "stale native pass" hypothesis above is withdrawn

- `inspect()`'s `native=` / `nativeOK` reads `family->nativeProps_DEPRECATED["backgroundColor"]` (cpp/HybridShadewind.cpp:483-490),
  RN's props overlay, NOT the UIView. `applyBackgroundsOnMain` never touches it. Under `hook`/`hookAsync`/`native` nothing in
  this library refreshes the overlay, so `nativeOK` can read stale light values at any toggle speed. The `nativeOK=0` half of the
  "failure" is a probe artifact until UIKit is read directly.
- A generation counter would change nothing: setTheme captures colours synchronously and the main queue is FIFO, so the last
  pass is always the last call's colours.
- Still unexplained: tag 218 read tree=light on a second Inspect with no theme change (treeOK 31 -> 30). Candidates: the hook
  skipped it, or a ref detach/attach around freeze/reveal re-registered it (src/index.tsx useThemedRef, ThemeHook::add).
- Side finding: `RCTViewComponentView -setBackgroundColor:` only stores an ivar (RCTViewComponentView.mm:131-134); the layer is painted in
  `invalidateLayer` on finalizeUpdates. So the native pass may paint nothing until the Fabric mount, and `paintMs` would measure
  an ivar store. To verify: read [view backgroundColor] and the layer colour on the main queue per registered tag.

### Re-check with the UIKit probe (build 50, iPhone 17 Pro simulator, default `native`)

`inspect()` now reads `UIView.backgroundColor` per registered tag on the main thread (`viewOK`) and `layer.backgroundColor`
(`layerOK`). `native pass` also builds its colour map off the main thread and creates one UIColor per distinct colour.

- Single switch after idle (Light -> Dark via Settings, Back, Inspect): `treeOK=31 viewOK=31`.
- Rapid taps in Settings (Light, Dark, Light, Dark, 120 ms apart), Back, Inspect: `treeOK=31 viewOK=31`, screen dark.
  The Home render counter and the report text were identical to the previous run, so the taps' effect is not independently
  confirmed (same end state as the start). The earlier `nativeOK=0` / tag 218 anomaly did NOT reproduce.
- `layerOK=1`: `layer.backgroundColor` is nil for most views (RN paints another way or later), so `layerOK` is not a usable
  check; the screen was visibly dark. Needs the real paint path (`_backgroundColorLayer`) to be read.
Conclusion so far: no UIKit-level inconsistency observed; the earlier "failure" is consistent with the overlay probe artifact.

### Perf re-run on build 50 (TheirBench port, one launch, iPhone 17 Pro simulator, Release)

| strategy | JS-idle avg (min-max) | call -> mounted avg / max | UIKit check after run |
|---|---|---|---|
| `hook` | 8.60 ms (8.16-8.87) | n/a | treeOK 2002/2002, viewOK 2002, layerOK 2002 |
| `hookAsync` | 0.03 ms | 12.92 / 45.47 ms | 2007 / 2007 / 2007 |
| `native` | 0.46 ms (0.40-0.49) | 13.33 / 48.58 ms | 2007 / 2007 / 2007 |

vs build 49: `hook` 8.67 -> 8.60 (noise), `native` JS-idle 0.26 -> 0.46 ms (the colour map and palette are now built on the
JS thread instead of the main thread), visual 12.05 -> 13.33 ms (within run-to-run spread; no gain visible at this level).
Main-thread time of the pass itself is not reported by this screen.

engine `hook` 8.6 ms and free Uniwind 91.6-102.6 ms on the same machine and metric. Published Pro 1.8.1: 7.7 ms (other machine).

## Deep dive: where the 8.6 ms of `hook` goes (Instruments, build 51, 2003-view TheirBench, 5 runs x 10 switches)

JS thread, 1151 samples, of which `HybridShadewind::setTheme` = 398 (about 35%, the rest is timers / React / GC):

| inside setTheme -> commitTick -> ShadowTree::commit (400 samples) | samples | share |
|---|---|---|
| `RootShadowNode::layoutIfNeeded` -> `YogaLayoutableShadowNode::layoutTree` (Yoga `calculateLayout` 222) | 297 | **74%** |
| `UIManager::shadowTreeWillCommit` (our hook: walk + clone) | 105 | 26% |

So the engine's own work is about a quarter of a switch (about 2.0-2.6 ms of 8.6); about three quarters is React Native running
a Yoga layout pass that cannot change any size.

Why layout runs: every clone of a `MeasurableYogaNode` (Paragraph/Text) goes through `YogaLayoutableShadowNode::completeClone`, which
marks it dirty unconditionally (`shouldNewRevisionDirtyMeasurement` returns true), and dirty children dirty their ancestors
(`updateYogaChildren`). View clones are NOT dirtied when the Yoga style is unchanged. So the layout cost comes from the Text colour.

Main thread (4947 samples): text redraw dominates the app work (`RCTParagraphTextView drawRect:` 1259,
`RCTTextLayoutManager drawAttributedString:` 383, `_textStorageAndLayoutManager...` 590); the rest is accessibility traversal
caused by the tooling (AX `accessibilityElements` microhangs), not the engine.

Constraint found: skipping the layout pass is not safe for Text. `ParagraphShadowNode` rebuilds its AttributedString (which holds
the foreground colour that `RCTParagraphComponentView` draws) inside `layout()`, so a text colour change needs that node laid out.

Candidate levers (not done yet), in order of expected gain:
1. Backgrounds-only themes (views, no Text colour) should avoid the layout pass entirely; verify by measuring with Text excluded
   (my `-noText 1` run still reported registered=2002 / views=2002, so that switch did not take effect: inconclusive, needs a fix).
2. For Text: update only the Paragraph `State` (new AttributedString with the colour) instead of cloning with new props, so the node
   does not need a re-measure; needs a look at `ParagraphShadowNode::updateStateIfNeeded`/`buildAttributedString` and a way to keep
   the Yoga node clean (it is a protected member).
3. Keep layout dirty-propagation short: today every dirty Text dirties its item View and the scroll content.
Measured numbers above come from one profiled session (profiler overhead raises the JS-idle average from 8.6 to about 12.8 ms).

## Text colour without a layout pass (build 53, cpp/ThemeHook.hpp `recolorParagraph` / `cloneThemed`)

Change: when a themed clone only changes a Paragraph's colour, the hook builds the new `ParagraphState` itself (previous
AttributedString with the foreground colour replaced, only on fragments that carried the paragraph's old colour) and clears the
clone's Yoga dirty flag (`YogaAccess`, protected-member access). No layout pass is needed because a colour cannot change a size
and the state `layout()` would have produced is already in place. Falls back to the normal path when the source node is dirty,
has no state, or its children are replaced.

Same TheirBench port, `hook`, Release, iPhone 17 Pro simulator, 2003 views:

| build | JS-idle avg | median | min-max | commit / clone (engine) |
|---|---|---|---|---|
| 50/51 (layout runs) | 8.60 ms (8.2-8.9); 11-12 ms on a cold first run | 8.63 | 8.16-8.87 | commit ~12 (profiled) / clone 2.5 |
| 53, launch 1 | 4.23 ms | 3.82 | 2.64-9.88 | commit 4.17 / clone 3.95 |
| 53, launch 2 | 3.42 ms | 2.93 | 2.04-9.66 | commit 3.36 / clone 2.41 |

Checks after the run: treeOK 2002/2002, viewOK 2002/2002. Pixel check with Dark / Light buttons: item and header text turn white
in dark and black again in light; backgrounds follow.

Not covered: the main thread still redraws every Paragraph (state change -> drawRect), which the JS-idle metric of the `hook`
strategy does not include; Home/Settings frozen-screen flow and rapid toggles were not re-run on this build; Android not touched.

### Where the remaining ~3.5-4.5 ms of `hook` goes (build 54/55, profiled; `hook` now also reports reused/precloned/misses)

JS thread, 841 samples over 5 runs: `setTheme` 138, of which 137 is `commitTick` and all of that is the commit hook
(`walkTree` 136: `cloneThemed` 102, of which `recolorParagraph` 18 and `createState` 2; `ShadowNode::clone` 115 incl. 41 in
`YogaLayoutableShadowNode::cloneChildInPlace`). Layout is gone from the switch (the 53 `layoutIfNeeded` samples belong to the benchmark
screen's own React commits). So the switch is now essentially the engine's clone work for ~3000 nodes.

Pre-built nodes are not being used: per switch `reused 2002 precloned 0 misses (notOurs/noBuffer/source/props/children) 0/0/1001/0/1001`.
- 1001 children-replaced: each themed item View has a themed Text child, so its clone gets a new children list and cannot take a
  pre-built node (by design: a pre-built node carries the old children).
- 1001 source mismatch: the Paragraph in the new tree is not the node we pre-built from. RN re-clones a themed child when its Yoga owner
  differs (`cloneChildInPlace`), so `pre.source` (the node we produced) is no longer the live node.
Ideas, not done: pre-build the item View together with its new child (one buffered subtree), and make the pre-built Paragraph the
node RN keeps (set the Yoga owner before it is handed to the parent) so it is not cloned a second time.

Latest `hook` runs on this build: 4.47 ms (median 4.92, 3.15-6.40) with reused/precloned stats on; earlier runs 3.42 / 4.23 / 4.32.
Run-to-run spread is about +-1 ms.

## Removed: the `native` strategy (build 57)

The UIKit colour pass (`applyBackgroundsOnMain`) is gone, `hookAsync` is the default strategy. Reasons: no measurable gain (mounted
3.24 ms vs 2.84 ms for `hookAsync`, JS idle 0.58 vs 0.05 ms), it walked every UIView of every window per switch (does not scale
with app size), it wrote behind Fabric's back, and `RCTViewComponentView -setBackgroundColor:` only stores an ivar, so it very
likely painted nothing earlier. Kept: `readBackgroundsOnMain`, the debug read behind `inspect()`'s `viewOK` / `layerOK`.
Check after removal: Home -> Settings -> Dark (default strategy) -> Back with the frozen Home: treeOK 31/31, viewOK 31/31;
TheirBench `hook` 4.66 ms (median 3.95).

## Android port (build 58)

Needed to build and be correct on Android:
1. `android/CMakeLists.txt`: add the per-component `platform/android` header directories from the ReactAndroid prefab (React
   Native's own CMake does the same); `HostPlatformParagraphProps.h` was not found otherwise.
2. `Color` is an `int` on Android (a class on iOS): `colorBits()` handles both; busy-probe globals moved out of the iOS-only block.
3. `android/build.gradle`: removed `apply plugin: "com.facebook.react"`; with it the library module generated duplicate classes of other
   libraries (`RNCSafeAreaProviderManagerInterface defined multiple times`).
4. `recolorParagraph`: `dynamic_cast<ConcreteState<ParagraphState>>` fails across React Native's shared libraries on Android (all
   1001 paragraphs hit "state type mismatch"); a `static_cast` guarded by the component name works (recolor 1001/0/0).
5. Backgrounds did not change on screen even though the tree was right: Android's mounting layer sends `Props::rawProps`, not the
   typed fields. `applyRawFields` now merges the theme's raw props into `rawProps` (`RN_SERIALIZABLE_STATE`). After that Dark/Light
   are correct for backgrounds and text.

Open: `hookAsync` has no background executor on Android; `viewOK`/`layerOK` probes are iOS-only; run on a physical device.

## Opus advice applied (pre-clones removed, background commit fixed)

- **Pre-built nodes are gone** (`scheduleBuildPreclones`, `buildPreclones`, `Slot::pre`, `touch()`/`prepare()` warming, `setAsync`):
  the builder cloned the very nodes the same commit was about to lay out (hooks run before `layoutIfNeeded`), a data race on
  `children_` / `state_` / `yogaNode_`; and the feature never paid off (`precloned 0`, structural `missChildren` for every themed
  view with a themed child). The per-theme `produced` props cache stays (that is the `reused 2002` win).
- **Background commits use `mountSynchronously = true`.** `false` made an off-thread commit write to RuntimeScheduler queues
  that only the JS thread may touch, and delayed the mount to the next JS tick (see the correction in BENCHMARK.md).
- **No `dynamic_cast` for Yoga nodes / ViewProps**: `static_cast` guarded by the Paragraph component name or the `ViewKind` trait.
- **The background lambda holds a `weak_ptr<UIManagerBinding>`** so a GCD thread can never drop the last reference of an object
  that owns a `jsi::Function`.
- **Text recolour:** when no fragment carries the old colour but one already carries the new one (a React commit re-rendered
  the Text with the old colour while the state was already recoloured), the state is kept and the node stays clean; only when
  neither colour is present does layout produce the state (reason 8). Without this a plain React re-render during a switch sent
  1000 paragraphs through layout (visual 12 ms).
- Open: hook lifetime across Fast Refresh (own the hook in the UIManager's ContextContainer), Android background executor on a
  serial JNI-attached thread plus a `UIManagerMountHook` for "mounted", whole-tree walk pruning (see PLAN.md).

## Stale Home after a freeze: found and fixed (2026-10-15, iPhone 17 Pro simulator, Release)

Setup: `freezeOnBlur: true` on the bottom tabs of `example-real`, an always-mounted probe in `App.tsx` that prints `inspect()` (plain styles, so the
engine never registers it). Sequence: Account -> Dark -> Home (reveal) -> Account -> Light, Dark, Light (150 ms apart) -> Home, run twice.

Before: Home stayed dark while the theme was light, `reg=174 inTree=174 treeOK=97 viewOK=97` (reproduced 4 times with the same numbers).
`inspect()` now also lists `stale`: the hook's own state for each wrong view: `ep=9/9 app==cur:1 base==cur:1 delta:1 prod:0`. The hook believed
the view was already applied for the current epoch and that the props in the tree were its own, but the tree held the old theme's props.

Cause: after a freeze the ref re-attaches and registers again with `renderTheme` = the theme of the cached plan. That equals the current
theme, so `ThemeHook::add(... renderedWithCurrentTheme = true)` marks the view applied with `base = the props the tree holds now`. Those props
were re-themed by the hook before the freeze, so the claim is false and no later commit touches the view.

Fix (src/uniwind/useShadewindStyle.ts `renderThemeFor`, used by the holder ref and by aot.ts): pass the render theme only on a node's first attach.
A re-attach registers without it, so the next commit applies the current theme.

After: the same sequence, run twice, `treeOK=174 viewOK=174`, correct colours on screen.

Not measured: the cost of the extra re-theme commit on each reveal, Android, a dynamic className change on an attached view (it also counts as a
re-attach now and gets one extra clone), and `useThemed` in `src/index.tsx`, which has its own stale `theme` closure.

Method warning: `example-real` installs `shadewind` from `vendor/shadewind-0.1.0.tgz` and consumes the compiled `lib/module`, not `src/`. Edits to `cpp/` or
`src/` only reach the app after copying `cpp/`, `src/` and a `bob build` output (`lib/`) into `example-real/node_modules/shadewind` and rebuilding.
