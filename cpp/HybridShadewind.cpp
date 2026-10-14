#include "HybridShadewind.hpp"

#include <chrono>
#include <jsi/JSIDynamic.h>
#include <react/renderer/components/root/RootShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/core/RawProps.h>
#include <react/renderer/core/RawValue.h>
#include <react/renderer/graphics/Color.h>
#include <react/renderer/graphics/PlatformColorParser.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/mounting/ShadowTreeRegistry.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/uimanager/UIManagerBinding.h>
#include <react/renderer/uimanager/primitives.h>
#include <atomic>
#include <type_traits>
#include <unordered_set>
#include "ShadewindNative.hpp"
#if defined(__APPLE__)
#include <dispatch/dispatch.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace margelo::nitro::shadewind {

using namespace facebook::react;

namespace {

// Main-thread busy probe: how long the main run loop stays awake without going back to sleep. A mount of 1500 updated views
// shows up here as one long busy period (it is what a user sees as a dropped frame); nothing in JS can see it.
// Only iOS feeds it (run loop observer); elsewhere mainBusyMs() reports 0.
std::atomic<double> gBusyStartMs{0};
std::atomic<double> gMaxBusyMs{0};

double runLoopNowMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Debug: counts of why a Paragraph clone could not skip layout (see RecoloredParagraph::reason); resets the counters.
std::string reasonsText() {
  std::string text;

  for (int i = 0; i < 9; ++i) {
    text += (i ? "," : "") + std::to_string(gReasons[i].exchange(0));
  }

  gRecolored = 0;
  gRecolorSkipDirty = 0;
  gRecolorSkipState = 0;

  return text;
}

// ARGB of a SharedColor as an unsigned value. `Color` is an int on Android and a class on iOS (the template keeps the branch
// that does not apply from being compiled).
template <typename ColorT>
int64_t colorValueBits(const ColorT& value) {
  if constexpr (std::is_arithmetic_v<ColorT>) {
    return static_cast<int64_t>(static_cast<uint32_t>(value));
  } else {
    return static_cast<int64_t>(static_cast<uint32_t>(value.getColor()));
  }
}

int64_t colorBits(const SharedColor& color) {
  return colorValueBits(*color);
}

#if defined(__APPLE__)
void runOnMain(std::function<void()> work) {
  auto* task = new std::function<void()>(std::move(work));

  dispatch_async_f(dispatch_get_main_queue(), task, [](void* context) {
    auto* function = static_cast<std::function<void()>*>(context);

    (*function)();
    delete function;
  });
}

// Main-thread busy probe (iOS only): see below.
std::atomic<bool> gBusyObserverInstalled{false};

void runLoopActivity(CFRunLoopObserverRef, CFRunLoopActivity activity, void*) {
  if (activity == kCFRunLoopAfterWaiting) {
    gBusyStartMs.store(runLoopNowMs());
  } else if (activity == kCFRunLoopBeforeWaiting) {
    const double start = gBusyStartMs.exchange(0);

    if (start > 0) {
      const double busy = runLoopNowMs() - start;

      if (busy > gMaxBusyMs.load()) {
        gMaxBusyMs.store(busy);
      }
    }
  }
}

void runInBackground(std::function<void()> work) {
  auto* task = new std::function<void()>(std::move(work));

  dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), task, [](void* context) {
    auto* function = static_cast<std::function<void()>*>(context);

    (*function)();
    delete function;
  });
}
#endif

// Results of the last background / main-thread pass, read by the next setTheme call (they finish after it returned).
std::atomic<double> gLastAsyncCommitMs{0};
// setTheme call -> main thread done mounting (the screen update), of the last switch
std::atomic<double> gLastVisualMs{0};

using Clock = std::chrono::steady_clock;

double ms(Clock::time_point from, Clock::time_point to) {
  return std::chrono::duration<double, std::milli>(to - from).count();
}

// How an update reaches the screen. The two hook strategies keep the theme in the commit hook (no nativeProps overlay);
// the others merge into nativeProps_DEPRECATED first, so a later React clone of the node keeps the new values (baselines).
enum class Strategy {
  HookAsync, // default: typed props applied inside a commit hook, commit on a background thread (JS thread free right away)
  Hook,   // the same with a synchronous commit
  Stock,  // UIManager::updateShadowTree (whole-tree walk, linear de-duplication)
  Fast,   // one ShadowTree::commit + cloneMultiple: only the touched nodes and their ancestors (internal: flushPending)
  FastAsync, // same, but the UI thread mounts it later instead of the caller waiting for it
  Direct, // update the native views right away, shadow tree is synced by the next React clone
  Both,   // direct update now + single-pass commit to keep the shadow tree exact
};

bool parseStrategy(const std::string& name, Strategy& out) {
  if (name == "hook") out = Strategy::Hook;
  else if (name == "hookAsync") out = Strategy::HookAsync;
  else if (name == "stock") out = Strategy::Stock;
  else if (name == "fastAsync") out = Strategy::FastAsync;
  else if (name == "direct") out = Strategy::Direct;
  else if (name == "both") out = Strategy::Both;
  else return false;

  return true;
}

struct ApplyTimings {
  double directMs = 0;
  double commitMs = 0;
};

// One commit per surface, cloning only the families we touch (RN's animation backend does the same).
void commitSingleSurfacePass(UIManager& ui, const std::vector<Update>& updates, bool mountSynchronously) {
  std::unordered_map<SurfaceId, std::vector<const Update*>> bySurface;

  for (const auto& update : updates) {
    bySurface[update.family->getSurfaceId()].push_back(&update);
  }

  const auto contextContainer = ui.getContextContainer();

  for (const auto& [surfaceId, group] : bySurface) {
    std::unordered_set<std::shared_ptr<const ShadowNodeFamily>> families;
    std::unordered_map<const ShadowNodeFamily*, const folly::dynamic*> propsByFamily;

    families.reserve(group.size());
    propsByFamily.reserve(group.size());

    for (const auto* update : group) {
      families.insert(update->family);
      propsByFamily.emplace(update->family.get(), &update->props);
    }

    ui.getShadowTreeRegistry().visit(surfaceId, [&](const ShadowTree& shadowTree) {
      shadowTree.commit(
          [&](const RootShadowNode& oldRoot) {
            return std::static_pointer_cast<RootShadowNode>(oldRoot.cloneMultiple(
                families,
                [&](const ShadowNode& node, const ShadowNodeFragment& fragment) {
                  auto props = ShadowNodeFragment::propsPlaceholder();
                  auto it = propsByFamily.find(&node.getFamily());

                  if (it != propsByFamily.end()) {
                    PropsParserContext context{surfaceId, *contextContainer};

                    props = node.getComponentDescriptor().cloneProps(context, node.getProps(), RawProps(*it->second));
                  }

                  return node.clone({.props = props, .children = fragment.children, .state = node.getState()});
                }));
          },
          {.mountSynchronously = mountSynchronously});
    });
  }
}

} // namespace

// Builds the per-theme props of newly registered views on a background thread (see ThemeHook::prewarm).
void HybridShadewind::schedulePrewarm() {
#if defined(__APPLE__)
  auto* task = new std::function<void()>([hook = _hook]() { hook->prewarm(); });

  dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), task, [](void* context) {
    auto* function = static_cast<std::function<void()>*>(context);

    (*function)();
    delete function;
  });
#else
  _hook->prewarm();
#endif
}

namespace {

// An (almost) empty commit: the commit hook does the real work on it. Same trick as RN's animation backend.
void commitTick(UIManager& ui, bool mountSynchronously = true) {
  ui.getShadowTreeRegistry().enumerate([mountSynchronously](const ShadowTree& shadowTree, bool&) {
    shadowTree.commit(
        [](const RootShadowNode& oldRoot) { return std::static_pointer_cast<RootShadowNode>(oldRoot.ShadowNode::clone({})); },
        {.mountSynchronously = mountSynchronously});
  });
}

std::shared_ptr<const TypedDelta> toTypedDelta(UIManager& ui, SurfaceId surfaceId, const folly::dynamic& props) {
  auto delta = std::make_shared<TypedDelta>();
  delta->raw = props;

  const auto color = [&](const char* key) -> std::optional<SharedColor> {
    if (const auto* value = props.get_ptr(key)) {
      SharedColor parsed;

      fromRawValue(*ui.getContextContainer(), surfaceId, RawValue(*value), parsed);

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

ApplyTimings applyUpdates(UIManager& ui, std::vector<Update>& updates, Strategy strategy) {
  ApplyTimings timings;

  for (const auto& update : updates) {
    mergeNativeProps(*update.family, update.props);
  }

  if (updates.empty()) {
    return timings;
  }

  if (strategy == Strategy::Direct || strategy == Strategy::Both) {
    const auto t0 = Clock::now();

    for (const auto& update : updates) {
      ui.synchronouslyUpdateViewOnUIThread(update.tag, update.props);
    }

    timings.directMs = ms(t0, Clock::now());
  }

  if (strategy == Strategy::Stock) {
    const auto t0 = Clock::now();
    std::unordered_map<Tag, folly::dynamic> tagToProps;

    tagToProps.reserve(updates.size());

    for (const auto& update : updates) {
      tagToProps.emplace(update.tag, update.props);
    }

    ui.updateShadowTree(std::move(tagToProps));
    timings.commitMs = ms(t0, Clock::now());
  } else if (strategy == Strategy::Fast || strategy == Strategy::FastAsync || strategy == Strategy::Both) {
    const auto t0 = Clock::now();

    commitSingleSurfacePass(ui, updates, strategy != Strategy::FastAsync);
    timings.commitMs = ms(t0, Clock::now());
  }

  return timings;
}

} // namespace

std::string HybridShadewind::getTheme() {
  std::lock_guard<std::mutex> lock(_themeMutex);
  return _theme;
}

void HybridShadewind::loadHybridMethods() {
  HybridShadewindSpec::loadHybridMethods();

  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("register", 2, &HybridShadewind::registerNode);
    prototype.registerRawHybridMethod("unregister", 1, &HybridShadewind::unregisterNode);
    prototype.registerRawHybridMethod("refreshReactNodes", 1, &HybridShadewind::refreshReactNodes);
    prototype.registerRawHybridMethod("inspect", 0, &HybridShadewind::inspect);
    prototype.registerRawHybridMethod("flushPending", 0, &HybridShadewind::flushPending);
    prototype.registerRawHybridMethod("prepare", 0, &HybridShadewind::prepare);
    prototype.registerRawHybridMethod("resetMainBusy", 0, &HybridShadewind::resetMainBusy);
    prototype.registerRawHybridMethod("mainBusyMs", 0, &HybridShadewind::mainBusyMs);
    prototype.registerRawHybridMethod("setTheme", 1, &HybridShadewind::setTheme);
  });
}

// register(shadowNode, { light: { backgroundColor: 4294967295 }, dark: { ... } })
// Props must already be in the raw format React Native sends to native (e.g. processed colors).
jsi::Value HybridShadewind::registerNode(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 2 || !args[1].isObject()) {
    throw jsi::JSError(rt, "Shadewind.register(node, propsByTheme) expects 2 arguments");
  }

  auto node = Bridging<std::shared_ptr<const ShadowNode>>::fromJs(rt, args[0]);

  if (!node) {
    throw jsi::JSError(rt, "Shadewind.register: first argument is not a ShadowNode");
  }

  auto themes = args[1].asObject(rt);
  auto names = themes.getPropertyNames(rt);
  std::unordered_map<std::string, folly::dynamic> propsByTheme;

  for (size_t i = 0; i < names.size(rt); i++) {
    auto name = names.getValueAtIndex(rt, i).asString(rt);

    propsByTheme.emplace(name.utf8(rt), jsi::dynamicFromValue(rt, themes.getProperty(rt, name)));
  }

  if (auto binding = UIManagerBinding::getBinding(rt)) {
    auto& ui = binding->getUIManager();

    if (!_hookRegistered) {
      ui.registerCommitHook(*_hook);
      _hookRegistered = true;
#if defined(__APPLE__)
      _hook->setAsync(runInBackground);
#endif
    }

    std::unordered_map<std::string, std::shared_ptr<const TypedDelta>> typed;

    for (const auto& [name, props] : propsByTheme) {
      typed.emplace(name, toTypedDelta(ui, node->getFamily().getSurfaceId(), props));
    }

    _hook->add(node->getFamilyShared(), std::move(typed), node->getProps(), node->getComponentName(), node->getFamily().getSurfaceId());
  }

  _registry.add(node->getFamilyShared(), std::move(propsByTheme));

  return jsi::Value::undefined();
}

jsi::Value HybridShadewind::unregisterNode(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1) {
    return jsi::Value::undefined();
  }

  auto node = Bridging<std::shared_ptr<const ShadowNode>>::fromJs(rt, args[0]);

  if (node) {
    _registry.remove(&node->getFamily());
    _hook->remove(&node->getFamily());
  }

  return jsi::Value::undefined();
}

// refreshReactNodes(nodes): repoint the JS wrappers React holds (fiber.stateNode.node) at the nodes of the committed tree.
// React rebuilds its tree from those wrappers (un-hiding a frozen screen, re-attaching untouched children), so a wrapper
// that still points at the pre-update node silently brings the old props back. Returns how many wrappers were updated.
jsi::Value HybridShadewind::refreshReactNodes(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  auto binding = UIManagerBinding::getBinding(rt);

  if (count < 1 || !args[0].isObject() || !binding) {
    return jsi::Value(0);
  }

  auto& ui = binding->getUIManager();
  auto array = args[0].asObject(rt).asArray(rt);
  const size_t length = array.size(rt);
  std::unordered_map<SurfaceId, std::shared_ptr<const RootShadowNode>> roots;
  int refreshed = 0;

  for (size_t i = 0; i < length; i++) {
    auto value = array.getValueAtIndex(rt, i);

    if (!value.isObject()) {
      continue;
    }

    auto object = value.asObject(rt);

    if (!object.hasNativeState<ShadowNodeWrapper>(rt)) {
      continue;
    }

    auto wrapper = object.getNativeState<ShadowNodeWrapper>(rt);

    if (!wrapper->shadowNode) {
      continue;
    }

    const auto& family = wrapper->shadowNode->getFamily();
    const auto surfaceId = family.getSurfaceId();
    auto root = roots.find(surfaceId);

    if (root == roots.end()) {
      std::shared_ptr<const RootShadowNode> current;

      ui.getShadowTreeRegistry().visit(surfaceId, [&](const ShadowTree& tree) {
        current = tree.getCurrentRevision().rootShadowNode;
      });

      root = roots.emplace(surfaceId, std::move(current)).first;
    }

    if (!root->second) {
      continue;
    }

    auto ancestors = family.getAncestors(*root->second);

    if (ancestors.empty()) {
      continue;
    }

    std::shared_ptr<const ShadowNode> node = root->second;

    for (const auto& ancestor : ancestors) {
      node = node->getChildren()[ancestor.second];
    }

    wrapper->shadowNode = std::move(node);
    ++refreshed;
  }

  return jsi::Value(refreshed);
}

// Debug: for every registered view compare the background colour of
//   - the node in the committed shadow tree,
//   - our nativeProps_DEPRECATED overlay,
//   - what the registry expects for the current theme.
// Tells where a stale colour comes from after a freeze / navigation.
jsi::Value HybridShadewind::inspect(jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
  std::string theme = getTheme();
  auto binding = UIManagerBinding::getBinding(rt);
  auto report = jsi::Object(rt);

  report.setProperty(rt, "theme", jsi::String::createFromUtf8(rt, theme));

  if (!binding || theme.empty()) {
    return report;
  }

  auto& ui = binding->getUIManager();
  auto updates = _registry.collect(theme);

  const auto asColor = [](const folly::dynamic* value) -> int64_t {
    if (value == nullptr || !value->isNumber()) {
      return -1;
    }

    return static_cast<int64_t>(static_cast<uint32_t>(value->asInt()));
  };

  int inTree = 0, notInTree = 0, treeMatches = 0, nativeMatches = 0, layerMatches = 0;
  std::string samples;

  std::vector<Tag> tags;

  tags.reserve(updates.size());

  for (const auto& update : updates) {
    tags.push_back(update.tag);
  }

  const auto uikit = readBackgroundsOnMain(tags);
  std::unordered_map<Tag, size_t> uikitIndex;

  for (size_t i = 0; i < uikit.size(); ++i) {
    uikitIndex.emplace(uikit[i].tag, i);
  }

  for (const auto& update : updates) {
    const int64_t expected = asColor(update.props.get_ptr("backgroundColor"));
    int64_t treeBg = -1;
    bool found = false;

    ui.getShadowTreeRegistry().visit(update.family->getSurfaceId(), [&](const ShadowTree& tree) {
      auto root = tree.getCurrentRevision().rootShadowNode;
      auto ancestors = update.family->getAncestors(*root);

      if (ancestors.empty()) {
        return;
      }

      const ShadowNode* node = root.get();

      for (const auto& ancestor : ancestors) {
        node = node->getChildren()[ancestor.second].get();
      }

      found = true;

      if (auto viewProps = std::dynamic_pointer_cast<const ViewProps>(node->getProps()); viewProps && viewProps->backgroundColor) {
        treeBg = colorBits(*viewProps->backgroundColor);
      }
    });

    int64_t nativeBg = -1;

    {
#if SHADEWIND_HAS_NATIVE_PROPS_MUTEX
      std::lock_guard<std::mutex> lock(update.family->nativePropsMutex);
#endif
      if (update.family->nativeProps_DEPRECATED && update.family->nativeProps_DEPRECATED->isObject()) {
        nativeBg = asColor(update.family->nativeProps_DEPRECATED->get_ptr("backgroundColor"));
      }
    }

    found ? ++inTree : ++notInTree;

    if (found && treeBg == expected) {
      ++treeMatches;
    }

    // what UIKit holds (the UIView ivar and the painted layer); `overlay` is RN's nativeProps_DEPRECATED, which only the older
    // strategies write, so it is NOT the screen
    const auto& u = uikit[uikitIndex[update.tag]];

    if (u.viewColor == expected) {
      ++nativeMatches;
    }

    if (u.layerColor == expected) {
      ++layerMatches;
    }

    (void)nativeBg;

    if (samples.size() < 600 && (u.viewColor != expected || u.layerColor != expected || (found && treeBg != expected))) {
      samples += "tag " + std::to_string(update.tag) + (found ? "" : " (not in tree)") + ": tree=" + std::to_string(treeBg) +
          " view=" + std::to_string(u.viewColor) + " layer=" + std::to_string(u.layerColor) +
          " overlay=" + std::to_string(nativeBg) + " expected=" + std::to_string(expected) + "; ";
    }
  }

  report.setProperty(rt, "registered", static_cast<double>(updates.size()));
  report.setProperty(rt, "inTree", inTree);
  report.setProperty(rt, "notInTree", notInTree);
  report.setProperty(rt, "treeMatchesExpected", treeMatches);
  report.setProperty(rt, "nativePropsMatchExpected", nativeMatches); // now: UIView.backgroundColor == expected
  report.setProperty(rt, "layerMatchesExpected", layerMatches);
  report.setProperty(rt, "samples", jsi::String::createFromUtf8(rt, samples));

  return report;
}

// Applies the current theme to views registered since the last flush (mounted late, or revealed after a freeze).
// One commit for all of them. No-op until setTheme was called once.
// Hint that a theme switch is likely coming: warms the memory the switch will read, off the JS thread.
jsi::Value HybridShadewind::prepare(jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
  if (!_hookRegistered) {
    return jsi::Value::undefined();
  }

#if defined(__APPLE__)
  auto* task = new std::function<void()>([hook = _hook]() { hook->touch(); });

  dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), task, [](void* context) {
    auto* function = static_cast<std::function<void()>*>(context);

    (*function)();
    delete function;
  });
#else
  _hook->touch();
#endif

  return jsi::Value::undefined();
}

// Starts (once) the main run loop observer and clears the longest busy period seen so far.
jsi::Value HybridShadewind::resetMainBusy(jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
#if defined(__APPLE__)
  if (!gBusyObserverInstalled.exchange(true)) {
    runOnMain([]() {
      auto observer = CFRunLoopObserverCreate(
          kCFAllocatorDefault, kCFRunLoopAfterWaiting | kCFRunLoopBeforeWaiting, true, 0, runLoopActivity, nullptr);

      CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
    });
  }
#endif

  gMaxBusyMs.store(0);

  return jsi::Value::undefined();
}

// Longest main-thread busy period (ms) since resetMainBusy.
jsi::Value HybridShadewind::mainBusyMs(jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
  double busy = gMaxBusyMs.load();
  const double start = gBusyStartMs.load();

  // a busy period still in progress counts too (it only reaches gMaxBusyMs once the main thread goes back to sleep)
  if (start > 0) {
    busy = std::max(busy, runLoopNowMs() - start);
  }

  return jsi::Value(busy);
}

jsi::Value HybridShadewind::flushPending(jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
  if (_hookRegistered) {
    schedulePrewarm();
  }

  std::string theme;

  {
    std::lock_guard<std::mutex> lock(_themeMutex);
    theme = _theme;
  }

  if (theme.empty()) {
    _registry.collectPending(""); // drops the pending list
    return jsi::Value::undefined();
  }

  auto binding = UIManagerBinding::getBinding(rt);

  if (_hookMode) {
    _registry.collectPending(theme); // not used in hook mode, just drop the list

    if (binding && _hook->hasUnapplied()) {
      commitTick(binding->getUIManager());
    }

    return jsi::Value::undefined();
  }

  auto updates = _registry.collectPending(theme);

  if (!binding || updates.empty()) {
    return jsi::Value::undefined();
  }

  applyUpdates(binding->getUIManager(), updates, Strategy::Fast);

  return jsi::Value::undefined();
}

// setTheme(name, strategy?) pushes the registered props of `name` to every live view without touching React.
// strategy: 'hookAsync' (default) | 'hook' | 'stock' | 'fast' | 'fastAsync' | 'direct' | 'both'
jsi::Value HybridShadewind::setTheme(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1 || !args[0].isString()) {
    throw jsi::JSError(rt, "Shadewind.setTheme(name) expects a string");
  }

  auto name = args[0].asString(rt).utf8(rt);
  Strategy strategy = Strategy::HookAsync;

  if (count > 1 && args[1].isString()) {
    const auto requested = args[1].asString(rt).utf8(rt);

    if (!parseStrategy(requested, strategy)) {
      throw jsi::JSError(rt, "Shadewind.setTheme: unknown strategy '" + requested + "' (hook, hookAsync, stock, fastAsync, direct, both)");
    }
  }

  {
    std::lock_guard<std::mutex> lock(_themeMutex);
    _theme = name;
  }

  auto binding = UIManagerBinding::getBinding(rt);

  if (!binding) {
    throw jsi::JSError(rt, "Shadewind.setTheme: Fabric UIManager is not available (New Architecture only)");
  }

  _hookMode = strategy == Strategy::Hook || strategy == Strategy::HookAsync;

  if (strategy == Strategy::HookAsync) {
    const auto a0 = Clock::now();

    _hook->setTheme(name);

    // The commit (scan + clone + mount hand-off) runs off the JS thread. The hook keeps working for every commit.
#if defined(__APPLE__)
    auto* task = new std::function<void()>([binding, a0]() {
      const auto c0 = Clock::now();

      // like React's own commits: do not make this thread wait while the main thread mounts 1500 updated views
      commitTick(binding->getUIManager(), false);
      gLastAsyncCommitMs = ms(c0, Clock::now());

      // The commit queued its mount on the main queue; this block queues behind it, so when it runs the views are mounted
      // (the next vsync presents them). That is the time from the setTheme call to the screen update.
      runOnMain([a0]() { gLastVisualMs = ms(a0, Clock::now()); });
    });

    dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), task, [](void* context) {
      auto* function = static_cast<std::function<void()>*>(context);

      (*function)();
      delete function;
    });
#else
    commitTick(binding->getUIManager());
#endif

    const auto a1 = Clock::now();
    const auto stats = _hook->stats();
    auto result = jsi::Object(rt);

    result.setProperty(rt, "views", static_cast<double>(stats.applied));
    result.setProperty(rt, "scanMs", stats.scanMs);   // from the previous run
    result.setProperty(rt, "cloneMs", stats.cloneMs); // from the previous run
    result.setProperty(rt, "propsMs", stats.propsMs);
    result.setProperty(rt, "reused", static_cast<double>(stats.reused));
    result.setProperty(rt, "precloned", static_cast<double>(stats.precloned));
    result.setProperty(
        rt,
        "misses",
        std::to_string(stats.missNotOurs) + "/" + std::to_string(stats.missNoBuffer) + "/" + std::to_string(stats.missSource) + "/" +
            std::to_string(stats.missProps) + "/" + std::to_string(stats.missChildren) + " recolor " + std::to_string(gRecolored.load()) +
            "/" + std::to_string(gRecolorSkipDirty.load()) + "/" + std::to_string(gRecolorSkipState.load()) + " reasons " +
            reasonsText());
    result.setProperty(rt, "collectMs", 0.0);
    result.setProperty(rt, "directMs", 0.0);
    result.setProperty(rt, "commitMs", gLastAsyncCommitMs.load()); // previous background commit
    result.setProperty(rt, "visualMs", gLastVisualMs.load());      // previous setTheme -> mounted on the main thread
    result.setProperty(rt, "totalMs", ms(a0, a1));                 // what the JS thread actually paid

    return result;
  }

  if (_hookMode) {
    const auto h0 = Clock::now();

    _hook->setTheme(name);
    commitTick(binding->getUIManager());

    const auto h1 = Clock::now();
    const auto stats = _hook->stats();
    auto result = jsi::Object(rt);

    result.setProperty(rt, "views", static_cast<double>(stats.applied));
    result.setProperty(rt, "scanMs", stats.scanMs);
    result.setProperty(rt, "cloneMs", stats.cloneMs);
    result.setProperty(rt, "propsMs", stats.propsMs);
    result.setProperty(rt, "reused", static_cast<double>(stats.reused));
    result.setProperty(rt, "precloned", static_cast<double>(stats.precloned));
    result.setProperty(
        rt,
        "misses",
        std::to_string(stats.missNotOurs) + "/" + std::to_string(stats.missNoBuffer) + "/" + std::to_string(stats.missSource) + "/" +
            std::to_string(stats.missProps) + "/" + std::to_string(stats.missChildren) + " recolor " + std::to_string(gRecolored.load()) +
            "/" + std::to_string(gRecolorSkipDirty.load()) + "/" + std::to_string(gRecolorSkipState.load()) + " reasons " +
            reasonsText());
    result.setProperty(rt, "collectMs", 0.0);
    result.setProperty(rt, "directMs", 0.0);
    result.setProperty(rt, "commitMs", ms(h0, h1));
    result.setProperty(rt, "totalMs", ms(h0, h1));

    return result;
  }

  const auto t0 = Clock::now();

  // `updates` pins every family until after the commit
  auto updates = _registry.collect(name);

  const auto t1 = Clock::now();

  auto applied = applyUpdates(binding->getUIManager(), updates, strategy);

  const auto t2 = Clock::now();

  auto timings = jsi::Object(rt);
  timings.setProperty(rt, "views", static_cast<double>(updates.size()));
  timings.setProperty(rt, "collectMs", ms(t0, t1));
  timings.setProperty(rt, "directMs", applied.directMs);
  timings.setProperty(rt, "commitMs", applied.commitMs);
  timings.setProperty(rt, "scanMs", 0.0);
  timings.setProperty(rt, "cloneMs", 0.0);
  timings.setProperty(rt, "propsMs", 0.0);
  timings.setProperty(rt, "totalMs", ms(t0, t2));

  return timings;
}

} // namespace margelo::nitro::shadewind
