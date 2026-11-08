/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Vitest globalSetup: runs once, before any worker forks. Several suites
// spawn the real `corepack pnpm`, and CI routes HOME to a fresh per-run
// directory, so without this every worker downloads the pinned pnpm into a
// cold cache at the same time. A losing concurrent install can leave the
// version folder unusable, and every later `corepack pnpm` on that home then
// crashes with MODULE_NOT_FOUND (#12436). Keeping the download serial avoids
// the race entirely.
export default function setup() {
  ensurePinnedPnpm();
}

function spawnPinnedPnpm() {
  return spawnSync('corepack', ['pnpm', '--version'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

export function ensurePinnedPnpm(spawn = spawnPinnedPnpm, env = process.env) {
  let result = spawn();
  if (result.status === 0) {
    return;
  }
  // An interrupted or raced earlier install can leave the pinned version
  // folder present but broken, and corepack keeps reusing it. Purge it once
  // so the retry reinstalls from scratch instead of reusing the wreckage.
  const installDir = pinnedPnpmInstallDir(env);
  if (installDir && existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
    result = spawn();
    if (result.status === 0) {
      return;
    }
  }
  throw new Error(
    `corepack could not provide the pinned pnpm (status ${result.status}): ` +
      (result.stderr || result.stdout || result.error),
  );
}

// Mirrors corepack's own cache layout: COREPACK_HOME ?? <cache root>/node/corepack,
// then v1/<name>/<version>.
function pinnedPnpmInstallDir(env) {
  const { packageManager } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const version = packageManager?.match(/^pnpm@([^+]+)/)?.[1];
  if (!version) {
    return null;
  }
  const home =
    env['COREPACK_HOME'] ??
    join(
      env['XDG_CACHE_HOME'] ??
        env['LOCALAPPDATA'] ??
        join(
          env['HOME'] ?? homedir(),
          process.platform === 'win32' ? join('AppData', 'Local') : '.cache',
        ),
      'node',
      'corepack',
    );
  return join(home, 'v1', 'pnpm', version);
}
