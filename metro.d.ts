/**
 * Wrap the Metro config returned by `withUniwindConfig` (outermost). `prebuildStyleTable: false` skips building the native class
 * resolver's table at bundle time (the app then builds it on the device when idle).
 */
export function withShadewind<C extends object>(config: C, options?: { prebuildStyleTable?: boolean }): C;
