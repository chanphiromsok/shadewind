import type { HybridObject } from 'react-native-nitro-modules';

/**
 * Typed surface. The calls that need the raw JSI runtime (register / unregister / setTheme)
 * are registered natively with registerRawHybridMethod and typed in `src/index.tsx`.
 */
export interface UniwindShadow extends HybridObject<{
  ios: 'c++';
  android: 'c++';
}> {
  /** Name of the theme last applied with setTheme ('' before the first call). */
  getTheme(): string;
}
