// Symbols the renderer sources reference but a harness commit never calls. They are declared by React Native's headers and
// defined in libraries the harness does not build.

#include <react/renderer/uimanager/UIManager.h>

#include <cstdlib>

namespace facebook::react {

std::shared_ptr<const ContextContainer> UIManager::getContextContainer() const {
  std::abort();
}

} // namespace facebook::react

#include <react/renderer/core/EventBeat.h>

namespace facebook::react {

// EventQueue installs it; events are never dispatched in the harness
void EventBeat::setBeatCallback(BeatCallback) {}

} // namespace facebook::react
