// `shadewind/uniwind`: engine support for Uniwind apps. Needs `withShadewind()` from `shadewind/metro` in metro.config.js.
export { installUniwind, type InstallResult } from './install';
export { View } from './View';
export { Text } from './Text';
/** Debug only: why each className was or was not handed to the engine, and render counts (needs `__DEV__` or `globalThis.__SHADEWIND_DEBUG__ = true`). */
export { decisions, renders } from './useShadewindStyle';
