// Golden fixture for the native class resolver (cpp/css/StyleResolver.hpp), from Uniwind itself:
//
// 1. compiles an app's global.css with Uniwind's own bundler (Tailwind scan of the app's sources included), as its Metro
//    transformer does for iOS; the copy of the app gets a third theme and a source file with the variants the app does not use
//    (responsive, theme, focus / disabled, important, relative line heights, classes the table cannot hold),
// 2. loads the result into Uniwind's own UniwindStore,
// 3. builds the native table with src/uniwind/styleTable.ts (the code the app runs), twice: as the device builds it (from Uniwind's
//    store), and as shadewind/metro builds it at bundle time (the app's Metro config, getDefaultConfig -> withUniwindConfig ->
//    withShadewind, and Uniwind's own Metro transformer on the CSS entry, with React Native's Babel transformer behind ours): the
//    two must be equal except for the classes that read the pixel ratio or hairline width (unknown at bundle time),
// 4. resolves every className literal (the app's, the extra file's), every ordered pair of classes that set the same property
//    (precedence) and random combinations with Uniwind's own resolveStyles, for every theme, interaction state and five screen
//    widths (Tailwind's breakpoints exactly, and below them).
//
// Run from a directory whose node_modules has uniwind@1.12.0, tailwindcss@4.3.3, esbuild, metro@0.84.6 (with metro-config and
// metro-transform-worker) and @react-native/metro-config@0.86.2, after building the package (bob build: the Metro transformer
// loads lib/module):
//   node <repo>/cpp/harness/fixtures/resolver/generate.mjs <repo> [app dir, default example-real]
// Writes table.json (the device's table), table.prebuilt.json (the bundle's), cases.jsonl and summary.json next to this script.
//
// cases.jsonl: a header line {themes, widths, states}, then one line per className: {c, fb, pfb (falls back with the prebuilt
// table)} and, when it does not fall back,
// `u` (the distinct results) and `i` (for each theme, width and state in header order, the index of its result in `u`). A result
// is {styles: [[key, value]] in key order, deps, sum, data}; undefined, NaN and ±Infinity values are {"$u":1}, {"$nan":1} and
// {"$inf":±1}, as in the table.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const app = path.resolve(repo, process.argv[3] ?? 'example-real');
const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
// esbuild comes from the working directory's node_modules, like everything else this script runs
const { build } = createRequire(path.join(cwd, 'package.json'))('esbuild');
const modules = path.join(cwd, 'node_modules');
const uniwind = path.join(modules, 'uniwind');
const uniwindVersion = JSON.parse(fs.readFileSync(path.join(uniwind, 'package.json'), 'utf8')).version;

// ---- the app, copied next to node_modules so `@import "tailwindcss"` resolves and Tailwind scans its sources

const work = path.join(cwd, '.resolver-app');

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.copyFileSync(path.join(app, 'global.css'), path.join(work, 'global.css'));
fs.cpSync(path.join(app, 'src'), path.join(work, 'src'), { recursive: true });

for (const file of ['App.tsx', 'index.js']) {
  if (fs.existsSync(path.join(app, file))) {
    fs.copyFileSync(path.join(app, file), path.join(work, file));
  }
}

// a third theme: the dark variables with another brand colour (theme indexes past 0 and 1, a theme the variants do not name)
const css = fs.readFileSync(path.join(work, 'global.css'), 'utf8');
const dark = css.match(/@variant dark \{[^}]*\}/);

if (!dark) {
  throw new Error('global.css has no `@variant dark { ... }` block to copy for the extra theme');
}

// and two utilities whose values read device-fixed runtime fields (Uniwind's hairlineWidth() and pixelRatio() CSS functions)
fs.writeFileSync(
  path.join(work, 'global.css'),
  `${css.replace(dark[0], `${dark[0]}\n\n    ${dark[0].replace('@variant dark', '@variant ocean').replace(/--color-brand:[^;]*;/, '--color-brand: #0077be;')}`)}
@utility border-hairline {
  border-width: hairlineWidth();
}

@utility w-ratio {
  width: pixelRatio(2);
}
`
);

const DEVICE_CLASSES = ['border-hairline', 'w-ratio'];

// classNames Tailwind must compile (it scans this file) and the cases resolve, beyond what the app uses
const EXTRA = [
  // responsive, both orders, ranges
  'p-2 sm:p-4 md:p-6 lg:p-8 xl:p-10', 'xl:p-10 lg:p-8 md:p-6 sm:p-4 p-2', 'flex-col md:flex-row', 'md:flex-row flex-col',
  'max-md:hidden flex', 'max-sm:p-1 p-3', 'md:max-lg:p-3 p-1', 'w-full md:w-1/2', 'md:w-1/2 w-full', 'sm:text-lg text-sm',
  // theme variants, the extra theme, theme + state + width
  'bg-card dark:bg-background', 'dark:bg-background bg-card', 'text-primary light:text-secondary', 'dark:md:p-4 p-1',
  'dark:active:bg-brand bg-card', 'ocean:bg-blue bg-card dark:bg-background', 'bg-brand ocean:bg-orange',
  // interaction states
  'opacity-100 active:opacity-50', 'active:opacity-50 opacity-100', 'border focus:border-brand border-divider',
  'disabled:opacity-25 opacity-90', 'active:focus:bg-blue bg-card', 'focus:active:p-2 p-1', 'disabled:active:bg-orange bg-card',
  'focus:text-brand disabled:text-inactive active:text-blue text-primary',
  // important, both syntaxes, against a later and an earlier class
  '!p-2 p-4', 'p-4 !p-2', 'p-4! p-2', 'p-2 p-4!', '!text-sm text-lg', 'text-lg !text-sm', '!bg-card active:bg-brand',
  'md:!p-1 !p-3',
  // line heights: relative with and without a font size, inline --tw-leading against text-*/leading
  'leading-tight', 'leading-none', 'leading-6', 'leading-[1.7]', 'text-sm/6', 'text-lg/tight', 'text-xs/[18px]',
  'text-lg leading-tight', 'leading-tight text-lg', 'text-sm leading-5 text-lg', 'leading-5 text-sm', 'text-sm leading-[3]',
  // letter spacing in em (reads --uniwind-em, set by text-*)
  'tracking-wide', 'tracking-tighter', 'tracking-[0.1em]', 'text-lg tracking-wide', 'tracking-wide text-xs text-2xl',
  // fonts and text
  'font-bold', 'font-light font-bold', 'font-[650]', 'italic', 'not-italic', 'uppercase', 'underline', 'line-through',
  'text-center', 'text-right', 'font-semibold text-base text-primary', 'text-transparent',
  // visibility, display
  'invisible', 'visible', 'invisible hidden', 'hidden invisible', 'flex invisible', 'invisible visible',
  // border and outline styles with and without colours
  'border', 'border-2', 'border-dashed', 'border-dotted', 'border-solid border-brand', 'border-brand border-dashed', 'border-t-4',
  'outline', 'outline-dashed', 'outline-2 outline-offset-2', 'outline-dashed outline-brand', 'rounded', 'rounded-full',
  'rounded-t-lg rounded-b-none',
  // colours: alpha, arbitrary, keywords
  'bg-brand/50', 'text-primary/75', 'bg-red-500', 'bg-[#123456]', 'text-[rgb(1,2,3)]', 'bg-transparent', 'bg-current',
  'text-inherit', 'border-x-brand',
  // sizes and positions
  'w-10', 'h-1/2', 'size-8', 'min-w-0', 'max-w-sm', 'aspect-square', 'aspect-video', 'aspect-[4/3]', 'inset-0', 'top-2',
  '-top-2', '-mt-2', 'm-auto', 'gap-2', 'gap-x-3', 'p-[13px]', 'p-px', 'p-0.5', 'absolute', 'relative', 'z-10', 'flex-wrap',
  'grow', 'shrink-0', 'basis-1/2', 'self-center', 'content-between', 'overflow-scroll', 'opacity-0',
  // classes the table cannot hold (post-processed, runtime-dependent, data / direction / orientation variants)
  'shadow-md', 'ring-2', 'translate-x-2', 'rotate-45', 'scale-50', 'h-screen', 'pt-safe', 'bg-linear-to-r from-brand to-blue',
  'blur-sm', 'data-[selected=true]:bg-brand', 'rtl:p-2', 'ltr:p-3', 'portrait:p-2', 'landscape:p-3', 'tabular-nums',
  'text-shadow-sm', 'p-2 shadow-md',
  // platforms
  'ios:p-2 android:p-3', 'native:m-1 web:m-2',
  // device-fixed runtime values: in the device's table, not in the bundle's
  'border-hairline', 'w-ratio', 'border-hairline border-brand', 'p-2 w-ratio',
];

fs.writeFileSync(path.join(work, 'src', '__resolver_extra.ts'), `export const EXTRA = ${JSON.stringify(EXTRA, null, 2)};\n`);

// ---- Uniwind's sources (TypeScript, path alias `@`) and ours, bundled for Node, with React Native stubbed

const stub = path.join(work, 'react-native-stub.mjs');

fs.writeFileSync(
  stub,
  `export const Platform = { OS: 'ios', isTV: false, select: (o) => o.ios ?? o.native ?? o.default };
export const Dimensions = { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => ({ remove() {} }) };
export const PixelRatio = { get: () => 3, getFontScale: () => 1 };
export const StyleSheet = { hairlineWidth: 1 / 3 };
export const I18nManager = { isRTL: false };
export const Appearance = { getColorScheme: () => 'light', addChangeListener: () => ({ remove() {} }) };
`
);

const entry = path.join(work, 'entry.mjs');
const src = (file) => JSON.stringify(path.join(uniwind, 'src', file));

fs.writeFileSync(
  entry,
  `export { UniwindStore } from ${src('core/native/store.ts')};
export { UniwindBundlerConfig } from ${src('bundler/config.ts')};
export { compileCSS } from ${src('bundler/css-compiler/index.ts')};
export { buildStyleTable } from ${JSON.stringify(path.join(repo, 'src/uniwind/styleTable.ts'))};
`
);

const bundle = path.join(work, 'bundle.mjs');

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': path.join(uniwind, 'src'), 'react-native': stub },
  external: ['@tailwindcss/node', '@tailwindcss/oxide', 'lightningcss', 'culori', 'react'],
  define: { __DEV__: 'false' },
  logLevel: 'warning',
});

const { UniwindStore, UniwindBundlerConfig, compileCSS, buildStyleTable } = await import(
  pathToFileURL(bundle).href
);

// ---- compile and load, as Uniwind's Metro transformer and Uniwind.__reinit do

process.chdir(work);

const config = UniwindBundlerConfig.fromMetroConfig({ cssEntryFile: './global.css', extraThemes: ['ocean'] }, 'ios');

// what withUniwindConfig does when Metro starts: the theme variants and `@theme` variables (bg-card, ...) go into uniwind.css
await config.generateArtifacts(path.join(uniwind, 'uniwind.css'));

const virtualCode = await compileCSS(config);
const themes = config.themes;

UniwindStore.reinit(new Function('rt', `return ${virtualCode}`), themes);

const runtime = UniwindStore.runtime;
const stylesheet = UniwindStore.stylesheet;

const t0 = performance.now();
const table = buildStyleTable({
  stylesheet,
  varsByTheme: UniwindStore.vars,
  themes,
  runtime,
});
const buildMs = performance.now() - t0;
const parsed = JSON.parse(table.json);
const unsupported = new Set([...parsed.fallback, ...parsed.reserved]);

// ---- the bundle's table: Uniwind's Metro transformer on the CSS entry, in the app's Metro config with withShadewind

const libTable = path.join(repo, 'lib', 'module', 'uniwind', 'styleTable.js');

if (!fs.existsSync(libTable) || fs.statSync(libTable).mtimeMs < fs.statSync(path.join(repo, 'src/uniwind/styleTable.ts')).mtimeMs) {
  throw new Error('lib/module is older than src: build the package first (bob build)');
}

const fromHere = createRequire(path.join(cwd, 'package.json'));
const { getDefaultConfig } = fromHere('@react-native/metro-config');
const { withUniwindConfig } = fromHere('uniwind/metro');
const { withShadewind } = createRequire(path.join(repo, 'package.json'))('./metro.cjs');

const bundleTable = async (platform) => {
  const metroConfig = withShadewind(
    withUniwindConfig(getDefaultConfig(work), { cssEntryFile: './global.css', extraThemes: ['ocean'] })
  );
  const transformer = fromHere(metroConfig.transformerPath);
  const result = await transformer.transform(
    metroConfig.transformer,
    work,
    'global.css',
    fs.readFileSync(path.join(work, 'global.css')),
    {
      dev: false,
      hot: false,
      minify: false,
      platform,
      type: 'module',
      unstable_transformProfile: 'hermes-stable',
      customTransformOptions: {},
      experimentalImportSupport: false,
      inlineRequires: false,
      inlinePlatform: true,
    }
  );
  const names = result.dependencies.map((dependency) => dependency.name);

  if (!names.includes('shadewind/uniwind')) {
    throw new Error(`${platform}: the CSS module does not depend on shadewind/uniwind (${names.join(', ')})`);
  }

  // the module as the app runs it, with the two modules it requires stood in for
  let registered = null;
  const stand = {
    uniwind: { Uniwind: { __reinit: () => {} } },
    'shadewind/uniwind': { registerPrebuiltStyleTable: (json, meta) => (registered = { json, meta }) },
  };
  const moduleRequire = (name) => {
    if (!(name in stand)) {
      throw new Error(`unexpected require(${name})`);
    }

    return stand[name];
  };

  new Function('__d', result.output[0].data.code)((factory) =>
    factory(globalThis, moduleRequire, moduleRequire, moduleRequire, { exports: {} }, {}, names)
  );

  if (!registered) {
    throw new Error(`${platform}: the CSS module did not register a table`);
  }

  return registered;
};

const prebuilt = await bundleTable('ios');
const prebuiltParsed = JSON.parse(prebuilt.json);

// equal to the device's table, except for the classes that read device-fixed values (fallback in the bundle's)
const onlyOnDevice = Object.keys(parsed.classes).filter((name) => !(name in prebuiltParsed.classes));
const mismatched = Object.keys(prebuiltParsed.classes).filter(
  (name) => JSON.stringify(prebuiltParsed.classes[name]) !== JSON.stringify(parsed.classes[name])
);

if (mismatched.length > 0) {
  throw new Error(`bundle and device tables differ for ${mismatched.join(' ')}`);
}

if (JSON.stringify(onlyOnDevice.sort()) !== JSON.stringify([...DEVICE_CLASSES].sort())) {
  throw new Error(`classes only in the device's table: ${onlyOnDevice.join(' ')} (expected ${DEVICE_CLASSES.join(' ')})`);
}

if (
  prebuilt.meta.deviceDependent !== DEVICE_CLASSES.length ||
  JSON.stringify(prebuiltParsed.themes) !== JSON.stringify(parsed.themes) ||
  !parsed.fallback.every((name) => prebuiltParsed.fallback.includes(name)) ||
  prebuiltParsed.fallback.length !== parsed.fallback.length + DEVICE_CLASSES.length
) {
  throw new Error(`bundle table metadata: ${JSON.stringify(prebuilt.meta)}`);
}

// Android goes through the same path (its own platform variables)
const androidPrebuilt = await bundleTable('android');
const unsupportedPrebuilt = new Set([...prebuiltParsed.fallback, ...prebuiltParsed.reserved]);

// ---- classNames: every string literal of the app that names a class, plus generated combinations

const literals = new Set();

const scan = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scan(full);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/(["'`])((?:(?!\1)[^\\\n$])*)\1/g)) {
        const text = match[2].trim();

        if (text && text.split(/\s+/).some((token) => token in stylesheet && !Object.prototype.hasOwnProperty.call(Object.prototype, token))) {
          literals.add(match[2]);
        }
      }
    }
  }
};

scan(path.join(work, 'src'));

if (fs.existsSync(path.join(work, 'App.tsx'))) {
  scan(path.join(work, 'App.tsx').replace(/App\.tsx$/, ''));
}

const known = Object.keys(stylesheet).sort();
const supportedNames = () => known.filter((name) => !unsupported.has(name));
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = () => known[Math.floor(random() * known.length)];
const generated = [];

// every ordered pair of classes that set the same property (precedence: order, width, complexity, important), sampled when many
const setters = new Map();

for (const name of supportedNames()) {
  for (const property of new Set(stylesheet[name].flatMap((style) => style.entries.map(([key]) => key)))) {
    setters.set(property, [...(setters.get(property) ?? []), name]);
  }
}

for (const names of setters.values()) {
  const pairs = names.flatMap((a, i) => names.filter((_, j) => j !== i).map((b) => `${a} ${b}`));

  for (let n = 0; n < Math.min(pairs.length, 24); n++) {
    generated.push(pairs.length <= 24 ? pairs[n] : pairs[Math.floor(random() * pairs.length)]);
  }
}

for (let i = 0; i < 800; i++) {
  const count = 2 + Math.floor(random() * 4);

  generated.push(Array.from({ length: count }, pick).join(' '));
}

// whitespace forms resolveStyles treats differently (split on ' ' unless there is a newline), unknown tokens, duplicates
const supported = supportedNames();
const a = supported[0];
const b = supported[Math.floor(supported.length / 2)];

generated.push(`${a}  ${b}`, `${a}\n${b}`, ` ${a} ${b} `, `${a}\t${b}`, `${a} not-a-class ${b}`, `${a} ${a}`, `${b} ${a} ${b}`);

const classNames = [...new Set([...literals, ...generated])];

// ---- Uniwind's own resolution of each one

const STATES = [
  undefined,
  { isPressed: true },
  { isFocused: true },
  { isDisabled: true },
  { isPressed: false, isFocused: false, isDisabled: false },
  { isPressed: true, isFocused: true, isDisabled: false },
];
const WIDTHS = [390, 640, 768, 1024, 1280];
const context = { scopedTheme: null, rtl: null, variables: null };

// undefined, NaN and Infinity survive as markers (JSON has none of them); top-level key order is kept as pairs
const encode = (value) => {
  if (value === undefined) {
    return { $u: 1 };
  }

  if (typeof value === 'number' && Number.isNaN(value)) {
    return { $nan: 1 };
  }

  if (value === Infinity || value === -Infinity) {
    return { $inf: value > 0 ? 1 : -1 };
  }

  return value;
};

const tokensOf = (className) => (className.includes('\n') ? className.split(/\s+/).filter(Boolean) : className.split(' '));
const lines = [
  JSON.stringify({
    themes,
    widths: WIDTHS,
    states: STATES.map((state) => [state?.isPressed ?? null, state?.isFocused ?? null, state?.isDisabled ?? null]),
  }),
];
let cases = 0;
let resolvable = 0;
let fallbackClassNames = 0;

for (const className of classNames) {
  const fallback = tokensOf(className).some((token) => unsupported.has(token));
  const line = { c: className, fb: fallback, pfb: tokensOf(className).some((token) => unsupportedPrebuilt.has(token)) };

  cases += themes.length * WIDTHS.length * STATES.length;

  if (fallback) {
    fallbackClassNames++;
    lines.push(JSON.stringify(line));
    continue;
  }

  const distinct = new Map();

  line.u = [];
  line.i = [];

  for (const theme of themes) {
    for (const width of WIDTHS) {
      for (const state of STATES) {
        runtime.currentThemeName = theme;
        runtime.screen.width = width;

        const result = UniwindStore.resolveStyles(className, {}, state, context);
        const encoded = JSON.stringify({
          styles: Object.entries(result.styles).map(([key, value]) => [key, encode(value)]),
          deps: result.dependencies,
          sum: result.dependencySum,
          data: result.hasDataAttributes,
        });

        if (!distinct.has(encoded)) {
          distinct.set(encoded, line.u.length);
          line.u.push(JSON.parse(encoded));
        }

        line.i.push(distinct.get(encoded));
        resolvable++;
      }
    }
  }

  lines.push(JSON.stringify(line));
}

fs.writeFileSync(path.join(here, 'table.json'), table.json + '\n');
fs.writeFileSync(path.join(here, 'table.prebuilt.json'), prebuilt.json + '\n');
fs.writeFileSync(path.join(here, 'cases.jsonl'), lines.join('\n') + '\n');
fs.writeFileSync(
  path.join(here, 'summary.json'),
  JSON.stringify(
    {
      uniwind: uniwindVersion,
      app: path.relative(repo, app),
      themes,
      stylesheetClasses: known.length,
      tableClasses: table.classes,
      fallbackClasses: table.fallback,
      appLiterals: literals.size,
      classNames: classNames.length,
      fallbackClassNames,
      cases,
      resolvableCases: resolvable,
      tableBuildMsNode: Math.round(buildMs * 100) / 100,
      prebuilt: {
        classes: Object.keys(prebuiltParsed.classes).length,
        onlyOnDevice: DEVICE_CLASSES,
        meta: prebuilt.meta,
        bytes: prebuilt.json.length,
        androidBytes: androidPrebuilt.json.length,
      },
    },
    null,
    2
  ) + '\n'
);

console.log(fs.readFileSync(path.join(here, 'summary.json'), 'utf8'));
