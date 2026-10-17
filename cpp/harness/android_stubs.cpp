// React Native's Android configuration (RN_SERIALIZABLE_STATE) in the harness: what only Android's mounting layer calls (state and
// props handed to Java through JNI). The harness never crosses into Java: reaching an abort here is a harness bug.
//
// ParagraphState: Android's ParagraphState.cpp (platform/android), except getJNIReference, which hands Java the text layout that
// only Android's TextLayoutManager prepares (the harness lays text out with the generic one).

#include <fbjni/fbjni.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/graphics/configurePlatformColorCacheInvalidationHook.h>
#include <react/renderer/components/text/stateConversions.h>
#include <react/renderer/core/ConcreteState.h>

#include <cstdlib>

namespace facebook::react {

folly::dynamic ParagraphState::getDynamic() const {
  LOG(FATAL) << "ParagraphState may only be serialized to MapBuffer";
  std::abort();
}

MapBuffer ParagraphState::getMapBuffer() const {
  return toMapBuffer(*this);
}

jni::local_ref<jobject> ParagraphState::getJNIReference() const {
  std::abort();
}

} // namespace facebook::react

// the colour cache hook is installed by Android's Scheduler setup
namespace facebook::react {

void configurePlatformColorCacheInvalidationHook(std::function<void()>&& /*hook*/) {}

} // namespace facebook::react

// fbjni's library (an Android .so in the AAR): referenced by inline JNI wrappers that only run when state or props go to Java
namespace facebook::jni {

JNIEnv* Environment::current() {
  std::abort();
}

void throwPendingJniExceptionAsCppException() {
  std::abort();
}

void throwCppExceptionIf(bool condition) {
  if (condition) {
    std::abort();
  }
}

local_ref<JString> make_jstring(const char* /*utf8*/) {
  std::abort();
}

alias_ref<JClass> findClassStatic(const char* /*name*/) {
  std::abort();
}

} // namespace facebook::jni
