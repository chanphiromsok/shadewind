// Correctness of the engine inside React Native's renderer. Each test drives React-like commits (mount, re-render, Suspense hide /
// reveal as freezeOnBlur does it, theme switches) and reads the committed tree: what would be mounted on screen.

#include "App.hpp"

#include <gtest/gtest.h>

using namespace harness;

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
