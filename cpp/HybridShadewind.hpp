#pragma once

#include "HybridShadewindSpec.hpp"
#include "ThemeEngine.hpp"
#include "ThemeTransition.hpp"
#include <jsi/jsi.h>
#include <atomic>
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
  jsi::Value registerMany(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value unregisterNode(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value inspect(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value flushPending(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value resetMainBusy(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value mainBusyMs(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value prepare(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value configure(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value loadClassTable(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value mergeClasses(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value loadStyleTable(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value resolveStyleClasses(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);
  jsi::Value setTheme(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);

  void loadHybridMethods() override;

private:
  // The hook is registered with React Native's UIManager, which keeps a raw pointer to it. A HybridObject dies whenever
  // Hermes collects it (Fast Refresh creates a new one), so the state lives for the process and every instance shares it.
  struct State {
    ThemeEngine engine;
    ThemeTransition transition{engine.hook()};
    std::weak_ptr<const ContextContainer> registeredContainer; // identifies the UIManager the hook is registered with
    std::weak_ptr<const ContextContainer> transitionContainer; // the UIManager the mount hook is registered with (on first use)
    std::atomic<bool> prewarmScheduled{false};
  };

  static State& sharedState();

  // Registers the hook with the runtime's UIManager once. Returns the UIManager, or null without Fabric.
  UIManager* attachedUIManager(jsi::Runtime& rt);
  void registerOne(jsi::Runtime& rt, UIManager& ui, const jsi::Value& node, const jsi::Value& props, const jsi::Value& styleId, const jsi::Value& renderTheme);
  void schedulePrewarm();

  State& _state = sharedState();
  ThemeEngine& _engine = _state.engine;
};

} // namespace margelo::nitro::shadewind
