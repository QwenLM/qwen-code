/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const NPM_BUN_OPTIONAL_DEPENDENCIES = Object.fromEntries(
  [
    '@oven/bun-darwin-aarch64',
    '@oven/bun-darwin-x64',
    '@oven/bun-linux-aarch64',
    '@oven/bun-linux-x64',
  ].map((name) => [name, '1.4.4']),
);

export const NPM_OPENTUI_NATIVE_ASSETS = {
  '@opentui/core-darwin-arm64': 'libopentui.dylib',
  '@opentui/core-darwin-x64': 'libopentui.dylib',
  '@opentui/core-linux-arm64': 'libopentui.so',
  '@opentui/core-linux-x64': 'libopentui.so',
};

export const OPENTUI_COMMON_ASSETS = [
  '@opentui/core/parser.worker.js',
  '@opentui/core/assets/javascript/highlights.scm',
  '@opentui/core/assets/javascript/tree-sitter-javascript.wasm',
  '@opentui/core/assets/typescript/highlights.scm',
  '@opentui/core/assets/typescript/tree-sitter-typescript.wasm',
  '@opentui/core/assets/markdown/highlights.scm',
  '@opentui/core/assets/markdown/injections.scm',
  '@opentui/core/assets/markdown/tree-sitter-markdown.wasm',
  '@opentui/core/assets/markdown_inline/highlights.scm',
  '@opentui/core/assets/markdown_inline/tree-sitter-markdown_inline.wasm',
  '@opentui/core/assets/zig/highlights.scm',
  '@opentui/core/assets/zig/tree-sitter-zig.wasm',
  'web-tree-sitter/tree-sitter.wasm',
];

function lockedVersions(rootDir, packageNames) {
  const keys = Object.keys(
    parseYaml(fs.readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'))
      ?.packages ?? {},
  );
  return Object.fromEntries(
    packageNames.map((name) => {
      const versions = keys
        .filter((key) => key.startsWith(`${name}@`))
        .map((key) => key.slice(name.length + 1));
      if (versions.length !== 1) {
        throw new Error(
          `OpenTUI platform package version is not locked for ${name}`,
        );
      }
      return [name, versions[0]];
    }),
  );
}

export function stageOpenTuiPackages(rootDir, runtimeDir, packageNames) {
  const installDir = path.join(runtimeDir, 'opentui-modules');
  fs.mkdirSync(installDir, { recursive: true });
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error('npm_execpath is unavailable; run packaging via npm run');
  }
  const versions = lockedVersions(rootDir, packageNames);
  execFileSync(
    process.execPath,
    [
      npmExecPath,
      'install',
      '--prefix',
      installDir,
      '--package-lock=false',
      '--no-save',
      '--ignore-scripts',
      '--force',
      '--no-audit',
      '--no-fund',
      ...Object.entries(versions).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  const modulesDir = path.join(installDir, 'node_modules');
  for (const [name, version] of Object.entries(versions)) {
    const installed = JSON.parse(
      fs.readFileSync(path.join(modulesDir, name, 'package.json'), 'utf8'),
    );
    if (installed.name !== name || installed.version !== version) {
      throw new Error(
        `Staged OpenTUI package does not match ${name}@${version}`,
      );
    }
  }
  return modulesDir;
}

export function prepareNpmOpenTuiAssets(distDir, modulesDir) {
  const assetRoot = path.join(distDir, 'opentui-assets');
  if (modulesDir) {
    for (const [name, library] of Object.entries(NPM_OPENTUI_NATIVE_ASSETS)) {
      const destination = path.join(assetRoot, name, library);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(modulesDir, name, library), destination);
    }
  }
  const required = [
    ...OPENTUI_COMMON_ASSETS,
    ...Object.entries(NPM_OPENTUI_NATIVE_ASSETS).map(
      ([name, library]) => `${name}/${library}`,
    ),
  ];
  for (const key of required) {
    let present = false;
    try {
      present = fs.statSync(path.join(assetRoot, key)).isFile();
    } catch {
      // Report the asset key instead of an absolute temporary staging path.
    }
    if (!present)
      throw new Error(`Required npm OpenTUI asset not found: ${key}`);
  }
}
