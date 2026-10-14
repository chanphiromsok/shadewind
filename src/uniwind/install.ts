import type { ThemedStyles } from '../internal';

// The only file that reads Uniwind's runtime. Everything is loaded lazily and inside try/catch: the module that imports this is
// evaluated while React Native is still setting up (Uniwind's component barrel), and a missing or unsupported Uniwind must
// leave plain Uniwind behaviour, never an exception.

/** Uniwind minor versions the adapter was verified against. */
const TESTED = ['1.12'];

export type InstallResult = { active: boolean; reason?: string };

type Internals = {
  UniwindStore: typeof import('uniwind-internal/core/native').UniwindStore;
  UniwindListener: typeof import('uniwind-internal/core/listener').UniwindListener;
  StyleDependency: typeof import('uniwind-internal/common/consts').StyleDependency;
};

let result: InstallResult | null = null;
let internals: Internals | null = null;

export const getInternals = () => internals;

const probe = (): InstallResult => {
  const shadewind = require('shadewind') as typeof import('../index');
  const { UniwindStore } = require('uniwind-internal/core/native');
  const { UniwindListener } = require('uniwind-internal/core/listener');
  const { StyleDependency } = require('uniwind-internal/common/consts');

  // set first: the components need them even when the engine is inactive (they then behave like Uniwind's own)
  internals = { UniwindStore, UniwindListener, StyleDependency };

  const { Uniwind } = require('uniwind') as {
    Uniwind: { currentTheme: string };
  };
  const version = String(
    (require('uniwind/package.json') as { version?: string }).version
  );

  if (!TESTED.some((minor) => version.startsWith(`${minor}.`))) {
    return {
      active: false,
      reason: `Uniwind ${version} is outside the tested range (${TESTED.join(', ')}.x)`,
    };
  }

  const themes = Object.keys(UniwindStore.vars);

  if (themes.length === 0) {
    return { active: false, reason: 'Uniwind has no themes (store is empty)' };
  }

  // a second copy of the store (dist vs src) would have empty vars or another theme: refuse instead of guessing
  if (UniwindStore.runtime.currentThemeName !== Uniwind.currentTheme) {
    return { active: false, reason: 'Uniwind store does not match Uniwind' };
  }

  if (themes.length > shadewind.capabilities.maxThemes) {
    return {
      active: false,
      reason: `${themes.length} themes, the engine supports ${shadewind.capabilities.maxThemes}`,
    };
  }

  shadewind.configure({
    themes,
    initialTheme: UniwindStore.runtime.currentThemeName,
    onUnsupported: 'silent',
  });

  // one subscription: every theme change (setTheme, system scheme) goes to the engine
  UniwindListener.subscribe(() => {
    try {
      shadewind.setTheme(UniwindStore.runtime.currentThemeName);
    } catch (error) {
      if (__DEV__) {
        console.warn('[shadewind] could not apply the Uniwind theme', error);
      }
    }
  }, [StyleDependency.Theme]);

  return { active: true };
};

/**
 * Connects the engine to Uniwind. Safe to call many times and never throws: when it returns `{ active: false }` every
 * component keeps Uniwind's own theme subscription and behaves exactly like plain Uniwind.
 */
export function installUniwind(): InstallResult {
  if (result) {
    return result;
  }

  try {
    result = probe();
  } catch (error) {
    result = {
      active: false,
      reason: `Shadewind could not load Uniwind internals (is withShadewind() in metro.config.js?): ${String(error)}`,
    };
  }

  if (!result.active && __DEV__) {
    console.warn(`[shadewind] inactive: ${result.reason}`);
  }

  return result;
}

export type { ThemedStyles };
