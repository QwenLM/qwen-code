/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';
import { runManagedExtensionShell } from './managed-extension-shell.js';
import { ManagedExtensionExecutionUnknownError } from './managed-extension-error.js';

it.skipIf(process.platform !== 'darwin')(
  'runs with exact private environment and seals capture after registered group stop',
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-shell-'),
    );
    const ledger = ManagedRuntimeLedger.create({
      workFile: path.join(directory, 'ledger.json'),
      worker: {
        pid: process.pid,
        pgid: process.pid,
        incarnation: 'test',
        startedAt: Date.now(),
        groupOwned: false,
      },
    });
    const owners = new ManagedExtensionProcessOwners(
      'developer-process-group',
      { ledger, directory: path.join(directory, 'owners') },
    );
    const write = vi.fn(
      async (_stream: 'stdout' | 'stderr', _chunk: Buffer) => {},
    );
    const capture = {
      write,
      finish: vi.fn(async () => {}),
      setStarted: vi.fn(),
      setProcessResult: vi.fn(),
    };
    try {
      const result = await runManagedExtensionShell(owners, {
        sessionId: 'root',
        configRevision: 1,
        command: 'printf "%s" "$EXT_TEST_TOKEN"',
        cwd: directory,
        environment: { EXT_TEST_TOKEN: 'private-value', PATH: '/usr/bin:/bin' },
        signal: new AbortController().signal,
        capture,
      });
      expect(result.llmContent).toBe('private-value');
      expect(
        Buffer.concat(
          write.mock.calls.map((call) => call[1] as Buffer),
        ).toString(),
      ).toBe('private-value');
      expect(capture.finish).toHaveBeenCalledWith('stdout', true);
      expect(await owners.hasLiveSessionOwners('root')).toBe(false);
      capture.finish.mockClear();
      const stop = vi.spyOn(owners, 'stop').mockResolvedValueOnce({
        ownerId: 'unproven',
        sessionId: 'root',
        configRevision: 1,
        mode: 'developer-process-group',
        scope: 'process_group',
        state: 'outcome_unknown',
      });
      try {
        await expect(
          runManagedExtensionShell(owners, {
            sessionId: 'root',
            configRevision: 1,
            command: 'printf unproven',
            cwd: directory,
            environment: { PATH: '/usr/bin:/bin' },
            signal: new AbortController().signal,
            capture,
          }),
        ).rejects.toBeInstanceOf(ManagedExtensionExecutionUnknownError);
        expect(capture.finish).not.toHaveBeenCalled();
      } finally {
        stop.mockRestore();
      }
    } finally {
      await owners.stopAll();
      await fs.rm(directory, { force: true, recursive: true });
    }
  },
);
