import { Platform, Settings } from 'react-native';
import type { ThemeTransition } from 'shadewind';
import { ARM_TRANSITION } from './transitionArm';

// The theme transition the test app uses, or null: instant switches, and the Account screen exactly as the meters expect it.
// - iOS: launch arguments `-themeTransition <ms>` and `-themeTransitionType blur` (default fade).
// - Android (React Native's Settings is iOS only): `SHADEWIND_TRANSITION=blur:250 bash scripts/arm.sh engine`, then rebuild.
// The plain arm has no engine, so it is always null there.
const parse = (type: unknown, ms: unknown): Required<ThemeTransition> | null => {
  const durationMs = Number(ms);

  return durationMs > 0 ? { type: type === 'blur' ? 'blur' : 'fade', durationMs } : null;
};

const fromLaunchArguments = () =>
  Platform.OS === 'ios' ? parse(Settings.get('themeTransitionType'), Settings.get('themeTransition')) : null;

const fromArm = () => {
  const [type, ms] = (ARM_TRANSITION ?? '').split(':');

  return parse(type, ms);
};

export const TRANSITION: Required<ThemeTransition> | null = ARM_TRANSITION === null ? null : (fromLaunchArguments() ?? fromArm());
