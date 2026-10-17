// css::ClassMerge against tailwind-merge 3.7.0: fixtures/classmerge/cases.tsv holds 3000 random class strings plus every pair of modifiers in both orders, and twMerge's
// output for each (generate.mjs), table.tsv the table bin/cn-table.mjs built from them. The native merge must give the same bytes.

#include "css/ClassMerge.hpp"

#include <gtest/gtest.h>

#include <fstream>
#include <sstream>
#include <string>

using margelo::nitro::shadewind::css::ClassMerge;

namespace {

std::string slurp(const std::string& path) {
  std::ifstream file(path);
  std::stringstream text;

  text << file.rdbuf();

  return text.str();
}

} // namespace

TEST(ClassMerge, MatchesTailwindMerge) {
  ClassMerge merge;

  ASSERT_TRUE(merge.load(slurp(std::string(FIXTURES_DIR) + "/classmerge/table.tsv")));

  std::istringstream cases(slurp(std::string(FIXTURES_DIR) + "/classmerge/cases.tsv"));
  std::string line;
  int checked = 0;

  while (std::getline(cases, line)) {
    const auto tab = line.find('\t');

    ASSERT_NE(tab, std::string::npos);

    const std::string input = line.substr(0, tab);
    const std::string expected = line.substr(tab + 1);
    const std::string_view inputs[1] = {input};
    std::string out;

    ASSERT_TRUE(merge.merge(inputs, 1, out)) << input;
    EXPECT_EQ(out, expected) << input;
    ++checked;
  }

  EXPECT_EQ(checked, 3000 + 13 * 12 * 2);
}

TEST(ClassMerge, OrderSensitiveModifiersAreBarriers) {
  ClassMerge merge;

  ASSERT_TRUE(merge.load("G\t1\nS\tbefore\nK\t0\t0\nT\tp-1\t0\nT\tp-2\t0\n"));

  const auto run = [&](const std::string& input) {
    const std::string_view inputs[1] = {input};
    std::string out;

    EXPECT_TRUE(merge.merge(inputs, 1, out));

    return out;
  };

  EXPECT_EQ(run("hover:before:p-1 before:hover:p-2"), "hover:before:p-1 before:hover:p-2");
  EXPECT_EQ(run("focus:hover:p-1 hover:focus:p-2"), "hover:focus:p-2");
}
