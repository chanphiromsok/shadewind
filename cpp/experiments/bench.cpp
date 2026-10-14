// Micro-benchmark: the hook's per-node question "is this family registered?" for a tree walk.
// Build:  clang++ -O2 -std=c++17 bench.cpp -o bench && ./bench
#include "FamilyIndex.hpp"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <unordered_map>
#include <vector>

using Clock = std::chrono::steady_clock;

static double run(const char* name, size_t registered, size_t treeNodes, bool cold) {
  // allocate "families" the way RN does: separate heap objects with some neighbours between them
  std::mt19937_64 rng(42);
  std::vector<void*> nodes(treeNodes);

  for (auto& n : nodes) {
    n = std::malloc(64 + (rng() % 3) * 32);
  }

  std::vector<void*> order = nodes;
  std::shuffle(order.begin(), order.end(), rng);

  std::unordered_map<const void*, uint32_t> stdMap;
  FamilyIndex flat(registered);

  for (size_t i = 0; i < registered; i++) {
    stdMap.emplace(nodes[i * (treeNodes / registered)], static_cast<uint32_t>(i));
    flat.insert(nodes[i * (treeNodes / registered)], static_cast<uint32_t>(i));
  }

  std::vector<char> thrash(cold ? 64 * 1024 * 1024 : 1);
  auto flush = [&] {
    if (cold) {
      for (size_t i = 0; i < thrash.size(); i += 64) {
        thrash[i]++;
      }
    }
  };

  const int reps = cold ? 5 : 200;
  uint64_t sink = 0;
  double tStd = 0, tFlat = 0;

  for (int r = 0; r < reps; r++) {
    flush();
    auto a = Clock::now();

    for (void* p : order) {
      auto it = stdMap.find(p);
      sink += it == stdMap.end() ? 0 : it->second + 1;
    }

    tStd += std::chrono::duration<double, std::nano>(Clock::now() - a).count();
    flush();
    a = Clock::now();

    for (void* p : order) {
      const uint32_t v = flat.find(p);
      sink += v == FamilyIndex::kNotFound ? 0 : v + 1;
    }

    tFlat += std::chrono::duration<double, std::nano>(Clock::now() - a).count();
  }

  const double perStd = tStd / reps / treeNodes;
  const double perFlat = tFlat / reps / treeNodes;

  std::printf("%-28s nodes=%-7zu registered=%-6zu %s  std %6.1f ns/node   simd %6.1f ns/node   x%.2f   (sink %llu)\n", name, treeNodes,
              registered, cold ? "cold" : "hot ", perStd, perFlat, perStd / perFlat, static_cast<unsigned long long>(sink & 1));

  for (void* n : nodes) {
    std::free(n);
  }

  return perStd / perFlat;
}

int main() {
#if FI_NEON
  std::puts("backend: NEON");
#elif FI_SSE2
  std::puts("backend: SSE2");
#else
  std::puts("backend: portable");
#endif
  run("benchmark screen", 2003, 2003, false);
  run("benchmark screen", 2003, 2003, true);
  run("tovtam-like", 108, 6000, false);
  run("tovtam-like", 108, 6000, true);
  run("large app", 500, 50000, false);
  run("large app", 500, 50000, true);

  return 0;
}
