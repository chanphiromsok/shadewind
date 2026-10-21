#pragma once

// React Native's headers carry warnings of their own, reported against whichever of our files first includes them. Wrap the includes
// of React Native's renderer headers in these two, so a build log shows ours only. Clang only: GCC has no such diagnostic.
//
//   -Wdocumentation-deprecated-sync: mounting/ShadowViewMutation.h documents `@deprecated` without the attribute.
#if defined(__clang__)
#define SHADEWIND_REACT_HEADERS_BEGIN \
  _Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \"-Wdocumentation-deprecated-sync\"")
#define SHADEWIND_REACT_HEADERS_END _Pragma("clang diagnostic pop")
#else
#define SHADEWIND_REACT_HEADERS_BEGIN
#define SHADEWIND_REACT_HEADERS_END
#endif
