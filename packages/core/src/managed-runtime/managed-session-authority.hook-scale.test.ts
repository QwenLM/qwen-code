/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import type { HookExecution, HookRegistration } from './managed-hook-record.js';

// Counts the checks of a Hook execution body made through this module's
// exports: parses, and start and successor checks. An admission check that
// reads the Session's whole history repeats them.
const parsed = vi.hoisted(() => ({ executions: 0 }));
vi.mock('./managed-hook-record.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-hook-record.js')>();
  return {
    ...actual,
    parseHookExecution: (value: unknown) => {
      parsed.executions++;
      return actual.parseHookExecution(value);
    },
    isHookExecutionStart: (value: unknown) => {
      parsed.executions++;
      return actual.isHookExecutionStart(value);
    },
    isHookExecutionSuccessor: (previous: unknown, next: unknown) => {
      parsed.executions++;
      return actual.isHookExecutionSuccessor(previous, next);
    },
  };
});

const directories: string[] = [];
const sessionKey = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: '550e8400-e29b-41d4-a716-446655440002',
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A Session with a settled catalog registration. Its resource reads can be
 * counted or failed by resource ID.
 */
async function history() {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-hook-scale-'));
  directories.push(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    root,
    'chats',
    `${sessionKey.sessionId}.jsonl`,
  );
  await mkdir(runtimeBaseDir, { recursive: true });
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const local = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const reads: string[] = [];
  const failing = new Set<string>();
  const io = {
    inFlight: 0,
    peak: 0,
    delayMs: 0,
    slow: new Map<string, number>(),
  };
  const resources: ManagedSessionResourceStore = {
    publish: (kind, bytes) => local.publish(kind, bytes),
    read: async (ref) => {
      reads.push(ref.resourceId);
      if (failing.has(ref.resourceId))
        throw new Error(`resource ${ref.resourceId} is unavailable`);
      io.inFlight++;
      io.peak = Math.max(io.peak, io.inFlight);
      try {
        const delay = io.slow.get(ref.resourceId) ?? io.delayMs;
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        return await local.read(ref);
      } finally {
        io.inFlight--;
      }
    },
  };
  let lease: SessionWriterLease | undefined;
  const release = async () => {
    await lease?.release();
    lease = undefined;
  };
  const open = async (create = false, retainVerifiedResources = false) => {
    await release();
    lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    try {
      return await LocalManagedSessionAuthority.open({
        lease,
        sessionKey,
        cwd: '/workspace',
        version: 'test',
        resources,
        ...(retainVerifiedResources ? { retainVerifiedResources } : {}),
        ...(create
          ? {
              create: {
                definitionRef: await local.publish(
                  'definition',
                  Buffer.from('{}'),
                ),
                rootSnapshotRef: await local.publish('root', Buffer.from('{}')),
                createdBy: 'daemon',
              },
            }
          : {}),
      });
    } catch (error) {
      await release();
      throw error;
    }
  };
  let authority = await open(true);
  let commands = 0;
  const commit = (domain: string, record: unknown) =>
    authority.commitExtensionRecord(
      {
        operation: 'commitHookRecord',
        commandId: `command-${commands++}`,
        sessionKey,
        contentDigest: 'd'.repeat(64),
      },
      { domain: domain as 'hook_execution', record },
      actor,
    );
  const catalog = await local.publish(
    'managed-hook-catalog',
    Buffer.from('{}'),
  );
  for (const state of ['admitted', 'running', 'settled'] as const)
    await commit('hook_registration', {
      ...templates.hook_registration,
      catalogRef: catalog,
      run: { ...templates.hook_registration.run, state },
    });
  let plan: ManagedSessionDurableRef = catalog;
  /**
   * Execution `index` is ordinal `index % 4` of occurrence `index / 4`,
   * which shares one plan; odd executions consume a once key. Each settles
   * through three revisions, the last naming its result.
   */
  const execution = (index: number, input: ManagedSessionDurableRef) => {
    const id = `execution-${index}`;
    return {
      ...templates.hook_execution,
      hookExecutionId: id,
      occurrenceId: `occurrence-${Math.floor(index / 4)}`,
      ordinal: index % 4,
      planRef: plan,
      inputRef: input,
      onceKey: index % 2 === 1 ? `once-${index}` : null,
      run: { ...templates.hook_execution.run, effectId: id },
    } satisfies HookExecution;
  };
  const settle = async (index: number) => {
    if (index % 4 === 0)
      plan = await local.publish(
        'managed-hook-plan',
        Buffer.from(JSON.stringify({ index })),
      );
    const intent = execution(
      index,
      await local.publish('managed-hook-input', Buffer.from(`{"i":${index}}`)),
    );
    parsed.executions = 0;
    await commit('hook_execution', intent);
    const admission = parsed.executions;
    await commit('hook_execution', {
      ...intent,
      run: { ...intent.run, state: 'running', execution: 'dispatch_started' },
    });
    await commit('hook_execution', {
      ...intent,
      resultRef: await local.publish(
        'managed-hook-result',
        Buffer.from(`{"r":${index}}`),
      ),
      run: { ...intent.run, state: 'settled', execution: 'settled' },
    });
    return admission;
  };
  return {
    local,
    reads,
    failing,
    io,
    settle,
    commit,
    execution: (index: number) => execution(index, catalog),
    get authority() {
      return authority;
    },
    reopen: async (retainVerifiedResources = false) => {
      authority = await open(false, retainVerifiedResources);
      return authority;
    },
    release,
  };
}

it('admits a Hook execution without validating the history it accumulated', async () => {
  const session = await history();
  try {
    // Crosses the 32-revision replay window and ends at ordinal 1.
    const executions = 34;
    let early = 0;
    for (let index = 0; index < executions; index++) {
      const admission = await session.settle(index);
      // Equal modulo 4: ordinal 1 beside a committed sibling, with a once key.
      if (index === 9) early = admission;
      if (index === executions - 1) expect(admission).toBe(early);
    }
    expect(early).toBeGreaterThan(0);

    // Reopening replays every revision once and reads every resource once.
    session.reads.length = 0;
    session.io.peak = 0;
    parsed.executions = 0;
    const reopened = await session.reopen();
    expect(reopened.extensionRecordsInDomain('hook_execution')).toHaveLength(
      executions,
    );
    expect(session.reads.length).toBe(new Set(session.reads).size);
    // Each execution has 3 revisions, 1 input and 1 result; each occurrence
    // has a plan, plus the catalog and 3 registration revisions.
    expect(session.reads.length).toBe(
      executions * 5 + Math.ceil(executions / 4) + 4,
    );
    // A window of 32 revisions, each reading its record and then at most
    // three resources at once; an unbounded one reads hundreds here.
    expect(session.io.peak).toBeLessThanOrEqual(32 * 3);
    // A bounded number per revision; reading the history at each admission
    // takes several thousand here.
    expect(parsed.executions).toBeLessThanOrEqual(executions * 3 * 4);
  } finally {
    await session.release();
  }
});

it('refuses consumed once keys, taken ordinals and a moved occurrence from an indexed history', async () => {
  const session = await history();
  try {
    for (let index = 0; index < 40; index++) await session.settle(index);
    const { planRef } = session.authority.extensionRecord(
      'hook_execution',
      'execution-0',
    )!.record as HookExecution;
    // A replacement catalog, which new occurrences bind to.
    const replaced = {
      ...templates.hook_registration.run.definition!,
      definitionId: 'catalog-2',
    };
    for (const state of ['admitted', 'running', 'settled'] as const)
      await session.commit('hook_registration', {
        ...templates.hook_registration,
        registrationId: 'registration-2',
        catalogId: 'catalog-2',
        catalogRef: session.execution(0).inputRef,
        run: {
          ...templates.hook_registration.run,
          state,
          effectId: 'registration-2',
          definition: replaced,
        },
      });
    for (const live of [true, false]) {
      if (!live) await session.reopen();
      // The oldest once key, not only a recent one, stays consumed.
      await expect(
        session.commit('hook_execution', {
          ...session.execution(1000),
          onceKey: 'once-1',
        }),
      ).rejects.toThrow('onceKey is already consumed');
      for (const patch of [
        { occurrenceId: 'occurrence-0', ordinal: 2, planRef },
        {
          occurrenceId: 'occurrence-0',
          ordinal: 7,
          planRef,
          eventName: 'AfterTool',
        },
        {
          occurrenceId: 'occurrence-0',
          ordinal: 7,
          planRef: session.execution(0).inputRef,
        },
        // An existing occurrence keeps its registration.
        {
          occurrenceId: 'occurrence-0',
          ordinal: 7,
          planRef,
          registrationId: 'registration-2',
          run: { ...session.execution(1000).run, definition: replaced },
        },
      ])
        await expect(
          session.commit('hook_execution', {
            ...session.execution(1000),
            ...patch,
          }),
        ).rejects.toThrow('unique ordinals');
      await expect(
        session.commit('hook_registration', {
          ...templates.hook_registration,
          registrationId: `conflicting-${live}`,
          catalogRef: session.execution(0).inputRef,
          run: {
            ...templates.hook_registration.run,
            effectId: `conflicting-${live}`,
            definition: {
              ...templates.hook_registration.run.definition!,
              definitionDigest: 'c'.repeat(64),
            },
          },
        }),
      ).rejects.toThrow('two definition digests');
    }
    // A command opens one record only, also after a reopen.
    await expect(
      session.authority.commitExtensionRecord(
        {
          operation: 'other',
          commandId: 'command-3',
          sessionKey,
          contentDigest: 'e'.repeat(64),
        },
        { domain: 'hook_execution', record: session.execution(2000) },
        actor,
      ),
    ).rejects.toThrow('command command-3 already opened hook_execution record');
    await session.settle(1000);
    expect(
      session.authority.extensionRecord('hook_execution', 'execution-1000')
        ?.revision,
    ).toBe(3);
  } finally {
    await session.release();
  }
});

it('still refuses a reopen when a shared or late resource is missing or corrupt', async () => {
  const session = await history();
  try {
    for (let index = 0; index < 12; index++) await session.settle(index);
    const record = (id: string) =>
      session.authority.extensionRecord('hook_execution', id)!
        .record as HookExecution;
    const plan = record('execution-5').planRef;
    const result = record('execution-11').resultRef!;
    await session.release();
    // A plan that every revision of four executions names, and a result
    // that only the last revision of the last execution names.
    // Other reads are slow, so some are still running when the replay meets
    // the failure; none may outlive the refused open.
    session.io.delayMs = 20;
    for (const ref of [plan, result]) {
      session.failing.add(ref.resourceId);
      await expect(session.reopen()).rejects.toThrow(
        `resource ${ref.resourceId} is unavailable`,
      );
      expect(session.io.inFlight).toBe(0);
      session.failing.delete(ref.resourceId);
    }
    session.io.delayMs = 0;
    // Only the failing revision's other reference is slow.
    session.failing.add(plan.resourceId);
    session.io.slow.set(record('execution-4').inputRef.resourceId, 100);
    await expect(session.reopen()).rejects.toThrow('is unavailable');
    expect(session.io.inFlight).toBe(0);
    session.failing.delete(plan.resourceId);
    session.io.slow.clear();
    const file = path.join(
      session.local.sessionRoot,
      plan.kind,
      plan.resourceId,
    );
    // The same length, so only the digest tells it apart.
    await writeFile(file, '{"index":5}');
    await expect(session.reopen()).rejects.toThrow(
      'does not match its recorded digest',
    );
    await rm(file);
    await expect(session.reopen()).rejects.toThrow('not present');
  } finally {
    await session.release();
  }
});

it('keeps what opening verified only until a caller takes it', async () => {
  const session = await history();
  try {
    for (let index = 0; index < 8; index++) await session.settle(index);
    const reopened = await session.reopen();
    expect((await reopened.takeVerifiedExtensionResources()).size).toBe(0);
    session.reads.length = 0;
    const retained = await session.reopen(true);
    // Everything opening read, and nothing else.
    expect(
      [...(await retained.takeVerifiedExtensionResources()).keys()].sort(),
    ).toEqual([...new Set(session.reads)].sort());
    expect(session.reads).toHaveLength(8 * 5 + 2 + 4);
    expect((await retained.takeVerifiedExtensionResources()).size).toBe(0);
  } finally {
    await session.release();
  }
});

it('reads a committed reference again at each commit, as before', async () => {
  const session = await history();
  try {
    await session.settle(0);
    const input = await session.local.publish(
      'managed-hook-input',
      Buffer.from('{"lost":true}'),
    );
    await session.commit('hook_execution', {
      ...session.execution(1),
      inputRef: input,
    });
    // A resource lost after one commit refuses the next that names it.
    await rm(
      path.join(session.local.sessionRoot, input.kind, input.resourceId),
    );
    await expect(
      session.commit('hook_execution', {
        ...session.execution(2),
        inputRef: input,
      }),
    ).rejects.toThrow('not present');
  } finally {
    await session.release();
  }
});

it('lets the store judge a reopened reference that describes a verified ID differently', async () => {
  const session = await history();
  try {
    await session.settle(0);
    const input = await session.local.publish(
      'managed-hook-input',
      Buffer.from('{"shared":true}'),
    );
    await session.commit('hook_execution', {
      ...session.execution(1),
      inputRef: input,
    });
    // The local store reads no schema version, so it accepts this one.
    await session.commit('hook_execution', {
      ...session.execution(2),
      inputRef: { ...input, schemaVersion: 2 },
    });
    session.reads.length = 0;
    const reopened = await session.reopen();
    expect(reopened.extensionRecordsInDomain('hook_execution')).toHaveLength(3);
    expect(session.reads.filter((id) => id === input.resourceId)).toHaveLength(
      2,
    );
  } finally {
    await session.release();
  }
});
