import { Settings } from 'react-native';
import { setDefaultTransition } from 'shadewind';
import { installUniwind, nativeResolver } from 'shadewind/uniwind';
import { TRANSITION } from './transitionConfig';

// -realDebug 1 collects why each className was or was not handed to the engine (Account > Engine report)
if (Settings.get('realDebug')) {
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ = true;
}

// -resolverOff 1: Uniwind's own class resolution only (no class table loaded or built), for A/B launches of one build
if (Settings.get('resolverOff')) {
  nativeResolver.setEnabled(false);
}

// the theme transition for Uniwind.setTheme, if one is asked for (src/transitionConfig.ts): the adapter's default
if (TRANSITION) {
  setDefaultTransition(TRANSITION);
}

installUniwind();
