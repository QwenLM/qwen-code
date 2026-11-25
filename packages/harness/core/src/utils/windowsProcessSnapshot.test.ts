/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { spawnAsync } from './shell-utils.js';
import {
  readWindowsProcessSnapshot,
  selectWindowsDescendants,
  terminateWindowsProcesses,
} from './windowsProcessSnapshot.js';

vi.mock('./shell-utils.js', () => ({ spawnAsync: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawnAsync).mockReset();
});

it('selects descendants across multiple roots but excludes recycled-parent relationships', () => {
  const root = { pid: 100, parent: 1, created: '20' };
  const child = { pid: 101, parent: 100, created: '21' };
  const leaf = { pid: 102, parent: 101, created: '22' };
  const old = { pid: 103, parent: 100, created: '19' };
  const other = { pid: 104, parent: 1, created: '23' };
  expect(
    selectWindowsDescendants([leaf, child, old, other, root], [100]),
  ).toEqual([leaf, child, root]);
});

it('rejects incomplete or invalid process snapshots', async () => {
  vi.mocked(spawnAsync).mockResolvedValue({
    stdout: '[{"pid":100}]',
    stderr: '',
  });
  await expect(readWindowsProcessSnapshot()).rejects.toThrow('identities');
  vi.mocked(spawnAsync).mockResolvedValue({ stdout: '[]', stderr: '' });
  await expect(readWindowsProcessSnapshot()).resolves.toEqual([]);
});

it('validates identifiers before constructing a termination script', async () => {
  await expect(
    terminateWindowsProcesses([{ pid: 1, parent: 0, created: '1' }]),
  ).rejects.toThrow();
  await expect(
    terminateWindowsProcesses([{ pid: 100, parent: 0, created: "';exit" }]),
  ).rejects.toThrow();
  expect(spawnAsync).not.toHaveBeenCalled();
});

it('uses a cmdlet on the identity-checked process without restricted Process methods', async () => {
  vi.mocked(spawnAsync).mockResolvedValue({ stdout: '', stderr: '' });
  await terminateWindowsProcesses([{ pid: 100, parent: 1, created: '20' }]);
  const args = vi.mocked(spawnAsync).mock.calls[0]![1];
  const script = Buffer.from(
    args[args.indexOf('-EncodedCommand') + 1]!,
    'base64',
  ).toString('utf16le');
  expect(script).toContain(
    'Stop-Process -InputObject $process -Force -ErrorAction Stop',
  );
  expect(script).toContain('$heldProcesses += $process');
  expect(script.indexOf('$process.Handle')).toBeLessThan(
    script.indexOf('$current = Get-CimInstance'),
  );
  expect(script.indexOf('-eq $entry.created')).toBeLessThan(
    script.indexOf('Stop-Process'),
  );
  expect(script).not.toMatch(
    /\$process\.(?:Kill|Dispose|Close|WaitForExit)\s*\(/,
  );
  expect(script).toContain('if (-not $process.HasExited) { throw }');
  expect(script.trim()).toMatch(/exit 0$/);
  expect(script).toContain(
    'Write-Error -ErrorRecord $_ -ErrorAction Continue\n      exit 1',
  );
});

function timeoutOnce() {
  vi.mocked(spawnAsync).mockImplementationOnce(
    (_executable, _args, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('helper aborted')),
          { once: true },
        );
      }),
  );
}

function fakeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
}

it('retries a timed-out snapshot and clears the timer after success', async () => {
  fakeClock();
  timeoutOnce();
  vi.mocked(spawnAsync).mockResolvedValueOnce({ stdout: '[]', stderr: '' });
  const result = expect(readWindowsProcessSnapshot()).resolves.toEqual([]);
  await vi.advanceTimersByTimeAsync(30000);
  await result;
  expect(spawnAsync).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('retries termination with the same identities after a timeout', async () => {
  fakeClock();
  timeoutOnce();
  vi.mocked(spawnAsync).mockResolvedValueOnce({ stdout: '', stderr: '' });
  const result = expect(
    terminateWindowsProcesses([{ pid: 100, parent: 1, created: '20' }]),
  ).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(30000);
  await result;
  expect(spawnAsync).toHaveBeenCalledTimes(2);
  expect(vi.mocked(spawnAsync).mock.calls[1]![1]).toEqual(
    vi.mocked(spawnAsync).mock.calls[0]![1],
  );
});

it('bounds both attempts by the remaining shared deadline', async () => {
  fakeClock();
  timeoutOnce();
  timeoutOnce();
  const result = expect(
    readWindowsProcessSnapshot(45000),
  ).rejects.toMatchObject({
    name: 'WindowsProcessTimeoutError',
    phase: 'snapshot',
    attempts: 2,
  });
  await vi.advanceTimersByTimeAsync(45000);
  await result;
  expect(spawnAsync).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not retry script failures or an externally terminated helper', async () => {
  vi.mocked(spawnAsync).mockRejectedValue(
    new Error('Command failed with exit code null'),
  );
  await expect(readWindowsProcessSnapshot()).rejects.toThrow('exit code null');
  expect(spawnAsync).toHaveBeenCalledTimes(1);
});

it('does not spawn when the shared deadline is already exhausted', async () => {
  await expect(
    readWindowsProcessSnapshot(performance.now() - 1),
  ).rejects.toMatchObject({
    name: 'WindowsProcessTimeoutError',
    attempts: 0,
  });
  expect(spawnAsync).not.toHaveBeenCalled();
});
