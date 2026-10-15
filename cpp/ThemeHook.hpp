#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <array>
#include <cstring>
#include <folly/dynamic.h>
#include <react/renderer/components/root/RootShadowNode.h>
#include <react/renderer/components/text/ParagraphProps.h>
#include <react/renderer/components/text/ParagraphShadowNode.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/core/ConcreteState.h>
#include <react/renderer/components/view/ViewShadowNode.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/core/RawProps.h>
#include <react/renderer/core/RawValue.h>
#include <react/renderer/graphics/Color.h>
#include <react/renderer/graphics/PlatformColorParser.h>
#include <react/renderer/core/RawPropsParser.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/uimanager/UIManagerCommitHook.h>
#include <mutex>
#include <optional>
#include <tuple>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace margelo::nitro::shadewind {

using namespace facebook::react;

// What a theme changes on one view, already converted to React Native's C++ types.
struct TypedDelta {
  std::optional<SharedColor> background;
  std::optional<SharedColor> border;
  std::optional<SharedColor> text;
  std::optional<Float> opacity;
  folly::dynamic raw; // used for components we don't set typed fields on
};

// `yogaNode_` is protected in YogaLayoutableShadowNode; naming it through a derived class is the one legal way to reach it.
struct YogaAccess : YogaLayoutableShadowNode {
  static yoga::Node& node(const YogaLayoutableShadowNode& n) {
    return const_cast<YogaLayoutableShadowNode&>(n).*(&YogaAccess::yogaNode_); // mutable member, pointer-to-member drops that
  }
};

// Text colour without a layout pass.
//
// Cloning a Paragraph with new props always dirties its Yoga node (ParagraphShadowNode::shouldNewRevisionDirtyMeasurement), and
// a dirty Paragraph dirties every ancestor, so a theme switch re-ran Yoga over the whole tree even though a colour cannot change
// a size. The only reason layout mattered is that ParagraphShadowNode::layout() is what rebuilds the ParagraphState (its
// AttributedString holds the colour the view draws). So this builds that state here, from the previous one, and the caller
// keeps the clone's Yoga node clean.
//
// Returns the state to clone with and whether the node may stay clean. `keepClean` is false (and `state` untouched) whenever
// anything is not exactly the simple case: no previous state, a dirty source, new children, or a source that is not laid out.
struct RecoloredParagraph {
  State::Shared state;
  bool keepClean = false;
  int reason = 0; // 0 ok, 1 children replaced, 2 no state, 3 not a Paragraph, 4 not Yoga/dirty, 5 state type mismatch, 6 no fragments, 7 no props, 8 no fragment carried the old colour
};

inline std::atomic<int> gReasons[9];

inline RecoloredParagraph recolorParagraph(const ShadowNode& source, const SharedColor& color, bool childrenReplaced) {
  RecoloredParagraph out;

  out.state = source.getState();

  if (childrenReplaced) {
    out.reason = 1;
    return out;
  }

  if (!out.state) {
    out.reason = 2;
    return out;
  }

  if (std::strcmp(source.getComponentName(), ParagraphComponentName) != 0) {
    out.reason = 3;
    return out;
  }

  // a Paragraph is a ConcreteViewShadowNode, hence a YogaLayoutableShadowNode (no RTTI: it is fragile across RN's libraries)
  const auto* yogaSource = static_cast<const YogaLayoutableShadowNode*>(&source);

  if (YogaAccess::node(*yogaSource).isDirty()) {
    out.reason = 4;
    return out;
  }

  // The component name was checked above, so the state of this node is a ConcreteState<ParagraphState>. A dynamic_cast is not
  // used: across React Native's shared libraries (hidden visibility on Android) it fails for types that are in fact identical.
  const auto* concrete = static_cast<const ConcreteState<ParagraphState>*>(source.getState().get());

  ParagraphState data = concrete->getData();

  if (data.attributedString.getFragments().empty()) {
    out.reason = 6;
    return out;
  }

  const auto* sourceProps = static_cast<const ParagraphProps*>(source.getProps().get()); // same reasoning as above

  if (sourceProps == nullptr) {
    out.reason = 7;
    return out;
  }

  // only the fragments that carry the paragraph's own colour (a nested <Text> with its own colour keeps it). A <Text> without a
  // colour of its own renders with the default text attributes, so that is the colour its fragments hold.
  SharedColor previous = sourceProps->textAttributes.foregroundColor;

  if (!previous) {
    previous = TextAttributes::defaultTextAttributes().foregroundColor;
  }

  bool changed = false;
  bool alreadyTarget = false; // some fragment already holds the colour we want

  for (auto& fragment : data.attributedString.getFragments()) {
    if (fragment.textAttributes.foregroundColor == previous) {
      fragment.textAttributes.foregroundColor = color;
      changed = true;
    } else if (fragment.textAttributes.foregroundColor == color) {
      alreadyTarget = true;
    }
  }

  auto base = data.attributedString.getBaseTextAttributes();

  if (base.foregroundColor == previous) {
    base.foregroundColor = color;
    data.attributedString.setBaseTextAttributes(base);
    changed = true;
  } else if (base.foregroundColor == color) {
    alreadyTarget = true;
  }

  if (!changed) {
    if (alreadyTarget) {
      // The state was recoloured by an earlier pass while the props came back from React with the old colour (a React commit
      // that re-rendered the Text): the state is already right, only the props need the new colour. Keep it clean.
      out.keepClean = true;

      return out;
    }

    // nothing carried the old or the new colour (explicit colours set inside nested Text, say): let layout produce the state
    out.reason = 8;

    return out;
  }

  out.state = source.getComponentDescriptor().createState(source.getFamily(), std::make_shared<const ParagraphState>(std::move(data)));
  out.keepClean = true;

  return out;
}

// Debug counters: how many Paragraph clones took the no-layout path, and why the others did not.
inline std::atomic<int> gRecolored{0};
inline std::atomic<int> gRecolorSkipDirty{0};
inline std::atomic<int> gRecolorSkipState{0};

// Clone `node` with the theme's props. A text colour change keeps the layout clean (see recolorParagraph).
inline std::shared_ptr<ShadowNode> cloneThemed(
    const ShadowNode& node,
    const Props::Shared& props,
    const ShadowNode::SharedListOfShared& children,
    const TypedDelta& delta) {
  RecoloredParagraph recolored;

  if (delta.text) {
    recolored = recolorParagraph(node, *delta.text, children != nullptr);
  } else {
    recolored.state = node.getState();
  }

  auto result = node.clone({.props = props, .children = children, .state = recolored.state});

  if (delta.text && std::strcmp(node.getComponentName(), ParagraphComponentName) == 0) {
    ++gReasons[recolored.reason];

    if (recolored.keepClean) {
      ++gRecolored;
    } else if (YogaAccess::node(static_cast<const YogaLayoutableShadowNode&>(node)).isDirty()) {
      ++gRecolorSkipDirty;
    } else {
      ++gRecolorSkipState;
    }
  }

  if (recolored.keepClean) {
    // the clone of a Paragraph is a Paragraph
    YogaAccess::node(static_cast<const YogaLayoutableShadowNode&>(*result)).setDirty(false);
  }

  return result;
}

struct HookStats {
  double scanMs = 0;  // finding the registered nodes that need an update
  double cloneMs = 0; // building their new props and cloning them (propsMs + node clone)
  double propsMs = 0; // of cloneMs: building the typed props only
  int applied = 0;    // nodes cloned in the last commit that did work
  int reused = 0;     // of applied: props reused from the cache instead of rebuilt
  bool fullApply = false; // the last commit skipped the tree scan (theme change)
  int scanned = 0;    // registered views looked at
  // how a node's props were found: React replaced them (rebuilt) / its children list is being replaced (cloned with new children)
  int missNotOurs = 0, missChildren = 0;
};

/**
 * Applies the current theme to registered views inside every commit (React's own commits too).
 *
 * Why a commit hook: whatever route React takes (un-hiding a frozen screen, re-attaching untouched children, cloning
 * from a stale handle) the new tree passes through here before it is committed, so a view can never leave a commit
 * with a stale theme. That removes the need for React Native's deprecated nativeProps overlay and for walking React
 * fibers from JS.
 *
 * A view needs work when the theme changed since we last styled it, or when the props object in the new tree is not
 * the one we produced (React replaced it).
 */
class ThemeHook final : public UIManagerCommitHook, public std::enable_shared_from_this<ThemeHook> {
public:
  void commitHookWasRegistered(const UIManager& uiManager) noexcept override {
    _contextContainer = uiManager.getContextContainer();
  }

  void commitHookWasUnregistered(const UIManager&) noexcept override {}

  void add(
      const std::shared_ptr<const ShadowNodeFamily>& family,
      const std::unordered_map<std::string, std::shared_ptr<const TypedDelta>>& byTheme,
      Props::Shared base,
      const char* componentName,
      SurfaceId surface,
      bool renderedWithCurrentTheme = false) {
    std::lock_guard<std::mutex> lock(_mutex);

    if (_entries.bucket_count() < 4096) {
      _entries.reserve(4096); // a screen registers thousands of views: avoid rehashing during mount
    }

    Entry entry;

    entry.family = family;
    entry.base = std::move(base);
    entry.componentName = componentName;
    entry.surface = surface;

    for (const auto& [name, delta] : byTheme) {
      const auto id = internTheme(name);

      if (id != kNoTheme) {
        entry.slots[id].delta = delta;
      }
    }

    // React already rendered this view with the current theme's values (its props are `base`): nothing to apply until the
    // theme changes or React replaces the props. Without this every mounted view is cloned once right after mount, and the
    // flush that follows commits the whole tree again.
    if (renderedWithCurrentTheme && _theme != kNoTheme) {
      entry.appliedEpoch = _epoch;
      entry.appliedProps = entry.base.get();
    }

    _entries[family.get()] = std::move(entry);
  }

  // Builds the props of every theme for views that have not been styled yet, from the props they registered with, so the
  // first switch finds them cached. Runs on a background thread; building props only reads the (immutable) source.
  void prewarm() {
    struct Job {
      const ShadowNodeFamily* family;
      Props::Shared base;
      const char* componentName;
      SurfaceId surface;
      std::vector<std::pair<ThemeId, std::shared_ptr<const TypedDelta>>> deltas;
    };

    std::vector<Job> jobs;

    {
      std::lock_guard<std::mutex> lock(_mutex);

      for (const auto& [family, entry] : _entries) {
        // lineage intact (still built from the registration props) and some themes not prepared yet
        if (entry.base && entry.componentName) {
          Job job{family, entry.base, entry.componentName, entry.surface, {}};

          for (ThemeId id = 0; id < kMaxThemes; id++) {
            if (entry.slots[id].delta && !entry.slots[id].produced) {
              job.deltas.emplace_back(id, entry.slots[id].delta);
            }
          }

          if (!job.deltas.empty()) {
            jobs.push_back(std::move(job));
          }
        }
      }
    }

    if (jobs.empty() || !_contextContainer) {
      return;
    }

    std::vector<std::vector<std::pair<ThemeId, Props::Shared>>> built(jobs.size());

    for (size_t i = 0; i < jobs.size(); i++) {
      for (const auto& [id, delta] : jobs[i].deltas) {
        if (auto props = buildPropsFrom(jobs[i].surface, jobs[i].componentName, *jobs[i].base, *delta)) {
          built[i].emplace_back(id, std::move(props));
        }
      }
    }

    std::lock_guard<std::mutex> lock(_mutex);

    for (size_t i = 0; i < jobs.size(); i++) {
      auto entry = _entries.find(jobs[i].family);

      // only if the view still has the props we built from (React did not change them meanwhile)
      if (entry != _entries.end() && entry->second.base == jobs[i].base) {
        for (auto& [id, props] : built[i]) {
          auto& slot = entry->second.slots[id].produced;

          if (!slot) {
            slot = std::move(props); // keeps a version the hook built in the meantime
          }
        }
      }
    }
  }

  void remove(const ShadowNodeFamily* family) {
    std::lock_guard<std::mutex> lock(_mutex);
    _entries.erase(family);
  }

  // Interns the declared theme names in order, so slot ids are deterministic and a later typo cannot take a slot.
  // Returns false when more than kMaxThemes names are declared.
  bool declareThemes(const std::vector<std::string>& names) {
    std::lock_guard<std::mutex> lock(_mutex);
    bool ok = true;

    for (const auto& name : names) {
      ok = internTheme(name) != kNoTheme && ok;
    }

    return ok;
  }

  static constexpr int maxThemes() {
    return static_cast<int>(kMaxThemes);
  }

  void setTheme(const std::string& theme) {
    std::lock_guard<std::mutex> lock(_mutex);
    _theme = internTheme(theme);
    ++_epoch;
    _fullPending = true;
  }

  // Carrier styles: a view that renders `nativeID="sw:<id>"` is discovered here, in the commit, with no ref and no per-view JS call.
  // `byTheme` is the per-theme prop object of one distinct style; JS defines each distinct style once.
  void defineStyle(int64_t id, const std::unordered_map<std::string, folly::dynamic>& byTheme) {
    std::lock_guard<std::mutex> lock(_mutex);
    auto& def = _carrier[id];

    for (const auto& [name, props] : byTheme) {
      const auto theme = internTheme(name);

      if (theme != kNoTheme) {
        def.raw[theme] = props;
        def.defined[theme] = true;
      }
    }

    def.typed.clear();
  }

  bool hasUnapplied() {
    std::lock_guard<std::mutex> lock(_mutex);

    if (_theme == kNoTheme) {
      return false;
    }

    for (const auto& [_, entry] : _entries) {
      if (entry.appliedEpoch != _epoch) {
        return true;
      }
    }

    return false;
  }

  // Background colours of every registered view for the current theme (used by the iOS direct path).
  std::vector<std::pair<Tag, SharedColor>> backgrounds() {
    std::lock_guard<std::mutex> lock(_mutex);
    std::vector<std::pair<Tag, SharedColor>> result;

    result.reserve(_entries.size());

    for (const auto& [_, entry] : _entries) {
      auto family = entry.family.lock();

      if (family && _theme != kNoTheme && entry.slots[_theme].delta && entry.slots[_theme].delta->background) {
        result.emplace_back(family->getTag(), *entry.slots[_theme].delta->background);
      }
    }

    return result;
  }

  HookStats stats() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _stats;
  }

  RootShadowNode::Unshared shadowTreeWillCommit(
      const ShadowTree&,
      const RootShadowNode::Shared&,
      const RootShadowNode::Unshared& newRoot,
      const ShadowTreeCommitOptions&) noexcept override {
    using Clock = std::chrono::steady_clock;
    const auto t0 = Clock::now();

    // One pass over the new tree, under one lock hold: decide per registered view, clone it (or take its pre-built node) and
    // record what was applied. React Native's cloneMultiple does the same job but builds a Tag->count hash map with a heap
    // allocation per node, locks a weak_ptr per ancestor hop and re-scans every ancestor's children; this walk does a
    // single pointer-keyed lookup per node.
    std::unique_lock<std::mutex> lock(_mutex);

    if (_theme == kNoTheme || (_entries.empty() && _carrier.empty())) {
      return newRoot;
    }

    // views that unmounted never show up in a walk, so drop their entries now and then
    if ((++_commits & 127) == 0) {
      for (auto it = _entries.begin(); it != _entries.end();) {
        it = it->second.family.expired() ? _entries.erase(it) : std::next(it);
      }
    }

    Walk walk;

    walk.theme = _theme;
    walk.epoch = _epoch;
    walk.full = _fullPending;

    auto cloned = walkTree(*newRoot, walk);

    const auto t1 = Clock::now();

    if (!cloned) {
      _stats.scanMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
      _stats.scanned = walk.scanned;

      return newRoot;
    }

    if (walk.full && _epoch == walk.epoch) {
      _fullPending = false;
    }

    // the walk is the scan: it finds and builds in one pass, so the whole time is reported as clone time
    _stats.scanMs = 0;
    _stats.cloneMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    _stats.propsMs = static_cast<double>(walk.propsNs) / 1e6;
    _stats.applied = walk.applied;
    _stats.reused = walk.reused;
    _stats.missNotOurs = walk.missNotOurs;
    _stats.missChildren = walk.missChildren;
    _stats.fullApply = walk.full;
    _stats.scanned = walk.scanned;

    return std::static_pointer_cast<RootShadowNode>(cloned);
  }

private:
  // Themes are interned to small ids so a view's per-theme data is one flat array instead of three string-keyed hash maps:
  // a theme switch touches every registered view, and chasing map nodes per view is what a cold cache pays for.
  using ThemeId = uint8_t;
  static constexpr ThemeId kMaxThemes = 6;
  static constexpr ThemeId kNoTheme = 0xFF;

  // One cache line per theme slot: the commit reads delta / produced of exactly one slot per view.
  struct alignas(64) Slot {
    std::shared_ptr<const TypedDelta> delta; // what this theme changes on the view (null: view has no style for the theme)
    // the props we built for this theme earlier; reused while the node still holds one of our props objects
    Props::Shared produced;
  };

  // Hot fields first (one cache line): the commit reads these for every registered view, so a cold cache pays per line.
  struct Entry {
    std::weak_ptr<const ShadowNodeFamily> family;
    uint64_t appliedEpoch = 0;
    // The props object last applied. Not owning: it is always also held by slots[theme].produced, so it stays alive.
    const Props* appliedProps = nullptr;
    Props::Shared base; // the props the view registered with (what produced[] is built from when pre-warming)
    std::array<Slot, kMaxThemes> slots;
    const char* componentName = nullptr;
    SurfaceId surface = 0;
    bool carrier = false; // found through its nativeID (no ref, no per-view registration)
  };

  // ---- carrier styles --------------------------------------------------------------------------------------------------
  struct CarrierStyle {
    std::array<folly::dynamic, kMaxThemes> raw;
    std::array<bool, kMaxThemes> defined{};
    // typed deltas per surface, built lazily from `raw` when a node of that style is first seen
    std::unordered_map<SurfaceId, std::array<std::shared_ptr<const TypedDelta>, kMaxThemes>> typed;
  };

  static int64_t carrierId(const std::string& nativeId) {
    if (nativeId.size() < 4 || nativeId[0] != 's' || nativeId[1] != 'w' || nativeId[2] != ':') {
      return -1;
    }

    int64_t value = 0;

    for (size_t i = 3; i < nativeId.size(); i++) {
      const char c = nativeId[i];

      if (c < '0' || c > '9') {
        return -1;
      }

      value = value * 10 + (c - '0');
    }

    return value;
  }

  std::shared_ptr<const TypedDelta> makeDelta(const folly::dynamic& props, SurfaceId surface) {
    auto delta = std::make_shared<TypedDelta>();
    delta->raw = props;

    const auto color = [&](const char* key) -> std::optional<SharedColor> {
      if (const auto* value = props.get_ptr(key)) {
        SharedColor parsed;

        fromRawValue(*_contextContainer, surface, RawValue(*value), parsed);

        return parsed;
      }

      return std::nullopt;
    };

    delta->background = color("backgroundColor");
    delta->border = color("borderColor");
    delta->text = color("color");

    if (const auto* opacity = props.get_ptr("opacity"); opacity && opacity->isNumber()) {
      delta->opacity = static_cast<Float>(opacity->asDouble());
    }

    return delta;
  }

  // Caller holds _mutex and has checked _carrier is non-empty and the theme is set.
  Entry* adoptCarrier(const ShadowNode& node, int64_t id, ThemeId theme, uint64_t epoch) {
    const auto def = _carrier.find(id);

    if (def == _carrier.end() || !_contextContainer) {
      return nullptr;
    }

    const auto surface = node.getFamily().getSurfaceId();
    auto& typed = def->second.typed[surface];

    Entry entry;

    entry.family = node.getFamilyShared();
    entry.base = node.getProps();
    entry.componentName = node.getComponentName();
    entry.surface = surface;
    entry.carrier = true;

    for (ThemeId t = 0; t < kMaxThemes; t++) {
      if (!def->second.defined[t]) {
        continue;
      }

      if (!typed[t]) {
        typed[t] = makeDelta(def->second.raw[t], surface);
      }

      entry.slots[t].delta = typed[t];
    }

    // React already rendered the view with the theme that is current: nothing to apply until the theme changes
    if (entry.slots[theme].delta && matchesDelta(*entry.base, entry.componentName, *entry.slots[theme].delta)) {
      entry.appliedEpoch = epoch;
      entry.appliedProps = entry.base.get();
    }

    auto& stored = _entries[&node.getFamily()];

    stored = std::move(entry);

    return &stored;
  }

  // Do the props already hold the values the delta would set (for the fields it sets)?
  static bool matchesDelta(const Props& props, const char* name, const TypedDelta& delta) {
    const bool paragraph = std::strcmp(name, ParagraphComponentName) == 0;

    if (!paragraph && std::strcmp(name, ViewComponentName) != 0) {
      return false;
    }

    const auto& view = static_cast<const ViewProps&>(props);

    if (delta.background && !(view.backgroundColor == *delta.background)) {
      return false;
    }

    if (delta.border && !(view.borderColors.all && *view.borderColors.all == *delta.border)) {
      return false;
    }

    if (delta.text && paragraph && !(static_cast<const ParagraphProps&>(props).textAttributes.foregroundColor == *delta.text)) {
      return false;
    }

    return true;
  }

  // Do the props show the resting colours of a theme other than `current`?
  static bool showsOtherTheme(const Entry& entry, const Props& props, const char* name, ThemeId current) {
    for (ThemeId t = 0; t < kMaxThemes; t++) {
      if (t != current && entry.slots[t].delta && matchesDelta(props, name, *entry.slots[t].delta)) {
        return true;
      }
    }

    return false;
  }

  // Caller holds _mutex. Returns kNoTheme when more than kMaxThemes distinct themes exist.
  ThemeId internTheme(const std::string& name) {
    for (size_t i = 0; i < _themeNames.size(); i++) {
      if (_themeNames[i] == name) {
        return static_cast<ThemeId>(i);
      }
    }

    if (_themeNames.size() >= kMaxThemes) {
      return kNoTheme;
    }

    _themeNames.push_back(name);

    return static_cast<ThemeId>(_themeNames.size() - 1);
  }

  struct Walk {
    ThemeId theme = kNoTheme;
    uint64_t epoch = 0;
    bool full = false;
    int scanned = 0;
    int applied = 0;
    int reused = 0;
    int missNotOurs = 0, missChildren = 0;
    int64_t propsNs = 0;
  };

  // Returns the replacement for `node`, or nullptr when nothing under it changed. Caller holds _mutex.
  std::shared_ptr<ShadowNode> walkTree(const ShadowNode& node, Walk& walk) {
    using Clock = std::chrono::steady_clock;

    // children first: a changed child makes this node a (cheap) clone with a new children list
    ShadowNode::SharedListOfShared newChildren;
    {
      const auto& children = node.getChildren();
      std::vector<std::shared_ptr<ShadowNode>> replaced;

      for (size_t i = 0; i < children.size(); i++) {
        if (auto next = walkTree(*children[i], walk)) {
          if (replaced.empty()) {
            replaced.resize(children.size());
          }

          replaced[i] = std::move(next);
        }
      }

      if (!replaced.empty()) {
        // built once, copying only the untouched children (a copy-then-overwrite would pay a refcount round trip on each
        // replaced one)
        auto list = std::make_shared<std::vector<std::shared_ptr<const ShadowNode>>>();

        list->reserve(children.size());

        for (size_t i = 0; i < children.size(); i++) {
          if (replaced[i]) {
            list->push_back(std::move(replaced[i]));
          } else {
            list->push_back(children[i]);
          }
        }

        newChildren = std::move(list);
      }
    }

    auto entryIt = _entries.find(&node.getFamily());
    Entry* entry = entryIt != _entries.end() ? &entryIt->second : nullptr;

    // a family address can be reused by a new view while the old entry has not been purged yet
    if (entry && entry->family.expired()) {
      entry = nullptr;
    }

    // a view that carries a style id in its nativeID is registered here, by the commit itself
    if (!entry && !_carrier.empty() && walk.theme != kNoTheme) {
      if (const auto id = carrierId(node.getProps()->nativeId); id >= 0) {
        entry = adoptCarrier(node, id, walk.theme, walk.epoch);
      }
    }

    const Slot* target = entry ? &entry->slots[walk.theme] : nullptr;

    if (target && !target->delta) {
      target = nullptr; // registered, but with no style for this theme
    }

    if (target) {
      ++walk.scanned;
    }

    const Props* current = node.getProps().get();

    // a registered view needs work after a theme change, or when React replaced its props with something we did not make
    bool needs = target && (walk.full || entry->appliedEpoch != walk.epoch || current != entry->appliedProps);

    // React gave a carrier view new props (a re-render, a pressed state, an inline colour): re-theme only when it shows the
    // colours of another theme. What matches neither theme is state or inline styling and is left alone.
    if (needs && entry->carrier && !walk.full && entry->appliedEpoch == walk.epoch && current != entry->appliedProps) {
      if (matchesDelta(*current, node.getComponentName(), *target->delta) || !showsOtherTheme(*entry, *current, node.getComponentName(), walk.theme)) {
        entry->base = node.getProps();
        entry->appliedProps = current;
        needs = false;
      }
    }

    if (!needs) {
      if (!newChildren) {
        return nullptr;
      }

      return node.clone({.children = newChildren});
    }

    // the node still holds a props object we made (or the registration props the cached ones derive from)
    bool ours = current == entry->appliedProps || current == entry->base.get();

    for (ThemeId id = 0; !ours && id < kMaxThemes; id++) {
      ours = entry->slots[id].produced.get() == current;
    }

    std::shared_ptr<ShadowNode> result;
    const Props* applied = nullptr;

    if (ours && target->produced) {
      ++walk.reused;

      if (newChildren) {
        ++walk.missChildren;
      }

      result = cloneThemed(node, target->produced, newChildren, *target->delta);

      applied = target->produced.get();
    } else {
      ++walk.missNotOurs;

      const auto p0 = Clock::now();
      auto props = buildProps(node, *target->delta);

      walk.propsNs += std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - p0).count();

      result = cloneThemed(node, props, newChildren, *target->delta);
      applied = props.get();

      // React changed the props: they are the new source of truth, everything built from the old ones is stale
      if (!ours) {
        for (auto& slot : entry->slots) {
          slot.produced = nullptr;
        }

        entry->base = nullptr;
      }

      entry->slots[walk.theme].produced = std::move(props); // keeps `applied` alive
    }

    ++walk.applied;

    entry->appliedProps = applied;
    entry->appliedEpoch = walk.epoch;

    return result;
  }

  // One prepared parser per props type, built the same way React Native's ConcreteComponentDescriptor does.
  // A RawProps without a parser attached crashes inside the props constructor.
  template <typename PropsT>
  static const RawPropsParser& parserFor() {
    static RawPropsParser parser;
    static std::once_flag once;

    std::call_once(once, [] { parser.prepare<PropsT>(); });

    return parser;
  }

  // Typed path: the props constructor copies every field from the source when the RawProps is empty (Props itself is
  // not copyable), then we set the few fields the theme owns. No colour parsing, no dynamic.
  //
  // One RawProps per call, never shared: reading a RawProps moves a mutable cursor (keyIndexCursor_), so a shared instance
  // is a data race between the prewarm thread and the commit thread (an out-of-range index and an abort in debug builds).
  // The parser is read-only once prepared, so sharing that is fine.
  template <typename PropsT>
  static std::shared_ptr<PropsT> copyProps(const PropsParserContext& context, const Props& source) {
    RawProps raw{folly::dynamic::object()};

    raw.parse(parserFor<PropsT>());

    return std::make_shared<PropsT>(context, static_cast<const PropsT&>(source), raw);
  }

  // Typed path only (View, Paragraph). Returns nullptr for any other component.
  Props::Shared buildPropsFrom(SurfaceId surface, const char* name, const Props& source, const TypedDelta& delta) {
    PropsParserContext context{surface, *_contextContainer};

    if (std::strcmp(name, ViewComponentName) == 0) {
      auto props = copyProps<ViewShadowNodeProps>(context, source);

      applyViewFields(*props, delta);
      applyRawFields(*props, source, delta);

      return props;
    }

    if (std::strcmp(name, ParagraphComponentName) == 0) {
      auto props = copyProps<ParagraphProps>(context, source);

      applyViewFields(*props, delta);
      applyRawFields(*props, source, delta);

      if (delta.text) {
        props->textAttributes.foregroundColor = *delta.text;
      }

      return props;
    }

    return nullptr;
  }

  Props::Shared buildProps(const ShadowNode& node, const TypedDelta& delta) {
    if (auto typed = buildPropsFrom(node.getFamily().getSurfaceId(), node.getComponentName(), *node.getProps(), delta)) {
      return typed;
    }

    // anything else: let React Native parse the raw props
    PropsParserContext context{node.getFamily().getSurfaceId(), *_contextContainer};

    return node.getComponentDescriptor().cloneProps(context, node.getProps(), RawProps(delta.raw));
  }

  // Android's mounting layer sends `Props::rawProps` (a folly::dynamic that React Native accumulates from every raw props update)
  // to the Java view, not the typed fields: a typed-only change never reaches the screen there. Keep the dynamic in step.
  static void applyRawFields(Props& props, const Props& source, const TypedDelta& delta) {
#ifdef RN_SERIALIZABLE_STATE
    // the new props are built from an empty RawProps, so their dynamic starts empty: carry over what React last sent (otherwise
    // React's own later changes on a themed view, e.g. borderWidth or accessibilityLabel, would not reach the Android view)
    props.rawProps = source.rawProps.isObject() ? source.rawProps : folly::dynamic::object();

    if (delta.raw.isObject()) {
      props.rawProps.update(delta.raw);
    }
#else
    (void)props;
    (void)source;
    (void)delta;
#endif
  }

  static void applyViewFields(ViewProps& props, const TypedDelta& delta) {
    if (delta.background) {
      props.backgroundColor = *delta.background;
    }

    if (delta.border) {
      props.borderColors.all = *delta.border;
    }

    if (delta.opacity) {
      props.opacity = *delta.opacity;
    }
  }

  std::mutex _mutex;
  std::unordered_map<const ShadowNodeFamily*, Entry> _entries;
  std::unordered_map<int64_t, CarrierStyle> _carrier;
  ThemeId _theme = kNoTheme;
  std::vector<std::string> _themeNames;
  uint64_t _epoch = 0;
  uint64_t _commits = 0;
  bool _fullPending = false; // set by setTheme: the next commit applies the theme to every registered view
  HookStats _stats;
  std::shared_ptr<const ContextContainer> _contextContainer;
};

} // namespace margelo::nitro::shadewind
