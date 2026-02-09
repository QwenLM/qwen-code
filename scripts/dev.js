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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliPackageDir = join(root, 'packages', 'cli');

// Resolve tsx from node_modules
const tsxPath = resolve(root, 'node_modules', '.bin', 'tsx');

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

const env = {
  ...process.env,
  DEV: 'true',
  CLI_VERSION: 'dev',
  NODE_ENV: 'development',
  // Use --import with register() instead of deprecated --loader
  NODE_OPTIONS: `--import ${pathToFileURL(registerPath).href}`,
};

const nodeArgs = [tsxPath, cliEntry, ...process.argv.slice(2)];

const child = spawn('node', nodeArgs, {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
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
