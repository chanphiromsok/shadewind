#import "ShadewindNative.hpp"

#import <React/RCTConversions.h>
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#include <chrono>
#include <unordered_map>

namespace margelo::nitro::shadewind {

namespace {

// ARGB as the shadow tree stores it (uint32 widened to int64), so it compares with the tree and the expected colour.
int64_t argbOf(UIColor* color) {
  if (color == nil) {
    return -1;
  }

  CGFloat r = 0, g = 0, b = 0, a = 0;

  if (![color getRed:&r green:&g blue:&b alpha:&a]) {
    return -1;
  }

  const auto byte = [](CGFloat v) { return static_cast<uint32_t>(lround(fmax(0, fmin(1, v)) * 255)); };

  return static_cast<int64_t>((byte(a) << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b));
}

// Theme transition overlay. Main thread only: every function below runs from a block queued on the main queue (or from the mount
// hook, which Fabric calls on the main thread).
constexpr NSTimeInterval kFailsafeSeconds = 1.0;

UIView* gOverlay = nil;      // the snapshot on screen, if any
uint64_t gOverlayId = 0;     // the transition it belongs to
NSTimeInterval gOverlaySeconds = 0;
bool gOverlayFading = false;

// The key window of the foreground scene (an app with several windows: the one the user is looking at).
UIWindow* visibleAppWindow() {
  UIWindow* fallback = nil;

  for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class] || scene.activationState != UISceneActivationStateForegroundActive) {
      continue;
    }

    for (UIWindow* window in ((UIWindowScene*)scene).windows) {
      if (window.isKeyWindow) {
        return window;
      }

      if (fallback == nil && !window.hidden) {
        fallback = window;
      }
    }
  }

  return fallback;
}

// By identity: a stale completion block or timer can never remove a newer overlay.
void removeOverlay(UIView* overlay) {
  if (overlay == nil) {
    return;
  }

  [overlay.layer removeAllAnimations];
  [overlay removeFromSuperview];

  if (gOverlay == overlay) {
    gOverlay = nil;
    gOverlayId = 0;
    gOverlayFading = false;
  }
}

void fadeOutOverlay(UIView* overlay) {
  if (overlay != gOverlay || gOverlayFading) {
    return;
  }

  gOverlayFading = true;

  [UIView animateWithDuration:gOverlaySeconds
                        delay:0
                      options:UIViewAnimationOptionCurveLinear | UIViewAnimationOptionAllowUserInteraction
                   animations:^{
                     overlay.alpha = 0;
                   }
                   completion:^(BOOL finished) {
                     (void)finished;
                     removeOverlay(overlay);
                   }];
}

} // namespace

void themeTransitionBegin(uint64_t id, ThemeTransitionPreset, double durationMs) {
  // Queued on the main queue ahead of the mount of the theme commit (RN dispatches the mount to the main queue after this call
  // returns, from any strategy), so the snapshot shows the old theme.
  dispatch_async(dispatch_get_main_queue(), ^{
    UIView* previous = gOverlay;
    UIWindow* window = nil;
    UIView* snapshot = nil;

    const bool allowed = !UIAccessibilityIsReduceMotionEnabled() && UIApplication.sharedApplication.applicationState == UIApplicationStateActive;

    if (allowed) {
      window = visibleAppWindow();
      // afterScreenUpdates:NO captures what is on screen now. nil for content that cannot be captured (secure fields).
      snapshot = [window snapshotViewAfterScreenUpdates:NO];
    }

    if (snapshot == nil) {
      removeOverlay(previous);

      return;
    }

    snapshot.frame = window.bounds;
    snapshot.userInteractionEnabled = NO; // taps go to the app underneath
    snapshot.isAccessibilityElement = NO;
    snapshot.accessibilityElementsHidden = YES;
    [window addSubview:snapshot];

    // the new snapshot already contains what is left of the previous overlay: only now is it safe to take that away
    removeOverlay(previous);

    gOverlay = snapshot;
    gOverlayId = id;
    gOverlaySeconds = durationMs / 1000.0;
    gOverlayFading = false;

    // If the mount never reports (nothing visible changed, so Fabric mounts nothing), do not leave a frozen picture on top.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFailsafeSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      fadeOutOverlay(snapshot);
    });
  });
}

void themeTransitionRun(uint64_t id) {
  void (^run)(void) = ^{
    if (gOverlay != nil && gOverlayId == id) {
      fadeOutOverlay(gOverlay);
    }
  };

  if ([NSThread isMainThread]) {
    // the mount hook: RCTSurfacePresenter reports the mount from a main-queue block queued right after the views were updated,
    // so at most one frame shows the new theme under the still opaque snapshot before the fade starts
    run();
  } else {
    dispatch_async(dispatch_get_main_queue(), run);
  }
}

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags) {
  std::vector<UIKitBackground> result;

  result.reserve(tags.size());

  for (auto tag : tags) {
    result.push_back({tag, -1, -1});
  }

  std::unordered_map<facebook::react::Tag, size_t> index;

  for (size_t i = 0; i < tags.size(); ++i) {
    index.emplace(tags[i], i);
  }

  auto* out = &result; // blocks capture by value (const), so write through a pointer

  void (^read)(void) = ^{
    std::function<void(UIView*)> walk = [&](UIView* view) {
      auto it = index.find(static_cast<facebook::react::Tag>(view.tag));

      if (it != index.end()) {
        auto& entry = (*out)[it->second];

        if ([view isKindOfClass:RCTViewComponentView.class]) {
          entry.viewColor = argbOf(view.backgroundColor);
          entry.layerColor = view.layer.backgroundColor != nullptr ? argbOf([UIColor colorWithCGColor:view.layer.backgroundColor]) : -1;
        } else if (entry.viewColor == -1) {
          entry.viewColor = entry.layerColor = -2;
        }
      }

      for (UIView* child in view.subviews) {
        walk(child);
      }
    };

    for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:UIWindowScene.class]) {
        continue;
      }

      for (UIWindow* window in ((UIWindowScene*)scene).windows) {
        walk(window);
      }
    }
  };

  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read); // debug only
  }

  return result;
}

} // namespace margelo::nitro::shadewind
