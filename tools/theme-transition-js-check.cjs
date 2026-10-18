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
console.log(n + ' checks passed');
