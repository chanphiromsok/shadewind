// Runtime check of src/index.tsx's transition logic: compiles the real file with TypeScript and runs it against a fake native engine.
// Run: node tools/theme-transition-js-check.cjs   (needs `yarn install` for the typescript package)
const path = require('path');
const root = path.join(__dirname, '..');
const ts = require(path.join(root, 'node_modules', 'typescript'));
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

const calls = [];
const stubs = {
  react: { createElement() {}, useCallback: (f) => f, useMemo: (f) => f(), useSyncExternalStore() {} },
  'react-native': { Appearance: { addChangeListener: () => ({ remove() {} }), getColorScheme: () => 'light' }, Platform: { OS: 'ios' }, StyleSheet: {}, Text: {}, View: {} },
  './internal': {
    ShadewindEngine: {
      configure: () => ({ ok: true, maxThemes: 6 }),
      setTheme: (...a) => { calls.push(a); },
    },
    toNativeProps() {}, toNativePropsWith() {},
  },
};
const src = fs.readFileSync(path.join(root, 'src', 'index.tsx'), 'utf8');
const out = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', jsx: 'react', target: 'es2020' } }).outputText;
const m = new Module('index'); m.paths = [];
m.require = (n) => { if (n in stubs) return stubs[n]; throw new Error('unexpected import ' + n); };
global.__DEV__ = true;
m._compile(out.replace(/require\(/g, 'module.require('), 'index.js');
const api = m.exports;

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('PASS', name); };
api.configure({ themes: ['light', 'dark'], initialTheme: 'light' });
const last = () => calls[calls.length - 1];

ok('configure applies the initial theme with strategy hook, no transition', () => assert.deepStrictEqual(last(), ['light', 'hook']));
ok('setTheme without options: engine gets NO third argument (instant)', () => { api.setTheme('dark'); assert.deepStrictEqual(last(), ['dark', undefined, undefined]); });
ok('setTheme with fade passes {type, durationMs}', () => { api.setTheme('light', { transition: { type: 'fade', durationMs: 300 } }); assert.deepStrictEqual(last(), ['light', undefined, { type: 'fade', durationMs: 300 }]); });
ok('durationMs defaults to 250', () => { api.setTheme('dark', { transition: { type: 'fade' } }); assert.strictEqual(last()[2].durationMs, 250); });
ok('durationMs is clamped to 2000', () => { api.setTheme('light', { transition: { type: 'fade', durationMs: 99999 } }); assert.strictEqual(last()[2].durationMs, 2000); });
ok('durationMs 0 / negative / NaN means instant', () => { for (const d of [0, -5, NaN]) { api.setTheme('dark'); api.setTheme('light', { transition: { type: 'fade', durationMs: d } }); assert.strictEqual(last()[2], undefined); } });
ok('unknown preset throws UNKNOWN_TRANSITION and does not switch', () => { const before = calls.length; assert.throws(() => api.setTheme('dark', { transition: { type: 'spin' } }), (e) => e.code === 'UNKNOWN_TRANSITION'); assert.strictEqual(calls.length, before); });
ok('setDefaultTransition applies to setTheme without options', () => { api.setDefaultTransition({ type: 'fade', durationMs: 180 }); api.setTheme('dark'); assert.deepStrictEqual(last()[2], { type: 'fade', durationMs: 180 }); });
ok('the Uniwind path (hookDeferred) uses the default', () => { api.applyUniwindTheme('light'); assert.deepStrictEqual(last(), ['light', 'hookDeferred', { type: 'fade', durationMs: 180 }]); });
ok('transition:false overrides the default', () => { api.setTheme('dark', { transition: false }); assert.strictEqual(last()[2], undefined); });
ok('same theme again: no native call at all', () => { const before = calls.length; api.setTheme('dark'); assert.strictEqual(calls.length, before); });
ok('setDefaultTransition(undefined) clears it', () => { api.setDefaultTransition(undefined); api.setTheme('light'); assert.strictEqual(last()[2], undefined); });
ok('setDefaultTransition validates', () => assert.throws(() => api.setDefaultTransition({ type: 'x' }), (e) => e.code === 'UNKNOWN_TRANSITION'));
ok('configure({transition}) validates (Opus fix)', () => assert.throws(() => api.configure({ themes: ['light', 'dark'], initialTheme: 'light', transition: { type: 'x' } }), (e) => e.code === 'UNKNOWN_TRANSITION'));
ok('blur is accepted and passed to the engine', () => { api.setTheme('dark'); api.setTheme('light', { transition: { type: 'blur', durationMs: 400 } }); assert.deepStrictEqual(last()[2], { type: 'blur', durationMs: 400 }); });
ok('blur as the default is used by the Uniwind path', () => { api.setDefaultTransition({ type: 'blur' }); api.applyUniwindTheme('dark'); assert.deepStrictEqual(last(), ['dark', 'hookDeferred', { type: 'blur', durationMs: 250 }]); api.setDefaultTransition(undefined); });

// shadewind/uniwind installs a driver: setTheme goes to Uniwind, whose listener calls applyUniwindTheme. The fake is Uniwind 1.12's
// setTheme: no notify when it is on that theme already, otherwise a synchronous notify.
api.setTheme('light');
const uniwind = { current: 'light', setTheme(name) { if (name === uniwind.current) return; uniwind.current = name; api.applyUniwindTheme(name); } };
assert.strictEqual(typeof api.setThemeDriver, 'function', 'setThemeDriver is exported');
api.setThemeDriver((name) => uniwind.setTheme(name));
const fade = { type: 'fade', durationMs: 250 };
ok('driver: setTheme with fade moves Uniwind and the engine together (deferred, with the transition)', () => { api.setTheme('dark', { transition: fade }); assert.strictEqual(uniwind.current, 'dark'); assert.deepStrictEqual(last(), ['dark', 'hookDeferred', fade]); assert.strictEqual(api.getTheme(), 'dark'); });
ok('driver: a later Uniwind.setTheme reaches the engine (the reported bug)', () => { uniwind.setTheme('light'); assert.strictEqual(api.getTheme(), 'light'); assert.deepStrictEqual(last(), ['light', 'hookDeferred', undefined]); });
ok('driver: no options uses the default transition', () => { api.setDefaultTransition({ type: 'blur', durationMs: 300 }); api.setTheme('dark'); assert.deepStrictEqual(last(), ['dark', 'hookDeferred', { type: 'blur', durationMs: 300 }]); });
ok('driver: transition:false overrides the default', () => { api.setTheme('light', { transition: false }); assert.deepStrictEqual(last(), ['light', 'hookDeferred', undefined]); api.setDefaultTransition(undefined); });
ok('driver: a bad preset throws before Uniwind switches', () => { const before = calls.length; assert.throws(() => api.setTheme('dark', { transition: { type: 'spin' } }), (e) => e.code === 'UNKNOWN_TRANSITION'); assert.strictEqual(uniwind.current, 'light'); assert.strictEqual(calls.length, before); });
ok('driver: an undeclared theme throws before Uniwind switches', () => { assert.throws(() => api.setTheme('drak'), (e) => e.code === 'UNKNOWN_THEME'); assert.strictEqual(uniwind.current, 'light'); });
ok('driver: Uniwind already on the theme, engine not: the engine is brought to it', () => { uniwind.current = 'dark'; api.setTheme('dark', { transition: fade }); assert.strictEqual(api.getTheme(), 'dark'); assert.deepStrictEqual(last(), ['dark', undefined, fade]); });
ok('driver: engine already on the theme, Uniwind not: Uniwind is still asked', () => { uniwind.current = 'light'; api.setTheme('dark'); assert.strictEqual(uniwind.current, 'dark'); assert.strictEqual(api.getTheme(), 'dark'); });
ok('driver: setTheme through the driver does not stop a later applyUniwindTheme', () => { uniwind.setTheme('light'); assert.strictEqual(api.getTheme(), 'light'); });
ok('driver: __SHADEWIND_UNIWIND_STRATEGY__ picks the engine strategy of the Uniwind path (measuring only)', () => { global.__SHADEWIND_UNIWIND_STRATEGY__ = 'hookAsync'; uniwind.setTheme('dark'); assert.deepStrictEqual(last(), ['dark', 'hookAsync', undefined]); delete global.__SHADEWIND_UNIWIND_STRATEGY__; uniwind.setTheme('light'); assert.deepStrictEqual(last(), ['light', 'hookDeferred', undefined]); });
api.setThemeDriver(null);
ok('driver removed: setTheme is engine-only again', () => { api.setTheme('dark'); assert.deepStrictEqual(last(), ['dark', undefined, undefined]); assert.strictEqual(uniwind.current, 'light'); });

// src/uniwind/useShadewindStyle.ts's engine ref (useEngineRef), compiled the same way, against a fake engine: a plain ref for views,
// pause() / resume() only on a pausable one, and the render theme claimed on a node's first attach only.
const engineCalls = [];
// a fake Uniwind store for useShadewindStyle: one cached result per className, as Uniwind's getStyles returns
const THEME = 1, RTL = 6;
const resolved = {
  'bg-card': { styles: { backgroundColor: 'white' }, dependencies: [THEME, RTL], dependencySum: 66, hasDataAttributes: false },
  'accent-brand': { styles: { accentColor: 'green' }, dependencies: [THEME], dependencySum: 2, hasDataAttributes: false },
  'accent-red-500': { styles: { accentColor: 'red' }, dependencies: [], dependencySum: 0, hasDataAttributes: false },
};
const fakeInternals = {
  UniwindStore: { getStyles: (className) => resolved[className], vars: { light: {}, dark: {} }, runtime: { currentThemeName: 'light' } },
  UniwindListener: { subscribe: () => () => {} },
  StyleDependency: { Theme: THEME },
};
const hooks = { reducers: 0, effects: [], active: true };
const refStubs = {
  react: {
    useLayoutEffect: (fn, deps) => { hooks.effects.push(deps); },
    useReducer: () => { hooks.reducers++; return [0, () => {}]; },
    useRef: (v) => ({ current: v }),
  },
  'react-native': { StyleSheet: { flatten: (s) => s } },
  './install': { getInternals: () => fakeInternals, installUniwind: () => ({ active: hooks.active }) },
  'uniwind-internal/core/context': { useUniwindContext: () => ({ scopedTheme: null }) },
  'shadewind/internal': {
    ShadewindEngine: {
      register: (...a) => { engineCalls.push(['register', ...a]); return true; },
      unregister: (...a) => { engineCalls.push(['unregister', ...a]); },
      label() {},
    },
  },
};
const refSrc = fs.readFileSync(path.join(root, 'src', 'uniwind', 'useShadewindStyle.ts'), 'utf8');
const refOut = ts.transpileModule(refSrc, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
const rm = new Module('useShadewindStyle'); rm.paths = [];
rm.require = (name) => { if (name in refStubs) return refStubs[name]; throw new Error('unexpected import ' + name); };
rm._compile(refOut.replace(/require\(/g, 'module.require('), 'useShadewindStyle.js');
const { useEngineRef, renderThemeOf, useShadewindStyle } = rm.exports;
const themedA = { light: { backgroundColor: 1 }, dark: { backgroundColor: 2 } };
const themedB = { light: { color: 1 }, dark: { color: 2 } };
renderThemeOf.set(themedA, 'light');
renderThemeOf.set(themedB, 'light');

ok('engine ref: a view gets a plain function, without pause / resume', () => { const ref = useEngineRef(themedA, undefined, undefined); assert.strictEqual(typeof ref, 'function'); assert.strictEqual(ref.pause, undefined); assert.strictEqual(ref.resume, undefined); });
ok('engine ref: attach registers once with the render theme', () => { engineCalls.length = 0; const node = {}; useEngineRef(themedA, undefined, undefined)(node); assert.deepStrictEqual(engineCalls, [['register', node, themedA, 'light']]); });
ok('engine ref: another holder on an attached node claims no render theme (re-attach, styles changed)', () => { const node = {}; useEngineRef(themedA, undefined, undefined)(node); engineCalls.length = 0; useEngineRef(themedB, undefined, undefined)(node); assert.deepStrictEqual(engineCalls, [['register', node, themedB, undefined]]); });
ok('engine ref: a pausable ref unbinds on pause and binds again on resume', () => { const ref = useEngineRef(themedA, undefined, undefined, true); const node = {}; ref(node); engineCalls.length = 0; ref.pause(); ref.resume(); assert.deepStrictEqual(engineCalls, [['unregister', node], ['register', node, themedA]]); });
ok('engine ref: the user ref still receives the node', () => { const user = { current: null }; const node = {}; useEngineRef(themedA, user, undefined)(node); assert.strictEqual(user.current, node); });
ok('engine ref: no themed styles, the user ref is returned unchanged', () => { const user = () => {}; assert.strictEqual(useEngineRef(null, user, undefined), user); });

// useShadewindStyle and Text's selection colour (an accent className): no extra hooks without one, the theme in the subscription with one
const render = (accent) => { hooks.reducers = 0; hooks.effects.length = 0; const out = useShadewindStyle('bg-card', {}, undefined, accent); return { out, deps: hooks.effects[0], reducers: hooks.reducers, effects: hooks.effects.length }; };
const warn = console.warn; console.warn = () => {};
ok('style: no accent, one reducer and one layout effect, subscribed to the non-theme dependencies only', () => { const r = render(undefined); assert.strictEqual(r.reducers, 1); assert.strictEqual(r.effects, 1); assert.deepStrictEqual(r.deps, [[RTL]]); assert.strictEqual(r.out.accentColor, undefined); });
ok('style: a theme-dependent accent keeps the hook count, returns its colour and subscribes to the theme too', () => { const r = render('accent-brand'); assert.strictEqual(r.reducers, 1); assert.strictEqual(r.effects, 1); assert.strictEqual(r.out.accentColor, 'green'); assert.ok(r.deps[0].includes(THEME) && r.deps[0].includes(RTL)); });
ok('style: an accent that does not depend on the theme leaves the theme out', () => { const r = render('accent-red-500'); assert.strictEqual(r.out.accentColor, 'red'); assert.ok(!r.deps[0].includes(THEME)); });
ok('style: the subscription array is the same object across renders (the effect does not subscribe again)', () => { assert.strictEqual(render('accent-brand').deps[0], render('accent-brand').deps[0]); assert.strictEqual(render(undefined).deps[0], render(undefined).deps[0]); });
ok('style: engine inactive, the view subscribes to the theme like Uniwind\'s own (with and without an accent)', () => { hooks.active = false; try { assert.ok(render(undefined).deps[0].includes(THEME)); assert.ok(render('accent-red-500').deps[0].includes(THEME)); assert.strictEqual(render('accent-red-500').deps[0], render('accent-red-500').deps[0]); assert.strictEqual(render(undefined).out.themed, null); } finally { hooks.active = true; } assert.ok(!render('accent-red-500').deps[0].includes(THEME)); });
console.warn = warn;

// src/uniwind/native.ts withUserStyle: the cached className style alone when there is no user style
const nm = new Module('native'); nm.paths = [];
nm.require = (name) => ({ default: function Host() {}, NativeText: function NativeText() {} }); // the React Native host components
nm._compile(ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'uniwind', 'native.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText.replace(/require\(/g, 'module.require('), 'native.js');
const { withUserStyle } = nm.exports;
const cached = { backgroundColor: 'white' };
ok('withUserStyle: no style prop (undefined, null, false): the cached object itself, no array', () => { assert.strictEqual(withUserStyle(cached, undefined), cached); assert.strictEqual(withUserStyle(cached, null), cached); assert.strictEqual(withUserStyle(cached, false), cached); });
ok('withUserStyle: with a style prop, the user style comes after the className style', () => { const user = { padding: 4 }; assert.deepStrictEqual(withUserStyle(cached, user), [cached, user]); });

console.log(n + ' checks passed');
