// The premise hookDeferred rests on, run on React Native 0.86.2's own RuntimeScheduler_Modern with a Hermes runtime: a Low task
// (the engine's fallback commit, scheduled by setTheme) runs after the Normal and UserBlocking tasks React schedules for the
// re-render the switch causes, also when they are scheduled after it and when a render task schedules its own continuation (a
// render React splits). An Idle task runs after it. Exits non-zero on a different order.

#include <hermes/hermes.h>
#include <react/featureflags/ReactNativeFeatureFlags.h>
#include <react/featureflags/ReactNativeFeatureFlagsDefaults.h>
#include <react/renderer/runtimescheduler/RuntimeScheduler.h>

#include <cstdio>
#include <deque>
#include <functional>
#include <string>
#include <vector>

using namespace facebook;
using namespace facebook::react;

// RuntimeScheduler_Modern reports long tasks only to a PerformanceEntryReporter it was given; this run gives none, so the timeline
// library (and what it pulls in) is not linked and this is never called.
void facebook::react::PerformanceEntryReporter::reportLongTask(HighResTimeStamp, HighResDuration) {}

namespace {

class Flags final : public ReactNativeFeatureFlagsDefaults {
public:
  bool enableBridgelessArchitecture() override {
    return true; // RuntimeScheduler_Modern, the event loop of a bridgeless app
  }
};

} // namespace

int main() {
  ReactNativeFeatureFlags::override(std::make_unique<Flags>());

  auto runtime = facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build());
  std::deque<std::function<void()>> jsThread;
  RuntimeExecutor executor = [&](std::function<void(jsi::Runtime&)>&& callback) {
    jsThread.push_back([&, callback = std::move(callback)]() { callback(*runtime); });
  };
  RuntimeScheduler scheduler(executor);
  std::vector<std::string> order;

  // the switch's task (a timer, the appearance listener): setTheme schedules the fallback, then Uniwind's subscribers make React
  // schedule its render (Default lane: Normal priority), which yields once and schedules a continuation
  scheduler.scheduleTask(SchedulerPriority::NormalPriority, [&](jsi::Runtime&) {
    order.push_back("switch");
    scheduler.scheduleTask(SchedulerPriority::LowPriority, [&](jsi::Runtime&) { order.push_back("fallback (Low)"); });
    scheduler.scheduleTask(SchedulerPriority::IdlePriority, [&](jsi::Runtime&) { order.push_back("idle-lane render (Idle)"); });
    scheduler.scheduleTask(SchedulerPriority::NormalPriority, [&](jsi::Runtime&) {
      order.push_back("render (Normal)");
      scheduler.scheduleTask(SchedulerPriority::NormalPriority, [&](jsi::Runtime&) { order.push_back("render continuation (Normal)"); });
    });
    scheduler.scheduleTask(SchedulerPriority::UserBlockingPriority, [&](jsi::Runtime&) { order.push_back("continuous-lane render (UserBlocking)"); });
  });

  while (!jsThread.empty()) {
    auto next = std::move(jsThread.front());

    jsThread.pop_front();
    next();
  }

  const std::vector<std::string> expected = {
      "switch",
      "continuous-lane render (UserBlocking)",
      "render (Normal)",
      "render continuation (Normal)",
      "fallback (Low)",
      "idle-lane render (Idle)"};

  for (const auto& item : order) {
    std::printf("%s\n", item.c_str());
  }

  const bool ok = order == expected;

  std::printf("%s\n", ok ? "ORDER OK" : "ORDER DIFFERS");
  return ok ? 0 : 1;
}
