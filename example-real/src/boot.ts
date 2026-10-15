import { Settings } from 'react-native';
import { installUniwind } from 'shadewind/uniwind';

// -realDebug 1 collects why each className was or was not handed to the engine (Account > Engine report)
if (Settings.get('armB')) {
  // measurement: refs stay attached, the engine is never called (what the ref machinery alone costs)
  (globalThis as { __SHADEWIND_SKIP_REGISTER?: boolean }).__SHADEWIND_SKIP_REGISTER = true;
}

if (Settings.get('realDebug')) {
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ = true;
}

installUniwind();
