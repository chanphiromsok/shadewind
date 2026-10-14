// Reads lines "<css>\t<expected ARGB hex>" produced by tests/gen_colors.mjs (culori + the same clamp policy)
// and reports mismatches. Build: clang++ -O2 -std=c++17 -I.. color_parity.cpp -o color_parity
#include "../css/ColorParser.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>

using margelo::nitro::shadewind::css::parseColor;

int main(int argc, char** argv) {
  std::ifstream in(argc > 1 ? argv[1] : "colors.tsv");
  std::string line;
  size_t total = 0, parseFail = 0, exact = 0, within1 = 0, worse = 0;
  int maxDelta = 0;
  std::string worstCase;

  while (std::getline(in, line)) {
    const size_t tab = line.find('\t');

    if (tab == std::string::npos) {
      continue;
    }

    const std::string css = line.substr(0, tab);
    const uint32_t expected = static_cast<uint32_t>(std::strtoul(line.c_str() + tab + 1, nullptr, 16));
    const auto got = parseColor(css);
    total++;

    if (!got) {
      parseFail++;
      std::printf("PARSE FAIL  %s\n", css.c_str());
      continue;
    }

    int d = 0;

    for (int shift = 0; shift < 32; shift += 8) {
      const int a = static_cast<int>((*got >> shift) & 0xFF);
      const int b = static_cast<int>((expected >> shift) & 0xFF);
      d = std::max(d, std::abs(a - b));
    }

    if (d == 0) {
      exact++;
    } else if (d <= 1) {
      within1++;
    } else {
      worse++;
      std::printf("DELTA %d  %s  got %08x want %08x\n", d, css.c_str(), *got, expected);
    }

    if (d > maxDelta) {
      maxDelta = d;
      worstCase = css;
    }
  }

  std::printf("total %zu  exact %zu  within1 %zu  worse %zu  parseFail %zu  maxDelta %d  (%s)\n", total, exact, within1, worse,
              parseFail, maxDelta, worstCase.c_str());

  return (worse || parseFail) ? 1 : 0;
}
