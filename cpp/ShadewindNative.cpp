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

// findClassStatic makes a global reference that is never released: look it up and resolve the methods once.
struct Overlay {
  facebook::jni::alias_ref<jclass> cls = facebook::jni::findClassStatic(kOverlayClass);
  facebook::jni::JStaticMethod<void(jlong, jint, jdouble)> begin = cls->getStaticMethod<void(jlong, jint, jdouble)>("begin");
  facebook::jni::JStaticMethod<void(jlong)> run = cls->getStaticMethod<void(jlong)>("run");
};

const Overlay& overlay() {
  static const Overlay instance; // after the thread is attached: both callers hold a ThreadScope

  return instance;
}

} // namespace

// The overlay is Kotlin (ThemeTransitionOverlay.kt). These are called from the JS thread and from the mount hook (UI thread), the
// latter noexcept: a Java exception must not become std::terminate, the transition just does not run.
void themeTransitionBegin(uint64_t id, ThemeTransitionPreset preset, double durationMs) {
  try {
    facebook::jni::ThreadScope scope;
    const auto& o = overlay();

    o.begin(o.cls, static_cast<jlong>(id), static_cast<jint>(preset), durationMs);
  } catch (...) {
  }
}

void themeTransitionRun(uint64_t id) {
  try {
    facebook::jni::ThreadScope scope;
    const auto& o = overlay();

    o.run(o.cls, static_cast<jlong>(id));
  } catch (...) {
  }
}

#else

void themeTransitionBegin(uint64_t, ThemeTransitionPreset, double) {}

void themeTransitionRun(uint64_t) {}

#endif

} // namespace margelo::nitro::shadewind
#endif
