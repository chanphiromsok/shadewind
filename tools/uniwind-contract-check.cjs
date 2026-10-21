// The contract between shadewind and Uniwind's private code (docs/UNIWIND_CONTRACT.md), checked against the Uniwind in an app's
// node_modules. No device, no Metro run beyond Uniwind's own CSS transform: Uniwind's real store, listener and compiled stylesheet.
//
// Run: node tools/uniwind-contract-check.cjs [app dir with node_modules, default example-real]
//
// Each check is named after an item of the contract; a failure names the item that changed, not a symptom three layers down.
// A Uniwind that fails here must stay out of install.ts's TESTED list (the adapter then turns itself off with a reason).
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { compileStylesheet, loadUniwind, reinitStore } = require('./uniwind-harness.cjs');

const repo = path.join(__dirname, '..');
const app = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? path.join(repo, 'example-real'));
const ts = require(path.join(repo, 'node_modules', 'typescript'));

const CLASSES = ['p-4', 'bg-card', 'text-primary bg-background', 'dark:bg-card p-2', 'active:bg-brand bg-card', 'md:p-4 p-1', 'flex-row items-center'];
const STATES = [undefined, { isPressed: true, isDisabled: false }, { isPressed: false, isDisabled: true }];
const ROOT = { scopedTheme: null, rtl: null, variables: null };

let failed = 0;
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(error.message ?? error).split('\n').join('\n       ')}`);
  }
};

const compileSource = (name, out) => {
  const source = fs.readFileSync(path.join(repo, 'src', 'uniwind', name), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: name,
  });

  fs.writeFileSync(path.join(out, name.replace(/\.tsx?$/, '.js')), outputText);

  return require(path.join(out, name.replace(/\.tsx?$/, '.js')));
};

(async () => {
  const uniwind = loadUniwind(app);
  const { UniwindStore: store, UniwindListener: listener, StyleDependency } = uniwind;

  console.log(`Uniwind ${uniwind.version} (${uniwind.root})\n`);

  // ---- files: the specifiers shadewind/metro maps (uniwind-internal/*) and the files it replaces
  const src = (...parts) => path.join(uniwind.root, 'src', ...parts);
  const exists = (base) => ['.ts', '.tsx', '/index.ts', '/index.tsx'].some((ext) => fs.existsSync(base + ext));

  check('files: every uniwind-internal/* module shadewind imports exists in src/', () => {
    for (const parts of [
      ['core', 'native'],
      ['core', 'listener'],
      ['core', 'context'],
      ['common', 'consts'],
      ['components', 'utils'],
      ['components', 'native', 'useAccentColor'],
      ['hoc', 'withUniwind.native'],
    ]) {
      assert.ok(exists(src(...parts)), `uniwind/src/${parts.join('/')} is gone (metro.cjs PREFIX, uniwind-internal.d.ts)`);
    }
  });

  check('files: the components metro.cjs REPLACED swaps still exist under the names its patterns match', () => {
    for (const name of ['View', 'Text', 'Pressable', 'TouchableOpacity']) {
      assert.ok(fs.existsSync(src('components', 'native', `${name}.tsx`)), `src/components/native/${name}.tsx`);
    }

    assert.ok(fs.existsSync(src('hoc', 'withUniwind.native.tsx')), 'src/hoc/withUniwind.native.tsx');
  });

  check('files: the replaced components export the names shadewind\'s replacements stand in for', () => {
    for (const name of ['View', 'Text', 'Pressable', 'TouchableOpacity']) {
      const text = fs.readFileSync(src('components', 'native', `${name}.tsx`), 'utf8');

      assert.ok(new RegExp(`export (const|function) ${name}\\b|export \\{[^}]*\\b${name}\\b`).test(text), `${name}.tsx has no export named ${name}`);
    }

    assert.ok(/export (const|function) withUniwind\b/.test(fs.readFileSync(src('hoc', 'withUniwind.native.tsx'), 'utf8')), 'withUniwind export');
  });

  // ---- the CSS module (metro-babel-transformer.cjs, nativeResolver prebuilt table)
  const cssModule = await compileStylesheet(app, CLASSES);

  check('css module: starts with `const { Uniwind } = require(\'uniwind\');Uniwind.__reinit(rt => ` (metro-babel-transformer.cjs CSS_MODULE)', () => {
    assert.ok(/^const \{ Uniwind \} = require\('uniwind'\);Uniwind\.__reinit\(rt => /.test(cssModule), cssModule.slice(0, 120));
  });

  let reinit;

  check('css module: __reinit(generate, themes[, fingerprint]) with a function and a theme list', () => {
    reinit = reinitStore(uniwind, cssModule);
    assert.strictEqual(typeof reinit.generate, 'function');
    assert.ok(Array.isArray(reinit.themes) && reinit.themes.length >= 2, String(reinit.themes));
  });

  // ---- UniwindStore
  check('store: vars (object per theme), runtime.currentThemeName, runtime.screen.width, stylesheet, cache (Map per theme)', () => {
    const themes = Object.keys(store.vars);

    assert.ok(themes.length >= 2, `vars: ${themes}`);
    assert.strictEqual(typeof store.runtime.currentThemeName, 'string');
    assert.strictEqual(typeof store.runtime.screen?.width, 'number', 'runtime.screen.width (the native resolver)');
    assert.ok(store.stylesheet && Object.keys(store.stylesheet).length > 0, 'stylesheet');
    assert.ok(store.cache && themes.every((theme) => store.cache[theme] instanceof Map), 'cache: a Map for every theme');
  });

  check('store: getStyles lives on the prototype, resolveStyles is callable (installBoundedStyleCache, nativeResolver)', () => {
    const prototype = Object.getPrototypeOf(store);

    assert.strictEqual(typeof prototype.getStyles, 'function');
    assert.strictEqual(store.getStyles, prototype.getStyles, 'getStyles must not be an own property before shadewind installs');
    assert.strictEqual(typeof store.resolveStyles, 'function');
  });

  store.runtime.currentThemeName = 'light';

  const result = store.getStyles('bg-card p-4', {}, undefined, ROOT);

  check('getStyles result: styles object, dependencies number[], dependencySum number', () => {
    assert.ok(result.styles && typeof result.styles === 'object', 'styles');
    assert.ok(Array.isArray(result.dependencies) && result.dependencies.every((d) => typeof d === 'number'), 'dependencies');
    assert.strictEqual(typeof result.dependencySum, 'number', 'dependencySum');
    assert.ok(result.styles.backgroundColor !== undefined && result.styles.padding === 16, JSON.stringify(result.styles));
  });

  check('StyleDependency: numeric Theme and Variables; every dependency is a bit of dependencySum (styleCache.ts: 1 << dependency)', () => {
    assert.ok(Number.isInteger(StyleDependency.Theme) && Number.isInteger(StyleDependency.Variables));
    assert.notStrictEqual(StyleDependency.Theme, StyleDependency.Variables);

    for (const value of Object.values(StyleDependency).filter((entry) => typeof entry === 'number')) {
      assert.ok(Number.isInteger(value) && value >= 0 && value < 31, `StyleDependency value ${value} does not fit a bit set`);
    }

    const themed = store.getStyles('bg-card', {}, undefined, ROOT);

    assert.ok(themed.dependencies.includes(StyleDependency.Theme), 'a theme variable class depends on Theme');
    // eslint-disable-next-line no-bitwise
    assert.ok((themed.dependencySum & (1 << StyleDependency.Theme)) !== 0, 'dependencySum has the Theme bit');
    // eslint-disable-next-line no-bitwise
    assert.strictEqual(themed.dependencies.reduce((sum, d) => sum | (1 << d), 0), themed.dependencySum, 'dependencySum is the bit set of dependencies');
  });

  check('cache: the entry key is `${className}${disabled}${focused}${pressed}${scoped}${rtl}${variablesKey}` in store.cache[theme] (styleCache.ts)', () => {
    // the formula styleCache.ts copies, over states and contexts that leave each field out
    const keyOf = (className, state, context) =>
      `${className}${state?.isDisabled ?? false}${state?.isFocused ?? false}${state?.isPressed ?? false}${context.scopedTheme !== null}${
        context.rtl ?? ''
      }${context.variables?.__uniwindVariablesCacheKey ?? ''}`;

    for (const [index, [state, context]] of [
      [undefined, ROOT],
      [{ isPressed: true }, ROOT],
      [{ isDisabled: true, isFocused: true, isPressed: false }, ROOT],
      [undefined, { scopedTheme: null, rtl: true, variables: null }],
      [undefined, { scopedTheme: null, rtl: null, variables: { __uniwindVariablesCacheKey: 'vk' } }],
      [undefined, { scopedTheme: 'dark', rtl: null, variables: null }],
    ].entries()) {
      const className = `p-${index + 2} text-primary`;
      const fresh = store.getStyles(className, {}, state, context);
      const cache = store.cache[context.scopedTheme ?? store.runtime.currentThemeName];
      const key = keyOf(className, state, context);

      assert.strictEqual(cache.get(key), fresh, `case ${index}: no entry under "${key}"; last keys ${[...cache.keys()].slice(-2)}`);
      assert.strictEqual(store.getStyles(className, {}, state, context), fresh, `case ${index}: a second call is a hit`);
    }
  });

  check('cache: an entry goes when its dependency notifies (the invalidation styleCache.ts reproduces)', () => {
    const fresh = store.getStyles('bg-card', {}, undefined, ROOT);

    assert.strictEqual(store.getStyles('bg-card', {}, undefined, ROOT), fresh);
    listener.notify([StyleDependency.Theme]);
    assert.notStrictEqual(store.getStyles('bg-card', {}, undefined, ROOT), fresh, 'still the cached object after a Theme notify');
  });

  // ---- UniwindListener
  check('listener: subscribe(fn, deps) returns a dispose, notify(deps) calls it, getSnapshot(deps) counts notifies', () => {
    let calls = 0;
    const dispose = listener.subscribe(() => calls++, [StyleDependency.Variables]);
    const before = listener.getSnapshot([StyleDependency.Variables]);

    listener.notify([StyleDependency.Variables]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(listener.getSnapshot([StyleDependency.Variables]), before + 1);
    assert.strictEqual(typeof dispose, 'function');
    dispose();
    listener.notify([StyleDependency.Variables]);
    assert.strictEqual(calls, 1, 'dispose');
  });

  // ---- shadewind's code against the real store
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shadewind-contract-src-')));

  try {
    const { buildStyleTable } = compileSource('styleTable.ts', out);
    const { installBoundedStyleCache, STYLE_CACHE_LIMIT } = compileSource('styleCache.ts', out);

    check('styleTable: buildStyleTable reads the stylesheet format (classes > 0), or refuses with a reason (never an empty table)', () => {
      let table = null;
      let refusal = null;

      try {
        table = buildStyleTable({ stylesheet: store.stylesheet, varsByTheme: store.vars, themes: Object.keys(store.vars), runtime: store.runtime });
      } catch (error) {
        refusal = String(error.message);
      }

      if (table) {
        assert.ok(table.classes > 0, `a table without classes (${table.fallback} fallback): the style format changed and nothing said so`);
      } else {
        assert.ok(/matches\(\) functions/.test(refusal), `refused for another reason: ${refusal}`);
        console.log(`       (native resolver refused on this Uniwind: ${refusal.slice(0, 70)}...)`);
      }
    });

    check('styleCache: the bounded cache returns what Uniwind\'s own returns, for classNames x states x themes', () => {
      const own = {};

      for (const theme of Object.keys(store.vars)) {
        store.runtime.currentThemeName = theme;

        for (const className of CLASSES) {
          for (const [index, state] of STATES.entries()) {
            own[`${theme}|${className}|${index}`] = JSON.stringify(store.getStyles(className, {}, state, ROOT).styles);
          }
        }
      }

      store.runtime.currentThemeName = 'light';
      assert.strictEqual(installBoundedStyleCache(store, listener, StyleDependency), true, 'refused this store');

      for (const theme of Object.keys(store.vars)) {
        store.runtime.currentThemeName = theme;

        for (const className of CLASSES) {
          for (const [index, state] of STATES.entries()) {
            assert.strictEqual(
              JSON.stringify(store.getStyles(className, {}, state, ROOT).styles),
              own[`${theme}|${className}|${index}`],
              `${theme} ${className} state ${index}`
            );
          }
        }
      }
    });

    check('styleCache: same key (a hit returns the same object), invalidated by the dependency, bounded', () => {
      store.runtime.currentThemeName = 'light';

      const a = store.getStyles('bg-card text-primary', {}, undefined, ROOT);

      assert.strictEqual(store.getStyles('bg-card text-primary', {}, undefined, ROOT), a, 'hit');
      listener.notify([StyleDependency.Theme]);
      assert.notStrictEqual(store.getStyles('bg-card text-primary', {}, undefined, ROOT), a, 'invalidated by Theme');

      for (let i = 0; i < STYLE_CACHE_LIMIT + 50; i++) {
        store.getStyles(`w-[${i + 1}px]`, {}, undefined, ROOT);
      }

      assert.ok(store.cache.light.size <= STYLE_CACHE_LIMIT, `${store.cache.light.size} entries`);
    });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
