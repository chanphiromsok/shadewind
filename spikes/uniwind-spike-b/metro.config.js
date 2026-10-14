const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const { withUniwindConfig } = require('uniwind/metro')
const path = require('node:path')

const workspaceRoot = path.resolve(__dirname, '../../')
const shadewindRoot = '/Users/phirom/Desktop/uniwind-shadow'

const defaultConfig = getDefaultConfig(__dirname)
const config = {
  watchFolders: [workspaceRoot, shadewindRoot],
  resolver: {
    nodeModulesPaths: [path.join(workspaceRoot, 'node_modules'), path.join(__dirname, 'node_modules')],
    // the library's source entry (package.json exports condition) and none of its own node_modules (one react-native only)
    unstable_conditionNames: ['shadewind-source', 'react-native'],
    blockList: [
      new RegExp(`${shadewindRoot}/node_modules/.*`),
      new RegExp(`${shadewindRoot}/example/.*`),
      new RegExp(`${shadewindRoot}/spikes/.*`),
    ],
  },
}
const mergedConfigs = mergeConfig(defaultConfig, config)

module.exports = withUniwindConfig(mergedConfigs, {
  cssEntryFile: './global.css',
  extraThemes: ['ocean'],
})
