const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

// REAL_PLAIN=1 builds the plain Uniwind arm; otherwise the engine is added on top (see src/boot.ts, written by scripts/arm.sh).
const config = withUniwindConfig(mergeConfig(getDefaultConfig(__dirname), {}), {
  cssEntryFile: './global.css',
});

module.exports = process.env.REAL_PLAIN
  ? config
  : require('shadewind/metro').withShadewind(config);
