/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const RESUME_ENV = 'QWEN_CODE_RESUME_SESSION_ID';
const CLI_PATH_ENV = 'QWEN_CODE_CLI_PATH';

function isFilePath(spec: string): boolean {
  return spec.includes('/') || spec.includes('\\');
}

function resolveBundledCliPath(): string | null {
  const candidates: string[] = [];

  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('@qwen-code/sdk/package.json');
    const packageRoot = path.dirname(packageJsonPath);
    candidates.push(path.join(packageRoot, 'dist', 'cli', 'cli.js'));
  } catch {
    // Ignore resolution errors and fall back to other candidates.
  }

  const cwd = process.cwd();
  candidates.push(path.join(cwd, 'dist', 'cli', 'cli.js'));
  candidates.push(path.join(cwd, 'dist', 'cli.js'));
  candidates.push(
    path.join(cwd, 'packages', 'sdk-typescript', 'dist', 'cli', 'cli.js'),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCliCommand(): { command: string; args: string[] } {
  const explicitPath = process.env[CLI_PATH_ENV];
  if (explicitPath) {
    if (isFilePath(explicitPath)) {
      const ext = path.extname(explicitPath).toLowerCase();
      if (['.js', '.mjs', '.cjs'].includes(ext)) {
        return { command: process.execPath, args: [explicitPath] };
      }
    }
    return { command: explicitPath, args: [] };
  }

  const bundledPath = resolveBundledCliPath();
  if (bundledPath) {
    return { command: process.execPath, args: [bundledPath] };
  }

  return { command: 'qwen', args: [] };
}

const cliArgs = process.argv.slice(2);
const resumeSessionId = process.env[RESUME_ENV];
if (resumeSessionId) {
  cliArgs.push('--resume', resumeSessionId);
}

const { command, args } = resolveCliCommand();
const child = spawn(command, [...args, ...cliArgs], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  } else {
    process.exit(code ?? 0);
  }
});

child.on('error', (error) => {
  console.error('Failed to start Qwen CLI:', error);
  process.exit(1);
});
