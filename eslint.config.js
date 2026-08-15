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

// Static-import guard: relative specifiers only, enumerated by depth. The
// earlier `**/serve*` globs also matched third-party package names (`serve`,
// `@scope/serve`, `@scope/serve/subpath`), so bare/scoped specifiers must
// never reach the boundary check; imports deeper than six levels below src/
// do not occur in the guarded trees. `../serve` (bare directory) resolves to
// the serve/ barrel and stays covered.
const relativeServeImportPatterns = [];
for (let depth = 1; depth <= 6; depth++) {
  const prefix = '../'.repeat(depth);
  relativeServeImportPatterns.push(
    `${prefix}serve`,
    `${prefix}serve/*`,
    `${prefix}serve/**`,
  );
}

const restrictedServeImports = (message) => ({
  patterns: [{ group: relativeServeImportPatterns, message }],
});

// Dynamic-import guard. Relative spellings are matched with linear-time
// patterns — the previous nested-quantifier shape backtracked exponentially
// (ReDoS: ~4x cost per two added `../` segments). Non-literal sources and
// type-level imports cannot be resolved statically, and rounds 2-5 each
// demonstrated a new spelling entrance, so those are rejected fail-closed.
const serveDynamicImportPatterns = [
  // Canonical and duplicated-separator spellings: ../serve, ./../serve,
  // ..//serve, ../../serve/x, ...
  String.raw`^(?:\.\x2f+|\.\.\x2f+)+serve(?:\x2f|$)`,
  // Spellings routing through intermediate or traversal segments:
  // ../runtime/../serve/x, ../foo/../../../serve/x, ..//foo//serve, ...
  String.raw`^(?:\.\x2f+|\.\.\x2f+)+(?:[^\x2f]+\x2f+)+serve(?:\x2f|$)`,
  // A traversal run landing on serve from ANY position — covers a leading
  // literal segment (foo/../../../serve/x) that the dot-slash-anchored
  // patterns miss (round-6 entrance).
  String.raw`(?:^|\x2f)(?:\.\.\x2f+)+serve(?:\x2f|$)`,
];

// Computed dynamic-import sources cannot be statically checked against the
// serve/ boundary. Distinct from the boundary message on purpose: a
// developer hitting this did not necessarily import serve/.
const FAIL_CLOSED_DYNAMIC_IMPORT_MESSAGE =
  'Dynamically computed import sources cannot be checked against the serve/ ' +
  'boundary. Use a string-literal specifier so the boundary rule can see ' +
  'the target (#8084, #9146).';

// Node percent-decodes path segments when mapping the resolved URL to the
// filesystem (`../%73erve/index.js` loads serve/), while these selectors
// match raw specifier text — so any `%` in a guarded-tree specifier is
// rejected outright instead of pattern-matched (round-6 entrance).
const SERVE_BOUNDARY_PERCENT_MESSAGE =
  'Percent-encoded path segments bypass the serve/ boundary check; use the ' +
  'canonical specifier spelling (#8084).';

// vitest's module-loading call APIs resolve (and, without a factory, load)
// the real module — same boundary, CallExpression shape (round-6
// suggestion: vi.mock/doMock/importActual/importMock).
const vitestModuleLoadingCallSelector =
  'CallExpression[callee.object.name=/^(?:vi|vitest)$/][callee.property.name=/^(?:mock|doMock|importActual|importMock)$/]';

const restrictedServeDynamicImports = (message) => [
  ...serveDynamicImportPatterns.flatMap((pattern) => [
    {
      selector: `ImportExpression[source.value=/${pattern}/]`,
      message,
    },
    {
      selector: `ImportExpression[source.quasis.0.value.cooked=/${pattern}/]`,
      message,
    },
    // Static spellings must pass the same regexes: the depth-enumerated
    // no-restricted-imports globs only see canonical forms, while
    // `./../serve`, `..//serve`, and traversal-through-intermediate static
    // imports resolve to serve/ just the same (round-6 entrances).
    {
      selector: `ImportDeclaration[source.value=/${pattern}/]`,
      message,
    },
    {
      selector: `ExportNamedDeclaration[source.value=/${pattern}/]`,
      message,
    },
    {
      selector: `ExportAllDeclaration[source.value=/${pattern}/]`,
      message,
    },
    {
      // @typescript-eslint wraps the specifier in a TSLiteralType: the string
      // lives at argument.literal.value, NOT argument.value (probe-verified;
      // the old path was dead code).
      selector: `TSImportType[argument.literal.value=/${pattern}/]`,
      message,
    },
    // vitest module-loading calls (see vitestModuleLoadingCallSelector).
    {
      selector: `${vitestModuleLoadingCallSelector}[arguments.0.value=/${pattern}/]`,
      message,
    },
    {
      selector: `${vitestModuleLoadingCallSelector}[arguments.0.quasis.0.value.cooked=/${pattern}/]`,
      message,
    },
  ]),
  // Percent-encoded segments (see SERVE_BOUNDARY_PERCENT_MESSAGE).
  ...[
    'ImportExpression[source.value=/%/]',
    'ImportExpression[source.quasis.0.value.cooked=/%/]',
    'ImportDeclaration[source.value=/%/]',
    'ExportNamedDeclaration[source.value=/%/]',
    'ExportAllDeclaration[source.value=/%/]',
    'TSImportType[argument.literal.value=/%/]',
    `${vitestModuleLoadingCallSelector}[arguments.0.value=/%/]`,
  ].map((selector) => ({
    selector,
    message: SERVE_BOUNDARY_PERCENT_MESSAGE,
  })),
  // Fail-closed: concatenation, `new URL(...)`, template literals containing
  // expressions, and any other computed source cannot be proven safe
  // statically (rounds 2-6 each demonstrated a new entrance). Pure template
  // literals (no expressions) are fully described by their first quasi and
  // stay covered by the pattern selectors above. These hits get their own
  // message: the policy is "computed sources cannot be checked", not "you
  // imported serve/".
  {
    selector:
      'ImportExpression:not([source.type="Literal"]):not([source.type="TemplateLiteral"])',
    message: FAIL_CLOSED_DYNAMIC_IMPORT_MESSAGE,
  },
  {
    selector: 'ImportExpression[source.type="TemplateLiteral"][source.expressions.0]',
    message: FAIL_CLOSED_DYNAMIC_IMPORT_MESSAGE,
  },
  {
    selector: `${vitestModuleLoadingCallSelector}:not([arguments.0.type="Literal"]):not([arguments.0.type="TemplateLiteral"])`,
    message: FAIL_CLOSED_DYNAMIC_IMPORT_MESSAGE,
  },
  {
    selector: `${vitestModuleLoadingCallSelector}[arguments.0.type="TemplateLiteral"][arguments.0.expressions.0]`,
    message: FAIL_CLOSED_DYNAMIC_IMPORT_MESSAGE,
  },
];

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
    // transitively one hop away.
    files: ['packages/cli/src/runtime/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedServeImports(
          'packages/cli/src/runtime must not import serve/ internals (#8084).',
        ),
      ],
    },
  },
  {
    // `utils/` is the layer every other directory imports, so it must not
    // import back into one. The daemon direction is clean and enforced here;
    // the remaining `ui/`, `config/`, `i18n/` and `nonInteractive/` edges are
    // tracked in #9146 and will be added to this group as they are resolved.
    files: ['packages/cli/src/utils/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedServeImports(
          'packages/cli/src/utils must not import serve/. Move lifecycle-free logic down into utils/ instead (#9146).',
        ),
      ],
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
  },
  {
    // Positioned after the general TS block so the dynamic-import guard is not
    // overwritten by the shared `no-restricted-syntax` rule.
    files: ['packages/cli/src/runtime/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': serveGuardSyntaxRules(
        'packages/cli/src/runtime must not dynamically import serve/ internals (#8084).',
      ),
    },
  },
  {
    // Positioned after the general TS block so the dynamic-import guard is not
    // overwritten by the shared `no-restricted-syntax` rule.
    files: ['packages/cli/src/utils/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': serveGuardSyntaxRules(
        'packages/cli/src/utils must not dynamically import serve/. Move lifecycle-free logic down into utils/ instead (#9146).',
      ),
    },
  },
  {
    // ACP integration and the daemon are separate runtime surfaces that happen
    // to share a package directory. ACP may consume neutral contracts under
    // `runtime/`, but never `serve/` implementation modules — see #8084.
    // Enforcement point is `npm run lint` in CI; fixture coverage lives in
    // scripts/tests/eslint-boundary-rules.test.js (serve-boundary cases plus
    // a string-throw probe that pins the restated selectors below).
    //
    // Positioned after the general TS block on purpose: flat config lets the
    // last matching block win per rule, and that block also configures
    // `no-restricted-syntax` — placing this one earlier would silently lose
    // the dynamic-import guard below. The shared selectors are restated via
    // serveGuardSyntaxRules so this override does not drop them.
    files: ['packages/cli/src/acp-integration/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedServeImports(
          'acp-integration must not import serve/ internals. Put shared, lifecycle-free logic in packages/cli/src/runtime/ instead (#8084).',
        ),
      ],
      // no-restricted-imports only visits static import/export declarations;
      // the same boundary applies to dynamic `await import('../serve/…')`.
      // The selector regex spells `/` as `\x2f` because esquery cannot parse
      // a literal slash inside its attribute-regex syntax.
      'no-restricted-syntax': serveGuardSyntaxRules(
        'acp-integration must not dynamically import serve/ internals. Put shared, lifecycle-free logic in packages/cli/src/runtime/ instead (#8084).',
      ),
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
