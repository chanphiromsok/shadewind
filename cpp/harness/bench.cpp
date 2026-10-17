// Engine cost inside React Native's renderer, three arms on identical trees:
//   none      plain React Native (the floor)
//   baseline  the engine at 44eb043 with that commit's JS ref policy
//   current   this branch
//
// What is measured is the native side only: React's commit (with the commit hook and Yoga layout), the registrations the refs
// make, the flush after a commit, a theme switch. JS work (React render, the adapter hooks, Uniwind's style resolution) is not here;
// it is the same for both engine arms except for the number of native calls, which `registerCalls` counts.
//
//   build/harness_bench            all scenarios, a table
//   build/harness_bench --json     the same as JSON lines

#include "App.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <numeric>

using namespace harness;

namespace {

using Clock = std::chrono::steady_clock;

bool gJson = false;

double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

struct Series {
  std::vector<double> values;

  void add(double v) {
    values.push_back(v);
  }

  double median() const {
    if (values.empty()) {
      return 0;
    }

    auto sorted = values;

    std::sort(sorted.begin(), sorted.end());

    return sorted[sorted.size() / 2];
  }
};

struct Row {
  std::string scenario;
  std::string metric;
  std::map<std::string, double> byEngine;
  std::string note;
};

std::vector<Row> gRows;

void record(const std::string& scenario, const std::string& metric, const std::string& engine, double value, const std::string& note = "") {
  for (auto& row : gRows) {
    if (row.scenario == scenario && row.metric == metric) {
      row.byEngine[engine] = value;
      return;
    }
  }

  gRows.push_back({scenario, metric, {{engine, value}}, note});
}

const std::vector<std::string> kThemes{"light", "dark"};

struct Styles {
  Style primary = makeStyle(1, "backgroundColor", {{"light", 0xFF3B82F6}, {"dark", 0xFF1E3A8A}});
  Style typography = makeStyle(2, "color", {{"light", 0xFF111827}, {"dark", 0xFFF9FAFB}});
  Style card = makeStyle(3, "backgroundColor", {{"light", 0xFFFFFFFF}, {"dark", 0xFF1C1C1E}});
  Style gray = makeStyle(4, "backgroundColor", {{"light", 0xFFE5E7EB}, {"dark", 0xFF374151}});
};

// uniwind-benchmarks' screen: a header card plus 1000 grid items (themed View + themed Text), 2003 views
Instance* theirScreen(App& app, const Styles& s, int items) {
  std::vector<Instance*> grid;

  grid.reserve(items);

  for (int i = 0; i < items; i++) {
    grid.push_back(app.view(
        s.primary, {app.text(s.typography, std::to_string(i))},
        folly::dynamic::object("width", 120)("height", 100)("borderRadius", 16)("alignItems", "center")("justifyContent", "center")));
  }

  auto* header = app.view(s.gray, {app.text(s.typography, "Running benchmark..."), app.text(s.typography, "Run 1 of 10")},
                          folly::dynamic::object("padding", 16));
  auto* list = app.plainView(std::move(grid), folly::dynamic::object("flexDirection", "row")("flexWrap", "wrap")("gap", 8));

  return app.plainView({app.text(s.typography, "Benchmark"), header, list}, folly::dynamic::object("flex", 1));
}

// an app tab: cards of themed View > [themed Text, plain View > plain View]
Instance* tab(App& app, const Styles& s, int cards) {
  std::vector<Instance*> children;

  for (int i = 0; i < cards; i++) {
    auto* inner = app.plainView({app.plainView({}, folly::dynamic::object("height", 4))}, folly::dynamic::object("padding", 2));

    children.push_back(app.view(s.card, {app.text(s.typography, "post " + std::to_string(i)), inner}, folly::dynamic::object("padding", 8)));
  }

  return app.plainView(std::move(children), folly::dynamic::object("flex", 1));
}

template <typename EngineT>
void theirBenchmark(int items, int runs) {
  EngineT engine;
  Styles s;
  App app(engine, kThemes, "light");
  Series render, commit, refs, flush, total, prewarm, theme, reactAfter, reactBefore;
  Instance* leaf = nullptr;

  // render scenario: re-mount the whole screen, like their `renderKey`
  for (int run = 0; run < runs + 2; run++) {
    const auto t0 = Clock::now();
    auto* screen = theirScreen(app, s, items);

    leaf = app.plainView({}, folly::dynamic::object("height", 1));

    const auto t1 = Clock::now();

    app.mountCommit({screen, leaf});

    const auto t2 = Clock::now();

    // the refs attach after the commit (each one a native register call, or a queued one), then the microtask flush
    app.attachRefs();

    const auto t3 = Clock::now();

    app.collectGarbage();

    if (run >= 2) {
      render.add(ms(t0, t1));
      commit.add(ms(t1, t2));
      refs.add(ms(t2, t3));
      total.add(ms(t0, t3));
    }

    const auto p0 = Clock::now();

    engine.prewarm();

    if (run >= 2) {
      prewarm.add(ms(p0, Clock::now()));
    }
  }

  // an unrelated React commit with no switch so far
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 1 + run % 2));
    reactBefore.add(ms(t0, Clock::now()));
  }

  // theme scenario: switch 10 times, synchronous commit ('hook')
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.setTheme(run % 2 == 0 ? "dark" : "light");
    theme.add(ms(t0, Clock::now()));

    if (app.lastThemeCommit().stale != 0) {
      std::fprintf(stderr, "%s: %d stale views after a switch\n", engine.name(), app.lastThemeCommit().stale);
    }
  }

  // an unrelated React commit after the switches: React's handles still hold the pre-switch nodes
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 3 + run % 2));
    reactAfter.add(ms(t0, Clock::now()));
  }

  const std::string sc = "2003 views (uniwind-benchmarks screen)";
  const std::string e = engine.name();

  record(sc, "mount: create nodes (render)", e, render.median());
  record(sc, "mount: React commit (hook + layout)", e, commit.median());
  record(sc, "mount: refs + flush after commit", e, refs.median());
  record(sc, "mount: total", e, total.median());
  record(sc, "prewarm (off JS thread on iOS)", e, prewarm.median());
  record(sc, "theme switch (sync commit)", e, theme.median());
  record(sc, "React commit, before any switch", e, reactBefore.median());
  record(sc, "React commit, after switches", e, reactAfter.median());
}

template <typename EngineT>
void tabsBenchmark(int tabs, int cards, int runs) {
  EngineT engine;
  Styles s;
  App app(engine, kThemes, "light");
  std::vector<Instance*> screens;

  for (int i = 0; i < tabs; i++) {
    screens.push_back(tab(app, s, cards));
  }

  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));
  auto children = screens;

  children.push_back(leaf);
  app.mount(children);
  engine.prewarm();

  // freezeOnBlur: every tab but the first is suspended
  for (int i = 1; i < tabs; i++) {
    app.hide(*screens[i]);
  }

  engine.prewarm();

  Series theme, reveal, reactAfter;
  int staleInReveal = 0;

  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.setTheme(run % 2 == 0 ? "dark" : "light");
    theme.add(ms(t0, Clock::now()));

    // open tab 1 (reveal) and leave it again (hide); time the reveal commit plus its flush
    const auto r0 = Clock::now();

    app.reveal(*screens[1]);
    reveal.add(ms(r0, Clock::now()));
    staleInReveal = std::max(staleInReveal, app.lastReactCommit().stale);

    app.hide(*screens[1]);

    const auto c0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 1 + run % 2));
    reactAfter.add(ms(c0, Clock::now()));
  }

  const std::string sc = std::to_string(tabs) + " tabs x " + std::to_string(cards) + " cards, " + std::to_string(tabs - 1) +
      " frozen (freezeOnBlur)";
  const std::string e = engine.name();

  record(sc, "theme switch (sync commit)", e, theme.median());
  record(sc, "reveal a frozen tab (commit + flush)", e, reveal.median());
  record(sc, "stale views in the reveal commit (max)", e, staleInReveal);
  record(sc, "React commit, after switches", e, reactAfter.median());
}

void print() {
  const char* engines[] = {"none", "baseline", "current"};

  if (gJson) {
    for (const auto& row : gRows) {
      std::printf("{\"scenario\":\"%s\",\"metric\":\"%s\"", row.scenario.c_str(), row.metric.c_str());

      for (const auto* e : engines) {
        if (row.byEngine.count(e)) {
          std::printf(",\"%s\":%.4f", e, row.byEngine.at(e));
        }
      }

      std::printf("}\n");
    }

    return;
  }

  std::string scenario;

  for (const auto& row : gRows) {
    if (row.scenario != scenario) {
      scenario = row.scenario;
      std::printf("\n## %s\n\n| metric | none | baseline (44eb043) | current |\n|---|---|---|---|\n", scenario.c_str());
    }

    std::printf("| %s |", row.metric.c_str());

    for (const auto* e : engines) {
      if (row.byEngine.count(e)) {
        const bool count = row.metric.find("stale") != std::string::npos;

        std::printf(count ? " %.0f |" : " %.3f ms |", row.byEngine.at(e));
      } else {
        std::printf(" - |");
      }
    }

    std::printf("\n");
  }
}

} // namespace

int main(int argc, char** argv) {
  int runs = 15;

  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--json") == 0) {
      gJson = true;
    } else if (std::strcmp(argv[i], "--runs") == 0 && i + 1 < argc) {
      runs = std::atoi(argv[++i]);
    }
  }

  theirBenchmark<NoEngine>(1000, runs);
  theirBenchmark<BaselineEngine>(1000, runs);
  theirBenchmark<CurrentEngine>(1000, runs);

  tabsBenchmark<NoEngine>(5, 400, runs);
  tabsBenchmark<BaselineEngine>(5, 400, runs);
  tabsBenchmark<CurrentEngine>(5, 400, runs);

  print();

  return 0;
}
