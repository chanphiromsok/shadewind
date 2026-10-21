// Loads Uniwind's own store in Node, with an app's stylesheet compiled by Uniwind's own Metro transformer. Shared by the
// checks that run against Uniwind's real code (uniwind-contract-check.cjs).
//
// An app dir is a folder with global.css, package.json, src/ and node_modules (uniwind, tailwindcss, @react-native/metro-config).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// the stylesheet Uniwind compiles for the app, as the source of the CSS module (`Uniwind.__reinit(...)`)
const compileStylesheet = async (app, extraClasses = []) => {
  // real path: Uniwind compares the CSS entry under process.cwd() (always real) with Metro's project root
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shadewind-harness-')));

  try {
    for (const file of ['global.css', 'package.json']) {
      fs.copyFileSync(path.join(app, file), path.join(work, file));
    }

    fs.cpSync(path.join(app, 'src'), path.join(work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'harnessExtra.ts'), `export const EXTRA = ${JSON.stringify(extraClasses)};\n`);
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

    return fs.readFileSync(captured, 'utf8');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

// Uniwind's dist/common modules (CommonJS in a "type": "module" package), loaded from the app's copy
const loadUniwind = (app) => {
  // react-native is not loadable in Node: the parts Uniwind's store reads, with a phone's values
  const rn = {
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove() {} }) },
    PixelRatio: { getFontScale: () => 1, get: () => 3 },
    StyleSheet: { hairlineWidth: 1 / 3, flatten: (style) => style },
    I18nManager: { isRTL: false },
    Platform: { OS: 'ios', isTV: false },
    Keyboard: { addListener: () => ({ remove() {} }) },
  };
  const resolveFilename = Module._resolveFilename;

  global.__DEV__ = false;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'react-native' ? 'stub:react-native' : resolveFilename.call(this, request, ...rest);
  };
  require.cache['stub:react-native'] = { id: 'stub:react-native', filename: 'stub:react-native', loaded: true, exports: rn };

  const fromApp = Module.createRequire(path.join(app, 'package.json'));
  const root = path.dirname(fromApp.resolve('uniwind/package.json'));
  const dist = path.join(root, 'dist', 'common');
  const loadJs = Module._extensions['.js'];

  Module._extensions['.js'] = function (module, filename) {
    if (filename.startsWith(dist + path.sep)) {
      return module._compile(fs.readFileSync(filename, 'utf8'), filename, 'commonjs');
    }

    return loadJs.call(this, module, filename);
  };

  const load = (...parts) => require(path.join(dist, ...parts));

  return {
    root,
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    UniwindStore: load('core', 'native', 'store.js').UniwindStore,
    UniwindListener: load('core', 'listener.js').UniwindListener,
    StyleDependency: load('common', 'consts.js').StyleDependency,
  };
};

// a store holding the compiled stylesheet, as Uniwind.__reinit would
const reinitStore = (uniwind, cssModule) => {
  let reinit = null;

  new Function('require', cssModule)(() => ({ Uniwind: { __reinit: (generate, themes, fingerprint) => (reinit = { generate, themes, fingerprint }) } }));

  if (!reinit) {
    throw new Error('the CSS module did not call Uniwind.__reinit');
  }

  uniwind.UniwindStore.reinit(reinit.generate, reinit.themes);

  return reinit;
};

module.exports = { compileStylesheet, loadUniwind, reinitStore };
