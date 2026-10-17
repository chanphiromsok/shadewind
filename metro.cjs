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

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = fs.realpathSync(__dirname);
const BABEL_TRANSFORMER = path.join(PACKAGE_ROOT, 'metro-babel-transformer.cjs');
const UPSTREAM_ENV = 'SHADEWIND_UPSTREAM_BABEL_TRANSFORMER';
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
 * @param {{ prebuildStyleTable?: boolean }} [options]
 * @returns {C}
 */
function withShadewind(config, options = {}) {
  const resolver = config.resolver ?? {};
  const transformer = config.transformer ?? {};
  let babelTransformerPath = transformer.babelTransformerPath;

  if (options.prebuildStyleTable !== false && babelTransformerPath && realOrSelf(babelTransformerPath) !== BABEL_TRANSFORMER) {
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

  return {
    ...config,
    ...(babelTransformerPath !== transformer.babelTransformerPath && { transformer: { ...transformer, babelTransformerPath } }),
    resolver: {
      ...resolver,
      resolveRequest: (context, moduleName, platform) => {
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

        if (origin && isInside(realOrSelf(origin), PACKAGE_ROOT)) {
          return context.resolveRequest(context, moduleName, platform);
        }

        const resolved = (previous ?? context.resolveRequest)(context, moduleName, platform);

        if (resolved.type === 'sourceFile') {
          for (const [pattern, name] of REPLACED) {
            const match = pattern.exec(resolved.filePath);

            if (match) {
              // resolved like an app import, so the `shadewind-source` / default export condition picks src or lib
              return context.resolveRequest(
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
