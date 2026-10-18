#pragma once

// SHADEWIND_DEV_TOOLS: what exists only to inspect and measure the engine: inspect() and what feeds it, the timings setTheme returns,
// the main-thread busy probe and the Paragraph clone counters. 1 in debug builds (the podspec's Debug configuration, Android's
// CMake Debug build type), 0 in release, where none of it is compiled: no timers or counters in the commit hook, no extra
// main-thread hop after a hookAsync switch, no inspect / resetMainBusy / mainBusyMs methods.
//
// A release build that is used to measure (example-real, example) opts in: SHADEWIND_DEV_TOOLS=1 in the environment of
// `pod install` (iOS), shadewindDevTools=true in the app's gradle.properties (Android).
//
// Set for the whole library, never per file: ThemeHook.hpp is a header and its classes must look the same everywhere. Only
// statements and function bodies are switched, never data members.
#ifndef SHADEWIND_DEV_TOOLS
#define SHADEWIND_DEV_TOOLS 0
#endif
