#!/usr/bin/env node
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
  readFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliPackageDir = join(root, 'packages', 'cli');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

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

const coreDir = join(root, 'packages', 'core');
const coreSpecifier = '@qwen-code/qwen-code-core';
const coreSourceUrl = pathToFileURL(join(coreDir, 'index.ts')).href;
const coreSrcUrl = pathToFileURL(join(coreDir, 'src') + '/').href;

const coreExports = JSON.parse(
  readFileSync(join(coreDir, 'package.json'), 'utf-8'),
).exports;

const coreSubpathSourceUrls = {};
for (const [subpath, conditions] of Object.entries(coreExports ?? {})) {
  const distEntry = conditions?.import;
  // Skips the root (handled below) and the string-valued entries — `./dist/*`,
  // `./src/*`, `./package.json` — whose target is not one fixed source file.
  if (subpath === '.' || typeof distEntry !== 'string') continue;
  if (!distEntry.startsWith('./dist/')) continue;
  const sourcePath = join(
    coreDir,
    distEntry.slice('./dist/'.length).replace(/\.js$/, '.ts'),
  );
  if (existsSync(sourcePath)) {
    coreSubpathSourceUrls[`${coreSpecifier}/${subpath.slice(2)}`] =
      pathToFileURL(sourcePath).href;
  }
}

const loaderCode = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const coreSourceUrl = '${coreSourceUrl}';
const coreSubpathSourceUrls = ${JSON.stringify(coreSubpathSourceUrls, null, 2)};
const coreSrcUrl = '${coreSrcUrl}';
const corePrefix = '${coreSpecifier}/';

export function resolve(specifier, context, nextResolve) {
  const url =
    specifier === '${coreSpecifier}'
      ? coreSourceUrl
      : coreSubpathSourceUrls[specifier];
  if (url) {
    return {
      shortCircuit: true,
      url,
      format: 'module',
    };
  }
  if (specifier.startsWith(corePrefix)) {
    // Deep paths mirror packages/core/src; leave missing files to Node.
    const sub = specifier.slice(corePrefix.length).replace(/\\.js$/, '');
    for (const ext of ['.ts', '.tsx']) {
      const candidate = new URL(sub + ext, coreSrcUrl);
      if (existsSync(fileURLToPath(candidate))) {
        return { shortCircuit: true, url: candidate.href, format: 'module' };
      }
    }
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
  // Report the real package version (like scripts/start.js) so the UI shows
  // e.g. "v0.19.4" instead of "dev". DEV=true / NODE_ENV=development remain the
  // signals that distinguish a dev build.
  CLI_VERSION: pkg.version,
  NODE_ENV: 'development',
  NODE_OPTIONS: `${existingNodeOptions} --expose-gc ${importFlag}`.trim(),
  // The entry a `qwen …` subprocess should call to reach THIS build — without
  // it, a skill that shells out to `qwen` gets whatever PATH resolves, which on
  // a dev machine is routinely an older global install. Assignment, not `??` or
  // `||=`: an inherited value is another session's CLI (a dev CLI started from
  // inside an outer qwen session's shell — the usual dogfooding flow), and
  // honouring it re-points every subprocess at the outer build — the same skew,
  // one level up, and silent. Each entry stamps itself; nested sessions each
  // call their own build. This one line also covers `npm run dev:daemon`, which
  // launches serve through this file.
  QWEN_CODE_CLI: fileURLToPath(import.meta.url),
};

// On Windows, use tsx.cmd; on Unix, use tsx directly
const isWin = platform() === 'win32';
const tsxBinName = isWin ? 'tsx.cmd' : 'tsx';
const localTsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const localTsxCmd = join(root, 'node_modules', '.bin', tsxBinName);
const hasLocalTsxCli = existsSync(localTsxCli);
const tsxCmd = hasLocalTsxCli
  ? process.execPath
  : existsSync(localTsxCmd)
    ? localTsxCmd
    : tsxBinName;
const tsxArgs = [
  ...(hasLocalTsxCli ? [localTsxCli] : []),
  cliEntry,
  ...process.argv.slice(2),
];
const useShell = isWin && !hasLocalTsxCli;

const child = spawn(tsxCmd, tsxArgs, {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
  shell: useShell, // Needed only when falling back to tsx.cmd on Windows.
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

child.on('close', (code, signal) => {
  // Cleanup temp directory
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  // A signal-killed child reports `code === null`, and `code ?? 0` read that as
  // success. This launcher is a QWEN_CODE_CLI entry now: a review gate command
  // OOM-killed mid-run must not come back green. Re-raise the signal the way
  // cli-entry.js does, so the caller sees the same death; fall back to a
  // non-zero exit if the signal cannot be re-raised.
  if (signal) {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      process.exit(1);
    }
  }
  process.exit(code ?? 1);
});
