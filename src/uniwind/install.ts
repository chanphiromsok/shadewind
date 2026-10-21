import type { ThemedStyles } from '../internal';
import {
  installNativeResolver,
  offerPrebuiltTable,
  type ResolverStore,
} from './nativeResolver';
import { installBoundedStyleCache } from './styleCache';

// The only file that reads Uniwind's runtime. Everything is loaded lazily and inside try/catch: the module that imports this is
// evaluated while React Native is still setting up (Uniwind's component barrel), and a missing or unsupported Uniwind must
// leave plain Uniwind behaviour, never an exception.

/** Uniwind minor versions the adapter was verified against (1.13: the engine and precompileClassNames; the native class resolver needs the 1.12 style format, styleTable.ts). */
const TESTED = ['1.12', '1.13'];

export type InstallResult = { active: boolean; reason?: string };

// Declared here, not as `typeof import('uniwind-internal/...')`: those specifiers exist only inside the app's Metro build, so
// they must not appear in the .d.ts files this package ships.
type Internals = {
  UniwindStore: {
    vars: Record<string, unknown>;
    runtime: { currentThemeName: string };
    getStyles: (
      className: string | undefined,
      props: Record<string, any>,
      state: any,
      context: any
    ) => {
      styles: Record<string, unknown>;
      dependencies: number[];
      hasDataAttributes?: boolean;
    };
  };
  UniwindListener: {
    subscribe: (listener: () => void, dependencies: number[]) => () => void;
    getSnapshot?: (dependencies: number[]) => number;
  };
  StyleDependency: { Theme: number; Variables: number };
};

let result: InstallResult | null = null;
let internals: Internals | null = null;

export const getInternals = () => internals;

const EMPTY_STORE = 'Uniwind has no themes (store is empty)';

const probe = (): InstallResult => {
  const shadewind = require('shadewind') as typeof import('../index');
  const { UniwindStore } = require('uniwind-internal/core/native');
  const { UniwindListener } = require('uniwind-internal/core/listener');
  const { StyleDependency } = require('uniwind-internal/common/consts');

  // set first: the components need them even when the engine is inactive (they then behave like Uniwind's own)
  internals = { UniwindStore, UniwindListener, StyleDependency };

  // for measuring only (docs/LOCAL_TESTING.md, step 7): the adapter's components without the engine (no refs, no registration,
  // no native class resolution), set before the app's first render
  if (
    (globalThis as { __SHADEWIND_ENGINE_OFF__?: boolean })
      .__SHADEWIND_ENGINE_OFF__ === true
  ) {
    return { active: false, reason: 'turned off (__SHADEWIND_ENGINE_OFF__)' };
  }

  const { Uniwind } = require('uniwind') as {
    Uniwind: { currentTheme: string; setTheme: (name: string) => void };
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
    return { active: false, reason: EMPTY_STORE };
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
      shadewind.applyUniwindTheme(UniwindStore.runtime.currentThemeName);
    } catch (error) {
      if (__DEV__) {
        console.warn('[shadewind] could not apply the Uniwind theme', error);
      }
    }
  }, [StyleDependency.Theme]);

  // shadewind's own setTheme goes through Uniwind too: one source of truth, the listener above brings the engine along
  shadewind.setThemeDriver((name) => Uniwind.setTheme(name));

  // cache misses of Uniwind's getStyles resolve natively once the class table is built (nativeResolver.ts)
  installNativeResolver(
    UniwindStore as unknown as ResolverStore,
    UniwindListener,
    StyleDependency.Variables
  );

  // Uniwind's style cache, bounded and without a listener subscription per entry (styleCache.ts); the resolver above stays behind it
  // `globalThis.__SHADEWIND_STYLE_CACHE_LIMIT__`: entries kept per theme (default 4096); 0 leaves Uniwind's own cache alone
  const cacheLimit = (
    globalThis as { __SHADEWIND_STYLE_CACHE_LIMIT__?: number }
  ).__SHADEWIND_STYLE_CACHE_LIMIT__;

  if (cacheLimit !== 0) {
    installBoundedStyleCache(
      UniwindStore,
      UniwindListener,
      StyleDependency,
      typeof cacheLimit === 'number' && cacheLimit > 0 ? cacheLimit : undefined
    );
  }

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

  let next: InstallResult;

  try {
    next = probe();
  } catch (error) {
    next = {
      active: false,
      reason: `Shadewind could not load Uniwind internals (is withShadewind() in metro.config.js?): ${String(error)}`,
    };
  }

  // The store fills when `global.css` is evaluated. Called before that (a boot file imported ahead of the app), the answer
  // is "not yet", not "never": keep asking, the components call this on every render.
  if (!next.active && next.reason === EMPTY_STORE) {
    return next;
  }

  result = next;

  if (!result.active && __DEV__) {
    console.warn(`[shadewind] inactive: ${result.reason}`);
  }

  return result;
}

/** What shadewind/metro writes next to a prebuilt table (metro-babel-transformer.cjs). */
export type PrebuiltTableMeta = {
  uniwind: string;
  platform: string;
  themes: string[];
  fingerprint: string | null;
  fallback: number;
  deviceDependent: number;
};

/**
 * Called by the code shadewind/metro appends to Uniwind's CSS module, right after Uniwind loaded the stylesheet: the class table
 * built at bundle time. It is kept with the store's stylesheet, variables and variables revision of this moment, and used at install
 * only if they are still the store's (and the platform and Uniwind version are the ones it was built for). Never throws.
 */
export function registerPrebuiltStyleTable(
  json: string,
  meta: PrebuiltTableMeta
): void {
  try {
    const { Platform } = require('react-native') as {
      Platform: { OS: string; isTV?: boolean };
    };
    const version = String(
      (require('uniwind/package.json') as { version?: string }).version
    );

    // Uniwind picks TV variables on the device: a table built for the phone platform does not apply
    if (
      typeof json !== 'string' ||
      Platform.OS !== meta.platform ||
      Platform.isTV ||
      version !== meta.uniwind ||
      !TESTED.some((minor) => version.startsWith(`${minor}.`))
    ) {
      return;
    }

    const { UniwindStore } = require('uniwind-internal/core/native');
    const { UniwindListener } = require('uniwind-internal/core/listener');
    const { StyleDependency } = require('uniwind-internal/common/consts');
    const store = UniwindStore as unknown as ResolverStore;

    offerPrebuiltTable({
      json,
      fallback: meta.fallback,
      deviceDependent: meta.deviceDependent,
      stylesheet: store.stylesheet,
      vars: store.vars,
      variablesRevision: (
        UniwindListener as Internals['UniwindListener']
      ).getSnapshot?.([StyleDependency.Variables]),
    });
  } catch (error) {
    if (__DEV__) {
      console.warn('[shadewind] prebuilt class table not used', error);
    }
  }
}

export type { ThemedStyles };
