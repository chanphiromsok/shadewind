#pragma once

#include <folly/dynamic.h>
#include <react/renderer/core/ShadowNodeFamily.h>
#include <cxxreact/ReactNativeVersion.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace margelo::nitro::shadewind {

using namespace facebook::react;

// RN >= 0.86.1 guards ShadowNodeFamily::nativeProps_DEPRECATED with nativePropsMutex
#if REACT_NATIVE_VERSION_MINOR > 86 || (REACT_NATIVE_VERSION_MINOR == 86 && REACT_NATIVE_VERSION_PATCH >= 1)
#define SHADEWIND_HAS_NATIVE_PROPS_MUTEX 1
#else
#define SHADEWIND_HAS_NATIVE_PROPS_MUTEX 0
#endif

// One styled view: its family (weak, so an unmounted view never leaks) and the props to apply per theme.
struct Entry {
  std::weak_ptr<const ShadowNodeFamily> family;
  std::unordered_map<std::string, folly::dynamic> propsByTheme;
};

struct Update {
  std::shared_ptr<const ShadowNodeFamily> family;
  Tag tag;
  folly::dynamic props;
};

class ThemeRegistry {
public:
  void add(const std::shared_ptr<const ShadowNodeFamily>& family, std::unordered_map<std::string, folly::dynamic> propsByTheme) {
    std::lock_guard<std::mutex> lock(_mutex);
    _entries[family.get()] = Entry{family, std::move(propsByTheme)};
    _pending.push_back(family);
  }

  // Views registered since the last call, with the props of `theme`. Used to apply the current theme to views that
  // mounted (or were revealed again after a freeze) after the last setTheme.
  std::vector<Update> collectPending(const std::string& theme) {
    std::lock_guard<std::mutex> lock(_mutex);
    std::vector<Update> updates;
    updates.reserve(_pending.size());

    for (const auto& weak : _pending) {
      auto family = weak.lock();

      if (!family) {
        continue;
      }

      auto entry = _entries.find(family.get());

      if (entry == _entries.end()) {
        continue;
      }

      auto props = entry->second.propsByTheme.find(theme);

      if (props != entry->second.propsByTheme.end()) {
        updates.push_back(Update{family, family->getTag(), props->second});
      }
    }

    _pending.clear();

    return updates;
  }

  void remove(const ShadowNodeFamily* family) {
    std::lock_guard<std::mutex> lock(_mutex);
    _entries.erase(family);
  }

  // Collects the props for `theme`, dropping views that no longer exist.
  // Returned updates hold the family alive until the commit is done.
  std::vector<Update> collect(const std::string& theme) {
    std::lock_guard<std::mutex> lock(_mutex);
    std::vector<Update> updates;
    updates.reserve(_entries.size());

    for (auto it = _entries.begin(); it != _entries.end();) {
      auto family = it->second.family.lock();

      if (!family) {
        it = _entries.erase(it);
        continue;
      }

      auto props = it->second.propsByTheme.find(theme);

      if (props != it->second.propsByTheme.end()) {
        updates.push_back(Update{family, family->getTag(), props->second});
      }

      ++it;
    }

    return updates;
  }

  size_t size() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _entries.size();
  }

private:
  std::mutex _mutex;
  std::unordered_map<const ShadowNodeFamily*, Entry> _entries;
  std::vector<std::weak_ptr<const ShadowNodeFamily>> _pending;
};

// Keeps the values after React re-clones the node: UIManager::cloneNode re-applies nativeProps_DEPRECATED
// (React's own props win only for keys React re-sends). RN marks this field "will be removed",
// so every access lives here.
inline void mergeNativeProps(const ShadowNodeFamily& family, const folly::dynamic& props) {
#if SHADEWIND_HAS_NATIVE_PROPS_MUTEX
  std::lock_guard<std::mutex> lock(family.nativePropsMutex);
#endif

  if (family.nativeProps_DEPRECATED && family.nativeProps_DEPRECATED->isObject()) {
    family.nativeProps_DEPRECATED->update(props);
    return;
  }

  family.nativeProps_DEPRECATED = std::make_unique<folly::dynamic>(props);
}

} // namespace margelo::nitro::shadewind
