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
const marker = /const GLOBAL_DIR_MARKER = '([^']+)';/.exec(
  readFileSync(join(root, 'packages/core/src/config/storage.ts'), 'utf8'),
)?.[1];

describe.skipIf(process.platform === 'win32')(
  'the XDG migration command',
  () => {
    let home;
    let cwd;
    let bin;

    // uname is stubbed so the result does not depend on the host.
    const migrate = (env = {}, uname = 'Linux') => {
      writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${uname}\n`, {
        mode: 0o755,
      });
      return spawnSync('bash', ['-c', command], {
        cwd,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
        encoding: 'utf8',
      });
    };

    const expectRefused = (result) => {
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).not.toBe('');
    };

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'qwen-migrate-home-'));
      cwd = mkdtempSync(join(tmpdir(), 'qwen-migrate-cwd-'));
      bin = mkdtempSync(join(tmpdir(), 'qwen-migrate-bin-'));
      mkdirSync(join(home, '.qwen'));
      writeFileSync(join(home, '.qwen', 'oauth_creds.json'), '{}');
    });

    afterEach(() => {
      for (const dir of [home, cwd, bin]) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is the same in both languages', () => {
      expect(command).toBeTruthy();
      expect(
        migrationCommand('docs/design/2026-10-24-xdg-base-directory.zh-CN.md'),
      ).toBe(command);
    });

    it('moves ~/.qwen into the XDG directory and marks it', () => {
      expect(marker).toBeTruthy();
      expect(migrate().status).toBe(0);
      expect(existsSync(join(home, '.qwen'))).toBe(false);
      const xdgDir = join(home, '.config', 'qwen');
      expect(existsSync(join(xdgDir, 'oauth_creds.json'))).toBe(true);
      expect(existsSync(join(xdgDir, marker))).toBe(true);
    });

    it('moves ~/.qwen into an absolute XDG_CONFIG_HOME', () => {
      const configHome = join(home, 'xdg');
      expect(migrate({ XDG_CONFIG_HOME: configHome }).status).toBe(0);
      expect(existsSync(join(configHome, 'qwen', 'oauth_creds.json'))).toBe(
        true,
      );
      expect(existsSync(join(configHome, 'qwen', marker))).toBe(true);
      expect(existsSync(join(home, '.config'))).toBe(false);
    });

    it.each([
      [
        'XDG_CONFIG_HOME=relative-config',
        { XDG_CONFIG_HOME: 'relative-config' },
      ],
      ['XDG_CONFIG_HOME=~/.config', { XDG_CONFIG_HOME: '~/.config' }],
      ['QWEN_HOME set', { QWEN_HOME: join(tmpdir(), 'qwen-home') }],
      ['HOME unset', { HOME: undefined }],
    ])('leaves ~/.qwen alone with %s', (_, env) => {
      expectRefused(migrate(env));
      expect(existsSync(join(home, '.qwen', 'oauth_creds.json'))).toBe(true);
      expect(readdirSync(cwd)).toEqual([]);
    });

    it.each(['Darwin', 'MINGW64_NT-10.0', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0'])(
      'leaves ~/.qwen alone on %s',
      (uname) => {
        expectRefused(migrate({}, uname));
        expect(existsSync(join(home, '.qwen', 'oauth_creds.json'))).toBe(true);
        expect(existsSync(join(home, '.config'))).toBe(false);
      },
    );

    it('leaves ~/.qwen alone when the destination exists', () => {
      mkdirSync(join(home, '.config', 'qwen'), { recursive: true });
      expectRefused(migrate());
      expect(existsSync(join(home, '.qwen', 'oauth_creds.json'))).toBe(true);
    });

    it('creates nothing when there is no ~/.qwen', () => {
      rmSync(join(home, '.qwen'), { recursive: true });
      expectRefused(migrate());
      expect(existsSync(join(home, '.config'))).toBe(false);
    });

    it('says so when run again after a migration', () => {
      expect(migrate().status).toBe(0);
      expectRefused(migrate());
      expect(
        existsSync(join(home, '.config', 'qwen', 'oauth_creds.json')),
      ).toBe(true);
    });
  },
);
