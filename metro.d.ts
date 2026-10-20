/**
 * Wrap the Metro config returned by `withUniwindConfig` (outermost).
 *
 * - `prebuildStyleTable: false` skips building the native class resolver's table at bundle time (the app then builds it on the
 *   device when idle).
 * - `cacheColors: true` (off by default) puts a bounded cache in front of React Native's colour parser, so a string colour such as
 *   '#00a8ff' is parsed once instead of for every view of every render. It does not change any result, and it does nothing for
 *   views the engine themes.
 */
export function withShadewind<C extends object>(
  config: C,
  options?: { prebuildStyleTable?: boolean; cacheColors?: boolean }
): C;
