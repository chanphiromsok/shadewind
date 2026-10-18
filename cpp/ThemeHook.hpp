#pragma once

#include <atomic>
#include <chrono>
#include <array>
#include <cstring>
#include <folly/container/F14Map.h>
#include <folly/dynamic.h>
#include <react/renderer/components/root/RootShadowNode.h>
#include <react/renderer/components/text/ParagraphProps.h>
#include <react/renderer/components/text/ParagraphShadowNode.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/core/ConcreteState.h>
#include <react/renderer/components/view/ViewShadowNode.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/core/RawProps.h>
#include <react/renderer/core/RawPropsParser.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/uimanager/UIManagerCommitHook.h>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
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

// Themes are interned to small ids so a view's per-theme data is a flat array.
using ThemeId = uint8_t;
inline constexpr ThemeId kMaxThemes = 6;
inline constexpr ThemeId kNoTheme = 0xFF;

// What one style (a className, a useThemed object) changes in each theme. Built once and shared by every view registered with it,
// so registering a view copies one pointer instead of a delta per theme.
struct ThemeStyle {
  std::array<std::shared_ptr<const TypedDelta>, kMaxThemes> byTheme;
};

// `yogaNode_` is protected in YogaLayoutableShadowNode; naming it through a derived class is the one legal way to reach it.
struct YogaAccess : YogaLayoutableShadowNode {
  static facebook::yoga::Node& node(const YogaLayoutableShadowNode& n) {
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

// `display: none`, which is also how React hides a suspended or frozen subtree (cloneHiddenInstance in React's Fabric renderer).
// Nothing under such a node is on screen, and every way back to visible is a commit, so its subtree is themed when it shows.
inline bool isHidden(const ShadowNode& node) {
  // every ViewKind node is a ConcreteViewShadowNode, whose props derive from ViewProps (no RTTI across RN's libraries)
  return node.getTraits().check(ShadowNodeTraits::Trait::ViewKind) &&
      static_cast<const ViewProps&>(*node.getProps()).yogaStyle.display() == facebook::yoga::Display::None;
}

struct HookStats {
  double scanMs = 0;  // a commit that changed nothing: the walk
  double cloneMs = 0; // a commit that changed something: walk + props + clones
  double propsMs = 0; // of cloneMs: building the typed props only
  int applied = 0;    // nodes cloned in the last commit that did work
  int reused = 0;     // of applied: props reused from the cache instead of rebuilt
  bool fullApply = false; // the last walk could not skip unchanged subtrees (theme change, late registration, unknown old tree)
  int scanned = 0;    // registered views looked at
  int visited = 0;    // nodes visited
  int skipped = 0;    // subtrees skipped because the previous commit already themed them
  int hidden = 0;     // `display: none` subtrees skipped (themed when they show)
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
 *
 * The walk does not visit what it cannot change:
 * - a subtree that is the very node object of the previous commit's tree, when that tree was themed for the current theme
 *   and no view registered late since: nothing in it can need work (nodes are immutable). This makes a React commit cost
 *   what React changed, not the size of the tree.
 * - a `display: none` subtree (a frozen screen): it is themed in the commit that shows it again, before it is mounted.
 */
class ThemeHook final : public UIManagerCommitHook {
public:
  void commitHookWasRegistered(const UIManager& uiManager) noexcept override {
    setContextContainer(uiManager.getContextContainer());
  }

  void commitHookWasUnregistered(const UIManager&) noexcept override {}

  void setContextContainer(std::shared_ptr<const ContextContainer> container) {
    std::lock_guard<std::mutex> lock(_mutex);
    _contextContainer = std::move(container);
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

  // One style's deltas by theme name -> the shared per-theme table. Names past kMaxThemes are dropped.
  std::shared_ptr<const ThemeStyle> makeStyle(const std::vector<std::pair<std::string, std::shared_ptr<const TypedDelta>>>& byName) {
    std::lock_guard<std::mutex> lock(_mutex);
    auto style = std::make_shared<ThemeStyle>();

    for (const auto& [name, delta] : byName) {
      if (const auto id = internTheme(name); id != kNoTheme) {
        style->byTheme[id] = delta;
      }
    }

    return style;
  }

  void add(
      const std::shared_ptr<const ShadowNodeFamily>& family,
      std::shared_ptr<const ThemeStyle> style,
      Props::Shared base,
      const char* componentName,
      SurfaceId surface,
      bool renderedWithCurrentTheme = false) {
    std::lock_guard<std::mutex> lock(_mutex);

    // unmounted views leave expired entries behind; drop them as the map grows, not only every 128 commits
    if (_entries.size() >= _purgeAt) {
      purgeExpired();
      _purgeAt = std::max<size_t>(1024, _entries.size() * 2);
    }

    auto& entry = _entries[family.get()];

    entry = Entry{};
    entry.family = family;
    entry.style = std::move(style);
    entry.base = std::move(base);
    entry.componentName = componentName;
    entry.surface = surface;

    // React already rendered this view with the current theme's values (its props are `base`): nothing to apply until the
    // theme changes or React replaces the props. Without this every mounted view is cloned once right after mount, and the
    // flush that follows commits the whole tree again.
    if (renderedWithCurrentTheme && _theme != kNoTheme) {
      entry.appliedEpoch = _epoch;
      entry.appliedProps = entry.base.get();
    } else if (_theme != kNoTheme) {
      // registered with props of another theme (a re-attach, a switch between render and attach): the next commit must look
      // at it, so the previous tree no longer proves anything
      ++_registrationGeneration;
      _stale = true;
    }

    _prewarmQueue.push_back(family);
  }

  void remove(const ShadowNodeFamily* family) {
    std::lock_guard<std::mutex> lock(_mutex);
    _entries.erase(family);
  }

  void setTheme(const std::string& theme) {
    std::lock_guard<std::mutex> lock(_mutex);
    _theme = internTheme(theme);
    ++_epoch;
    _startedEpoch.store(_epoch, std::memory_order_release);
  }

  // The epoch `setTheme` last started (see rootCarries). Lock-free: _mutex is held for a whole commit walk, and the JS thread
  // calls this right after setTheme, when a background (hookAsync) commit may be walking.
  uint64_t epoch() const {
    return _startedEpoch.load(std::memory_order_acquire);
  }

  // Theme transitions: from now on the hook records which epoch each tree it returns was themed for. Idle (and free) until the
  // first transition asks for it. Call before the commit whose mount is to be recognised.
  void watchMounts() {
    _watchMounts.store(true, std::memory_order_relaxed);
  }

  // True when `root` is a tree this hook returned for epoch `minEpoch` or later, i.e. the mount of that tree shows the theme.
  // The mount hook calls it on the main thread: it takes a lock of its own, never the one a commit holds during its walk. A tree
  // that is not among the last few recorded ones answers false (the next mount reports a newer root).
  bool rootCarries(const ShadowNode* root, uint64_t minEpoch) {
    std::lock_guard<std::mutex> lock(_mountMutex);

    for (size_t i = 0; i < _mounts.size(); ++i) {
      // newest first: an address a later tree reused is found before the one it replaced
      const auto& mount = _mounts[(_nextMount + _mounts.size() - 1 - i) % _mounts.size()];

      if (mount.pointer == root) {
        return mount.epoch >= minEpoch;
      }
    }

    return false;
  }

  // A view registered with another theme's props since the last commit: the caller commits once so it is themed now.
  bool hasStale() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _stale && _theme != kNoTheme;
  }

  // Builds the props of every theme for views registered (or re-rendered by React) since the last call, from the props they
  // registered with, so a switch finds them cached. Runs off the JS thread; building props only reads the (immutable) source.
  void prewarm() {
    struct Job {
      const ShadowNodeFamily* family;
      Props::Shared base;
      const char* componentName;
      SurfaceId surface;
      std::vector<std::pair<ThemeId, std::shared_ptr<const TypedDelta>>> deltas;
    };

    std::vector<Job> jobs;
    std::shared_ptr<const ContextContainer> context;

    {
      std::lock_guard<std::mutex> lock(_mutex);
      std::vector<std::weak_ptr<const ShadowNodeFamily>> queue;

      queue.swap(_prewarmQueue);
      context = _contextContainer;

      for (const auto& weak : queue) {
        const auto family = weak.lock();
        const auto it = family ? _entries.find(family.get()) : _entries.end();

        if (it == _entries.end() || !it->second.base || !it->second.componentName) {
          continue;
        }

        const auto& entry = it->second;
        Job job{family.get(), entry.base, entry.componentName, entry.surface, {}};

        for (ThemeId id = 0; id < kMaxThemes; id++) {
          if (entry.style->byTheme[id] && !entry.produced[id]) {
            job.deltas.emplace_back(id, entry.style->byTheme[id]);
          }
        }

        if (!job.deltas.empty()) {
          jobs.push_back(std::move(job));
        }
      }
    }

    if (jobs.empty() || !context) {
      return;
    }

    std::vector<std::vector<std::pair<ThemeId, Props::Shared>>> built(jobs.size());

    for (size_t i = 0; i < jobs.size(); i++) {
      for (const auto& [id, delta] : jobs[i].deltas) {
        if (auto props = buildPropsFrom(*context, jobs[i].surface, jobs[i].componentName, *jobs[i].base, *delta)) {
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
          auto& slot = entry->second.produced[id];

          if (!slot) {
            slot = std::move(props); // keeps a version the hook built in the meantime
          }
        }
      }
    }
  }

  // Debug (inspect): what the hook believes about one view, next to the props the committed tree holds for it.
  std::string describe(const ShadowNodeFamily* family, const Props* current) {
    std::lock_guard<std::mutex> lock(_mutex);
    const auto it = _entries.find(family);

    if (it == _entries.end()) {
      return "noentry";
    }

    const auto& e = it->second;

    return "ep=" + std::to_string(e.appliedEpoch) + "/" + std::to_string(_epoch) + " app==cur:" + std::to_string(current == e.appliedProps) +
        " base==cur:" + std::to_string(current == e.base.get()) + " delta:" + std::to_string(_theme != kNoTheme && e.style->byTheme[_theme] != nullptr) +
        " prod:" + std::to_string(_theme != kNoTheme && e.produced[_theme].get() == current) + " " + (e.componentName ? e.componentName : "?");
  }

  // Debug (inspect): every live registered view with what the current theme gives it.
  struct Registered {
    std::shared_ptr<const ShadowNodeFamily> family;
    std::shared_ptr<const TypedDelta> delta; // null: no style for the current theme
  };

  std::vector<Registered> registered() {
    std::lock_guard<std::mutex> lock(_mutex);
    std::vector<Registered> result;

    result.reserve(_entries.size());

    for (const auto& [_, entry] : _entries) {
      if (auto family = entry.family.lock()) {
        result.push_back({std::move(family), _theme != kNoTheme ? entry.style->byTheme[_theme] : nullptr});
      }
    }

    return result;
  }

  size_t size() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _entries.size();
  }

  HookStats stats() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _stats;
  }

  RootShadowNode::Unshared shadowTreeWillCommit(
      const ShadowTree&,
      const RootShadowNode::Shared& oldRoot,
      const RootShadowNode::Unshared& newRoot,
      const ShadowTreeCommitOptions&) noexcept override {
    using Clock = std::chrono::steady_clock;
    const auto t0 = Clock::now();

    // One pass over the new tree, under one lock hold: decide per registered view, clone it and record what was applied.
    std::unique_lock<std::mutex> lock(_mutex);

    if (_theme == kNoTheme || _entries.empty()) {
      // nothing registered can be wrong in it: the next commit may skip what it shares with this tree
      _stale = false;
      remember(newRoot);

      return newRoot;
    }

    // views that unmounted never show up in a walk, so drop their entries now and then
    if ((++_commits & 127) == 0) {
      purgeExpired();
    }

    Walk walk;

    walk.theme = _theme;
    walk.epoch = _epoch;

    // The previous tree proves its unchanged subtrees right only if this hook produced it for the current theme and no view
    // registered late since. A commit that failed after the hook ran never becomes a previous tree, so it proves nothing.
    const ShadowNode* old = provenTree(oldRoot) ? oldRoot.get() : nullptr;

    _stale = false;

    auto cloned = walkTree(*newRoot, old, walk);
    auto result = cloned ? std::static_pointer_cast<RootShadowNode>(cloned) : newRoot;


    remember(result);

    const auto t1 = Clock::now();
    const double elapsed = std::chrono::duration<double, std::milli>(t1 - t0).count();

    _stats.scanMs = cloned ? 0 : elapsed;
    _stats.cloneMs = cloned ? elapsed : 0;
    _stats.propsMs = static_cast<double>(walk.propsNs) / 1e6;
    _stats.applied = walk.applied;
    _stats.reused = walk.reused;
    _stats.missNotOurs = walk.missNotOurs;
    _stats.missChildren = walk.missChildren;
    _stats.fullApply = old == nullptr;
    _stats.scanned = walk.scanned;
    _stats.visited = walk.visited;
    _stats.skipped = walk.skipped;
    _stats.hidden = walk.hidden;

    return result;
  }

private:
  // Hot fields first: the commit reads these for every registered view it visits.
  struct Entry {
    std::weak_ptr<const ShadowNodeFamily> family;
    uint64_t appliedEpoch = 0;
    // The props object last applied. Not owning: it is always also held by `produced[theme]` or `base`, so it stays alive.
    const Props* appliedProps = nullptr;
    std::shared_ptr<const ThemeStyle> style;
    Props::Shared base; // the props React last gave the view (what produced[] is built from)
    const char* componentName = nullptr;
    SurfaceId surface = 0;
    std::array<Props::Shared, kMaxThemes> produced; // props built per theme, reused while the node holds one of ours
  };

  // A tree this hook returned, and what it was themed for.
  struct Proof {
    std::weak_ptr<const ShadowNode> root;
    const ShadowNode* pointer = nullptr;
    uint64_t epoch = 0;
    uint64_t registrations = 0;
  };

  struct Walk {
    ThemeId theme = kNoTheme;
    uint64_t epoch = 0;
    int scanned = 0;
    int visited = 0;
    int applied = 0;
    int reused = 0;
    int skipped = 0;
    int hidden = 0;
    int missNotOurs = 0, missChildren = 0;
    int64_t propsNs = 0;
  };

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

  // Caller holds _mutex.
  void purgeExpired() {
    std::vector<const ShadowNodeFamily*> expired;

    for (const auto& [key, entry] : _entries) {
      if (entry.family.expired()) {
        expired.push_back(key);
      }
    }

    for (const auto* key : expired) {
      _entries.erase(key);
    }
  }

  // Caller holds _mutex. The committed tree is the very root object a hook returned (ShadowTree::tryCommit stores it as is).
  bool provenTree(const RootShadowNode::Shared& oldRoot) const {
    for (const auto& proof : _proofs) {
      if (proof.pointer == oldRoot.get() && !proof.root.expired()) {
        return proof.epoch == _epoch && proof.registrations == _registrationGeneration;
      }
    }

    return false;
  }

  // Caller holds _mutex. Several surfaces and retried commits interleave, hence a few slots.
  void remember(const std::shared_ptr<const ShadowNode>& root) {
    _proofs[_nextProof] = Proof{root, root.get(), _epoch, _registrationGeneration};
    _nextProof = (_nextProof + 1) % _proofs.size();

    if (_watchMounts.load(std::memory_order_relaxed)) {
      std::lock_guard<std::mutex> lock(_mountMutex); // lock order: _mutex, then _mountMutex
      _mounts[_nextMount] = {root.get(), _epoch};
      _nextMount = (_nextMount + 1) % _mounts.size();
    }
  }

  // The node at the same place in the previous tree: same index, or shifted by the difference in child count (an insertion or
  // removal above it). Anything else: no counterpart, the subtree is walked in full.
  static const ShadowNode* counterpart(
      const std::vector<std::shared_ptr<const ShadowNode>>& olds,
      const std::vector<std::shared_ptr<const ShadowNode>>& news,
      size_t i) {
    const auto& family = news[i]->getFamily();

    if (i < olds.size() && &olds[i]->getFamily() == &family) {
      return olds[i].get();
    }

    const auto shifted = static_cast<std::ptrdiff_t>(i) + static_cast<std::ptrdiff_t>(olds.size()) -
        static_cast<std::ptrdiff_t>(news.size());

    if (shifted >= 0 && shifted < static_cast<std::ptrdiff_t>(olds.size()) && &olds[shifted]->getFamily() == &family) {
      return olds[shifted].get();
    }

    return nullptr;
  }

  // Returns the replacement for `node`, or nullptr when nothing under it changed. `old` is the same view in a proven previous
  // tree (or null). Caller holds _mutex.
  std::shared_ptr<ShadowNode> walkTree(const ShadowNode& node, const ShadowNode* old, Walk& walk) {
    using Clock = std::chrono::steady_clock;

    if (old == &node) {
      ++walk.skipped;
      return nullptr;
    }

    if (isHidden(node)) {
      ++walk.hidden;
      return nullptr;
    }

    // a subtree that was hidden in the previous tree was not themed then: being the same objects proves nothing
    if (old != nullptr && isHidden(*old)) {
      old = nullptr;
    }

    ++walk.visited;

    // children first: a changed child makes this node a (cheap) clone with a new children list
    ShadowNode::SharedListOfShared newChildren;
    {
      const auto& children = node.getChildren();
      const auto* oldChildren = old != nullptr ? &old->getChildren() : nullptr;
      std::vector<std::shared_ptr<ShadowNode>> replaced;

      for (size_t i = 0; i < children.size(); i++) {
        const ShadowNode* oldChild = oldChildren != nullptr ? counterpart(*oldChildren, children, i) : nullptr;

        if (auto next = walkTree(*children[i], oldChild, walk)) {
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

    const TypedDelta* delta = entry ? entry->style->byTheme[walk.theme].get() : nullptr; // null: no style for this theme

    if (delta) {
      ++walk.scanned;
    }

    const Props* current = node.getProps().get();

    // a registered view needs work after a theme change, or when React replaced its props with something we did not make
    const bool needs = delta && (entry->appliedEpoch != walk.epoch || current != entry->appliedProps);

    if (!needs) {
      if (!newChildren) {
        return nullptr;
      }

      return node.clone({.children = newChildren});
    }

    // the node still holds a props object we made (or the props the cached ones derive from)
    bool ours = current == entry->appliedProps || current == entry->base.get();

    for (ThemeId id = 0; !ours && id < kMaxThemes; id++) {
      ours = entry->produced[id].get() == current;
    }

    std::shared_ptr<ShadowNode> result;
    const Props* applied = nullptr;
    auto& target = entry->produced[walk.theme];

    if (ours && target) {
      ++walk.reused;

      if (newChildren) {
        ++walk.missChildren;
      }

      result = cloneThemed(node, target, newChildren, *delta);
      applied = target.get();
    } else {
      ++walk.missNotOurs;

      const auto p0 = Clock::now();
      auto props = buildProps(node, *delta);

      walk.propsNs += std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - p0).count();

      result = cloneThemed(node, props, newChildren, *delta);
      applied = props.get();

      // React changed the props: they are the new source of truth. Everything built from the old ones is stale; the next
      // React commit brings these same props again (React's handle), so they become `base` and the clone below is reused.
      if (!ours) {
        for (auto& slot : entry->produced) {
          slot = nullptr;
        }

        entry->base = node.getProps();
        _prewarmQueue.push_back(entry->family);
      }

      target = std::move(props); // keeps `applied` alive
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
  static Props::Shared buildPropsFrom(
      const ContextContainer& container,
      SurfaceId surface,
      const char* name,
      const Props& source,
      const TypedDelta& delta) {
    PropsParserContext context{surface, container};

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

  // Caller holds _mutex.
  Props::Shared buildProps(const ShadowNode& node, const TypedDelta& delta) {
    const auto surface = node.getFamily().getSurfaceId();

    if (auto typed = buildPropsFrom(*_contextContainer, surface, node.getComponentName(), *node.getProps(), delta)) {
      return typed;
    }

    // anything else: let React Native parse the raw props
    PropsParserContext context{surface, *_contextContainer};

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
  folly::F14FastMap<const ShadowNodeFamily*, Entry> _entries;
  std::vector<std::weak_ptr<const ShadowNodeFamily>> _prewarmQueue;
  std::array<Proof, 16> _proofs{};
  size_t _nextProof = 0;
  // Trees returned since the first transition, with the epoch they carry (rootCarries). Own lock: see rootCarries.
  struct Mounted {
    const ShadowNode* pointer = nullptr; // identity only, never dereferenced
    uint64_t epoch = 0;
  };
  std::atomic<bool> _watchMounts{false};
  std::mutex _mountMutex;
  std::array<Mounted, 16> _mounts{};
  size_t _nextMount = 0;
  ThemeId _theme = kNoTheme;
  std::vector<std::string> _themeNames;
  uint64_t _epoch = 0;
  std::atomic<uint64_t> _startedEpoch{0}; // _epoch, readable without _mutex (epoch())
  uint64_t _registrationGeneration = 0; // bumped by every registration with another theme's props
  bool _stale = false;                  // such a registration happened since the last walk
  uint64_t _commits = 0;
  size_t _purgeAt = 1024;
  HookStats _stats;
  std::shared_ptr<const ContextContainer> _contextContainer;
};

} // namespace margelo::nitro::shadewind
