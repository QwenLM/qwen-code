/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import { runHostedCsiTextTurn } from './hosted-csi-text-turn.js';

vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: vi.fn(),
}));

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_A = '33333333-3333-4333-8333-333333333333';
const PROMPT_B = '44444444-4444-4444-8444-444444444444';

async function openSession(root: string) {
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };
  const resourceStore = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  return openManagedSession({
    runtimeBaseDir: root,
    transcriptPath: '',
    sessionId: SESSION_ID,
    sessionKey,
    cwd: root,
    version: 'hosted-harness/1',
    workerId: 'boot-1',
    activationLeaseDurationMs: 60_000,
    journalStore: new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: root,
      sessionId: SESSION_ID,
      transcriptPath: path.join(root, `${SESSION_ID}.jsonl`),
    }),
    resourceStore,
    create: {
      definitionRef: await resourceStore.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({ engine: 'managed', sessionId: SESSION_ID }),
        ),
      ),
      rootSnapshotRef: await resourceStore.publish(
        'managed-root',
        Buffer.from(JSON.stringify({ cwd: root })),
      ),
      createdBy: 'hosted-harness',
    },
    requireNew: true,
  });
}

async function submit(session: ManagedSession, promptId: string, text: string) {
  const bytes = Buffer.from(JSON.stringify([{ type: 'text', text }]));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const contentRef = await session.resources.publish('managed-input', bytes);
  const admissionRef = await session.resources.publish(
    'managed-admission',
    Buffer.from(JSON.stringify({ promptId, digest: `sha256:${digest}` })),
  );
  await session.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: digest,
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'hosted-harness',
      contentRef,
      admissionRef,
      deadline: null,
      wakeReason: 'input',
    },
  );
}

describe('private CSI native text turn', () => {
  let root: string;
  let managed: ManagedSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(tmpdir(), 'csi-text-turn-'));
    managed = await openSession(root);
  });

  afterEach(async () => {
    await managed.close();
    await rm(root, { recursive: true, force: true });
  });

  it('retains complete Parts and connects streamed identity to native settlement', async () => {
    const parts = [{ text: 'reason', thought: true }, { text: 'answer' }];
    vi.mocked(runHostedHarnessTextTurn).mockImplementation(async (input) => {
      const finish = await input.modelScope!.beginMainAttempt('owned-model');
      await input.textDeltas!.delta('answer');
      await finish(true, []);
      return { text: 'answer', parts, model: 'owned-model' };
    });
    await submit(managed, PROMPT_A, 'first');
    const result = await runHostedCsiTextTurn(
      { managed, cwd: root },
      PROMPT_A,
      'first',
      new AbortController(),
    );
    expect(result.systemPayload).toMatchObject({ state: 'completed' });
    const projected = await managed.sink.project();
    const assistant = projected.find((entry) => entry.type === 'assistant')!;
    expect(assistant.message?.parts).toEqual(parts);
    const events = managed.authority.eventsInSequenceRange(
      1,
      managed.authority.committedSequence,
    );
    expect(
      events.find((event) => event.kind === 'message.delta')?.payload,
    ).toMatchObject({ messageId: assistant.uuid });
    expect(
      events.find((event) => event.kind === 'turn.settled')?.payload,
    ).toMatchObject({ turnId: PROMPT_A, outcome: 'completed' });
    expect(managed.authority.currentActivation?.epoch).toBe(1);
    expect(runHostedHarnessTextTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ toolTurn: expect.anything() }),
    );
  });

  it('continues from settled history and excludes a failed prompt instruction', async () => {
    vi.mocked(runHostedHarnessTextTurn).mockRejectedValueOnce(
      new Error('owned model failure'),
    );
    await submit(managed, PROMPT_A, 'failed instruction');
    const first = await runHostedCsiTextTurn(
      { managed, cwd: root },
      PROMPT_A,
      'failed instruction',
      new AbortController(),
    );
    expect(first.systemPayload).toMatchObject({ state: 'error' });
    vi.mocked(runHostedHarnessTextTurn).mockImplementation(async (input) => {
      expect(input.history.some((entry) => entry.type === 'user')).toBe(false);
      const finish = await input.modelScope!.beginMainAttempt('owned-model');
      await finish(true, []);
      return { text: 'next answer', model: 'owned-model' };
    });
    await submit(managed, PROMPT_B, 'second');
    const second = await runHostedCsiTextTurn(
      { managed, cwd: root },
      PROMPT_B,
      'second',
      new AbortController(),
    );
    expect(second.systemPayload).toMatchObject({ state: 'completed' });
    expect(managed.authority.currentActivation?.epoch).toBe(1);
  });

  it('propagates native persistence errors from the model scope without settling', async () => {
    vi.mocked(runHostedHarnessTextTurn).mockRejectedValueOnce(
      new ManagedSessionRecordError('owned model receipt lost'),
    );
    await submit(managed, PROMPT_A, 'first');
    await expect(
      runHostedCsiTextTurn(
        { managed, cwd: root },
        PROMPT_A,
        'first',
        new AbortController(),
      ),
    ).rejects.toThrow('owned model receipt lost');
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .some((event) => event.kind === 'turn.settled'),
    ).toBe(false);
  });

  it('propagates uncertain assistant persistence instead of settling a model error', async () => {
    vi.mocked(runHostedHarnessTextTurn).mockImplementation(async (input) => {
      const finish = await input.modelScope!.beginMainAttempt('owned-model');
      await finish(true, []);
      return { text: 'answer', model: 'owned-model' };
    });
    await submit(managed, PROMPT_A, 'first');
    const write = managed.sink.write.bind(managed.sink);
    vi.spyOn(managed.sink, 'write').mockImplementation(async (entry) => {
      if (entry.type === 'assistant') throw new Error('owned uncertain output');
      return write(entry);
    });
    await expect(
      runHostedCsiTextTurn(
        { managed, cwd: root },
        PROMPT_A,
        'first',
        new AbortController(),
      ),
    ).rejects.toThrow('owned uncertain output');
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .some((event) => event.kind === 'turn.settled'),
    ).toBe(false);
  });

  it('propagates an uncertain terminal write instead of returning completion', async () => {
    vi.mocked(runHostedHarnessTextTurn).mockRejectedValueOnce(
      new Error('model'),
    );
    await submit(managed, PROMPT_A, 'first');
    const write = managed.sink.write.bind(managed.sink);
    vi.spyOn(managed.sink, 'write').mockImplementation(async (entry) => {
      if (entry.subtype === 'turn_result')
        throw new Error('owned lost receipt');
      return write(entry);
    });
    await expect(
      runHostedCsiTextTurn(
        { managed, cwd: root },
        PROMPT_A,
        'first',
        new AbortController(),
      ),
    ).rejects.toThrow('owned lost receipt');
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .some((event) => event.kind === 'turn.settled'),
    ).toBe(false);
  });
});
