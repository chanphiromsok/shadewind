#pragma once

#include "DevTools.hpp"

#include <react/renderer/graphics/Color.h>
#include <react/renderer/core/ReactPrimitives.h>
#include <functional>
#include <cstdint>
#include <utility>
#include <vector>

namespace margelo::nitro::shadewind {

#if SHADEWIND_DEV_TOOLS
// Debug (iOS only): what UIKit really holds. For each tag, the UIView's backgroundColor
// and the colour its layer was painted with (set by RCTViewComponentView when the mount finalizes). -1 = view not found or
// no colour; -2 = not a Fabric view. Blocks the caller until the main thread answered. Elsewhere returns -1 for both.
struct UIKitBackground {
  facebook::react::Tag tag;
  int64_t viewColor;
  int64_t layerColor;
};

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags);
#endif

// Animated theme change (ThemeTransition.hpp drives these; iOS: ios/ShadewindNative.mm, Android: ThemeTransitionOverlay.kt through JNI,
// elsewhere they do nothing). Both are callable from any thread and return at once; the work happens on the main / UI thread.
// A transition is a snapshot of the window laid over the app, which fades out once the new theme is mounted.
// JS sends the preset by name (ThemeTransitionPreset in src/internal.tsx, mapped in HybridShadewind::setTheme); keep these numbers
// in step with PRESET_* in ThemeTransitionOverlay.kt.
enum class ThemeTransitionPreset : int { Fade = 0, Blur = 1 };

// Queues the snapshot on the main thread. Call BEFORE the commit that themes the views: the mount is queued on the main thread after
// this, so the snapshot shows the old theme. A new `id` replaces the previous transition: its snapshot (which includes whatever is
// left of the previous overlay) goes on top and the previous overlay is removed at once. Does nothing (no overlay) for reduced
// motion, a backgrounded app or a window that cannot be captured.
void themeTransitionBegin(uint64_t id, ThemeTransitionPreset preset, double durationMs);

// The theme of transition `id` is mounted: start fading its overlay out and remove it at the end. No-op when `id` was replaced,
// skipped or already run. The platform also runs it on its own after a timeout, so an overlay never stays.
void themeTransitionRun(uint64_t id);

} // namespace margelo::nitro::shadewind
