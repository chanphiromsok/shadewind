#pragma once

// Development diagnostics (`shadewind/diagnostics`): what the commit hook registers, drops and updates, recorded natively and read by
// JS with drainDiagnostics(). Compiled in only when SHADEWIND_DIAGNOSTICS is 1, which the podspec (Debug configuration) and
// build.gradle (debug build type) define: a release build has no recorder, and flags() is a constant 0 the compiler folds away.
// Compiled in, it is off until JS turns it on; while off the hook pays one relaxed atomic load per commit and per registration.

#ifndef SHADEWIND_DIAGNOSTICS
#define SHADEWIND_DIAGNOSTICS 0
#endif

#include <folly/dynamic.h>
#include <react/renderer/core/ReactPrimitives.h>
#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace margelo::nitro::shadewind {

namespace diagnostics {

inline constexpr uint32_t kMounts = 1;   // a view was registered
inline constexpr uint32_t kUnmounts = 2; // a registered view left (unmounted and released) or was unbound
inline constexpr uint32_t kUpdates = 4;  // a commit applied theme props

// Events kept between two drains. Past it the oldest are dropped and counted: a screen of thousands of views logs while JS is busy.
inline constexpr size_t kCapacity = 4096;

} // namespace diagnostics

// One view the hook cloned with its theme's props.
struct DiagnosticUpdate {
  facebook::react::Tag tag = 0;
  const char* component = nullptr;
  int64_t styleId = -1;
  folly::dynamic props; // what the theme gives the view, as JS registered it (colours as ARGB numbers)
  bool themeChange = false; // the theme changed since the view was last themed (otherwise React replaced its props)
  bool textWithoutLayout = false; // a Paragraph recoloured without a layout pass
};

struct DiagnosticEvent {
  enum class Kind : uint8_t {
    Registered,   // a view was bound to a style
    Unregistered, // a bound view was unmounted and released
    Unbound,      // a mounted view was unbound (unregister: a pressed Pressable, a style the engine no longer takes)
    Commit,       // a commit that applied theme props
  };

  Kind kind = Kind::Registered;
  facebook::react::Tag tag = 0;
  const char* component = nullptr;
  int64_t styleId = -1;
  size_t live = 0; // registered views after this event

  // Commit
  std::string theme;
  bool themeChanged = false; // the first commit after a theme switch (otherwise: React replaced props of themed views)
  int reused = 0;
  int skipped = 0;
  int hidden = 0;
  double ms = 0;
  std::vector<DiagnosticUpdate> updates;
};

// Bounded event queue. Its own lock: the hook appends while holding its commit lock, JS drains without ever taking that one.
class DiagnosticLog {
public:
  static constexpr bool available() {
    return SHADEWIND_DIAGNOSTICS != 0;
  }

  uint32_t flags() const {
#if SHADEWIND_DIAGNOSTICS
    return _flags.load(std::memory_order_relaxed);
#else
    return 0;
#endif
  }

  // Turning diagnostics off also drops what was not read. Without the recorder compiled in, nothing is ever turned on.
  void setFlags(uint32_t flags) {
    if (!available()) {
      return;
    }

    _flags.store(flags, std::memory_order_relaxed);

    if (flags == 0) {
      std::lock_guard<std::mutex> lock(_mutex);
      _events.clear();
      _dropped = 0;
    }
  }

  void push(DiagnosticEvent event) {
    std::lock_guard<std::mutex> lock(_mutex);

    if (_events.size() >= diagnostics::kCapacity) {
      _events.pop_front();
      ++_dropped;
    }

    _events.push_back(std::move(event));
  }

  // Everything recorded since the last drain, oldest first, and how many events were dropped meanwhile.
  std::pair<std::vector<DiagnosticEvent>, uint64_t> drain() {
    std::lock_guard<std::mutex> lock(_mutex);
    std::vector<DiagnosticEvent> events(std::make_move_iterator(_events.begin()), std::make_move_iterator(_events.end()));
    const uint64_t dropped = _dropped;

    _events.clear();
    _dropped = 0;

    return {std::move(events), dropped};
  }

private:
  std::atomic<uint32_t> _flags{0};
  std::mutex _mutex;
  std::deque<DiagnosticEvent> _events;
  uint64_t _dropped = 0;
};

} // namespace margelo::nitro::shadewind
