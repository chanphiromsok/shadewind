'use strict';

// shadewind/metro: wraps a Metro config so Uniwind's `View` and `Text` become the engine-aware versions from
// `shadewind/uniwind`, and the adapter can reach the Uniwind modules it needs. Nothing in node_modules is patched.
//
//   const { withUniwindConfig } = require('uniwind/metro');
//   const { withShadewind } = require('shadewind/metro');
//   module.exports = withShadewind(withUniwindConfig(config, { cssEntryFile: './global.css' }));
//
// It must be the OUTERMOST wrapper (after withUniwindConfig) so it sees the files Uniwind's resolver picked.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = fs.realpathSync(__dirname);
const PREFIX = 'uniwind-internal/';
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
const REPLACED = /[\\/]uniwind[\\/]src[\\/]components[\\/]native[\\/](View|Text)\.tsx$/;

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
 * @returns {C}
 */
function withShadewind(config) {
  const resolver = config.resolver ?? {};
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
          const match = REPLACED.exec(resolved.filePath);

          if (match) {
            // resolved like an app import, so the `shadewind-source` / default export condition picks src or lib
            return context.resolveRequest(
              { ...context, originModulePath: pinnedOrigin },
              `shadewind/uniwind/${match[1]}`,
              platform
            );
          }
        }

        return resolved;
      },
    },
  };
}

module.exports = { withShadewind };
