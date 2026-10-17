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
  "${RN}/react/renderer/graphics/platform/cxx"
  "${RN}/react/renderer/components/view/platform/cxx"
  "${RN}/react/renderer/components/text/platform/cxx"
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
target_compile_options(rn_renderer PRIVATE -w)
target_link_libraries(rn_renderer PUBLIC yoga folly_runtime glog atomic)

# ---- the harness

add_library(harness_support INTERFACE)
target_include_directories(harness_support INTERFACE "${ENGINE}" "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(harness_support INTERFACE rn_renderer)

add_executable(harness_tests tests.cpp class_merge_tests.cpp style_resolver_tests.cpp)
target_link_libraries(harness_tests PRIVATE harness_support GTest::gtest_main)
target_compile_definitions(harness_tests PRIVATE FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")

add_executable(harness_bench bench.cpp)
target_link_libraries(harness_bench PRIVATE harness_support)

