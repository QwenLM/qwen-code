/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  // React/TSX files with React Hooks rules
  {
    files: ['src/**/*.tsx', 'src/webview/**/*.ts'],
    plugins: {
      '@typescript-eslint': typescriptEslint,
      'react-hooks': reactHooks,
      import: importPlugin,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Restrict deep imports but allow known-safe exceptions used by the webview
      // - react-dom/client: required for React 18's createRoot API
      // - ./styles/**: local CSS modules loaded by the webview
      'import/no-internal-modules': [
        'error',
        {
          allow: ['react-dom/client', './styles/**'],
        },
      ],

      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'warn',
    },
  },
  // Non-React TS files (including test files, fixtures, etc.)
  {
    files: ['**/*.ts'],
    excludedFiles: ['src/**/*.tsx', 'src/webview/**/*.ts'],  // Exclude React files
    plugins: {
      '@typescript-eslint': typescriptEslint,
      import: importPlugin,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      'react-hooks/rules-of-hooks': 'off',  // Disable React Hooks rule for non-React files
      'react-hooks/exhaustive-deps': 'off', // Disable React Hooks rule for non-React files
      // Restrict deep imports but allow known-safe exceptions used by the webview
      // - react-dom/client: required for React 18's createRoot API
      // - ./styles/**: local CSS modules loaded by the webview
      'import/no-internal-modules': [
        'error',
        {
          allow: ['react-dom/client', './styles/**'],
        },
      ],

      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'warn',
    },
  },
];
