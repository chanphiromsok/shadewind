#pragma once
#include <map>

#include "HybridShadewindSpec.hpp"
#include "ThemeHook.hpp"
#include "ThemeRegistry.hpp"
#include <jsi/jsi.h>
#include <string>

namespace margelo::nitro::shadewind {

using namespace facebook;

class HybridShadewind : public HybridShadewindSpec {
public:
  HybridShadewind() : HybridObject(TAG) {}

  // typed (generated spec)
  std::string getTheme() override;

  // raw JSI: they need the runtime to reach React Native's UIManager
  jsi::Value registerNode(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value unregisterNode(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value refreshReactNodes(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value inspect(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value flushPending(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value resetMainBusy(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value mainBusyMs(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value prepare(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value configure(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value loadClassTable(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value mergeClasses(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value setTheme(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);

  void loadHybridMethods() override;

private:
  void schedulePrewarm();

  // The hook is registered with React Native's UIManager, which keeps a raw pointer to it. A HybridObject dies whenever
  // Hermes collects it (Fast Refresh creates a new one), so the state lives for the process and every instance shares it.
  struct State {
    ThemeRegistry registry;
    // Views of one className register the same per-theme style: the JS side tags it with an id, and the parsed props and the
    // typed deltas are built once per (id, surface) instead of once per view.
    struct SharedStyle {
      std::shared_ptr<const PropsByTheme> props;
      std::unordered_map<std::string, std::shared_ptr<const TypedDelta>> typed;
    };
    std::map<std::pair<int64_t, int>, SharedStyle> styleCache;
    std::mutex styleMutex;
    std::shared_ptr<ThemeHook> hook = std::make_shared<ThemeHook>();
    std::weak_ptr<const ContextContainer> registeredContainer; // identifies the UIManager the hook is registered with
    bool hookMode = true; // false after a setTheme with an older strategy
    std::string theme;
    std::mutex themeMutex;
  };

  static State& sharedState();
  bool hookRegisteredWith(UIManager& ui);

  State& _state = sharedState();
  ThemeRegistry& _registry = _state.registry;
  std::shared_ptr<ThemeHook>& _hook = _state.hook;
  bool& _hookMode = _state.hookMode;
  std::string& _theme = _state.theme;
  std::mutex& _themeMutex = _state.themeMutex;
};

} // namespace margelo::nitro::shadewind
