# Native harness

The engine (`cpp/ThemeHook.hpp`, `cpp/ThemeEngine.hpp`) running inside React Native 0.86.2's own C++ renderer: real `ShadowTree`
commits with the commit hook, Yoga layout, props parsing and Paragraph state, on the "cxx" platform, without an app, a simulator,
JSI or Hermes. A small stand-in for React's Fabric renderer (`FakeReact.hpp`) creates and clones nodes the way `UIManager` does,
keeps React's node handles the way `UIManagerBinding` does, and hides / reveals subtrees the way Suspense and Activity do
(`freezeOnBlur`).

It answers two questions without a device: is every view on screen in the right theme after each commit, and what does the
engine cost natively.

## Run

Docker (any machine):

```sh
docker build -f cpp/harness/Dockerfile -t shadewind-harness .    # from the repository root, about 2 minutes
docker run --rm shadewind-harness                                 # tests, then the benchmark
docker run --rm shadewind-harness build/harness_bench --runs 30   # benchmark only
```

Linux without Docker (Ubuntu 24.04: `clang cmake ninja-build libgoogle-glog-dev libdouble-conversion-dev libboost-dev
libgflags-dev libgtest-dev`):

```sh
cd cpp/harness
./fetch-deps.sh          # React Native from npm, folly / fmt / fast_float at the versions RN 0.86 pins
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
cmake --build build
build/harness_tests && build/harness_bench
```

On macOS use Docker: folly and glog from Homebrew do not match the versions React Native pins.

## What is in it

| File | |
|---|---|
| `FakeReact.hpp` | React's side: createNode / cloneNode, child sets from React's handles, `cloneHiddenInstance` (`display: none`), reveal, `completeRoot`, commits from the JS thread and from another thread |
| `Engines.hpp` | the engine as JS drives it, three arms: `none` (plain React Native), `baseline` (44eb043 and its JS ref policy, kept in `baseline/`), `current` (this branch) |
| `App.hpp` | themed views rendered with the current theme, refs attached after a commit and detached on hide, the JS microtask after each commit, and `check()`: every visible bound view must hold the current theme (props, and for text the drawn attributed string) |
| `tests.cpp` | correctness: mount, switches, freeze / reveal (sync and async switch), rapid toggles while frozen, React commits after a switch, pressed views, late registration, unmount clean-up |
| `class_merge_tests.cpp` | `css::ClassMerge` byte-for-byte against tailwind-merge 3.7.0 (`fixtures/classmerge`, regenerate with `generate.mjs`) |
| `bench.cpp` | native cost per arm, each arm in its own process: mount (commit, registrations), theme switch (sync and async), the React commits after a switch, frozen tabs and their reveal |

## Reading the benchmark

- Only native work is measured. React's render, the adapter hooks and Uniwind's style resolution run in JS and are not here; the
  registration column stands in for the JSI calls (one per view at 44eb043, one per commit now).
- `none` is the floor. Compare arms within one run; absolute numbers depend on the machine.
- The 44eb043 arm gets slower the longer it runs (its registry and prewarmed props for unmounted views live until a purge every
  128 commits), so its mount numbers grow with `--runs`.

## React Native facts this relies on (0.86.2, checked in the sources)

- React's Fabric renderer hides a suspended subtree with `cloneHiddenInstance`: a clone of the top host nodes with
  `display: none` in the parent's child set; on reveal the child set holds React's original node again. On hide it also detaches
  the refs of every host component in the subtree (`recursivelyTraverseDisappearLayoutEffects` -> `safelyDetachRef`).
- `UIManagerBinding` binds every node it hands to JS to its JS wrapper (`valueFromShadowNode(..., true)`). A clone made by
  anything but React on the JS thread repoints that wrapper to the clone (`ShadowNode::transferRuntimeShadowNodeReference`; the
  thread flag is set by `ReactInstance` before it runs JS). So the hook's clones on the JS thread become React's handles; clones
  on another thread (iOS `hookAsync`) do not, until the next React commit themes those views again on the JS thread.
- `ShadowTree::tryCommit` stores the root the commit hooks return as the committed root, which is what lets the hook recognise
  the previous tree and skip subtrees React did not change.
- A clone with new props or children loses Yoga's "configured" flag, and the next layout clones it again when its new parent does
  not own it (`configureYogaTree` -> `cloneChildInPlace`). That is the extra cost of the first React commit after a switch
  (`next React commit` row). Forcing layout in the switch commit would avoid it but costs far more with frozen tabs: Yoga's
  `zeroOutLayoutRecursively` clones every node of every `display: none` subtree on any root layout (that is also why an unrelated
  React commit costs about 8-11 ms with no engine at all in the tabs scenario).
