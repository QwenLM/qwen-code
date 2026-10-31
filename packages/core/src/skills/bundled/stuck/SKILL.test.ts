/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../../config/storage.js';

const skillPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'SKILL.md',
);

function readPreamble(): string {
  const content = fs.readFileSync(skillPath, 'utf8');
  const match = /\*\*Preamble[^\n]*\n\n```\n([\s\S]*?)```/.exec(content);
  if (!match) throw new Error('stuck SKILL.md has no preamble block');
  return match[1]!;
}

describe.skipIf(process.platform === 'win32')(
  'bundled stuck skill preamble',
  () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let home: string;
    let bin: string;

    // Runs the preamble with `uname -s` reporting `system`, and returns the
    // runtime dir it resolves.
    const runPreamble = (
      system: string,
      env: Record<string, string> = {},
      shellOptions = '',
    ) => {
      fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${system}\n`, {
        mode: 0o755,
      });
      const result = spawnSync(
        'bash',
        ['-c', `${shellOptions}${readPreamble()}\nprintf %s "$RUNTIME_DIR"`],
        {
          env: {
            PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
            HOME: home,
            ...env,
          },
          encoding: 'utf8',
        },
      );
      expect(result.stderr).toBe('');
      return result.stdout;
    };

    // What core resolves for the same home on `value`.
    const coreDir = (value: NodeJS.Platform) => {
      Object.defineProperty(process, 'platform', { value });
      return Storage.getGlobalQwenDir();
    };

    beforeEach(() => {
      home = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-stuck-home-')),
      );
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-stuck-bin-'));
      vi.stubEnv('HOME', home);
      vi.stubEnv('QWEN_HOME', undefined);
      vi.stubEnv('XDG_CONFIG_HOME', undefined);
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform);
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    });

    it('uses the XDG config directory for a new Linux install', () => {
      expect(runPreamble('Linux')).toBe(path.join(home, '.config', 'qwen'));
      expect(runPreamble('Linux')).toBe(coreDir('linux'));
    });

    it('keeps an existing ~/.qwen unless the XDG directory holds the marker', () => {
      fs.mkdirSync(path.join(home, '.qwen'));
      expect(runPreamble('Linux')).toBe(path.join(home, '.qwen'));
      expect(runPreamble('Linux')).toBe(coreDir('linux'));

      const xdgDir = path.join(home, '.config', 'qwen');
      fs.mkdirSync(xdgDir, { recursive: true });
      fs.writeFileSync(path.join(xdgDir, '.qwen-global-dir'), '');
      expect(runPreamble('Linux')).toBe(xdgDir);
      expect(runPreamble('Linux')).toBe(coreDir('linux'));
    });

    it('ignores a relative XDG_CONFIG_HOME', () => {
      vi.stubEnv('XDG_CONFIG_HOME', 'relative-config');
      expect(runPreamble('Linux', { XDG_CONFIG_HOME: 'relative-config' })).toBe(
        coreDir('linux'),
      );
    });

    it('resolves under set -u with nothing configured', () => {
      expect(runPreamble('Linux', {}, 'set -u\n')).toBe(coreDir('linux'));
    });

    it('uses QWEN_HOME over the XDG config directory', () => {
      const qwenHome = path.join(home, 'custom-qwen');
      vi.stubEnv('QWEN_HOME', qwenHome);
      expect(runPreamble('Linux', { QWEN_HOME: qwenHome })).toBe(qwenHome);
      expect(runPreamble('Linux', { QWEN_HOME: qwenHome })).toBe(
        coreDir('linux'),
      );
    });

    it('uses an absolute XDG_CONFIG_HOME', () => {
      const configHome = path.join(home, 'xdg-config');
      vi.stubEnv('XDG_CONFIG_HOME', configHome);
      expect(runPreamble('Linux', { XDG_CONFIG_HOME: configHome })).toBe(
        path.join(configHome, 'qwen'),
      );
      expect(runPreamble('Linux', { XDG_CONFIG_HOME: configHome })).toBe(
        coreDir('linux'),
      );
    });

    it('keeps ~/.qwen on macOS', () => {
      expect(runPreamble('Darwin')).toBe(path.join(home, '.qwen'));
      expect(runPreamble('Darwin')).toBe(coreDir('darwin'));
    });

    it('keeps ~/.qwen under a Windows shell', () => {
      expect(runPreamble('MINGW64_NT-10.0-22631')).toBe(coreDir('win32'));
    });
  },
);
