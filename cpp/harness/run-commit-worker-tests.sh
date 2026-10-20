#!/bin/sh
# cpp/CommitWorker.hpp's tests (commit_worker_tests.cpp) built and run on their own: no React Native, no Docker, any C++20 compiler.
#
#   ./run-commit-worker-tests.sh [thread|address|undefined|none]      default: thread (the queue is all about threads)
#
# googletest: the system's (-lgtest -lgtest_main), or a source checkout in GTEST_SRC (a folder with include/ and src/; the Android
# NDK ships one: $ANDROID_HOME/ndk/<version>/sources/third_party/googletest). CXX picks the compiler (default clang++).
set -e
cd "$(dirname "$0")"

SANITIZER="${1:-thread}"
CXX="${CXX:-clang++}"
OUT="${OUT:-build-commit-worker}"
FLAGS="-std=c++20 -O1 -g -pthread"

if [ "$SANITIZER" != "none" ]; then
  FLAGS="$FLAGS -fsanitize=$SANITIZER"
fi

mkdir -p "$OUT"

# our own code with warnings as errors; googletest's with none
$CXX $FLAGS -Wall -Wextra -Werror -I.. ${GTEST_SRC:+-isystem "$GTEST_SRC/include"} -c commit_worker_tests.cpp -o "$OUT/commit_worker_tests.o"

if [ -n "$GTEST_SRC" ]; then
  $CXX $FLAGS -w -I"$GTEST_SRC/include" -I"$GTEST_SRC" -c "$GTEST_SRC/src/gtest-all.cc" -o "$OUT/gtest-all.o"
  $CXX $FLAGS -w -I"$GTEST_SRC/include" -I"$GTEST_SRC" -c "$GTEST_SRC/src/gtest_main.cc" -o "$OUT/gtest_main.o"
  $CXX $FLAGS "$OUT/commit_worker_tests.o" "$OUT/gtest-all.o" "$OUT/gtest_main.o" -o "$OUT/commit_worker_tests"
else
  $CXX $FLAGS "$OUT/commit_worker_tests.o" -lgtest -lgtest_main -o "$OUT/commit_worker_tests"
fi

"$OUT/commit_worker_tests" "$@"
