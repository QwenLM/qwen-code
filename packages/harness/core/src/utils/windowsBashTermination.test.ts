/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnAsync } from './shell-utils.js';
import {
  parseMsysProcess,
  prepareWindowsBashTermination,
  selectMsysProcesses,
  parentsFirst,
} from './windowsBashTermination.js';
import {
  readWindowsProcessSnapshot,
  terminateWindowsProcesses,
} from './windowsProcessSnapshot.js';

vi.mock('./shell-utils.js', () => ({ spawnAsync: vi.fn() }));
vi.mock('./windowsProcessSnapshot.js', async (original) => ({
  ...(await original<typeof import('./windowsProcessSnapshot.js')>()),
  readWindowsProcessSnapshot: vi.fn(),
  terminateWindowsProcesses: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  mkdtempSync: vi.fn((await original<typeof import('node:fs')>()).mkdtempSync),
}));

function stat(pid: number, parent: number, group = 100, started = '42') {
  return `${pid} (some (shell) name) S ${parent} ${group} ${Array(16).fill('0').join(' ')} ${started}`;
}
const root = parseMsysProcess(stat(100, 1), '9000');
const child = parseMsysProcess(stat(101, 100), '9010');
const orphan = parseMsysProcess(stat(102, 1), '9020');
const stranger = parseMsysProcess(stat(200, 1, 200), '9900');
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

describe('MSYS ownership', () => {
  it('orders parents before children even when the snapshot lists leaves first', () => {
    const leaf = { ...orphan, parent: child.pid };
    expect(parentsFirst([leaf, child, root])).toEqual([root, child, leaf]);
  });
  it('distinguishes Windows PID from MSYS PID and parses comm with parentheses', () => {
    expect(root).toEqual({
      pid: 100,
      parent: 1,
      group: 100,
      started: '42',
      windowsPid: 9000,
    });
    expect(() => parseMsysProcess('bad', '42')).toThrow();
    expect(() => parseMsysProcess(stat(100, 1), '1')).toThrow();
  });
  it('recovers orphaned group members without claiming a concurrent task', () => {
    expect(
      selectMsysProcesses([root, child, orphan, stranger], root, [root]),
    ).toEqual([root, child, orphan]);
  });
  it('does not claim a shared group owned by another shell', () => {
    const sharedRoot = { ...root, group: 200 };
    expect(
      selectMsysProcesses([sharedRoot, child, stranger], sharedRoot, [
        sharedRoot,
      ]),
    ).toEqual([sharedRoot, child]);
  });
  it('retains proven members after root exit but never adopts a reused group', () => {
    expect(selectMsysProcesses([child, orphan], root, [root, child])).toEqual([
      child,
      orphan,
    ]);
    const reused = { ...root, started: '99' };
    expect(selectMsysProcesses([reused, stranger], root, [root])).toEqual([]);
    expect(selectMsysProcesses([orphan], root, [root])).toEqual([]);
  });
});

function fixture() {
  const controller = prepareWindowsBashTermination('C:\\Git\\bin\\bash.exe');
  cleanups.push(controller.cleanup);
  const directory = vi.mocked(fs.mkdtempSync).mock.results.at(-1)!
    .value as string;
  fs.writeFileSync(path.join(directory, 'identity'), `${stat(100, 1)}\n9000\n`);
  return controller;
}

it('retains the supervisor until a newly orphaned descendant has been reclaimed', async () => {
  const controller = fixture();
  let members = [root, child];
  let ownerSuspended = false;
  const killed: number[] = [];
  vi.mocked(spawnAsync).mockImplementation(async (_exe, args) => {
    const script = args[3]!;
    if (script.includes('for entry')) {
      return {
        stdout: members
          .map(
            (p) =>
              `${p.windowsPid}\t${stat(p.pid, p.parent, p.group, p.started)}`,
          )
          .join('\n'),
        stderr: '',
      };
    }
    const pids = args
      .slice(5)
      .filter((_, i) => i % 3 === 0)
      .map(Number);
    if (script.includes('kill -STOP')) ownerSuspended = true;
    if (script.includes('kill -KILL')) {
      expect(ownerSuspended).toBe(true);
      for (const pid of pids) {
        killed.push(pid);
        members = members.filter((p) => p.pid !== pid);
        // A process created immediately before its parent died was absent
        // from the first snapshot. The live owner still proves group ownership.
        if (pid === child.pid) members.push(orphan);
      }
    }
    return { stdout: '', stderr: '' };
  });
  vi.mocked(readWindowsProcessSnapshot).mockImplementation(async () =>
    members.map((p) => ({ pid: p.windowsPid, parent: 0, created: p.started })),
  );
  vi.mocked(terminateWindowsProcesses).mockImplementation(async (processes) => {
    if (processes.some((p) => p.pid === root.windowsPid)) {
      expect(killed).toEqual([child.pid, orphan.pid, root.pid]);
    }
  });
  await controller.kill();
  expect(killed).toEqual([child.pid, orphan.pid, root.pid]);
});

it('does not kill descendants when suspending the owner fails', async () => {
  const controller = fixture();
  vi.mocked(spawnAsync).mockImplementation(async (_exe, args) => {
    if (args[3]!.includes('kill -STOP')) throw new Error('STOP failed');
    return { stdout: `9000\t${stat(100, 1)}\n`, stderr: '' };
  });
  await expect(controller.kill()).rejects.toThrow('STOP failed');
  expect(
    vi
      .mocked(spawnAsync)
      .mock.calls.some(([, args]) => args[3]!.includes('kill -KILL')),
  ).toBe(false);
});

it('resumes the same supervisor after snapshot failure without hiding the error', async () => {
  const controller = fixture();
  vi.mocked(spawnAsync).mockResolvedValue({
    stdout: `9000\t${stat(100, 1)}\n`,
    stderr: '',
  });
  vi.mocked(readWindowsProcessSnapshot).mockRejectedValueOnce(
    new Error('CIM unavailable'),
  );
  await expect(controller.kill()).rejects.toThrow('CIM unavailable');
  const resume = vi.mocked(spawnAsync).mock.calls.at(-1)![1];
  expect(resume[3]).toContain('kill -CONT');
  expect(resume.slice(5)).toEqual(['100', '42', '9000']);
});

it.skipIf(process.platform === 'win32')(
  'keeps the owner as parent across exec and forwards the exit status',
  () => {
    const controller = fixture();
    const args = controller.wrapArgs([
      '-c',
      'exec "$BASH" -c \'echo "$PPID"; exit 37\'',
    ]);
    // Supply the two MSYS proc values on hosts without Git Bash.
    args[4] = args[4]!
      .replace('$(< /proc/$$/stat)', 'fixture')
      .replace('$(< /proc/$$/winpid)', '1');
    const result = spawnSync('/bin/bash', args, { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe(String(result.pid));
    expect(result.status).toBe(37);
  },
);

it('stops orphaned MSYS members and waits for captured native descendants', async () => {
  const controller = fixture();
  const table = `9000\t${stat(100, 1)}\n9020\t${stat(102, 1)}\n9900\t${stat(200, 1, 200)}\n`;
  let reads = 0;
  vi.mocked(spawnAsync).mockImplementation(async (_exe, args) => {
    const script = args[3]!;
    if (script.includes('for entry'))
      return { stdout: reads++ < 2 ? table : '', stderr: '' };
    if (script.includes('kill -KILL') && args.length > 5)
      expect(args.slice(5)).toEqual(['102', '42', '9020']);
    return { stdout: '', stderr: '' };
  });
  const native = [
    { pid: 9020, parent: 8000, created: '1' },
    { pid: 9030, parent: 9020, created: '2' },
  ];
  vi.mocked(readWindowsProcessSnapshot)
    .mockResolvedValueOnce(native)
    .mockResolvedValue([]);
  vi.mocked(terminateWindowsProcesses).mockResolvedValue();
  await controller.kill();
  expect(terminateWindowsProcesses).toHaveBeenCalledWith(
    native,
    expect.any(Number),
  );
  expect(readWindowsProcessSnapshot).toHaveBeenCalledTimes(2);
  const scripts = vi.mocked(spawnAsync).mock.calls.map(([, args]) => args[3]!);
  // Real Bash syntax validation catches quoting/interpolation mistakes in helpers.
  if (process.platform !== 'win32') {
    for (const script of scripts)
      execFileSync('/bin/bash', ['-n'], { input: script });
    execFileSync('/bin/bash', ['-n'], { input: controller.wrapArgs([])[4] });
  }
});

it('does not kill a reused root or report it as stopped', async () => {
  const controller = fixture();
  vi.mocked(spawnAsync).mockResolvedValue({
    stdout: `9000\t${stat(100, 1, 100, '99')}\n`,
    stderr: '',
  });
  await expect(controller.kill()).rejects.toThrow('ownership');
  expect(terminateWindowsProcesses).not.toHaveBeenCalled();
  expect(spawnAsync).toHaveBeenCalledTimes(1);
});

it('propagates enumeration failure instead of treating it as an empty tree', async () => {
  const controller = fixture();
  vi.mocked(spawnAsync).mockRejectedValue(new Error('probe failed'));
  await expect(controller.kill()).rejects.toThrow('probe failed');
});

it('keeps verifying native descendants after all MSYS members disappear', async () => {
  const controller = fixture();
  let reads = 0;
  vi.mocked(spawnAsync).mockImplementation(async (_exe, args) => ({
    stdout:
      args[3]!.includes('for entry') && reads++ < 2
        ? `9000\t${stat(100, 1)}\n`
        : '',
    stderr: '',
  }));
  const parent = { pid: 9000, parent: 8000, created: '1' };
  const nativeChild = { pid: 9001, parent: 9000, created: '2' };
  vi.mocked(readWindowsProcessSnapshot)
    .mockResolvedValueOnce([parent, nativeChild])
    .mockResolvedValueOnce([nativeChild])
    .mockResolvedValueOnce([]);
  vi.mocked(terminateWindowsProcesses).mockResolvedValue();
  await controller.kill();
  expect(terminateWindowsProcesses).toHaveBeenNthCalledWith(
    2,
    [nativeChild],
    expect.any(Number),
  );
  expect(readWindowsProcessSnapshot).toHaveBeenCalledTimes(3);
  const deadlines = vi
    .mocked(readWindowsProcessSnapshot)
    .mock.calls.map(([deadline]) => deadline);
  expect(new Set(deadlines).size).toBe(1);
  expect(deadlines[0]).toEqual(expect.any(Number));
  expect(
    vi
      .mocked(terminateWindowsProcesses)
      .mock.calls.every(([, deadline]) => deadline === deadlines[0]),
  ).toBe(true);
});
