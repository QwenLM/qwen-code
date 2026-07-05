#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper.
 *
 * For most commands: launches dist/cli.js with --expose-gc so that
 * global.gc() is available for the memory-pressure monitor's critical-tier
 * cleanup.
 *
 * For bootstrap fast paths: imports cli.js directly in-process, skipping the
 * spawnSync overhead. These paths do not need global.gc(); the normal
 * interactive path still relaunches with --expose-gc for the memory-pressure
 * monitor.
 */

function hasFlag(flag, alias) {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--') {
      return false;
    }
    if (arg === flag || arg === alias) {
      return true;
    }
  }
  return false;
}

function isInProcessFastPath() {
  const first = process.argv[2];
  if (first === 'serve' || first === 'mcp') {
    return true;
  }
  if (first === undefined || first.startsWith('-')) {
    return hasFlag('--help', '-h') || hasFlag('--version', '-v');
  }
  return false;
}

const isTopLevelVersion =
  (process.argv[2] === undefined || process.argv[2].startsWith('-')) &&
  hasFlag('--version', '-v');

if (isTopLevelVersion && process.env['CLI_VERSION']) {
  process.stdout.write(`${process.env['CLI_VERSION']}\n`);
  process.exit(0);
}

const { existsSync } = await import('node:fs');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { dirname, join } = await import('node:path');

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPathCandidates = [
  join(__dirname, 'cli.js'),
  join(__dirname, '..', 'dist', 'cli.js'),
];
const packageJsonPathCandidates = [
  join(__dirname, 'package.json'),
  join(__dirname, '..', 'package.json'),
];
const cliPath =
  cliPathCandidates.find((candidate) => existsSync(candidate)) ??
  cliPathCandidates[0];
const packageJsonPath =
  packageJsonPathCandidates.find((candidate) => existsSync(candidate)) ??
  packageJsonPathCandidates[0];

if (isTopLevelVersion) {
  try {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    process.stdout.write(`${pkg.version || 'unknown'}\n`);
    process.exit(0);
  } catch {
    // Fall through to cli.js, which has its own version fallback.
  }
}

if (isInProcessFastPath()) {
  const { default: module } = await import('node:module');
  module.enableCompileCache?.();
  process.argv[1] = cliPath;
  await import(pathToFileURL(cliPath).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 1);
  }
}
