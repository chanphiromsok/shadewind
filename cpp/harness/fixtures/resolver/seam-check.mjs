// Checks src/uniwind/nativeResolver.ts in front of Uniwind 1.12's real UniwindStore (compiled from example-real's CSS like
// generate.mjs does), with a stand-in for the native function: when getStyles reaches the native resolver and when it must not
// (scoped theme, scoped variables, no table yet, stale table, other stylesheet, disabled), that the native answer is what getStyles
// returns and caches, and that an undefined answer or a throw runs Uniwind's own resolveStyles. Then the table shadewind/metro
// prebuilds (install.ts registerPrebuiltStyleTable): used from install on when it belongs to the store, not when the variables
// changed first or the resolver is off, the device-dependent upgrade, a CSS reload after install. Each scenario runs on its own
// instance of the modules (an import with its own query string).
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
export { buildStyleTable } from ${JSON.stringify(path.join(repo, 'src/uniwind/styleTable.ts'))};
export { installNativeResolver, nativeResolver } from ${JSON.stringify(path.join(repo, 'src/uniwind/nativeResolver.ts'))};
export { registerPrebuiltStyleTable } from ${JSON.stringify(path.join(repo, 'src/uniwind/install.ts'))};
`
);

const bundle = path.join(work, 'seam-bundle.mjs');

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: {
    '@': path.join(uniwind, 'src'),
    'uniwind-internal': path.join(uniwind, 'src'),
    'react-native': path.join(work, 'react-native-stub.mjs'),
  },
  plugins: [
    {
      name: 'internal-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/internal$/ }, () => ({ path: internal }));
      },
    },
  ],
  // install.ts requires these at run time (uniwind/package.json for its version; the others only in installUniwind)
  external: ['@tailwindcss/node', '@tailwindcss/oxide', 'lightningcss', 'culori', 'react', 'shadewind', 'uniwind', 'uniwind/package.json'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __DEV__: 'false' },
  logLevel: 'warning',
});

globalThis.__calls = calls;
globalThis.performance ??= { now: () => Date.now() };

process.chdir(work);

const VARIABLES = 9;
const context = { scopedTheme: null, rtl: null, variables: null };
let checks = 0;
let fresh = 0;
let code = null;
let themes = null;
// getStyles caches per className and state: each check uses a className it has not seen
const name = (base) => `${base} p-${(fresh++ % 90) + 1}`;

// a fresh copy of every module (Uniwind's store included), with the CSS loaded as Uniwind.__reinit does
const instance = async (tag) => {
  const m = await import(`${pathToFileURL(bundle).href}?${tag}`);

  if (code === null) {
    const config = m.UniwindBundlerConfig.fromMetroConfig({ cssEntryFile: './global.css', extraThemes: ['ocean'] }, 'ios');

    await config.generateArtifacts(path.join(uniwind, 'uniwind.css'));
    code = await m.compileCSS(config);
    themes = config.themes;
  }

  const load = () => m.UniwindStore.reinit(new Function('rt', `return ${code}`), themes);
  const store = m.UniwindStore;

  load();

  const expectNative = (className, state, ctx = context) => {
    const before = calls.length;
    const result = store.getStyles(className, {}, state, ctx);

    assert.equal(calls.length, before + 1, `native not called for ${className}`);
    assert.deepEqual(result.styles, { native: className });
    checks++;

    return calls.at(-1);
  };
  const expectUniwind = (className, state, ctx = context) => {
    const before = calls.length;
    const result = store.getStyles(className, {}, state, ctx);

    assert.ok(!('native' in result.styles), `native result for ${className}`);
    assert.ok(calls.length <= before + 1);
    checks++;

    return calls.length - before;
  };
  // what the code shadewind/metro appends to the CSS module does, right after __reinit
  const register = (deviceDependent = 0) => {
    const table = m.buildStyleTable({ stylesheet: store.stylesheet, varsByTheme: store.vars, themes, runtime: store.runtime });

    m.registerPrebuiltStyleTable(table.json, {
      uniwind: '1.12.0',
      platform: 'ios',
      themes,
      fingerprint: null,
      fallback: table.fallback,
      deviceDependent,
    });
  };

  return { ...m, load, store, expectNative, expectUniwind, register };
};

const idle = () => new Promise((resolve) => setTimeout(resolve, 700));

// ---- A. no prebuilt table: built on the device

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, load, expectNative, expectUniwind } = await instance('a');
  const runtime = store.runtime;

  // 1. installed, table not built yet: Uniwind's JS
  installNativeResolver(store, UniwindListener, VARIABLES);
  assert.equal(nativeResolver.status().state, 'waiting');
  assert.equal(expectUniwind(name('bg-card'), undefined), 0);

  // 2. built: native, with the store's theme, the screen width and the state as given
  const status = nativeResolver.rebuild();

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.ok(status.classes > 100 && status.builds === 1 && status.source === 'runtime');

  runtime.currentThemeName = 'dark';
  runtime.screen.width = 768;

  const call = expectNative(name('bg-card'), { isPressed: true, isFocused: false });

  assert.deepEqual(
    { theme: call.theme, width: call.width, pressed: call.pressed, focused: call.focused, disabled: call.disabled },
    { theme: 'dark', width: 768, pressed: true, focused: false, disabled: undefined }
  );

  // cached by getStyles: a second call does not resolve again
  const cached = name('bg-card');

  expectNative(cached, undefined);
  {
    const before = calls.length;

    assert.deepEqual(store.getStyles(cached, {}, undefined, context).styles, { native: cached });
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
    store.getStyles('flex-row items-center', {}, undefined, context).styles,
    Object.getPrototypeOf(store).resolveStyles.call(store, 'flex-row items-center', {}, undefined, context).styles
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
  load();
  assert.equal(expectUniwind(name('bg-card'), undefined), 0);
  assert.equal(nativeResolver.status().state, 'stale');
  assert.equal(nativeResolver.rebuild().state, 'ready');
  expectNative(name('bg-card'), undefined);

  // 8. the runtime fields the build watched are plain again; the counters saw both paths
  assert.ok(Object.getOwnPropertyDescriptor(runtime, 'screen').writable);
  assert.equal(typeof Object.getOwnPropertyDescriptor(runtime, 'fontScale').value, 'function');
  assert.ok(nativeResolver.status().native > 0 && nativeResolver.status().uniwind > 0);
}

// ---- B. a prebuilt table for this stylesheet: native from install on, no build on the device

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, expectNative, register } = await instance('b');

  register();
  installNativeResolver(store, UniwindListener, VARIABLES);

  const status = nativeResolver.status();

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.source, 'prebuilt');
  assert.equal(status.builds, 0);
  assert.ok(status.classes > 100 && status.tableBytes > 1000);
  expectNative(name('bg-card'), undefined);

  // no device-dependent classes: nothing is rebuilt when idle
  await idle();
  assert.equal(nativeResolver.status().builds, 0);
}

// ---- C. a prebuilt table with device-dependent classes: used at once, rebuilt on the device when idle

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, expectNative, register } = await instance('c');

  register(2);
  installNativeResolver(store, UniwindListener, VARIABLES);
  assert.equal(nativeResolver.status().source, 'prebuilt');
  expectNative(name('bg-card'), undefined);
  await idle();
  assert.equal(nativeResolver.status().builds, 1);
  assert.equal(nativeResolver.status().source, 'runtime');
  expectNative(name('bg-card'), undefined);
}

// ---- D. the variables changed between the CSS module and install: the prebuilt table is not used

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, expectUniwind, register } = await instance('d');

  register();
  UniwindListener.notify([VARIABLES]);
  installNativeResolver(store, UniwindListener, VARIABLES);
  assert.equal(nativeResolver.status().state, 'waiting');
  assert.equal(nativeResolver.status().source, null);
  assert.equal(expectUniwind(name('bg-card'), undefined), 0);
}

// ---- E. the resolver turned off before install: nothing is loaded or built

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, expectUniwind, register } = await instance('e');

  nativeResolver.setEnabled(false);
  register();
  installNativeResolver(store, UniwindListener, VARIABLES);
  assert.equal(nativeResolver.status().source, null);
  assert.equal(expectUniwind(name('bg-card'), undefined), 0);
  await idle();
  assert.equal(nativeResolver.status().builds, 0);
  assert.equal(expectUniwind(name('bg-card'), undefined), 0);
}

// ---- F. CSS reload after install (development): the new module's prebuilt table replaces the old one at once

{
  const { store, UniwindListener, installNativeResolver, nativeResolver, load, expectNative, register } = await instance('f');

  register();
  installNativeResolver(store, UniwindListener, VARIABLES);
  load();
  register();
  assert.equal(nativeResolver.status().source, 'prebuilt');
  assert.equal(nativeResolver.status().state, 'ready');
  expectNative(name('bg-card'), undefined);
  assert.equal(nativeResolver.status().builds, 0);
}

console.log(`seam-check: ${checks} checks passed`);
process.exit(0); // pending idle timers are not awaited
