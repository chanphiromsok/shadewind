# The native harness in a container: React Native 0.86's C++ renderer (cxx platform) + the engine, tests and benchmark.
#
#   docker build -f cpp/harness/Dockerfile -t shadewind-harness .     (from the repository root)
#   docker run --rm shadewind-harness                                  (tests, then the benchmark)
#   docker run --rm shadewind-harness build/harness_bench --runs 30    (benchmark only)
#   docker build --build-arg RN_VERSION=0.88.0 ...                     (another React Native release)
#
# Numbers are for comparing the arms (none / baseline / current) on one machine, not for comparing machines.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang cmake ninja-build git curl ca-certificates nodejs npm \
      libgoogle-glog-dev libdouble-conversion-dev libboost-dev libgflags-dev libgtest-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /shadewind

# only what the harness compiles: the engine headers and the harness itself
COPY cpp/ThemeHook.hpp cpp/ThemeEngine.hpp cpp/
COPY cpp/css cpp/css
COPY cpp/harness cpp/harness

WORKDIR /shadewind/cpp/harness

ARG RN_VERSION=0.86.2
RUN rm -rf .deps build && RN_VERSION=${RN_VERSION} ./fetch-deps.sh

RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang \
    && cmake --build build

CMD ["sh", "-c", "build/harness_tests && build/harness_bench"]
