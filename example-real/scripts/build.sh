#!/bin/bash
# usage: scripts/build.sh engine|plain   builds a Release simulator app and copies it to build-out/<arm>.app
export ASDF_RUBY_VERSION=3.2.0 LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 NODE_ENV=production
ARM=$1; ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
./scripts/arm.sh $ARM
if [ "$ARM" = plain ]; then export REAL_PLAIN=1; else unset REAL_PLAIN; fi
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'metro-*' -exec rm -rf {} + 2>/dev/null
[ -d ios/Pods ] || (cd ios && pod install)
mkdir -p build-out dd
(cd ios && xcodebuild -workspace RealWorld.xcworkspace -scheme RealWorld -configuration Release \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ../dd ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build) > build-out/$ARM.log 2>&1
echo "xcodebuild exit $?"
rm -rf "build-out/$ARM.app"; cp -R dd/Build/Products/Release-iphonesimulator/RealWorld.app "build-out/$ARM.app"
echo "BUILD_${ARM}_DONE"
