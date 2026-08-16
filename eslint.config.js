/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';
// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from 'eslint-plugin-storybook';
import checkFile from 'eslint-plugin-check-file';
import { legacyFilenames } from './eslint.legacy-filenames.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import noServeBoundaryCross from './eslint-rules/no-serve-boundary-cross.js';

// Resolution-based serve boundary guard (#8084, #9144 round-8 decision):
// a local rule that RESOLVES each import-like specifier against the
// importing file and reports anything landing inside src/serve/,
// fail-closed on sources it cannot check statically. It replaces the
// spelling-by-spelling regex/glob matrix (depth-enumerated globs,
// per-shape selector regexes, percent/query/fragment/absolute/createRequire
// special cases) — eight review rounds each demonstrated a new spelling
// escaping that matrix, because every spelling is just another way to name
// the same target.
const serveBoundaryPlugin = {
  rules: { 'no-serve-boundary-cross': noServeBoundaryCross },
};
const configDir = path.dirname(fileURLToPath(import.meta.url));
const serveBoundaryOptions = {
  serveDir: path.resolve(configDir, 'packages/cli/src/serve'),
  baseUrlDir: path.resolve(configDir, 'packages/cli'),
};

const restrictedRequire = {
  selector: 'CallExpression[callee.name="require"]',
  message: 'Avoid using require(). Use ES6 imports instead.',
};

const restrictedStringThrow = {
  selector: 'ThrowStatement > Literal:not([value=/^\\w+Error:/])',
  message:
    'Do not throw string literals or non-Error objects. Throw new Error("...") instead.',
};

// The three guarded trees (runtime/, utils/, acp-integration/) share one
// no-restricted-syntax shape. Flat config replaces rule options wholesale,
// so the array is built in one place — a future selector added here reaches
// every guarded tree instead of needing hand-replication in each block.
const serveGuardSyntaxRules = (message) => [
  'error',
  restrictedRequire,
  restrictedStringThrow,
  ...restrictedServeDynamicImports(message),
];

export default tseslint.config(
  {
    // Global ignores
    ignores: [
      'node_modules/*',
      'packages/**/dist/**',
      'integrations/**/dist/**',
      'bundle/**',
      'package/bundle/**',
      '.integration-tests/**',
      'packages/**/.integration-test/**',
      'dist/**',
      'demo/**/dist/**',
      'docs-site/.next/**',
      'docs-site/out/**',
      '.qwen/**',
      'packages/desktop/**',
      'packages/desktop-shell/runtime/**',
      'packages/desktop-shell/src-tauri/target/**',
      'packages/cua-driver/**', // vendored trycua/cua driver (Rust + scripts); not qwen-code TS
      'packages/mobile-mcp/**', // vendored mobile-next/mobile-mcp; has own eslint config
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs['recommended-latest'],
  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat['jsx-runtime'], // Add this if you are using React 17+
  {
    // Settings for eslint-plugin-react
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    // Import specific config
    files: ['packages/cli/src/**/*.{ts,tsx}'], // Target only TS/TSX in the cli package
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: true,
      },
    },
    rules: {
      ...importPlugin.configs.recommended.rules,
      ...importPlugin.configs.typescript.rules,
      'import/no-default-export': 'warn',
      'import/no-unresolved': 'off', // Disable for now, can be noisy with monorepos/paths
      'import/namespace': 'off', // Disabled due to https://github.com/import-js/eslint-plugin-import/issues/2866
    },
  },
  {
    // `runtime/` is the neutral layer acp-integration is directed to; it must
    // not import `serve/` internals itself, or the #8084 boundary reforms
    // transitively one hop away. Enforced by the resolution-based local rule
    // (see serveBoundaryPlugin above).
    files: ['packages/cli/src/runtime/**/*.{ts,tsx}'],
    plugins: { 'qwen-boundary': serveBoundaryPlugin },
    rules: {
      'qwen-boundary/no-serve-boundary-cross': ['error', serveBoundaryOptions],
    },
  },  {
    // `utils/` is the layer every other directory imports, so it must not
    // import back into one. The daemon direction is clean and enforced here;
    // the remaining `ui/`, `config/`, `i18n/` and `nonInteractive/` edges are
    // tracked in #9146 and will be added to this group as they are resolved.
    // Enforced by the resolution-based local rule (see serveBoundaryPlugin).
    files: ['packages/cli/src/utils/**/*.{ts,tsx}'],
    plugins: { 'qwen-boundary': serveBoundaryPlugin },
    rules: {
      'qwen-boundary/no-serve-boundary-cross': ['error', serveBoundaryOptions],
    },
  },
  {
    // General overrides and rules for the project (TS/TSX files)
    files: [
      'packages/**/src/**/*.{ts,tsx}',
      'integrations/**/src/**/*.{ts,tsx}',
    ],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: true,
      },
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      // We use TypeScript for React components; prop-types are unnecessary
      'react/prop-types': 'off',
      // General Best Practice Rules (subset adapted for flat config)
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      'arrow-body-style': ['error', 'as-needed'],
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'no-public' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-inferrable-types': [
        'error',
        { ignoreParameters: true, ignoreProperties: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'import/no-internal-modules': [
        'error',
        {
          allow: [
            'react-dom/test-utils',
            'react-dom/client',
            'memfs/lib/volume.js',
            'mime/lite',
            'yargs/**',
            'msw/node',
            '**/generated/**',
            './styles/tailwind.css',
            './styles/App.css',
            './styles/style.css'
          ],
        },
      ],
      'import/no-relative-packages': 'error',
      'no-cond-assign': 'error',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-restricted-syntax': [
        'error',
        restrictedRequire,
        restrictedStringThrow,
      ],
      'no-unsafe-finally': 'error',
      'no-console': 'error',
      'no-unused-expressions': 'off', // Disable base rule
      '@typescript-eslint/no-unused-expressions': [
        // Enable TS version
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      'no-var': 'error',
      'object-shorthand': 'error',
      'one-var': ['error', 'never'],
      'prefer-arrow-callback': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      radix: 'error',
      'default-case': 'error',
    },
  },  {
    // ACP integration and the daemon are separate runtime surfaces that happen
    // to share a package directory. ACP may consume neutral contracts under
    // `runtime/`, but never `serve/` implementation modules — see #8084.
    // Enforced by the resolution-based local rule (see serveBoundaryPlugin);
    // fixture coverage lives in scripts/tests/eslint-boundary-rules.test.js.
    files: ['packages/cli/src/acp-integration/**/*.{ts,tsx}'],
    plugins: { 'qwen-boundary': serveBoundaryPlugin },
    rules: {
      'qwen-boundary/no-serve-boundary-cross': ['error', serveBoundaryOptions],
    },
  },
  {
    files: [
      'packages/web-shell/client/**/*.{ts,tsx}',
      'packages/web-shell/*.config.ts',
    ],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: true,
      },
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
    },
    rules: {
      'react/prop-types': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'object-shorthand': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    files: [
      'packages/web-shell/client/**/*.test.{ts,tsx}',
      'packages/web-shell/client/test/**/*.{ts,tsx}',
    ],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.vitest,
      },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': 'off',
      'vitest/no-commented-out-tests': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['packages/web-shell/client/e2e/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Enforce kebab-case filenames
    files: ['packages/core/src/**/*.ts', 'packages/cli/src/**/*.ts'],
    ignores: legacyFilenames.flatMap((name) => [
      `**/${name}.ts`,
      `**/${name}.*.ts`,
    ]),
    plugins: {
      'check-file': checkFile,
    },
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
    },
  },
  {
    files: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/**/test/**/*.test.{ts,tsx}',
      'integrations/**/src/**/*.test.{ts,tsx}',
    ],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': 'off',
      'vitest/no-commented-out-tests': 'off',
      'no-console': 'off', // Allow console in tests
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
  // extra settings for scripts that we run directly with node
  {
    files: [
      './scripts/**/*.js',
      './scripts/**/*.mjs',
      'esbuild.config.js',
      'packages/*/scripts/**/*.js',
      // Verification reproducer scripts under docs/ also run with `node`.
      'docs/**/*.mjs',
      // Plan C CDP-tunnel acceptance harness (issue #5626) runs with `node`.
      'packages/cli/src/serve/cdp-tunnel/acceptance/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-console': 'off', // Allow console in scripts
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
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['.github/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['packages/desktop-shell/bootstrap/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // ==================== no-console allowlist ====================
  // The following files/packages are allowed to use console.*

  // VS Code IDE companion - out of scope for no-console rule
  {
    files: ['packages/vscode-ide-companion/**/*.ts', 'packages/vscode-ide-companion/**/*.tsx', 'packages/vscode-ide-companion/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  // WebUI package - UI component library with Storybook
  {
    files: ['packages/webui/**/*.ts', 'packages/webui/**/*.tsx', 'packages/webui/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  // Chrome extension (chrome-extension) - the MV3 background service
  // worker and content scripts run in the browser with no stdio; console is
  // the only logging / debugging channel available there.
  {
    files: ['packages/chrome-extension/**/*.ts', 'packages/chrome-extension/**/*.tsx'],
    rules: { 'no-console': 'off' },
  },
  // Specific CLI files that intentionally wrap console usage
  {
    files: [
      'packages/cli/src/acp-integration/acpAgent.ts',      // console infrastructure for ACP mode
      'packages/cli/src/utils/stdioHelpers.ts',            // wraps console.clear()
    ],
    rules: { 'no-console': 'off' },
  },
  // Specific esbuild configs not covered by scripts pattern
  {
    files: ['packages/vscode-ide-companion/esbuild.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
  // Settings for web-templates assets
  {
    files: [
      'packages/web-templates/src/**/*.{js,jsx,ts,tsx}',
      'packages/web-templates/*.mjs',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-console': 'off',
      'no-undef': 'off',
    },
  },
  // Prettier config must be last
  prettierConfig,
  // extra settings for scripts that we run directly with node
  {
    files: ['./integration-tests/**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-console': 'off', // Allow console in integration tests
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
  // Settings for docs-site directory
  {
    files: ['docs-site/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      // Allow relaxed rules for documentation site
      '@typescript-eslint/no-unused-vars': 'off',
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
    },
  },
  storybook.configs['flat/recommended'],
);
