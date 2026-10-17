#if !defined(__APPLE__)
#include "ShadewindNative.hpp"

#if defined(__ANDROID__)
#include <fbjni/fbjni.h>
#endif

namespace margelo::nitro::shadewind {

std::vector<UIKitBackground> readBackgroundsOnMain(const std::vector<facebook::react::Tag>& tags) {
  std::vector<UIKitBackground> result;

  result.reserve(tags.size());

  for (auto tag : tags) {
    result.push_back({tag, -1, -1});
  }

  return result;
}

#if defined(__ANDROID__)

namespace {

constexpr auto kOverlayClass = "com/margelo/nitro/shadewind/ThemeTransitionOverlay";

} // namespace

// The overlay is Kotlin (ThemeTransitionOverlay.kt). These are called from the JS thread and from the mount hook (UI thread), the
// latter noexcept: a Java exception must not become std::terminate, the transition just does not run.
void themeTransitionBegin(uint64_t id, ThemeTransitionPreset preset, double durationMs) {
  try {
    facebook::jni::ThreadScope scope;
    auto cls = facebook::jni::findClassStatic(kOverlayClass);
    auto begin = cls->getStaticMethod<void(jlong, jint, jdouble)>("begin");

    begin(cls, static_cast<jlong>(id), static_cast<jint>(preset), durationMs);
  } catch (...) {
  }
}

void themeTransitionRun(uint64_t id) {
  try {
    facebook::jni::ThreadScope scope;
    auto cls = facebook::jni::findClassStatic(kOverlayClass);
    auto run = cls->getStaticMethod<void(jlong)>("run");

    run(cls, static_cast<jlong>(id));
  } catch (...) {
  }
}

#else

void themeTransitionBegin(uint64_t, ThemeTransitionPreset, double) {}

void themeTransitionRun(uint64_t) {}

#endif

} // namespace margelo::nitro::shadewind
#endif
