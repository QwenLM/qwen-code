/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Development entry point for Qwen Code CLI.
 *
 * Runs the CLI directly from TypeScript source files without requiring a build step.
 * Changes to packages/core or packages/cli are reflected immediately.
 *
 * Usage: npm run dev -- [args]
 * Example: npm run dev -- help
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliPackageDir = join(root, 'packages', 'cli');

// Ensure qc-helper bundled skill can find user docs in dev mode.
// In dev, import.meta.url resolves to the source tree, so the bundled skill
// directory is packages/core/src/skills/bundled/qc-helper/. We create a
// symlink from there to docs/users/ so the skill can read docs at runtime.
const qcHelperDocsLink = join(
  root,
  'packages',
  'core',
  'src',
  'skills',
  'bundled',
  'qc-helper',
  'docs',
);
const userDocsTarget = join(root, 'docs', 'users');
if (existsSync(userDocsTarget) && !existsSync(qcHelperDocsLink)) {
  mkdirSync(dirname(qcHelperDocsLink), { recursive: true });
  try {
    symlinkSync(userDocsTarget, qcHelperDocsLink);
  } catch {
    // Symlink may fail on some systems; non-critical for dev
  }
}

// Entry point for the CLI
const cliEntry = join(cliPackageDir, 'index.ts');

// Create a temporary loader file
const tmpDir = mkdtempSync(join(tmpdir(), 'qwen-dev-'));
const loaderPath = join(tmpDir, 'loader.mjs');

const coreSourcePath = join(root, 'packages', 'core', 'index.ts');
const coreSourceUrl = pathToFileURL(coreSourcePath).href;

const loaderCode = `
import { pathToFileURL } from 'node:url';

const coreSourceUrl = '${coreSourceUrl}';

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@qwen-code/qwen-code-core') {
    return {
      shortCircuit: true,
      url: coreSourceUrl,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
`;

writeFileSync(loaderPath, loaderCode);

// Create the register script that uses the new register() API
const registerPath = join(tmpDir, 'register.mjs');
const loaderUrl = pathToFileURL(loaderPath).href;
const registerCode = `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('${loaderUrl}', pathToFileURL('./'));
`;
writeFileSync(registerPath, registerCode);

// Preserve existing NODE_OPTIONS (e.g. VS Code debugger injects --inspect flags via NODE_OPTIONS)
const existingNodeOptions = process.env.NODE_OPTIONS || '';
const importFlag = `--import ${pathToFileURL(registerPath).href}`;

const env = {
  ...process.env,
  DEV: 'true',
  CLI_VERSION: 'dev',
  NODE_ENV: 'development',
  NODE_OPTIONS: `${existingNodeOptions} ${importFlag}`.trim(),
};

// On Windows, use tsx.cmd; on Unix, use tsx directly
const isWin = platform() === 'win32';
const tsxCmd = isWin ? 'tsx.cmd' : 'tsx';
const tsxArgs = [cliEntry, ...process.argv.slice(2)];

const child = spawn(tsxCmd, tsxArgs, {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
  shell: isWin, // Use shell on Windows to resolve .cmd files
});

child.on('error', (err) => {
  console.error('Failed to start dev server:', err.message);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  process.exit(1);
});

child.on('close', (code) => {
  // Cleanup temp directory
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  process.exit(code ?? 0);
});
