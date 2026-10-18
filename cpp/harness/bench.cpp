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
//   BENCH_PROFILE=1 build/harness_bench --runs 3
//                                  the current engine on the 2003-view screen only, in this process (no fork; BENCH_PROFILE=none:
//                                  no engine, the same React work; BENCH_MOUNT_ONLY=1: the render scenario alone): for callgrind,
//                                  e.g. valgrind --tool=callgrind --toggle-collect='*ThemeHook::prewarm*' ...

#include "App.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <numeric>
#include <string>

#include <sys/wait.h>
#include <unistd.h>

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

  app.setChecks(false);
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

  if (std::getenv("BENCH_MOUNT_ONLY")) { // profiling the render scenario alone
    record("2003 views (uniwind-benchmarks screen)", "mount: React commit (hook + layout)", engine.name(), commit.median());
    record("2003 views (uniwind-benchmarks screen)", "mount: refs attach + flush", engine.name(), refs.median());
    return;
  }

  // an unrelated React commit with no switch so far
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 1 + run % 2));
    reactBefore.add(ms(t0, Clock::now()));
  }

  const bool themes = std::strcmp(engine.name(), "none") != 0;
  Series afterSync, asyncCommit, firstAfterAsync, secondAfterAsync;

  // theme scenario, 'hook': the switch commits on the JS thread (also Android today)
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.setTheme(run % 2 == 0 ? "dark" : "light");
    theme.add(ms(t0, Clock::now()));

    const int measuresBefore = app.react().measures();
    const auto c0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 3 + run % 2));
    afterSync.add(ms(c0, Clock::now()));

    if (std::getenv("BENCH_DEBUG") && run == runs - 1) {
      const auto st = engine.stats();

      std::fprintf(stderr, "%s next commit: applied=%d visited=%d skipped=%d measures=%d\n", engine.name(), st.applied, st.visited,
                   st.skipped, app.react().measures() - measuresBefore);
    }
  }

  // 'hookAsync' (iOS default): the switch commits on a background thread, so React's handles keep the pre-switch nodes until
  // the next React commit themes them again on the JS thread
  for (int run = 0; run < runs; run++) {
    const auto t0 = Clock::now();

    app.setThemeAsync(run % 2 == 0 ? "dark" : "light");
    asyncCommit.add(ms(t0, Clock::now()));

    const auto c0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 5 + run % 2));

    const auto c1 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 7 + run % 2));
    firstAfterAsync.add(ms(c0, c1));
    secondAfterAsync.add(ms(c1, Clock::now()));
  }

  // verify once, untimed: every themed view holds the theme after a sync and an async switch
  if (themes) {
    app.setChecks(true);
    app.setTheme(app.theme() == "dark" ? "light" : "dark");

    int stale = app.lastThemeCommit().stale;

    app.setThemeAsync(app.theme() == "dark" ? "light" : "dark");
    stale += app.lastThemeCommit().stale;
    app.rerender(*leaf, folly::dynamic::object("height", 9));
    stale += app.lastReactCommit().stale;

    if (stale != 0) {
      std::fprintf(stderr, "%s: %d stale views\n", engine.name(), stale);
      std::exit(2);
    }
  }

  const std::string sc = "2003 views (uniwind-benchmarks screen)";
  const std::string e = engine.name();

  record(sc, "mount: create nodes (render, same for all)", e, render.median());
  record(sc, "mount: React commit (hook + layout)", e, commit.median());
  record(sc, "mount: refs attach + flush", e, refs.median());
  record(sc, "mount: total", e, total.median());
  record(sc, "prewarm after mount (off JS thread on iOS)", e, prewarm.median());
  record(sc, "React commit, before any switch", e, reactBefore.median());
  record(sc, "switch, sync ('hook', JS thread)", e, theme.median());
  record(sc, "  next React commit", e, afterSync.median());
  record(sc, "switch, async ('hookAsync', background thread)", e, asyncCommit.median());
  record(sc, "  first React commit after it", e, firstAfterAsync.median());
  record(sc, "  second React commit after it", e, secondAfterAsync.median());
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

  const bool themes = std::strcmp(engine.name(), "none") != 0;
  Series sync, async, reveal, revealAsync, reactAfter;
  int staleInReveal = 0;

  // the last round is untimed and checked: what the reveal commits show
  for (int run = 0; run <= runs; run++) {
    const bool verify = run == runs;

    app.setChecks(verify);

    // a switch on the JS thread ('hook', Android today)
    const auto t0 = Clock::now();

    app.setTheme(run % 2 == 0 ? "dark" : "light");
    sync.add(ms(t0, Clock::now()));

    // open tab 1 (reveal) and leave it again (hide); time the reveal commit plus its flush
    const auto r0 = Clock::now();

    app.reveal(*screens[1]);
    reveal.add(ms(r0, Clock::now()));
    staleInReveal = std::max(staleInReveal, app.lastReactCommit().stale);
    app.hide(*screens[1]);

    // the same with the iOS default: the switch commits off the JS thread
    const auto a0 = Clock::now();

    app.setThemeAsync(run % 2 == 0 ? "light" : "dark");
    async.add(ms(a0, Clock::now()));

    const auto r1 = Clock::now();

    app.reveal(*screens[1]);
    revealAsync.add(ms(r1, Clock::now()));
    staleInReveal = std::max(staleInReveal, app.lastReactCommit().stale);
    app.hide(*screens[1]);

    const auto c0 = Clock::now();

    app.rerender(*leaf, folly::dynamic::object("height", 1 + run % 2));
    reactAfter.add(ms(c0, Clock::now()));

    if (verify) {
      for (auto* series : {&sync, &async, &reveal, &revealAsync, &reactAfter}) {
        series->values.pop_back();
      }
    }
  }

  const std::string sc = std::to_string(tabs) + " tabs x " + std::to_string(cards) + " cards, " + std::to_string(tabs - 1) +
      " frozen (freezeOnBlur)";
  const std::string e = engine.name();

  record(sc, "switch, sync ('hook', JS thread)", e, sync.median());
  record(sc, "switch, async ('hookAsync', background thread)", e, async.median());
  record(sc, "reveal a frozen tab after a sync switch (commit + flush)", e, reveal.median());
  record(sc, "reveal a frozen tab after an async switch (commit + flush)", e, revealAsync.median());

  if (themes) {
    record(sc, "stale views in a reveal commit (max over all runs)", e, staleInReveal);
  }

  record(sc, "unrelated React commit", e, reactAfter.median());
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

// Runs one arm in a child process: every arm starts from a fresh heap, so one arm's allocations do not slow the next.
void isolated(const std::function<void()>& arm) {
  int fds[2];

  if (pipe(fds) != 0) {
    std::perror("pipe");
    std::exit(1);
  }

  const pid_t pid = fork();

  if (pid == 0) {
    close(fds[0]);
    arm();

    for (const auto& row : gRows) {
      for (const auto& [engine, value] : row.byEngine) {
        dprintf(fds[1], "%s\t%s\t%s\t%.6f\n", row.scenario.c_str(), row.metric.c_str(), engine.c_str(), value);
      }
    }

    close(fds[1]);
    _exit(0);
  }

  close(fds[1]);

  std::string data;
  char buffer[4096];
  ssize_t n;

  while ((n = read(fds[0], buffer, sizeof(buffer))) > 0) {
    data.append(buffer, static_cast<size_t>(n));
  }

  close(fds[0]);

  int status = 0;

  waitpid(pid, &status, 0);

  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    std::fprintf(stderr, "an arm failed (status %d)\n", status);
    std::exit(1);
  }

  size_t start = 0;

  while (start < data.size()) {
    const size_t end = data.find('\n', start);
    const std::string line = data.substr(start, end - start);
    std::vector<std::string> fields;
    size_t from = 0;

    for (size_t tab; (tab = line.find('\t', from)) != std::string::npos; from = tab + 1) {
      fields.push_back(line.substr(from, tab - from));
    }

    fields.push_back(line.substr(from));

    if (fields.size() == 4) {
      record(fields[0], fields[1], fields[2], std::stod(fields[3]));
    }

    start = end == std::string::npos ? data.size() : end + 1;
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

  if (const char* profile = std::getenv("BENCH_PROFILE")) { // profiling: one engine in this process (see the header)
    if (std::strcmp(profile, "none") == 0) {
      theirBenchmark<NoEngine>(1000, runs); // the same React work without an engine, to subtract
    } else {
      theirBenchmark<CurrentEngine>(1000, runs);
    }

    print();
    return 0;
  }

  isolated([&] { theirBenchmark<NoEngine>(1000, runs); });
  isolated([&] { theirBenchmark<BaselineEngine>(1000, runs); });
  isolated([&] { theirBenchmark<CurrentEngine>(1000, runs); });

  isolated([&] { tabsBenchmark<NoEngine>(5, 400, runs); });
  isolated([&] { tabsBenchmark<BaselineEngine>(5, 400, runs); });
  isolated([&] { tabsBenchmark<CurrentEngine>(5, 400, runs); });

  print();

  return 0;
}
