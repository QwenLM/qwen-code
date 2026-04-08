/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// vscode-ide-companion/package.json declares `"type": "module"`, so this
// file is parsed as ESM and must use `export default` instead of
// `module.exports`. Using CJS syntax here causes `npm install`'s prepare
// script to crash and breaks vitest runs from any parent directory that
// triggers PostCSS config discovery (e.g. running `npm test` from the
// monorepo root).
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
