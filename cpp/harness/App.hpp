#pragma once

// An app on top of FakeReact + an Engine: themed views are rendered with the current theme's colours (what React renders), their
// refs attach after the commit and detach when React hides them, and the JS microtask (flush) runs after every React commit.
// `check()` reads the committed tree the way the screen would get it: every visible bound view must hold the current theme.

#include "Engines.hpp"

#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/core/ConcreteState.h>
#include <react/renderer/graphics/PlatformColorParser.h>
#ifdef RN_SERIALIZABLE_STATE
#include <react/featureflags/ReactNativeFeatureFlags.h>
#include <react/renderer/core/DynamicPropsUtilities.h>
#include <react/renderer/mounting/Differentiator.h>
#endif

#include <unordered_map>

namespace harness {

// ARGB as processColor sends it: unsigned on iOS, a signed int32 on Android
inline folly::dynamic argb(uint32_t value) {
#ifdef RN_SERIALIZABLE_STATE
  return folly::dynamic(static_cast<int64_t>(static_cast<int32_t>(value)));
#else
  return folly::dynamic(static_cast<int64_t>(value));
#endif
}

#ifdef RN_SERIALIZABLE_STATE
// What the Java side makes of a colour prop: ReadableNativeMap boxes an INT64 as a Double, ColorPropConverter calls Double.toInt(),
// which saturates at the int32 limits (Kotlin semantics).
inline int32_t javaColourInt(const folly::dynamic& value) {
  const double number = value.asDouble();

  if (number >= 2147483647.0) {
    return INT32_MAX;
  }

  if (number <= -2147483648.0) {
    return INT32_MIN;
  }

  return static_cast<int32_t>(number);
}
#endif

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
  App(Engine& engine, std::vector<std::string> themes, std::string initial, Screen screen = {})
      : engine_(engine), react_(1, screen), themes_(std::move(themes)), theme_(std::move(initial)) {
    engine_.attach(react_.context());
    react_.addHook(engine_.hook());
    engine_.configure(themes_);
    engine_.setTheme(theme_); // configure() pushes the initial theme
#ifdef RN_SERIALIZABLE_STATE
    mountedRoot_ = react_.committed();
#endif
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
    lastReactCommit_ = checked(); // what the reveal commit itself shows, before the microtask
    attachAll(instance);
    afterCommit();
  }

  // React re-renders a view; a themed view renders the current theme's values (no subscription: whatever made it re-render)
  void rerender(Instance& instance, folly::dynamic props = folly::dynamic::object()) {
    if (const auto it = bindings_.find(&instance); it != bindings_.end()) {
      props.update(valuesFor(*it->second.style));
    }

    react_.rerender(instance, props);
    lastReactCommit_ = checked();
    afterCommit();
  }

  // A new child of a mounted instance, its refs attached after the commit
  void append(Instance& parent, Instance* child) {
    react_.append(parent, child);
    lastReactCommit_ = checked();
    attachRefs();
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
    lastThemeCommit_ = checked();
  }

  // 'hookAsync' (the iOS default): the engine's commit on a background thread
  void setThemeAsync(const std::string& name) {
    theme_ = name;
    engine_.setTheme(name);
    react_.commitTickOffThread();
    lastThemeCommit_ = checked();
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

  // benchmarks turn the per-commit checks off so they are not timed
  void setChecks(bool enabled) {
    checks_ = enabled;
  }

  Check check() const {
    Check result;

#ifdef RN_SERIALIZABLE_STATE
    mountOnAndroid();
#endif
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
  Check checked() const {
    return checks_ ? check() : Check{};
  }

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
#ifdef RN_SERIALIZABLE_STATE
        // and on Android, the colour the Java view holds after the mount instructions it was sent
        ok = ok && androidColour(node.getTag()) == expected(*binding->style, "backgroundColor");
#endif
      }

      if (!ok) {
        ++result.stale;
      }
    }

    for (const auto& child : node.getChildren()) {
      walk(*child, result);
    }
  }

#ifdef RN_SERIALIZABLE_STATE
  // Android's side of the mount (React Native 0.86, FabricMountingManager.cpp): the mounting layer diffs the last mounted tree
  // against the committed one and sends each created or updated view the props getProps() picks, which the Java view applies on
  // top of what it holds. With the default flags that is the new props' `rawProps`: a typed-only change never reaches the view.
  static folly::dynamic sentToJava(const Props* oldProps, const ShadowView& view) {
    const Props* newProps = view.props.get();

    if (ReactNativeFeatureFlags::enablePropsUpdateReconciliationAndroid() &&
        std::strcmp(view.componentName, newProps->getDiffPropsImplementationTarget()) == 0) {
      return newProps->getDiffProps(oldProps);
    }

    if (ReactNativeFeatureFlags::enableAccumulatedUpdatesInRawPropsAndroid() && oldProps != nullptr) {
      return diffDynamicProps(oldProps->rawProps, newProps->rawProps);
    }

    return newProps->rawProps;
  }

  void mountOnAndroid() const {
    const auto root = react_.committed();

    if (root == mountedRoot_) {
      return;
    }

    for (const auto& mutation : calculateShadowViewMutations(*mountedRoot_, *root)) {
      const auto& view = mutation.newChildShadowView;

      if (mutation.type == ShadowViewMutation::Create) {
        javaViews_[view.tag] = sentToJava(nullptr, view);
      } else if (mutation.type == ShadowViewMutation::Update) {
        auto& held = javaViews_[view.tag];
        const auto sent = sentToJava(mutation.oldChildShadowView.props.get(), view);

        if (!held.isObject()) {
          held = folly::dynamic::object();
        }

        for (const auto& [key, value] : sent.items()) {
          held[key] = value;
        }
      } else if (mutation.type == ShadowViewMutation::Delete) {
        javaViews_.erase(mutation.oldChildShadowView.tag);
      }
    }

    mountedRoot_ = root;
  }

  SharedColor androidColour(Tag tag) const {
    SharedColor colour;

    if (const auto it = javaViews_.find(tag); it != javaViews_.end() && it->second.isObject()) {
      if (const auto* value = it->second.get_ptr("backgroundColor"); value && !value->isNull()) {
        // decoded as Java does (saturating), not with the C++ conversion that accepts any 32-bit number
        const auto decoded = value->isNumber() ? folly::dynamic(static_cast<int64_t>(javaColourInt(*value))) : *value;

        fromRawValue(*react_.context(), react_.surface(), RawValue(decoded), colour);
      }
    }

    return colour;
  }

  mutable RootShadowNode::Shared mountedRoot_;
  mutable std::unordered_map<Tag, folly::dynamic> javaViews_;
#endif

  Engine& engine_;
  FakeReact react_;
  std::vector<std::string> themes_;
  std::string theme_;
  std::unordered_map<Instance*, Binding> bindings_;
  mutable std::unordered_map<const ShadowNodeFamily*, const Binding*> familyIndex_;
  Instance* unrelated_ = nullptr;
  Check lastReactCommit_;
  Check lastThemeCommit_;
  bool checks_ = true;
};

} // namespace harness
