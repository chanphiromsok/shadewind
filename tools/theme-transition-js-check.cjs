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
  './cn': {},
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
const hooks = { reducers: 0, effects: [], active: true, ref: null };
const refStubs = {
  react: {
    useLayoutEffect: (fn, deps) => { hooks.effects.push(deps); },
    useReducer: () => { hooks.reducers++; return [0, () => {}]; },
    useRef: (v) => hooks.ref ?? { current: v }, // set hooks.ref to keep one component's ref across renders
  },
  'react-native': { StyleSheet: { flatten: (s) => s }, processColor: (c) => (c === 'white' ? 0xffffffff : c === 'bad' ? undefined : (c === 'half' ? 0x80336699 : 0xff111111)) },
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
// uniwindAccess.ts, compiled the same way, on the same './install' stub
const accessOut = ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'uniwind', 'uniwindAccess.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
const am = new Module('uniwindAccess'); am.paths = [];
am.require = (name) => { if (name in refStubs) return refStubs[name]; throw new Error('unexpected import ' + name); };
am._compile(accessOut.replace(/require\(/g, 'module.require('), 'uniwindAccess.js');
refStubs['./uniwindAccess'] = am.exports;
const rm = new Module('useShadewindStyle'); rm.paths = [];
rm.require = (name) => { if (name in refStubs) return refStubs[name]; throw new Error('unexpected import ' + name); };
rm._compile(refOut.replace(/require\(/g, 'module.require('), 'useShadewindStyle.js');
const { useEngineRef, renderThemeOf, useShadewindStyle } = rm.exports;
const themedA = { light: { backgroundColor: 1 }, dark: { backgroundColor: 2 } };
const themedB = { light: { color: 1 }, dark: { color: 2 } };
const st = (themed, deps = [], rerender = () => {}) => ({ themed, deps, rerender }); // what useShadewindStyle hands to useEngineRef
renderThemeOf.set(themedA, 'light');
renderThemeOf.set(themedB, 'light');

ok('engine ref: a view gets a plain function, without pause / resume', () => { const ref = useEngineRef(st(themedA), undefined); assert.strictEqual(typeof ref, 'function'); assert.strictEqual(ref.pause, undefined); assert.strictEqual(ref.resume, undefined); });
ok('engine ref: attach registers once with the render theme', () => { engineCalls.length = 0; const node = {}; useEngineRef(st(themedA), undefined)(node); assert.deepStrictEqual(engineCalls, [['register', node, themedA, 'light']]); });
ok('engine ref: another holder on an attached node claims no render theme (re-attach, styles changed)', () => { const node = {}; useEngineRef(st(themedA), undefined)(node); engineCalls.length = 0; useEngineRef(st(themedB), undefined)(node); assert.deepStrictEqual(engineCalls, [['register', node, themedB, undefined]]); });
ok('engine ref: a pausable ref unbinds on pause and binds again on resume', () => { const ref = useEngineRef(st(themedA), undefined, true); const node = {}; ref(node); engineCalls.length = 0; ref.pause(); ref.resume(); assert.deepStrictEqual(engineCalls, [['unregister', node], ['register', node, themedA]]); });
ok('engine ref: the user ref still receives the node', () => { const user = { current: null }; const node = {}; useEngineRef(st(themedA), user)(node); assert.strictEqual(user.current, node); });
ok('engine ref: no themed styles, the user ref is returned unchanged', () => { const user = () => {}; assert.strictEqual(useEngineRef(st(null), user), user); });

// useShadewindStyle and Text's selection colour (an accent className): no extra hooks without one, the theme in the subscription with one
// the subscription moved from a layout effect to the ref: `deps` is what the ref subscribes to (useEngineRef), kept as deps[0]
const render = (accent) => { hooks.reducers = 0; hooks.effects.length = 0; const out = useShadewindStyle('bg-card', {}, undefined, accent); return { out, deps: [out.deps], reducers: hooks.reducers, effects: hooks.effects.length }; };
const warn = console.warn; console.warn = () => {};
ok('style: no accent, one reducer and no layout effect, the ref subscribes to the non-theme dependencies only', () => { const r = render(undefined); assert.strictEqual(r.reducers, 1); assert.strictEqual(r.effects, 0); assert.strictEqual(typeof r.out.rerender, 'function'); assert.deepStrictEqual(r.deps, [[RTL]]); assert.strictEqual(r.out.accentColor, undefined); });
ok('style: a theme-dependent accent keeps the hook count, returns its colour and subscribes to the theme too', () => { const r = render('accent-brand'); assert.strictEqual(r.reducers, 1); assert.strictEqual(r.effects, 0); assert.strictEqual(r.out.accentColor, 'green'); assert.ok(r.deps[0].includes(THEME) && r.deps[0].includes(RTL)); });
ok('style: an accent that does not depend on the theme leaves the theme out', () => { const r = render('accent-red-500'); assert.strictEqual(r.out.accentColor, 'red'); assert.ok(!r.deps[0].includes(THEME)); });
ok('style: the subscription array is the same object across renders (the ref is not replaced)', () => { assert.strictEqual(render('accent-brand').deps[0], render('accent-brand').deps[0]); assert.strictEqual(render(undefined).deps[0], render(undefined).deps[0]); });
ok('style: engine inactive, the view subscribes to the theme like Uniwind\'s own (with and without an accent)', () => { hooks.active = false; try { assert.ok(render(undefined).deps[0].includes(THEME)); assert.ok(render('accent-red-500').deps[0].includes(THEME)); assert.strictEqual(render('accent-red-500').deps[0], render('accent-red-500').deps[0]); assert.strictEqual(render(undefined).out.themed, null); } finally { hooks.active = true; } assert.ok(!render('accent-red-500').deps[0].includes(THEME)); });
ok('style: a className the engine cannot take (an inline style over a painted key) keeps the theme in the subscription, so a switch re-renders it', () => {
  hooks.reducers = 0; hooks.effects.length = 0;
  const out = useShadewindStyle('bg-card', { style: { backgroundColor: 'red' } });
  assert.strictEqual(out.themed, null);
  assert.ok(out.deps.includes(THEME), 'the theme stays in the subscription');
});
ok('style: the render that unbinds a view the engine painted sends its colours again (as numbers, never equal to the strings before)', () => {
  const { nudgeUnbound } = rm.exports;
  // processColor's ARGB, rotated to the RRGGBBAA the host's second processColor reads: that pass must give the same colour back
  const rot = (n) => ((n << 8) | ((n >>> 24) & 0xff)) >>> 0; // what the host does to a number (normalizeColor then ARGB)
  const back = (n) => ((n << 24) | (n >>> 8)) >>> 0; // RRGGBBAA -> AARRGGBB
  const out = nudgeUnbound({ backgroundColor: 'white', borderColor: 'bad', color: 'half', padding: 4 });
  assert.strictEqual(out.borderColor, 'bad'); assert.strictEqual(out.padding, 4);
  assert.strictEqual(back(out.backgroundColor), 0xffffffff); assert.strictEqual(back(out.color), 0x80336699);
  assert.strictEqual(out.backgroundColor, 0xffffffff); assert.strictEqual(out.color, 0x33669980); assert.strictEqual(rot(0xff111111) >>> 0, 0x111111ff);
  assert.deepStrictEqual(nudgeUnbound([{ a: 1 }]), [{ a: 1 }]);
  hooks.ref = { current: true }; // bound by the previous render
  try {
    const out = useShadewindStyle('bg-card', { style: { backgroundColor: 'red' } }); // not engine-bound now
    assert.strictEqual(out.themed, null);
    assert.strictEqual(out.style.backgroundColor, 0xffffffff); // white is the same in both byte orders
    assert.strictEqual(hooks.ref.current, false);
    assert.strictEqual(useShadewindStyle('bg-card', { style: { backgroundColor: 'red' } }).style.backgroundColor, 'white', 'only the render that unbinds');
  } finally { hooks.ref = null; }
});
console.warn = warn;

// src/uniwind/native.ts withUserStyle: the cached className style alone when there is no user style
const nm = new Module('native'); nm.paths = [];
nm.require = (name) => name.includes('featureflags') ? { defaultTextToOverflowHidden: () => true } : { default: function Host() {}, NativeText: function NativeText() {} }; // the React Native host components, the text overflow flag on (its default)
nm._compile(ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'uniwind', 'native.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText.replace(/require\(/g, 'module.require('), 'native.js');
const { withUserStyle } = nm.exports;
const cached = { backgroundColor: 'white' };
ok('withUserStyle: no style prop (undefined, null, false): the cached object itself, no array', () => { assert.strictEqual(withUserStyle(cached, undefined), cached); assert.strictEqual(withUserStyle(cached, null), cached); assert.strictEqual(withUserStyle(cached, false), cached); });
ok('withUserStyle: with a style prop, the user style comes after the className style', () => { const user = { padding: 4 }; assert.deepStrictEqual(withUserStyle(cached, user), [cached, user]); });
// font-bold resolves to a number in Uniwind: the direct Text path takes it, with the weight as a string and Text.js's default
// `overflow: 'hidden'` first, as Text.js would
const { nativeTextStyle, textIsPlain } = nm.exports;
const bold = { color: '#000', fontWeight: 700, fontSize: 24 };
ok('nativeTextStyle: overflow hidden first, a numeric weight as a string, the same copy on every call, the source untouched', () => { const a = nativeTextStyle(bold); assert.deepStrictEqual(a, { overflow: 'hidden', color: '#000', fontWeight: '700', fontSize: 24 }); assert.deepStrictEqual(Object.keys(a)[0], 'overflow'); assert.strictEqual(nativeTextStyle(bold), a); assert.strictEqual(bold.fontWeight, 700); });
ok('nativeTextStyle: a className overflow wins over the default; no style gets the default alone', () => { assert.strictEqual(nativeTextStyle({ overflow: 'visible' }).overflow, 'visible'); assert.deepStrictEqual(nativeTextStyle(undefined), { overflow: 'hidden' }); const s = { fontWeight: '600' }; assert.deepStrictEqual(nativeTextStyle(s), { overflow: 'hidden', fontWeight: '600' }); });
ok('textIsPlain: a numeric weight in the className style stays on the direct path, in the user style it does not', () => { assert.strictEqual(textIsPlain({ className: 'font-bold', children: 1 }, bold), true); assert.strictEqual(textIsPlain({ className: 'x', children: 1, style: { fontWeight: 700 } }, cached), false); assert.strictEqual(textIsPlain({ className: 'x', children: 1 }, { ...bold, userSelect: 'none' }), false); });

// src/uniwind/useShadewindStyle.ts subscribeShared: one Uniwind subscription per dependency list, a Set of views behind it.
// The fake listener behaves like Uniwind's: a listener is called once per notified dependency it subscribed to.
{
  const { subscribeShared } = rm.exports;
  const sets = new Map(); let uniwindSubscribes = 0, disposes = 0;
  fakeInternals.UniwindListener = {
    subscribe: (fn, deps) => { uniwindSubscribes++; deps.forEach((d) => { if (!sets.has(d)) sets.set(d, new Set()); sets.get(d).add(fn); }); return () => { disposes++; deps.forEach((d) => sets.get(d).delete(fn)); }; },
  };
  const notify = (deps) => deps.forEach((d) => (sets.get(d) ?? new Set()).forEach((fn) => fn()));
  const calls = { a: 0, b: 0, c: 0 };
  const depsA = [9], depsSame = [9], depsOther = [3, 9];
  const offA = subscribeShared(() => calls.a++, depsA);
  const offB = subscribeShared(() => calls.b++, depsSame);
  const offC = subscribeShared(() => calls.c++, depsOther);
  ok('subscribeShared: views with the same dependencies share one Uniwind subscription (another list gets its own)', () => { assert.strictEqual(uniwindSubscribes, 2); });
  ok('subscribeShared: a notify reaches every view as often as its own subscription would', () => { notify([9]); assert.deepStrictEqual(calls, { a: 1, b: 1, c: 1 }); notify([3, 9]); assert.deepStrictEqual(calls, { a: 2, b: 2, c: 3 }); });
  ok('subscribeShared: an unsubscribed view is not called, the group stays while a view is left', () => { offA(); notify([9]); assert.deepStrictEqual(calls, { a: 2, b: 3, c: 4 }); assert.strictEqual(disposes, 0); });
  ok('subscribeShared: the last view of a group disposes the Uniwind subscription; a later view subscribes again', () => { offB(); assert.strictEqual(disposes, 1); notify([9]); assert.strictEqual(calls.b, 3); const offD = subscribeShared(() => {}, [9]); assert.strictEqual(uniwindSubscribes, 3); offD(); offC(); assert.strictEqual(disposes, 3); });
  fakeInternals.UniwindListener = { subscribe: () => () => {} };
}

// useEngineRef subscribes from the ref (no layout effect): attach subscribes, detach (unmount, hide) unsubscribes
{
  const sets = new Map();
  fakeInternals.UniwindListener = {
    subscribe: (fn, deps) => { deps.forEach((d) => { if (!sets.has(d)) sets.set(d, new Set()); sets.get(d).add(fn); }); return () => deps.forEach((d) => sets.get(d).delete(fn)); },
  };
  const notify = (d) => (sets.get(d) ?? new Set()).forEach((fn) => fn());
  ok('engine ref: attach subscribes the view, a notify re-renders it, detach unsubscribes', () => { let n = 0; const ref = useEngineRef(st(themedA, [RTL], () => n++), undefined); const node = {}; ref(node); notify(RTL); assert.strictEqual(n, 1); ref(null); notify(RTL); assert.strictEqual(n, 1); });
  ok('engine ref: engine inactive (no themed styles) with dependencies, the ref subscribes and forwards, nothing registers', () => { let n = 0; engineCalls.length = 0; const user = { current: null }; const ref = useEngineRef(st(null, [THEME], () => n++), user); assert.notStrictEqual(ref, user); const node = {}; ref(node); assert.strictEqual(user.current, node); notify(THEME); assert.strictEqual(n, 1); assert.deepStrictEqual(engineCalls, []); ref(null); assert.strictEqual(user.current, null); notify(THEME); assert.strictEqual(n, 1); });
  ok('engine ref: only the dependencies change, the binding stays (no unregister) and the new list is subscribed', () => { hooks.ref = { current: null }; let n = 0; const rr = () => n++; const node = {}; const first = useEngineRef(st(themedA, [RTL], rr), undefined); first(node); engineCalls.length = 0; const second = useEngineRef(st(themedA, [RTL, 3], rr), undefined); assert.notStrictEqual(second, first); first(null); second(node); assert.ok(!engineCalls.some((c) => c[0] === 'unregister')); notify(3); assert.strictEqual(n, 1); second(null); hooks.ref = null; });
  ok('engine ref: other themed styles (className changed), the old binding is unbound on detach as before', () => { hooks.ref = { current: null }; const node = {}; const first = useEngineRef(st(themedA, [RTL]), undefined); first(node); engineCalls.length = 0; useEngineRef(st(themedB, [RTL]), undefined); first(null); hooks.ref = null; assert.ok(engineCalls.some((c) => c[0] === 'unregister' && c[1] === node)); });
  fakeInternals.UniwindListener = { subscribe: () => () => {} };
}

// withUniwind: the wrapped component may ignore `ref`, so it subscribes with a layout effect and the ref only binds the engine
{
  const { useEffectSubscription, NO_DEPS } = rm.exports;
  ok('withUniwind path: the effect subscribes even if the ref never attaches; the ref with NO_DEPS does not subscribe again', () => { hooks.effects.length = 0; const styled = { themed: null, deps: [THEME], rerender: () => {}, onRegisterFailed: undefined }; useEffectSubscription(styled); assert.strictEqual(hooks.effects.length, 1); assert.deepStrictEqual(hooks.effects[0], [[THEME]]); const user = () => {}; assert.strictEqual(useEngineRef({ ...styled, deps: NO_DEPS }, user), user); });
}

// withUniwind (src/uniwind/withUniwind.tsx): className is resolved there and goes down as `style` only. Forwarded as well, the host view
// inside an icon (its Text) resolves it a second time, finds the colours in the inline style and re-renders on every switch.
{
  const wuSrc = ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'uniwind', 'withUniwind.tsx'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  const wm = new Module('withUniwind'); wm.paths = [];
  const created = [];
  const wuStubs = {
    react: { createElement: (type, props) => { created.push({ type, props }); return { type, props }; } },
    'uniwind-internal/hoc/withUniwind.native': { withUniwind: (component) => component },
    './native': { withUserStyle: (style, user) => ({ style, user }) },
    './useShadewindStyle': { NO_DEPS: [], useEffectSubscription: () => {}, useEngineRef: (_styled, ref) => ref ?? 'engine-ref', useShadewindStyle: () => ({ style: { color: 'red' }, themed: null, deps: [] }) },
  };
  wm.require = (name) => { if (name in wuStubs) return wuStubs[name]; throw new Error('unexpected import ' + name); };
  wm._compile(wuSrc.replace(/require\(/g, 'module.require('), 'withUniwind.js');
  const Inner = () => null;
  const Wrapped = wm.exports.withUniwind(Inner);
  const render = (props) => { created.length = 0; Wrapped(props); const engine = created[0]; return engine.type(engine.props), created[1]; };
  ok('withUniwind: the wrapped component gets the resolved style and no className', () => {
    const host = render({ className: 'text-brand', testID: 'icon', style: { margin: 1 } });
    assert.strictEqual(host.type, Inner);
    assert.ok(!('className' in host.props), 'className is not forwarded');
    assert.deepStrictEqual(host.props.style, { style: { color: 'red' }, user: { margin: 1 } });
    assert.strictEqual(host.props.testID, 'icon');
  });
  ok('withUniwind: without a className the props go through as they are', () => {
    const host = render({ testID: 'icon', style: { margin: 1 } });
    assert.deepStrictEqual(host.props.style, { margin: 1 });
  });
}

// src/uniwind/nativeResolver.ts: a fresh module per check (it keeps module state), a fake engine and a fake Uniwind store
{
  const resolverSrc = ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'uniwind', 'nativeResolver.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText.replace(/require\(/g, 'module.require(');
  globalThis.requestIdleCallback = (cb) => cb();
  globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
  const fresh = (loadResult = { ok: true, classes: 3, unsupported: 0 }) => {
    const mod = new Module('nativeResolver'); mod.paths = [];
    mod.require = (name) => {
      if (name === '../internal') return { ShadewindEngine: { loadStyleTable: () => loadResult } };
      if (name === './styleTable') return { buildStyleTable: () => ({ json: '{"t":1}', fallback: 0 }) };
      throw new Error('unexpected import ' + name);
    };
    mod._compile(resolverSrc, 'nativeResolver.js');
    const listeners = [];
    const proto = { resolveStyles() { return { styles: { from: 'uniwind' }, dependencies: [] }; } };
    const store = Object.assign(Object.create(proto), { stylesheet: {}, vars: { light: {}, dark: {} }, runtime: { currentThemeName: 'light', screen: { width: 400 } } });
    const listener = { subscribe: (fn) => { listeners.push(fn); return () => {}; }, getSnapshot: () => 0 };
    const notifyAll = () => listeners.forEach((fn) => fn());
    return { api: mod.exports, store, listener, notifyAll };
  };
  const NO_SCOPE = { scopedTheme: null, variables: null };
  globalThis.__swResolve = (className) => (className === 'unknown' ? undefined : { styles: { from: 'native' }, dependencies: [] });
  ok('nativeResolver: a table built while disabled reads off, and ready once enabled (it no longer stays off)', () => {
    const { api, store, listener } = fresh();
    api.installNativeResolver(store, listener, 9);
    api.nativeResolver.setEnabled(false);
    api.nativeResolver.rebuild();
    assert.strictEqual(api.nativeResolver.status().state, 'off');
    assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'uniwind');
    api.nativeResolver.setEnabled(true);
    assert.strictEqual(api.nativeResolver.status().state, 'ready');
    assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'native');
  });
  ok('nativeResolver: a class the table lacks, a scoped theme and scoped variables go to Uniwind', () => {
    const { api, store, listener } = fresh();
    api.installNativeResolver(store, listener, 9);
    api.nativeResolver.rebuild(); // install builds it when the JS thread is idle
    assert.strictEqual(api.nativeResolver.status().state, 'ready');
    assert.strictEqual(store.resolveStyles('unknown', {}, undefined, NO_SCOPE).styles.from, 'uniwind');
    assert.strictEqual(store.resolveStyles('a', {}, undefined, { scopedTheme: 'dark', variables: null }).styles.from, 'uniwind');
    assert.strictEqual(store.resolveStyles('a', {}, undefined, { scopedTheme: null, variables: {} }).styles.from, 'uniwind');
  });
  ok('nativeResolver: Variables, or a CSS reload (reinit replaces the stylesheet, then notifyAll), marks the table stale until the idle rebuild', () => {
    const { api, store, listener, notifyAll } = fresh();
    const realTimeout = globalThis.setTimeout; const pending = []; globalThis.setTimeout = (fn) => { pending.push(fn); return 0; };
    try {
      api.installNativeResolver(store, listener, 9);
      pending.splice(0).forEach((fn) => fn());
      assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'native');
      store.stylesheet = {}; store.vars = { light: {}, dark: {} };
      notifyAll();
      assert.strictEqual(api.nativeResolver.status().state, 'stale');
      assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'uniwind');
      pending.splice(0).forEach((fn) => fn());
      assert.strictEqual(api.nativeResolver.status().state, 'ready');
      assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'native');
    } finally { globalThis.setTimeout = realTimeout; }
  });
  ok('nativeResolver: a table the engine cannot load fails without reporting its classes, and Uniwind keeps resolving', () => {
    const { api, store, listener } = fresh({ ok: false, classes: 7, unsupported: 0, error: 'bad table' });
    api.installNativeResolver(store, listener, 9);
    api.nativeResolver.rebuild();
    const st = api.nativeResolver.status();
    assert.strictEqual(st.state, 'failed'); assert.strictEqual(st.classes, 0); assert.strictEqual(st.error, 'bad table');
    assert.strictEqual(store.resolveStyles('a', {}, undefined, NO_SCOPE).styles.from, 'uniwind');
  });
  delete globalThis.__swResolve;
}

console.log(n + ' checks passed');
