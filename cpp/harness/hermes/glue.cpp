// The JSI glue of the class resolver (cpp/ResolveGlue.hpp, what `__swResolve` runs) inside a real Hermes runtime, the version
// React Native 0.86.2 pins (hermes-v250829098.0.16):
//   1. parity: for every case of fixtures/resolver/cases.jsonl the JS object the glue returns (keys in order, values,
//      dependencies, dependencySum, hasDataAttributes) equals Uniwind 1.12's own resolveStyles result, and it returns undefined
//      exactly where Uniwind's JS must resolve (a fallback);
//   2. bench: nanoseconds per call of the glue as shipped against a candidate that creates the property names once per runtime.
//
// Build: cmake -DHERMES_DIR=<hermes checkout> -DHERMES_BUILD=<its build, with hermesvm built> (see cpp/harness/README.md).

#include "ResolveGlue.hpp"

#include <folly/json.h>
#include <hermes/hermes.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace margelo::nitro::shadewind;
using css::StyleResolver;

namespace {

std::string slurp(const std::string& path) {
  std::ifstream file(path);
  std::stringstream text;

  text << file.rdbuf();

  return text.str();
}

// as in style_resolver_tests.cpp: numbers by value, object keys as sets
bool same(const folly::dynamic& a, const folly::dynamic& b) {
  if (a.isNumber() && b.isNumber()) {
    return a.asDouble() == b.asDouble();
  }

  if (a.type() != b.type()) {
    return false;
  }

  if (a.isArray()) {
    if (a.size() != b.size()) {
      return false;
    }

    for (size_t i = 0; i < a.size(); i++) {
      if (!same(a[i], b[i])) {
        return false;
      }
    }

    return true;
  }

  if (a.isObject()) {
    if (a.size() != b.size()) {
      return false;
    }

    for (const auto& [key, value] : a.items()) {
      const folly::dynamic* other = b.get_ptr(key);

      if (!other || !same(value, *other)) {
        return false;
      }
    }

    return true;
  }

  return a == b;
}

jsi::Value stateValue(const folly::dynamic& value) {
  return value.isNull() ? jsi::Value::undefined() : jsi::Value(value.getBool());
}

// a JS value in the fixture's encoding: undefined, NaN and Infinity as markers
folly::dynamic encode(jsi::Runtime& rt, const jsi::Value& value) {
  if (value.isUndefined()) {
    return folly::dynamic::object("$u", 1);
  }

  if (value.isNumber()) {
    const double number = value.getNumber();

    if (std::isnan(number)) {
      return folly::dynamic::object("$nan", 1);
    }

    if (std::isinf(number)) {
      return folly::dynamic::object("$inf", number > 0 ? 1 : -1);
    }

    return number;
  }

  return jsi::dynamicFromValue(rt, value);
}

// The object the glue returned, as the fixture writes Uniwind's result: { styles: [[key, value]], deps, sum, data }
folly::dynamic encodeResult(jsi::Runtime& rt, const jsi::Object& result) {
  folly::dynamic styles = folly::dynamic::array;
  const auto object = result.getPropertyAsObject(rt, "styles");
  const auto keys = object.getPropertyNames(rt);

  for (size_t i = 0; i < keys.size(rt); i++) {
    const auto key = keys.getValueAtIndex(rt, i).getString(rt);

    styles.push_back(folly::dynamic::array(key.utf8(rt), encode(rt, object.getProperty(rt, jsi::PropNameID::forString(rt, key)))));
  }

  folly::dynamic deps = folly::dynamic::array;
  const auto array = result.getPropertyAsObject(rt, "dependencies").asArray(rt);

  for (size_t i = 0; i < array.size(rt); i++) {
    deps.push_back(array.getValueAtIndex(rt, i).getNumber());
  }

  return folly::dynamic::object("styles", std::move(styles))("deps", std::move(deps))(
      "sum", result.getProperty(rt, "dependencySum").getNumber())("data", result.getProperty(rt, "hasDataAttributes").getBool());
}

bool matches(const folly::dynamic& native, const folly::dynamic& expected) {
  if (native["styles"].size() != expected["styles"].size()) {
    return false;
  }

  for (size_t i = 0; i < native["styles"].size(); i++) {
    if (native["styles"][i][0] != expected["styles"][i][0]) {
      return false; // keys in the same order
    }
  }

  return same(native["styles"], expected["styles"]) && same(native["deps"], expected["deps"]) &&
      native["sum"].asDouble() == expected["sum"].asDouble() && native["data"].asBool() == expected["data"].asBool();
}

// The candidate: resolveClassesWith with every property name created once for the runtime instead of from a C string per call.
struct Names {
  std::vector<jsi::PropNameID> properties;
  jsi::PropNameID styles, dependencies, dependencySum, hasDataAttributes;

  Names(jsi::Runtime& rt, const StyleResolver& resolver, size_t count)
      : styles(jsi::PropNameID::forAscii(rt, "styles")),
        dependencies(jsi::PropNameID::forAscii(rt, "dependencies")),
        dependencySum(jsi::PropNameID::forAscii(rt, "dependencySum")),
        hasDataAttributes(jsi::PropNameID::forAscii(rt, "hasDataAttributes")) {
    properties.reserve(count);

    for (uint32_t i = 0; i < count; i++) {
      properties.push_back(jsi::PropNameID::forUtf8(rt, resolver.propertyName(i)));
    }
  }
};

jsi::Value resolveCached(
    jsi::Runtime& rt,
    StyleResolver& resolver,
    StyleResolver::Result& resolved,
    const Names& names,
    const jsi::Value* args,
    size_t count) {
  MergeInput in;

  if (count < 3 || !resolver.loaded() || !args[2].isNumber() || !readAscii(rt, args, 2, in)) {
    return jsi::Value::undefined();
  }

  const int theme = resolver.themeIndex(in.views[1]);
  const auto state = [&](size_t i) { return i < count ? triOf(args[i]) : StyleResolver::Tri::Unset; };

  if (!resolver.resolve(in.views[0], theme, args[2].getNumber(), state(3), state(4), state(5), resolved)) {
    return jsi::Value::undefined();
  }

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

} // namespace

int main() {
  auto runtime = facebook::hermes::makeHermesRuntime();
  jsi::Runtime& rt = *runtime;
  int failures = 0;

  {
    StyleResolver resolver;
    std::string error;

    if (!resolver.load(slurp(std::string(FIXTURES_DIR) + "/resolver/table.json"), &error)) {
      std::fprintf(stderr, "table: %s\n", error.c_str());
      return 1;
    }

    StyleResolver::Result resolved;
    const folly::dynamic summary = folly::parseJson(slurp(std::string(FIXTURES_DIR) + "/resolver/summary.json"));
    std::istringstream lines(slurp(std::string(FIXTURES_DIR) + "/resolver/cases.jsonl"));
    std::string line;

    std::getline(lines, line);

    const folly::dynamic header = folly::parseJson(line);
    int64_t cases = 0, resolvedCases = 0, mismatches = 0, candidateMismatches = 0;
    size_t propertyCount = 0;
    std::vector<std::string> classNames;

    // the candidate needs every property id the table has: ask the resolver for names until it runs out is not possible, so
    // collect the ids seen while checking parity first, then build Names over the highest id
    std::vector<std::vector<jsi::Value>> benchArgs;

    while (std::getline(lines, line)) {
      if (line.empty()) {
        continue;
      }

      const folly::dynamic c = folly::parseJson(line);
      const std::string& className = c["c"].getString();
      const bool fallback = c["fb"].getBool();
      size_t combination = 0;

      classNames.push_back(className);

      for (const auto& themeName : header["themes"]) {
        for (const auto& width : header["widths"]) {
          for (const auto& state : header["states"]) {
            const size_t index = combination++;
            jsi::Value args[] = {
                jsi::String::createFromUtf8(rt, className), jsi::String::createFromUtf8(rt, themeName.getString()),
                jsi::Value(width.asDouble()), stateValue(state[0]), stateValue(state[1]), stateValue(state[2])};
            const jsi::Value value = resolveClassesWith(rt, resolver, resolved, args, 6);

            ++cases;

            if (fallback) {
              if (!value.isUndefined()) {
                ++mismatches;
              }

              continue;
            }

            if (!value.isObject()) {
              if (++mismatches <= 10) {
                std::fprintf(stderr, "unexpected fallback: %s\n", className.c_str());
              }

              continue;
            }

            ++resolvedCases;

            for (const auto& item : resolved.styles) {
              propertyCount = std::max<size_t>(propertyCount, item.property + 1);
            }

            const folly::dynamic native = encodeResult(rt, value.getObject(rt));
            const folly::dynamic& expected = c["u"][c["i"][index].asInt()];

            if (!matches(native, expected) && ++mismatches <= 10) {
              std::fprintf(stderr, "mismatch: %s\n  uniwind: %s\n  glue:    %s\n", className.c_str(), folly::toJson(expected).c_str(),
                           folly::toJson(native).c_str());
            }
          }
        }
      }
    }

    std::printf("parity (Hermes, glue): %lld cases, %lld resolved, %lld mismatches (fixture: %lld cases, %lld resolvable)\n",
                static_cast<long long>(cases), static_cast<long long>(resolvedCases), static_cast<long long>(mismatches),
                static_cast<long long>(summary["cases"].asInt()), static_cast<long long>(summary["resolvableCases"].asInt()));

    failures += mismatches != 0 || cases != summary["cases"].asInt() || resolvedCases != summary["resolvableCases"].asInt();

    // bench: every className of the fixture that resolves, both themes, width 390, no interaction state
    for (const auto& className : classNames) {
      for (const auto& themeName : header["themes"]) {
        std::vector<jsi::Value> args;

        args.emplace_back(jsi::String::createFromUtf8(rt, className));
        args.emplace_back(jsi::String::createFromUtf8(rt, themeName.getString()));
        args.emplace_back(390.0);

        if (resolveClassesWith(rt, resolver, resolved, args.data(), args.size()).isObject()) {
          benchArgs.push_back(std::move(args));
        }
      }
    }

    {
      const Names names(rt, resolver, propertyCount);

      // the candidate returns the same objects
      for (auto& args : benchArgs) {
        const auto a = resolveClassesWith(rt, resolver, resolved, args.data(), args.size());
        const auto b = resolveCached(rt, resolver, resolved, names, args.data(), args.size());

        if (folly::toJson(encodeResult(rt, a.getObject(rt))) != folly::toJson(encodeResult(rt, b.getObject(rt)))) {
          ++candidateMismatches;
        }
      }

      std::printf("candidate (cached property names) differs from the shipped glue on %lld of %zu calls\n",
                  static_cast<long long>(candidateMismatches), benchArgs.size());
      failures += candidateMismatches != 0;

      using Clock = std::chrono::steady_clock;
      const int reps = 40;
      std::vector<double> shipped, cached;
      double sink = 0;

      for (int round = 0; round < 7; round++) {
        for (int arm = 0; arm < 2; arm++) {
          const auto t0 = Clock::now();

          for (int r = 0; r < reps; r++) {
            for (auto& args : benchArgs) {
              const auto value = arm == 0 ? resolveClassesWith(rt, resolver, resolved, args.data(), args.size())
                                          : resolveCached(rt, resolver, resolved, names, args.data(), args.size());

              sink += value.isObject();
            }
          }

          const double ns = std::chrono::duration<double, std::nano>(Clock::now() - t0).count() / (reps * benchArgs.size());

          (arm == 0 ? shipped : cached).push_back(ns);
        }
      }

      std::sort(shipped.begin(), shipped.end());
      std::sort(cached.begin(), cached.end());
      std::printf("bench (%zu calls x %d reps x 7 rounds, ns per call): shipped median %.0f [%.0f-%.0f], cached names median %.0f [%.0f-%.0f]%s\n",
                  benchArgs.size(), reps, shipped[3], shipped.front(), shipped.back(), cached[3], cached.front(), cached.back(),
                  sink > 0 ? "" : " (no result?)");
    }
  }

  return failures == 0 ? 0 : 1;
}
