#pragma once

// Animated theme change, the part that is the same on both platforms: knowing WHEN the new theme is on screen.
//
// The overlay itself (snapshot, fade, removal) is native (ShadewindNative.hpp). This class decides when to start the fade: it is a
// React Native mount hook, which Fabric calls on the main / UI thread after a transaction was mounted (iOS: RCTSurfacePresenter,
// Android: FabricUIManager, both from the "mounted" notification they post once the views are updated). The hook gets the root of
// the mounted tree. ThemeHook remembers which theme epoch every tree it returned carries, so "the new theme is mounted" is:
// the mounted root carries the epoch setTheme started. That holds for every strategy (hook, hookAsync, hookDeferred) because it does
// not depend on who committed or when; a mount of an older tree (a commit that was in flight) does not start the fade.

#include "ShadewindNative.hpp"
#include "ThemeHook.hpp"

#include <react/renderer/uimanager/UIManagerMountHook.h>
#include <atomic>
#include <mutex>

namespace margelo::nitro::shadewind {

using namespace facebook::react;

class ThemeTransition final : public UIManagerMountHook {
public:
  explicit ThemeTransition(ThemeHook& hook) : _hook(hook) {}

  // JS thread: after ThemeHook::setTheme (so its epoch is the one to wait for), before the commit.
  void begin(ThemeTransitionPreset preset, double durationMs) {
    _hook.watchMounts();

    uint64_t id = 0;

    {
      std::lock_guard<std::mutex> lock(_mutex);
      id = ++_lastId;
      _epoch = _hook.epoch();
      _armed.store(true, std::memory_order_release);
    }

    themeTransitionBegin(id, preset, durationMs);
  }

  // Main / UI thread, after every mount. Idle (one atomic load) unless a transition waits.
  void shadowTreeDidMount(const RootShadowNode::Shared& rootShadowNode, HighResTimeStamp) noexcept override {
    if (!_armed.load(std::memory_order_acquire)) {
      return;
    }

    uint64_t id = 0;

    {
      std::lock_guard<std::mutex> lock(_mutex);

      if (!_armed.load(std::memory_order_relaxed) || !_hook.rootCarries(rootShadowNode.get(), _epoch)) {
        return;
      }

      _armed.store(false, std::memory_order_relaxed);
      id = _lastId;
    }

    themeTransitionRun(id);
  }

private:
  ThemeHook& _hook;
  std::mutex _mutex;
  std::atomic<bool> _armed{false};
  uint64_t _lastId = 0;
  uint64_t _epoch = 0; // the epoch the pending transition waits for
};

} // namespace margelo::nitro::shadewind
