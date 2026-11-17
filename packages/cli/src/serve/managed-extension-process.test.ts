/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';

// The Linux preread regressions below mock only the cgroup unit so a real
// child is spawned through the real start() attach path without a delegated
// cgroup root. Developer-mode tests never touch this module. The launch script
// is hoisted-mutable so the overflow case can write past the capture budget
// before acknowledging membership.
const cgroupMock = vi.hoisted(() => ({
  script:
    "require('fs').writeSync(3,'joined\\n');process.stdout.write('stdout-sentinel');process.stderr.write('stderr-sentinel');setInterval(()=>{},1000)",
}));
vi.mock('@qwen-code/qwen-code-core/hooks/hook-command-cgroup.js', () => {
  const unit = {
    launch: (executable: string, _args: string[], env: NodeJS.ProcessEnv) => ({
      executable,
      args: ['-e', cgroupMock.script],
      env,
    }),
    terminate: async () => {},
    waitForEmpty: async () => true,
    remove: () => {},
  };
  return { HookCommandCgroup: { create: () => unit, attach: () => unit } };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('ManagedExtensionProcessOwners', () => {
  it('does not silently substitute developer mode on unsupported hosts', () => {
    if (process.platform !== 'linux')
      expect(
        () => new ManagedExtensionProcessOwners('linux-cgroup', {}),
      ).toThrow('unavailable');
    expect(
      () => new ManagedExtensionProcessOwners('developer-process-group', {}),
    ).toThrow('unavailable');
  });

  it.skipIf(process.platform !== 'darwin')(
    'stops changed Session owners while preserving retained MCP owners and sibling Sessions',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-retained-'),
      );
      directories.push(directory);
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
      const start = (sessionId: string) =>
        owners.start({
          sessionId,
          configRevision: 1,
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          env: {},
          cwd: directory,
        });
      try {
        const retained = await start('a');
        const changed = await start('a');
        const sibling = await start('b');
        const receipts = await owners.stopSession(
          'a',
          new Set([retained.ownerId]),
        );
        expect(receipts).toEqual([
          expect.objectContaining({
            ownerId: changed.ownerId,
            state: 'stopped',
          }),
        ]);
        expect(receipts.some((receipt) => receipt.coverage !== undefined)).toBe(
          false,
        );
        expect(await owners.hasLiveSessionOwners('a')).toBe(true);
        expect(
          await owners.hasLiveSessionOwners('a', new Set([retained.ownerId])),
        ).toBe(false);
        expect(await owners.hasLiveSessionOwners('b')).toBe(true);
        expect(retained.child.exitCode).toBeNull();
        expect(sibling.child.exitCode).toBeNull();
      } finally {
        await owners.stopAll();
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'persists zero-owner coverage and rejects a missing indexed owner after restart',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-journal-'),
      );
      directories.push(directory);
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
      const options = { ledger, directory: path.join(directory, 'owners') };
      const original = new ManagedExtensionProcessOwners(
        'developer-process-group',
        options,
      );
      await original.coverSession('root', 1);
      const resumed = new ManagedExtensionProcessOwners(
        'developer-process-group',
        options,
      );
      expect(await resumed.stopSession('root')).toEqual([
        expect.objectContaining({
          state: 'stopped',
          coverage: 'registered-owners',
          configRevision: 1,
          journalId: original.journalId,
        }),
      ]);
      await fs.writeFile(
        path.join(options.directory, '.owners.json'),
        JSON.stringify(['extension-aaaa']),
      );
      const damaged = new ManagedExtensionProcessOwners(
        'developer-process-group',
        options,
      );
      await expect(damaged.stopSession('root')).rejects.toThrow('missing');
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'records the process group before target code and reports only group scope',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-process-'),
      );
      directories.push(directory);
      const ledger = ManagedRuntimeLedger.create({
        workFile: path.join(directory, 'ledger.json'),
        worker: {
          pid: process.pid,
          pgid: process.pid,
          incarnation: 'test',
          startedAt: Date.now(),
        },
      });
      const owners = new ManagedExtensionProcessOwners(
        'developer-process-group',
        { ledger },
      );
      const owner = await owners.start({
        sessionId: 'session-a',
        configRevision: 1,
        executable: process.execPath,
        args: [
          '-e',
          'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
        ],
        env: {},
        cwd: directory,
      });
      try {
        expect(ledger.outstandingGroups()).toEqual([
          expect.objectContaining({
            callId: owner.ownerId,
            pgid: owner.child.pid,
          }),
        ]);
        const receipt = await owners.stop(owner.ownerId);
        expect(receipt).toMatchObject({
          state: 'stopped',
          scope: 'process_group',
          mode: 'developer-process-group',
          sessionId: 'session-a',
        });
        expect(await owners.stopSession('session-b')).toEqual([]);
        expect(await owners.stop(owner.ownerId)).toEqual(receipt);
      } finally {
        owner.child.kill('SIGKILL');
        await owners.stop(owner.ownerId);
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'releases preread listeners and buffers when startup fails after spawn',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-preread-fail-'),
      );
      directories.push(directory);
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
      // Fail the post-spawn durable save: that owner record carries pgid, the
      // pre-spawn save does not. start() then rejects after the child exists
      // and the preread listeners are attached.
      const proto = ManagedExtensionProcessOwners.prototype as unknown as {
        saveOwner: (owner: Record<string, unknown>) => Promise<void>;
      };
      const originalSave = proto.saveOwner;
      const save = vi
        .spyOn(proto, 'saveOwner')
        .mockImplementation(async function (
          this: ManagedExtensionProcessOwners,
          owner: Record<string, unknown>,
        ) {
          if ('pgid' in owner)
            throw new Error('injected post-spawn journal failure');
          return originalSave.call(this, owner);
        });
      try {
        await expect(
          owners.start({
            sessionId: 'root',
            configRevision: 1,
            executable: process.execPath,
            args: [
              '-e',
              'process.stdout.write("stdout-sentinel");setInterval(()=>{},1000)',
            ],
            env: {},
            cwd: directory,
            prereadOutput: true,
          }),
        ).rejects.toThrow('injected post-spawn journal failure');
        // The stopped child is retained in the owner map; its preread
        // listeners must be detached so they cannot keep output buffers alive
        // for the lifetime of this instance.
        const retained = [
          ...(
            owners as unknown as {
              owners: Map<
                string,
                {
                  child?: {
                    stdout?: { listenerCount: (event: string) => number };
                    stderr?: { listenerCount: (event: string) => number };
                  };
                }
              >;
            }
          ).owners.values(),
        ];
        expect(retained).toHaveLength(1);
        expect(retained[0].child?.stdout?.listenerCount('data')).toBe(0);
        expect(retained[0].child?.stderr?.listenerCount('data')).toBe(0);
      } finally {
        save.mockRestore();
        await owners.stopAll();
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'buffers stdout/stderr from spawn through real cgroup-mode start on Linux',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-preread-linux-'),
      );
      directories.push(directory);
      const owners = new ManagedExtensionProcessOwners('linux-cgroup', {
        cgroupRoot: directory,
        directory: path.join(directory, 'owners'),
      });
      // The mocked cgroup unit does not actually kill the child, so track it
      // for explicit cleanup.
      let spawned: ChildProcess | undefined;
      try {
        const started = await owners.start({
          sessionId: 'root',
          configRevision: 1,
          executable: process.execPath,
          args: ['-e', 'ignored-by-mock-launch'],
          env: { PATH: '/usr/bin:/bin' },
          cwd: directory,
          prereadOutput: true,
        });
        spawned = started.child;
        // The spawn-time listeners (not a caller stub) must capture the real
        // child's output; disabling the preread attach leaves these empty.
        await vi.waitFor(() => {
          expect(Buffer.concat(started.preread!.stdout).toString()).toBe(
            'stdout-sentinel',
          );
          expect(Buffer.concat(started.preread!.stderr).toString()).toBe(
            'stderr-sentinel',
          );
        });
        started.detachPreread!();
      } finally {
        spawned?.kill('SIGKILL');
        await owners.stopAll();
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'detaches preread listeners when startup fails after spawn on Linux',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-preread-fail-linux-'),
      );
      directories.push(directory);
      const owners = new ManagedExtensionProcessOwners('linux-cgroup', {
        cgroupRoot: directory,
        directory: path.join(directory, 'owners'),
      });
      // Reject the post-spawn durable save (its record carries pgid) after a
      // short delay so the real child's sentinels reach the preread buffers
      // before the failure. This pins the failed-start cleanup on the platform
      // CI actually runs; the darwin-only regression never executes there.
      const proto = ManagedExtensionProcessOwners.prototype as unknown as {
        saveOwner: (owner: Record<string, unknown>) => Promise<void>;
      };
      const originalSave = proto.saveOwner;
      const save = vi
        .spyOn(proto, 'saveOwner')
        .mockImplementation(async function (
          this: ManagedExtensionProcessOwners,
          owner: Record<string, unknown>,
        ) {
          if ('pgid' in owner) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            throw new Error('injected post-spawn journal failure');
          }
          return originalSave.call(this, owner);
        });
      try {
        await expect(
          owners.start({
            sessionId: 'root',
            configRevision: 1,
            executable: process.execPath,
            args: ['-e', 'ignored-by-mock-launch'],
            env: { PATH: '/usr/bin:/bin' },
            cwd: directory,
            prereadOutput: true,
          }),
        ).rejects.toThrow('injected post-spawn journal failure');
        // The stopped child stays in the owner map; removing the failed-start
        // detach leaves its data listeners attached (listenerCount 1).
        const retained = [
          ...(
            owners as unknown as {
              owners: Map<
                string,
                {
                  child?: {
                    stdout?: { listenerCount: (event: string) => number };
                    stderr?: { listenerCount: (event: string) => number };
                  };
                }
              >;
            }
          ).owners.values(),
        ];
        expect(retained).toHaveLength(1);
        expect(retained[0].child?.stdout?.listenerCount('data')).toBe(0);
        expect(retained[0].child?.stderr?.listenerCount('data')).toBe(0);
      } finally {
        save.mockRestore();
        await owners.stopAll();
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'caps the spawn-time preread at the shell budget and reports overflow',
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-preread-cap-'),
      );
      directories.push(directory);
      const owners = new ManagedExtensionProcessOwners('linux-cgroup', {
        cgroupRoot: directory,
        directory: path.join(directory, 'owners'),
      });
      // Write past the 1 MiB budget BEFORE acknowledging membership, so the
      // overflow happens inside the pre-handoff preread window. An unbounded
      // preread would retain all 2 MiB and never flag overflow.
      const defaultScript = cgroupMock.script;
      cgroupMock.script =
        'process.stdout.write("x".repeat(2 * 1024 * 1024));require(\'fs\').writeSync(3,"joined\\n");setInterval(()=>{},1000)';
      let spawned: ChildProcess | undefined;
      try {
        const started = await owners.start({
          sessionId: 'root',
          configRevision: 1,
          executable: process.execPath,
          args: ['-e', 'ignored-by-mock-launch'],
          env: { PATH: '/usr/bin:/bin' },
          cwd: directory,
          prereadOutput: true,
        });
        spawned = started.child;
        started.detachPreread!();
        const retainedBytes =
          started.preread!.stdout.reduce((n, b) => n + b.length, 0) +
          started.preread!.stderr.reduce((n, b) => n + b.length, 0);
        expect(retainedBytes).toBeLessThanOrEqual(1024 * 1024);
        expect(started.preread!.overflow).toBe(true);
      } finally {
        cgroupMock.script = defaultScript;
        spawned?.kill('SIGKILL');
        await owners.stopAll();
      }
    },
  );
});
