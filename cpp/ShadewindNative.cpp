#if !defined(__APPLE__)
#include "ShadewindNative.hpp"

namespace margelo::nitro::shadewind {

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags) {
  std::vector<UIKitBackground> result;

  result.reserve(tags.size());

  for (auto tag : tags) {
    result.push_back({tag, -1, -1});
  }

  return result;
}

} // namespace margelo::nitro::shadewind
#endif
