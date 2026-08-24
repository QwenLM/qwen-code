#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * npm-distribution bin launcher for the Qwen Code CLI.
 *
 * The npm tarball ships JS only. The OpenTUI runtime — a pinned Bun build plus
 * the native renderer libraries — arrives through the matching per-platform
 * optional dependency (@qwen-code/qwen-code-<os>-<arch>) that npm installs
 * alongside this package. This launcher resolves that package for the current
 * platform and runs its bundled CLI entry under its bundled Bun, replicating
 * the standalone bin/qwen wrapper (which sets QWEN_CODE_LAUNCHER_PATH for the
 * in-CLI updater).
 *
 * The node entry (cli-entry.js) still ships in this package for environments
 * where the platform package is unavailable (offline install, --omit=optional,
 * mirrors that drop unknown packages).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_PACKAGES = {
  'darwin-arm64': '@qwen-code/qwen-code-darwin-arm64',
  'darwin-x64': '@qwen-code/qwen-code-darwin-x64',
  'linux-arm64': '@qwen-code/qwen-code-linux-arm64',
  'linux-x64': '@qwen-code/qwen-code-linux-x64',
  'win32-x64': '@qwen-code/qwen-code-win-x64',
};

function fail(message) {
  process.stderr.write(`qwen: ${message}\n`);
  process.exit(1);
}

function platformPackageName(platform = process.platform, arch = process.arch) {
  return PLATFORM_PACKAGES[`${platform}-${arch}`] ?? null;
}

function resolvePlatformPackageDir(name) {
  // The platform packages deliberately publish no "exports" map, so their
  // package.json stays resolvable as a subpath from this launcher.
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${name}/package.json`));
}

function main() {
  const args = process.argv.slice(2);
  const isWindows = process.platform === 'win32';

  const packageName = platformPackageName();
  if (!packageName) {
    fail(
      `no prebuilt runtime exists for ${process.platform}-${process.arch}. ` +
        'Install the standalone archive instead: ' +
        'https://github.com/QwenLM/qwen-code/releases',
    );
  }

  let packageDir;
  try {
    packageDir = resolvePlatformPackageDir(packageName);
  } catch {
    // npm-bin.js and cli-entry.js both sit at the package root; argv[1] can
    // be a .bin symlink elsewhere, so locate the fallback via this module.
    const fallbackEntry = join(
      dirname(fileURLToPath(import.meta.url)),
      'cli-entry.js',
    );
    fail(
      `the ${packageName} runtime package was not installed. ` +
        'This usually happens with --omit=optional installs or a ' +
        'registry/mirror that lacks the platform package. Reinstall without ' +
        '--omit=optional, or run the node-based fallback directly:\n' +
        `  node ${fallbackEntry}`,
    );
  }

  const runtime = isWindows
    ? join(packageDir, 'bun', 'bun.exe')
    : join(packageDir, 'bun', 'bin', 'bun');
  const cliEntry = join(packageDir, 'lib', 'cli-entry.js');
  if (!existsSync(runtime) || !existsSync(cliEntry)) {
    fail(`the ${packageName} runtime package is damaged (missing Bun or CLI).`);
  }

  // Mirrors the standalone bin/qwen wrapper: the in-CLI updater relaunches
  // through QWEN_CODE_LAUNCHER_PATH after a managed update.
  const launcherPath = isWindows
    ? join(packageDir, 'bin', 'qwen.cmd')
    : join(packageDir, 'bin', 'qwen');

  const child = spawn(runtime, [cliEntry, ...args], {
    stdio: 'inherit',
    env: { ...process.env, QWEN_CODE_LAUNCHER_PATH: launcherPath },
  });

  // Ctrl+C and SIGTERM reach this launcher and the CLI child alike (both share
  // the foreground process group). The child owns the exit decision — the
  // TUI's double-Ctrl+C guard runs there — so this launcher never exits
  // first: it waits for the child to close and mirrors its status. Signals
  // sent to the launcher alone are forwarded.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on('error', (error) => {
    fail(`failed to launch ${packageName}: ${error.message}`);
  });
  child.on('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

main();
