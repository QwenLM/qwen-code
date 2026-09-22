/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { LlmChat, ORPHAN_TOOL_USE_REPAIR_REASON } from '../core/llm-chat.js';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { Content, GenerateContentResponse } from '@google/genai';
import { CompressionStatus } from '../core/turn.js';
import { Storage } from './storage.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { getSessionWriterLockPath } from '../services/session-writer-lease.js';
import {
  clearSessionTranscriptIndexCacheEntriesForTest,
  encodeSessionTranscriptCursor,
  SessionTranscriptReader,
  SessionTranscriptSnapshotUnavailableError,
} from '../services/session-transcript-reader.js';
import { readManagedSessionRecords } from '../managed-runtime/managed-session-message-projection.js';
import type { ManagedSession } from '../managed-runtime/managed-session-assembly.js';
import { parseHarnessCheckpointV1 } from '../managed-runtime/managed-harness-checkpoint.js';
import { LocalJsonlManagedSessionJournalStore } from '../managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '../managed-runtime/managed-session-resources.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
} from '../managed-runtime/managed-session-records.js';
import {
  managedRuntimeDispatchGate,
  resetManagedRuntimeDispatchGatesForTest,
} from '../managed-runtime/managed-runtime-dispatch-gate.js';
import {
  isManagedSessionTranscriptSync,
  localManagedSessionKey,
  managedSessionResourceRoot,
} from '../utils/sessionStorageUtils.js';

const sessionId = '550e8400-e29b-41d4-a716-4466554400aa';
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  resetManagedRuntimeDispatchGatesForTest();
  vi.restoreAllMocks();
});

interface Fixture {
  config: Config;
  runtimeBaseDir: string;
  transcriptPath: string;
}

type Activate = (options: { managedSessionLog: boolean }) => Promise<Fixture>;

async function withWorkspace(run: (activate: Activate) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-log-'));
  temporaryDirectories.add(root);
  const workspace = path.join(root, 'workspace');
  const runtimeBaseDir = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    await run(async (options) => {
      const params: ConfigParameters = {
        sessionId,
        cwd: workspace,
        targetDir: workspace,
        debugMode: false,
        model: 'qwen3-coder-plus',
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        managedToolSessionFactory: () => {
          throw new Error('must not create tools');
        },
        ...(options.managedSessionLog
          ? { managedSessionLogEnabled: true }
          : {}),
      };
      const config = new Config(params);
      const transcriptPath = config.getTranscriptPath();
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      ).mockResolvedValue(undefined);
      await config.initialize({ sessionExecutionEngine: 'managed' });
      return { config, runtimeBaseDir, transcriptPath };
    });
  });
}

async function transcriptRecords(
  transcriptPath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(transcriptPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function checkpointPayloads(
  records: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return records
    .filter((entry) => {
      const body = entry['managedSession'] as
        | Record<string, unknown>
        | undefined;
      return body?.['kind'] === 'checkpoint.committed';
    })
    .map(
      (entry) =>
        (entry['managedSession'] as Record<string, unknown>)[
          'payload'
        ] as Record<string, unknown>,
    );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function readCheckpoint(
  fixture: Fixture,
  payload: Record<string, unknown>,
) {
  const stateRef = payload['stateRef'] as {
    kind: string;
    resourceId: string;
  };
  const bytes = await readFile(
    path.join(
      managedSessionResourceRoot(fixture.runtimeBaseDir, sessionId),
      stateRef.kind,
      stateRef.resourceId,
    ),
  );
  return parseHarnessCheckpointV1(bytes);
}

async function readCheckpointPhase(
  fixture: Fixture,
  payload: Record<string, unknown>,
): Promise<string> {
  return (await readCheckpoint(fixture, payload)).continuation.phase;
}

function stubStoppedModelStream(
  config: Config,
  beforeGenerate: () => Promise<void>,
) {
  const generateContentStream = vi.fn(async () => {
    await beforeGenerate();
    return (async function* () {
      yield {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
      } as unknown as GenerateContentResponse;
    })();
  });
  vi.spyOn(config, 'getContentGenerator').mockReturnValue({
    generateContent: vi.fn(),
    generateContentStream,
    embedContent: vi.fn(),
  } as unknown as ContentGenerator);
  vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
    model: 'qwen3-coder-plus',
    authType: 'openai',
  } as ReturnType<Config['getContentGeneratorConfig']>);
  return generateContentStream;
}

describe('managed session log activation', () => {
  it('routes the authoritative journal through an injected hosted store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-store-'));
    temporaryDirectories.add(root);
    const workspace = path.join(root, 'workspace');
    const runtimeBaseDir = path.join(root, 'runtime');
    const remoteBaseDir = path.join(root, 'remote-store');
    await mkdir(workspace, { recursive: true });

    await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
      const sessionKey = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId,
      };
      const remoteTranscriptPath = path.join(remoteBaseDir, 'authority.jsonl');
      const config = new Config({
        sessionId,
        cwd: workspace,
        targetDir: workspace,
        debugMode: false,
        model: 'qwen3-coder-plus',
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        managedSessionLogEnabled: true,
        managedToolSessionFactory: () => {
          throw new Error('must not create tools');
        },
        managedSessionStore: {
          mode: 'create',
          sessionKey,
          journalStore: new LocalJsonlManagedSessionJournalStore({
            runtimeBaseDir: remoteBaseDir,
            sessionId,
            transcriptPath: remoteTranscriptPath,
          }),
          resourceStore: LocalManagedSessionResourceStore.create({
            runtimeBaseDir: remoteBaseDir,
            sessionKey,
          }),
        },
      });
      const localTranscriptPath = config.getTranscriptPath();
      await mkdir(path.dirname(localTranscriptPath), { recursive: true });
      vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      ).mockResolvedValue(undefined);

      await config.initialize({ sessionExecutionEngine: 'managed' });
      const recorder = config.getChatRecordingService()!;
      recorder.recordUserMessage('persist remotely');
      await recorder.flush();

      await expect(stat(localTranscriptPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(isManagedSessionTranscriptSync(remoteTranscriptPath)).toBe(true);
      expect(
        (await transcriptRecords(remoteTranscriptPath)).map(
          (record) => record['subtype'],
        ),
      ).toEqual(
        expect.arrayContaining([
          MANAGED_SESSION_HEADER_SUBTYPE,
          MANAGED_SESSION_EVENT_SUBTYPE,
          MANAGED_SESSION_COMMIT_SUBTYPE,
        ]),
      );

      await config.closeSessionWriter();
      const remoteLock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(remoteBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(remoteLock['state']).toBe('sealed');
    });
  });

  it('seals an injected hosted store when recorder activation fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-store-'));
    temporaryDirectories.add(root);
    const workspace = path.join(root, 'workspace');
    const runtimeBaseDir = path.join(root, 'runtime');
    const remoteBaseDir = path.join(root, 'remote-store');
    await mkdir(workspace, { recursive: true });

    await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
      const sessionKey = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        sessionId,
      };
      const closeStore = vi.fn<() => Promise<void>>().mockResolvedValue();
      const config = new Config({
        sessionId,
        cwd: workspace,
        targetDir: workspace,
        debugMode: false,
        model: 'qwen3-coder-plus',
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        managedSessionLogEnabled: true,
        managedToolSessionFactory: () => {
          throw new Error('must not create tools');
        },
        managedSessionStore: {
          mode: 'create',
          sessionKey,
          journalStore: new LocalJsonlManagedSessionJournalStore({
            runtimeBaseDir: remoteBaseDir,
            sessionId,
            transcriptPath: path.join(remoteBaseDir, 'authority.jsonl'),
          }),
          resourceStore: LocalManagedSessionResourceStore.create({
            runtimeBaseDir: remoteBaseDir,
            sessionKey,
          }),
          close: closeStore,
        },
      });
      await mkdir(path.dirname(config.getTranscriptPath()), {
        recursive: true,
      });
      vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      ).mockResolvedValue(undefined);
      vi.spyOn(
        config.getChatRecordingService()!,
        'activate',
      ).mockImplementation(() => {
        throw new Error('recorder activation failed');
      });

      await expect(
        config.initialize({ sessionExecutionEngine: 'managed' }),
      ).rejects.toThrow('recorder activation failed');
      expect(closeStore).toHaveBeenCalledOnce();

      const remoteLock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(remoteBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(remoteLock['state']).toBe('sealed');
    });
  });

  it('records a managed session through the authority and seals on close', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();

      const records = await transcriptRecords(fixture.transcriptPath);
      const subtypes = records.map((entry) => entry['subtype']);

      // The authority writes the engine record first so maintenance guards see
      // a managed session, then the header that makes the log authoritative.
      expect(subtypes[0]).toBe('session_execution_engine');
      expect(
        (records[0]['systemPayload'] as Record<string, unknown>)['engine'],
      ).toBe('managed');
      expect(subtypes[1]).toBe(MANAGED_SESSION_HEADER_SUBTYPE);
      expect(isManagedSessionTranscriptSync(fixture.transcriptPath)).toBe(true);
      expect(fixture.config.getSessionExecutionEngine()).toBe('managed');

      // The user message reached the log as a Managed event, not as a raw
      // legacy line: it is inside a committed transaction.
      expect(subtypes).toContain(MANAGED_SESSION_EVENT_SUBTYPE);
      expect(subtypes).toContain(MANAGED_SESSION_COMMIT_SUBTYPE);
      expect(subtypes).not.toContain(undefined);

      await fixture.config.closeSessionWriter();

      // Releasing would delete the lock and leave the Managed log unguarded.
      const lock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(fixture.runtimeBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(lock['state']).toBe('sealed');
    });
  });

  it('submits a before_model checkpoint before a model request, not on open', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();

      const before = await transcriptRecords(fixture.transcriptPath);
      expect(
        before.some((entry) => {
          const body = entry['managedSession'] as
            | Record<string, unknown>
            | undefined;
          return body?.['kind'] === 'checkpoint.committed';
        }),
      ).toBe(false);

      await fixture.config.ensureManagedHarnessRunnable();

      const after = await transcriptRecords(fixture.transcriptPath);
      const checkpoints = after.filter((entry) => {
        const body = entry['managedSession'] as
          | Record<string, unknown>
          | undefined;
        return body?.['kind'] === 'checkpoint.committed';
      });
      expect(checkpoints).toHaveLength(1);
      expect(
        (checkpoints[0]['managedSession'] as Record<string, unknown>)[
          'payload'
        ] as Record<string, unknown>,
      ).toMatchObject({ boundary: null });

      await fixture.config.closeSessionWriter();
    });
  });

  it('sends the Agent model stream only after a before_model checkpoint', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();
      expect(
        checkpointPayloads(await transcriptRecords(fixture.transcriptPath)),
      ).toHaveLength(0);

      const generateContentStream = stubStoppedModelStream(
        fixture.config,
        async () => {
          const during = checkpointPayloads(
            await transcriptRecords(fixture.transcriptPath),
          );
          expect(during).toHaveLength(1);
          expect(during[0]).toMatchObject({ boundary: null });
        },
      );

      const chat = new LlmChat(fixture.config, {});
      const stream = await chat.sendMessageStream(
        'qwen3-coder-plus',
        { message: 'summarise the docs' },
        'prompt-h08',
      );
      for await (const _ of stream) {
        /* consume the Agent stream */
      }

      expect(generateContentStream).toHaveBeenCalledOnce();

      recorder.recordTurnResult({
        promptId: 'prompt-h08',
        state: 'completed',
        endedAt: Date.now(),
        stopReason: 'end_turn',
      });
      await recorder.flush();

      const after = await transcriptRecords(fixture.transcriptPath);
      const events = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const checkpoints = checkpointPayloads(after);
      const settled = events.filter(
        (event) => event['kind'] === 'turn.settled',
      );
      expect(checkpoints).toHaveLength(2);
      expect(settled).toHaveLength(1);
      expect(checkpoints[0]['boundary']).toBeNull();
      expect(checkpoints[1]['boundary']).toBe('turn_complete');

      await fixture.config.closeSessionWriter();
    });
  });

  it('sends the Agent model stream after a cold reopen only once a before_model checkpoint exists', async () => {
    await withWorkspace(async (activate) => {
      const first = await activate({ managedSessionLog: true });
      first.config
        .getChatRecordingService()!
        .recordUserMessage('summarise the docs');
      await first.config.closeSessionWriter();
      expect(
        checkpointPayloads(await transcriptRecords(first.transcriptPath)),
      ).toHaveLength(0);

      const fixture = await activate({ managedSessionLog: true });
      expect(
        checkpointPayloads(await transcriptRecords(fixture.transcriptPath)),
      ).toHaveLength(0);

      const generateContentStream = stubStoppedModelStream(
        fixture.config,
        async () => {
          const during = checkpointPayloads(
            await transcriptRecords(fixture.transcriptPath),
          );
          expect(during).toHaveLength(1);
          expect(during[0]).toMatchObject({ boundary: null });
        },
      );

      const chat = new LlmChat(fixture.config, {});
      const stream = await chat.sendMessageStream(
        'qwen3-coder-plus',
        { message: 'summarise the docs' },
        'prompt-h08-cold',
      );
      for await (const _ of stream) {
        /* consume the Agent stream */
      }

      expect(generateContentStream).toHaveBeenCalledOnce();
      await fixture.config.closeSessionWriter();
    });
  });

  it('commits a turn-complete checkpoint with the settled turn, not on open', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();

      recorder.recordTurnResult({
        promptId: 'turn-1',
        state: 'completed',
        endedAt: Date.now(),
        stopReason: 'end_turn',
      });
      await recorder.flush();

      const after = await transcriptRecords(fixture.transcriptPath);
      const events = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const checkpoints = events.filter(
        (event) => event['kind'] === 'checkpoint.committed',
      );
      const settled = events.filter(
        (event) => event['kind'] === 'turn.settled',
      );
      expect(checkpoints).toHaveLength(2);
      expect(settled).toHaveLength(1);
      expect(
        (checkpoints[0]['payload'] as Record<string, unknown>)['boundary'],
      ).toBeNull();
      expect(
        (checkpoints[1]['payload'] as Record<string, unknown>)['boundary'],
      ).toBe('turn_complete');
      expect(
        (checkpoints[1]['payload'] as Record<string, unknown>)[
          'previousCheckpointId'
        ],
      ).toBe(
        (checkpoints[0]['payload'] as Record<string, unknown>)['checkpointId'],
      );

      const markers = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_COMMIT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const settleMarker = markers.find(
        (marker) => marker['operation'] === 'settleTurn',
      );
      expect(settleMarker?.['eventCount']).toBe(2);
      expect(settleMarker?.['lastSequence']).toBe(
        (settleMarker?.['firstSequence'] as number) + 1,
      );

      await fixture.config.closeSessionWriter();
    });
  });

  it('replaces the Harness activation after a turn-complete checkpoint', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const rebuilt: unknown[][] = [];
      const llmClient = fixture.config.getLlmClient();
      const startNewSession = vi.spyOn(fixture.config, 'startNewSession');
      const closeSessionWriter = vi.spyOn(fixture.config, 'closeSessionWriter');
      vi.spyOn(llmClient, 'isInitialized').mockReturnValue(true);
      vi.spyOn(llmClient, 'rebuildChatFromDurableHistory').mockImplementation(
        async (history) => {
          rebuilt.push(history);
        },
      );
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();
      expect(rebuilt).toHaveLength(0);
      recorder.recordTurnResult({
        promptId: 'turn-1',
        state: 'completed',
        endedAt: Date.now(),
        stopReason: 'end_turn',
      });
      await recorder.flush();

      await fixture.config.ensureManagedHarnessRunnable();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({ text: 'first turn' }),
            ]),
          }),
        ]),
      );
      await fixture.config.ensureManagedHarnessRunnable();
      expect(rebuilt).toHaveLength(1);
      recorder.recordUserMessage('second turn');
      await recorder.flush();

      const after = await transcriptRecords(fixture.transcriptPath);
      const events = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const checkpoints = events.filter(
        (event) => event['kind'] === 'checkpoint.committed',
      );
      expect(checkpoints).toHaveLength(2);
      expect(
        (checkpoints[1]['payload'] as Record<string, unknown>)['boundary'],
      ).toBe('turn_complete');

      const activations = events.filter(
        (event) => event['kind'] === 'activation.changed',
      );
      expect(
        activations.map(
          (event) =>
            (event['payload'] as Record<string, unknown>)['phase'] as string,
        ),
      ).toEqual(['active', 'released', 'active']);
      const firstActive = activations[0]['payload'] as Record<string, unknown>;
      const secondActive = activations[2]['payload'] as Record<string, unknown>;
      expect(secondActive['activationId']).not.toBe(
        firstActive['activationId'],
      );
      expect(secondActive['epoch']).toBe(2);

      const messages = events.filter(
        (event) => event['kind'] === 'message.committed',
      );
      expect(
        (messages[messages.length - 1]?.['subject'] as Record<string, unknown>)[
          'activationId'
        ],
      ).toBe(secondActive['activationId']);

      expect(fixture.config.getLlmClient()).toBe(llmClient);
      expect(startNewSession).not.toHaveBeenCalled();
      expect(closeSessionWriter).not.toHaveBeenCalled();

      await fixture.config.closeSessionWriter();
    });
  });

  it('waits for queued records before replacing the Harness activation', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();
      recorder.recordTurnResult({
        promptId: 'turn-1',
        state: 'completed',
        endedAt: Date.now(),
        stopReason: 'end_turn',
      });
      await recorder.flush();

      const managedSession = (
        fixture.config as unknown as { managedSession?: ManagedSession }
      ).managedSession;
      if (!managedSession) throw new Error('Managed session was not opened.');

      const recordPublishStarted = deferred();
      const releaseRecordPublish = deferred();
      const replacementStarted = deferred();
      const originalPublish = managedSession.resources.publish.bind(
        managedSession.resources,
      );
      vi.spyOn(managedSession.resources, 'publish').mockImplementation(
        async (kind, body) => {
          const ref = await originalPublish(kind, body);
          if (kind === 'managed-message') {
            const record = JSON.parse(body.toString('utf8')) as ChatRecord;
            const text = record.message?.parts
              ?.map((part) => part.text ?? '')
              .join('');
            if (text === 'second turn') {
              recordPublishStarted.resolve();
              await releaseRecordPublish.promise;
            }
          }
          return ref;
        },
      );
      const originalReplace =
        managedSession.replaceActivation.bind(managedSession);
      const replaceActivation = vi
        .spyOn(managedSession, 'replaceActivation')
        .mockImplementation(async () => {
          replacementStarted.resolve();
          return originalReplace();
        });

      recorder.recordUserMessage('second turn');
      await recordPublishStarted.promise;
      const ensureRunnable = fixture.config.ensureManagedHarnessRunnable();
      const replacedWhileRecordWasPending = await Promise.race([
        replacementStarted.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      releaseRecordPublish.resolve();
      const [ensureResult, flushResult] = await Promise.allSettled([
        ensureRunnable,
        recorder.flush(),
      ]);

      expect(replacedWhileRecordWasPending).toBe(false);
      expect(ensureResult.status).toBe('fulfilled');
      expect(flushResult.status).toBe('fulfilled');
      expect(replaceActivation).toHaveBeenCalledOnce();
      await expect(recorder.assertCanStartTurn()).resolves.toBeUndefined();

      await fixture.config.closeSessionWriter();
    });
  });

  it('persists a durable approval wait without replacing the Harness handle', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('needs permission');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();

      await fixture.config.commitManagedDurableWait({
        requestId: 'fc-wait-1',
        kind: 'execute',
        source: 'tool_call',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        invocation: { toolCallId: 'fc-wait-1', kind: 'execute' },
      });

      const waiting = checkpointPayloads(
        await transcriptRecords(fixture.transcriptPath),
      );
      expect(waiting).toHaveLength(2);
      expect(waiting[1]).toMatchObject({ boundary: 'durable_wait' });
      expect(await readCheckpointPhase(fixture, waiting[1])).toBe(
        'await_action',
      );

      await expect(
        fixture.config.ensureManagedHarnessRunnable(),
      ).rejects.toMatchObject({ reason: 'invalid_state' });
      await expect(
        fixture.config.resolveManagedDurableWait({
          requestId: 'fc-wait-1',
          outcome: 'decided',
          body: { optionId: 'allow' },
        }),
      ).resolves.toBeUndefined();
      await fixture.config.ensureManagedHarnessRunnable();

      const after = await transcriptRecords(fixture.transcriptPath);
      const payloads = checkpointPayloads(after);
      expect(payloads).toHaveLength(3);
      expect(payloads[2]['boundary']).toBeNull();
      expect(await readCheckpointPhase(fixture, payloads[2])).toBe(
        'model_output_committed',
      );

      const events = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const actions = events.filter(
        (event) => event['kind'] === 'action.changed',
      );
      expect(
        actions.map(
          (event) =>
            (event['payload'] as Record<string, unknown>)['state'] as string,
        ),
      ).toEqual(['requested', 'decided']);
      const lastCheckpoint = events
        .filter((event) => event['kind'] === 'checkpoint.committed')
        .at(-1);
      expect(actions[1]['sequence'] as number).toBeLessThan(
        lastCheckpoint?.['sequence'] as number,
      );
      expect(
        (actions[1]['payload'] as Record<string, unknown>)['decisionRef'],
      ).not.toBeNull();
      expect(
        events
          .filter((event) => event['kind'] === 'activation.changed')
          .map(
            (event) =>
              (event['payload'] as Record<string, unknown>)['phase'] as string,
          ),
      ).toEqual(['active']);

      await fixture.config.closeSessionWriter();
    });
  });

  it('rebuilds a still-requested approval wait after the original waiter is gone', async () => {
    await withWorkspace(async (activate) => {
      const options = [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      ];
      const invocation = { toolCallId: 'fc-wait-1', kind: 'execute' };
      const first = await activate({ managedSessionLog: true });
      first.config
        .getChatRecordingService()!
        .recordUserMessage('needs permission');
      await first.config.getChatRecordingService()!.flush();
      await first.config.ensureManagedHarnessRunnable();
      await first.config.commitManagedDurableWait({
        requestId: 'fc-wait-1',
        kind: 'execute',
        source: 'tool_call',
        options,
        invocation,
      });
      await expect(
        first.config.readPendingManagedApprovalWait(),
      ).resolves.toMatchObject({
        requestId: 'fc-wait-1',
        kind: 'execute',
        source: 'tool_call',
        options,
        invocation,
      });
      await first.config.closeSessionWriter();

      const second = await activate({ managedSessionLog: true });
      await expect(
        second.config.readPendingManagedApprovalWait(),
      ).resolves.toMatchObject({
        requestId: 'fc-wait-1',
        kind: 'execute',
        source: 'tool_call',
        options,
        invocation,
      });
      await second.config.resolveManagedDurableWait({
        requestId: 'fc-wait-1',
        outcome: 'decided',
        body: { optionId: 'allow' },
      });
      await expect(
        second.config.readPendingManagedApprovalWait(),
      ).resolves.toBeNull();
      await second.config.ensureManagedHarnessRunnable();
      await second.config.closeSessionWriter();
    });
  });

  it('resolves a detached approval wait on a successor handle', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('needs permission');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();
      await fixture.config.commitManagedDurableWait({
        requestId: 'fc-wait-1',
        kind: 'execute',
        source: 'tool_call',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        invocation: { toolCallId: 'fc-wait-1', kind: 'execute' },
      });
      await fixture.config.detachManagedHarnessWait();
      await expect(
        fixture.config.ensureManagedHarnessRunnable(),
      ).rejects.toMatchObject({ reason: 'invalid_state' });
      await expect(
        fixture.config.readPendingManagedApprovalWait(),
      ).resolves.toMatchObject({ requestId: 'fc-wait-1' });
      await fixture.config.resolveManagedDurableWait({
        requestId: 'fc-wait-1',
        outcome: 'decided',
        body: { optionId: 'allow' },
      });
      await expect(
        fixture.config.readPendingManagedApprovalWait(),
      ).resolves.toBeNull();
      await fixture.config.ensureManagedHarnessRunnable();
      await fixture.config.closeSessionWriter();
    });
  });

  it('persists admitted Runtime work without replacing the Harness handle', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('run a remote tool');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();

      await fixture.config.commitManagedAwaitRuntime({
        functionCallId: 'fc-rt-1',
        executionCallId: 'ex-rt-1',
        invocationBindingId: 'bind-rt-1',
        modelMessageId: 'msg-rt-1',
      });

      const waiting = checkpointPayloads(
        await transcriptRecords(fixture.transcriptPath),
      );
      expect(waiting).toHaveLength(2);
      expect(waiting[1]).toMatchObject({ boundary: 'durable_wait' });
      expect(await readCheckpointPhase(fixture, waiting[1])).toBe(
        'await_runtime',
      );
      await expect(
        fixture.config.ensureManagedHarnessRunnable(),
      ).rejects.toMatchObject({ reason: 'invalid_state' });
      expect(
        fixture.config.shouldRetainManagedRuntimeInvocation('ex-rt-1'),
      ).toBe(false);

      const sessionKey = localManagedSessionKey(
        fixture.config.getProjectRoot(),
        sessionId,
      );
      managedRuntimeDispatchGate(sessionKey).handoff('ex-rt-1');
      expect(
        fixture.config.shouldRetainManagedRuntimeInvocation('ex-rt-1'),
      ).toBe(true);

      await expect(
        fixture.config.resolveManagedAwaitRuntime({
          functionCallId: 'fc-rt-1',
          executionCallId: 'ex-rt-1',
          outcome: 'completed',
          body: { output: 'ok' },
        }),
      ).resolves.toBeUndefined();
      await fixture.config.ensureManagedHarnessRunnable();

      const after = await transcriptRecords(fixture.transcriptPath);
      const payloads = checkpointPayloads(after);
      expect(payloads).toHaveLength(3);
      expect(payloads[2]['boundary']).toBeNull();
      expect(await readCheckpointPhase(fixture, payloads[2])).toBe(
        'results_ready',
      );
      expect(
        fixture.config.shouldRetainManagedRuntimeInvocation('ex-rt-1'),
      ).toBe(false);

      const events = after
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      expect(
        events
          .filter((event) => event['kind'] === 'activation.changed')
          .map(
            (event) =>
              (event['payload'] as Record<string, unknown>)['phase'] as string,
          ),
      ).toEqual(['active']);

      await fixture.config.closeSessionWriter();
    });
  });

  it('sends the original Runtime receipt on the next model request instead of a synthesized failure', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('run a remote tool');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();
      await fixture.config.commitManagedAwaitRuntime({
        functionCallId: 'fc-rt-1',
        executionCallId: 'ex-rt-1',
        invocationBindingId: 'bind-rt-1',
        modelMessageId: 'msg-rt-1',
      });
      await fixture.config.resolveManagedAwaitRuntime({
        functionCallId: 'fc-rt-1',
        executionCallId: 'ex-rt-1',
        outcome: 'completed',
        body: { output: 'ok' },
        functionResponse: {
          id: 'fc-rt-1',
          name: 'remote_tool',
          response: { output: 'original runtime receipt' },
        },
      });

      let captured: Content[] | undefined;
      const generateContentStream = vi.fn(
        async (request: { contents: Content[] }) => {
          captured = request.contents;
          return (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'used original' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })();
        },
      );
      vi.spyOn(fixture.config, 'getContentGenerator').mockReturnValue({
        generateContent: vi.fn(),
        generateContentStream,
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);
      vi.spyOn(fixture.config, 'getContentGeneratorConfig').mockReturnValue({
        model: 'qwen3-coder-plus',
        authType: 'openai',
      } as ReturnType<Config['getContentGeneratorConfig']>);

      const chat = new LlmChat(fixture.config, {}, [
        {
          role: 'user',
          parts: [{ text: 'run a remote tool' }],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-rt-1',
                name: 'remote_tool',
                args: {},
              },
            },
          ],
        },
      ]);
      const stream = await chat.sendMessageStream(
        'qwen3-coder-plus',
        { message: 'continue' },
        'prompt-h04',
      );
      for await (const _ of stream) {
        /* consume the Agent stream */
      }

      expect(generateContentStream).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(captured);
      expect(serialized).toContain('original runtime receipt');
      expect(serialized).not.toContain(ORPHAN_TOOL_USE_REPAIR_REASON);
      expect(
        captured
          ?.flatMap((content) => content.parts ?? [])
          .find((part) => part.functionResponse?.id === 'fc-rt-1')
          ?.functionResponse?.response,
      ).toEqual({ output: 'original runtime receipt' });

      const payloads = checkpointPayloads(
        await transcriptRecords(fixture.transcriptPath),
      );
      const latest = await readCheckpoint(
        fixture,
        payloads[payloads.length - 1]!,
      );
      expect(latest.continuation.phase).toBe('results_ready');
      expect(latest.tools?.items[0]?.consumed).toBe(true);
      expect(() =>
        managedRuntimeDispatchGate(
          localManagedSessionKey(fixture.config.getProjectRoot(), sessionId),
        ).claim('ex-rt-1'),
      ).toThrow(/already dispatched/);

      await fixture.config.closeSessionWriter();
    });
  });

  it('marks an already-present Runtime receipt consumed without replacing it', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('run a remote tool');
      await recorder.flush();
      await fixture.config.ensureManagedHarnessRunnable();
      await fixture.config.commitManagedAwaitRuntime({
        functionCallId: 'fc-rt-1',
        executionCallId: 'ex-rt-1',
        invocationBindingId: 'bind-rt-1',
        modelMessageId: 'msg-rt-1',
      });
      await fixture.config.resolveManagedAwaitRuntime({
        functionCallId: 'fc-rt-1',
        executionCallId: 'ex-rt-1',
        outcome: 'completed',
        functionResponse: {
          id: 'fc-rt-1',
          name: 'remote_tool',
          response: { output: 'original runtime receipt' },
        },
      });

      let captured: Content[] | undefined;
      const generateContentStream = vi.fn(
        async (request: { contents: Content[] }) => {
          captured = request.contents;
          return (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'used original' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })();
        },
      );
      vi.spyOn(fixture.config, 'getContentGenerator').mockReturnValue({
        generateContent: vi.fn(),
        generateContentStream,
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);
      vi.spyOn(fixture.config, 'getContentGeneratorConfig').mockReturnValue({
        model: 'qwen3-coder-plus',
        authType: 'openai',
      } as ReturnType<Config['getContentGeneratorConfig']>);

      const chat = new LlmChat(fixture.config, {}, [
        {
          role: 'user',
          parts: [{ text: 'run a remote tool' }],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-rt-1',
                name: 'remote_tool',
                args: {},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-rt-1',
                name: 'remote_tool',
                response: { output: 'original runtime receipt' },
              },
            },
          ],
        },
      ]);
      const stream = await chat.sendMessageStream(
        'qwen3-coder-plus',
        { message: 'continue' },
        'prompt-h04-live',
      );
      for await (const _ of stream) {
        /* consume the Agent stream */
      }

      expect(generateContentStream).toHaveBeenCalledOnce();
      expect(JSON.stringify(captured)).not.toContain(
        ORPHAN_TOOL_USE_REPAIR_REASON,
      );
      expect(
        captured
          ?.flatMap((content) => content.parts ?? [])
          .filter((part) => part.functionResponse?.id === 'fc-rt-1'),
      ).toHaveLength(1);

      const payloads = checkpointPayloads(
        await transcriptRecords(fixture.transcriptPath),
      );
      expect(
        (await readCheckpoint(fixture, payloads[payloads.length - 1]!)).tools
          ?.items[0]?.consumed,
      ).toBe(true);

      await fixture.config.closeSessionWriter();
    });
  });

  it('attributes records to the activation it installed and releases it', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      fixture.config.getChatRecordingService()!.recordUserMessage('first turn');
      await fixture.config.closeSessionWriter();

      const events = (await transcriptRecords(fixture.transcriptPath))
        .filter((entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((entry) => entry['managedSession'] as Record<string, unknown>);
      const activations = events.filter(
        (event) => event['kind'] === 'activation.changed',
      );

      // Installed on open, released on close: a reader can tell a holder that
      // finished from one that vanished.
      expect(
        activations.map(
          (event) =>
            (event['payload'] as Record<string, unknown>)['phase'] as string,
        ),
      ).toEqual(['active', 'released']);
      const installed = activations[0]['payload'] as Record<string, unknown>;
      const released = activations[1]['payload'] as Record<string, unknown>;
      expect(installed['workerId']).toBe(sessionId);
      expect(installed['installRef']).not.toBeNull();
      expect(released['boundaryRef']).not.toBeNull();

      // The message names that activation, so the fence accepted it as harness
      // output rather than as an untethered entry.
      const message = events.find(
        (event) => event['kind'] === 'message.committed',
      );
      expect(
        (message?.['subject'] as Record<string, unknown>)['activationId'],
      ).toBe(installed['activationId']);
    });
  });

  it('reopens a sealed managed session and continues the same log', async () => {
    await withWorkspace(async (activate) => {
      const first = await activate({ managedSessionLog: true });
      first.config.getChatRecordingService()!.recordUserMessage('first turn');
      await first.config.closeSessionWriter();
      const afterFirst = await transcriptRecords(first.transcriptPath);

      // A reader sees the conversation, not the wrapper records carrying it.
      const loaded = await first.config
        .getSessionService()
        .loadSession(sessionId);
      expect(loaded?.conversation.messages.map((entry) => entry.type)).toEqual([
        'user',
      ]);
      expect(loaded?.lastCompletedUuid).toBe(
        loaded?.conversation.messages[0].uuid,
      );

      // Taking over the seal, not colliding with it.
      const second = await activate({ managedSessionLog: true });
      second.config.getChatRecordingService()!.recordUserMessage('second turn');
      await second.config.closeSessionWriter();

      const reloaded = await second.config
        .getSessionService()
        .loadSession(sessionId);
      expect(
        reloaded?.conversation.messages.map((entry) => entry.type),
      ).toEqual(['user', 'user']);

      const records = await transcriptRecords(second.transcriptPath);
      const subtypes = records.map((entry) => entry['subtype']);
      expect(
        subtypes.filter((value) => value === MANAGED_SESSION_HEADER_SUBTYPE),
      ).toHaveLength(1);
      expect(
        subtypes.filter((value) => value === 'session_execution_engine'),
      ).toHaveLength(1);

      // The first session's records are still there, with the second appended.
      expect(records.slice(0, afterFirst.length)).toEqual(afterFirst);
      expect(
        subtypes.filter((value) => value === MANAGED_SESSION_EVENT_SUBTYPE)
          .length,
      ).toBeGreaterThan(
        afterFirst.filter(
          (entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE,
        ).length,
      );

      const lock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(second.runtimeBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(lock['state']).toBe('sealed');
    });
  });

  it('restores the goal a managed session recorded', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      const permit = {
        goalId: 'goal-1',
        revision: 1,
        turnId: 'turn-1',
      } as never;
      recorder.recordUserMessage('set the goal');
      recorder.recordAssistantTurn({
        model: 'qwen3-coder-plus',
        message: 'evidence for the goal',
        goalContext: permit,
      });
      await recorder.flush();
      const written = (await fixture.config
        .getSessionService()
        .loadSession(sessionId))!.conversation.messages;
      const [cursorRecord] = written;
      const goal = {
        goalId: 'goal-1',
        revision: 1,
        objective: 'verify the result',
        status: 'active',
        evidenceCursor: { recordId: cursorRecord.uuid },
        turnCount: 1,
        activeTimeMs: 0,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 2,
      };
      await recorder.recordGoalState('550e8400-e29b-41d4-a716-4466554400b1', {
        v: 2,
        cause: 'turn_finished',
        snapshot: { v: 2, activity: 'idle', goal },
      } as never);
      await fixture.config.closeSessionWriter();

      const projection = await fixture.config
        .getSessionService()
        .readRestoreProjection(sessionId, {
          replay: { kind: 'all', hideInheritedHistory: false },
        });

      // Reported as a recovery candidate, so a resumed session still has its
      // goal rather than silently losing it.
      expect(
        projection?.runtime.goalRecords.map((entry) => entry.subtype),
      ).toEqual(['goal_state']);
    });
  });

  it('restores a compacted managed session from its summary', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      recorder.recordChatCompression({
        info: {
          originalTokenCount: 100,
          newTokenCount: 10,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
      });
      // A shape the sink cannot map fails the flush, so reaching the assertions
      // is itself evidence the compaction was carried.
      await recorder.flush();
      await fixture.config.closeSessionWriter();

      const projection = await fixture.config
        .getSessionService()
        .readRestoreProjection(sessionId, {
          replay: { kind: 'all', hideInheritedHistory: false },
        });

      // Rebuilt from the compaction snapshot, not from the turn it replaced.
      expect(projection?.runtime.apiHistory).toEqual([
        { role: 'user', parts: [{ text: 'summary' }] },
      ]);
    });
  });

  it('restores a managed session from its projected records', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      recorder.recordUserMessage('second turn');
      await fixture.config.closeSessionWriter();

      const service = fixture.config.getSessionService();
      const projection = await service.readRestoreProjection(sessionId, {
        replay: { kind: 'all', hideInheritedHistory: false },
      });

      // The replay page is the conversation, not the wrapper records.
      expect(projection?.replay?.records.map((entry) => entry.type)).toEqual([
        'user',
        'user',
      ]);
      expect(projection?.replay?.hasMore).toBe(false);
      expect(projection?.runtime.apiHistory.length).toBeGreaterThan(0);
      expect(projection?.runtime.recording.executionEngine).toBe('managed');

      // A record written next chains from the last thing a reader saw.
      const records = projection!.replay!.records;
      expect(projection?.runtime.recording.lastCompletedUuid).toBe(
        records[records.length - 1].uuid,
      );

      const recent = await service.readRestoreProjection(sessionId, {
        replay: { kind: 'recent', limit: 1, hideInheritedHistory: false },
      });
      expect(recent?.replay?.records).toHaveLength(1);
      expect(recent?.replay?.hasMore).toBe(true);
      expect(recent?.replay?.anchorRecordId).toBe(
        recent?.replay?.records[0].uuid,
      );
    });
  });

  it('refuses to restore a managed session from another project', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      fixture.config.getChatRecordingService()!.recordUserMessage('first turn');
      await fixture.config.closeSessionWriter();

      const service = fixture.config.getSessionService();
      vi.spyOn(
        service as unknown as {
          sessionBelongsToCurrentProject(): Promise<boolean>;
        },
        'sessionBelongsToCurrentProject',
      ).mockResolvedValue(false);

      await expect(
        service.readRestoreProjection(sessionId, {
          replay: { kind: 'all', hideInheritedHistory: false },
        }),
      ).rejects.toThrow();
    });
  });

  it('loads a managed session that nothing has been said in yet', async () => {
    await withWorkspace(async (activate) => {
      const first = await activate({ managedSessionLog: true });
      await first.config.closeSessionWriter();

      // The header is proof the session exists, so an empty history must not
      // read as a missing session -- that would make the session unopenable.
      const loaded = await first.config
        .getSessionService()
        .loadSession(sessionId);
      expect(loaded?.conversation.messages).toEqual([]);
      expect(loaded?.lastCompletedUuid).toBeNull();

      // A client opening the same session pages it before anything is said.
      const page = await new SessionTranscriptReader(
        first.config.getTargetDir(),
      ).readPage(sessionId, { limit: 10 });
      expect(page.records).toEqual([]);
      expect(page.hasMore).toBe(false);
      const backwardPage = await new SessionTranscriptReader(
        first.config.getTargetDir(),
      ).readPage(sessionId, { direction: 'backward', limit: 10 });
      expect(backwardPage.records).toEqual([]);
      expect(backwardPage.hasMore).toBe(false);

      const second = await activate({ managedSessionLog: true });
      second.config.getChatRecordingService()!.recordUserMessage('first turn');
      await second.config.closeSessionWriter();
      const reloaded = await second.config
        .getSessionService()
        .loadSession(sessionId);
      expect(reloaded?.conversation.messages).toHaveLength(1);
    });
  });

  it('carries the file history a managed session recorded', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      await recorder.recordFileHistorySnapshotBatchStrict([
        {
          promptId: 'prompt-1',
          trackedFileBackups: {},
          timestamp: new Date('2026-09-11T00:00:00.000Z'),
        },
      ]);
      await recorder.recordFileHistorySnapshotBatchStrict([
        {
          promptId: 'prompt-2',
          trackedFileBackups: {},
          timestamp: new Date('2026-09-11T00:00:01.000Z'),
        },
      ]);
      await fixture.config.closeSessionWriter();

      // Each batch is its own committed fact, so both prompts survive a cold
      // reopen; one folded latest-wins body would have dropped the first.
      const projection = await fixture.config
        .getSessionService()
        .readRestoreProjection(sessionId, { replay: { kind: 'none' } });
      expect(
        projection?.runtime.fileHistorySnapshots?.map(
          (snapshot) => snapshot.promptId,
        ),
      ).toEqual(['prompt-1', 'prompt-2']);

      // They live in the authoritative log, not as a legacy record beside it.
      const records = await transcriptRecords(fixture.transcriptPath);
      expect(
        records.filter(
          (record) => record['subtype'] === 'file_history_snapshot',
        ),
      ).toEqual([]);
      const committedDomains = records
        .filter((record) => record['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((record) => record['managedSession'] as Record<string, unknown>)
        .filter((event) => event['kind'] === 'domain.committed')
        .map(
          (event) =>
            (event['payload'] as { domain?: unknown } | undefined)?.domain,
        );
      expect(
        committedDomains.filter((domain) => domain === 'file_history'),
      ).toHaveLength(2);
    });
  });

  it('carries the branch checkpoint a completed turn recorded', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      const cursor = recorder.getBranchCheckpointCursor();
      recorder.recordUserMessage('branch me');
      recorder.recordAssistantTurn({
        model: 'qwen3-coder-plus',
        message: [{ text: 'sure' }],
      });
      const point = await recorder.recordBranchCheckpointTransaction({
        cursor,
        stopReason: 'end_turn',
      });
      expect(point?.checkpointUuid).toBeDefined();

      // Every ordinary end_turn prompt records one of these, and a refused
      // record degrades the recorder for the rest of the session — so the
      // message after it is the real evidence that nothing was refused.
      recorder.recordUserMessage('after the checkpoint');
      await recorder.flush();
      await fixture.config.closeSessionWriter();

      const records = await transcriptRecords(fixture.transcriptPath);
      expect(
        records.filter((record) => record['subtype'] === 'branch_checkpoint'),
      ).toEqual([]);
      const events = records
        .filter((record) => record['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((record) => record['managedSession'] as Record<string, unknown>);
      expect(
        events.filter((event) => event['kind'] === 'checkpoint.committed'),
      ).toEqual([]);
      const branchMessages = events.filter(
        (event) =>
          event['kind'] === 'message.committed' &&
          (event['payload'] as { messageId?: unknown }).messageId ===
            point!.checkpointUuid,
      );
      expect(branchMessages).toHaveLength(1);
      expect(branchMessages[0]['payload']).toMatchObject({ role: 'system' });

      // The branch readers parse the original payload, so the record has to
      // come back as it was written.
      const projected = await readManagedSessionRecords({
        transcriptPath: fixture.transcriptPath,
        runtimeBaseDir: fixture.runtimeBaseDir,
        sessionKey: localManagedSessionKey(
          fixture.config.getProjectRoot(),
          sessionId,
        ),
      });
      const restored = projected.find(
        (record) => record.subtype === 'branch_checkpoint',
      );
      expect(restored?.uuid).toBe(point!.checkpointUuid);
      expect(restored?.systemPayload).toEqual({
        v: 1,
        startExclusiveRecordUuid: cursor.recordId,
        assistantRecordUuid: point!.assistantRecordUuid,
      });
    });
  });

  it('carries the source a daemon session was created from', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      expect(await recorder.recordSessionSource('standalone', 'task-42')).toBe(
        true,
      );

      // The bridge writes this on create and again on restore, so a refusal
      // here would degrade the recorder before the first prompt.
      recorder.recordUserMessage('after the source');
      await recorder.flush();
      await fixture.config.closeSessionWriter();

      const records = await transcriptRecords(fixture.transcriptPath);
      expect(
        records.filter((record) => record['subtype'] === 'session_source'),
      ).toEqual([]);
      const committedDomains = records
        .filter((record) => record['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE)
        .map((record) => record['managedSession'] as Record<string, unknown>)
        .filter((event) => event['kind'] === 'domain.committed')
        .map(
          (event) =>
            (event['payload'] as { domain?: unknown } | undefined)?.domain,
        );
      expect(
        committedDomains.filter((domain) => domain === 'session_source'),
      ).toHaveLength(1);

      const projected = await readManagedSessionRecords({
        transcriptPath: fixture.transcriptPath,
        runtimeBaseDir: fixture.runtimeBaseDir,
        sessionKey: localManagedSessionKey(
          fixture.config.getProjectRoot(),
          sessionId,
        ),
      });
      const restored = projected.find(
        (record) => record.subtype === 'session_source',
      );
      expect(restored?.systemPayload).toEqual({
        sourceType: 'standalone',
        sourceId: 'task-42',
      });

      // The listing reads physical records and then the transcript tail, so
      // without a Managed probe a Managed session would be listed with no
      // creator attribution at all.
      const listed = await fixture.config.getSessionService().listSessions();
      const item = listed.items.find((entry) => entry.sessionId === sessionId);
      expect(item?.sourceType).toBe('standalone');
      expect(item?.sourceId).toBe('task-42');
    });
  });

  it('navigates the turns of a managed session', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      recorder.recordUserMessage('second turn');
      await fixture.config.closeSessionWriter();

      // The physical log holds only wrapper records, which carry no navigation
      // kind, so turn navigation has to read the projection — otherwise a
      // Managed session silently reports no turns at all.
      const page = await new SessionTranscriptReader(
        fixture.config.getTargetDir(),
      ).readTurnIndexPage(sessionId);
      expect(page.totalTurns).toBe(2);
      expect(page.turns.map((turn) => turn.label)).toEqual([
        'first turn',
        'second turn',
      ]);
      expect(page.turns.map((turn) => turn.ordinal)).toEqual([0, 1]);

      // Paging is derived from the projection too, so start and the snapshot
      // round trip have to hold there and not just on the legacy index.
      const reader = new SessionTranscriptReader(fixture.config.getTargetDir());
      const newest = await reader.readTurnIndexPage(sessionId, { limit: 1 });
      expect(newest.start).toBe(1);
      expect(newest.turns.map((turn) => turn.label)).toEqual(['second turn']);
      const oldest = await reader.readTurnIndexPage(sessionId, {
        snapshot: newest.snapshot,
        start: 0,
        limit: 1,
      });
      expect(oldest.turns.map((turn) => turn.label)).toEqual(['first turn']);
    });
  });

  it('pages a managed session from its projection', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      const cursor = recorder.getBranchCheckpointCursor();
      recorder.recordUserMessage('first turn');
      recorder.recordAssistantTurn({
        model: 'qwen3-coder-plus',
        message: [{ text: 'first reply' }],
      });
      const point = await recorder.recordBranchCheckpointTransaction({
        cursor,
        stopReason: 'end_turn',
      });
      recorder.recordUserMessage('second turn');
      await fixture.config.closeSessionWriter();

      // Without projection-backed paging this handed the client the authority's
      // wrapper records as if they were the conversation.
      const workspaceCwd = fixture.config.getTargetDir();
      const reader = new SessionTranscriptReader(workspaceCwd);
      const first = await reader.readPage(sessionId, { limit: 2 });
      expect(first.records.map((item) => item.type)).toEqual([
        'user',
        'assistant',
      ]);
      expect(first.hasMore).toBe(true);
      expect(first.branchPointsByAssistantUuid).toEqual({
        [first.records[1].uuid]: point!.checkpointUuid,
      });

      const second = await reader.readPage(sessionId, {
        cursor: encodeSessionTranscriptCursor(
          first.nextCursorState!,
          workspaceCwd,
        ),
        limit: 2,
      });
      expect(second.records.map((item) => [item.type, item.subtype])).toEqual([
        ['system', 'branch_checkpoint'],
        ['user', undefined],
      ]);
      expect(second.records[1].message?.parts?.[0]?.text).toBe('second turn');
      expect(second.hasMore).toBe(false);

      // The turn index issues the snapshot a client anchors with, so both
      // readers have to accept the same identity.
      const turns = await reader.readTurnIndexPage(sessionId);
      const anchored = await reader.readPage(sessionId, {
        snapshot: turns.snapshot,
        atRecordId: turns.turns[1].turnId,
        limit: 1,
      });
      expect(anchored.targetRecordId).toBe(turns.turns[1].turnId);
      expect(
        anchored.records.map((item) => item.message?.parts?.[0]?.text),
      ).toEqual(['second turn']);
      expect(anchored.hasOlder).toBe(true);

      // The projected segment length is what the byte budget measures, so a
      // tiny budget still has to return the one record a page cannot split.
      const budgeted = await reader.readPage(sessionId, {
        limit: 10,
        maxBytes: 1,
      });
      expect(budgeted.records).toHaveLength(1);
      expect(budgeted.hasMore).toBe(true);

      // Turn status resolution pages backward and chains the cursor, so the
      // chain has to cover the whole projection in order.
      const backward: ChatRecord[][] = [];
      let backwardCursor: string | undefined;
      for (let request = 0; request < 10; request++) {
        const page = await reader.readPage(sessionId, {
          ...(backwardCursor === undefined
            ? { direction: 'backward' as const }
            : { cursor: backwardCursor }),
          limit: 2,
        });
        backward.unshift(page.records);
        if (!page.hasMore || page.nextCursorState === undefined) break;
        backwardCursor = encodeSessionTranscriptCursor(
          page.nextCursorState,
          workspaceCwd,
        );
      }
      const projected = await reader.readPage(sessionId, { limit: 10 });
      expect(backward.flat().map((item) => item.uuid)).toEqual(
        projected.records.map((item) => item.uuid),
      );

      const before = await reader.readPage(sessionId, {
        beforeRecordId: projected.records[3].uuid,
        limit: 10,
      });
      expect(before.records.map((item) => item.uuid)).toEqual(
        projected.records.slice(0, 3).map((item) => item.uuid),
      );

      // A frozen snapshot has to keep answering from the bytes it covers, so a
      // record appended afterwards must not appear on an anchored page.
      const reopened = await activate({ managedSessionLog: true });
      reopened.config
        .getChatRecordingService()!
        .recordUserMessage('third turn');
      await reopened.config.closeSessionWriter();
      // Drop the cached index so the projection is rebuilt: a cache hit would
      // hide whether the byte bound is what keeps the new record out.
      clearSessionTranscriptIndexCacheEntriesForTest();
      const afterAppend = await new SessionTranscriptReader(
        workspaceCwd,
      ).readPage(sessionId, {
        snapshot: turns.snapshot,
        atRecordId: turns.turns[1].turnId,
        limit: 10,
      });
      const afterAppendTexts = afterAppend.records.map(
        (item) => item.message?.parts?.[0]?.text,
      );
      expect(afterAppendTexts).toContain('second turn');
      expect(afterAppendTexts).not.toContain('third turn');
    });
  });

  it('maps a broken managed projection to an unavailable snapshot', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      fixture.config.getChatRecordingService()!.recordUserMessage('first turn');
      await fixture.config.closeSessionWriter();

      await rm(managedSessionResourceRoot(fixture.runtimeBaseDir, sessionId), {
        recursive: true,
        force: true,
      });
      clearSessionTranscriptIndexCacheEntriesForTest();

      await expect(
        new SessionTranscriptReader(fixture.config.getTargetDir()).readPage(
          sessionId,
          { limit: 10 },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
    });
  });

  it('leaves a managed host on the legacy transcript when the log is off', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: false });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();

      const records = await transcriptRecords(fixture.transcriptPath);
      expect(records.map((entry) => entry['subtype'])).toEqual([
        'session_execution_engine',
        undefined,
      ]);
      expect(records[1]['type']).toBe('user');
      expect(isManagedSessionTranscriptSync(fixture.transcriptPath)).toBe(
        false,
      );

      await fixture.config.closeSessionWriter();

      // A legacy close still releases, which removes the lock outright.
      await expect(
        stat(getSessionWriterLockPath(fixture.runtimeBaseDir, sessionId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
