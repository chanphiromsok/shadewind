#pragma once

#include <react/renderer/graphics/Color.h>
#include <react/renderer/core/ReactPrimitives.h>
#include <functional>
#include <cstdint>
#include <utility>
#include <vector>

namespace margelo::nitro::shadewind {

// Debug (iOS only): what UIKit really holds. For each tag, the UIView's backgroundColor
// and the colour its layer was painted with (set by RCTViewComponentView when the mount finalizes). -1 = view not found or
// no colour; -2 = not a Fabric view. Blocks the caller until the main thread answered. Elsewhere returns -1 for both.
struct UIKitBackground {
  facebook::react::Tag tag;
  int64_t viewColor;
  int64_t layerColor;
};

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags);

} // namespace margelo::nitro::shadewind
