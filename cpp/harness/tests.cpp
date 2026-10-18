// Correctness of the engine inside React Native's renderer. Each test drives React-like commits (mount, re-render, Suspense hide /
// reveal as freezeOnBlur does it, theme switches) and reads the committed tree: what would be mounted on screen.

#include "App.hpp"
#include "ThemeTransition.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <cstring>
#include <set>

#ifdef RN_SERIALIZABLE_STATE
#include <react/featureflags/ReactNativeFeatureFlagsDefaults.h>

#include <cstdlib>
#include <string>
#endif

using namespace harness;

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

  const auto stats = engine.stats();

  EXPECT_EQ(stats.applied, 12) << "only the visible screen's views are cloned";
  EXPECT_EQ(stats.hidden, 1);
  EXPECT_EQ(app.lastThemeCommit().stale, 0);
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
  EXPECT_EQ(engine.stats().missNotOurs, 0) << "props rebuilt for a view React did not change";
  EXPECT_EQ(app.lastReactCommit().stale, 0);
}

TEST_F(Current, UnrelatedReactCommitSkipsUnchangedSubtrees) {
  App app(engine, kThemes, "light");
  auto* leaf = app.plainView({}, folly::dynamic::object("height", 1));

  app.mount({screen(app, styles, 200), leaf});
  app.rerender(*leaf, folly::dynamic::object("height", 2));

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
  App app(engine, kThemes, "light");

  app.mount({screen(app, styles, 5)});
  app.setTheme("dark");

  EXPECT_TRUE(drained(engine).empty());
}

TEST_F(Current, DiagnosticsReportMountsWithTheLiveCount) {
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
  App app(engine, kThemes, "light");
  RootCloner cloner;

  app.react().addHook(cloner);

  auto& hook = engine.engine().hook();

  hook.watchMounts();
  app.mount({screen(app, styles, 5)});
  app.setTheme("dark");

  EXPECT_FALSE(hook.rootCarries(mountedRoot(app).get(), hook.epoch()));
}
