/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

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

describe('HostedTextDeltaStream', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hosted-deltas-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits every chunk as an activation-scoped message.delta event', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.delta('Hello, ');
      await stream.delta('world');
      const messageId = stream.takeMessageId();
      expect(messageId).toBeDefined();
      expect(stream.takeMessageId()).toBeUndefined();
      const events = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.payload['text'])).toEqual([
        'Hello, ',
        'world',
      ]);
      for (const event of events) {
        expect(event.payload['messageId']).toBe(messageId);
        expect(event.payload['turnId']).toBe('turn-1');
        expect(event.subject?.type).toBe('activation');
        expect(
          event.subject?.type === 'activation'
            ? event.subject.activationId
            : undefined,
        ).toBe(session.activation.activationId);
      }
    } finally {
      await session.close();
    }
  });

  it('splits chunks beyond the journal text limit', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.delta('x'.repeat(3072 + 100));
      const events = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(events).toHaveLength(2);
      expect(
        Buffer.byteLength(String(events[0]!.payload['text']), 'utf8'),
      ).toBeLessThanOrEqual(3072);
      expect(
        events.map((event) => event.payload['text']).join(''),
      ).toHaveLength(3072 + 100);
    } finally {
      await session.close();
    }
  });

  it('splits multi-byte chunks within the byte cap and rejoins exactly', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      const input = '好'.repeat(2000);
      await stream.delta(input);
      const events = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(events.length).toBeGreaterThan(1);
      for (const event of events) {
        expect(
          Buffer.byteLength(String(event.payload['text']), 'utf8'),
        ).toBeLessThanOrEqual(3072);
      }
      expect(events.map((event) => event.payload['text']).join('')).toBe(input);
    } finally {
      await session.close();
    }
  });

  it('commits model text with newlines and tabs verbatim', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.delta('line one\nline two');
      await stream.delta('\tindented\r\n');
      const events = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(events.map((event) => event.payload['text']).join('')).toBe(
        'line one\nline two\tindented\r\n',
      );
    } finally {
      await session.close();
    }
  });

  it('assigns a fresh messageId per model message', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.delta('first');
      const first = stream.takeMessageId();
      await stream.delta('second');
      const second = stream.takeMessageId();
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first).not.toBe(second);
      const ids = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta')
        .map((event) => event.payload['messageId']);
      expect(ids).toEqual([first, second]);
    } finally {
      await session.close();
    }
  });

  it('journals a retraction keyed by the first delta sequence and resets', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.delta('orphaned ');
      await stream.delta('prefix');
      const deltas = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(deltas).toHaveLength(2);

      await stream.retract();

      const retractions = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.retracted');
      expect(retractions).toHaveLength(1);
      expect(retractions[0]!.payload['messageId']).toBe(
        deltas[0]!.payload['messageId'],
      );
      expect(retractions[0]!.payload['turnId']).toBe('turn-1');
      expect(retractions[0]!.payload['fromSequence']).toBe(deltas[0]!.sequence);
      expect(retractions[0]!.sequence).toBeGreaterThan(deltas[1]!.sequence);
      expect(retractions[0]!.subject?.type).toBe('activation');

      // The replay publishes under a fresh identity.
      await stream.delta('recovered');
      const recoveredId = stream.takeMessageId();
      expect(recoveredId).toBeDefined();
      expect(recoveredId).not.toBe(deltas[0]!.payload['messageId']);
    } finally {
      await session.close();
    }
  });

  it('retracts nothing when nothing was published', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      await stream.retract();
      const retractions = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.retracted');
      expect(retractions).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

describe('HostedTextDeltaStream surrogate safety', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hosted-deltas-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('never splits a surrogate pair across durable chunks', async () => {
    const session = await openSession(root);
    try {
      const stream = new HostedTextDeltaStream(session, 'turn-1');
      const input = 'a'.repeat(3069) + '😀' + 'b'.repeat(4000);
      await stream.delta(input);
      const events = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'message.delta');
      expect(events.length).toBeGreaterThan(1);
      for (const event of events) {
        const text = event.payload['text'] as string;
        expect(
          text.charCodeAt(text.length - 1) >= 0xd800 &&
            text.charCodeAt(text.length - 1) <= 0xdbff,
        ).toBe(false);
        expect(
          text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff,
        ).toBe(false);
      }
      expect(events.map((event) => event.payload['text']).join('')).toBe(input);
    } finally {
      await session.close();
    }
  });
});
