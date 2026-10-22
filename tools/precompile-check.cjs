// Check of withShadewind(config, { precompileClassNames: true }): the Babel plugin (metro-precompile-plugin.cjs, through
// metro-babel-transformer.cjs as Metro calls it) and its runtime (src/uniwind/precompiled.tsx, against Uniwind's real store loaded
// with the app's stylesheet).
//
// Run: node tools/precompile-check.cjs [app dir with node_modules, default example-real] [--print]
//
// 1. Plugin: input -> output for the uniwind-benchmarks elements and for every fallback (printed with --print), with React Native's
//    own Babel transformer behind ours (the app's babel.config.js): the import survives TypeScript's import elision.
// 2. Runtime: a copy of the app (global.css unchanged, plus one source file with classes the app does not use) is compiled with
//    Uniwind's own Metro transformer, loaded into Uniwind's own UniwindStore (dist/common), and the compiled components are rendered
//    with a fake `use` / `jsx`: mode per className, the style object (the adapter's own, from the store), the engine registration.
//    Note: like any Metro start with Uniwind, this rewrites node_modules/uniwind/uniwind.css of the app (same content).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const assert = require('assert');

const repo = path.join(__dirname, '..');
const args = process.argv.slice(2);
const print = args.includes('--print');
const app = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? path.join(repo, 'example-real'));
const fromApp = Module.createRequire(path.join(app, 'package.json'));
const ts = require(path.join(repo, 'node_modules', 'typescript'));

const BENCH_VIEW = 'h-25 w-[32%] items-center justify-center rounded-2xl bg-bench-primary';
const BENCH_TEXT = 'text-2xl font-bold text-bench-typo';

// ---------------------------------------------------------------- 1. the plugin

const babel = fromApp('@babel/core');
const generate = fromApp('@babel/generator').default;
const plugin = require(path.join(repo, 'metro-precompile-plugin.cjs'));

// the plugin alone, JSX kept: what it does, readable
const pluginOnly = (src, filename = 'src/Fixture.tsx') =>
  babel.transformSync(src, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [plugin],
    generatorOpts: { retainLines: false },
  }).code;

const CASES = [
  {
    name: 'uniwind-benchmarks render scenario (RenderBench.tsx)',
    compiled: 2,
    src: `import { ScrollView, Text, View } from 'react-native';
export const Items = ({ n }: { n: number }) => (
  <ScrollView>
    {Array.from({ length: n }, (_, i) => (
      <View key={i} className="${BENCH_VIEW}">
        <Text className="${BENCH_TEXT}">{i}</Text>
      </View>
    ))}
  </ScrollView>
);`,
  },
  {
    name: 'shadewind/uniwind import, renamed, template literal, allowed props, one constant per className',
    compiled: 4,
    src: `import { View as Box, Text } from 'shadewind/uniwind';
export const A = () => (
  <Box className={\`p-3 flex-row\`} testID="a" onLayout={() => {}} pointerEvents="none">
    <Text className={"text-sm"} numberOfLines={1} testID="t">hi</Text>
    <Text className="text-sm" ellipsizeMode="head">again</Text>
    <Box className="p-3 flex-row" />
  </Box>
);`,
  },
  {
    name: 'className expressions (cn(), conditional, variable, template with expressions): one dynamic component per kind',
    compiled: 4,
    src: `import { Text, View } from 'react-native';
import { cn } from './cn';
export const D = (p: { on: boolean; c: string }) => (
  <>
    <View className={cn('p-3', p.on && 'bg-brand')} />
    <View className={p.on ? 'p-3' : 'p-4'} testID="x" />
    <Text className={p.c}>x</Text>
    <View className={\`p-3 \${p.c}\`} />
  </>
);`,
  },
  {
    name: 'fallbacks: nothing compiled',
    compiled: 0,
    src: `import * as RN from 'react-native';
import { Text, View } from 'react-native';
import type { ViewProps } from 'react-native';
import { cn } from './cn';
export const B = (p: ViewProps & { on: boolean; c: string }) => {
  const r = { current: null };
  return (
    <>
      <View {...p} className="p-3" />
      <View className="" />
      <View className="p-3" style={{ opacity: 0.5 }} />
      <View className="p-3" ref={r} />
      <View className="p-3" aria-label="x" />
      <View className="p-3" accessibilityState={{ disabled: true }} />
      <View className="p-3" className="p-4" />
      <Text className="text-sm" onPress={() => {}}>x</Text>
      <Text className="text-sm" disabled>x</Text>
      <Text className="text-sm" selectionColorClassName="accent-brand">x</Text>
      <Text className="text-sm" accessibilityRole="header">x</Text>
      <RN.View className="p-3" />
      <View />
    </>
  );
};
export const C = () => {
  const View = (props: any) => null;
  return <View className="p-3" />;
};`,
  },
];

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(error && error.message).split('\n').join('\n     ')}`);
  }
};

for (const { name, compiled, src } of CASES) {
  const out = pluginOnly(src);
  const count = (out.match(/<_Sw(View|Text)\d*\b/g) ?? []).length;

  if (print) {
    console.log(`\n=== ${name}\n--- in\n${src}\n--- out\n${out}\n`);
  }

  check(`plugin: ${name}: ${compiled} element(s) compiled`, () => {
    assert.strictEqual(count, compiled, out);

    if (compiled === 0) {
      assert.ok(!out.includes('shadewind/uniwind') || src.includes('shadewind/uniwind'), 'no import added');
      assert.ok(!/_sw\b|precompiled/.test(out), 'no runtime reference');
    } else {
      assert.ok(out.includes(`import { precompiled as _sw } from 'shadewind/uniwind';`) || out.includes('precompiled as _sw'));
    }
  });
}

check('plugin: expression classNames keep the attribute and share one component per kind', () => {
  const out = pluginOnly(CASES[2].src);

  assert.strictEqual((out.match(/_sw\.view\(\)/g) ?? []).length, 1, out);
  assert.strictEqual((out.match(/_sw\.text\(\)/g) ?? []).length, 1, out);
  assert.strictEqual((out.match(/className=\{/g) ?? []).length, 4, out);
});

check('plugin: one constant per className and file, className removed, other props kept', () => {
  const out = pluginOnly(CASES[1].src);

  assert.strictEqual((out.match(/_sw\.view\("p-3 flex-row"\)/g) ?? []).length, 1, out);
  assert.strictEqual((out.match(/_sw\.text\("text-sm"\)/g) ?? []).length, 1, out);
  assert.ok(!/className=/.test(out), out);
  assert.ok(out.includes('numberOfLines={1}') && out.includes('ellipsizeMode="head"') && out.includes('pointerEvents="none"'), out);
});

// through metro-babel-transformer.cjs as Metro calls it, React Native's transformer (and the app's babel.config.js) behind it
const metroTransform = async (filename, src, overrides = {}) => {
  const transformer = require(path.join(repo, 'metro-babel-transformer.cjs'));
  const { ast } = await transformer.transform({
    filename,
    src,
    plugins: [],
    options: {
      dev: false,
      hot: false,
      minify: false,
      platform: 'ios',
      projectRoot: app,
      enableBabelRCLookup: true,
      enableBabelRuntime: false,
      experimentalImportSupport: false,
      globalPrefix: '',
      hermesParser: false,
      publicPath: '/assets',
      unstable_transformProfile: 'hermes-stable',
      customTransformOptions: {},
      ...overrides,
    },
  });

  return generate(ast).code;
};

const pipeline = async () => {
  const { withShadewind } = require(path.join(repo, 'metro.cjs'));
  const base = () => ({ transformer: { babelTransformerPath: fromApp.resolve('@react-native/metro-babel-transformer') }, resolver: {} });

  check('metro.cjs: precompileClassNames installs the transformer (even with prebuildStyleTable: false) and sets the flags', () => {
    const on = withShadewind(base(), { precompileClassNames: true, prebuildStyleTable: false });

    assert.ok(on.transformer.babelTransformerPath.endsWith('metro-babel-transformer.cjs'));
    assert.strictEqual(process.env.SHADEWIND_PRECOMPILE_CLASSNAMES, '1');
    assert.strictEqual(process.env.SHADEWIND_PREBUILD_STYLE_TABLE, '0');

    const off = withShadewind(base());

    assert.ok(off.transformer.babelTransformerPath.endsWith('metro-babel-transformer.cjs'));
    assert.strictEqual(process.env.SHADEWIND_PRECOMPILE_CLASSNAMES, '0');
    assert.strictEqual(process.env.SHADEWIND_PREBUILD_STYLE_TABLE, '1');

    const none = withShadewind(base(), { prebuildStyleTable: false });

    assert.ok(!none.transformer.babelTransformerPath.endsWith('metro-babel-transformer.cjs'));
  });

  process.env.SHADEWIND_UPSTREAM_BABEL_TRANSFORMER = fromApp.resolve('@react-native/metro-babel-transformer');
  process.env.SHADEWIND_PRECOMPILE_CLASSNAMES = '1';

  const bench = await metroTransform('src/bench/Fixture.tsx', CASES[0].src);

  if (print) {
    console.log(`\n=== uniwind-benchmarks elements through React Native's Babel transformer\n${bench}\n`);
  }

  check('metro: the runtime import survives TypeScript import elision, both elements use the compiled components', () => {
    assert.ok(/require\("shadewind\/uniwind"\)/.test(bench), bench);
    assert.ok(bench.includes(`.view("${BENCH_VIEW}")`) && bench.includes(`.text("${BENCH_TEXT}")`), bench);
    assert.ok(!bench.includes('className'), bench);
  });

  const nodeModules = await metroTransform('node_modules/some-lib/index.js', CASES[0].src.replace(': { n: number }', ''));
  check('metro: a file in node_modules is not compiled', () => assert.ok(nodeModules.includes('className'), nodeModules));

  const android = await metroTransform('src/bench/Fixture.tsx', CASES[0].src, { platform: 'android' });
  check('metro: android compiled too', () => assert.ok(!android.includes('className'), android));

  const web = await metroTransform('src/bench/Fixture.tsx', CASES[0].src, { platform: 'web' });
  check('metro: web not compiled', () => assert.ok(web.includes('className'), web));

  process.env.SHADEWIND_PRECOMPILE_CLASSNAMES = '0';
  const off = await metroTransform('src/bench/Fixture.tsx', CASES[0].src);
  check('metro: option off, nothing compiled', () => assert.ok(off.includes('className'), off));
  process.env.SHADEWIND_PRECOMPILE_CLASSNAMES = '1';

  const cacheKeys = ['0', '1'].map((value) => {
    process.env.SHADEWIND_PRECOMPILE_CLASSNAMES = value;
    return require(path.join(repo, 'metro-babel-transformer.cjs')).getCacheKey();
  });
  check('metro: the cache key changes with the option', () => assert.notStrictEqual(cacheKeys[0], cacheKeys[1]));
};

// ---------------------------------------------------------------- 2. the runtime

// a copy of the app next to its node_modules, plus classes the app does not use (Tailwind compiles what it finds in the sources)
const EXTRA_CLASSES = [
  'md:p-4 p-1',
  'data-[on=true]:bg-brand',
  'landscape:p-2',
  'dark:p-4 p-1',
  'line-clamp-2',
  'select-none',
  'active:bg-brand bg-card',
  'pt-safe',
];

const compileStylesheet = async () => {
  // real path: Uniwind compares the CSS entry under process.cwd() (always real) with Metro's project root
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shadewind-precompile-')));

  for (const file of ['global.css', 'package.json']) {
    fs.copyFileSync(path.join(app, file), path.join(work, file));
  }

  fs.cpSync(path.join(app, 'src'), path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'precompileExtra.ts'), `export const EXTRA = ${JSON.stringify(EXTRA_CLASSES)};\n`);
  fs.symlinkSync(path.join(app, 'node_modules'), path.join(work, 'node_modules'));

  const capture = path.join(work, 'capture.cjs');
  const captured = path.join(work, 'css.ios.js');

  fs.writeFileSync(
    capture,
    `const fs = require('fs');
module.exports = {
  transform(args) { fs.writeFileSync(${JSON.stringify(captured)}, args.src); return { ast: null }; },
  getCacheKey: () => 'capture',
};\n`
  );

  const previous = process.cwd();
  process.chdir(work); // Uniwind finds the CSS entry from the working directory

  try {
    const fromWork = Module.createRequire(path.join(work, 'package.json'));
    const { getDefaultConfig } = fromWork('@react-native/metro-config');
    const { withUniwindConfig } = fromWork('uniwind/metro');
    const config = withUniwindConfig(getDefaultConfig(work), { cssEntryFile: './global.css' });

    await fromWork(config.transformerPath)
      .transform(
        { ...config.transformer, babelTransformerPath: capture },
        work,
        'global.css',
        fs.readFileSync(path.join(work, 'global.css')),
        {
          dev: false,
          hot: false,
          minify: false,
          platform: 'ios',
          type: 'module',
          unstable_transformProfile: 'hermes-stable',
          customTransformOptions: {},
          experimentalImportSupport: false,
          inlineRequires: false,
          inlinePlatform: true,
        }
      )
      .catch((error) => {
        // the capture returns no AST, so the rest of Metro's worker fails after the source was written
        if (!fs.existsSync(captured)) {
          throw error;
        }
      });
  } finally {
    process.chdir(previous);
  }

  const src = fs.readFileSync(captured, 'utf8');

  if (process.env.KEEP_PRECOMPILE_WORK) {
    console.log(`work copy kept: ${work}`);
  } else {
    fs.rmSync(work, { recursive: true, force: true });
  }

  return src;
};

// stand-ins by request name, for Uniwind's dist and for the compiled sources
const stubs = new Map();
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs.has(request)) {
    return `stub:${request}`;
  }

  // the compiled sources' relative imports that are stood in for (./install, ./View, ./Text)
  if (
    parent &&
    parent.filename &&
    parent.filename.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'shadewind-precompile-src-')) &&
    stubs.has(`local:${request}`)
  ) {
    return `stub:local:${request}`;
  }

  return resolveFilename.call(this, request, parent, ...rest);
};

const stub = (request, exports) => {
  stubs.set(request, exports);
  require.cache[`stub:${request}`] = { id: `stub:${request}`, filename: `stub:${request}`, loaded: true, exports };
};

const runtime = async () => {
  const cssModule = await compileStylesheet();

  const createContext = (value) => ({ $$default: value });
  const TextAncestorContext = createContext(false);
  const UniwindContext = createContext({ scopedTheme: null, rtl: null, variables: null });
  const provided = new Map();
  const use = (context) => (provided.has(context) ? provided.get(context) : context.$$default);

  global.__DEV__ = false;
  // production by default (cachedPlan shares one plan per store result with the adapter's views); --print collects the decisions
  globalThis.__SHADEWIND_DEBUG__ = print;

  const rn = {
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    Appearance: { getColorScheme: () => 'light' },
    PixelRatio: { getFontScale: () => 1, get: () => 3 },
    StyleSheet: { hairlineWidth: 1 / 3, flatten: (style) => style },
    I18nManager: { isRTL: false },
    processColor: (c) => (/^#[0-9a-f]{6}$/i.test(c) ? (0xff000000 | parseInt(c.slice(1), 16)) >>> 0 : c === 'white' ? 0xffffffff : 0xff111111),
    Platform: { OS: 'ios', isTV: false },
  };

  stub('react-native', rn);
  // useRef: the record of the view being rendered; a test that renders one view several times keeps `instance` (see `view()` below)
  let instance = { current: null };
  const newInstance = () => (instance = { current: null });
  stub('react', { use, createContext, useLayoutEffect() {}, useReducer() {}, useRef: () => instance });
  stub('react/jsx-runtime', { jsx: (type, props) => ({ type, props }) });
  stub('react-native/Libraries/Components/View/ViewNativeComponent', { default: 'RCTView' });
  stub('react-native/Libraries/Text/TextNativeComponent', { NativeText: 'RCTText' });
  stub('react-native/Libraries/Text/TextAncestorContext', { default: TextAncestorContext });
  stub('react-native/src/private/featureflags/ReactNativeFeatureFlags', { defaultTextToOverflowHidden: () => true });
  stub('uniwind-internal/core/context', { UniwindContext, useUniwindContext: () => use(UniwindContext) });

  const registered = [];
  const unregistered = [];
  stub('shadewind/internal', {
    ShadewindEngine: {
      register: (node, themed, renderTheme, force = false) => (registered.push({ node, themed, renderTheme, force }), true),
      unregister: (node) => unregistered.push(node),
      label() {},
    },
  });

  // Uniwind's own store, loaded with the app's stylesheet as Uniwind.__reinit does
  const uniwindDist = path.join(path.dirname(fromApp.resolve('uniwind/package.json')), 'dist', 'common');
  const loadJs = Module._extensions['.js'];

  // dist/common is CommonJS in a "type": "module" package
  Module._extensions['.js'] = function (module, filename) {
    if (filename.startsWith(uniwindDist + path.sep)) {
      return module._compile(fs.readFileSync(filename, 'utf8'), filename, 'commonjs');
    }

    return loadJs.call(this, module, filename);
  };

  const { UniwindStore } = require(path.join(uniwindDist, 'core', 'native', 'store.js'));
  const { UniwindListener } = require(path.join(uniwindDist, 'core', 'listener.js'));
  const { StyleDependency } = require(path.join(uniwindDist, 'common', 'consts.js'));
  let reinit = null;

  new Function('require', cssModule)(() => ({ Uniwind: { __reinit: (generate, themes) => (reinit = { generate, themes }) } }));
  UniwindStore.reinit(reinit.generate, reinit.themes);

  const internals = { UniwindStore, UniwindListener, StyleDependency };
  let active = true;

  stub('local:./install', { getInternals: () => internals, installUniwind: () => ({ active }) });
  stub('local:./View', { View: 'AdapterView' });
  stub('local:./Text', { Text: 'AdapterText' });

  // the sources, compiled with TypeScript (no type check: tsc does that)
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shadewind-precompile-src-')));

  for (const name of ['precompiled.tsx', 'useShadewindStyle.ts', 'native.ts', 'styleCache.ts', 'styleTable.ts', 'uniwindAccess.ts']) {
    const source = fs.readFileSync(path.join(repo, 'src', 'uniwind', name), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: name,
    });

    fs.writeFileSync(path.join(out, name.replace(/\.tsx?$/, '.js')), outputText);
  }

  const { precompiled } = require(path.join(out, 'precompiled.js'));
  const { nativeTextStyle } = require(path.join(out, 'native.js'));
  const { decisions } = require(path.join(out, 'useShadewindStyle.js'));
  const ROOT = { scopedTheme: null, rtl: null, variables: null };
  const adapterStyle = (className, state) => UniwindStore.getStyles(className, {}, state, ROOT).styles;
  const TEXT_STATE = { isPressed: false, isDisabled: false };

  UniwindStore.runtime.currentThemeName = 'light';

  const BenchView = precompiled.view(BENCH_VIEW);
  const BenchText = precompiled.text(BENCH_TEXT);

  const DynView = precompiled.view();
  const DynText = precompiled.text();

  check('runtime: className expression -> resolved per string, className not passed to the host, adapter style object', () => {
    const a = DynView({ className: BENCH_VIEW, testID: 'a' });

    assert.strictEqual(a.type, 'RCTView');
    assert.deepStrictEqual(a.props.style, adapterStyle(BENCH_VIEW));
    assert.strictEqual(a.props.testID, 'a');
    assert.ok(!('className' in a.props), 'className stays out of the host props');
    assert.strictEqual(DynView({ className: BENCH_VIEW }).props.style, a.props.style, 'the same string, the same style object');

    const b = DynView({ className: 'p-3 flex-row' });

    assert.deepStrictEqual(b.props.style, adapterStyle('p-3 flex-row'));
    assert.notStrictEqual(b.props.style, a.props.style);
    assert.strictEqual(DynText({ className: BENCH_TEXT, children: 'x' }).type, 'RCTText');
  });

  check('runtime: an expression className that toggles keeps the element type (no remount): value, undefined, false, empty', () => {
    const type = DynView({ className: 'p-3 flex-row' }).type;

    for (const className of [undefined, false, '', '  ', BENCH_VIEW]) {
      assert.strictEqual(DynView({ className, testID: 'x' }).type, type, String(className));
    }

    const empty = DynView({ className: undefined, testID: 'x' });

    assert.strictEqual(empty.props.style, undefined);
    assert.strictEqual(empty.props.testID, 'x');
    assert.ok(!('className' in empty.props));

    const textType = DynText({ className: 'text-sm' }).type;

    assert.strictEqual(DynText({ className: undefined, children: 'x' }).type, textType);
    assert.strictEqual(DynText({ className: undefined, children: 'x' }).props.style.overflow, 'hidden');
  });

  check('runtime: an expression className with no value, in a Text / scoped theme -> the adapter', () => {
    assert.strictEqual(DynText({ className: undefined, onPress: () => {} }).type, 'AdapterText');
  });

  check('runtime: an expression className that changes on a bound view: the old binding is dropped when React detaches the old ref, before the commit', () => {
    const node = {};
    const engineA = BENCH_VIEW;
    const engineB = 'bg-card';

    // one simulated view: render, then let React call the old ref with null (mutation phase) and the new ref with the node (layout phase)
    const swap = (from, to) => {
      const before = DynView({ className: from }).props.ref;
      const after = DynView({ className: to }).props.ref;

      return { before, after };
    };

    newInstance();
    registered.length = 0;
    unregistered.length = 0;

    const first = DynView({ className: engineA }).props.ref;

    first(node);
    assert.strictEqual(registered.length, 1);

    // ENGINE -> STATIC
    const toStatic = DynView({ className: 'p-3 flex-row' }).props.ref;

    assert.strictEqual(toStatic, undefined, 'a static className carries no ref');
    first(null); // React detaches the old ref
    assert.deepStrictEqual(unregistered, [node], 'unregistered at the detach');

    // empty value -> no ref either; a view bound again and then emptied drops its binding
    newInstance();
    registered.length = 0;
    unregistered.length = 0;

    const bound = DynView({ className: engineA }).props.ref;

    bound(node);
    assert.strictEqual(DynView({ className: undefined }).props.ref, undefined);
    bound(null);
    assert.deepStrictEqual(unregistered, [node], 'unregistered by the empty value');

    // ENGINE A -> ENGINE B: A's ref detaches (unregister), B's ref attaches as a first attach with the render theme
    newInstance();
    registered.length = 0;
    unregistered.length = 0;

    const a = DynView({ className: engineA }).props.ref;

    a(node);

    const b = DynView({ className: engineB }).props.ref;

    assert.notStrictEqual(a, b);
    a(null);
    assert.deepStrictEqual(unregistered, [node], 'the old binding is dropped before the new one');
    b(node);
    assert.strictEqual(registered.length, 2);
    assert.notStrictEqual(registered[0].themed, registered[1].themed);
    assert.strictEqual(registered[1].renderTheme, 'light', 'a first attach: React rendered this theme');

    // the same className re-rendered under another theme (its parent re-rendered during a switch): not dropped, registered again (forced)
    newInstance();
    const fresh = {};
    registered.length = 0;
    unregistered.length = 0;

    const light = DynView({ className: engineA }).props.ref;

    light(fresh);
    UniwindStore.runtime.currentThemeName = 'dark';

    try {
      const dark = DynView({ className: engineA }).props.ref;

      assert.notStrictEqual(light, dark, 'another theme, another ref');
      light(null);
      assert.deepStrictEqual(unregistered, [], 'a re-render under another theme does not unregister');
      dark(fresh);
      assert.strictEqual(registered.length, 2);
      assert.strictEqual(registered[1].renderTheme, undefined);
      assert.strictEqual(registered[1].force, true, 'forced: React gave the view new props');
    } finally {
      UniwindStore.runtime.currentThemeName = 'light';
    }

    // a hide or an unmount (the ref is still the newest) keeps the binding
    unregistered.length = 0;
    b(null);
    assert.deepStrictEqual(unregistered, [], 'a plain detach keeps the binding');
    void swap;
  });

  check('runtime: benchmark View -> host View, the adapter\'s style object, bound to the engine', () => {
    const element = BenchView({ children: 'x' });

    assert.strictEqual(element.type, 'RCTView');
    assert.deepStrictEqual(element.props.style, adapterStyle(BENCH_VIEW));
    assert.strictEqual(element.props.style.backgroundColor, '#00a8ff');
    assert.strictEqual(element.props.children, 'x');

    const node = {};

    registered.length = 0;
    element.props.ref(node);
    element.props.ref(node); // a re-attach: no render theme
    assert.deepStrictEqual(
      registered.map(({ node: n, themed, renderTheme, force }) => [n === node, themed, renderTheme, force]),
      [
        [true, { light: { backgroundColor: '#00a8ff' }, dark: { backgroundColor: '#273c75' } }, 'light', false],
        [true, { light: { backgroundColor: '#00a8ff' }, dark: { backgroundColor: '#273c75' } }, undefined, false],
      ]
    );
  });

  check('runtime: benchmark Text -> host Text with the direct path\'s props, bound to the engine', () => {
    const element = BenchText({ children: 7 });

    assert.strictEqual(element.type, 'RCTText');
    assert.deepStrictEqual(element.props.style, nativeTextStyle(adapterStyle(BENCH_TEXT, TEXT_STATE)));
    assert.strictEqual(element.props.style.fontWeight, '700');
    assert.strictEqual(element.props.style.overflow, 'hidden');
    assert.strictEqual(element.props.style.color, '#000000');
    assert.strictEqual(element.props.accessible, true);
    assert.strictEqual(element.props.allowFontScaling, true);
    assert.strictEqual(element.props.ellipsizeMode, 'tail');

    registered.length = 0;
    element.props.ref({});
    assert.deepStrictEqual(registered[0].themed, { light: { color: '#000000' }, dark: { color: '#ffffff' } });
    assert.strictEqual(registered[0].renderTheme, 'light');
  });

  check('runtime: after a theme switch a new render takes that theme\'s style and ref', () => {
    UniwindStore.runtime.currentThemeName = 'dark';

    try {
      const element = BenchView({});

      assert.deepStrictEqual(element.props.style, adapterStyle(BENCH_VIEW));
      assert.strictEqual(element.props.style.backgroundColor, '#273c75');
      registered.length = 0;
      element.props.ref({});
      assert.strictEqual(registered[0].renderTheme, 'dark');
      assert.strictEqual(registered[0].force, false);
    } finally {
      UniwindStore.runtime.currentThemeName = 'light';
    }
  });

  // The theme screen's regression: its parent re-renders every view between switches. A view React re-rendered under another theme
  // (new props) must be registered again, so the engine prewarms its per-theme props from React's new ones; a view attached again
  // under the same theme (a reveal) must not.
  check('runtime: a view re-rendered under another theme is registered again (forced, no render theme); a re-attach is not', () => {
    const node = {};
    const renderIn = (theme) => {
      UniwindStore.runtime.currentThemeName = theme;

      try {
        return BenchView({});
      } finally {
        UniwindStore.runtime.currentThemeName = 'light';
      }
    };
    const light = renderIn('light');
    const dark = renderIn('dark');

    assert.notStrictEqual(light.props.ref, dark.props.ref, 'one ref per theme');
    assert.strictEqual(renderIn('light').props.ref, light.props.ref, 'the same ref for the same theme (React does not call it again)');

    registered.length = 0;
    light.props.ref(node); // mount under light
    light.props.ref(null);
    dark.props.ref(node); // the parent re-rendered after a switch to dark
    dark.props.ref(null);
    dark.props.ref(node); // a reveal: same ref again
    light.props.ref(null);
    light.props.ref(node); // re-rendered after the switch back
    assert.deepStrictEqual(
      registered.map(({ renderTheme, force }) => [renderTheme, force]),
      [
        ['light', false],
        [undefined, true],
        [undefined, false],
        [undefined, true],
      ]
    );
  });

  check('runtime: same in every theme -> host View, no ref', () => {
    const element = precompiled.view('flex-row items-center p-3')({});

    assert.strictEqual(element.type, 'RCTView');
    assert.strictEqual(element.props.ref, undefined);
    assert.deepStrictEqual(element.props.style, { flexDirection: 'row', alignItems: 'center', padding: 12 });
  });

  check('runtime: differs between themes in what the engine cannot paint -> the adapter (it re-renders the view on a theme switch)', () => {
    const element = precompiled.view('dark:p-4 p-1')({});

    assert.strictEqual(element.type, 'AdapterView');
    assert.strictEqual(element.props.className, 'dark:p-4 p-1');
  });

  const adapterFallback = (Component, props, expected) => {
    const element = Component(props);

    assert.strictEqual(element.type, expected, JSON.stringify(element));
    assert.ok(typeof element.props.className === 'string');

    return element;
  };

  for (const [className, why] of [
    ['md:p-4 p-1', 'breakpoint (Dimensions)'],
    ['data-[on=true]:bg-brand', 'data attribute'],
    ['landscape:p-2', 'orientation'],
    ['pt-safe', 'insets'],
  ]) {
    check(`runtime: ${why} -> the adapter's View`, () => adapterFallback(precompiled.view(className), {}, 'AdapterView'));
  }

  check('runtime: a Text style that needs Text.js (line clamp, userSelect) -> the adapter\'s Text', () => {
    adapterFallback(precompiled.text('line-clamp-2'), { children: 'x' }, 'AdapterText');
    adapterFallback(precompiled.text('select-none'), { children: 'x' }, 'AdapterText');
  });

  check('runtime: a Text with element children -> the adapter\'s Text', () =>
    adapterFallback(BenchText, { children: { type: 'X', props: {} } }, 'AdapterText'));

  check('runtime: inside a Text, in a scoped theme, with scoped variables -> the adapter\'s component', () => {
    provided.set(TextAncestorContext, true);
    adapterFallback(BenchView, {}, 'AdapterView');
    adapterFallback(BenchText, { children: 'x' }, 'AdapterText');
    provided.delete(TextAncestorContext);

    provided.set(UniwindContext, { scopedTheme: 'dark', rtl: null, variables: null });
    adapterFallback(BenchView, {}, 'AdapterView');
    provided.set(UniwindContext, { scopedTheme: null, rtl: null, variables: { '--x': 1 } });
    adapterFallback(BenchView, {}, 'AdapterView');
    provided.delete(UniwindContext);

    assert.strictEqual(BenchView({}).type, 'RCTView');
  });

  check('runtime: an active: variant on a View resolves as the adapter\'s View does (never pressed)', () => {
    const element = precompiled.view('active:bg-brand bg-card')({});

    assert.strictEqual(element.type, 'RCTView');
    assert.deepStrictEqual(element.props.style, adapterStyle('active:bg-brand bg-card'));
  });

  check('runtime: updateCSSVariables -> views rendered after it get the new value (mounted ones are not re-rendered)', () => {
    const before = BenchView({}).props.style;
    const light = UniwindStore.vars.light;
    const previous = Object.getOwnPropertyDescriptor(light, '--color-bench-primary');

    light['--color-bench-primary'] = () => '#ff0000';
    UniwindListener.notify([StyleDependency.Variables]);

    try {
      const after = BenchView({}).props.style;

      assert.strictEqual(before.backgroundColor, '#00a8ff');
      assert.strictEqual(after.backgroundColor, '#ff0000');
      assert.deepStrictEqual(after, adapterStyle(BENCH_VIEW));
    } finally {
      Object.defineProperty(light, '--color-bench-primary', previous);
      UniwindListener.notify([StyleDependency.Variables]);
    }
  });

  check('runtime: a Variables change that makes a bound className static unbinds a view when it re-renders', () => {
    const bound = {};

    BenchView({}).props.ref(bound);

    const dark = UniwindStore.vars.dark;
    const previous = Object.getOwnPropertyDescriptor(dark, '--color-bench-primary');

    dark['--color-bench-primary'] = () => '#00a8ff'; // the light value: the same in every theme now
    UniwindListener.notify([StyleDependency.Variables]);

    try {
      const element = BenchView({});

      unregistered.length = 0;
      assert.strictEqual(element.type, 'RCTView');
      assert.strictEqual(typeof element.props.ref, 'function');
      assert.strictEqual(element.props.style.backgroundColor, '#00a8ffff', 'the unbound render sends the colour again (the engine painted the dark one)');
      element.props.ref(bound);
      element.props.ref({}); // never bound: nothing to do
      assert.deepStrictEqual(unregistered, [bound]);
      assert.strictEqual(precompiled.view('flex-row items-center p-3')({}).props.ref, undefined);
    } finally {
      Object.defineProperty(dark, '--color-bench-primary', previous);
      UniwindListener.notify([StyleDependency.Variables]);
    }

    assert.strictEqual(BenchView({}).props.style.backgroundColor, '#00a8ff');
    registered.length = 0;
    BenchView({}).props.ref(bound);
    assert.strictEqual(registered.length, 1, 'bound again');
  });

  check('runtime: an expression className that was bound and is static now sends its colours again, on every such render (StrictMode), and a never-bound one does not', () => {
    const view = newInstance();
    const first = DynView({ className: BENCH_VIEW });

    assert.strictEqual(first.props.style.backgroundColor, '#00a8ff');
    assert.strictEqual(typeof first.props.ref, 'function', 'bound');

    const dark = UniwindStore.vars.dark;
    const previous = Object.getOwnPropertyDescriptor(dark, '--color-bench-primary');

    dark['--color-bench-primary'] = () => '#00a8ff';
    UniwindListener.notify([StyleDependency.Variables]);

    try {
      const a = DynView({ className: BENCH_VIEW });
      const b = DynView({ className: BENCH_VIEW }); // the same render again

      assert.strictEqual(a.props.ref, undefined);
      assert.strictEqual(a.props.style.backgroundColor, '#00a8ffff');
      assert.strictEqual(b.props.style.backgroundColor, '#00a8ffff');
      assert.strictEqual(b.props.style, a.props.style, 'one object per style');
      assert.strictEqual(a.props.style.width, adapterStyle(BENCH_VIEW).width, 'the other properties are untouched');

      newInstance(); // another view, never bound
      assert.strictEqual(DynView({ className: BENCH_VIEW }).props.style.backgroundColor, '#00a8ff');
    } finally {
      Object.defineProperty(dark, '--color-bench-primary', previous);
      UniwindListener.notify([StyleDependency.Variables]);
      newInstance();
    }
  });

  check('runtime: engine inactive -> the adapter\'s components', () => {
    active = false;

    try {
      // a resolution made while active is kept until a Variables change: drop it as a new module would
      adapterFallback(precompiled.view(BENCH_VIEW), {}, 'AdapterView');
      adapterFallback(precompiled.text(BENCH_TEXT), { children: 'x' }, 'AdapterText');
    } finally {
      active = true;
    }
  });

  check('style table: a Uniwind whose styles are matches() functions (1.13) is refused with a reason, not turned into an empty table', () => {
    const { buildStyleTable } = require(path.join(out, 'styleTable.js'));
    const input = (style) => ({ stylesheet: { 'p-3': [style] }, varsByTheme: {}, themes: [], runtime: { currentThemeName: 'light' } });

    assert.throws(
      () => buildStyleTable(input({ entries: [], matches: () => true, hasDataAttributes: false, importantComplexity: 0, complexity: 1 })),
      /matches\(\) functions/
    );
  });

  // Uniwind's style cache, bounded from inside shadewind (styleCache.ts): the same results, a bound, one listener per dependency
  check('style cache: same results as Uniwind\'s own, bounded, no listener per entry, invalidated by its dependencies', () => {
    const { installBoundedStyleCache } = require(path.join(out, 'styleCache.js'));
    const prototype = Object.getPrototypeOf(UniwindStore);
    const original = (className, state, context = ROOT) => prototype.getStyles.call(UniwindStore, className, {}, state, context);
    const classNames = ['bg-card', 'p-3 flex-row', 'text-xl font-bold text-primary', 'h-25 w-[32%] bg-bench-primary', 'dark:bg-black', 'active:bg-brand bg-card', 'md:p-4 p-1'];
    const states = [undefined, { isPressed: true, isDisabled: false }, { isPressed: false, isDisabled: true }];
    const expected = [];

    for (const theme of ['light', 'dark']) {
      UniwindStore.runtime.currentThemeName = theme;

      for (const className of classNames) {
        for (const state of states) {
          const { styles, dependencies, dependencySum } = original(className, state);

          expected.push([theme, className, state, JSON.stringify(styles), JSON.stringify(dependencies), dependencySum]);
        }
      }
    }

    UniwindStore.runtime.currentThemeName = 'light';

    const limit = 8;
    const listeners = () => Object.values(UniwindListener.listeners).map((set) => set.size);

    assert.strictEqual(installBoundedStyleCache(UniwindStore, UniwindListener, StyleDependency, limit), true);
    assert.strictEqual(installBoundedStyleCache(UniwindStore, UniwindListener, StyleDependency, limit), true, 'idempotent');

    for (const [theme, className, state, styles, dependencies, dependencySum] of expected) {
      UniwindStore.runtime.currentThemeName = theme;

      const result = UniwindStore.getStyles(className, {}, state, ROOT);

      assert.strictEqual(JSON.stringify(result.styles), styles, `${theme} ${className}`);
      assert.strictEqual(JSON.stringify(result.dependencies), dependencies, `${theme} ${className}`);
      assert.strictEqual(result.dependencySum, dependencySum, `${theme} ${className}`);
    }

    UniwindStore.runtime.currentThemeName = 'light';
    assert.strictEqual(UniwindStore.getStyles(undefined, {}, undefined, ROOT), UniwindStore.getStyles('', {}, undefined, ROOT), 'the one empty result');

    // a hit is the same object
    const first = UniwindStore.getStyles('bg-card', {}, undefined, ROOT);

    assert.strictEqual(UniwindStore.getStyles('bg-card', {}, undefined, ROOT), first);

    // bounded, and no listener per entry
    const before = listeners();

    for (let i = 1; i <= 300; i++) {
      UniwindStore.getStyles(`w-[${i}px] bg-card`, {}, undefined, ROOT);
    }

    // the theme the entries were made in is bounded (the other theme's Map keeps what it held before the limit existed)
    assert.ok(UniwindStore.cache.light.size <= limit, `light cache size ${UniwindStore.cache.light.size}`);
    assert.deepStrictEqual(listeners(), before, 'the number of listeners does not depend on the number of classNames');

    // the dependencies invalidate: a theme-dependent entry is resolved again after the Theme notification
    const themed = UniwindStore.getStyles('bg-card', {}, undefined, ROOT);

    assert.strictEqual(UniwindStore.getStyles('bg-card', {}, undefined, ROOT), themed);
    UniwindListener.notify([StyleDependency.Theme]);
    assert.notStrictEqual(UniwindStore.getStyles('bg-card', {}, undefined, ROOT), themed, 'resolved again after the theme notification');

    // not Uniwind 1.12's store shape: left alone
    const fake = { getStyles() {}, cache: { light: {} } };

    assert.strictEqual(require(path.join(out, 'styleCache.js')).installBoundedStyleCache(fake, UniwindListener, StyleDependency), true, 'already installed on the module');
  });

  if (print) {
    console.log('\ndecisions:');
    for (const [key, value] of decisions) {
      if (key.startsWith('precompiled')) {
        console.log(`  ${key} -> ${value}`);
      }
    }
  }

  fs.rmSync(out, { recursive: true, force: true });
};

(async () => {
  await pipeline();
  await runtime();
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
