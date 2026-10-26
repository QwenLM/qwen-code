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
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// The command the XDG design note gives for moving ~/.qwen by hand.
const migrationCommand = (file) =>
  /\n {2}```sh\n([\s\S]*?)\n {2}```/.exec(
    readFileSync(join(root, file), 'utf8'),
  )?.[1];
const command = migrationCommand(
  'docs/design/2026-10-24-xdg-base-directory.md',
);

describe.skipIf(process.platform === 'win32')(
  'the XDG migration command',
  () => {
    let home;
    let cwd;

    const migrate = (env = {}) =>
      spawnSync('bash', ['-c', command], {
        cwd,
        env: { PATH: process.env.PATH, HOME: home, ...env },
        encoding: 'utf8',
      });

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'qwen-migrate-home-'));
      cwd = mkdtempSync(join(tmpdir(), 'qwen-migrate-cwd-'));
      mkdirSync(join(home, '.qwen'));
      writeFileSync(join(home, '.qwen', 'oauth_creds.json'), '{}');
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    it('is the same in both languages', () => {
      expect(command).toBeTruthy();
      expect(
        migrationCommand('docs/design/2026-10-24-xdg-base-directory.zh-CN.md'),
      ).toBe(command);
    });

    it('moves ~/.qwen into the XDG directory and marks it', () => {
      expect(migrate().status).toBe(0);
      expect(existsSync(join(home, '.qwen'))).toBe(false);
      const xdgDir = join(home, '.config', 'qwen');
      expect(existsSync(join(xdgDir, 'oauth_creds.json'))).toBe(true);
      expect(existsSync(join(xdgDir, '.qwen-global-dir'))).toBe(true);
    });

    it.each(['relative-config', '~/.config'])(
      'leaves ~/.qwen alone with XDG_CONFIG_HOME=%s',
      (value) => {
        expect(migrate({ XDG_CONFIG_HOME: value }).status).not.toBe(0);
        expect(existsSync(join(home, '.qwen', 'oauth_creds.json'))).toBe(true);
        expect(readdirSync(cwd)).toEqual([]);
      },
    );

    it('leaves ~/.qwen alone when the destination exists', () => {
      mkdirSync(join(home, '.config', 'qwen'), { recursive: true });
      expect(migrate().status).not.toBe(0);
      expect(existsSync(join(home, '.qwen', 'oauth_creds.json'))).toBe(true);
    });
  },
);
