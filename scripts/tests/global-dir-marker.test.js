/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_DIR_MARKER,
  Storage,
} from '../../packages/core/src/config/storage.ts';
import { getGlobalQwenDirLite } from '../../packages/cli/src/config/storage-paths-lite.ts';
import { getGlobalQwenDir as getChannelsGlobalQwenDir } from '../../packages/channels/base/src/paths.ts';
import { resolveQwenHome } from '../../packages/sdk-typescript/src/peer/registry.ts';
import {
  getGlobalQwenDir as getCompanionGlobalQwenDir,
  resetEnvBootstrapForTesting,
} from '../../packages/vscode-ide-companion/src/utils/paths.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(root, file), 'utf8');

// The launcher runs the CLI when imported, so evaluate only its resolver,
// with the bindings it imports.
const launcherSource = /^function getDefaultQwenHome\(\) \{$[\s\S]*?^\}$/m.exec(
  read('scripts/cli-entry.js'),
)?.[0];
const launcherResolver = launcherSource
  ? new Function(
      'existsSync',
      'homedir',
      'tmpdir',
      'join',
      'isAbsolute',
      `${launcherSource}\nreturn getDefaultQwenHome;`,
    )(existsSync, homedir, tmpdir, join, isAbsolute)
  : () => {
      throw new Error('scripts/cli-entry.js has no getDefaultQwenHome()');
    };

// The /stuck skill's shell preamble, run with `uname -s` reporting Linux.
function runStuckPreamble(home, env) {
  const preamble = /\*\*Preamble[^\n]*\n\n```\n([\s\S]*?)```/.exec(
    read('packages/core/src/skills/bundled/stuck/SKILL.md'),
  )?.[1];
  expect(preamble).toBeTruthy();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', {
    mode: 0o755,
  });
  const result = spawnSync(
    'bash',
    ['-c', `${preamble}\nprintf %s "$QWEN_DIR"`],
    {
      env: {
        PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
        HOME: home,
        ...env,
      },
      encoding: 'utf8',
    },
  );
  expect(result.stderr).toBe('');
  return result.stdout;
}

// Each copy of Storage.getGlobalQwenDir() that cannot import core. Their own
// tests pin each branch against their own literal; this runs them all, core
// included, over the same homes, so a copy that checks another path or
// marker than core does disagrees here.
const mirrors = [
  ['core', () => Storage.getGlobalQwenDir()],
  [
    'packages/cli/src/config/storage-paths-lite.ts',
    () => getGlobalQwenDirLite(),
  ],
  ['packages/channels/base/src/paths.ts', () => getChannelsGlobalQwenDir()],
  ['packages/sdk-typescript/src/peer/registry.ts', () => resolveQwenHome()],
  [
    'packages/vscode-ide-companion/src/utils/paths.ts',
    () => {
      resetEnvBootstrapForTesting();
      return getCompanionGlobalQwenDir();
    },
  ],
  ['scripts/cli-entry.js', () => launcherResolver()],
  // Needs bash and a stub `uname`, which Windows runners do not offer.
  ...(process.platform === 'win32'
    ? []
    : [['packages/core/src/skills/bundled/stuck/SKILL.md', runStuckPreamble]]),
];

const marker = (dir) => join(dir, GLOBAL_DIR_MARKER);
const legacy = (home) => join(home, '.qwen');
const xdg = (home) => join(home, '.config', 'qwen');
const customXdg = (home) => join(home, 'xdg', 'qwen');
const dir = (path) => mkdirSync(path, { recursive: true });
const file = (path) => {
  dir(dirname(path));
  writeFileSync(path, '');
};

// [name, set the home up, XDG_CONFIG_HOME, the global dir core resolves]
const homes = [
  ['an empty home', () => {}, undefined, xdg],
  ['only ~/.qwen', (home) => dir(legacy(home)), undefined, legacy],
  [
    '~/.qwen and an unmarked ~/.config/qwen',
    (home) => {
      dir(legacy(home));
      file(join(xdg(home), 'settings.json'));
    },
    undefined,
    legacy,
  ],
  [
    '~/.qwen and a marked ~/.config/qwen',
    (home) => {
      dir(legacy(home));
      file(marker(xdg(home)));
    },
    undefined,
    xdg,
  ],
  [
    'the marker in ~/.qwen instead of ~/.config/qwen',
    (home) => {
      file(marker(legacy(home)));
      dir(xdg(home));
    },
    undefined,
    legacy,
  ],
  [
    '~/.qwen and a marked custom XDG_CONFIG_HOME',
    (home) => {
      dir(legacy(home));
      file(marker(customXdg(home)));
    },
    (home) => join(home, 'xdg'),
    customXdg,
  ],
  [
    '~/.qwen and a custom XDG_CONFIG_HOME, marked only in ~/.config/qwen',
    (home) => {
      dir(legacy(home));
      file(marker(xdg(home)));
    },
    (home) => join(home, 'xdg'),
    legacy,
  ],
  [
    '~/.qwen and a relative XDG_CONFIG_HOME, marked in ~/.config/qwen',
    (home) => {
      dir(legacy(home));
      file(marker(xdg(home)));
    },
    () => 'relative-config',
    xdg,
  ],
];

describe.each(mirrors)('%s', (_, resolve) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let home;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-marker-home-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('QWEN_HOME', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each(homes)(
    'resolves %s as core does on Linux',
    (_, setUp, xdgConfigHome, expected) => {
      setUp(home);
      const env = xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigHome(home) } : {};
      if (env.XDG_CONFIG_HOME) {
        vi.stubEnv('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME);
      }
      expect(resolve(home, env)).toBe(expected(home));
    },
  );
});
