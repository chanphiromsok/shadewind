# Native harness: the engine (cpp/ThemeHook.hpp) running inside React Native 0.86's own C++ renderer (ShadowTree commits, Yoga
# layout, props parsing, Paragraph state) on the "cxx" platform, without an app, a simulator or JSI. See README.md.
#
#   ./fetch-deps.sh && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
#   build/harness_tests && build/harness_bench

cmake_minimum_required(VERSION 3.20)
project(shadewind_harness CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# HARNESS_SANITIZE: AddressSanitizer (use after free, overflows), LeakSanitizer (memory never freed, reported at exit) and UBSan
# over the engine and React Native's renderer. UBSan's vptr check is left out: it needs the type info of classes the harness
# stubs (UIManager, EventBeat). Run with ASAN_OPTIONS=detect_leaks=1.
option(HARNESS_SANITIZE "build with AddressSanitizer, LeakSanitizer and UBSan" OFF)
if(HARNESS_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize=vptr -fno-sanitize-recover=undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined -fno-sanitize=vptr)
endif()

# HARNESS_TSAN: ThreadSanitizer (data races: the commit hook runs on the JS thread and on background threads). Its own build
# directory; not together with HARNESS_SANITIZE.
option(HARNESS_TSAN "build with ThreadSanitizer" OFF)
if(HARNESS_TSAN)
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer)
  add_link_options(-fsanitize=thread)
endif()

set(DEPS "${CMAKE_CURRENT_SOURCE_DIR}/.deps" CACHE PATH "fetch-deps.sh output")
set(RN "${DEPS}/react-native/ReactCommon")
set(ENGINE "${CMAKE_CURRENT_SOURCE_DIR}/..")

find_package(Threads REQUIRED)
find_package(GTest REQUIRED)

# ---- third party, the versions React Native 0.86 pins (fmt, folly, fast_float from source; glog, boost, double-conversion from the OS)

add_library(fmt STATIC "${DEPS}/fmt/src/format.cc" "${DEPS}/fmt/src/os.cc")
target_include_directories(fmt PUBLIC "${DEPS}/fmt/include")

set(FOLLY_DEFS FOLLY_NO_CONFIG=1 FOLLY_HAVE_CLOCK_GETTIME=1 FOLLY_CFG_NO_COROUTINES=1 FOLLY_MOBILE=1 FOLLY_HAVE_PTHREAD=1)

# the folly subset React Native's Android build compiles (ReactAndroid/src/main/jni/third-party/folly/CMakeLists.txt)
set(FOLLY_SRC
  Conv.cpp Demangle.cpp FileUtil.cpp Format.cpp ScopeGuard.cpp SharedMutex.cpp String.cpp Unicode.cpp
  concurrency/CacheLocality.cpp container/detail/F14Table.cpp detail/FileUtilDetail.cpp detail/Futex.cpp
  detail/SplitStringSimd.cpp detail/UniqueInstance.cpp hash/SpookyHashV2.cpp json/dynamic.cpp json/json_pointer.cpp
  json/json.cpp lang/CString.cpp lang/Exception.cpp lang/SafeAssert.cpp lang/ToAscii.cpp memory/detail/MallocImpl.cpp
  net/NetOps.cpp portability/SysUio.cpp synchronization/SanitizeThread.cpp synchronization/ParkingLot.cpp
  system/AtFork.cpp system/ThreadId.cpp)
if(HARNESS_SANITIZE OR HARNESS_TSAN)
  list(APPEND FOLLY_SRC memory/SanitizeLeak.cpp) # folly annotates for the sanitizers when it sees them
endif()
list(TRANSFORM FOLLY_SRC PREPEND "${DEPS}/folly/folly/")

add_library(folly_runtime STATIC ${FOLLY_SRC})
target_compile_definitions(folly_runtime PUBLIC ${FOLLY_DEFS})
target_compile_options(folly_runtime PRIVATE -Wno-sign-compare -w)
target_include_directories(folly_runtime PUBLIC "${DEPS}/folly" "${DEPS}/fast_float/include")
target_link_libraries(folly_runtime PUBLIC fmt glog double-conversion Threads::Threads)

# ---- React Native: Yoga and the renderer pieces a commit needs (cxx platform)

file(GLOB_RECURSE YOGA_SRC CONFIGURE_DEPENDS "${RN}/yoga/yoga/*.cpp")
add_library(yoga STATIC ${YOGA_SRC})
target_include_directories(yoga PUBLIC "${RN}/yoga")
target_compile_options(yoga PRIVATE -w)

set(RN_DIRS
  react/renderer/core react/renderer/graphics react/renderer/components/view react/renderer/components/root
  react/renderer/components/text react/renderer/components/scrollview react/renderer/attributedstring react/renderer/textlayoutmanager
  react/renderer/mounting react/renderer/mounting/internal react/renderer/telemetry react/renderer/debug react/renderer/css react/featureflags react/utils
  react/debug logger)
set(RN_SRC "${RN}/react/renderer/textlayoutmanager/platform/cxx/react/renderer/textlayoutmanager/TextLayoutManager.cpp"
  "${RN}/jsi/jsi/jsi.cpp" "${RN}/jsi/jsi/JSIDynamic.cpp"
  "${RN}/jsinspector-modern/tracing/PerformanceTracer.cpp" "${RN}/jsinspector-modern/tracing/ConsoleTimeStamp.cpp"
  "${RN}/jsinspector-modern/tracing/TraceEventSerializer.cpp" "${RN}/jsinspector-modern/tracing/TraceEventGenerator.cpp"
  "${RN}/jsinspector-modern/network/CdpNetwork.cpp" "${RN}/jsinspector-modern/network/HttpUtils.cpp" "${RN}/oscompat/OSCompatPosix.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/rn_stubs.cpp")

# Android's configuration of the renderer: RN_SERIALIZABLE_STATE gives every Props the `rawProps` dynamic that Android's mounting
# layer sends to the Java views (the engine keeps it in step with its themed props). It needs fbjni's headers (FBJNI_INCLUDE, from
# the fbjni AAR React Native pins) and a JDK's JNI headers; nothing calls JNI (android_stubs.cpp).
option(HARNESS_ANDROID_STATE "build React Native's renderer and the engine as Android does (RN_SERIALIZABLE_STATE)" OFF)
set(FBJNI_INCLUDE "${DEPS}/fbjni/include" CACHE PATH "fbjni headers (prefab/modules/fbjni/include of fbjni-<version>.aar)")

# React Native's platform code for colours, views and text: Android's with this option (its Color is an int32, its ParagraphState
# serializes to a MapBuffer), the generic one otherwise. Text layout stays generic either way: Android's measures in Java.
set(PLATFORM_OF_GRAPHICS cxx)
set(PLATFORM_OF_VIEW_TEXT cxx)

if(HARNESS_ANDROID_STATE)
  find_package(JNI REQUIRED COMPONENTS JVM)
  set(PLATFORM_OF_GRAPHICS android)
  set(PLATFORM_OF_VIEW_TEXT android)
  list(APPEND RN_DIRS react/renderer/mapbuffer)
  list(APPEND RN_SRC "${CMAKE_CURRENT_SOURCE_DIR}/android_stubs.cpp"
    "${RN}/react/renderer/components/view/platform/android/react/renderer/components/view/HostPlatformViewProps.cpp"
    "${RN}/react/renderer/components/text/platform/android/react/renderer/components/text/HostPlatformParagraphProps.cpp")
endif()

foreach(dir ${RN_DIRS})
  file(GLOB dir_src CONFIGURE_DEPENDS "${RN}/${dir}/*.cpp")
  list(APPEND RN_SRC ${dir_src})
endforeach()

# EventBeat drives the JS runtime scheduler, which a harness has no use for
list(REMOVE_ITEM RN_SRC "${RN}/react/renderer/core/EventBeat.cpp")

add_library(rn_renderer STATIC ${RN_SRC})
# HttpUtils.h uses uint16_t without <cstdint> (libc++ pulls it in transitively, libstdc++ does not)
set_source_files_properties("${RN}/jsinspector-modern/network/HttpUtils.cpp" PROPERTIES COMPILE_OPTIONS "-include;cstdint")
target_include_directories(rn_renderer PUBLIC
  "${RN}"
  "${RN}/react/renderer/graphics/platform/${PLATFORM_OF_GRAPHICS}"
  "${RN}/react/renderer/components/view/platform/${PLATFORM_OF_VIEW_TEXT}"
  "${RN}/react/renderer/components/text/platform/${PLATFORM_OF_VIEW_TEXT}"
  "${RN}/react/renderer/textlayoutmanager/platform/cxx"
  "${RN}/react/renderer/components/scrollview/platform/cxx"
  "${RN}/react/utils/platform/cxx"
  "${RN}/jsi"
  "${RN}/callinvoker"
  "${RN}/runtimeexecutor"
  "${RN}/reactperflogger"
  "${RN}/jsinspector-modern"
  "${RN}/oscompat")
target_compile_definitions(rn_renderer PUBLIC LOG_TAG="ReactNative")

if(HARNESS_ANDROID_STATE)
  # ANDROID: React Native's own Android-only code (colour conversions for Java); not __ANDROID__, which would select Bionic paths
  # in folly and glog
  target_compile_definitions(rn_renderer PUBLIC RN_SERIALIZABLE_STATE ANDROID)
  # Android's HostPlatformColor.h uses uint8_t without <cstdint> (the NDK's libc++ pulls it in transitively)
  target_compile_options(rn_renderer PUBLIC -include cstdint)
  target_include_directories(rn_renderer PUBLIC "${FBJNI_INCLUDE}" ${JNI_INCLUDE_DIRS})
endif()
target_compile_options(rn_renderer PRIVATE -w)
target_link_libraries(rn_renderer PUBLIC yoga folly_runtime glog atomic)

# ---- the harness

add_library(harness_support INTERFACE)
target_include_directories(harness_support INTERFACE "${ENGINE}" "${CMAKE_CURRENT_SOURCE_DIR}")
# the development diagnostics recorder, as the app's Debug builds compile it (cpp/Diagnostics.hpp)
# HARNESS_RELEASE_CONFIG: the engine as a release build compiles it (no recorder, no dev tools); tests that read what only those
# provide skip themselves. Default: both in, as in a debug build.
option(HARNESS_RELEASE_CONFIG "build the engine as in a release app (SHADEWIND_DIAGNOSTICS=0, SHADEWIND_DEV_TOOLS=0)" OFF)
if(HARNESS_RELEASE_CONFIG)
  target_compile_definitions(harness_support INTERFACE SHADEWIND_DIAGNOSTICS=0 SHADEWIND_DEV_TOOLS=0)
else()
  target_compile_definitions(harness_support INTERFACE SHADEWIND_DIAGNOSTICS=1 SHADEWIND_DEV_TOOLS=1)
endif()
target_link_libraries(harness_support INTERFACE rn_renderer)

add_executable(harness_tests tests.cpp class_merge_tests.cpp style_resolver_tests.cpp)
target_link_libraries(harness_tests PRIVATE harness_support GTest::gtest_main)
target_compile_definitions(harness_tests PRIVATE FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")

add_executable(harness_bench bench.cpp)
target_link_libraries(harness_bench PRIVATE harness_support)


# The class resolver's JSI glue (cpp/ResolveGlue.hpp) inside a real Hermes runtime: parity with Uniwind and a bench (hermes/glue.cpp).
# Optional: HERMES_DIR is a checkout of the Hermes version React Native pins (sdks/.hermesv1version), HERMES_BUILD its CMake build
# with the `hermesvm` target built. Uses Hermes' own JSI, not React Native's copy (rn_renderer is not linked).
set(HERMES_DIR "" CACHE PATH "Hermes checkout (facebook/hermes at the tag React Native pins)")
set(HERMES_BUILD "" CACHE PATH "Hermes build directory with hermesvm built")

if(HERMES_DIR AND HERMES_BUILD)
  add_executable(hermes_glue hermes/glue.cpp "${HERMES_DIR}/API/jsi/jsi/JSIDynamic.cpp")
  target_include_directories(hermes_glue PRIVATE "${ENGINE}" "${HERMES_DIR}/API" "${HERMES_DIR}/API/jsi" "${HERMES_DIR}/public")
  target_compile_definitions(hermes_glue PRIVATE FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
  target_link_libraries(hermes_glue PRIVATE folly_runtime "${HERMES_BUILD}/lib/libhermesvm.so")
  set_target_properties(hermes_glue PROPERTIES BUILD_RPATH "${HERMES_BUILD}/lib")

  # The task order hookDeferred relies on, on React Native's RuntimeScheduler (scheduler/order.cpp). React Native's jsi (in
  # rn_renderer) with the Hermes it pins, as an app links them.
  file(GLOB SCHEDULER_SRC "${RN}/react/renderer/runtimescheduler/*.cpp"
       "${RN}/jsinspector-modern/tracing/EventLoopReporter.cpp" "${RN}/runtimeexecutor/platform/cxx/ReactCommon/RuntimeExecutorSyncUIThreadUtils.cpp")
  add_executable(scheduler_order scheduler/order.cpp ${SCHEDULER_SRC})
  target_include_directories(scheduler_order PRIVATE "${HERMES_DIR}/public" "${HERMES_DIR}/API" "${RN}/runtimeexecutor/platform/cxx")
  target_link_libraries(scheduler_order PRIVATE harness_support "${HERMES_BUILD}/lib/libhermesvm.so")
  set_target_properties(scheduler_order PROPERTIES BUILD_RPATH "${HERMES_BUILD}/lib")
endif()
