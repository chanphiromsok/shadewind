#pragma once

// The JSI side of Uniwind's class resolution: reads the arguments of `__swResolve` / `resolveClasses` and builds the JS result
// object from the C++ resolver's answer. A header so the Hermes bench and check (cpp/harness/hermes) run this very code, not a copy.

#include "css/StyleResolver.hpp"

#include <jsi/JSIDynamic.h>
#include <jsi/jsi.h>
#include <cstring>
#include <memory>
#include <vector>
#include <string_view>

namespace margelo::nitro::shadewind {

using namespace facebook;

constexpr size_t kMergeMaxArgs = 16;
constexpr size_t kMergeBuffer = 4096;

struct MergeInput {
  char buffer[kMergeBuffer];
  size_t length = 0;
  std::string_view views[kMergeMaxArgs];
  size_t count = 0;
};

inline bool readAscii(jsi::Runtime& rt, const jsi::Value* args, size_t count, MergeInput& in) {
  if (count > kMergeMaxArgs) {
    return false;
  }

  for (size_t i = 0; i < count; i++) {
    if (!args[i].isString()) {
      return false;
    }

    const size_t begin = in.length;
    bool ok = true;
    auto cb = [&](bool ascii, const void* data, size_t num) {
      if (num > kMergeBuffer - in.length) {
        ok = false;
        return;
      }

      if (ascii) {
        std::memcpy(in.buffer + in.length, data, num);
      } else {
        const auto* p = static_cast<const char16_t*>(data);

        for (size_t k = 0; k < num; k++) {
          if (p[k] > 127) {
            ok = false;
            return;
          }

          in.buffer[in.length + k] = static_cast<char>(p[k]);
        }
      }

      in.length += num;
    };

    args[i].getString(rt).getStringData(rt, cb);

    if (!ok) {
      return false;
    }

    in.views[i] = std::string_view(in.buffer + begin, in.length - begin);
  }

  in.count = count;

  return true;
}

// isPressed / isFocused / isDisabled: only a boolean equals Uniwind's `true` / `false` (resolveStyles compares with !==)
inline css::StyleResolver::Tri triOf(const jsi::Value& value) {
  if (!value.isBool()) {
    return css::StyleResolver::Tri::Unset;
  }

  return value.getBool() ? css::StyleResolver::Tri::True : css::StyleResolver::Tri::False;
}

inline jsi::Value styleValue(jsi::Runtime& rt, const css::StyleResolver::Item& item) {
  if (!item.value) {
    return jsi::Value(item.number);
  }

  if (item.value->undefined) {
    return jsi::Value::undefined();
  }

  const folly::dynamic& value = item.value->value;

  switch (value.type()) {
    case folly::dynamic::DOUBLE:
      return jsi::Value(value.getDouble());
    case folly::dynamic::INT64:
      return jsi::Value(static_cast<double>(value.getInt()));
    case folly::dynamic::STRING:
      return jsi::String::createFromUtf8(rt, value.getString());
    case folly::dynamic::BOOL:
      return jsi::Value(value.getBool());
    case folly::dynamic::NULLT:
      return jsi::Value::null();
    default:
      return jsi::valueFromDynamic(rt, value);
  }
}

// The keys of the result object, created once per runtime instead of from a C string at every call (measured on Hermes in
// cpp/harness/hermes/glue.cpp: 1118 -> 654 ns per call). Kept as the runtime's own data, so the runtime releases them when it is
// destroyed (Hermes does that first thing in its destructor, while its heap still exists): they never outlive it, also across a
// reload. Rebuilt when another table is loaded (the property ids change).
struct ResolveNames {
  uint64_t generation = 0;
  std::vector<jsi::PropNameID> properties;
  jsi::PropNameID styles, dependencies, dependencySum, hasDataAttributes;

  ResolveNames(jsi::Runtime& rt, const css::StyleResolver& resolver)
      : generation(resolver.generation()),
        styles(jsi::PropNameID::forAscii(rt, "styles")),
        dependencies(jsi::PropNameID::forAscii(rt, "dependencies")),
        dependencySum(jsi::PropNameID::forAscii(rt, "dependencySum")),
        hasDataAttributes(jsi::PropNameID::forAscii(rt, "hasDataAttributes")) {
    properties.reserve(resolver.propertyCount());

    for (uint32_t i = 0; i < resolver.propertyCount(); i++) {
      properties.push_back(jsi::PropNameID::forUtf8(rt, resolver.propertyName(i)));
    }
  }
};

// JS thread only, like the resolver.
inline const ResolveNames& resolveNames(jsi::Runtime& rt, const css::StyleResolver& resolver) {
  static constexpr jsi::UUID kKey{0x5d3a91c4, 0x2b7e, 0x4f10, 0x8a6c, 0x1e9f04b27d35};
  auto names = std::static_pointer_cast<ResolveNames>(rt.getRuntimeData(kKey));

  if (!names || names->generation != resolver.generation()) {
    names = std::make_shared<ResolveNames>(rt, resolver);
    rt.setRuntimeData(kKey, names);
  }

  return *names; // the runtime holds it
}

// (className, theme, screenWidth, isPressed, isFocused, isDisabled) -> Uniwind's resolveStyles result
// ({ styles, dependencies, dependencySum, hasDataAttributes }), or undefined: resolve it with Uniwind's JS
inline jsi::Value resolveClassesWith(
    jsi::Runtime& rt,
    css::StyleResolver& resolver,
    css::StyleResolver::Result& resolved,
    const jsi::Value* args,
    size_t count) {
  MergeInput in;

  if (count < 3 || !resolver.loaded() || !args[2].isNumber() || !readAscii(rt, args, 2, in)) {
    return jsi::Value::undefined();
  }

  const int theme = resolver.themeIndex(in.views[1]);
  const auto state = [&](size_t i) { return i < count ? triOf(args[i]) : css::StyleResolver::Tri::Unset; };

  if (!resolver.resolve(in.views[0], theme, args[2].getNumber(), state(3), state(4), state(5), resolved)) {
    return jsi::Value::undefined();
  }

  const ResolveNames& names = resolveNames(rt, resolver);
  jsi::Object styles(rt);

  for (const auto& item : resolved.styles) {
    styles.setProperty(rt, names.properties[item.property], styleValue(rt, item));
  }

  jsi::Array dependencies(rt, resolved.dependencies.size());

  for (size_t i = 0; i < resolved.dependencies.size(); i++) {
    dependencies.setValueAtIndex(rt, i, resolved.dependencies[i]);
  }

  jsi::Object result(rt);

  result.setProperty(rt, names.styles, std::move(styles));
  result.setProperty(rt, names.dependencies, std::move(dependencies));
  result.setProperty(rt, names.dependencySum, static_cast<double>(resolved.dependencySum));
  result.setProperty(rt, names.hasDataAttributes, false);

  return result;
}


} // namespace margelo::nitro::shadewind
