#!/bin/sh
# Every test configuration, then the benchmark (the Docker image's default command; arguments go to the benchmark):
#   build/          React Native's renderer with its generic platform code
#   build-android/  the same renderer built as on Android (RN_SERIALIZABLE_STATE, Android's platform code), checked against what
#                   Android's mounting layer would send each Java view, in each of React Native 0.86's props modes
set -e

build/harness_tests

for mode in default accumulated reconciliation; do
  echo "== Android build, props sent to Java: ${mode}"
  HARNESS_ANDROID_PROPS="${mode}" build-android/harness_tests --gtest_brief=1
done

build/harness_bench "$@"
