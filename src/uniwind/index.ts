// `shadewind/uniwind`: engine support for Uniwind apps. Needs `withShadewind()` from `shadewind/metro` in metro.config.js.
export {
  installUniwind,
  registerPrebuiltStyleTable,
  type InstallResult,
  type PrebuiltTableMeta,
} from './install';
/** Uniwind's class resolution in C++ (cpp/css/StyleResolver.hpp): status, rebuild, on / off. */
export { nativeResolver, type ResolverStatus } from './nativeResolver';
export { View } from './View';
export { Text } from './Text';
export { Pressable } from './Pressable';
export { TouchableOpacity } from './TouchableOpacity';
/** Debug only: why each className was or was not handed to the engine, and render counts (needs `__DEV__` or `globalThis.__SHADEWIND_DEBUG__ = true`). */
export { decisions, renders } from './useShadewindStyle';
export { withUniwind } from './withUniwind';
/** SPIKE: runtime of `withShadewind(config, { precompileClassNames: true })`; generated code only. */
export { precompiled } from './precompiled';
