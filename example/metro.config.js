const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMetroConfig } = require('react-native-monorepo-config');
const { withUniwindConfig } = require('uniwind/metro');
const root = path.resolve(__dirname, '..');
// the library's `shadewind/metro` export, from this repository (the example is not installed as a package here)
const { withShadewind } = require(path.join(root, 'metro.cjs'));

/**
 * Metro configuration: the monorepo setup (Shadewind from this repository's source), Uniwind, then Shadewind on top of Uniwind.
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = withMetroConfig(getDefaultConfig(__dirname), {
  root,
  dirname: __dirname,
  conditions: ['shadewind-source'],
});

module.exports = withShadewind(
  withUniwindConfig(config, { cssEntryFile: './global.css' })
);
