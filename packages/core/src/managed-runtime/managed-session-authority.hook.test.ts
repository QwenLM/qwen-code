/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  type HookExecution,
  type HookRegistration,
} from './managed-hook-record.js';

const directories: string[] = [];
const sessionKey = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: '550e8400-e29b-41d4-a716-446655440001',
};
const actor = { class: 'trusted_entry' } as const;
const templates = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-hook-record-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
).templates as {
  hook_registration: HookRegistration;
  hook_execution: HookExecution;
};
function command(commandId: string) {
  return {
    operation: 'commitHookRecord',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-hook-authority-'));
  directories.push(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    root,
    'chats',
    `${sessionKey.sessionId}.jsonl`,
  );
  await mkdir(runtimeBaseDir, { recursive: true });
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const open = async (create: boolean) => {
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    try {
      const authority = await LocalManagedSessionAuthority.open({
        lease,
        sessionKey,
        cwd: '/workspace',
        version: 'test',
        resources,
        ...(create
          ? {
              create: {
                definitionRef: await resources.publish(
                  'definition',
                  Buffer.from('{}'),
                ),
                rootSnapshotRef: await resources.publish(
                  'root',
                  Buffer.from('{}'),
                ),
                createdBy: 'daemon',
              },
            }
          : {}),
      });
      return { lease, authority };
    } catch (error) {
      await lease.release();
      throw error;
    }
  };
  const data = await resources.publish('hook-data', Buffer.from('{}'));
  const registration: HookRegistration = {
    ...templates.hook_registration,
    catalogRef: data,
  };
  const execution: HookExecution = {
    ...templates.hook_execution,
    planRef: data,
    inputRef: data,
  };
  return { resources, open, data, registration, execution };
}

it('pins Hook plans, consumes once intents atomically and recovers unknown execution without tasks', async () => {
  const { open, data, registration, execution, resources } = await setup();
  const first = await open(true);
  let blocked: HookExecution;
  const commit = (id: string, record: HookExecution) =>
    first.authority.commitExtensionRecord(
      command(id),
      { domain: 'hook_execution', record },
      actor,
    );
  const another = (
    id: string,
    patch: Partial<HookExecution> = {},
  ): HookExecution => ({
    ...execution,
    ...patch,
    hookExecutionId: id,
    run: { ...execution.run, effectId: id },
  });
  try {
    await expect(commit('not-registered', execution)).rejects.toThrow(
      'settled committed registration',
    );
    for (const state of ['admitted', 'running', 'settled'] as const) {
      const receipt = await first.authority.commitExtensionRecord(
        command(`register-${state}`),
        {
          domain: 'hook_registration',
          record: { ...registration, run: { ...registration.run, state } },
        },
        actor,
      );
      expect(receipt.taskId).toBeNull();
    }
    await expect(
      first.authority.commitExtensionRecord(
        command('conflicting-definition'),
        {
          domain: 'hook_registration',
          record: {
            ...registration,
            registrationId: 'other',
            run: {
              ...registration.run,
              effectId: 'other',
              definition: {
                ...registration.run.definition!,
                definitionDigest: 'c'.repeat(64),
              },
            },
          },
        },
        actor,
      ),
    ).rejects.toThrow('two definition digests');
    await expect(
      commit('wrong-pin', {
        ...execution,
        run: {
          ...execution.run,
          definition: { ...execution.run.definition!, definitionRevision: 2 },
        },
      }),
    ).rejects.toThrow('settled committed registration');
    for (const field of ['planRef', 'inputRef'] as const) {
      await expect(
        commit(`missing-${field}`, {
          ...execution,
          [field]: { ...data, resourceId: 'missing' },
        }),
      ).rejects.toThrow('not present');
    }
    const intents = await Promise.allSettled([
      commit('execution-1', execution),
      commit(
        'execution-2',
        another('execution-2', { occurrenceId: 'occurrence-2' }),
      ),
    ]);
    expect(intents.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((intents[1] as PromiseRejectedResult).reason.message).toContain(
      'onceKey',
    );
    expect((await commit('execution-1', execution)).receipt.replayed).toBe(
      true,
    );
    const differentPlan = await resources.publish(
      'hook-plan',
      Buffer.from('{}'),
    );
    for (const patch of [
      { ordinal: 0 },
      { ordinal: 1, eventName: 'AfterTool' },
      { ordinal: 1, planRef: differentPlan },
    ]) {
      await expect(
        commit(
          'bad-occurrence',
          another('bad-occurrence', { ...patch, onceKey: null }),
        ),
      ).rejects.toThrow('unique ordinals');
    }
    const running: HookExecution = {
      ...execution,
      run: {
        ...execution.run,
        state: 'running',
        execution: 'dispatch_started',
      },
    };
    await commit('execution-dispatch', running);
    blocked = {
      ...running,
      run: {
        ...running.run,
        state: 'recovery_blocked',
        execution: 'outcome_unknown',
        reason: 'outcome_unknown',
      },
    };
    await commit('execution-unknown', blocked);
    expect(first.authority.taskViews()).toEqual([]);
  } finally {
    await first.lease.release();
  }
  const reopened = await open(false);
  try {
    expect(
      reopened.authority.extensionRecord('hook_execution', 'execution-1'),
    ).toMatchObject({ record: blocked!, task: null });
    await expect(
      reopened.authority.commitExtensionRecord(
        command('once-after-recovery'),
        {
          domain: 'hook_execution',
          record: another('once-after-recovery', {
            occurrenceId: 'occurrence-2',
          }),
        },
        actor,
      ),
    ).rejects.toThrow('onceKey');
    const settled: HookExecution = {
      ...blocked!,
      resultRef: data,
      run: {
        ...blocked!.run,
        state: 'settled',
        execution: 'settled',
        reason: null,
      },
    };
    await reopened.authority.commitExtensionRecord(
      command('late-result'),
      { domain: 'hook_execution', record: settled },
      actor,
    );
    await expect(
      reopened.authority.commitExtensionRecord(
        command('rewrite-result'),
        {
          domain: 'hook_execution',
          record: { ...settled, cancelRequested: true },
        },
        actor,
      ),
    ).rejects.toThrow('cannot follow');
    expect(reopened.authority.taskViews()).toEqual([]);
  } finally {
    await reopened.lease.release();
  }
  const final = await open(false);
  try {
    expect(
      final.authority.extensionRecord('hook_execution', 'execution-1')?.run,
    ).toMatchObject({ state: 'settled', runtime: null });
  } finally {
    await final.lease.release();
  }
  await rm(path.join(resources.sessionRoot, data.kind, data.resourceId));
  await expect(open(false)).rejects.toThrow('not present');
});
