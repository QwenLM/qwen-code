/**
 * ESLint Configuration for Shared Package
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom rules for enforcing best practices in shared code.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import noDirectOpenImport from './eslint-rules/no-direct-open-import.cjs'
import noInlineSourceAuthCheck from './eslint-rules/no-inline-source-auth-check.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '*.cjs',
      'eslint-rules/**',
    ],
  },

  // TypeScript files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      // Custom plugin for shared package rules
      'craft-shared': {
        rules: {
          'no-direct-open-import': noDirectOpenImport,
          'no-inline-source-auth-check': noInlineSourceAuthCheck,
        },
      },
    },
    rules: {
      // Prevent direct imports of 'open' package — use openUrl() from utils instead
      'craft-shared/no-direct-open-import': 'error',
      // Prevent inline source.config.isAuthenticated checks — use isSourceUsable() instead
      'craft-shared/no-inline-source-auth-check': 'error',
    },
  },
]
