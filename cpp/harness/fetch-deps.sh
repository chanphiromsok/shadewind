#!/usr/bin/env bash
# Fetches the C++ sources the harness builds into .deps/: React Native's ReactCommon (from the npm package), the folly, fmt
# and fast_float versions React Native 0.86 pins (packages/react-native/gradle/libs.versions.toml), and fbjni's headers for the
# Android build. glog, boost and double-conversion come from the OS (see Dockerfile). Re-running skips what is already there.
set -euo pipefail

cd "$(dirname "$0")"

RN_VERSION="${RN_VERSION:-0.86.2}"
FOLLY_TAG="v2024.11.18.00"
FMT_TAG="12.1.0"
FAST_FLOAT_TAG="v8.0.0"

mkdir -p .deps

if [ ! -d .deps/react-native/ReactCommon ]; then
  echo "react-native ${RN_VERSION}"
  tmp="$(mktemp -d)"
  curl -fsSL "https://registry.npmjs.org/react-native/-/react-native-${RN_VERSION}.tgz" -o "${tmp}/rn.tgz" ||
    (cd "${tmp}" && npm pack "react-native@${RN_VERSION}" >/dev/null && mv react-native-*.tgz rn.tgz)
  tar -xzf "${tmp}/rn.tgz" -C "${tmp}"
  rm -rf .deps/react-native
  mv "${tmp}/package" .deps/react-native
  rm -rf "${tmp}"
fi

clone() {
  local dir="$1" url="$2" tag="$3"

  if [ ! -d ".deps/${dir}" ]; then
    echo "${dir} ${tag}"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "${tag}" "${url}" ".deps/${dir}"
  fi
}

# fbjni's headers, for the Android build of the harness (HARNESS_ANDROID_STATE): React Native's Android headers include them.
# The version React Native pins, from Maven Central; only the headers are used (no JNI call is made).
if [ ! -d .deps/fbjni/include ]; then
  FBJNI_VERSION="$(sed -n 's/^fbjni = "\(.*\)"/\1/p' .deps/react-native/gradle/libs.versions.toml)"
  echo "fbjni ${FBJNI_VERSION}"
  tmp="$(mktemp -d)"
  curl -fsSL "https://repo.maven.apache.org/maven2/com/facebook/fbjni/fbjni/${FBJNI_VERSION}/fbjni-${FBJNI_VERSION}.aar" -o "${tmp}/fbjni.aar"
  (cd "${tmp}" && unzip -q fbjni.aar 'prefab/modules/fbjni/include/*')
  rm -rf .deps/fbjni
  mkdir -p .deps/fbjni
  mv "${tmp}/prefab/modules/fbjni/include" .deps/fbjni/include
  rm -rf "${tmp}"
fi

clone folly https://github.com/facebook/folly "${FOLLY_TAG}"
clone fmt https://github.com/fmtlib/fmt "${FMT_TAG}"
clone fast_float https://github.com/fastfloat/fast_float "${FAST_FLOAT_TAG}"

echo "dependencies in $(pwd)/.deps"
