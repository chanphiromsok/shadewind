import { Settings } from 'react-native';
import { setDefaultTransition } from 'shadewind';
import { installUniwind, nativeResolver } from 'shadewind/uniwind';

// -realDebug 1 collects why each className was or was not handed to the engine (Account > Engine report)
if (Settings.get('realDebug')) {
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ = true;
}

// -resolverOff 1: Uniwind's own class resolution only (no class table loaded or built), for A/B launches of one build
if (Settings.get('resolverOff')) {
  nativeResolver.setEnabled(false);
}

// -themeTransition 250: Uniwind.setTheme cross-fades over 250 ms (the default of the Uniwind adapter)
const transitionMs = Number(Settings.get('themeTransition'));

if (transitionMs > 0) {
  setDefaultTransition({ type: 'fade', durationMs: transitionMs });
}

installUniwind();
