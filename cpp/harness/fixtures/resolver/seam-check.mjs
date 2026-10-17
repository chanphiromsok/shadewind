// Checks src/uniwind/nativeResolver.ts in front of Uniwind 1.12's real UniwindStore (compiled from example-real's CSS like
// generate.mjs does), with a stand-in for the native function: when getStyles reaches the native resolver and when it must not
// (scoped theme, scoped variables, no table yet, stale table, other stylesheet, disabled), that the native answer is what getStyles
// returns and caches, and that an undefined answer or a throw runs Uniwind's own resolveStyles.
//
// Run like generate.mjs (after it, it reuses its .resolver-app):
//   node <repo>/cpp/harness/fixtures/resolver/seam-check.mjs <repo>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const cwd = process.cwd();
const { build } = createRequire(path.join(cwd, 'package.json'))('esbuild');
const uniwind = path.join(cwd, 'node_modules', 'uniwind');
const work = path.join(cwd, '.resolver-app');

if (!fs.existsSync(path.join(work, 'global.css'))) {
  throw new Error('run generate.mjs first (it prepares .resolver-app)');
}

// the native side: loadStyleTable installs __swResolve; this one answers by className so the test can steer it
const calls = [];
const internal = path.join(work, 'internal-stub.mjs');

fs.writeFileSync(
  internal,
  `export const ShadewindEngine = {
  loadStyleTable(json) {
    const table = JSON.parse(json);
    globalThis.__swResolve = (className, theme, width, pressed, focused, disabled) => {
      globalThis.__calls.push({ className, theme, width, pressed, focused, disabled });
      if (className.includes('boom')) throw new Error('boom');
      if (className.includes('flex-row')) return undefined;
      return { styles: { native: className }, dependencies: [2], dependencySum: 4, hasDataAttributes: false };
    };
    return { ok: true, classes: Object.keys(table.classes).length, unsupported: 0 };
  },
};
`
);

const entry = path.join(work, 'seam-entry.mjs');
const src = (file) => JSON.stringify(path.join(uniwind, 'src', file));

fs.writeFileSync(
  entry,
  `export { UniwindStore } from ${src('core/native/store.ts')};
export { UniwindListener } from ${src('core/listener.ts')};
export { UniwindBundlerConfig } from ${src('bundler/config.ts')};
export { compileCSS } from ${src('bundler/css-compiler/index.ts')};
export { installNativeResolver, nativeResolver } from ${JSON.stringify(path.join(repo, 'src/uniwind/nativeResolver.ts'))};
`
);

const bundle = path.join(work, 'seam-bundle.mjs');

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': path.join(uniwind, 'src'), 'react-native': path.join(work, 'react-native-stub.mjs') },
  plugins: [
    {
      name: 'internal-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/internal$/ }, () => ({ path: internal }));
      },
    },
  ],
  external: ['@tailwindcss/node', '@tailwindcss/oxide', 'lightningcss', 'culori', 'react'],
  define: { __DEV__: 'false' },
  logLevel: 'warning',
});

globalThis.__calls = calls;
globalThis.performance ??= { now: () => Date.now() };

const { UniwindStore, UniwindListener, UniwindBundlerConfig, compileCSS, installNativeResolver, nativeResolver } = await import(
  pathToFileURL(bundle).href
);

process.chdir(work);

const config = UniwindBundlerConfig.fromMetroConfig({ cssEntryFile: './global.css', extraThemes: ['ocean'] }, 'ios');
const load = (code) => UniwindStore.reinit(new Function('rt', `return ${code}`), config.themes);

await config.generateArtifacts(path.join(uniwind, 'uniwind.css'));

const code = await compileCSS(config);

load(code);

const VARIABLES = 9;
const context = { scopedTheme: null, rtl: null, variables: null };
const runtime = UniwindStore.runtime;
let checks = 0;
let fresh = 0;
// getStyles caches per className and state: each check uses a className it has not seen
const name = (base) => `${base} p-${(fresh++ % 90) + 1}`;
const expectNative = (className, state, ctx = context) => {
  const before = calls.length;
  const result = UniwindStore.getStyles(className, {}, state, ctx);

  assert.equal(calls.length, before + 1, `native not called for ${className}`);
  assert.deepEqual(result.styles, { native: className });
  checks++;

  return calls.at(-1);
};
const expectUniwind = (className, state, ctx = context) => {
  const before = calls.length;
  const result = UniwindStore.getStyles(className, {}, state, ctx);

  assert.ok(!('native' in result.styles), `native result for ${className}`);
  assert.ok(calls.length <= before + 1);
  checks++;

  return calls.length - before;
};

// 1. installed, table not built yet: Uniwind's JS
installNativeResolver(UniwindStore, UniwindListener, VARIABLES);
assert.equal(nativeResolver.status().state, 'waiting');
assert.equal(expectUniwind(name('bg-card'), undefined), 0);

// 2. built: native, with the store's theme, the screen width and the state as given
const status = nativeResolver.rebuild();

assert.equal(status.state, 'ready', JSON.stringify(status));
assert.ok(status.classes > 100 && status.builds === 1);

runtime.currentThemeName = 'dark';
runtime.screen.width = 768;

let call = expectNative(name('bg-card'), { isPressed: true, isFocused: false });

assert.deepEqual(
  { theme: call.theme, width: call.width, pressed: call.pressed, focused: call.focused, disabled: call.disabled },
  { theme: 'dark', width: 768, pressed: true, focused: false, disabled: undefined }
);

// cached by getStyles: a second call does not resolve again
const cached = name('bg-card');

expectNative(cached, undefined);
{
  const before = calls.length;

  assert.deepEqual(UniwindStore.getStyles(cached, {}, undefined, context).styles, { native: cached });
  assert.equal(calls.length, before);
}

// 3. scoped theme or scoped variables: Uniwind's JS, native never asked
assert.equal(expectUniwind(name('bg-card'), undefined, { scopedTheme: 'light', rtl: null, variables: null }), 0);
assert.equal(
  expectUniwind(name('bg-card'), undefined, { scopedTheme: null, rtl: null, variables: { '--color-card': '#fff' } }),
  0
);

// 4. native answers undefined (a fallback class) or throws: Uniwind's JS result
assert.equal(expectUniwind(name('flex-row'), undefined), 1);
assert.equal(expectUniwind(name('boom'), undefined), 1);
runtime.currentThemeName = 'light';
runtime.screen.width = 390;
assert.deepEqual(
  UniwindStore.getStyles('flex-row items-center', {}, undefined, context).styles,
  Object.getPrototypeOf(UniwindStore).resolveStyles.call(UniwindStore, 'flex-row items-center', {}, undefined, context).styles
);

// 5. variables changed (updateCSSVariables notifies Variables): stale until rebuilt
UniwindListener.notify([VARIABLES]);
assert.equal(nativeResolver.status().state, 'stale');
assert.equal(expectUniwind(name('bg-card'), undefined), 0);
assert.equal(nativeResolver.rebuild().state, 'ready');
expectNative(name('bg-card'), undefined);

// 6. disabled: Uniwind's JS; enabled again: native
nativeResolver.setEnabled(false);
assert.equal(nativeResolver.status().state, 'off');
assert.equal(expectUniwind(name('bg-card'), undefined), 0);
nativeResolver.setEnabled(true);
expectNative(name('bg-card'), undefined);

// 7. the stylesheet was reloaded (development): Uniwind's JS until a table for the new one is built
load(code);
assert.equal(expectUniwind(name('bg-card'), undefined), 0);
assert.equal(nativeResolver.status().state, 'stale');
assert.equal(nativeResolver.rebuild().state, 'ready');
expectNative(name('bg-card'), undefined);

// 8. the runtime fields the build watched are plain again
assert.ok(Object.getOwnPropertyDescriptor(runtime, 'screen').writable);
assert.equal(typeof Object.getOwnPropertyDescriptor(runtime, 'fontScale').value, 'function');

console.log(`seam-check: ${checks} checks passed`);
process.exit(0); // the idle rebuild timers are not awaited
