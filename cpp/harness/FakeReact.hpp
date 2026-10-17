#pragma once

// A stand-in for React's Fabric renderer: it creates and clones shadow nodes the way UIManager::createNode / cloneNode do, keeps
// its own node handles (fiber.stateNode.node) that only React operations update, builds child sets from them, hides a subtree the
// way React's Offscreen does (cloneHiddenInstance: a clone with `display: none` in the parent's child set) and commits through a
// real ShadowTree with every registered commit hook. Nothing here is engine code.

#include <react/featureflags/ReactNativeFeatureFlags.h>
#include <react/renderer/components/root/RootComponentDescriptor.h>
#include <react/renderer/components/text/ParagraphComponentDescriptor.h>
#include <react/renderer/components/text/RawTextComponentDescriptor.h>
#include <react/renderer/components/text/TextComponentDescriptor.h>
#include <react/renderer/components/view/ViewComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/mounting/MountingCoordinator.h>
#include <react/renderer/mounting/ShadowTree.h>
#include <react/renderer/mounting/ShadowTreeDelegate.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/uimanager/UIManagerCommitHook.h>
#include <react/utils/ContextContainer.h>

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

namespace harness {

using namespace facebook::react;

// Counts text measurements: a colour-only switch must not lay text out again.
class CountingTextLayoutManager : public TextLayoutManager {
public:
  using TextLayoutManager::TextLayoutManager;

  TextMeasurement measure(
      const AttributedStringBox& box,
      const ParagraphAttributes& paragraphAttributes,
      const TextLayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override {
    ++measures;

    auto result = TextLayoutManager::measure(box, paragraphAttributes, layoutContext, layoutConstraints);

    result.size = {.width = 80, .height = 20};

    return result;
  }

  mutable std::atomic<int> measures{0};
};

// The UIManager's part of a commit: run the commit hooks in order.
class Delegate final : public ShadowTreeDelegate {
public:
  RootShadowNode::Unshared shadowTreeWillCommit(
      const ShadowTree& tree,
      const RootShadowNode::Shared& oldRoot,
      const RootShadowNode::Unshared& newRoot,
      const ShadowTree::CommitOptions& options) const override {
    auto result = newRoot;

    for (auto* hook : hooks) {
      result = hook->shadowTreeWillCommit(tree, oldRoot, result, options);
    }

    return result;
  }

  void shadowTreeDidFinishTransaction(std::shared_ptr<const MountingCoordinator>, bool) const override {}
  void shadowTreeDidFinishReactCommit(const ShadowTree&) const override {}
  void shadowTreeDidPromoteReactRevision(const ShadowTree&) const override {}

  std::vector<UIManagerCommitHook*> hooks;
};

// One host instance as React holds it. `handle` is the native state of the JS object in fiber.stateNode.node: React replaces it
// when React clones the node, and React Native repoints it (ShadowNode::transferRuntimeShadowNodeReference) when something else
// clones the node on the JS thread, a commit hook included.
struct Instance {
  std::string type; // "View" | "Paragraph" | "RawText"
  std::shared_ptr<ShadowNodeWrapper> handle;
  std::shared_ptr<const ShadowNode> hiddenClone; // set while a Suspense/Offscreen boundary hides this subtree
  std::vector<Instance*> children;
  Instance* parent = nullptr;
  bool hidden = false;

  const std::shared_ptr<const ShadowNode>& node() const {
    return handle->shadowNode;
  }
};

class FakeReact {
public:
  explicit FakeReact(SurfaceId surface = 1) : surface_(surface) {
    // this thread is the JS thread: in a bridgeless app ReactInstance sets this before running JS (ReactInstance.cpp)
    ShadowNode::setUseRuntimeShadowNodeReferenceUpdateOnThread(true);

    context_ = std::make_shared<ContextContainer>();
    textLayout_ = std::make_shared<CountingTextLayoutManager>(context_);
    context_->insert("TextLayoutManager", std::static_pointer_cast<TextLayoutManager>(textLayout_));

    ComponentDescriptorParameters parameters{.eventDispatcher = {}, .contextContainer = context_, .flavor = nullptr};

    root_ = std::make_unique<RootComponentDescriptor>(parameters);
    view_ = std::make_unique<ViewComponentDescriptor>(parameters);
    paragraph_ = std::make_unique<ParagraphComponentDescriptor>(parameters);
    text_ = std::make_unique<TextComponentDescriptor>(parameters);
    rawText_ = std::make_unique<RawTextComponentDescriptor>(parameters);

    LayoutConstraints constraints;

    constraints.minimumSize = {.width = 390, .height = 844};
    constraints.maximumSize = {.width = 390, .height = 844};

    tree_ = std::make_unique<ShadowTree>(surface_, constraints, LayoutContext{}, delegate_, *context_);
    rootInstance_.type = "Root";
  }

  ~FakeReact() {
    tree_->commitEmptyTree();
  }

  std::shared_ptr<const ContextContainer> context() const {
    return context_;
  }

  void addHook(UIManagerCommitHook& hook) {
    delegate_.hooks.push_back(&hook);
  }

  SurfaceId surface() const {
    return surface_;
  }

  Instance& root() {
    return rootInstance_;
  }

  const ShadowTree& tree() const {
    return *tree_;
  }

  int measures() const {
    return textLayout_->measures.load();
  }

  // ---- render phase: create instances (UIManager::createNode). Children are appended before the parent node is created.

  Instance* view(folly::dynamic props, std::vector<Instance*> children = {}) {
    return create("View", *view_, std::move(props), std::move(children));
  }

  // <Text style={props}>{text}</Text>: a Paragraph with one RawText child
  Instance* text(folly::dynamic props, const std::string& content) {
    auto* raw = create("RawText", *rawText_, folly::dynamic::object("text", content), {});

    return create("Paragraph", *paragraph_, std::move(props), {raw});
  }

  // ---- commit phase

  // Mounts `children` under the root (replacing what was there) in one React commit.
  void mount(std::vector<Instance*> children) {
    for (auto* child : children) {
      child->parent = &rootInstance_;
    }

    rootInstance_.children = std::move(children);
    commitReact();
  }

  // React re-renders one host instance with new props (cloneNodeWithNewProps), and its ancestors with new child sets.
  void rerender(Instance& instance, const folly::dynamic& props) {
    setHandle(instance, cloneProps(*instance.node(), props));
    reparent(instance);
    commitReact();
  }

  // Suspense / Activity hides `instance` (react-freeze, freezeOnBlur): the parent's child set holds a `display: none` clone.
  void hide(Instance& instance) {
    instance.hidden = true;
    instance.hiddenClone = cloneProps(*instance.node(), folly::dynamic::object("display", "none"));
    reparent(instance);
    commitReact();
  }

  // Revealed again: the parent's child set holds React's own (old) node again.
  void reveal(Instance& instance) {
    instance.hidden = false;
    instance.hiddenClone = nullptr;
    reparent(instance);
    commitReact();
  }

  // A commit made by something other than React on the current tree (Shadewind's commitTick, RN's animation backend), on this
  // (the JS) thread.
  void commitTick() {
    tree_->commit(
        [](const RootShadowNode& oldRoot) { return std::static_pointer_cast<RootShadowNode>(oldRoot.ShadowNode::clone({})); },
        {.mountSynchronously = true});
  }

  // The same from another thread (Shadewind's hookAsync on iOS commits on a GCD queue): clones made there do not repoint
  // React's handles.
  void commitTickOffThread() {
    std::thread worker([this] { commitTick(); });

    worker.join();
  }

  // React's completeRoot: the root's child set from React's handles.
  void commitReact() {
    auto children = childSet(rootInstance_);

    tree_->commit(
        [&](const RootShadowNode& oldRoot) {
          return std::make_shared<RootShadowNode>(
              oldRoot, ShadowNodeFragment{.props = ShadowNodeFragment::propsPlaceholder(), .children = children});
        },
        {.enableStateReconciliation = true, .mountSynchronously = true, .source = ShadowTree::CommitSource::React});
  }

  // React drops the fibers (and Hermes the node wrappers) of unmounted instances: release every instance the root does not reach.
  // Returns the released ones so callers can forget them.
  std::vector<const Instance*> collectGarbage() {
    std::unordered_set<const Instance*> reachable;
    std::vector<const Instance*> stack{&rootInstance_};

    while (!stack.empty()) {
      const auto* instance = stack.back();

      stack.pop_back();
      reachable.insert(instance);

      for (const auto* child : instance->children) {
        stack.push_back(child);
      }
    }

    std::vector<const Instance*> released;
    std::vector<std::unique_ptr<Instance>> kept;

    for (auto& instance : instances_) {
      if (reachable.count(instance.get())) {
        kept.push_back(std::move(instance));
      } else {
        released.push_back(instance.get());
      }
    }

    instances_ = std::move(kept);

    return released; // dangling: for identity comparisons only
  }

  RootShadowNode::Shared committed() const {
    return tree_->getCurrentRevision().rootShadowNode;
  }

private:
  Instance* create(const char* type, const ComponentDescriptor& descriptor, folly::dynamic props, std::vector<Instance*> children) {
    PropsParserContext context{surface_, *context_};
    auto family = descriptor.createFamily({.tag = nextTag_, .surfaceId = surface_, .instanceHandle = nullptr});

    nextTag_ += 2;

    const auto parsed = descriptor.cloneProps(context, nullptr, RawProps(std::move(props)));
    const auto state = descriptor.createInitialState(parsed, family);
    auto list = std::make_shared<std::vector<std::shared_ptr<const ShadowNode>>>();

    for (auto* child : children) {
      list->push_back(child->node());
    }

    auto& instance = instances_.emplace_back(std::make_unique<Instance>());

    instance->type = type;
    setHandle(*instance, descriptor.createShadowNode(ShadowNodeFragment{.props = parsed, .children = list, .state = state}, family));
    instance->children = std::move(children);

    for (auto* child : instance->children) {
      child->parent = instance.get();
    }

    return instance.get();
  }

  // UIManager::cloneNode: React's own clones never transfer the runtime reference
  std::shared_ptr<const ShadowNode> cloneProps(const ShadowNode& node, const folly::dynamic& props) {
    PropsParserContext context{surface_, *context_};
    auto parsed = node.getComponentDescriptor().cloneProps(context, node.getProps(), RawProps(props));

    return node.getComponentDescriptor().cloneShadowNode(node, {.props = parsed, .runtimeShadowNodeReference = false});
  }

  // UIManagerBinding wraps every node it returns to JS and binds the wrapper to it (valueFromShadowNode(..., true))
  static void setHandle(Instance& instance, std::shared_ptr<const ShadowNode> node) {
    instance.handle = std::make_shared<ShadowNodeWrapper>(std::move(node));
    instance.handle->shadowNode->setRuntimeShadowNodeReference(instance.handle);
  }

  static std::shared_ptr<const std::vector<std::shared_ptr<const ShadowNode>>> childSet(const Instance& instance) {
    auto list = std::make_shared<std::vector<std::shared_ptr<const ShadowNode>>>();

    list->reserve(instance.children.size());

    for (const auto* child : instance.children) {
      list->push_back(child->hidden ? child->hiddenClone : child->node());
    }

    return list;
  }

  // React clones every ancestor of a changed instance with a new child set (cloneNodeWithNewChildren).
  void reparent(Instance& instance) {
    for (auto* parent = instance.parent; parent != nullptr && parent != &rootInstance_; parent = parent->parent) {
      const auto& node = *parent->node();

      setHandle(*parent, node.getComponentDescriptor().cloneShadowNode(node, {.children = childSet(*parent), .runtimeShadowNodeReference = false}));
    }
  }

  SurfaceId surface_;
  Tag nextTag_ = 3;
  std::shared_ptr<ContextContainer> context_;
  std::shared_ptr<CountingTextLayoutManager> textLayout_;
  std::unique_ptr<RootComponentDescriptor> root_;
  std::unique_ptr<ViewComponentDescriptor> view_;
  std::unique_ptr<ParagraphComponentDescriptor> paragraph_;
  std::unique_ptr<TextComponentDescriptor> text_;
  std::unique_ptr<RawTextComponentDescriptor> rawText_;
  Delegate delegate_;
  std::unique_ptr<ShadowTree> tree_;
  Instance rootInstance_;
  std::vector<std::unique_ptr<Instance>> instances_;
};

} // namespace harness
