/**
 * Wrap the Metro config returned by `withUniwindConfig` (outermost).
 *
 * - `prebuildStyleTable: false` skips building the native class resolver's table at bundle time (the app then builds it on the
 *   device when idle).
 * - `cacheColors: true` (off by default) puts a bounded cache in front of React Native's colour parser, so a string colour such as
 *   '#00a8ff' is parsed once instead of for every view of every render. It does not change any result, and it does nothing for
 *   views the engine themes.
 * - `precompileClassNames: true` (experimental, off by default) compiles `<View className="literal">` / `<Text className="literal">` of
 *   the app's files into components without per-view hooks (metro-precompile-plugin.cjs). Compiled views follow theme switches
 *   (engine) but do not re-render when `Uniwind.updateCSSVariables` changes a variable after they mounted.
 */
export function withShadewind<C extends object>(
  config: C,
  options?: {
    prebuildStyleTable?: boolean;
    cacheColors?: boolean;
    precompileClassNames?: boolean;
  }
): C;
