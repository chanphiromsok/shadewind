import { NitroModules } from 'react-native-nitro-modules';
import type { UniwindShadow } from './UniwindShadow.nitro';

const UniwindShadowHybridObject =
  NitroModules.createHybridObject<UniwindShadow>('UniwindShadow');

export function multiply(a: number, b: number): number {
  return UniwindShadowHybridObject.multiply(a, b);
}
