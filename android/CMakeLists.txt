project(shadewind)
cmake_minimum_required(VERSION 3.9.0)

set(PACKAGE_NAME shadewind)
set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

# Define C++ library and add all sources
file(GLOB CORE_SOURCES "../cpp/*.cpp")
add_library(${PACKAGE_NAME} SHARED src/main/cpp/cpp-adapter.cpp ${CORE_SOURCES})

# Add Nitrogen specs :)
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/shadewind+autolinking.cmake)

# Set up local includes
include_directories("src/main/cpp" "../cpp")

# Fabric's platform-specific headers (HostPlatform*Props.h, platform ParagraphState.h, ...) are not on the prefab include path
# by default: React Native's own CMake adds these per-component directories, so do the same.
get_target_property(RN_INCLUDE_DIRS ReactAndroid::reactnative INTERFACE_INCLUDE_DIRECTORIES)
foreach(dir IN LISTS RN_INCLUDE_DIRS)
  foreach(sub
      components/text
      components/view
      components/scrollview
      components/textinput
      components/image
      graphics
      textlayoutmanager
      attributedstring
      imagemanager
      core)
    if(EXISTS "${dir}/react/renderer/${sub}/platform/android")
      target_include_directories(${PACKAGE_NAME} PRIVATE "${dir}/react/renderer/${sub}/platform/android")
    endif()
  endforeach()
endforeach()

# shadewind/diagnostics: the native recorder exists in debug builds only (cpp/Diagnostics.hpp). The Android Gradle plugin builds a
# debug variant with CMAKE_BUILD_TYPE=Debug and a release variant with Release.
target_compile_definitions(${PACKAGE_NAME} PRIVATE $<$<CONFIG:Debug>:SHADEWIND_DIAGNOSTICS=1>)

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android # <-- Android core
)
