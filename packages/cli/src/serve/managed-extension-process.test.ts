/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';

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
});
