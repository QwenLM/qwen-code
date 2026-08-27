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
 * platform and runs its bundled CLI entry under its bundled Bun.
 *
 * Whenever the platform package is unavailable — unsupported platform,
 * --omit=optional install, registry/mirror that lacks it, or a damaged
 * extraction — the launcher falls back to the node entry (cli-entry.js) that
 * ships in this same package, so `qwen` keeps working (including the exit-44
 * post-update relaunch that re-enters through this bin) exactly as it did
 * before the platform packages existed.
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

function launchChild(command, commandArgs, onLaunchError) {
  const child = spawn(command, commandArgs, { stdio: 'inherit' });
  let spawnFailed = false;

  // Ctrl+C and SIGTERM reach this launcher and the CLI child alike (both share
  // the foreground process group). The child owns the exit decision — the
  // TUI's double-Ctrl+C guard runs there — so this launcher never exits
  // first: it waits for the child to close and mirrors its status. Signals
  // sent to the launcher alone are forwarded. On Windows the console already
  // delivers CTRL_C_EVENT to every attached process, and child.kill('SIGINT')
  // maps to TerminateProcess — an ungraceful kill that would defeat the CLI's
  // double-Ctrl+C guard — so SIGINT is not forwarded there.
  const forwardedSignals =
    process.platform === 'win32'
      ? ['SIGTERM']
      : ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];
  const forwarders = forwardedSignals.map((signal) => {
    const handler = () => {
      child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler];
  });

  child.on('error', (error) => {
    // A spawn failure also emits 'close' (with a negative code); mark the
    // failure so the close-mirror path below stays silent while the error
    // handler decides what happens next.
    spawnFailed = true;
    onLaunchError(error);
  });
  child.on('close', (code, signal) => {
    if (spawnFailed) return;
    if (signal) {
      // Drop the forwarders first: registering a listener replaced the
      // default terminating action, so a re-raise that re-enters them would
      // be swallowed and this launcher would hang on a dead child.
      for (const [name, handler] of forwarders) {
        process.removeListener(name, handler);
      }
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const isWindows = process.platform === 'win32';

  // This launcher always runs under the host Node; publish its path so the
  // update check can resolve npm even when the CLI itself runs under the
  // platform package's bundled Bun (where process.execPath is the Bun binary
  // and no npm lives next to it).
  process.env['QWEN_CODE_HOST_NODE'] ??= process.execPath;

  // npm-bin.js and cli-entry.js both sit at the package root; argv[1] can be
  // a .bin symlink elsewhere, so locate the fallback via this module.
  const fallbackEntry = join(
    dirname(fileURLToPath(import.meta.url)),
    'cli-entry.js',
  );
  const runNodeFallback = (reason) => {
    process.stderr.write(`qwen: ${reason} Falling back to node.\n`);
    launchChild(process.execPath, [fallbackEntry, ...args], (error) =>
      fail(`failed to launch ${fallbackEntry}: ${error.message}`),
    );
  };

  const packageName = platformPackageName();
  if (!packageName) {
    runNodeFallback(
      `no prebuilt runtime exists for ${process.platform}-${process.arch}.`,
    );
    return;
  }

  let packageDir;
  try {
    packageDir = resolvePlatformPackageDir(packageName);
  } catch {
    runNodeFallback(
      `the ${packageName} runtime package was not installed. ` +
        'This usually happens with --omit=optional installs or a ' +
        'registry/mirror that lacks the platform package.',
    );
    return;
  }

  const runtime = isWindows
    ? join(packageDir, 'bun', 'bun.exe')
    : join(packageDir, 'bun', 'bin', 'bun');
  const cliEntry = join(packageDir, 'lib', 'cli-entry.js');
  if (!existsSync(runtime) || !existsSync(cliEntry)) {
    runNodeFallback(
      `the ${packageName} runtime package is damaged (missing Bun or CLI). ` +
        'Reinstalling the package usually fixes this.',
    );
    return;
  }

  launchChild(runtime, [cliEntry, ...args], (error) => {
    // The runtime exists but cannot execute — e.g. a glibc-linked Bun on a
    // musl host, or a noexec mount. The node entry ships in this same
    // package, so degrade to it instead of dying here.
    runNodeFallback(
      `the ${packageName} runtime failed to start (${error.message}).`,
    );
  });
}

main();
