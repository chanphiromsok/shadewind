// Runtime check of src/index.tsx's useThemed / useThemedProps: compiles the real file with TypeScript and runs the hooks against a
// fake native engine and a minimal hook runtime (one slot array per component instance), so it holds for the hooks with or
// without React hooks inside.
// Run: node tools/use-themed-js-check.cjs   (needs `yarn install` for the typescript package)
const path = require('path');
const root = path.join(__dirname, '..');
const ts = require(path.join(root, 'node_modules', 'typescript'));
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

let slots = null;
let slot = 0;
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const useMemo = (f, deps) => {
  const i = slot++;
  const s = slots[i];

  if (s && same(s.deps, deps)) return s.value;

  const value = f();
  slots[i] = { deps, value };
  return value;
};
// a component instance: its hook slots survive re-renders
const instance = () => {
  const own = [];
  return (fn) => { slots = own; slot = 0; try { return fn(); } finally { slots = null; } };
};

const engine = { raw: [], unregistered: [], registered: new Set(), labels: [] };
const stubs = {
  react: { createElement: (type, props) => ({ type, props }), useCallback: (f, deps) => useMemo(() => f, deps), useMemo, useSyncExternalStore() {} },
  'react-native': { Appearance: { addChangeListener: () => ({ remove() {} }), getColorScheme: () => 'light' }, Platform: { OS: 'ios' }, StyleSheet: { flatten: (s) => s }, Text: 'Text', View: 'View' },
  './internal': {
    ShadewindEngine: {
      configure: () => ({ ok: true, maxThemes: 6 }),
      setTheme() {},
      registerRaw(...args) { engine.raw.push(args); engine.registered.add(args[0]); return true; },
      isRegistered: (node) => engine.registered.has(node),
      unregister(node) { engine.unregistered.push(node); engine.registered.delete(node); },
      label(styles, label) { engine.labels.push([styles, label]); },
    },
    toNativeProps: (style) => ({ native: style }),
    toNativePropsWith: (values, colorKeys) => ({ native: values, colorKeys }),
  },
};
const src = fs.readFileSync(path.join(root, 'src', 'index.tsx'), 'utf8');
const out = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', jsx: 'react', target: 'es2020' } }).outputText;
const m = new Module('index'); m.paths = [];
m.require = (n) => { if (n in stubs) return stubs[n]; throw new Error('unexpected import ' + n); };
global.__DEV__ = true;
const warn = console.warn;
const warnings = [];
console.warn = (msg) => warnings.push(msg);
m._compile(out.replace(/require\(/g, 'module.require('), 'index.js');
const api = m.exports;

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('PASS', name); };
api.configure({ themes: ['light', 'dark'], initialTheme: 'light' });
const card = () => ({ light: { backgroundColor: '#fff' }, dark: { backgroundColor: '#000' } }); // a new object per call, as inline
const lastRaw = () => engine.raw[engine.raw.length - 1];

ok('engine view: style is the current theme, engine true', () => {
  const r = instance()(() => api.useThemed(card()));
  assert.strictEqual(r.engine, true);
  assert.deepStrictEqual(r.style, { backgroundColor: '#fff' });
});

ok('inline objects of the same content: same ref across re-renders (no detach/attach per commit)', () => {
  const render = instance();
  const a = render(() => api.useThemed(card()));
  const b = render(() => api.useThemed(card()));
  assert.strictEqual(a.ref, b.ref);
});

ok('first attach passes the render theme, a re-attach of the same node passes undefined, null is ignored', () => {
  const node = {};
  const { ref } = instance()(() => api.useThemed(card()));
  const before = engine.raw.length;
  ref(node);
  assert.strictEqual(lastRaw()[0], node);
  assert.deepStrictEqual(lastRaw()[1], { light: { native: { backgroundColor: '#fff' } }, dark: { native: { backgroundColor: '#000' } } });
  assert.strictEqual(lastRaw()[2], 'light');
  ref(null);
  assert.strictEqual(engine.raw.length, before + 1);
  ref(node);
  assert.strictEqual(lastRaw()[2], undefined);
});

ok('views with the same styles content share one native object (one style id in C++)', () => {
  const a = {}; const b = {};
  instance()(() => api.useThemed(card())).ref(a);
  const nativeA = lastRaw()[1];
  instance()(() => api.useThemed(card())).ref(b);
  assert.strictEqual(lastRaw()[1], nativeA);
});

ok('dev label: once per native object, named by the styles content', () => {
  const styles = { light: { borderColor: 'red' }, dark: { borderColor: 'blue' } };
  const before = engine.labels.length;
  instance()(() => api.useThemed(styles)).ref({});
  instance()(() => api.useThemed(Object.assign({}, styles))).ref({});
  const added = engine.labels.slice(before);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0][1], `useThemed: ${JSON.stringify(styles)}`);
  assert.strictEqual(added[0][0], lastRaw()[1]);
});

ok('after a switch: the re-render reads the new theme; a node attached then is registered with it', () => {
  const render = instance();
  const node = {};
  render(() => api.useThemed(card())).ref(node);
  api.setTheme('dark');
  const r = render(() => api.useThemed(card()));
  assert.deepStrictEqual(r.style, { backgroundColor: '#000' });
  r.ref(node); // the same node again: its props may have been re-themed by the commit hook meanwhile
  assert.strictEqual(lastRaw()[2], undefined);
  const fresh = {};
  r.ref(fresh);
  assert.strictEqual(lastRaw()[0], fresh);
  assert.strictEqual(lastRaw()[2], 'dark');
  api.setTheme('light');
});

ok('unsupported key: fallback, warns once, the ref unregisters a node bound before', () => {
  const node = {};
  const render = instance();
  render(() => api.useThemed(card())).ref(node);
  const before = warnings.length;
  const bad = () => ({ light: { opacity: 1 }, dark: { opacity: 0.5 } });
  const r = render(() => api.useThemed(bad()));
  render(() => api.useThemed(bad()));
  assert.strictEqual(r.engine, false);
  assert.deepStrictEqual(r.style, { opacity: 1 });
  assert.strictEqual(warnings.length, before + 1);
  assert.match(warnings[before], /'opacity' is not supported/);
  r.ref(node);
  assert.strictEqual(engine.unregistered[engine.unregistered.length - 1], node);
  const raw = engine.raw.length;
  r.ref({}); // never bound: nothing to unregister, nothing registered
  assert.strictEqual(engine.raw.length, raw);
});

ok('fallback reasons: undeclared theme, missing key in a theme, no keys, forceFallback', () => {
  const render = instance();
  assert.strictEqual(render(() => api.useThemed({ light: { color: 'red' }, sepia: { color: 'brown' } })).engine, false);
  assert.strictEqual(render(() => api.useThemed({ light: { color: 'red' } })).engine, false);
  assert.strictEqual(render(() => api.useThemed({ light: {}, dark: {} })).engine, false);
  const forced = render(() => api.useThemed(card(), { forceFallback: 'inline style overrides' }));
  assert.strictEqual(forced.engine, false);
  assert.deepStrictEqual(forced.style, { backgroundColor: '#fff' });
  assert.strictEqual(render(() => api.useThemed(card())).engine, true);
});

ok("onUnsupported 'throw': every render of an unsupported view throws", () => {
  api.configure({ themes: ['light', 'dark'], initialTheme: 'light', onUnsupported: 'throw' });
  const render = instance();
  const bad = () => ({ light: { opacity: 1 }, dark: { opacity: 0.5 } });
  assert.throws(() => render(() => api.useThemed(bad())), /not supported/);
  assert.throws(() => render(() => api.useThemed(bad())), /not supported/);
  assert.throws(() => render(() => api.useThemed(card(), { forceFallback: 'forced' })), /forced/);
  api.configure({ themes: ['light', 'dark'], initialTheme: 'light', onUnsupported: 'warn' });
});

const gradient = () => ({ light: { colors: ['#fff', '#eee'], start: 0 }, dark: { colors: ['#000', '#111'], start: 0 } });

ok('useThemedProps: props of the current theme, converted with colorKeys, registered without a theme', () => {
  const render = instance();
  const r = render(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] }));
  assert.deepStrictEqual(r.props, { colors: ['#fff', '#eee'], start: 0 });
  const node = {};
  r.ref(node);
  assert.strictEqual(lastRaw()[0], node);
  assert.deepStrictEqual(lastRaw()[1], {
    light: { native: { colors: ['#fff', '#eee'], start: 0 }, colorKeys: ['colors'] },
    dark: { native: { colors: ['#000', '#111'], start: 0 }, colorKeys: ['colors'] },
  });
  assert.strictEqual(lastRaw()[2], undefined);
  const raw = engine.raw.length;
  r.ref(null);
  assert.strictEqual(engine.raw.length, raw);
  api.setTheme('dark');
  assert.deepStrictEqual(render(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] })).props, { colors: ['#000', '#111'], start: 0 });
  api.setTheme('light');
});

ok('useThemedProps: same ref and native across re-renders with inline values; colorKeys are part of the identity', () => {
  const render = instance();
  const a = render(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] }));
  const b = render(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] }));
  assert.strictEqual(a.ref, b.ref);
  a.ref({}); const nativeA = lastRaw()[1];
  b.ref({}); assert.strictEqual(lastRaw()[1], nativeA);
  const c = render(() => api.useThemedProps(gradient()));
  c.ref({});
  assert.notStrictEqual(lastRaw()[1], nativeA);
  assert.deepStrictEqual(lastRaw()[1].light.colorKeys, []);
});

ok('useThemedProps: dev label names the values and colorKeys', () => {
  const values = { light: { tint: 'red' }, dark: { tint: 'blue' } };
  const before = engine.labels.length;
  instance()(() => api.useThemedProps(values, { colorKeys: ['tint'] })).ref({});
  const added = engine.labels.slice(before);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0][1], `useThemedProps: ${JSON.stringify([values, ['tint']])}`);
  assert.strictEqual(added[0][0], lastRaw()[1]);
});

ok('useThemedProps: views with the same values share one native object (one style id in C++)', () => {
  instance()(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] })).ref({});
  const nativeA = lastRaw()[1];
  instance()(() => api.useThemedProps(gradient(), { colorKeys: ['colors'] })).ref({});
  assert.strictEqual(lastRaw()[1], nativeA);
});

ok('ThemedView: same ref across re-renders, an inline style override falls back', () => {
  const render = instance();
  const userRef = () => {};
  const a = render(() => api.ThemedView({ themed: card(), ref: userRef }));
  const b = render(() => api.ThemedView({ themed: card(), ref: userRef }));
  assert.strictEqual(a.type, 'View');
  assert.strictEqual(a.props.ref, b.props.ref);
  assert.deepStrictEqual(a.props.style, [{ backgroundColor: '#fff' }, undefined]);
  const before = warnings.length;
  render(() => api.ThemedView({ themed: { light: { backgroundColor: '#eee' }, dark: { backgroundColor: '#222' } }, style: { backgroundColor: 'red' } })); // content not warned before
  assert.match(warnings[before] ?? '', /inline style overrides 'backgroundColor'/);
});

console.warn = warn;
console.log(`\n${n} checks passed`);
