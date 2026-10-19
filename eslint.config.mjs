import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import { defineConfig } from 'eslint/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  {
    extends: fixupConfigRules(compat.extends('@react-native', 'prettier')),
    plugins: { prettier },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'prettier/prettier': 'error',
    },
  },
  {
    // React Compiler rules: eslint-plugin-react-hooks 7's `recommended-latest` set, without the two @react-native already turns
    // on as errors (rules-of-hooks, exhaustive-deps). The plugin is registered by @react-native.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/static-components': 'error',
      'react-hooks/use-memo': 'error',
      'react-hooks/void-use-memo': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/immutability': 'error',
      'react-hooks/globals': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/error-boundaries': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/set-state-in-render': 'error',
      'react-hooks/unsupported-syntax': 'warn',
      'react-hooks/config': 'error',
      'react-hooks/gating': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'lib/', 'example-real/', 'example/uniwind-types.d.ts'],
  },
]);
