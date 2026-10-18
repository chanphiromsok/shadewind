#include "HybridShadewind.hpp"
#include "css/ClassMerge.hpp"
#include "css/StyleResolver.hpp"

#include <chrono>
#include <jsi/JSIDynamic.h>
#include <react/renderer/components/root/RootShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/mounting/ShadowTreeRegistry.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/uimanager/UIManagerBinding.h>
#include <react/renderer/uimanager/primitives.h>
#include <atomic>
#include <cstring>
#include <string>
#include <thread>
#include <type_traits>
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

void runInBackground(std::function<void()> work, qos_class_t qos) {
  auto* task = new std::function<void()>(std::move(work));

  dispatch_async_f(dispatch_get_global_queue(qos, 0), task, [](void* context) {
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
#endif

// Results of the last background / main-thread pass, read by the next setTheme call (they finish after it returned).
[[maybe_unused]] std::atomic<double> gLastAsyncCommitMs{0};
// setTheme call -> main thread done mounting (the screen update), of the last switch
std::atomic<double> gLastVisualMs{0};

using Clock = std::chrono::steady_clock;

double ms(Clock::time_point from, Clock::time_point to) {
  return std::chrono::duration<double, std::milli>(to - from).count();
}

// An (almost) empty commit: the commit hook does the real work on it. Same trick as RN's animation backend.
void commitTick(UIManager& ui, bool mountSynchronously = true) {
  ui.getShadowTreeRegistry().enumerate([mountSynchronously](const ShadowTree& shadowTree, bool&) {
    shadowTree.commit(
        [](const RootShadowNode& oldRoot) { return std::static_pointer_cast<RootShadowNode>(oldRoot.ShadowNode::clone({})); },
        {.mountSynchronously = mountSynchronously});
  });
}

// The hook's last commit, as the JS timing object (`ThemeTimings` in src/internal.tsx).
jsi::Object timingsOf(jsi::Runtime& rt, const HookStats& stats, double commitMs, double totalMs) {
  auto result = jsi::Object(rt);

  result.setProperty(rt, "views", static_cast<double>(stats.applied));
  result.setProperty(rt, "scanMs", stats.scanMs);
  result.setProperty(rt, "cloneMs", stats.cloneMs);
  result.setProperty(rt, "propsMs", stats.propsMs);
  result.setProperty(rt, "reused", static_cast<double>(stats.reused));
  result.setProperty(rt, "visited", static_cast<double>(stats.visited));
  result.setProperty(rt, "skipped", static_cast<double>(stats.skipped));
  result.setProperty(rt, "hidden", static_cast<double>(stats.hidden));
  result.setProperty(
      rt,
      "misses",
      std::to_string(stats.missNotOurs) + "/" + std::to_string(stats.missChildren) + " recolor " + std::to_string(gRecolored.load()) +
          "/" + std::to_string(gRecolorSkipDirty.load()) + "/" + std::to_string(gRecolorSkipState.load()) + " reasons " +
          reasonsText());
  result.setProperty(rt, "commitMs", commitMs);
  result.setProperty(rt, "visualMs", gLastVisualMs.load());
  result.setProperty(rt, "totalMs", totalMs);

  return result;
}

} // namespace

std::string HybridShadewind::getTheme() {
  return _engine.theme();
}

void HybridShadewind::loadHybridMethods() {
  HybridShadewindSpec::loadHybridMethods();

  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("register", 4, &HybridShadewind::registerNode);
    prototype.registerRawHybridMethod("registerMany", 4, &HybridShadewind::registerMany);
    prototype.registerRawHybridMethod("unregister", 1, &HybridShadewind::unregisterNode);
    prototype.registerRawHybridMethod("inspect", 0, &HybridShadewind::inspect);
    prototype.registerRawHybridMethod("flushPending", 0, &HybridShadewind::flushPending);
    prototype.registerRawHybridMethod("prepare", 0, &HybridShadewind::prepare);
    prototype.registerRawHybridMethod("resetMainBusy", 0, &HybridShadewind::resetMainBusy);
    prototype.registerRawHybridMethod("mainBusyMs", 0, &HybridShadewind::mainBusyMs);
    prototype.registerRawHybridMethod("configure", 1, &HybridShadewind::configure);
    prototype.registerRawHybridMethod("loadClassTable", 1, &HybridShadewind::loadClassTable);
    prototype.registerRawHybridMethod("mergeClasses", 0, &HybridShadewind::mergeClasses);
    prototype.registerRawHybridMethod("loadStyleTable", 1, &HybridShadewind::loadStyleTable);
    prototype.registerRawHybridMethod("resolveClasses", 6, &HybridShadewind::resolveStyleClasses);
    prototype.registerRawHybridMethod("setTheme", 1, &HybridShadewind::setTheme);
  });
}

HybridShadewind::State& HybridShadewind::sharedState() {
  static State* state = new State(); // never destroyed on purpose: UIManager keeps a pointer to the hook

  return *state;
}

// The hook keeps the UIManager's ContextContainer alive, so its address cannot be reused by a later UIManager.
UIManager* HybridShadewind::attachedUIManager(jsi::Runtime& rt) {
  auto binding = UIManagerBinding::getBinding(rt);

  if (!binding) {
    return nullptr;
  }

  auto& ui = binding->getUIManager();

  if (_state.registeredContainer.lock() != ui.getContextContainer()) {
    ui.registerCommitHook(_engine.hook());
    _state.registeredContainer = ui.getContextContainer();
  }

  return &ui;
}

// Builds the props of every theme for newly registered views off the JS thread (see ThemeHook::prewarm). One pending run covers
// every registration made before it starts.
void HybridShadewind::schedulePrewarm() {
  if (_state.prewarmScheduled.exchange(true)) {
    return;
  }

  auto run = [hook = _engine.hookShared(), &scheduled = _state.prewarmScheduled]() {
    scheduled = false; // before reading the queue: a registration from now on schedules the next run
    hook->prewarm();
  };

#if defined(__APPLE__)
  runInBackground(std::move(run), QOS_CLASS_UTILITY);
#else
  std::thread(std::move(run)).detach();
#endif
}

// One registration: `props` is { light: { backgroundColor: 4294967295 }, dark: { ... } } (colours as processColor numbers or CSS
// strings); `styleId` tags it so views of one style share the parsed form; `renderTheme` is the theme the view rendered with,
// passed only on a node's first attach.
void HybridShadewind::registerOne(
    jsi::Runtime& rt,
    UIManager& ui,
    const jsi::Value& nodeValue,
    const jsi::Value& propsValue,
    const jsi::Value& styleIdValue,
    const jsi::Value& renderThemeValue) {
  auto node = Bridging<std::shared_ptr<const ShadowNode>>::fromJs(rt, nodeValue);

  if (!node) {
    throw jsi::JSError(rt, "Shadewind.register: not a ShadowNode");
  }

  const SurfaceId surface = node->getFamily().getSurfaceId();
  const int64_t styleId = styleIdValue.isNumber() ? static_cast<int64_t>(styleIdValue.asNumber()) : -1;
  auto style = _engine.cachedStyle(styleId, surface);

  if (!style) {
    if (!propsValue.isObject()) {
      throw jsi::JSError(rt, "Shadewind.register: per-theme props must be an object");
    }

    auto themes = propsValue.asObject(rt);
    auto names = themes.getPropertyNames(rt);
    PropsByTheme props;

    for (size_t i = 0; i < names.size(rt); i++) {
      auto name = names.getValueAtIndex(rt, i).asString(rt);

      props.emplace_back(name.utf8(rt), jsi::dynamicFromValue(rt, themes.getProperty(rt, name)));
    }

    style = _engine.buildStyle(styleId, surface, std::move(props), *ui.getContextContainer());
  }

  if (renderThemeValue.isString()) {
    const auto renderTheme = renderThemeValue.asString(rt).utf8(rt);

    _engine.registerView(*node, std::move(style), &renderTheme);
  } else {
    _engine.registerView(*node, std::move(style), nullptr);
  }
}

// register(shadowNode, propsByTheme, styleId?, renderTheme?)
jsi::Value HybridShadewind::registerNode(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 2) {
    throw jsi::JSError(rt, "Shadewind.register(node, propsByTheme, styleId?, renderTheme?) expects at least 2 arguments");
  }

  if (auto* ui = attachedUIManager(rt)) {
    const jsi::Value undefined;

    registerOne(rt, *ui, args[0], args[1], count > 2 ? args[2] : undefined, count > 3 ? args[3] : undefined);
    schedulePrewarm();
  }

  return jsi::Value::undefined();
}

// registerMany(nodes, propsByTheme[], styleIds[], renderThemes[]): the registrations of one React commit in one call, then the
// one commit that themes views registered with another theme's props (a re-attach, a switch between render and attach).
jsi::Value HybridShadewind::registerMany(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 4 || !args[0].isObject() || !args[1].isObject() || !args[2].isObject() || !args[3].isObject()) {
    throw jsi::JSError(rt, "Shadewind.registerMany(nodes, propsByTheme, styleIds, renderThemes) expects 4 arrays");
  }

  auto* ui = attachedUIManager(rt);

  if (ui == nullptr) {
    return jsi::Value::undefined();
  }

  auto nodes = args[0].asObject(rt).asArray(rt);
  auto props = args[1].asObject(rt).asArray(rt);
  auto ids = args[2].asObject(rt).asArray(rt);
  auto themes = args[3].asObject(rt).asArray(rt);
  const size_t length = nodes.size(rt);

  for (size_t i = 0; i < length; i++) {
    registerOne(rt, *ui, nodes.getValueAtIndex(rt, i), props.getValueAtIndex(rt, i), ids.getValueAtIndex(rt, i), themes.getValueAtIndex(rt, i));
  }

  if (length > 0) {
    schedulePrewarm();
  }

  if (_engine.hook().hasStale()) {
    commitTick(*ui);
  }

  return jsi::Value::undefined();
}

jsi::Value HybridShadewind::unregisterNode(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1) {
    return jsi::Value::undefined();
  }

  if (auto node = Bridging<std::shared_ptr<const ShadowNode>>::fromJs(rt, args[0])) {
    _engine.unregisterView(*node);
  }

  return jsi::Value::undefined();
}

// Debug: for every registered view compare the background colour of
//   - the node in the committed shadow tree,
//   - what UIKit holds for it (iOS),
//   - what the current theme gives it.
// Views inside a `display: none` subtree (a frozen screen) are counted apart: the hook themes them when they show.
jsi::Value HybridShadewind::inspect(jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
  const std::string theme = getTheme();
  auto binding = UIManagerBinding::getBinding(rt);
  auto report = jsi::Object(rt);

  report.setProperty(rt, "theme", jsi::String::createFromUtf8(rt, theme));

  if (!binding || theme.empty()) {
    return report;
  }

  auto& ui = binding->getUIManager();
  const auto views = _engine.hook().registered();

  const auto expectedOf = [](const std::shared_ptr<const TypedDelta>& delta) -> int64_t {
    const auto* value = delta ? delta->raw.get_ptr("backgroundColor") : nullptr;

    return value != nullptr && value->isNumber() ? static_cast<int64_t>(static_cast<uint32_t>(value->asInt())) : -1;
  };

  std::vector<Tag> tags;

  tags.reserve(views.size());

  for (const auto& view : views) {
    tags.push_back(view.family->getTag());
  }

  const auto uikit = readBackgroundsOnMain(tags);
  int inTree = 0, notInTree = 0, hidden = 0, treeMatches = 0, nativeMatches = 0, layerMatches = 0;
  std::string samples;
  std::string stale;

  for (size_t i = 0; i < views.size(); i++) {
    const auto& view = views[i];
    const int64_t expected = expectedOf(view.delta);
    int64_t treeBg = -1;
    bool found = false;
    bool underHidden = false;
    const Props* treeProps = nullptr;

    ui.getShadowTreeRegistry().visit(view.family->getSurfaceId(), [&](const ShadowTree& tree) {
      auto root = tree.getCurrentRevision().rootShadowNode;
      auto ancestors = view.family->getAncestors(*root);

      if (ancestors.empty()) {
        return;
      }

      const ShadowNode* node = root.get();

      for (const auto& ancestor : ancestors) {
        underHidden = underHidden || isHidden(*node);
        node = node->getChildren()[ancestor.second].get();
      }

      underHidden = underHidden || isHidden(*node);
      found = true;
      treeProps = node->getProps().get();

      if (node->getTraits().check(ShadowNodeTraits::Trait::ViewKind)) {
        // every ConcreteViewShadowNode carries ViewProps (static_assert in ConcreteViewShadowNode); no RTTI across RN's libraries
        const auto* viewProps = static_cast<const ViewProps*>(node->getProps().get());

        if (viewProps->backgroundColor) {
          treeBg = colorBits(viewProps->backgroundColor);
        }
      }
    });

    if (!found) {
      ++notInTree;
      continue;
    }

    ++inTree;

    if (underHidden) {
      ++hidden;
      continue;
    }

    if (treeBg == expected) {
      ++treeMatches;
    } else if (stale.size() < 700) {
      stale += "tag " + std::to_string(tags[i]) + " " + _engine.hook().describe(view.family.get(), treeProps) + "; ";
    }

    const auto& u = uikit[i];

    nativeMatches += u.viewColor == expected ? 1 : 0;
    layerMatches += u.layerColor == expected ? 1 : 0;

    if (samples.size() < 600 && (u.viewColor != expected || u.layerColor != expected || treeBg != expected)) {
      samples += "tag " + std::to_string(tags[i]) + ": tree=" + std::to_string(treeBg) + " view=" + std::to_string(u.viewColor) +
          " layer=" + std::to_string(u.layerColor) + " expected=" + std::to_string(expected) + "; ";
    }
  }

  report.setProperty(rt, "registered", static_cast<double>(views.size()));
  report.setProperty(rt, "inTree", inTree);
  report.setProperty(rt, "notInTree", notInTree);
  report.setProperty(rt, "hidden", hidden);
  report.setProperty(rt, "treeMatchesExpected", treeMatches);
  report.setProperty(rt, "nativePropsMatchExpected", nativeMatches); // UIView.backgroundColor == expected (iOS)
  report.setProperty(rt, "layerMatchesExpected", layerMatches);
  report.setProperty(rt, "samples", jsi::String::createFromUtf8(rt, samples));
  report.setProperty(rt, "stale", jsi::String::createFromUtf8(rt, stale));

  return report;
}

// Kept for API compatibility: registerMany flushes what this used to. A view registered alone (register) is themed here.
jsi::Value HybridShadewind::flushPending(jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
  if (auto* ui = attachedUIManager(rt); ui != nullptr && _engine.hook().hasStale()) {
    commitTick(*ui);
  }

  return jsi::Value::undefined();
}

// Kept for API compatibility: it used to warm the pre-built nodes of the next switch, which are gone.
jsi::Value HybridShadewind::prepare(jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
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

static css::ClassMerge gClassMerge;
// Uniwind's class resolution from the table src/uniwind/styleTable.ts builds; JS thread only (loaded and read there)
static css::StyleResolver gStyleResolver;
static css::StyleResolver::Result gResolved;

// ---- class merge: zero-copy argument reads ------------------------------------------------------------------------------
//
// jsi::String::utf8() allocates a std::string per argument. getStringData() hands out Hermes' own ASCII bytes (or UTF-16),
// which are copied into one stack buffer here. Non-ASCII input is not handled natively: the caller gets `undefined` and uses
// the JS reference, so output can never differ from it.
namespace {

constexpr size_t kMergeMaxArgs = 16;
constexpr size_t kMergeBuffer = 4096;

struct MergeInput {
  char buffer[kMergeBuffer];
  size_t length = 0;
  std::string_view views[kMergeMaxArgs];
  size_t count = 0;
};

bool readAscii(jsi::Runtime& rt, const jsi::Value* args, size_t count, MergeInput& in) {
  if (count > kMergeMaxArgs) {
    return false;
  }

  for (size_t i = 0; i < count; i++) {
    if (!args[i].isString()) {
      return false;
    }

    const size_t begin = in.length;
    bool ok = true;
    auto cb = [&](bool ascii, const void* data, size_t num) {
      if (num > kMergeBuffer - in.length) {
        ok = false;
        return;
      }

      if (ascii) {
        std::memcpy(in.buffer + in.length, data, num);
      } else {
        const auto* p = static_cast<const char16_t*>(data);

        for (size_t k = 0; k < num; k++) {
          if (p[k] > 127) {
            ok = false;
            return;
          }

          in.buffer[in.length + k] = static_cast<char>(p[k]);
        }
      }

      in.length += num;
    };

    args[i].getString(rt).getStringData(rt, cb);

    if (!ok) {
      return false;
    }

    in.views[i] = std::string_view(in.buffer + begin, in.length - begin);
  }

  in.count = count;

  return true;
}

jsi::Value mergeAscii(jsi::Runtime& rt, const jsi::Value* args, size_t count) {
  if (!gClassMerge.loaded()) {
    return jsi::Value::undefined();
  }

  MergeInput in;

  if (!readAscii(rt, args, count, in)) {
    return jsi::Value::undefined();
  }

  std::string out;

  if (!gClassMerge.merge(in.views, in.count, out)) {
    return jsi::Value::undefined();
  }

  // single argument that came back unchanged: hand the very same JS string back, no allocation
  if (in.count == 1 && out.size() == in.views[0].size()) {
    return jsi::Value(rt, args[0]);
  }

  return jsi::String::createFromAscii(rt, out.data(), out.size());
}

// isPressed / isFocused / isDisabled: only a boolean equals Uniwind's `true` / `false` (resolveStyles compares with !==)
css::StyleResolver::Tri triOf(const jsi::Value& value) {
  if (!value.isBool()) {
    return css::StyleResolver::Tri::Unset;
  }

  return value.getBool() ? css::StyleResolver::Tri::True : css::StyleResolver::Tri::False;
}

jsi::Value styleValue(jsi::Runtime& rt, const css::StyleResolver::Item& item) {
  if (!item.value) {
    return jsi::Value(item.number);
  }

  if (item.value->undefined) {
    return jsi::Value::undefined();
  }

  const folly::dynamic& value = item.value->value;

  switch (value.type()) {
    case folly::dynamic::DOUBLE:
      return jsi::Value(value.getDouble());
    case folly::dynamic::INT64:
      return jsi::Value(static_cast<double>(value.getInt()));
    case folly::dynamic::STRING:
      return jsi::String::createFromUtf8(rt, value.getString());
    case folly::dynamic::BOOL:
      return jsi::Value(value.getBool());
    case folly::dynamic::NULLT:
      return jsi::Value::null();
    default:
      return jsi::valueFromDynamic(rt, value);
  }
}

// (className, theme, screenWidth, isPressed, isFocused, isDisabled) -> Uniwind's resolveStyles result
// ({ styles, dependencies, dependencySum, hasDataAttributes }), or undefined: resolve it with Uniwind's JS
jsi::Value resolveClasses(jsi::Runtime& rt, const jsi::Value* args, size_t count) {
  MergeInput in;

  if (count < 3 || !gStyleResolver.loaded() || !args[2].isNumber() || !readAscii(rt, args, 2, in)) {
    return jsi::Value::undefined();
  }

  const int theme = gStyleResolver.themeIndex(in.views[1]);
  const auto state = [&](size_t i) { return i < count ? triOf(args[i]) : css::StyleResolver::Tri::Unset; };

  if (!gStyleResolver.resolve(in.views[0], theme, args[2].getNumber(), state(3), state(4), state(5), gResolved)) {
    return jsi::Value::undefined();
  }

  jsi::Object styles(rt);

  for (const auto& item : gResolved.styles) {
    styles.setProperty(rt, gStyleResolver.propertyName(item.property).c_str(), styleValue(rt, item));
  }

  jsi::Array dependencies(rt, gResolved.dependencies.size());

  for (size_t i = 0; i < gResolved.dependencies.size(); i++) {
    dependencies.setValueAtIndex(rt, i, gResolved.dependencies[i]);
  }

  jsi::Object result(rt);

  result.setProperty(rt, "styles", std::move(styles));
  result.setProperty(rt, "dependencies", std::move(dependencies));
  result.setProperty(rt, "dependencySum", static_cast<double>(gResolved.dependencySum));
  result.setProperty(rt, "hasDataAttributes", false);

  return result;
}

} // namespace

// loadStyleTable(json): installs the table src/uniwind/styleTable.ts builds from Uniwind's stylesheet, and the plain global host
// function `__swResolve` (see resolveClasses) in this runtime. Returns { ok, classes, unsupported, error? }.
jsi::Value HybridShadewind::loadStyleTable(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1 || !args[0].isString()) {
    throw jsi::JSError(rt, "Shadewind.loadStyleTable(json) expects a string");
  }

  std::string error;
  const bool ok = gStyleResolver.load(args[0].asString(rt).utf8(rt), &error);
  jsi::Object result(rt);

  result.setProperty(rt, "ok", ok);
  result.setProperty(rt, "classes", static_cast<double>(gStyleResolver.classCount()));
  result.setProperty(rt, "unsupported", static_cast<double>(gStyleResolver.unsupportedCount()));

  if (!ok) {
    result.setProperty(rt, "error", jsi::String::createFromUtf8(rt, error));
  }

  if (ok) {
    rt.global().setProperty(
        rt, "__swResolve",
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, "__swResolve"), 6,
            [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
              return resolveClasses(runtime, a, n);
            }));
  } else {
    rt.global().setProperty(rt, "__swResolve", jsi::Value::undefined());
  }

  return result;
}

// resolveClasses(className, theme, screenWidth, isPressed?, isFocused?, isDisabled?): the Nitro raw-method form of __swResolve
jsi::Value HybridShadewind::resolveStyleClasses(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  return resolveClasses(rt, args, count);
}

// loadClassTable(text): installs the generated tailwind-merge conflict table (tools/cn-table). Returns true when usable.
// It also installs a plain global host function (`__swCn`) that skips Nitro's method wrapper (measured ~23% faster).
jsi::Value HybridShadewind::loadClassTable(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1 || !args[0].isString()) {
    throw jsi::JSError(rt, "Shadewind.loadClassTable(text) expects a string");
  }

  const bool ok = gClassMerge.load(args[0].asString(rt).utf8(rt));

  if (ok) {
    rt.global().setProperty(
        rt, "__swCn",
        jsi::Function::createFromHostFunction(
            rt, jsi::PropNameID::forAscii(rt, "__swCn"), 0,
            [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
              return mergeAscii(runtime, a, n);
            }));
  }

  return jsi::Value(ok);
}

// mergeClasses(a, b, ...): twMerge(clsx(a, b, ...)) for string arguments, or undefined when a token is not in the table
// (the caller then uses the JS reference). This is the Nitro raw-method variant with zero-copy reads.
jsi::Value HybridShadewind::mergeClasses(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  return mergeAscii(rt, args, count);
}

// configure(names): declares the themes in order (a new JS session). Returns { maxThemes, ok } (ok false: more names than slots).
jsi::Value HybridShadewind::configure(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1 || !args[0].isObject() || !args[0].asObject(rt).isArray(rt)) {
    throw jsi::JSError(rt, "Shadewind.configure(names) expects an array of theme names");
  }

  auto array = args[0].asObject(rt).asArray(rt);
  std::vector<std::string> names;

  for (size_t i = 0; i < array.size(rt); i++) {
    names.push_back(array.getValueAtIndex(rt, i).asString(rt).utf8(rt));
  }

  const bool ok = _engine.configure(names);
  jsi::Object result(rt);

  result.setProperty(rt, "maxThemes", ThemeHook::maxThemes());
  result.setProperty(rt, "ok", ok);

  return result;
}

// setTheme(name, strategy?, transition?) applies `name` to every registered view without touching React.
// strategy: 'hookAsync' (default; the commit runs off the JS thread on iOS) | 'hook' (the commit runs on the JS thread)
// transition: { type: 'fade' | 'blur', durationMs } animates from a snapshot of the old screen (ThemeTransition.hpp); absent: instant.
jsi::Value HybridShadewind::setTheme(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 1 || !args[0].isString()) {
    throw jsi::JSError(rt, "Shadewind.setTheme(name) expects a string");
  }

  const auto name = args[0].asString(rt).utf8(rt);
  bool async = true;
  // 'hookDeferred': the commit runs here, on the JS thread, but its mount is queued on the RuntimeScheduler (the same queue
  // React's own commit of this task uses), so both reach the screen in one update.
  bool deferred = false;

  if (count > 1 && args[1].isString()) {
    const auto requested = args[1].asString(rt).utf8(rt);

    if (requested != "hook" && requested != "hookAsync" && requested != "hookDeferred") {
      throw jsi::JSError(rt, "Shadewind.setTheme: unknown strategy '" + requested + "' (hook, hookAsync, hookDeferred)");
    }

    async = requested == "hookAsync";
    deferred = requested == "hookDeferred";
  }

  bool animated = false;
  double transitionMs = 0;
  auto preset = ThemeTransitionPreset::Fade;

  if (count > 2 && args[2].isObject()) {
    auto options = args[2].asObject(rt);
    const auto type = options.getProperty(rt, "type");

    const auto typeName = type.isString() ? type.asString(rt).utf8(rt) : std::string();

    if (typeName == "fade") {
      preset = ThemeTransitionPreset::Fade;
    } else if (typeName == "blur") {
      preset = ThemeTransitionPreset::Blur;
    } else {
      throw jsi::JSError(rt, "Shadewind.setTheme: unknown transition type (fade, blur)");
    }

    const auto duration = options.getProperty(rt, "durationMs");

    transitionMs = duration.isNumber() ? duration.asNumber() : 250;
    animated = transitionMs > 0;
  }

  auto* ui = attachedUIManager(rt);

  if (ui == nullptr) {
    throw jsi::JSError(rt, "Shadewind.setTheme: Fabric UIManager is not available (New Architecture only)");
  }

  const auto t0 = Clock::now();

  _engine.setTheme(name);

  if (animated) {
    // The mount hook is what tells the transition the new theme is on screen. Registered on first use, once per UIManager.
    if (_state.transitionContainer.lock() != ui->getContextContainer()) {
      ui->registerMountHook(_state.transition);
      _state.transitionContainer = ui->getContextContainer();
    }

    // after the epoch changed (that is the one to wait for), before any commit (the snapshot is queued ahead of the mount)
    _state.transition.begin(preset, transitionMs);
  }

#if defined(__APPLE__)
  if (async) {
    // The commit (walk + clone + mount hand-off) runs off the JS thread. The hook keeps working for every commit.
    // weak: a GCD thread must never drop the last reference of the binding (it owns a jsi::Function)
    std::weak_ptr<UIManagerBinding> weakBinding = UIManagerBinding::getBinding(rt);

    runInBackground(
        [weakBinding, t0]() {
          auto locked = weakBinding.lock();

          if (!locked) {
            return;
          }

          const auto c0 = Clock::now();

          // `mountSynchronously = false` would queue a rendering update on the RuntimeScheduler, whose queues only the JS thread
          // may touch. `true` is what React Native uses for commits made off the JS thread: on iOS the mount itself is still
          // dispatched asynchronously to the main queue.
          commitTick(locked->getUIManager(), true);
          gLastAsyncCommitMs = ms(c0, Clock::now());

          // The commit queued its mount on the main queue; this block queues behind it, so when it runs the views are mounted
          // (the next vsync presents them). That is the time from the setTheme call to the screen update.
          runOnMain([t0]() { gLastVisualMs = ms(t0, Clock::now()); });
        },
        QOS_CLASS_USER_INTERACTIVE);

    // the stats and the commit time are those of the previous run (this one finishes after the call returns)
    return timingsOf(rt, _engine.hook().stats(), gLastAsyncCommitMs.load(), ms(t0, Clock::now()));
  }
#else
  (void)async; // Android commits on the JS thread for now
#endif

  // `mountSynchronously = false` queues the mount with RuntimeScheduler::scheduleRenderingUpdate (Scheduler.cpp), which only the JS
  // thread may call, inside a task: this runs in the JS thread's setTheme call, which is one. Same on both platforms: React Native's
  // Scheduler decides this, not the platform. Without it Android mounted the engine's commit on its own, ahead of React's commit
  // (views React re-renders, e.g. LinearGradient colours, changed 4-8 frames after the engine-bound ones).
  commitTick(*ui, !deferred);

  const double elapsed = ms(t0, Clock::now());

  return timingsOf(rt, _engine.hook().stats(), elapsed, elapsed);
}

} // namespace margelo::nitro::shadewind
