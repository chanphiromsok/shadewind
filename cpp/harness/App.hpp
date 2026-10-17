#pragma once

// An app on top of FakeReact + an Engine: themed views are rendered with the current theme's colours (what React renders), their
// refs attach after the commit and detach when React hides them, and the JS microtask (flush) runs after every React commit.
// `check()` reads the committed tree the way the screen would get it: every visible bound view must hold the current theme.

#include "Engines.hpp"

#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/core/ConcreteState.h>
#include <react/renderer/graphics/PlatformColorParser.h>

#include <unordered_map>

namespace harness {

// ARGB as processColor sends it
inline folly::dynamic argb(uint32_t value) {
  return folly::dynamic(static_cast<int64_t>(value));
}

inline Style makeStyle(int64_t id, const char* key, std::vector<std::pair<std::string, uint32_t>> colours) {
  Style style;

  style.id = id;

  for (const auto& [theme, colour] : colours) {
    style.props.emplace_back(theme, folly::dynamic::object(key, argb(colour)));
  }

  return style;
}

struct Binding {
  const Style* style = nullptr;
  bool attached = false;
  bool everAttached = false;
  bool bound = true; // false: unbound (pressed), React's own props are right
};

struct Check {
  int visible = 0; // bound views on screen
  int stale = 0;   // of those, holding another theme's colour (props or, for text, the drawn attributed string)
};

class App {
public:
  App(Engine& engine, std::vector<std::string> themes, std::string initial)
      : engine_(engine), themes_(std::move(themes)), theme_(std::move(initial)) {
    engine_.attach(react_.context());
    react_.addHook(engine_.hook());
    engine_.configure(themes_);
    engine_.setTheme(theme_); // configure() pushes the initial theme
  }

  FakeReact& react() {
    return react_;
  }

  Engine& engine() {
    return engine_;
  }

  const std::string& theme() const {
    return theme_;
  }

  // A View with `style` rendered for the current theme
  Instance* view(const Style& style, std::vector<Instance*> children = {}, folly::dynamic layout = folly::dynamic::object()) {
    auto props = layout;

    props.update(valuesFor(style));

    auto* instance = react_.view(std::move(props), std::move(children));

    bindings_[instance] = Binding{.style = &style};

    return instance;
  }

  Instance* plainView(std::vector<Instance*> children = {}, folly::dynamic layout = folly::dynamic::object()) {
    return react_.view(std::move(layout), std::move(children));
  }

  Instance* text(const Style& style, const std::string& content) {
    folly::dynamic props = folly::dynamic::object("fontSize", 14);

    props.update(valuesFor(style));

    auto* instance = react_.text(std::move(props), content);

    bindings_[instance] = Binding{.style = &style};

    return instance;
  }

  void mount(std::vector<Instance*> children) {
    mountCommit(std::move(children));
    attachRefs();
  }

  // the two halves of a mount: React's commit, then (after it) the refs attach and the microtask flushes
  void mountCommit(std::vector<Instance*> children) {
    react_.mount(std::move(children));
  }

  void attachRefs() {
    attachAll(react_.root());
    afterCommit();
  }

  void hide(Instance& instance) {
    react_.hide(instance);
    detachAll(instance); // React detaches the refs of a hidden subtree
    afterCommit();
  }

  void reveal(Instance& instance) {
    react_.reveal(instance);
    lastReactCommit_ = check(); // what the reveal commit itself shows, before the microtask
    attachAll(instance);
    afterCommit();
  }

  // React re-renders a view; a themed view renders the current theme's values (no subscription: whatever made it re-render)
  void rerender(Instance& instance, folly::dynamic props = folly::dynamic::object()) {
    if (const auto it = bindings_.find(&instance); it != bindings_.end()) {
      props.update(valuesFor(*it->second.style));
    }

    react_.rerender(instance, props);
    lastReactCommit_ = check();
    afterCommit();
  }

  // A Pressable pressed: unbound, React renders the pressed colours itself
  void press(Instance& instance, folly::dynamic pressedProps) {
    auto& binding = bindings_.at(&instance);

    binding.bound = false;
    engine_.unbind(*instance.node());
    react_.rerender(instance, pressedProps);
    afterCommit();
  }

  // Released: React renders the resting style of the current theme; the binding resumes without a render theme
  void release(Instance& instance) {
    auto& binding = bindings_.at(&instance);

    react_.rerender(instance, valuesFor(*binding.style));
    binding.bound = true;
    engine_.attachRef(instance.node(), *binding.style, theme_, false);
    afterCommit();
  }

  // Shadewind.setTheme with the synchronous strategy ('hook', and Android today): the engine's commit on the JS thread
  void setTheme(const std::string& name) {
    theme_ = name;
    engine_.setTheme(name);
    react_.commitTick();
    lastThemeCommit_ = check();
  }

  // 'hookAsync' (the iOS default): the engine's commit on a background thread
  void setThemeAsync(const std::string& name) {
    theme_ = name;
    engine_.setTheme(name);
    react_.commitTickOffThread();
    lastThemeCommit_ = check();
  }

  // unmounted instances go away (React and Hermes drop them); their bindings with them
  void collectGarbage() {
    for (const auto* released : react_.collectGarbage()) {
      bindings_.erase(const_cast<Instance*>(released));
    }

    familyIndex_.clear();
  }

  // the model's idea of the theme only (what `check()` expects), without telling the engine
  void assumeTheme(const std::string& name) {
    theme_ = name;
  }

  // An unrelated React commit (a state change somewhere that renders no themed view)
  Instance* unrelated() {
    return unrelated_;
  }

  void setUnrelated(Instance* instance) {
    unrelated_ = instance;
  }

  Check lastReactCommit() const {
    return lastReactCommit_;
  }

  Check lastThemeCommit() const {
    return lastThemeCommit_;
  }

  Check check() const {
    Check result;

    walk(*react_.committed(), result);

    return result;
  }

  folly::dynamic valuesFor(const Style& style) const {
    for (const auto& [theme, props] : style.props) {
      if (theme == theme_) {
        return props;
      }
    }

    return folly::dynamic::object();
  }

private:
  void afterCommit() {
    engine_.flush(react_);
  }

  void attachAll(Instance& instance) {
    if (instance.hidden) {
      return;
    }

    if (const auto it = bindings_.find(&instance); it != bindings_.end() && it->second.bound && !it->second.attached) {
      const bool first = !it->second.everAttached;

      it->second.attached = true;
      it->second.everAttached = true;
      engine_.attachRef(instance.node(), *it->second.style, theme_, first);
    }

    for (auto* child : instance.children) {
      attachAll(*child);
    }
  }

  void detachAll(Instance& instance) {
    if (const auto it = bindings_.find(&instance); it != bindings_.end() && it->second.attached) {
      it->second.attached = false;
      engine_.detachRef(*instance.node());
    }

    for (auto* child : instance.children) {
      detachAll(*child);
    }
  }

  const Binding* bindingOf(const ShadowNodeFamily& family) const {
    // bindings are keyed by instance; families are stable per instance
    if (familyIndex_.size() != bindings_.size()) {
      familyIndex_.clear();

      for (const auto& [instance, binding] : bindings_) {
        familyIndex_[&instance->node()->getFamily()] = &binding;
      }
    }

    const auto it = familyIndex_.find(&family);

    return it != familyIndex_.end() ? it->second : nullptr;
  }

  SharedColor expected(const Style& style, const char* key) const {
    const auto values = valuesFor(style);
    SharedColor colour;

    if (const auto* value = values.get_ptr(key)) {
      fromRawValue(*react_.context(), react_.surface(), RawValue(*value), colour);
    }

    return colour;
  }

  void walk(const ShadowNode& node, Check& result) const {
    if (sw::isHidden(node)) {
      return;
    }

    if (const auto* binding = bindingOf(node.getFamily()); binding != nullptr && binding->bound) {
      ++result.visible;

      bool ok = true;
      const auto* props = static_cast<const ViewProps*>(node.getProps().get());

      if (std::strcmp(node.getComponentName(), "Paragraph") == 0) {
        const auto colour = expected(*binding->style, "color");
        const auto& paragraph = static_cast<const ParagraphProps&>(*node.getProps());

        ok = paragraph.textAttributes.foregroundColor == colour;

        const auto& state = static_cast<const ConcreteState<ParagraphState>&>(*node.getState()).getData();

        for (const auto& fragment : state.attributedString.getFragments()) {
          ok = ok && fragment.textAttributes.foregroundColor == colour;
        }
      } else {
        ok = props->backgroundColor == expected(*binding->style, "backgroundColor");
      }

      if (!ok) {
        ++result.stale;
      }
    }

    for (const auto& child : node.getChildren()) {
      walk(*child, result);
    }
  }

  Engine& engine_;
  FakeReact react_;
  std::vector<std::string> themes_;
  std::string theme_;
  std::unordered_map<Instance*, Binding> bindings_;
  mutable std::unordered_map<const ShadowNodeFamily*, const Binding*> familyIndex_;
  Instance* unrelated_ = nullptr;
  Check lastReactCommit_;
  Check lastThemeCommit_;
};

} // namespace harness
