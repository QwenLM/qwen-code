/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentUid,
  isRelayHome,
  purgeRelayHome,
  runDesktopRelayCommand,
} from './cli.js';
import { createRecordStore } from './runtime.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(name: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-cli-'));
  temporary.push(home);
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name }));
  return home;
}

describe.skipIf(process.platform === 'win32')(
  'desktop-relay disconnect',
  () => {
    it('revokes without a loopback listener and refuses a mismatched process identity', async () => {
      const home = tempHome('qwen-desktop-relay-runtime');
      const identity = `relay-disconnect-test-${process.pid}`;
      const child = spawn(
        process.execPath,
        [
          '-e',
          `process.title=${JSON.stringify(identity)};process.stdout.write('ready');setTimeout(()=>{},30000)`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      await once(child.stdout, 'data');
      const exited = once(child, 'exit');
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const store = createRecordStore(home);
      const record = {
        pid: child.pid!,
        processIdentity: 'unrelated',
        origin: 'https://example.com',
        daemonUrl: 'https://example.com',
        sessionId: 'test',
        phase: 'connected' as const,
        updatedAt: '',
      };
      try {
        store.write(record);
        expect(
          await runDesktopRelayCommand(['disconnect', '--home', home]),
        ).toBe(0);
        process.kill(child.pid!, 0);
        expect(output).toHaveBeenLastCalledWith(
          'No matching live desktop relay was found.\n',
        );
        store.write({ ...record, processIdentity: identity });
        expect(
          await runDesktopRelayCommand(['disconnect', '--home', home]),
        ).toBe(0);
        await expect(exited).resolves.toEqual([null, 'SIGTERM']);
      } finally {
        child.kill('SIGTERM');
        output.mockRestore();
        await exited;
      }
    });
  },
);

describe('desktop-relay uninstall --purge', () => {
  it('recognizes only marked runtime directories outside broad roots', () => {
    expect(isRelayHome(path.parse(process.cwd()).root)).toBe(false);
    expect(isRelayHome(os.homedir())).toBe(false);
    expect(isRelayHome(tempHome('another-project'))).toBe(false);
    expect(isRelayHome(tempHome('qwen-desktop-relay-runtime'))).toBe(true);
  });

  it('refuses to remove an unmarked directory', () => {
    const home = tempHome('another-project');
    expect(purgeRelayHome(home)).toBe(false);
    expect(fs.existsSync(home)).toBe(true);
  });

  it('removes a marked runtime directory', () => {
    const home = tempHome('qwen-desktop-relay-runtime');
    expect(purgeRelayHome(home)).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe('desktop-relay install safety', () => {
  it('rejects an existing unmarked directory before installing into it', async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), 'desktop-relay-existing-'),
    );
    temporary.push(home);
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('darwin');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(
      runDesktopRelayCommand(['install', '--home', home]),
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('is not a desktop relay runtime directory'),
    );
    expect(fs.existsSync(path.join(home, 'package.json'))).toBe(false);

    stderr.mockRestore();
    platform.mockRestore();
  });

  it('rejects a missing or empty --home value', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      runDesktopRelayCommand(['uninstall', '--home', '--purge']),
    ).resolves.toBe(2);
    await expect(
      runDesktopRelayCommand(['uninstall', '--home', '']),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      '--home requires a non-empty directory.\n',
    );
    stderr.mockRestore();
  });
});

describe('desktop-relay launchd domain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets the invoking user's gui domain under sudo", () => {
    vi.stubEnv('SUDO_UID', '501');
    expect(currentUid()).toBe(501);
  });

  it('falls back to the effective uid when SUDO_UID is unusable', () => {
    const effective = process.getuid?.() ?? os.userInfo().uid;
    for (const value of ['0', '-1', '501.5', 'not-a-number', '']) {
      vi.stubEnv('SUDO_UID', value);
      expect(currentUid()).toBe(effective);
    }
  });
});
