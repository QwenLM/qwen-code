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
  // Default config for all TS files (general) - no React hooks rules
  {
    files: ['**/*.ts'],
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
      'react-hooks/rules-of-hooks': 'off',  // Disable for all .ts files by default
      'react-hooks/exhaustive-deps': 'off', // Disable for all .ts files by default
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
  // Specific config for test files (override above) - no React hooks rules
  {
    files: ['**/*{test,spec}.{ts,tsx}', '**/__tests__/**', '**/test/**', 'e2e/**', 'e2e-vscode/**'],
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
      'react-hooks/rules-of-hooks': 'off',  // Explicitly disable for test files
      'react-hooks/exhaustive-deps': 'off', // Explicitly disable for test files
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
  // JSX/TSX files in src - enable React hooks rules (most specific - should override others)
  {
    files: ['src/**/*.{tsx,jsx}'],
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
      'react-hooks/rules-of-hooks': 'error',      // Enable React hooks rule for JSX/TSX files in src
      'react-hooks/exhaustive-deps': 'error',    // Enable React hooks rule for JSX/TSX files in src
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
  // Special webview TS files that are used in React context - enable React hooks rules
  {
    files: ['src/webview/**/*.ts'],
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
      'react-hooks/rules-of-hooks': 'error',      // Enable React hooks rule for webview .ts files
      'react-hooks/exhaustive-deps': 'error',    // Enable React hooks rule for webview .ts files
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
