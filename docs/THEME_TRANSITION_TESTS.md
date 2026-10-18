# Theme transition: device checks (F8)

For an agent that reviews or re-runs the non-device checks: `docs/THEME_TRANSITION_AGENT_REVIEW.md`.

Nothing here was run on a device. The code was written and reviewed in a Linux container without Xcode, an Android SDK or an
emulator: the TypeScript is typechecked, the ObjC++, Kotlin and JNI are not compiled. Run these on the Mac, in this order, and
record the file names and frame numbers next to each item (30 fps = 33 ms per frame).

How it works, for reading a failure: `setTheme(name, { transition })` queues a window snapshot on the main / UI thread
(`themeTransitionBegin`), commits the theme, and fades the snapshot out when Fabric's mount hook reports a tree that ThemeHook
returned for the new epoch (`ThemeTransition::shadowTreeDidMount` -> `themeTransitionRun`). A native timer fades it anyway after
1 s. Design notes: `docs/GUIDE.md` ("Animated switch"), sources `cpp/ThemeTransition.hpp`, `ios/ShadewindNative.mm`,
`android/.../ThemeTransitionOverlay.kt`.

## Build

Follow the task's section 5 (`prepare`, `npm pack`, install; `example-real/README.md` has the lockfile step). example-real:
`bash scripts/arm.sh engine`, then on iOS launch with `-themeTransition 250` (add `-themeTransitionType blur` for blur); on Android
arm with `SHADEWIND_TRANSITION=blur:250 bash scripts/arm.sh engine` (or `fade:250`) and rebuild. That sets the Uniwind default and
shows the "Theme transition (test)" row on Account: `hookDeferred` (Uniwind.setTheme), `hookAsync` (the engine alone; Uniwind is
not told) and `Toggle ×3`. Without it nothing changes.

tovtam calls `Uniwind.setTheme` with no options, so it is instant by default. To see the fade there without editing its
source, set the default once at startup (your call, in your own branch): `setDefaultTransition({ type: 'fade', durationMs: 250 })`
from `shadewind`.

## Checks

1. **Cross-fade.** Record the Account switch (example-real, iOS) and the tovtam theme sheet (iOS and Android). Crop the whole
   screen, per-frame `signalstats` YAVG: monotonic between the two themes over about `durationMs`, no jump, no frame where part of
   the screen is already new beneath the fade. Expected: the first frame with the new theme underneath is also the first frame of
   the fade (iOS: the mount hook runs in the main-queue turn after the mount).
2. **Taps pass through.** Tap a button in the first 100 ms of a fade; it must react (the overlay is `userInteractionEnabled = NO`
   on iOS, not clickable on Android).
3. **Rapid toggles.** "Toggle x3" (switches at 0, 70 and 140 ms). Afterwards: `native-find-views` (iOS) / `uiautomator dump`
   (Android) show no snapshot view left on the window (iOS: no `_UIReplicantView`/snapshot subview of the key window; Android: no
   `ImageView` that is a direct child of the DecorView), and the app is in the last theme. Also repeat after a cold start.
4. **Both strategies.** The `hookDeferred` and `hookAsync` buttons. Both must start the fade only after the new
   theme is visible: if you see the old theme fade into the old theme, the mount signal fired too early.
5. **Reduce motion.** iOS Settings > Accessibility > Motion > Reduce Motion; Android `settings put global animator_duration_scale 0`.
   Instant switch, no overlay. Restore both afterwards.
6. **No option, no cost.** Launch without `-themeTransition`: the Account "Measure 12 theme switches" numbers must match a
   build without the transition code of the same `hookDeferred` (the old baseline, sync 6.3-7.4 ms, idle about 15 ms, stall median
   about 17.6 ms, was measured before `hookDeferred` stopped committing on its own: `sync` is now expected near 0 and the engine's
   work moves into React's commit, inside `idle`). No hook is registered and the commit does not record mounts until the first
   transition is requested.
7. **Hidden tab.** Switch while a frozen tab is hidden, reveal it: no stale frame (HANDOFF "freeze sequences").
8. **Colours React renders change with the engine's views** (no transition). A screen with a colour read through
   `useResolveClassNames('text-primary')` or `useCSSVariable('--color-primary')` next to engine-bound views. Switch three ways:
   a press handler, a `setTimeout(() => Uniwind.setTheme(...), 0)` and the system appearance (Uniwind's adaptive themes). In each
   recording the first frame with the new theme must have both changed. Before the change only the press handler did (React
   rendered the other two in a later task, after the engine had mounted its own commit).

## Blur preset (`type: 'blur'`, example-real `-themeTransitionType blur`)

Not run on a device. Check: the old screen blurs for the first half of `durationMs`, then snapshot and blur fade out together, with
no jump when the blur ends. iOS: a `UIVisualEffectView` over the snapshot, its effect animated nil -> system material -> nil (its alpha
is never animated: an effect view with alpha < 1 renders wrongly). Risks: the material tints with the SYSTEM appearance, so an app
theme opposite to the OS appearance (dark theme on a light OS) may flash a light tint; a snapshot taken while a previous blur is
still on screen may not contain the blur. Android 12+: `RenderEffect` blur of the overlay view, radius 20 dp, animated per frame;
below 12 it is a plain fade (check with an API 30 emulator).

## Risks to check explicitly

- **Fade starts late (about 1 s).** Symptom: the theme flips, the overlay stays, then fades about 30 frames later. Cause: the
  mounted root is not the pointer ThemeHook returned (another commit hook, e.g. from Reanimated, runs after ours and clones the
  root), or the commit mounted nothing. Check with a tovtam recording.
- **Android hardware bitmaps.** `View.draw` into a software canvas cannot draw `Bitmap.Config.HARDWARE` bitmaps (image libraries
  use them on API 26+). Look for `theme transition skipped` in logcat on a screen full of images; the switch itself still works.
- **Android Modal / Dialog windows.** A React Native `Modal` lives in its own window; the DecorView snapshot does not contain it,
  and the overlay sits under it. Check what tovtam's theme sheet is (a `Modal` would break check 1 on Android).
- **Android race.** The snapshot is an asynchronous message sent at setTheme time; if Choreographer's mount runs first the
  snapshot shows the new theme (no visible transition, not a corruption). `mountedId` skips the case where the mount
  notification overtook the snapshot message. Android pulls the transaction on the committing thread, so a mount notification of an
  earlier batch can report the theme's tree before its views are updated: `run` therefore waits one Choreographer frame callback
  (FabricUIManager re-posts its mount-item callback every frame, ahead of ours). Check by stepping 3 toggles frame by frame: the
  fade must not begin before the new theme is underneath. A fade that looks absent on a slow device is this race.
- **Rapid toggle while a fade is running (iOS).** The new snapshot is expected to include the partly faded old overlay; if
  `snapshotViewAfterScreenUpdates:NO` reads model values instead of presentation values, you see a pop. Record it.
- **Memory.** One full-window bitmap (Android ARGB_8888) or snapshot view per transition: about 8 MB on a 1080x2400 phone, freed
  when the overlay is removed. Large tablets / foldables: measure.
- **Not covered:** `SurfaceView` / `TextureView` content (maps, video) on Android is missing from the snapshot; secure windows
  return no snapshot on iOS (instant switch); iPad multi-window uses the key window of the foreground scene only.
