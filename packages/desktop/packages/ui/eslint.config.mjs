/**
 * ESLint Configuration for UI Package
 *
 * Uses flat config format (ESLint 9+).
 * Enforces use of StyledDropdown wrappers instead of raw Radix primitives.
 */

import tsParser from '@typescript-eslint/parser'
import noHardcodedZIndex from './eslint-rules/no-hardcoded-z-index.cjs'
import noFloatingZTokensInIsland from './eslint-rules/no-floating-z-tokens-in-island.cjs'
import noNonstandardShadows from './eslint-rules/no-nonstandard-shadows.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },

  // TypeScript/React files
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'craft-styles': {
        rules: {
          'no-hardcoded-z-index': noHardcodedZIndex,
          'no-floating-z-tokens-in-island': noFloatingZTokensInIsland,
          'no-nonstandard-shadows': noNonstandardShadows,
        },
      },
    },
    rules: {
      // Prevent direct Radix dropdown imports — use StyledDropdown wrappers instead
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@radix-ui/react-dropdown-menu',
            message: 'Use StyledDropdownMenuContent, StyledDropdownMenuItem, etc. from components/ui/StyledDropdown instead.',
          },
        ],
      }],

      // Enforce centralized z-index token scale
      'craft-styles/no-hardcoded-z-index': 'error',

      // Enforce dedicated island z-index tokens in island components
      'craft-styles/no-floating-z-tokens-in-island': 'error',

      // Enforce approved shadow utility classes/tokens only
      'craft-styles/no-nonstandard-shadows': ['error', {
        allowedClasses: [
          'shadow-none',
          'shadow-xs',
          'shadow-minimal',
          'shadow-tinted',
          'shadow-thin',
          'shadow-middle',
          'shadow-strong',
          'shadow-panel-focused',
          'shadow-modal-small',
          'shadow-bottom-border',
          'shadow-bottom-border-thin',
        ],
        allowInlineNone: true,
      }],
    },
  },

  // Temporary exceptions for unresolved shadow migrations.
  {
    files: [
      'src/components/ui/BrowserControls.tsx',
      'src/components/markdown/ImageCardStack.tsx',
      'src/components/ui/__tests__/styled-dropdown.test.ts',
    ],
    rules: {
      'craft-styles/no-nonstandard-shadows': 'off',
    },
  },

  // Allow raw Radix import in the styled wrapper itself
  {
    files: ['src/components/ui/StyledDropdown.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]
