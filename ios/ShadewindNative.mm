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

} // namespace

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
