import { Settings } from 'react-native';
import { installUniwind } from 'shadewind/uniwind';

// -realDebug 1 collects why each className was or was not handed to the engine (Account > Engine report)
if (Settings.get('realDebug')) {
  (globalThis as { __SHADEWIND_DEBUG__?: boolean }).__SHADEWIND_DEBUG__ = true;
}

installUniwind();
