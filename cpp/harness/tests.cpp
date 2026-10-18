// Correctness of the engine inside React Native's renderer. Each test drives React-like commits (mount, re-render, Suspense hide /
// reveal as freezeOnBlur does it, theme switches) and reads the committed tree: what would be mounted on screen.

#include "App.hpp"
#include "ThemeTransition.hpp"

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define HARNESS_ASAN 1
#endif
#endif
#ifndef HARNESS_ASAN
#define HARNESS_ASAN 0
#endif

#if HARNESS_ASAN
#include <sanitizer/allocator_interface.h>
#else
#include <malloc.h>
#endif

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <thread>

#include <algorithm>
#include <cstring>
#include <set>

#ifdef RN_SERIALIZABLE_STATE
#include <react/featureflags/ReactNativeFeatureFlagsDefaults.h>

#include <cstdlib>
#include <string>
#endif

using namespace harness;

// A release-configuration harness (HARNESS_RELEASE_CONFIG) has no hook stats and no diagnostics recorder, as a release app: a test
// that reads them stops there, explicitly, instead of passing on zeros. What it checked before that point (colours) still ran.
#define NEEDS_DEV_TOOLS()                                                                                              \
  if (!SHADEWIND_DEV_TOOLS)                                                                                            \
  GTEST_SKIP() << "the hook's stats exist only with SHADEWIND_DEV_TOOLS"
#define NEEDS_DIAGNOSTICS()                                                                                            \
  if (!SHADEWIND_DIAGNOSTICS)                                                                                          \
  GTEST_SKIP() << "no diagnostics recorder in this configuration"

#ifdef RN_SERIALIZABLE_STATE
namespace {

// Android build (HARNESS_ANDROID_STATE): HARNESS_ANDROID_PROPS picks how React Native's mounting layer sends props to the Java
// views (App::sentToJava): unset = 0.86's defaults (each update's rawProps), `accumulated` (the rawProps diff), `reconciliation`
// (the typed props diff of View)
struct AndroidPropsFlags : facebook::react::ReactNativeFeatureFlagsDefaults {
  std::string mode;

  explicit AndroidPropsFlags(std::string m) : mode(std::move(m)) {}

  bool enableAccumulatedUpdatesInRawPropsAndroid() override {
    return mode == "accumulated";
  }

  bool enablePropsUpdateReconciliationAndroid() override {
    return mode == "reconciliation";
  }
};

const bool kAndroidFlags = [] {
  if (const char* mode = std::getenv("HARNESS_ANDROID_PROPS")) {
    facebook::react::ReactNativeFeatureFlags::override(std::make_unique<AndroidPropsFlags>(mode));
  }

  return true;
}();

} // namespace
#endif

namespace {

const std::vector<std::string> kThemes{"light", "dark"};

struct Styles {
  Style card = makeStyle(1, "backgroundColor", {{"light", 0xFFFFFFFF}, {"dark", 0xFF1C1C1E}});
  Style label = makeStyle(2, "color", {{"light", 0xFF111111}, {"dark", 0xFFF2F2F7}});
  Style header = makeStyle(3, "backgroundColor", {{"light", 0xFFF2F2F7}, {"dark", 0xFF2C2C2E}});
};

// card: themed View > [themed Text, plain View > plain View]
std::vector<Instance*> cards(App& app, const Styles& styles, int count) {
  std::vector<Instance*> result;

  for (int i = 0; i < count; i++) {
    auto* inner = app.plainView({app.plainView({}, folly::dynamic::object("height", 4))}, folly::dynamic::object("padding", 2));

    result.push_back(app.view(styles.card, {app.text(styles.label, "card " + std::to_string(i)), inner}, folly::dynamic::object("padding", 8)));
  }

  return result;
}

Instance* screen(App& app, const Styles& styles, int count) {
  auto children = cards(app, styles, count);

  children.insert(children.begin(), app.view(styles.header, {app.text(styles.label, "header")}));

  return app.plainView(std::move(children), folly::dynamic::object("flex", 1));
}

int revision(App& app) {
  return static_cast<int>(app.react().tree().getCurrentRevision().number);
}

} // namespace

class Current : public ::testing::Test {
protected:
  CurrentEngine engine;
  Styles styles;
};

#ifdef RN_SERIALIZABLE_STATE
// Colours reach JS-side as CSS strings. On Android the number the engine stores goes to Java as a Double narrowed with toInt(),
// which saturates above INT32_MAX: an unsigned ARGB turned every opaque colour into 0x7FFFFFFF (white at 50% alpha).
TEST(AndroidColours, CssStringsSurviveJavaDoubleToInt) {
  folly::dynamic props = folly::dynamic::object("backgroundColor", "#111111")("color", "rgb(255, 255, 255)")("borderColor", "#00000080");

  sw::normalizeColorStrings(props);

  EXPECT_EQ(harness::javaColourInt(props["backgroundColor"]), static_cast<int32_t>(0xFF111111u));
  EXPECT_EQ(harness::javaColourInt(props["color"]), static_cast<int32_t>(0xFFFFFFFFu));
  EXPECT_EQ(harness::javaColourInt(props["borderColor"]), static_cast<int32_t>(0x80000000u));
}
#endif

TEST_F(Current, MountNeedsNoExtraCommit) {
  App app(engine, kThemes, "light");
  const int before = revision(app);

  app.mount({screen(app, styles, 20)});

  EXPECT_EQ(revision(app), before + 1) << "the flush after mount committed again";
  EXPECT_EQ(app.check().stale, 0);
  EXPECT_EQ(app.check().visible, 1 + 1 + 20 * 2);
}

TEST_F(Current, SwitchThemesEveryVisibleViewWithoutTextLayout) {
  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 20)});

  const int measures = app.react().measures();

  for (const auto* theme : {"dark", "light", "dark"}) {
    app.setTheme(theme);
    EXPECT_EQ(app.lastThemeCommit().stale, 0) << theme;
    EXPECT_EQ(app.lastThemeCommit().visible, 42);
  }

  EXPECT_EQ(app.react().measures(), measures) << "a colour switch laid text out again";
}

TEST_F(Current, FrozenScreenRevealsWithoutStaleFrame) {
  App app(engine, kThemes, "light");
  auto* home = screen(app, styles, 10);
  auto* settings = screen(app, styles, 3);

  app.mount({home, settings});
  app.hide(*home); // navigate to settings: freezeOnBlur suspends home
  app.setTheme("dark");
  app.reveal(*home); // back

  EXPECT_EQ(app.lastReactCommit().stale, 0) << "the reveal commit itself shows the old theme";
  EXPECT_EQ(app.check().stale, 0);
  EXPECT_EQ(app.check().visible, 22 + 8);
}

TEST_F(Current, FrozenScreenRevealsWithoutStaleFrameAfterAsyncSwitch) {
  App app(engine, kThemes, "light");
  auto* home = screen(app, styles, 10);
  auto* settings = screen(app, styles, 3);

  app.mount({home, settings});
  app.hide(*home);
  app.setThemeAsync("dark"); // iOS default: the switch commits off the JS thread
  EXPECT_EQ(app.lastThemeCommit().stale, 0);
  app.reveal(*home);

  EXPECT_EQ(app.lastReactCommit().stale, 0) << "the reveal commit itself shows the old theme";
  EXPECT_EQ(app.check().stale, 0);
}

TEST_F(Current, ReactCommitsAfterAsyncSwitchStopRecloning) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 50), leaf});
  app.setThemeAsync("dark");

  // the first React commit brings React's pre-switch nodes back (an off-thread clone does not repoint React's handles): the hook
  // themes them again on the JS thread, which repoints the handles, so the next commit has nothing to do
  app.rerender(*leaf, folly::dynamic::object("height", 2));
  EXPECT_EQ(app.lastReactCommit().stale, 0);
  NEEDS_DEV_TOOLS();
  EXPECT_EQ(engine.stats().applied, 102);

  app.rerender(*leaf, folly::dynamic::object("height", 3));
  EXPECT_EQ(engine.stats().applied, 0);
  EXPECT_LT(engine.stats().visited, 10);
}

TEST_F(Current, RapidTogglesWhileFrozen) {
  App app(engine, kThemes, "light");
  auto* home = screen(app, styles, 10);
  auto* account = screen(app, styles, 3);

  app.mount({home, account});

  for (int round = 0; round < 3; round++) {
    app.hide(*home);
    app.setTheme("dark");
    app.setTheme("light");
    app.setTheme(round % 2 == 0 ? "dark" : "light");
    app.reveal(*home);
    EXPECT_EQ(app.lastReactCommit().stale, 0) << "round " << round;
    EXPECT_EQ(app.check().stale, 0) << "round " << round;
  }
}

TEST_F(Current, SwitchSkipsFrozenScreens) {
  App app(engine, kThemes, "light");
  auto* visible = screen(app, styles, 5);
  auto* frozen = screen(app, styles, 50);

  app.mount({visible, frozen});
  app.hide(*frozen);
  app.setTheme("dark");
  EXPECT_EQ(app.lastThemeCommit().stale, 0);
  NEEDS_DEV_TOOLS();

  const auto stats = engine.stats();

  EXPECT_EQ(stats.applied, 12) << "only the visible screen's views are cloned";
  EXPECT_EQ(stats.hidden, 1);
}

TEST_F(Current, ReactCommitAfterSwitchReusesProps) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));
  auto* main = screen(app, styles, 10);

  app.mount({main, leaf});
  app.setTheme("dark");

  // React re-renders a themed card (its props are React's again), then an unrelated commit brings that same React node back
  auto* card = main->children[1];

  app.rerender(*card, folly::dynamic::object("padding", 9));
  EXPECT_EQ(app.lastReactCommit().stale, 0);

  app.rerender(*leaf, folly::dynamic::object("height", 2));
  EXPECT_EQ(app.lastReactCommit().stale, 0);
  NEEDS_DEV_TOOLS();
  EXPECT_EQ(engine.stats().missNotOurs, 0) << "props rebuilt for a view React did not change";
}

TEST_F(Current, SwitchBackReusesTheRenderedPropsWithoutACopy) {
  // React rendered the card with the current theme: those props are that theme's, so prewarm must not build a copy of them and a
  // switch back must put React's own object back
  App app(engine, kThemes, "light");
  auto* card = app.view(styles.card, {}, folly::dynamic::object("padding", 8));

  app.mount({app.plainView({card})});

  const auto rendered = card->node()->getProps();

  engine.prewarm();
  app.setTheme("dark");

  ASSERT_NE(card->node()->getProps(), rendered) << "the switch did not reach the card (or its handle)";

  app.setTheme("light");

  EXPECT_EQ(card->node()->getProps(), rendered) << "switching back used a copy of the props React rendered";
  EXPECT_EQ(app.check().stale, 0);
}

TEST_F(Current, SetThemeDoesNotWaitForABackgroundWalk) {
  // iOS hookAsync: the switch's commit walks on a background thread while holding the hook's lock. A setTheme meanwhile (a rapid
  // toggle) must publish its theme and return, not wait for that walk; the commit after it applies the new theme.
  using Clock = std::chrono::steady_clock;
  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 6000)});
  engine.engine().setTheme("dark"); // nothing committed yet: the next commit themes 12002 views, a long walk
  app.assumeTheme("dark");

  std::atomic<bool> started{false}, done{false};
  Clock::time_point walkStart, walkEnd;
  std::thread background([&] {
    walkStart = Clock::now();
    started = true;
    app.react().commitTick();
    walkEnd = Clock::now();
    done = true;
  });

  while (!started) {
  }

  std::this_thread::sleep_for(std::chrono::milliseconds(3));

  const bool walkingBefore = !done;
  const auto t0 = Clock::now();

  engine.engine().setTheme("light");

  const auto latency = Clock::now() - t0;
  const bool walkingAfter = !done;

  background.join();

  ASSERT_TRUE(walkingBefore) << "inconclusive: the background walk had ended before setTheme was called";
  EXPECT_TRUE(walkingAfter) << "setTheme returned only after the background walk";
  EXPECT_LT(latency, (walkEnd - walkStart) / 10) << "setTheme took "
                                                 << std::chrono::duration<double, std::micro>(latency).count() << " us";

  // that walk themed dark; the commit after the second switch themes light
  app.assumeTheme("light");
  app.react().commitTick();
  EXPECT_EQ(app.check().stale, 0);
}

TEST_F(Current, ViewRegisteredAfterAnUncommittedSwitchIsFiledUnderThatTheme) {
  // setTheme publishes the theme; nothing commits before a view React rendered with it registers. The registration must count
  // as that theme's (its props become that theme's cached props), not as the theme of the last commit.
  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 2)});
  app.assumeTheme("dark");

  auto* late = app.view(styles.card, {}, folly::dynamic::object("padding", 4)); // React rendered it dark

  app.mountCommit({app.plainView({late})}); // React's commit: the engine is still on light
  engine.engine().setTheme("dark");         // published, nothing committed since
  app.attachRefs();                         // registers `late`
  app.react().commitTick();
  app.setTheme("light");

  EXPECT_EQ(app.lastThemeCommit().stale, 0) << "dark props were filed as the light theme's";
}

namespace {

// Every node's layout metrics, depth first: what the mounting layer would get.
void collectLayout(const ShadowNode& node, std::vector<facebook::react::LayoutMetrics>& out) {
  if (const auto* layoutable = dynamic_cast<const facebook::react::LayoutableShadowNode*>(&node)) {
    out.push_back(layoutable->getLayoutMetrics());
  }

  for (const auto& child : node.getChildren()) {
    collectLayout(*child, out);
  }
}

// The same React operations with or without the engine: theme switches between them, layout changes outside and inside re-themed
// views, views mounted after a switch, and a React re-render of a themed view while a switch is not committed yet (the hook then
// themes a node React has just cloned, which Yoga has not configured). Fractional sizes and left/right styles make the result
// depend on the pixel density and the RTL swap.
std::vector<facebook::react::LayoutMetrics> layoutAfterSwitches(Engine& engine, Screen display) {
  Styles styles;
  App app(engine, kThemes, "light", display);
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1.3)("marginLeft", 4.7));
  auto* main = screen(app, styles, 20);
  auto sides = [](double left) { return folly::dynamic::object("paddingLeft", left)("marginRight", 2.35)("borderLeftWidth", 1.5); };

  app.mount({main, leaf});
  app.rerender(*main->children[2], sides(6.1));
  app.setTheme("dark");
  app.rerender(*leaf, folly::dynamic::object("height", 5.45)("marginLeft", 3.2)); // a layout change elsewhere
  app.rerender(*main->children[1], sides(13.3));                                  // and inside a re-themed card
  app.setTheme("light");
  app.mount({main, screen(app, styles, 5), leaf}); // new themed views after the switches
  app.engine().setTheme("dark");                   // a switch React commits before the engine does (hookAsync)
  app.assumeTheme("dark");
  app.rerender(*main->children[2], sides(9.7));
  app.append(*main, app.plainView({app.plainView({}, folly::dynamic::object("height", 3.3))}, folly::dynamic::object("padding", 1.7)));
  app.engine().setTheme("light");
  app.assumeTheme("light");
  app.append(*main->children[3], app.plainView({}, folly::dynamic::object("height", 2.9)("marginLeft", 0.7)));
  app.rerender(*main->children[3], sides(2.2));
  app.setTheme("dark");
  app.rerender(*leaf, folly::dynamic::object("height", 9.15)("marginLeft", 1.1));

  std::vector<facebook::react::LayoutMetrics> layout;

  collectLayout(*app.react().committed(), layout);

  return layout;
}

void expectSameLayout(Screen display) {
  NoEngine none;
  CurrentEngine current;
  const auto expected = layoutAfterSwitches(none, display);
  const auto actual = layoutAfterSwitches(current, display);

  ASSERT_EQ(actual.size(), expected.size());

  int differences = 0;

  for (size_t i = 0; i < expected.size(); i++) {
    if (!(actual[i] == expected[i]) && ++differences <= 5) {
      ADD_FAILURE() << "node " << i << ": frame " << actual[i].frame.origin.x << "," << actual[i].frame.origin.y << " "
                    << actual[i].frame.size.width << "x" << actual[i].frame.size.height << ", expected "
                    << expected[i].frame.origin.x << "," << expected[i].frame.origin.y << " " << expected[i].frame.size.width
                    << "x" << expected[i].frame.size.height;
    }
  }

  EXPECT_EQ(differences, 0);
  EXPECT_GT(expected.size(), 100u);
}

} // namespace

// Colour-only clones keep Yoga's "configured" flag of the node they copy (keepYogaConfigured in ThemeHook.hpp), so the next
// layout does not clone and configure them again. The layout must still be exactly what React Native computes without the engine.
TEST(Layout, ThemeSwitchesLeaveTheLayoutOfPlainReactNative) {
  expectSameLayout({});
}

TEST(Layout, ThemeSwitchesLeaveTheLayoutOfPlainReactNativeAtAFractionalPixelDensity) {
  expectSameLayout({.pointScaleFactor = 2.625});
}

TEST(Layout, ThemeSwitchesLeaveTheLayoutOfPlainReactNativeInRtl) {
  expectSameLayout({.pointScaleFactor = 3, .rtl = true});
}

TEST_F(Current, UnrelatedReactCommitSkipsUnchangedSubtrees) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 200), leaf});
  app.rerender(*leaf, folly::dynamic::object("height", 2));
  EXPECT_EQ(app.lastReactCommit().stale, 0);
  NEEDS_DEV_TOOLS();

  const auto stats = engine.stats();

  EXPECT_LT(stats.visited, 10) << "the hook walked unchanged subtrees";
  EXPECT_GT(stats.skipped, 0);
}

TEST_F(Current, PressedViewIsLeftToReact) {
  App app(engine, kThemes, "light");
  auto* main = screen(app, styles, 3);

  app.mount({main});

  auto* card = main->children[1];

  app.setTheme("dark");
  app.press(*card, folly::dynamic::object("backgroundColor", argb(0xFF0000FF)));

  EXPECT_EQ(app.react().committed()->getChildren()[0]->getChildren()[1]->getProps(), card->node()->getProps())
      << "the engine painted over the pressed style";

  app.release(*card);
  EXPECT_EQ(app.check().stale, 0);
}

TEST_F(Current, ThemeChangeBeforeRefAttachIsAppliedByTheFlush) {
  App app(engine, kThemes, "light");
  auto* main = screen(app, styles, 5);

  // React rendered with light; the theme changes before the refs attach (a switch from a layout effect, say)
  engine.setTheme("dark");
  app.mount({main});

  // the views were registered with light props while the engine is on dark: the flush must have themed them
  app.assumeTheme("dark");
  EXPECT_EQ(app.check().stale, 0);
  EXPECT_EQ(app.check().visible, 12);
}

TEST_F(Current, UnmountedViewsAndStylesAreDropped) {
  App app(engine, kThemes, "light");
  std::vector<std::unique_ptr<Style>> distinct;

  for (int round = 0; round < 20; round++) {
    std::vector<Instance*> views;

    for (int i = 0; i < 50; i++) {
      distinct.push_back(std::make_unique<Style>(
          makeStyle(1000 + round * 50 + i, "backgroundColor", {{"light", 0xFF000000u + i}, {"dark", 0xFF00FF00u + i}})));
      views.push_back(app.view(*distinct.back()));
    }

    app.mount({app.plainView(std::move(views))});
    app.collectGarbage();
  }

  // 20 rounds of 50 views with their own styles, each round unmounting the last. The hook drops expired views as it grows and
  // every 128 commits; a style is dropped from the cache once no view uses it, when the cache next grows.
  EXPECT_LE(engine.engine().hook().size(), 1024u + 50u);

  for (int i = 0; i < 130; i++) {
    app.react().commitTick();
  }

  EXPECT_EQ(engine.engine().hook().size(), 50u);

  for (int round = 0; round < 2; round++) {
    std::vector<Instance*> views;

    for (int i = 0; i < 50; i++) {
      distinct.push_back(std::make_unique<Style>(
          makeStyle(5000 + round * 50 + i, "backgroundColor", {{"light", 0xFF000000u + i}, {"dark", 0xFF00FF00u + i}})));
      views.push_back(app.view(*distinct.back()));
    }

    app.mount({app.plainView(std::move(views))});
    app.collectGarbage();
  }

  EXPECT_LE(engine.engine().cachedStyles(), 150u) << "styles of unmounted views stayed cached";
}

namespace {

// Bytes the process has allocated and not freed (ASan's own count under AddressSanitizer, glibc's otherwise).
size_t liveHeapBytes() {
#if HARNESS_ASAN
  return __sanitizer_get_current_allocated_bytes();
#else
  return mallinfo2().uordblks;
#endif
}

} // namespace

TEST_F(Current, RemountLeavesTheOldScreenToPrewarm) {
  // A remount registers right after the unmount: freeing the old screen's entries (and their prewarmed props) there was a third
  // of the registration's cost on the JS thread. They wait for the next prewarm, which runs off the JS thread.
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();

  app.mount({screen(app, styles, 300)}); // 602 views; with the next 602 the registration crosses the purge threshold (1024)
  engine.prewarm();
  app.mount({});
  app.collectGarbage();
  app.mount({screen(app, styles, 300)});

  EXPECT_EQ(hook.pendingRelease(), 602u) << "the old screen was freed while registering";
  EXPECT_EQ(hook.size(), 602u);
  engine.prewarm();
  EXPECT_EQ(hook.pendingRelease(), 0u);
}

TEST_F(Current, RemountsWhilePrewarmRunsOnAnotherThread) {
  // iOS and Android prewarm off the JS thread: entries are freed there while the JS thread registers the next screen
  // (ThreadSanitizer checks this in the TSan build).
  App app(engine, kThemes, "light");
  std::atomic<bool> stop{false};
  std::thread prewarm([&] {
    while (!stop) {
      engine.prewarm();
    }
  });

  for (int i = 0; i < 20; i++) {
    app.mount({screen(app, styles, 300)});
    app.mount({});
    app.collectGarbage();
  }

  app.mount({screen(app, styles, 300)});
  stop = true;
  prewarm.join();

  app.setTheme("dark");
  EXPECT_EQ(app.check().stale, 0);
  EXPECT_EQ(app.check().visible, 602);
}

TEST_F(Current, MemoryStaysFlatAcrossMountSwitchUnmountCycles) {
  // Smart pointers stop memory from being lost, not from piling up: a cache or a map that keeps what unmounted views left
  // behind is a leak too. Mount, prewarm, switch twice and unmount, over and over (with the mount recording of a transition on):
  // after a warm-up, the live heap and the engine's registry must stop growing.
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();

  hook.watchMounts();

  const auto cycle = [&] {
    app.mount({screen(app, styles, 50)});
    engine.prewarm();
    app.setTheme("dark");
    app.setTheme("light");
    app.mount({});
    app.collectGarbage();
  };

  for (int i = 0; i < 600; i++) {
    cycle(); // warm-up: the registry (about 1000 dead views before a purge) and the style cache reach their purge thresholds
  }

  const size_t heapBefore = liveHeapBytes();
  const size_t entriesBefore = hook.size();

  for (int i = 0; i < 300; i++) {
    cycle();
  }

  const size_t heapAfter = liveHeapBytes();

  EXPECT_LE(hook.size(), std::max<size_t>(entriesBefore, 1024u + 102u)) << "the registry kept growing";
  EXPECT_LT(heapAfter, heapBefore + 64 * 1024)
      << "live heap grew by " << (heapAfter - heapBefore) << " bytes over 300 cycles of 102 themed views";
}

// ---- development diagnostics (shadewind/diagnostics)

namespace {

using Kind = sw::DiagnosticEvent::Kind;

std::vector<sw::DiagnosticEvent> drained(CurrentEngine& engine, uint64_t* dropped = nullptr) {
  auto [events, lost] = engine.engine().hook().diagnostics().drain();

  if (dropped != nullptr) {
    *dropped = lost;
  }

  return std::move(events);
}

int countOf(const std::vector<sw::DiagnosticEvent>& events, Kind kind) {
  return static_cast<int>(std::count_if(events.begin(), events.end(), [kind](const auto& e) { return e.kind == kind; }));
}

} // namespace

TEST_F(Current, DiagnosticsRecordNothingWhileOff) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 5)});
  app.setTheme("dark");

  EXPECT_TRUE(drained(engine).empty());
}

TEST_F(Current, DiagnosticsReportMountsWithTheLiveCount) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");

  engine.engine().hook().diagnostics().setFlags(sw::diagnostics::kMounts);
  app.mount({screen(app, styles, 5)});

  const auto events = drained(engine);

  ASSERT_EQ(countOf(events, Kind::Registered), 12); // header + its label, 5 cards with a label each
  ASSERT_EQ(events.size(), 12u) << "only mounts were asked for";

  std::set<facebook::react::Tag> tags;

  for (size_t i = 0; i < events.size(); i++) {
    EXPECT_EQ(events[i].live, i + 1);
    EXPECT_GT(events[i].tag, 0);
    EXPECT_TRUE(events[i].styleId >= 1 && events[i].styleId <= 3) << events[i].styleId;
    EXPECT_TRUE(std::strcmp(events[i].component, "View") == 0 || std::strcmp(events[i].component, "Paragraph") == 0);
    tags.insert(events[i].tag);
  }

  EXPECT_EQ(tags.size(), 12u);
}

TEST_F(Current, DiagnosticsReportAThemeSwitchPerView) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 5)});
  engine.engine().hook().diagnostics().setFlags(sw::diagnostics::kUpdates);
  app.setTheme("dark");

  const auto events = drained(engine);

  ASSERT_EQ(events.size(), 1u);
  ASSERT_EQ(events[0].kind, Kind::Commit);
  EXPECT_EQ(events[0].theme, "dark");
  EXPECT_TRUE(events[0].themeChanged);
  EXPECT_EQ(events[0].live, 12u);
  ASSERT_EQ(events[0].updates.size(), 12u);

  for (const auto& update : events[0].updates) {
    EXPECT_TRUE(update.themeChange);

    if (std::strcmp(update.component, "Paragraph") == 0) {
      EXPECT_EQ(update.styleId, 2);
      EXPECT_TRUE(update.props.count("color"));
      EXPECT_TRUE(update.textWithoutLayout) << "a colour switch laid text out again";
    } else {
      EXPECT_TRUE(update.props.count("backgroundColor"));
      EXPECT_FALSE(update.textWithoutLayout);
    }
  }

  // a commit that themes nothing is not reported
  app.react().commitTick();
  EXPECT_TRUE(drained(engine).empty());
}

TEST_F(Current, DiagnosticsReportUnmountsOnceReleased) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");

  engine.engine().hook().diagnostics().setFlags(sw::diagnostics::kMounts | sw::diagnostics::kUnmounts);
  app.mount({screen(app, styles, 5)});
  drained(engine);

  app.mount({screen(app, styles, 2)}); // the first screen unmounts
  app.collectGarbage();                // React and Hermes release it
  app.react().commitTick();

  const auto events = drained(engine);

  EXPECT_EQ(countOf(events, Kind::Registered), 6);
  EXPECT_EQ(countOf(events, Kind::Unregistered), 12);
  ASSERT_FALSE(events.empty());
  EXPECT_EQ(events.back().live, 6u) << "the count must drop to the views still mounted";
  EXPECT_EQ(engine.engine().hook().size(), 6u);
}

TEST_F(Current, DiagnosticsReportAnUnbindApart) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");
  auto* main = screen(app, styles, 3);

  app.mount({main});
  engine.engine().hook().diagnostics().setFlags(sw::diagnostics::kUnmounts);
  app.press(*main->children[1], folly::dynamic::object("backgroundColor", argb(0xFF0000FF)));

  const auto events = drained(engine);

  ASSERT_EQ(events.size(), 1u);
  EXPECT_EQ(events[0].kind, Kind::Unbound);
  EXPECT_EQ(events[0].tag, main->children[1]->node()->getTag());
  EXPECT_EQ(events[0].live, 7u);
}

TEST_F(Current, DiagnosticsAreBoundedAndDropTheOldest) {
  NEEDS_DIAGNOSTICS();

  App app(engine, kThemes, "light");
  auto& log = engine.engine().hook().diagnostics();

  log.setFlags(sw::diagnostics::kMounts);
  app.mount({screen(app, styles, 2100)}); // 4202 registrations, more than the log keeps

  uint64_t dropped = 0;
  const auto events = drained(engine, &dropped);

  EXPECT_EQ(events.size(), sw::diagnostics::kCapacity);
  EXPECT_EQ(dropped, 4202u - sw::diagnostics::kCapacity);
  EXPECT_EQ(events.back().live, 4202u) << "the newest are kept";

  app.setTheme("dark");
  log.setFlags(0);
  EXPECT_TRUE(drained(engine).empty()) << "turning diagnostics off drops what was not read";
}

// ---- the same scenarios on the 44eb043 engine: the harness reproduces what this branch fixes

TEST(Baseline, RevealCommitShowsStaleFrame) {
  BaselineEngine engine;
  Styles styles;
  App app(engine, kThemes, "light");
  auto* home = screen(app, styles, 10);
  auto* settings = screen(app, styles, 3);

  app.mount({home, settings});
  app.hide(*home);
  app.setTheme("dark");
  app.reveal(*home);

  EXPECT_GT(app.lastReactCommit().stale, 0) << "expected the 44eb043 engine to show the old theme in the reveal commit";
  EXPECT_EQ(app.check().stale, 0) << "and to fix it in the flush commit after the refs re-attach";
}

// ---- Theme transition: knowing when the new theme is mounted (cpp/ThemeTransition.hpp, ThemeHook::rootCarries) ----
//
// The platform overlay is replaced by a log. A mount is simulated the way UIManager::reportMount does it: pull the transaction (that
// makes the revision the base one) and hand the base revision's root to the mount hook.

namespace margelo::nitro::shadewind {

std::vector<std::string>& transitionLog() {
  static std::vector<std::string> log;

  return log;
}

void themeTransitionBegin(uint64_t id, ThemeTransitionPreset, double) {
  transitionLog().push_back("begin " + std::to_string(id));
}

void themeTransitionRun(uint64_t id) {
  transitionLog().push_back("run " + std::to_string(id));
}

} // namespace margelo::nitro::shadewind

namespace {

RootShadowNode::Shared mountedRoot(App& app) {
  auto coordinator = app.react().tree().getMountingCoordinator();

  coordinator->pullTransaction();

  return coordinator->getBaseRevision().rootShadowNode;
}

// A commit hook that runs after the engine's and returns another root (a library that clones the root in its own hook)
class RootCloner final : public facebook::react::UIManagerCommitHook {
public:
  void commitHookWasRegistered(const facebook::react::UIManager&) noexcept override {}
  void commitHookWasUnregistered(const facebook::react::UIManager&) noexcept override {}

  RootShadowNode::Unshared shadowTreeWillCommit(
      const facebook::react::ShadowTree&,
      const RootShadowNode::Shared&,
      const RootShadowNode::Unshared& newRoot,
      const facebook::react::ShadowTreeCommitOptions&) noexcept override {
    return std::static_pointer_cast<RootShadowNode>(newRoot->ShadowNode::clone({}));
  }
};

const auto kNow = [] { return facebook::react::HighResTimeStamp::now(); };

} // namespace

TEST_F(Current, MountedRootCarriesTheEpochItWasCommittedFor) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();

  hook.watchMounts();
  app.mount({screen(app, styles, 5)});

  const auto lightRoot = mountedRoot(app);

  app.setTheme("dark"); // commits the theme; not mounted yet (the transaction was not pulled)

  const auto target = hook.epoch();

  EXPECT_FALSE(hook.rootCarries(lightRoot.get(), target)) << "the tree on screen still has the old theme";

  const auto darkRoot = mountedRoot(app);

  EXPECT_NE(darkRoot.get(), lightRoot.get());
  EXPECT_TRUE(hook.rootCarries(darkRoot.get(), target)) << "the root React Native reports is the one the hook returned";
  EXPECT_FALSE(hook.rootCarries(lightRoot.get(), target));
}

TEST_F(Current, MountedRootCarriesTheEpochAfterABackgroundCommit) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();

  hook.watchMounts();
  app.mount({screen(app, styles, 5)});
  app.setThemeAsync("dark"); // hookAsync on iOS: the commit runs on another thread

  EXPECT_TRUE(hook.rootCarries(mountedRoot(app).get(), hook.epoch()));
}

TEST_F(Current, NothingIsRecordedUntilATransitionAsksForIt) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();

  app.mount({screen(app, styles, 5)});
  app.setTheme("dark");

  EXPECT_FALSE(hook.rootCarries(mountedRoot(app).get(), 0)) << "the default path must not record mounts";
}

TEST_F(Current, TransitionFadesOnlyForTheMountThatShowsTheNewTheme) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();
  sw::ThemeTransition transition(hook);

  hook.watchMounts(); // begin() does it too; here the earlier tree must be on record with its older epoch
  app.mount({screen(app, styles, 5)});
  sw::transitionLog().clear();

  // what setTheme does: epoch first, then the transition (snapshot), then the commit
  engine.engine().setTheme("dark");
  app.assumeTheme("dark");
  transition.begin(sw::ThemeTransitionPreset::Fade, 250);

  const auto before = app.react().committed(); // the tree React Native still has mounted

  transition.shadowTreeDidMount(before, kNow()); // a mount report for an earlier commit

  EXPECT_EQ(sw::transitionLog(), (std::vector<std::string>{"begin 1"})) << "faded for a tree that still has the old theme";

  app.react().commitTick();

  transition.shadowTreeDidMount(mountedRoot(app), kNow());
  transition.shadowTreeDidMount(mountedRoot(app), kNow()); // a later report must not fade twice

  EXPECT_EQ(sw::transitionLog(), (std::vector<std::string>{"begin 1", "run 1"}));
}

TEST_F(Current, RapidTogglesFadeOnlyTheLastTransition) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();
  sw::ThemeTransition transition(hook);

  app.mount({screen(app, styles, 5)});
  sw::transitionLog().clear();

  for (const auto* theme : {"dark", "light", "dark"}) {
    engine.engine().setTheme(theme);
    transition.begin(sw::ThemeTransitionPreset::Fade, 250);
    app.assumeTheme(theme);
    app.react().commitTick();
  }

  transition.shadowTreeDidMount(mountedRoot(app), kNow());

  EXPECT_EQ(sw::transitionLog(), (std::vector<std::string>{"begin 1", "begin 2", "begin 3", "run 3"}));
  EXPECT_EQ(app.check().stale, 0) << "ends in the last theme";
}

TEST_F(Current, AnotherHookThatClonesTheRootDefeatsTheMountSignal) {
  // Documents the known limit: the pointer identity breaks, so the native 1 s failsafe is what ends the fade.
  RootCloner cloner; // before the app: its last commit (the fake React's teardown) still runs every hook
  App app(engine, kThemes, "light");

  app.react().addHook(cloner);

  auto& hook = engine.engine().hook();

  hook.watchMounts();
  app.mount({screen(app, styles, 5)});
  app.setTheme("dark");

  EXPECT_FALSE(hook.rootCarries(mountedRoot(app).get(), hook.epoch()));
}

// ---- 'hookDeferred': the switch rides the React commit it causes (sw::commitUnlessThemed is its low-priority fallback) ----
//
// A colour React renders (useResolveClassNames, useCSSVariable) changes in the React commit of the re-render Uniwind's subscribers
// cause. The bound views must change in that same commit, not in one of the engine's own before it.

TEST_F(Current, DeferredSwitchRidesTheNextReactCommit) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 10), leaf});

  const int before = revision(app);

  app.setThemeDeferred("dark");
  EXPECT_EQ(revision(app), before) << "the switch must not commit on its own";

  app.rerender(*leaf, folly::dynamic::object("height", 2)); // the re-render a theme subscriber makes
  EXPECT_EQ(app.lastReactCommit().stale, 0) << "the React commit itself must show the new theme";
  EXPECT_EQ(app.lastReactCommit().visible, 22);

  const int afterReact = revision(app);

  EXPECT_FALSE(sw::commitUnlessThemed(engine.engine().hook(), app.react().tree(), true));
  EXPECT_EQ(revision(app), afterReact) << "the fallback committed although React's commit carried the theme";
}

TEST_F(Current, DeferredSwitchCommitsWhenReactDoesNot) {
  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 10)});
  app.setThemeDeferred("dark");
  EXPECT_GT(app.check().stale, 0);

  EXPECT_TRUE(sw::commitUnlessThemed(engine.engine().hook(), app.react().tree(), true));
  EXPECT_EQ(app.check().stale, 0);
  EXPECT_FALSE(sw::commitUnlessThemed(engine.engine().hook(), app.react().tree(), true));
}

TEST_F(Current, DeferredRapidTogglesEndInTheLastTheme) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 10), leaf});
  app.setThemeDeferred("dark");
  app.setThemeDeferred("light");
  app.setThemeDeferred("dark");
  app.rerender(*leaf, folly::dynamic::object("height", 2));
  EXPECT_EQ(app.lastReactCommit().stale, 0);

  // a fallback per switch, all after React's commit: none commits
  for (int i = 0; i < 3; i++) {
    EXPECT_FALSE(sw::commitUnlessThemed(engine.engine().hook(), app.react().tree(), true));
  }

  // and one that React's commit did not carry (a switch after it) does
  app.setThemeDeferred("light");
  EXPECT_TRUE(sw::commitUnlessThemed(engine.engine().hook(), app.react().tree(), true));
  EXPECT_EQ(app.check().stale, 0);
}

TEST_F(Current, DeferredSwitchFadesWhenTheReactCommitIsMounted) {
  App app(engine, kThemes, "light");
  auto& hook = engine.engine().hook();
  sw::ThemeTransition transition(hook);
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 5), leaf});
  mountedRoot(app);
  sw::transitionLog().clear();

  app.setThemeDeferred("dark");
  transition.begin(sw::ThemeTransitionPreset::Fade, 250);
  app.rerender(*leaf, folly::dynamic::object("height", 2));
  transition.shadowTreeDidMount(mountedRoot(app), kNow());

  EXPECT_EQ(sw::transitionLog(), (std::vector<std::string>{"begin 1", "run 1"}));
}
