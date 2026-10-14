#pragma once

#include "HybridUniwindShadowSpec.hpp"
#include "ThemeHook.hpp"
#include "ThemeRegistry.hpp"
#include <jsi/jsi.h>
#include <string>

namespace margelo::nitro::uniwindshadow {

using namespace facebook;

class HybridUniwindShadow : public HybridUniwindShadowSpec {
public:
  HybridUniwindShadow() : HybridObject(TAG) {}

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
  jsi::Value setTheme(jsi::Runtime& rt, const jsi::Value& thisValue, const jsi::Value* args, size_t count);

  void loadHybridMethods() override;

private:
  void schedulePrewarm();

  ThemeRegistry _registry;
  std::shared_ptr<ThemeHook> _hook = std::make_shared<ThemeHook>();
  bool _hookRegistered = false;
  bool _hookMode = true; // false after a setTheme with an older strategy
  std::string _theme;
  std::mutex _themeMutex;
};

} // namespace margelo::nitro::uniwindshadow
