# Theme-change benchmark: this engine vs Uniwind

Scenario: the `uni-stack/uniwind-benchmarks` theme-change screen. 2003 views (header card + 1000 items, item text themed too),
mounted once, then switched dark/light 10 times, 100 ms apart. Each change is timed from the theme call until the JS thread is
idle (`performance.now()` + `requestIdleCallback`), the app shows the average.

Protocol (their method, shortened): Release builds, same iPhone 17 Pro simulator (iOS 26.5), one cold launch discarded, then
3 warm launches (terminate + relaunch), each started with `-benchmarkScenario theme`; median of the 3.

## Results (this machine, run back to back)

"JS idle" is their metric (theme call until the JS thread is idle). "Mounted" is call until the main thread finished mounting it
(only measured for the engine's async strategies; the other libraries do not report it).

| Library | Version / strategy | Launch 1 | Launch 2 | Launch 3 | **Median (JS idle)** | Mounted (median) | vs `hook` |
|---|---|---|---|---|---|---|---|
| **This engine, `hook`** | build 56 | 4.50 ms | 4.89 ms | 4.88 ms | **4.88 ms** | n/a (sync commit) | 1.0x |
| **This engine, `hookAsync`** | build 56 | 0.05 ms | 0.05 ms | 0.06 ms | **0.05 ms** | ~11-12 ms (corrected, see below) | JS thread free |
| Uniwind (free) | 1.12.0 | 106.46 ms | 103.62 ms | 101.96 ms | **103.62 ms** | n/a | 21x slower |

Mounted per launch (`hookAsync`), build 56: 2.65 / 2.84 / 3.02 ms (**incorrect**, see the correction below); corrected build: 11.99 / 11.24 ms. The former `native` strategy (UIKit colour pass + commit) measured
3.05 / 3.24 / 3.36 ms mounted and 0.54-0.58 ms JS idle, i.e. no gain over `hookAsync`, and was removed.
Per-run spread (min - max of the 10 changes in one launch): `hook` 2.6-14.3 ms, `hookAsync` 0.04-0.13 ms,

## Published numbers for reference (their machine, iPhone 18 Pro Max simulator, iOS 27)

| Library | Theme change |
|---|---|
| Tamagui 3.0.3 | 25.92 ms |
| Unistyles 3.5.3 | 47.12 ms |
| Uniwind 1.12.0 | 93.19 ms |
| NativeWind 4.2.7 | 127.57 ms |
| NativeWind 5.0.0-rc.0 | 211.69 ms |

Their free Uniwind number (93.2 ms) and ours (101.96-106.46 ms) are within about 10-14%, so this machine is close to theirs for this
workload.

## Android (this machine, Pixel_8_Pro AVD, arm64, Release)

Same screen and metric. Launched with a VIEW intent `uwbench://theme[?strategy=hook]`; cold launch discarded, 4 / 3 warm launches,
result read through `uiautomator dump`.

| Library | Version / strategy | Warm launches | **Median (JS idle)** | vs engine |
|---|---|---|---|---|
| **This engine, `hook`** | build 58 | 7.04, 7.46, 7.23, 7.81 ms | **7.35 ms** | 1.0x |
| Uniwind (free) | 1.12.0 | 299.58, 325.35, 302.91 ms | **302.91 ms** | 41x slower |

NativeWind 4 123.33 ms.

Notes:
- This emulator is about 5x slower than theirs for the free Uniwind app (303 ms here against their 59 ms), so absolute numbers
  are not comparable with the published ones; only the same-machine ratio is.
- `hookAsync` on Android currently commits synchronously (no background executor yet), so it measures the same as `hook`.
- The engine's `viewOK` / `layerOK` probes are iOS-only; Android correctness was checked by tree check (2002/2002) and pixels
  (Dark and Light: backgrounds and text follow the theme).
- Before the Android fixes (rawProps kept in step, Paragraph state recolour without layout) the same screen read 10.8-11.8 ms.

## Correctness after each engine run

treeOK 2002/2002, viewOK 2002/2002 (UIView background), layerOK 2002/2002. Pixel check (Dark / Light): item and header text and
backgrounds follow the theme in both directions.

## Caveats

  this engine would be about 1.6x faster, but it is a different machine, so treat it as indicative.
  the floating theme switcher removed; Expo SDK 56 / RN 0.85.3 versus RN 0.86 for the other two.
- The engine's `hook` strategy commits synchronously, so the number includes the whole commit. The text redraw on the main thread
  after the switch is not part of this metric for any library (the same holds for plain Uniwind).
- Three warm launches per library, one sweep (their method uses two sweeps, order A and reversed B). Simulator only, iOS only.

### Android: run-to-run machine variance (2026-10-14)

After the review fixes the same screen read 40-55 ms on the emulator instead of 7.0-7.8 ms. An A/B on the same emulator, installing
the APK from before and after the fixes alternately, gave old 48.3 / 41.8 / 52.4 / 46.4 ms and new 46.8 / 52.0 / 55.3 / 46.2 ms:
the fixes cost nothing measurable, the emulator (or the host) was simply in a slow state (host load 5+, freshly rebooted AVD, three
iOS simulators booted). Android numbers need a quiet host and a warmed emulator, and should always be reported next to a same-run
baseline (free Uniwind) rather than as absolute milliseconds.

### Correction: the "call to mounted" time of `hookAsync` (2026-10-14)

The 2.7-3.0 ms "mounted" figures were an artifact. The background commit used `mountSynchronously = false`; off the JS thread that
queues a rendering update on the RuntimeScheduler (whose queues only the JS thread may touch) and the actual mount happens at the
JS thread's next tick, after the `runOnMain` block that stamps the time. With `mountSynchronously = true` (what React Native itself
uses for commits made off the JS thread) the mount is dispatched to the main queue during the commit, the stamp runs after it, and
the measurement is 11.2-12.0 ms (max 13.7-15.8 ms) for 2003 views on the iOS simulator. The "JS idle" numbers (0.05-0.08 ms for
`hookAsync`, 3.6-4.9 ms for `hook`) are not affected. Practical reading: `hookAsync` frees the JS thread and the screen updates in
about 11-12 ms; `hook` returns after 3.6-4.9 ms but includes only the commit, not the main-thread mount, in its number.

## Android with the Uniwind adapter (2026-10-14)

`uniwind-benchmarks/apps/uniwind` (unmodified app code, `className`), `withShadewind` + `shadewind/uniwind`, Release arm64,
emulator Pixel_8_Pro, intent `uwbench://theme`:

| Run | Average | Min | Max |
|---|---|---|---|
| 2003 views x 10 theme changes | 14.59 ms | 6.40 ms | 31.53 ms |

Notes: Android commits synchronously on the JS thread (no background commit yet), so this is the full hook cost. Different
AVD and no same-run plain-Uniwind run, so it is not comparable to the 303 ms of the earlier emulator; the final colours were
not pixel-checked for every switch. The public-API example (Home/Settings, Rapid x7, frozen Home) is correct on this emulator
(`treeOK 31/31`; `viewOK` has no Android probe and reads 0).

## Baseline before the next task (2026-10-14, iOS simulator iPhone 17 Pro, iOS 26.5, Release, commit 5233774 + ClassMerge hash change)

Theme switch, 2003 views x 10 changes, one cold launch discarded. Only 2 warm launches per strategy (not the 3 of the protocol).

| Strategy | Warm launch 1 | Warm launch 2 | JS idle median | Mounted avg | treeOK / viewOK / layerOK |
|---|---|---|---|---|---|
| `hook` | 3.20 ms | 3.22 ms | **3.21 ms** | n/a (sync) | 2002 / 2002 / 2002 |
| `hookAsync` | 0.04 ms | 0.04 ms | **0.04 ms** | 10.01 / 9.74 ms | 2002 / 2002 / 2002 |

`cn` on Hermes (ns/call, one run, 5,603 cases): clsx+twMerge 17,791; cnfast 2,043; Nitro zero-copy 845; `__swCn` 634;
public `cn()` 813; floors 474 (Nitro) / 302 (global fn). 0 mismatches, 0 fallbacks.

Not run in this baseline: Android, tovtam real-app rAF/stall, Uniwind comparison on this build.

## tovtam real app, current pipeline vs plain Uniwind (2026-10-14, Release, iPhone 17 Pro simulator, iOS 26.5)

In-app stall benchmark (12 `Uniwind.setTheme` switches 300 ms apart; longest JS-thread gap in the 350 ms after each switch; first switch
cold). 5 launches per arm, median of the 12 per launch:

| Arm | Per-launch medians (ms) | Median of launches | Worst single stall |
|---|---|---|---|
| Current pipeline (engine on, `engine: true`) | 37.5, 37.5, 36.7, 37.4, 37.2 | **37.4** | 43.6 |
| Plain Uniwind (`engine: false`) | 63.5, 61.3, 62.1, 64.7, 64.1 | **63.5** | 67.9 |

Does not reproduce the earlier tovtam run (64.8 -> 60.3 ms); the cause of the larger gain is not identified (different package build,
later fixes). Metric is JS stall, not time to pixels. `medianBusyMs` (about 352 ms) includes the wait window and is not informative.
