import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { createManagedHarnessHandle } from './managed-harness-factory.js';
import { ManagedHookActivationController } from './managed-hook-activation.js';
import {
  enableManagedExecutionDiagnostics,
  getManagedExecutionDiagnostics,
  managedInvocationId,
  parseManagedExecutionEvidence,
  observeManagedToolResponse,
  type ManagedExecutionEvidence,
} from './managed-execution-diagnostics.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { assertManagedSessionDurableRef } from './managed-session-records.js';
import type { ManagedSessionKey } from './managed-session-records.js';
import { scanManagedSessionJournal } from './managed-session-storage.js';

const fixture = JSON.parse(
  await fs.readFile(
    new URL(
      './contracts/managed-execution-diagnostics-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  sessionKey: ManagedSessionKey;
  messageId: string;
  ordinal: number;
  invocationId: string;
  evidence: ManagedExecutionEvidence;
};

const sessions: ManagedSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

async function setup(collect = true) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'execution-diagnostics-'),
  );
  dirs.push(dir);
  const options = {
    runtimeBaseDir: dir,
    transcriptPath: path.join(dir, 'session.jsonl'),
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    sessionKey: {
      tenantId: 't1',
      workspaceId: 'w1',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    },
    cwd: dir,
    version: 'hosted-harness/1',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
  };
  const resources = LocalManagedSessionResourceStore.create(options);
  const ref = await resources.publish('managed-test', Buffer.from('{}'));
  const session = await openManagedSession({
    ...options,
    create: { definitionRef: ref, rootSnapshotRef: ref, createdBy: 'test' },
  });
  sessions.push(session);
  if (collect) await enableManagedExecutionDiagnostics(session);
  await createManagedHarnessHandle(session).ensureRunnable();
  const record = (uuid: string): ChatRecord => ({
    uuid,
    parentUuid: null,
    sessionId: options.sessionId,
    timestamp: '2026-11-07T00:00:00.000Z',
    type: 'assistant',
    cwd: dir,
    version: 'hosted-harness/1',
    message: {
      role: 'model',
      parts: [
        { text: 'prefix' },
        {
          functionCall: {
            id: 'reused',
            name: 'read_file',
            args: { file_path: 'a.txt' },
          },
        },
      ],
    },
  });
  return { session, options, record };
}

describe('Managed execution diagnostics', () => {
  it.each([false, true])(
    'binds committed record digests to diagnostic evidence (collect=%s)',
    async (collect) => {
      const { session, options, record } = await setup(collect);
      const message = record('digest');
      await session.sink.write(message);
      const event = session.authority.lastEventOfKind('message.committed')!;
      const content = assertManagedSessionDurableRef(
        event.payload['contentRef'],
        'contentRef',
      );
      const diagnostics = event.payload['diagnosticsRef'];
      const expected = collect
        ? createHash('sha256')
            .update(
              JSON.stringify([
                'managed-execution-commit/1',
                content.digest,
                assertManagedSessionDurableRef(diagnostics, 'diagnosticsRef')
                  .digest,
              ]),
            )
            .digest('hex')
        : session.authority.sessionHeader.definitionRef.digest;
      const journal = scanManagedSessionJournal(
        await fs.readFile(options.transcriptPath),
        options.sessionKey,
      );
      const committed = [...journal.transactions.values()].find(
        (transaction) => transaction.receipt.commandId === 'recorder:digest',
      );
      expect(committed?.contentDigest).toBe(expected);
      expect(diagnostics !== undefined).toBe(collect);
    },
  );
  it('keeps operation observations while trimming optional Unicode paths to the source budget', async () => {
    const { session } = await setup();
    const facts = Array.from({ length: 90 }, (_, ordinal) => ({
      ...structuredClone(fixture.evidence.observations[0]),
      ordinal,
      invocationId: managedInvocationId(
        session.authority.sessionHeader.sessionKey,
        'capacity',
        ordinal,
      ),
      assistantMessageId: 'capacity',
      functionCallId: `call-${ordinal}`,
      file: {
        operation: 'read' as const,
        path: '目录/'.repeat(300),
        cwdRelative: '.',
      },
    }));
    const ref = await getManagedExecutionDiagnostics(
      session.authority,
    )!.publish('message:capacity', facts);
    const bytes = await session.resources.read(ref);
    const evidence = parseManagedExecutionEvidence(bytes);
    expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
    expect(evidence.observations).toHaveLength(90);
    expect(evidence.omittedObservationCount).toBe(0);
    expect(evidence.coverageReasons).toContain('file_path_unavailable');
    expect(
      evidence.observations.every((fact) => fact.file?.operation === 'read'),
    ).toBe(true);
  });
  it('preserves explicit execution evidence independently of omitted delivery', () => {
    const fact = structuredClone(fixture.evidence.observations[0]);
    fact.execution = 'unknown';
    fact.delivery = 'unknown';
    fact.capture = 'unknown';
    observeManagedToolResponse(fact, {
      executionStatus: 'success',
      outputTruncated: true,
      capture: { captureStatus: 'complete' },
    });
    expect([fact.execution, fact.delivery, fact.capture]).toEqual([
      'success',
      'partial',
      'complete',
    ]);
    observeManagedToolResponse(fact, { outputOmitted: true });
    expect([fact.execution, fact.delivery]).toEqual(['success', 'unavailable']);
  });
  it('reads flattened Shell capture facts without certifying truncated delivery', () => {
    const fact = structuredClone(fixture.evidence.observations[0]);
    fact.execution = 'unknown';
    fact.capture = 'unknown';
    fact.delivery = 'pending';
    observeManagedToolResponse(fact, {
      executionStatus: 'success',
      captureStatus: 'partial',
      previewTruncated: true,
    });
    expect([fact.execution, fact.capture, fact.delivery]).toEqual([
      'success',
      'partial',
      'partial',
    ]);
  });
  it('preserves legacy committed messages when collection is enabled later', async () => {
    const { session, record } = await setup(false);
    await session.sink.write(record('legacy'));
    const before = session.authority.committedSequence;
    await enableManagedExecutionDiagnostics(session);
    await session.sink.write(record('legacy'));
    expect(session.authority.committedSequence).toBe(before);
    expect(
      session.authority.committedEvent('message:legacy')?.payload[
        'diagnosticsRef'
      ],
    ).toBeUndefined();
    await session.sink.write(record('new'));
    const latest = session.authority.committedEvent('message:new')!;
    const evidence = parseManagedExecutionEvidence(
      await session.resources.read(
        assertManagedSessionDurableRef(
          latest.payload['diagnosticsRef'],
          'diagnosticsRef',
        ),
      ),
    );
    expect(evidence.startEventId).toBe('message:new');
    expect(evidence.coverageReasons).toContain('history_before_collection');
  });
  it('shares UTF-8 invocation identity and a closed leaf contract with Java', () => {
    expect(
      managedInvocationId(
        fixture.sessionKey,
        fixture.messageId,
        fixture.ordinal,
      ),
    ).toBe(fixture.invocationId);
    expect(
      parseManagedExecutionEvidence(
        Buffer.from(JSON.stringify(fixture.evidence)),
      ),
    ).toEqual(fixture.evidence);
    expect(() =>
      parseManagedExecutionEvidence(
        Buffer.from(
          JSON.stringify({ ...fixture.evidence, credential: 'private' }),
        ),
      ),
    ).toThrow();
    const invalid = structuredClone(fixture.evidence);
    invalid.observations[0].file!.path = '../private';
    expect(() =>
      parseManagedExecutionEvidence(Buffer.from(JSON.stringify(invalid))),
    ).toThrow();
  });

  it('counts occurrences by function-call ordinal and freezes replay evidence', async () => {
    const { session, record } = await setup();
    await session.sink.write(record('first'));
    const sequence = session.authority.committedSequence;
    await session.sink.write(record('first'));
    expect(session.authority.committedSequence).toBe(sequence);
    await session.sink.write(record('second'));
    const events = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'message.committed');
    const bodies = await Promise.all(
      events.map(async (event) =>
        parseManagedExecutionEvidence(
          await session.resources.read(
            assertManagedSessionDurableRef(
              event.payload['diagnosticsRef'],
              'diagnosticsRef',
            ),
          ),
        ),
      ),
    );
    expect(bodies[0].observations[0].ordinal).toBe(0);
    expect(bodies[0].observations[0].invocationId).not.toBe(
      bodies[1].observations[0].invocationId,
    );
    expect(bodies[0].epochId).toBe(bodies[1].epochId);
    const changed = record('first');
    changed.message!.parts![1].functionCall!.name = 'edit';
    await expect(session.sink.write(changed)).rejects.toThrow();
  });

  it('restores the collection epoch and request association after reopening', async () => {
    const { session, options, record } = await setup();
    await session.sink.write(record('first'));
    const old = session.authority.lastEventOfKind('message.committed')!;
    const before = parseManagedExecutionEvidence(
      await session.resources.read(
        assertManagedSessionDurableRef(
          old.payload['diagnosticsRef'],
          'diagnosticsRef',
        ),
      ),
    );
    await session.close();
    sessions.splice(sessions.indexOf(session), 1);
    const restored = await openManagedSession(options);
    sessions.push(restored);
    await enableManagedExecutionDiagnostics(restored);
    expect(
      getManagedExecutionDiagnostics(restored.authority)?.observation('reused')
        ?.assistantMessageId,
    ).toBe('first');
    await restored.sink.write(record('second'));
    const latest = restored.authority.lastEventOfKind('message.committed')!;
    const after = parseManagedExecutionEvidence(
      await restored.resources.read(
        assertManagedSessionDurableRef(
          latest.payload['diagnosticsRef'],
          'diagnosticsRef',
        ),
      ),
    );
    expect(after.epochId).toBe(before.epochId);
    expect(after.startEventId).toBe(before.startEventId);
  });

  it('attaches the same source contract to atomic final model output', async () => {
    const { session, record } = await setup();
    await new ManagedHookActivationController(session).runTurn(
      'turn-1',
      async (scope) => {
        const finish = await scope.beginMainAttempt('model');
        await finish(true, [], record('final'));
        await finish(true, [], record('final'));
      },
    );
    const events = session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    );
    const final = events.find((event) => event.eventId === 'message:final')!;
    expect(final.payload['diagnosticsRef']).toBeDefined();
    expect(
      events.find((event) => event.sequence === final.sequence - 1)?.kind,
    ).toBe('model.attempt');
    expect(
      events.filter((event) => event.eventId === 'message:final'),
    ).toHaveLength(1);
  });
});
