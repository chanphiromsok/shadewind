#pragma once

// The engine as JS drives it, in two versions, so tests and benchmarks compare them on the same trees:
// - Baseline: the engine at 44eb043 (cpp/harness/baseline) with the JS ref policy of that commit: a ref detach (unmount, and a
//   Suspense/Activity hide) unregisters, a re-attach registers again without a render theme, every register is its own native
//   call, and the flush after a commit commits again while any registered view is not applied.
// - Current: cpp/ThemeEngine.hpp with the JS policy of this branch: a detach keeps the registration (React's hide detaches refs,
//   the hook themes the subtree when it shows), registrations are queued and sent in one call after the commit, the flush commits
//   only for a view registered with another theme's props.

#include "FakeReact.hpp"
#include "ThemeEngine.hpp"
#include "baseline/ThemeHook.hpp"
#include "baseline/ThemeRegistry.hpp"

#include <map>
#include <unordered_map>
#include <unordered_set>

namespace harness {

namespace sw = margelo::nitro::shadewind;
namespace base = shadewind_baseline;

// One themed style: what JS registers (theme name -> raw props, colours as ARGB numbers or CSS strings).
struct Style {
  int64_t id = -1;
  sw::PropsByTheme props;
};

struct Stats {
  int applied = 0;
  int reused = 0;
  int scanned = 0;
  int visited = -1; // -1: not reported by this engine
  int skipped = -1;
  int hidden = -1;
  int missNotOurs = 0;
};

class Engine {
public:
  virtual ~Engine() = default;
  virtual const char* name() const = 0;
  virtual UIManagerCommitHook& hook() = 0;
  virtual void attach(std::shared_ptr<const ContextContainer> context) = 0;
  virtual void configure(const std::vector<std::string>& themes) = 0;
  // the JS ref callback with a node; `first`: the node's first attach, so `renderTheme` describes its props
  virtual void attachRef(const std::shared_ptr<const ShadowNode>& node, const Style& style, const std::string& renderTheme, bool first) = 0;
  // the JS ref callback with null: a Suspense/Activity hide or an unmount
  virtual void detachRef(const ShadowNode& node) = 0;
  // the binding goes away while the view stays (pressed Pressable, className no longer themeable)
  virtual void unbind(const ShadowNode& node) = 0;
  virtual void setTheme(const std::string& name) = 0;
  // the microtask after a React commit
  virtual void flush(FakeReact& react) = 0;
  virtual void prewarm() = 0;
  virtual Stats stats() = 0;
  virtual size_t registeredCount() = 0;
};

// ---- 44eb043

class BaselineEngine final : public Engine {
public:
  const char* name() const override {
    return "baseline";
  }

  UIManagerCommitHook& hook() override {
    return *hook_;
  }

  void attach(std::shared_ptr<const ContextContainer> context) override {
    context_ = context;
    hook_->setContextContainer(std::move(context));
  }

  void configure(const std::vector<std::string>& themes) override {
    hook_->declareThemes(themes);
  }

  // makeHolder's ref: unregister what it had, register again (renderTheme on the first attach only), then the native register
  void attachRef(const std::shared_ptr<const ShadowNode>& node, const Style& style, const std::string& renderTheme, bool first) override {
    if (const auto it = registered_.find(&node->getFamily()); it != registered_.end() && !it->second.expired()) {
      unregisterNode(*node);
    }

    registerNode(*node, style, first ? &renderTheme : nullptr);
  }

  void detachRef(const ShadowNode& node) override {
    unregisterNode(node);
  }

  void unbind(const ShadowNode& node) override {
    unregisterNode(node);
  }

  void setTheme(const std::string& name) override {
    theme_ = name;
    hook_->setTheme(name);
  }

  // HybridShadewind::flushPending at 44eb043 (prewarm measured separately: it runs off the JS thread on iOS)
  void flush(FakeReact& react) override {
    if (theme_.empty()) {
      registry_.collectPending("");
      return;
    }

    registry_.collectPending(theme_);

    if (hook_->hasUnapplied()) {
      react.commitTick();
    }
  }

  void prewarm() override {
    hook_->prewarm();
  }

  Stats stats() override {
    const auto s = hook_->stats();

    return {.applied = s.applied, .reused = s.reused, .scanned = s.scanned, .missNotOurs = s.missNotOurs};
  }

  size_t registeredCount() override {
    return registered_.size();
  }

private:
  // HybridShadewind::registerNode at 44eb043, without JSI
  void registerNode(const ShadowNode& node, const Style& style, const std::string* renderTheme) {
    const SurfaceId surface = node.getFamily().getSurfaceId();
    const auto key = std::make_pair(style.id, static_cast<int>(surface));
    SharedStyle shared;
    bool cached = false;

    {
      std::lock_guard<std::mutex> lock(styleMutex_);
      const auto it = styleCache_.find(key);

      if (it != styleCache_.end()) {
        shared = it->second;
        cached = true;
      }
    }

    if (!cached) {
      auto propsByTheme = std::make_shared<base::PropsByTheme>();

      for (auto [name, props] : style.props) {
        sw::normalizeColorStrings(props);
        propsByTheme->emplace(name, std::move(props));
      }

      shared.props = std::move(propsByTheme);

      for (const auto& [name, props] : *shared.props) {
        const auto typed = sw::toTypedDelta(*context_, surface, props);
        auto delta = std::make_shared<base::TypedDelta>();

        delta->background = typed->background;
        delta->border = typed->border;
        delta->text = typed->text;
        delta->opacity = typed->opacity;
        delta->raw = typed->raw;
        shared.typed.emplace(name, std::move(delta));
      }

      std::lock_guard<std::mutex> lock(styleMutex_);
      styleCache_.emplace(key, shared);
    }

    const bool renderedWithCurrent = renderTheme != nullptr && !theme_.empty() && *renderTheme == theme_;

    hook_->add(node.getFamilyShared(), shared.typed, node.getProps(), node.getComponentName(), surface, renderedWithCurrent);
    registry_.add(node.getFamilyShared(), shared.props);
    registered_[&node.getFamily()] = node.getFamilyShared();
  }

  void unregisterNode(const ShadowNode& node) {
    registry_.remove(&node.getFamily());
    hook_->remove(&node.getFamily());
    registered_.erase(&node.getFamily());
  }

  struct SharedStyle {
    std::shared_ptr<const base::PropsByTheme> props;
    std::unordered_map<std::string, std::shared_ptr<const base::TypedDelta>> typed;
  };

  std::shared_ptr<base::ThemeHook> hook_ = std::make_shared<base::ThemeHook>();
  base::ThemeRegistry registry_;
  std::map<std::pair<int64_t, int>, SharedStyle> styleCache_;
  std::mutex styleMutex_;
  std::shared_ptr<const ContextContainer> context_;
  std::string theme_;
  std::unordered_map<const ShadowNodeFamily*, std::weak_ptr<const ShadowNodeFamily>> registered_;
};

// ---- this branch

class CurrentEngine final : public Engine {
public:
  const char* name() const override {
    return "current";
  }

  UIManagerCommitHook& hook() override {
    return engine_.hook();
  }

  void attach(std::shared_ptr<const ContextContainer> context) override {
    context_ = context;
    engine_.hook().setContextContainer(std::move(context));
  }

  void configure(const std::vector<std::string>& themes) override {
    engine_.configure(themes);
  }

  // the JS side skips a node that is already registered with this style (a reveal re-attaches the same instance) and queues the
  // rest for one native call after the commit
  void attachRef(const std::shared_ptr<const ShadowNode>& node, const Style& style, const std::string& renderTheme, bool first) override {
    // JS keys this by the node object (a WeakMap), so a new view can never be taken for a dead one at the same address
    const auto it = registered_.find(&node->getFamily());

    if (it != registered_.end() && !it->second.first.expired() && it->second.second == style.id) {
      return;
    }

    registered_[&node->getFamily()] = {node->getFamilyShared(), style.id};
    queue_.push_back({node, &style, first ? std::optional<std::string>(renderTheme) : std::nullopt});
  }

  void detachRef(const ShadowNode&) override {}

  void unbind(const ShadowNode& node) override {
    drain();
    registered_.erase(&node.getFamily());
    engine_.unregisterView(node);
  }

  void setTheme(const std::string& name) override {
    drain();
    engine_.setTheme(name);
  }

  // registerMany + the stale check, as HybridShadewind::registerMany does
  void flush(FakeReact& react) override {
    drain();

    if (engine_.hook().hasStale()) {
      react.commitTick();
    }
  }

  void prewarm() override {
    engine_.hook().prewarm();
  }

  Stats stats() override {
    const auto s = engine_.hook().stats();

    return {
        .applied = s.applied,
        .reused = s.reused,
        .scanned = s.scanned,
        .visited = s.visited,
        .skipped = s.skipped,
        .hidden = s.hidden,
        .missNotOurs = s.missNotOurs};
  }

  size_t registeredCount() override {
    return registered_.size();
  }

  sw::ThemeEngine& engine() {
    return engine_;
  }

private:
  struct Pending {
    std::shared_ptr<const ShadowNode> node; // JS holds the node object until the call
    const Style* style;
    std::optional<std::string> renderTheme;
  };

  void drain() {
    for (const auto& pending : queue_) {
      const auto surface = pending.node->getFamily().getSurfaceId();
      auto style = engine_.cachedStyle(pending.style->id, surface);

      if (!style) {
        style = engine_.buildStyle(pending.style->id, surface, pending.style->props, *context_);
      }

      engine_.registerView(*pending.node, std::move(style), pending.renderTheme ? &*pending.renderTheme : nullptr);
    }

    queue_.clear();
  }

  sw::ThemeEngine engine_;
  std::shared_ptr<const ContextContainer> context_;
  std::vector<Pending> queue_;
  std::unordered_map<const ShadowNodeFamily*, std::pair<std::weak_ptr<const ShadowNodeFamily>, int64_t>> registered_;
};

} // namespace harness

namespace harness {

// No engine at all: plain React Native, the floor every engine cost is measured against.
class NoEngine final : public Engine {
public:
  const char* name() const override {
    return "none";
  }

  UIManagerCommitHook& hook() override {
    return hook_;
  }

  void attach(std::shared_ptr<const ContextContainer>) override {}
  void configure(const std::vector<std::string>&) override {}
  void attachRef(const std::shared_ptr<const ShadowNode>&, const Style&, const std::string&, bool) override {}
  void detachRef(const ShadowNode&) override {}
  void unbind(const ShadowNode&) override {}
  void setTheme(const std::string&) override {}
  void flush(FakeReact&) override {}
  void prewarm() override {}

  Stats stats() override {
    return {};
  }

  size_t registeredCount() override {
    return 0;
  }

private:
  struct PassThrough final : UIManagerCommitHook {
    void commitHookWasRegistered(const UIManager&) noexcept override {}
    void commitHookWasUnregistered(const UIManager&) noexcept override {}

    RootShadowNode::Unshared shadowTreeWillCommit(
        const ShadowTree&,
        const RootShadowNode::Shared&,
        const RootShadowNode::Unshared& newRoot,
        const ShadowTreeCommitOptions&) noexcept override {
      return newRoot;
    }
  } hook_;
};

} // namespace harness
