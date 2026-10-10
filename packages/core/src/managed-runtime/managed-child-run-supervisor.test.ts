/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookCommandCgroup } from '../hooks/hook-command-cgroup.js';
import {
  HookCommandIsolationUnavailableError,
  ManagedChildRunProcess,
  ManagedChildRunSupervisor,
} from './managed-child-run-supervisor.js';

// The prober's membership listing seam: ESM namespace objects reject
// vi.spyOn, so the unreadable-list simulation rides a module mock whose
// gate only the marker test opens.
const unreadableLists = vi.hoisted(() => ({ active: false, reads: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: unknown[]) => {
    if (unreadableLists.active) {
      unreadableLists.reads += 1;
      throw new Error('unreadable process list');
    }
    return (actual.readFileSync as (...inner: unknown[]) => unknown)(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

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

    it('keeps the exit evidence of a process that exits during the membership proof', async () => {
      const { unit } = await fakeUnit('qwen-bg-shell-fast');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-shell-fast',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        {
          // The proof resolves only after the exit actually ran, so the
          // constructor's listener can never hear this process.
          prove: async (child) => {
            await new Promise((resolve) => child.once('exit', resolve));
            return true;
          },
        },
      );
      expect(proc.exited).toBe(true);
      expect(proc.evidence).toEqual({ exitCode: 0, exitSignal: null });
    });

    it('proves membership from the launcher marker when the process list is unreadable', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-shell-joined');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      unreadableLists.active = true;
      unreadableLists.reads = 0;
      let proc: Awaited<ReturnType<ManagedChildRunSupervisor['start']>>;
      try {
        const supervisor = ManagedChildRunSupervisor.create({
          cgroupRoot: '/root',
        });
        proc = await supervisor.start({
          unitName: 'qwen-bg-shell-joined',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        });
      } finally {
        unreadableLists.active = false;
      }
      // The real prober consults the list on its first attempt — the
      // launcher's marker is what let the start resolve past this stub.
      expect(unreadableLists.reads).toBeGreaterThan(0);
      for (
        let attempt = 0;
        attempt < 200 && proc.evidence === null;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(proc.evidence).toEqual({ exitCode: 0, exitSignal: null });
      await writeFile(
        join(directory, 'qwen-bg-shell-joined', 'cgroup.events'),
        'populated 0\n',
      );
      await expect(proc.terminate(1_000)).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      expect(removed.value).toBe(true);
    });

    it('settles a natural end only once the unit proves empty', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-natural');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-natural',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        { prove: async () => true },
      );
      await writeFile(
        join(directory, 'qwen-bg-natural', 'cgroup.events'),
        'populated 1\n',
      );
      await new Promise((resolve) => proc.child.once('exit', resolve));
      expect(proc.evidence).toEqual({ exitCode: 0, exitSignal: null });
      const settling = proc.settleOnEmpty();
      // The root exited, but membership still proves life: the end answers
      // nothing yet — the root's exit alone is never evidence.
      const early = await Promise.race([
        settling.then(() => 'answered'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('held'), 300),
        ),
      ]);
      expect(early).toBe('held');
      expect(removed.value).toBe(false);
      await writeFile(
        join(directory, 'qwen-bg-natural', 'cgroup.events'),
        'populated 0\n',
      );
      await expect(settling).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      expect(removed.value).toBe(true);
    });

    it('answers a natural end a drain already settled with the same evidence', async () => {
      const { unit, removed } = await fakeUnit('qwen-bg-race');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      await writeFile(join(directory, 'qwen-bg-race', 'cgroup.procs'), '\n');
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-race',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        { prove: async () => true },
      );
      await writeFile(
        join(directory, 'qwen-bg-race', 'cgroup.events'),
        'populated 1\n',
      );
      await new Promise((resolve) => proc.child.once('exit', resolve));
      const settling = proc.settleOnEmpty();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // The drain drives the unit empty; both its settle and this one must
      // converge on the same evidence, never on two different ends.
      await writeFile(
        join(directory, 'qwen-bg-race', 'cgroup.events'),
        'populated 0\n',
      );
      const drained = proc.terminate(100);
      await expect(drained).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      await expect(settling).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      expect(removed.value).toBe(true);
    });

    it('answers a stop whose unit vanished behind the racing natural-end settle', async () => {
      // The review-measured chain, scripted deterministically: mid-grace
      // the natural-end settle proves the unit empty and removes it, so
      // the stop's `cgroup.kill` write into the removed directory fails
      // ENOENT. The stop answers the settle's evidence, never
      // "unavailable".
      const drained = { value: false };
      const removed = { value: false };
      const enoent = Object.assign(
        new Error(
          "ENOENT: no such file or directory, open '/root/qwen-bg-killrace/cgroup.kill'",
        ),
        { code: 'ENOENT' },
      );
      const killUnit = {
        empty: () => drained.value,
        remove: () => {
          removed.value = true;
        },
        waitForEmpty: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          drained.value = true;
          return true;
        },
        terminate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw enoent;
        },
      } as unknown as HookCommandCgroup;
      const child = new EventEmitter() as ChildProcess;
      const staged = new ManagedChildRunProcess(
        'qwen-bg-killrace',
        killUnit,
        child,
      );
      child.emit('exit', 0, null);
      const settling = staged.settleOnEmpty();
      const draining = staged.terminate(600);
      await expect(settling).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      await expect(draining).resolves.toEqual({
        exitCode: 0,
        exitSignal: null,
      });
      expect(removed.value).toBe(true);
    });

    it('answers null for a natural end the root never produced', async () => {
      const { unit } = await fakeUnit('qwen-bg-live');
      vi.spyOn(HookCommandCgroup, 'create').mockReturnValue(unit);
      const supervisor = ManagedChildRunSupervisor.create({
        cgroupRoot: '/root',
      });
      const proc = await supervisor.start(
        {
          unitName: 'qwen-bg-live',
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          env: { PATH: '/bin:/usr/bin' },
          cwd: directory,
          onOutput: () => undefined,
        },
        { prove: async () => true },
      );
      await expect(proc.settleOnEmpty()).resolves.toBeNull();
      proc.child.kill('SIGKILL');
      await new Promise((resolve) => proc.child.once('exit', resolve));
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
