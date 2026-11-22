/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';
import { runManagedExtensionShell } from './managed-extension-shell.js';
import { ManagedExtensionExecutionUnknownError } from './managed-extension-error.js';

it('does not wait for a close emitted before the owner start returns', async () => {
  const child = spawn(process.execPath, ['--eval', ''], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  await once(child, 'close');
  const owners = {
    start: vi.fn(async () => ({ ownerId: 'extension-closed', child })),
    stop: vi.fn(async () => ({
      ownerId: 'extension-closed',
      sessionId: 'root',
      configRevision: 1,
      mode: 'developer-process-group' as const,
      scope: 'process_group' as const,
      state: 'stopped' as const,
    })),
  } as unknown as ManagedExtensionProcessOwners;
  await expect(
    runManagedExtensionShell(owners, {
      sessionId: 'root',
      configRevision: 1,
      command: 'printf already-closed',
      cwd: process.cwd(),
      environment: {},
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ llmContent: '' });
  expect(owners.start).toHaveBeenCalledTimes(1);
});

it('accounts for output emitted before an already-closed child is handed off', async () => {
  const child = spawn(
    process.execPath,
    [
      '--eval',
      "process.stdout.write('stdout-sentinel'); process.stderr.write('stderr-sentinel')",
    ],
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  );
  await once(child, 'close');
  const detachPreread = vi.fn();
  const owners = {
    start: vi.fn(async () => ({
      ownerId: 'extension-closed',
      child,
      preread: {
        stdout: [Buffer.from('stdout-sentinel')],
        stderr: [Buffer.from('stderr-sentinel')],
      },
      detachPreread,
    })),
    stop: vi.fn(async () => ({
      ownerId: 'extension-closed',
      sessionId: 'root',
      configRevision: 1,
      mode: 'developer-process-group' as const,
      scope: 'process_group' as const,
      state: 'stopped' as const,
    })),
  } as unknown as ManagedExtensionProcessOwners;
  const write = vi.fn(
    async (_stream: 'stdout' | 'stderr', _chunk: Buffer) => {},
  );
  const capture = {
    write,
    finish: vi.fn(async () => {}),
    setStarted: vi.fn(),
    setProcessResult: vi.fn(),
  };
  const result = await runManagedExtensionShell(owners, {
    sessionId: 'root',
    configRevision: 1,
    command: 'printf sentinels',
    cwd: process.cwd(),
    environment: {},
    signal: new AbortController().signal,
    capture,
  });
  // The pre-handoff bytes must survive even though the streams closed before
  // the live listeners were installed; empty output here is silent data loss.
  expect(result.llmContent).toContain('stdout-sentinel');
  expect(result.llmContent).toContain('stderr-sentinel');
  expect(detachPreread).toHaveBeenCalledTimes(1);
  expect(
    Buffer.concat(write.mock.calls.map((call) => call[1])).toString(),
  ).toBe('stdout-sentinelstderr-sentinel');
  expect(capture.finish).toHaveBeenCalledWith('stdout', true);
  expect(capture.finish).toHaveBeenCalledWith('stderr', true);
});

it('reports preread overflow as a truncated result, not a complete success', async () => {
  const child = spawn(process.execPath, ['--eval', ''], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  await once(child, 'close');
  const owners = {
    start: vi.fn(async () => ({
      ownerId: 'extension-overflow',
      child,
      preread: {
        stdout: [Buffer.from('retained-prefix')],
        stderr: [],
        overflow: true,
      },
      detachPreread: vi.fn(),
    })),
    stop: vi.fn(async () => ({
      ownerId: 'extension-overflow',
      sessionId: 'root',
      configRevision: 1,
      mode: 'developer-process-group' as const,
      scope: 'process_group' as const,
      state: 'stopped' as const,
    })),
  } as unknown as ManagedExtensionProcessOwners;
  const capture = {
    write: vi.fn(async (_stream: 'stdout' | 'stderr', _chunk: Buffer) => {}),
    finish: vi.fn(async () => {}),
    setStarted: vi.fn(),
    setProcessResult: vi.fn(),
  };
  const result = await runManagedExtensionShell(owners, {
    sessionId: 'root',
    configRevision: 1,
    command: 'printf overflow',
    cwd: process.cwd(),
    environment: {},
    signal: new AbortController().signal,
    capture,
  });
  // The overflow flag must fold into the result: bytes dropped past the budget
  // are reported as truncated, not as a complete success.
  expect(result.llmContent).toContain('[Output truncated]');
  expect(capture.setProcessResult).toHaveBeenCalledWith(
    expect.objectContaining({ outputCaptureLimitExceeded: true }),
  );
});

it.skipIf(process.platform !== 'darwin')(
  'buffers command output from spawn so a fast exit cannot discard it',
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-preread-'),
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
    try {
      const { child, preread, detachPreread } = await owners.start({
        sessionId: 'root',
        configRevision: 1,
        executable: '/bin/sh',
        args: ['-c', 'printf stdout-sentinel; printf stderr-sentinel >&2'],
        cwd: directory,
        env: { PATH: '/usr/bin:/bin' },
        prereadOutput: true,
      });
      await once(child, 'close');
      expect(Buffer.concat(preread!.stdout).toString()).toBe('stdout-sentinel');
      expect(Buffer.concat(preread!.stderr).toString()).toBe('stderr-sentinel');
      detachPreread!();
    } finally {
      await owners.stopAll();
      await fs.rm(directory, { force: true, recursive: true });
    }
  },
);

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
