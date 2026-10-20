'use strict';

// shadewind/metro: wraps a Metro config so Uniwind's `View` and `Text` become the engine-aware versions from
// `shadewind/uniwind`, and the adapter can reach the Uniwind modules it needs. Nothing in node_modules is patched.
//
//   const { withUniwindConfig } = require('uniwind/metro');
//   const { withShadewind } = require('shadewind/metro');
//   module.exports = withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }));
//
// It must be the OUTERMOST wrapper (after withUniwindConfig) so it sees the files Uniwind's resolver picked.
//
// It also builds the native class resolver's table while Metro bundles (metro-babel-transformer.cjs, wrapped around the
// project's own Babel transformer), so the first screen resolves natively. `withShadewind(config, { prebuildStyleTable: false })`
// leaves the Babel transformer alone: the app then builds the table on the device when idle.
//
// `withShadewind(config, { cacheColors: true })` (off by default) routes React Native's colour parser through a small cache
// (metro-color-cache.cjs). A string colour such as '#00a8ff' is otherwise parsed again for every view of every render; on the
// 2003-view Android benchmark that was about 20 ms of the JS thread per re-mount for a StyleSheet with string colours. It does
// nothing for views the engine themes (it never parses those strings), and none of the parser's results change.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = fs.realpathSync(__dirname);
const PACKAGE_NAME = require('./package.json').name;
const BABEL_TRANSFORMER = path.join(PACKAGE_ROOT, 'metro-babel-transformer.cjs');
// the library's own code (source and compiled): an app inside the package folder (this repository's example) is not part of it
const OWN_CODE = [path.join(PACKAGE_ROOT, 'src'), path.join(PACKAGE_ROOT, 'lib')];
const UPSTREAM_ENV = 'SHADEWIND_UPSTREAM_BABEL_TRANSFORMER';
// precompileClassNames (metro-precompile-plugin.cjs, src/uniwind/precompiled.tsx); read by metro-babel-transformer.cjs
const PRECOMPILE_ENV = 'SHADEWIND_PRECOMPILE_CLASSNAMES';
const PREBUILD_ENV = 'SHADEWIND_PREBUILD_STYLE_TABLE';
// cacheColors: the wrapper replaces `@react-native/normalize-colors`; it reaches the real one through this private name
const COLOR_CACHE = path.join(PACKAGE_ROOT, 'metro-color-cache.cjs');
const NORMALIZE_COLORS = '@react-native/normalize-colors';
const REAL_NORMALIZE_COLORS = 'shadewind-internal/normalize-colors';
const PREFIX = 'uniwind-internal/';
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
// files of Uniwind replaced by the engine-aware versions: resolved file path -> `shadewind/uniwind/<name>`
const REPLACED = [
  [/[\\/]uniwind[\\/]src[\\/]components[\\/]native[\\/](View|Text|Pressable|TouchableOpacity)\.tsx$/, (match) => match[1]],
  [/[\\/]uniwind[\\/]src[\\/]hoc[\\/]withUniwind\.native\.tsx$/, () => 'withUniwind']
];

const isInside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

const realOrSelf = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * @template {object} C
 * @param {C} config Metro config, already wrapped with withUniwindConfig
 * @param {{ prebuildStyleTable?: boolean, cacheColors?: boolean, precompileClassNames?: boolean }} [options]
 * @returns {C}
 */
function withShadewind(config, options = {}) {
  const resolver = config.resolver ?? {};
  const transformer = config.transformer ?? {};
  let babelTransformerPath = transformer.babelTransformerPath;
  const precompile = options.precompileClassNames === true;

  // set both ways: a second withShadewind in the same process must not inherit the first one's choice
  process.env[PRECOMPILE_ENV] = precompile ? '1' : '0';
  process.env[PREBUILD_ENV] = options.prebuildStyleTable === false ? '0' : '1';

  if (
    (options.prebuildStyleTable !== false || precompile) &&
    babelTransformerPath &&
    realOrSelf(babelTransformerPath) !== BABEL_TRANSFORMER
  ) {
    // Metro's transform workers are started after the config is loaded and inherit the environment
    process.env[UPSTREAM_ENV] = babelTransformerPath;
    babelTransformerPath = BABEL_TRANSFORMER;
  }

  const previous = resolver.resolveRequest;
  const projectRoot = config.projectRoot ?? process.cwd();
  const pinnedOrigin = path.join(projectRoot, 'package.json');
  let uniwindRoot = null;

  const locateUniwind = (context, platform) => {
    if (uniwindRoot === null) {
      const found = context.resolveRequest(
        { ...context, originModulePath: pinnedOrigin },
        'uniwind/package.json',
        platform
      );

      uniwindRoot =
        found.type === 'sourceFile' ? path.dirname(realOrSelf(found.filePath)) : '';
    }

    return uniwindRoot;
  };

  let normalizeColorsFile = null;

  // The copy of `@react-native/normalize-colors` React Native itself loads: resolved from react-native's own folder, not from the
  // app's (a monorepo can hold several). `previous` is the resolver without this function, so it cannot send the request back here.
  const locateNormalizeColors = (context, platform) => {
    if (normalizeColorsFile === null) {
      const base = previous ?? context.resolveRequest;
      const reactNative = base({ ...context, originModulePath: pinnedOrigin }, 'react-native/package.json', platform);

      if (reactNative.type !== 'sourceFile') {
        throw new Error('[shadewind] cacheColors: react-native was not found');
      }

      const found = base(
        {
          ...context,
          originModulePath: path.join(path.dirname(realOrSelf(reactNative.filePath)), 'Libraries', 'StyleSheet', 'normalizeColor.js')
        },
        NORMALIZE_COLORS,
        platform
      );

      if (found.type !== 'sourceFile') {
        throw new Error(`[shadewind] cacheColors: ${NORMALIZE_COLORS} was not found for react-native`);
      }

      normalizeColorsFile = found;
    }

    return normalizeColorsFile;
  };

  return {
    ...config,
    ...(babelTransformerPath !== transformer.babelTransformerPath && { transformer: { ...transformer, babelTransformerPath } }),
    resolver: {
      ...resolver,
      resolveRequest: (context, moduleName, platform) => {
        if (options.cacheColors === true) {
          if (moduleName === REAL_NORMALIZE_COLORS) {
            return locateNormalizeColors(context, platform);
          }

          // everything but the wrapper itself gets the cached parser
          if (moduleName === NORMALIZE_COLORS && realOrSelf(context.originModulePath ?? '') !== COLOR_CACHE) {
            return { type: 'sourceFile', filePath: COLOR_CACHE };
          }
        }

        // private Uniwind modules, as the files Uniwind itself loads (src/, the `react-native` export condition)
        if (moduleName.startsWith(PREFIX)) {
          const root = locateUniwind(context, platform);
          const base = path.join(root, 'src', moduleName.slice(PREFIX.length));

          for (const extension of ['', ...EXTENSIONS]) {
            const candidate = base + extension;

            if (root && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return { type: 'sourceFile', filePath: candidate };
            }
          }

          throw new Error(`[shadewind] ${moduleName} was not found in uniwind (${root || 'not installed'})`);
        }

        // our own files import the real react-native: do not let Uniwind's resolver redirect them back to its barrel
        const origin = context.originModulePath;

        if (origin && OWN_CODE.some((dir) => isInside(realOrSelf(origin), dir))) {
          // except our imports of ourselves: those go through the wrapped resolvers like the app's (Uniwind's leaves them
          // alone), so they get the app's export conditions and the same module instance the app has (src or lib)
          const self = moduleName === PACKAGE_NAME || moduleName.startsWith(`${PACKAGE_NAME}/`);

          return (self ? previous ?? context.resolveRequest : context.resolveRequest)(context, moduleName, platform);
        }

        const resolved = (previous ?? context.resolveRequest)(context, moduleName, platform);

        if (resolved.type === 'sourceFile') {
          for (const [pattern, name] of REPLACED) {
            const match = pattern.exec(resolved.filePath);

            if (match) {
              // resolved like an app import, through the wrapped resolvers, so the app's export conditions apply: a monorepo
              // setup that adds `shadewind-source` (react-native-monorepo-config) gets src, an installed package gets lib
              return (previous ?? context.resolveRequest)(
                { ...context, originModulePath: pinnedOrigin },
                `shadewind/uniwind/${name(match)}`,
                platform
              );
            }
          }
        }

        return resolved;
      },
    },
  };
}

module.exports = { withShadewind };
