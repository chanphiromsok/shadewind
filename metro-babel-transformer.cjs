'use strict';

// shadewind/metro's Babel transformer: the class table of the native resolver (src/uniwind/nativeResolver.ts), built while Metro
// bundles, so the app's first screen already resolves its classes natively instead of waiting for a table built on the device.
//
// Every file goes to the project's own Babel transformer (withShadewind passes its path in SHADEWIND_UPSTREAM_BABEL_TRANSFORMER).
// One file is changed first: the module Uniwind's Metro transformer generates from the CSS entry,
//
//   const { Uniwind } = require('uniwind');Uniwind.__reinit(rt => <stylesheet>, <themes>, '<fingerprint>');
//
// Its stylesheet is evaluated here the way Uniwind's store does it on the device (same runtime helpers, same platform and theme
// variables), the table is built with src/uniwind/styleTable.ts (the code the app runs), and one guarded statement is appended:
//
//   try { require('shadewind/uniwind').registerPrebuiltStyleTable('<table json>', <meta>) } catch (e) {}
//
// Runtime fields fixed for a device but unknown here (pixel ratio, hairline width) are treated as changing: their classes fall back
// (and the app rebuilds the table on the device when idle if there are any). Anything unexpected (another Uniwind version, a
// stylesheet that reads the runtime while it is created, an error) leaves the module unchanged: the app then builds the table
// on the device as before.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UPSTREAM_ENV = 'SHADEWIND_UPSTREAM_BABEL_TRANSFORMER';
// withShadewind(config, { precompileClassNames: true }) sets '1' (metro-precompile-plugin.cjs); `prebuildStyleTable: false`
// with it on sets the second one to '0' (the transformer is then installed for the plugin only)
const PRECOMPILE_ENV = 'SHADEWIND_PRECOMPILE_CLASSNAMES';
const PREBUILD_ENV = 'SHADEWIND_PREBUILD_STYLE_TABLE';
const PRECOMPILE_PLUGIN = path.join(__dirname, 'metro-precompile-plugin.cjs');
// shadewind's own code (source and compiled) imports the real react-native and is never compiled (see metro.cjs OWN_CODE)
const OWN_CODE = [path.join(__dirname, 'src'), path.join(__dirname, 'lib')];
const TESTED_UNIWIND = /^1\.12\./;
// Uniwind 1.12's CSS module (bundler/adapters/metro/transformer.ts), native platforms
const CSS_MODULE = /^const \{ Uniwind \} = require\('uniwind'\);Uniwind\.__reinit\(rt => /;
const PLATFORMS = new Set(['ios', 'android']);
// Uniwind 1.12's runtime (core/native/runtime.ts): changing fields, and the device-fixed ones this machine does not know
const CHANGING = ['screen', 'orientation', 'insets', 'rtl', 'colorScheme', 'fontScale'];
const DEVICE_FIXED = ['pixelRatio', 'hairlineWidth'];
const TABLE_MODULE = path.join(__dirname, 'lib', 'module', 'uniwind', 'styleTable.js');

let upstreamModule = null;
const warned = new Set();

const upstream = () => {
  if (!upstreamModule) {
    const upstreamPath = process.env[UPSTREAM_ENV];

    if (!upstreamPath) {
      throw new Error(
        `[shadewind] ${UPSTREAM_ENV} is not set: shadewind/metro-babel-transformer must be installed by withShadewind() from shadewind/metro`
      );
    }

    upstreamModule = require(upstreamPath);
  }

  return upstreamModule;
};

const warnOnce = (reason) => {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.warn(`[shadewind] class table not prebuilt (built on the device instead): ${reason}`);
  }
};

/**
 * The table for Uniwind's generated CSS module `src`, and what the app needs to check it applies; null (with the reason) when it
 * cannot be built here.
 * @returns {Promise<{ table: { json: string, classes: number, fallback: number, deviceDependent: string[] }, meta: object } | { reason: string }>}
 */
async function prebuildStyleTable(src, platform, projectRoot) {
  let uniwindRoot;

  try {
    uniwindRoot = path.dirname(require.resolve('uniwind/package.json', { paths: [projectRoot] }));
  } catch {
    return { reason: 'uniwind is not resolvable from the project root' };
  }

  const uniwindVersion = String(JSON.parse(fs.readFileSync(path.join(uniwindRoot, 'package.json'), 'utf8')).version);

  if (!TESTED_UNIWIND.test(uniwindVersion)) {
    return { reason: `Uniwind ${uniwindVersion} is outside the tested range (1.12.x)` };
  }

  if (!fs.existsSync(TABLE_MODULE)) {
    return { reason: `${path.relative(__dirname, TABLE_MODULE)} is missing (build the package: bob build)` };
  }

  // the store's runtime on the device (core/native/runtime.ts), with Uniwind's own helpers
  // (Uniwind's package is "type": "module": its ES build, not dist/common)
  const { colorMix, lightDark, parseColor } = await import(
    pathToFileURL(path.join(uniwindRoot, 'dist', 'module', 'core', 'native', 'native-utils.js')).href
  );
  const runtime = {
    screen: { width: 0, height: 0 },
    colorScheme: 'light',
    currentThemeName: 'light',
    orientation: 'portrait',
    fontScale: (value) => value,
    hairlineWidth: 1,
    rtl: false,
    insets: { top: 0, left: 0, bottom: 0, right: 0 },
    colorMix,
    pixelRatio: (value) => value,
    cubicBezier: () => '',
    lightDark: () => '',
    parseColor,
  };

  runtime.lightDark = lightDark.bind(runtime);

  // the module, with `require('uniwind')` answered by a stand-in that keeps what __reinit receives
  let reinit = null;
  const stand = { Uniwind: { __reinit: (generate, themes, fingerprint) => (reinit = { generate, themes, fingerprint }) } };

  new Function('require', src)((name) => {
    if (name !== 'uniwind') {
      throw new Error(`unexpected require('${name}')`);
    }

    return stand;
  });

  if (!reinit || typeof reinit.generate !== 'function' || !Array.isArray(reinit.themes)) {
    return { reason: 'the CSS module did not call Uniwind.__reinit as Uniwind 1.12 does' };
  }

  // creating the stylesheet must not read a runtime field: it would hold this machine's stand-in values
  const reads = [];
  const watched = {};

  for (const key of [...CHANGING, ...DEVICE_FIXED]) {
    watched[key] = runtime[key];
    Object.defineProperty(runtime, key, {
      configurable: true,
      enumerable: true,
      get: () => (reads.push(key), watched[key]),
      set: (value) => (watched[key] = value),
    });
  }

  const generated = reinit.generate(runtime);

  for (const key of Object.keys(watched)) {
    Object.defineProperty(runtime, key, { configurable: true, enumerable: true, writable: true, value: watched[key] });
  }

  if (reads.length > 0) {
    return { reason: `the stylesheet reads runtime.${reads[0]} while it is created` };
  }

  // UniwindStore.reinit (core/native/store.ts): platform variables into the shared ones, each theme's on a clone of them
  const { scopedVars = {}, stylesheet, vars } = generated ?? {};

  if (!stylesheet || !vars) {
    return { reason: 'the stylesheet callback returned no stylesheet / vars' };
  }

  Object.assign(vars, scopedVars['__uniwind-platform-native'] ?? {});
  Object.assign(vars, scopedVars[`__uniwind-platform-${platform}`] ?? {});

  const varsByTheme = Object.fromEntries(
    reinit.themes.map((theme) => [theme, Object.assign(Object.create(vars), scopedVars[`__uniwind-theme-${theme}`] ?? {})])
  );
  const { buildStyleTable } = await import(pathToFileURL(TABLE_MODULE).href);
  const table = buildStyleTable({ stylesheet, varsByTheme, themes: reinit.themes, runtime, deviceFixed: DEVICE_FIXED });

  return {
    table,
    meta: {
      uniwind: uniwindVersion,
      platform,
      themes: reinit.themes,
      fingerprint: typeof reinit.fingerprint === 'string' ? reinit.fingerprint : null,
      fallback: table.fallback,
      deviceDependent: table.deviceDependent.length,
    },
  };
}

// The app's own source files (what Uniwind's resolver rewrites `react-native` for), on a native platform, that may hold a
// className attribute
const precompiles = (filename, src, options) => {
  if (
    process.env[PRECOMPILE_ENV] !== '1' ||
    !PLATFORMS.has(options.platform) ||
    !/\.[jt]sx?$/.test(filename) ||
    filename.endsWith('.css.js') // Uniwind's CSS module (its stylesheet names every class `className`)
  ) {
    return false;
  }

  const file = path.resolve(options.projectRoot ?? process.cwd(), filename);

  return (
    !file.split(path.sep).includes('node_modules') &&
    !OWN_CODE.some((dir) => file.startsWith(dir + path.sep)) &&
    src.includes('className')
  );
};

async function transform(args) {
  const { filename, src, options } = args;

  if (precompiles(filename, src, options)) {
    return upstream().transform({ ...args, plugins: [...(args.plugins ?? []), require(PRECOMPILE_PLUGIN)] });
  }

  // a cheap test first: every file of the app comes through here
  if (
    process.env[PREBUILD_ENV] !== '0' &&
    filename.endsWith('.css.js') &&
    PLATFORMS.has(options.platform) &&
    CSS_MODULE.test(src)
  ) {
    try {
      const result = await prebuildStyleTable(src, options.platform, options.projectRoot);

      if ('table' in result) {
        const register = `require('shadewind/uniwind').registerPrebuiltStyleTable(${JSON.stringify(result.table.json)}, ${JSON.stringify(result.meta)});`;

        // a failure here must never stop the app from starting: the device then builds the table itself
        return upstream().transform({ ...args, src: `${src}\ntry { ${register} } catch (e) {}\n` });
      }

      warnOnce(result.reason);
    } catch (error) {
      warnOnce(String(error && error.stack ? error.stack : error));
    }
  }

  return upstream().transform(args);
}

function getCacheKey() {
  const hash = crypto.createHash('sha1');

  hash.update(fs.readFileSync(__filename));
  hash.update(fs.existsSync(TABLE_MODULE) ? fs.readFileSync(TABLE_MODULE) : '');
  hash.update(process.env[UPSTREAM_ENV] ?? '');
  // The precompile plugin and whether it (and the prebuilt table) are on: A/B builds must not share cached transforms
  hash.update(fs.existsSync(PRECOMPILE_PLUGIN) ? fs.readFileSync(PRECOMPILE_PLUGIN) : '');
  hash.update(`${process.env[PRECOMPILE_ENV] ?? ''}/${process.env[PREBUILD_ENV] ?? ''}`);

  const upstreamKey = upstream().getCacheKey ? upstream().getCacheKey() : '';

  return `${hash.digest('hex')}$${upstreamKey}`;
}

module.exports = { transform, getCacheKey, prebuildStyleTable };
