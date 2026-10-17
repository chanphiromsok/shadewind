// css::StyleResolver against Uniwind 1.12's own resolveStyles (fixtures/resolver, generate.mjs): table.json is the table
// src/uniwind/styleTable.ts built from example-real's stylesheet (compiled by Uniwind's bundler, with a third theme and the variants
// the app does not use), cases.jsonl every className literal, every ordered pair of classes that set the same property and random
// combinations, for every theme, five screen widths and six interaction states, with Uniwind's result. The resolver must return the
// same keys in the same order with the same values, dependencies and dependency sum, or fall back exactly where a class of the
// className is not in the table. table.prebuilt.json is the table shadewind/metro built from the same CSS at bundle time (through
// Uniwind's own Metro transformer): the same results, or a fallback where a class reads a device-fixed value (pfb).

#include "css/StyleResolver.hpp"

#include <folly/json.h>
#include <gtest/gtest.h>

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>

using margelo::nitro::shadewind::css::StyleResolver;

namespace {

std::string slurp(const std::string& path) {
  std::ifstream file(path);
  std::stringstream text;

  text << file.rdbuf();

  return text.str();
}

StyleResolver::Tri tri(const folly::dynamic& value) {
  if (value.isNull()) {
    return StyleResolver::Tri::Unset;
  }

  return value.getBool() ? StyleResolver::Tri::True : StyleResolver::Tri::False;
}

// JSON numbers compare by value (14 and 14.0 are one JS number); object keys compare as sets (folly::dynamic keeps no order)
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

// the fixture's encoding of a result: [[key, value]], undefined, NaN and Infinity as markers
folly::dynamic encode(const StyleResolver& resolver, const StyleResolver::Result& result) {
  folly::dynamic styles = folly::dynamic::array;

  for (const auto& item : result.styles) {
    folly::dynamic value = item.value ? item.value->value : folly::dynamic(item.number);

    if (item.value && item.value->undefined) {
      value = folly::dynamic::object("$u", 1);
    } else if (value.isDouble() && std::isnan(value.getDouble())) {
      value = folly::dynamic::object("$nan", 1);
    } else if (value.isDouble() && std::isinf(value.getDouble())) {
      value = folly::dynamic::object("$inf", value.getDouble() > 0 ? 1 : -1);
    }

    styles.push_back(folly::dynamic::array(resolver.propertyName(item.property), std::move(value)));
  }

  return styles;
}

} // namespace

TEST(StyleResolver, MatchesUniwind) {
  StyleResolver resolver;
  std::string error;

  ASSERT_TRUE(resolver.load(slurp(std::string(FIXTURES_DIR) + "/resolver/table.json"), &error)) << error;
  ASSERT_EQ(resolver.unsupportedCount(), 0u);

  StyleResolver prebuilt;

  ASSERT_TRUE(prebuilt.load(slurp(std::string(FIXTURES_DIR) + "/resolver/table.prebuilt.json"), &error)) << error;
  ASSERT_EQ(prebuilt.unsupportedCount(), 0u);

  const folly::dynamic summary = folly::parseJson(slurp(std::string(FIXTURES_DIR) + "/resolver/summary.json"));
  std::istringstream lines(slurp(std::string(FIXTURES_DIR) + "/resolver/cases.jsonl"));
  std::string line;

  ASSERT_TRUE(std::getline(lines, line));

  const folly::dynamic header = folly::parseJson(line);
  const folly::dynamic& themes = header["themes"];
  const folly::dynamic& widths = header["widths"];
  const folly::dynamic& states = header["states"];
  const size_t combinations = themes.size() * widths.size() * states.size();
  StyleResolver::Result result;
  int64_t cases = 0, resolved = 0, mismatches = 0, prebuiltResolved = 0;

  while (std::getline(lines, line)) {
    if (line.empty()) {
      continue;
    }

    const folly::dynamic c = folly::parseJson(line);
    const std::string& className = c["c"].getString();
    const bool fallback = c["fb"].getBool();
    const bool prebuiltFallback = c["pfb"].getBool();

    ASSERT_TRUE(fallback || c["i"].size() == combinations) << line;

    size_t combination = 0;

    for (const auto& themeName : themes) {
      const int theme = resolver.themeIndex(themeName.getString());

      ASSERT_GE(theme, 0) << themeName;

      for (const auto& width : widths) {
        for (const auto& state : states) {
          const bool ok =
              resolver.resolve(className, theme, width.asDouble(), tri(state[0]), tri(state[1]), tri(state[2]), result);
          const size_t index = combination++;

          ++cases;

          if (fallback) {
            EXPECT_FALSE(ok) << className;
            EXPECT_FALSE(prebuilt.resolve(className, prebuilt.themeIndex(themeName.getString()), width.asDouble(),
                                          tri(state[0]), tri(state[1]), tri(state[2]), result))
                << "prebuilt: " << className;
            continue;
          }

          ASSERT_TRUE(ok) << "unexpected fallback: " << className;
          ++resolved;

          const folly::dynamic& expected = c["u"][c["i"][index].asInt()];
          const folly::dynamic styles = encode(resolver, result);
          folly::dynamic dependencies = folly::dynamic::array;

          for (const int dependency : result.dependencies) {
            dependencies.push_back(dependency);
          }

          bool keysInOrder = styles.size() == expected["styles"].size();

          for (size_t i = 0; keysInOrder && i < styles.size(); i++) {
            keysInOrder = styles[i][0] == expected["styles"][i][0];
          }

          const bool match = keysInOrder && same(styles, expected["styles"]) && same(dependencies, expected["deps"]) &&
              result.dependencySum == expected["sum"].asInt() && !expected["data"].asBool();

          if (!match && ++mismatches <= 20) {
            ADD_FAILURE() << "className: " << folly::toJson(className) << " theme " << themeName << " width " << width
                          << " state " << folly::toJson(state) << "\nuniwind: " << folly::toJson(expected)
                          << "\nnative styles: " << folly::toJson(styles) << "\nnative deps: " << folly::toJson(dependencies)
                          << " sum " << result.dependencySum;
          }

          // the bundle's table: the same result, or a fallback exactly where it lacks a class
          const bool prebuiltOk =
              prebuilt.resolve(className, prebuilt.themeIndex(themeName.getString()), width.asDouble(), tri(state[0]),
                               tri(state[1]), tri(state[2]), result);

          if (prebuiltFallback) {
            EXPECT_FALSE(prebuiltOk) << "prebuilt: " << className;
            continue;
          }

          ASSERT_TRUE(prebuiltOk) << "prebuilt, unexpected fallback: " << className;
          ++prebuiltResolved;

          folly::dynamic prebuiltDependencies = folly::dynamic::array;

          for (const int dependency : result.dependencies) {
            prebuiltDependencies.push_back(dependency);
          }

          if (!(same(encode(prebuilt, result), styles) && same(prebuiltDependencies, expected["deps"]) &&
                result.dependencySum == expected["sum"].asInt()) &&
              ++mismatches <= 20) {
            ADD_FAILURE() << "prebuilt differs: " << folly::toJson(className) << " theme " << themeName << " width " << width
                          << " state " << folly::toJson(state) << "\nprebuilt: " << folly::toJson(encode(prebuilt, result))
                          << "\ndevice table: " << folly::toJson(styles);
          }
        }
      }
    }
  }

  EXPECT_EQ(mismatches, 0);
  // the generator's counts: a truncated fixture must not pass
  EXPECT_EQ(cases, summary["cases"].asInt());
  EXPECT_EQ(resolved, summary["resolvableCases"].asInt());
  // the classNames with a device-fixed class are the only difference
  EXPECT_GT(prebuiltResolved, 0);
  EXPECT_LT(prebuiltResolved, resolved);
}

TEST(StyleResolver, RejectsBadTables) {
  StyleResolver resolver;
  StyleResolver::Result result;

  EXPECT_FALSE(resolver.load("not json"));
  EXPECT_FALSE(resolver.load(R"({"version":1,"themes":["light"],"classes":{}})"));
  EXPECT_FALSE(resolver.loaded());
  EXPECT_FALSE(resolver.resolve("p-1", 0, 390, StyleResolver::Tri::Unset, StyleResolver::Tri::Unset,
                                StyleResolver::Tri::Unset, result));
}

TEST(StyleResolver, PrecedenceAndPostProcessing) {
  // two themes; `a` and `b` set color (b important), `md` from 768, a pressed-only style, a relative lineHeight with no fontSize,
  // visibility hidden, a border style with no colour, a class the table could not read
  const char* table = R"({
    "version": 2, "themes": ["light", "dark"], "reserved": ["toString"], "fallback": ["fb"],
    "classes": {
      "a": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
             "important":[],"deps":[2],"entries":[["color",["#111","#eee"]],["opacity",[1,1]]]}],
      "b": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
             "important":["color"],"deps":[9],"entries":[["color",["#222","#ddd"]]]}],
      "md": [{"minWidth":768,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":1,
              "important":[],"deps":[],"entries":[["color",["#333","#ccc"]]]}],
      "press": [{"minWidth":0,"maxWidth":null,"theme":null,"active":true,"focus":null,"disabled":null,"complexity":1,
                 "important":[],"deps":[],"entries":[["opacity",[0.5,0.5]]]}],
      "lh": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
              "important":[],"deps":[],"entries":[["lineHeight",[1.5,1.5]]]}],
      "text": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
                "important":[],"deps":[],"entries":[["fontSize",[16,16]]]}],
      "invisible": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
                     "important":[],"deps":[],"entries":[["visibility",["hidden","hidden"]]]}],
      "dashed": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
                  "important":[],"deps":[],"entries":[["borderStyle",["dashed","dashed"]]]}],
      "released": [{"minWidth":0,"maxWidth":null,"theme":null,"active":false,"focus":null,"disabled":null,"complexity":1,
                    "important":[],"deps":[],"entries":[["opacity",[0.8,0.8]]]}],
      "lh6": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
               "important":[],"deps":[],"entries":[["lineHeight",[6,6]]]}],
      "odd": [{"minWidth":0,"maxWidth":null,"theme":null,"active":null,"focus":null,"disabled":null,"complexity":0,
               "important":[],"deps":[],"entries":[["letterSpacing",[{"$nan":1},{"$inf":-1}]],["width",[{"$u":1},{"$u":1}]]]}],
      "broken": [{"minWidth":"x"}]
    }
  })";
  StyleResolver resolver;
  StyleResolver::Result result;
  const auto unset = StyleResolver::Tri::Unset;
  const auto run = [&](const char* className, int theme = 0, double width = 390,
                       StyleResolver::Tri pressed = StyleResolver::Tri::Unset) -> std::string {
    if (!resolver.resolve(className, theme, width, pressed, unset, unset, result)) {
      return "fallback";
    }

    return folly::toJson(encode(resolver, result));
  };

  ASSERT_TRUE(resolver.load(table));
  EXPECT_EQ(resolver.unsupportedCount(), 1u);

  // key order is first-set order; an important property keeps its value against a later equal-complexity class
  EXPECT_EQ(run("a b"), R"([["color","#222"],["opacity",1]])");
  EXPECT_EQ(run("b a"), R"([["color","#222"],["opacity",1]])");
  EXPECT_EQ(run("a b", 1), R"([["color","#ddd"],["opacity",1]])");
  EXPECT_EQ(result.dependencies, (std::vector<int>{2, 9}));
  EXPECT_EQ(result.dependencySum, (1u << 2) | (1u << 9));
  // a style above the width is skipped, its higher complexity wins when it applies
  EXPECT_EQ(run("md a"), R"([["color","#111"],["opacity",1]])");
  EXPECT_EQ(run("a md b", 0, 1024), R"([["color","#333"],["opacity",1]])");
  // active: true needs isPressed === true; no state is not false
  EXPECT_EQ(run("a press"), R"([["color","#111"],["opacity",1]])");
  EXPECT_EQ(run("a press", 0, 390, StyleResolver::Tri::True), R"([["color","#111"],["opacity",0.5]])");
  // active: false needs isPressed === false: no state is neither
  EXPECT_EQ(run("released"), "[]");
  EXPECT_EQ(run("released", 0, 390, StyleResolver::Tri::False), R"([["opacity",0.8]])");
  // lineHeight under 6 is scaled by fontSize, NaN without one; 6 is not under 6
  EXPECT_EQ(run("text lh6"), R"([["fontSize",16],["lineHeight",6]])");
  EXPECT_EQ(run("text lh"), R"([["fontSize",16],["lineHeight",24]])");
  EXPECT_EQ(run("lh"), R"([["lineHeight",{"$nan":1}]])");
  EXPECT_EQ(run("invisible"), R"([["visibility","hidden"],["display","none"]])");
  EXPECT_EQ(run("dashed"), R"([["borderStyle","dashed"],["borderColor","#000000"]])");
  // values JSON has no literal for
  ASSERT_EQ(run("odd", 1), R"([["letterSpacing",{"$inf":-1}],["width",{"$u":1}]])");
  ASSERT_EQ(run("odd"), R"([["letterSpacing",{"$nan":1}],["width",{"$u":1}]])");
  // split rules: ' ' only, unless there is a newline
  EXPECT_EQ(run("a\tb"), "[]");
  EXPECT_EQ(run("a\n\tb"), R"([["color","#222"],["opacity",1]])");
  EXPECT_EQ(run("  a  "), R"([["color","#111"],["opacity",1]])");
  EXPECT_EQ(run("a\nb\xC2\xA0"), "fallback");
  // fallback classes, Object.prototype names, unreadable classes
  EXPECT_EQ(run("a fb"), "fallback");
  EXPECT_EQ(run("toString"), "fallback");
  EXPECT_EQ(run("broken"), "fallback");
  EXPECT_EQ(run("unknown"), "[]");
  EXPECT_EQ(run("a", 2), "fallback");
  // the scratch state is clean after every call, fallback included
  EXPECT_EQ(run("a press fb", 0, 390, StyleResolver::Tri::True), "fallback");
  EXPECT_EQ(run("a"), R"([["color","#111"],["opacity",1]])");
}
