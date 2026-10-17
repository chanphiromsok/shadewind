#pragma once

// Registration and theme state of the engine, without JSI: HybridShadewind.cpp is the JS binding around it, and the native
// harness (cpp/harness) drives the same code against React Native's renderer without an app.

#include "ThemeHook.hpp"
#include "css/ColorParser.hpp"

#include <folly/container/F14Map.h>
#include <react/renderer/core/RawValue.h>
#include <react/renderer/graphics/Color.h>
#include <react/renderer/graphics/PlatformColorParser.h>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace margelo::nitro::shadewind {

using namespace facebook::react;

// The per-theme props of one style as JS sends them: theme name -> raw props (colours as numbers or CSS strings).
using PropsByTheme = std::vector<std::pair<std::string, folly::dynamic>>;

// Colour props arrive from JS as CSS strings (hex, rgb(), hsl(), oklch()) or as numbers already processed by processColor.
// Strings are parsed here (css::parseColor) and replaced by the ARGB number React Native expects: unsigned on iOS, signed int32 on
// Android (what processColor returns there).
inline bool isColorKey(const std::string& key) {
  return key == "colors" || (key.size() >= 5 && (key.compare(key.size() - 5, 5, "Color") == 0 || key.compare(key.size() - 5, 5, "color") == 0)) ||
         key == "color";
}

inline void normalizeColorStrings(folly::dynamic& props) {
  if (!props.isObject()) {
    return;
  }

  for (auto& item : props.items()) {
    if (!item.first.isString() || !isColorKey(item.first.getString())) {
      continue;
    }

    auto convert = [](folly::dynamic& value) {
      if (value.isString()) {
        if (const auto argb = css::parseColor(value.getString())) {
#ifdef RN_SERIALIZABLE_STATE
          // Android sends Props::rawProps to Java, which reads a colour as a Double and narrows it with toInt(): that saturates
          // above INT32_MAX (every opaque colour became 0x7FFFFFFF, white at 50% alpha). Send the signed form, as processColor does.
          value = static_cast<int64_t>(static_cast<int32_t>(*argb));
#else
          value = static_cast<int64_t>(*argb);
#endif
        }
      }
    };

    if (item.second.isArray()) {
      for (auto& entry : item.second) {
        convert(entry);
      }
    } else {
      convert(item.second);
    }
  }
}

inline std::shared_ptr<const TypedDelta> toTypedDelta(const ContextContainer& container, SurfaceId surfaceId, const folly::dynamic& props) {
  auto delta = std::make_shared<TypedDelta>();
  delta->raw = props;

  const auto color = [&](const char* key) -> std::optional<SharedColor> {
    if (const auto* value = props.get_ptr(key)) {
      SharedColor parsed;

      fromRawValue(container, surfaceId, RawValue(*value), parsed);

      return parsed;
    }

    return std::nullopt;
  };

  delta->background = color("backgroundColor");
  delta->border = color("borderColor");
  delta->text = color("color");

  if (const auto* opacity = props.get_ptr("opacity"); opacity && opacity->isNumber()) {
    delta->opacity = static_cast<Float>(opacity->asDouble());
  }

  return delta;
}

class ThemeEngine {
public:
  ThemeHook& hook() {
    return *_hook;
  }

  const std::shared_ptr<ThemeHook>& hookShared() {
    return _hook;
  }

  // Declares the themes for a (new) JS session. Style ids restart with every JS session, so the cache starts over too.
  bool configure(const std::vector<std::string>& names) {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _styles.clear();
    }

    return _hook->declareThemes(names);
  }

  // The parsed style JS tagged with `styleId` (every view of one className / styles object shares it), or null.
  std::shared_ptr<const ThemeStyle> cachedStyle(int64_t styleId, SurfaceId surface) {
    if (styleId < 0) {
      return nullptr;
    }

    std::lock_guard<std::mutex> lock(_mutex);
    const auto it = _styles.find(key(styleId, surface));

    return it != _styles.end() ? it->second.lock() : nullptr;
  }

  // Parses one style. Kept (weakly) under `styleId` while views use it: once they are gone the entry expires, so a long session
  // that mounts many distinct styles does not grow without bound.
  std::shared_ptr<const ThemeStyle> buildStyle(int64_t styleId, SurfaceId surface, PropsByTheme props, const ContextContainer& container) {
    std::vector<std::pair<std::string, std::shared_ptr<const TypedDelta>>> deltas;

    deltas.reserve(props.size());

    for (auto& [name, values] : props) {
      normalizeColorStrings(values);
      deltas.emplace_back(name, toTypedDelta(container, surface, values));
    }

    auto style = _hook->makeStyle(deltas);

    if (styleId >= 0) {
      std::lock_guard<std::mutex> lock(_mutex);

      if (_styles.size() >= _purgeAt) {
        for (auto it = _styles.begin(); it != _styles.end();) {
          it = it->second.expired() ? _styles.erase(it) : std::next(it);
        }

        _purgeAt = std::max<size_t>(256, _styles.size() * 2);
      }

      _styles[key(styleId, surface)] = style;
    }

    return style;
  }

  // `renderTheme`: the theme JS rendered the view with, when its props are known to be that render's (first attach). Equal to
  // the current theme, the view needs nothing until the theme changes.
  void registerView(const ShadowNode& node, std::shared_ptr<const ThemeStyle> style, const std::string* renderTheme) {
    bool renderedWithCurrent = false;

    if (renderTheme != nullptr) {
      std::lock_guard<std::mutex> lock(_mutex);
      renderedWithCurrent = !_theme.empty() && *renderTheme == _theme;
    }

    _hook->add(
        node.getFamilyShared(), std::move(style), node.getProps(), node.getComponentName(), node.getFamily().getSurfaceId(),
        renderedWithCurrent);
  }

  void unregisterView(const ShadowNode& node) {
    _hook->remove(&node.getFamily());
  }

  void setTheme(const std::string& name) {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _theme = name;
    }

    _hook->setTheme(name);
  }

  std::string theme() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _theme;
  }

  size_t cachedStyles() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _styles.size();
  }

private:
  static uint64_t key(int64_t styleId, SurfaceId surface) {
    return (static_cast<uint64_t>(styleId) << 24) ^ static_cast<uint64_t>(static_cast<uint32_t>(surface));
  }

  std::shared_ptr<ThemeHook> _hook = std::make_shared<ThemeHook>();
  std::mutex _mutex;
  folly::F14FastMap<uint64_t, std::weak_ptr<const ThemeStyle>> _styles;
  size_t _purgeAt = 256;
  std::string _theme;
};

} // namespace margelo::nitro::shadewind
