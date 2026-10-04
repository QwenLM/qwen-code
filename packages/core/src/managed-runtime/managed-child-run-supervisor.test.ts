/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookCommandCgroup } from '../hooks/hook-command-cgroup.js';
import {
  HookCommandIsolationUnavailableError,
  ManagedChildRunSupervisor,
} from './managed-child-run-supervisor.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'child-supervisor-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fakeUnit(name: string) {
  const dir = join(directory, name);
  await mkdir(dir);
  const unit = Reflect.construct(HookCommandCgroup, [dir]);
  const removed = { value: false };
  vi.spyOn(unit, 'remove').mockImplementation(() => {
    removed.value = true;
  });
  return { unit, removed };
}

// The supervision tests spawn the shell-shaped launcher, which does not
// exist on win32; the isolation error covers every non-Linux host instead.
describe.skipIf(process.platform === 'win32')(
  'ManagedChildRunSupervisor',
  () => {
    it('refuses creation without a delegated root', () => {
      expect(() =>
        ManagedChildRunSupervisor.create({ cgroupRoot: undefined }),
      ).toThrow(HookCommandIsolationUnavailableError);
    });

    it('starts a process whose output and exit evidence are captured', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-shell-1');
      const create = vi
        .spyOn(HookCommandCgroup, 'create')
        .mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const chunks: string[] = [];
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-shell-1',
          executable: '/bin/sh',
          args: ['-c', 'printf hello'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: (_stream, chunk) => chunks.push(chunk.toString()),
        },
        { prove: async () => true },
      );
      expect(create).toHaveBeenCalledWith('/root', 'qwen-bg-shell-1');
      expect(supervisor.size).toBe(1);
      await new Promise((resolve) => proc.child.once('exit', resolve));
      await writeFile(
        join(directory, 'qwen-bg-shell-1', 'cgroup.events'),
        'populated 0\n',
      );
      expect(chunks.join('')).toBe('hello');
      expect(proc.evidence).toEqual({ exitCode: 0, exitSignal: null });
      await expect(proc.terminate(1_000)).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      expect(removed.value).toBe(true);
    });

    it('settles a terminated process only after the unit is empty', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-shell-2');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-shell-2',
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        { prove: async () => true },
      );
      await writeFile(
        join(directory, 'qwen-bg-shell-2', 'cgroup.procs'),
        `${proc.child.pid}\n`,
      );
      const markEmpty = proc.child.once('exit', () =>
        writeFile(
          join(directory, 'qwen-bg-shell-2', 'cgroup.events'),
          'populated 0\n',
        ),
      );
      const [evidence] = await Promise.all([proc.terminate(5_000), markEmpty]);
      expect(evidence).toEqual({ exitCode: null, exitSignal: 'SIGTERM' });
      expect(removed.value).toBe(true);
    });

    it('keeps the process when emptiness cannot be proven', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-shell-3');
      const empty = vi.spyOn(unit, 'empty').mockReturnValue(false);
      vi.spyOn(unit, 'terminate').mockResolvedValue(undefined);
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-shell-3',
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        { prove: async () => true },
      );
      await expect(proc.terminate(100)).resolves.toBeNull();
      expect(empty).toHaveBeenCalled();
      expect(removed.value).toBe(false);
      expect(supervisor.process('qwen-bg-shell-3')).toBe(proc);
      proc.child.kill('SIGKILL');
      await supervisor.process('qwen-bg-shell-3')?.child.once('exit', () => {});
    });

    it('fails closed as isolation when membership cannot be proven', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-shell-4');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      await expect(
        supervisor.start(
          {
            unitName: 'qwen-bg-shell-4',
            executable: '/bin/sh',
            args: ['-c', 'sleep 30'],
            env: { PATH: '/bin:/usr/bin' },
            cwd: directory,
            onOutput: () => undefined,
          },
          { prove: async () => false },
        ),
      ).rejects.toBeInstanceOf(HookCommandIsolationUnavailableError);
      expect(removed.value).toBe(true);
      expect(supervisor.size).toBe(0);
    });

    it('forwards attachment with its root only', () => {
      const attached = { present: true };
      const attach = vi
        .spyOn(HookCommandCgroup, 'attach')
        .mockReturnValue(attached as unknown as HookCommandCgroup);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      expect(supervisor.attach('qwen-bg-x')).toBe(attached);
      expect(attach).toHaveBeenCalledWith('/root', 'qwen-bg-x');
    });
  },
);
