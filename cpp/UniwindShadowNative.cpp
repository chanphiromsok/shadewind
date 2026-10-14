#if !defined(__APPLE__)
#include "UniwindShadowNative.hpp"

namespace margelo::nitro::uniwindshadow {

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags) {
  std::vector<UIKitBackground> result;

  result.reserve(tags.size());

  for (auto tag : tags) {
    result.push_back({tag, -1, -1});
  }

  return result;
}

} // namespace margelo::nitro::uniwindshadow
#endif
