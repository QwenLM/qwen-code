/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Local ESLint config for vscode-ide-companion.
// Extends the root config and adds package-specific overrides.
//
// Why this file exists: the package runs `eslint src` from within its own
// directory. In ESLint flat config, `files` patterns are resolved relative
// to the config root (repo root). When ESLint is invoked from a subdirectory,
// file paths arrive as `src/...` rather than `packages/vscode-ide-companion/src/...`,
// so the root config's `packages/*/src/**/*.{ts,tsx}` overrides do not match.
// This local config re-applies the necessary rule overrides using `src/**` patterns.

import rootConfig from '../../eslint.config.js';
import importPlugin from 'eslint-plugin-import';

export default [
  ...rootConfig,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js'],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-internal-modules': 'off',
      'import/no-relative-packages': 'off',
      'no-console': 'off',
      'react/prop-types': 'off',
      // Re-apply _-prefix ignore patterns — root config uses `packages/*/src/**/*.{ts,tsx}`
      // which doesn't match when eslint is invoked from within this subdirectory.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
