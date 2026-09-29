/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from './approval-mode.js';
import { Config, type ConfigParameters } from './config.js';
import { Storage } from './storage.js';
import {
  ManagedSessionRecordRefusedError,
  type ChatRecord,
} from '../services/chatRecordingService.js';
import { SessionExecutionEngineError } from '../services/session-execution-engine.js';
import { SessionService } from '../services/sessionService.js';
import {
  getSessionWriterLockPath,
  SessionWriterLease,
  SessionWriterUnavailableError,
} from '../services/session-writer-lease.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
} from '../managed-runtime/managed-session-records.js';
import { LocalJsonlManagedSessionJournalStore } from '../managed-runtime/local-jsonl-managed-session-journal-store.js';
import type { ManagedSession } from '../managed-runtime/managed-session-assembly.js';
import { ManagedSessionConflictError } from '../managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '../managed-runtime/managed-session-resources.js';
import { ManagedSessionRecordSink } from '../managed-runtime/managed-session-record-sink.js';
import { readManagedSessionRecords } from '../managed-runtime/managed-session-message-projection.js';
import {
  isManagedSessionTranscriptSync,
  localManagedSessionKey,
  managedSessionResourceRoot,
} from '../utils/sessionStorageUtils.js';

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

// Mirrors METADATA_REANCHOR_BYTES in chatRecordingService.ts.
const REANCHOR_GROWTH_BYTES = 32 * 1024 + 2 * 1024;

let root: string;
let projectDir: string;
let runtimeDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-log-'));
  projectDir = path.join(root, 'project');
  runtimeDir = path.join(root, 'runtime');
  await mkdir(projectDir, { recursive: true });
  // An exported QWEN_RUNTIME_DIR outranks the static override.
  vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Storage.setRuntimeBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

/** What a crash leaves: the writer's lock, naming a process that is gone. */
async function crashWriterLock(): Promise<Record<string, unknown>> {
  const crashed = await lockRecord();
  await writeFile(
    getSessionWriterLockPath(runtimeDir, SESSION_ID),
    JSON.stringify({ ...crashed, pid: 999_999 }),
  );
  return crashed;
}

function sessionService(): SessionService {
  return new SessionService(projectDir, { runtimeBaseDir: runtimeDir });
}

/** A Config the way a Managed host would build one for this session. */
function managedConfig(params: Partial<ConfigParameters> = {}): Config {
  return new Config({
    sessionId: SESSION_ID,
    cwd: projectDir,
    targetDir: projectDir,
    debugMode: false,
    model: 'test-model',
    chatRecording: true,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
    experimentalZedIntegration: true,
    sessionWriterLeaseEnabled: true,
    sessionExecutionEngine: 'managed',
    ...params,
  });
}

/** A Config that restores this session through its projection, as the daemon does. */
function restoringConfig(): Config {
  return managedConfig({
    sessionRestoreProjectionSource: () =>
      sessionService().readRestoreProjection(SESSION_ID, {
        replay: { kind: 'none' },
      }),
  });
}

// Stops initialization where hooks, MCP and tools would start.
async function start(config: Config): Promise<Config> {
  vi.spyOn(
    config as unknown as { initializeInternal(): Promise<void> },
    'initializeInternal',
  ).mockResolvedValue(undefined);
  await config.initialize();
  return config;
}

async function transcriptRecords(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(
    sessionService().getSessionTranscriptPath(SESSION_ID),
    'utf8',
  );
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeOwnerOnlyTranscript(): Promise<void> {
  const transcriptPath = sessionService().getSessionTranscriptPath(SESSION_ID);
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  // What a create leaves when it stops between its two appends.
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'session_execution_engine',
      cwd: projectDir,
      version: 'test',
      systemPayload: { version: 1, engine: 'managed' },
    })}\n`,
  );
}

async function lockRecord(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(getSessionWriterLockPath(runtimeDir, SESSION_ID), 'utf8'),
  ) as Record<string, unknown>;
}

function recordUser(config: Config, text: string): void {
  config.getChatRecordingService()!.recordUserMessage([{ text }]);
}

async function activeChatTexts(config: Config): Promise<string[]> {
  const chain = await config
    .getChatRecordingService()!
    .readActiveTranscriptChain();
  return chain
    .filter((record) => record.type === 'user')
    .map((record) => {
      const parts = (record.message?.parts ?? []) as Array<{ text?: string }>;
      return parts.map((part) => part.text ?? '').join('');
    });
}

describe('Managed Session log recording', () => {
  it('records a new session as a Managed Session log', async () => {
    const building = managedConfig({
      model: 'definition-model',
      approvalMode: ApprovalMode.YOLO,
    });
    // The definition records the mode the session has when it starts, not
    // the one it was built with.
    building.setApprovalMode(ApprovalMode.PLAN);
    const config = await start(building);
    recordUser(config, 'first prompt');
    await config.getChatRecordingService()!.flush();

    const records = await transcriptRecords();
    // The authority writes the owner record before the header, so Legacy
    // entries refuse the session even if the header never lands.
    expect(records[0]).toMatchObject({
      type: 'system',
      subtype: 'session_execution_engine',
      systemPayload: { version: 1, engine: 'managed' },
    });
    expect(records[1]?.['subtype']).toBe(MANAGED_SESSION_HEADER_SUBTYPE);
    // Every other line belongs to a committed Managed transaction; the user
    // record never lands raw.
    for (const record of records.slice(2)) {
      expect([
        MANAGED_SESSION_EVENT_SUBTYPE,
        MANAGED_SESSION_COMMIT_SUBTYPE,
      ]).toContain(record['subtype']);
    }
    const scan = await LocalJsonlManagedSessionJournalStore.read(
      sessionService().getSessionTranscriptPath(SESSION_ID),
      localManagedSessionKey(projectDir, SESSION_ID),
    );
    expect(scan.uncommitted).toBe(0);
    // The session is the activation's worker, with a five-minute horizon.
    expect(scan.activation?.workerId).toBe(SESSION_ID);
    expect(
      scan.events.find((event) => event.kind === 'activation.changed')?.payload[
        'leaseDurationMs'
      ],
    ).toBe(5 * 60 * 1000);
    // The definition carries configuration identity only.
    const definition = JSON.parse(
      (
        await LocalManagedSessionResourceStore.create({
          runtimeBaseDir: runtimeDir,
          sessionKey: localManagedSessionKey(projectDir, SESSION_ID),
        }).read(scan.header!.definitionRef)
      ).toString('utf8'),
    ) as Record<string, unknown>;
    expect(definition).toEqual({
      version: 1,
      engine: 'managed',
      model: 'definition-model',
      approvalMode: 'plan',
    });
    expect(records.some((record) => record['type'] === 'user')).toBe(false);
    expect(
      records.filter(
        (record) => record['subtype'] === 'session_execution_engine',
      ),
    ).toHaveLength(1);

    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    expect(isManagedSessionTranscriptSync(transcriptPath)).toBe(true);
    expect(() =>
      sessionService().assertLegacySessionExecution(SESSION_ID),
    ).toThrow(SessionExecutionEngineError);
    expect(await activeChatTexts(config)).toEqual(['first prompt']);

    // The writer pins the Managed schema while the session is open.
    expect(await lockRecord()).toMatchObject({
      state: 'active',
      schema_version: 3,
    });
    await config.closeSessionWriter();
  });

  it('seals the writer on close and restores the same history', async () => {
    const first = await start(managedConfig());
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();

    // Releasing would delete the lock and leave the log open to any writer.
    const sealed = await lockRecord();
    expect(sealed).toMatchObject({ state: 'sealed', schema_version: 3 });
    // The log records that the session stopped advancing before the seal.
    const scan = await LocalJsonlManagedSessionJournalStore.read(
      sessionService().getSessionTranscriptPath(SESSION_ID),
      localManagedSessionKey(projectDir, SESSION_ID),
    );
    expect(scan.activation?.phase).toBe('released');
    expect(scan.uncommitted).toBe(0);
    const bytesAtClose = (
      await stat(sessionService().getSessionTranscriptPath(SESSION_ID))
    ).size;

    const second = await start(restoringConfig());
    expect(await activeChatTexts(second)).toEqual(['first prompt']);
    recordUser(second, 'second prompt');
    await second.getChatRecordingService()!.flush();
    expect(await activeChatTexts(second)).toEqual([
      'first prompt',
      'second prompt',
    ]);
    await second.closeSessionWriter();
    expect(
      (await stat(sessionService().getSessionTranscriptPath(SESSION_ID))).size,
    ).toBeGreaterThan(bytesAtClose);

    const third = await start(restoringConfig());
    expect(await activeChatTexts(third)).toEqual([
      'first prompt',
      'second prompt',
    ]);
    await third.closeSessionWriter();
    expect(await lockRecord()).toMatchObject({ state: 'sealed' });
  });

  it('completes a create that stopped after its owner record', async () => {
    await writeOwnerOnlyTranscript();
    expect(() =>
      sessionService().assertLegacySessionExecution(SESSION_ID),
    ).toThrow(SessionExecutionEngineError);

    const config = await start(restoringConfig());
    recordUser(config, 'after the interrupted create');
    await config.getChatRecordingService()!.flush();
    const subtypes = (await transcriptRecords()).map(
      (record) => record['subtype'],
    );
    expect(subtypes.slice(0, 2)).toEqual([
      'session_execution_engine',
      MANAGED_SESSION_HEADER_SUBTYPE,
    ]);
    expect(await activeChatTexts(config)).toEqual([
      'after the interrupted create',
    ]);
    await config.closeSessionWriter();
  });

  it('repairs a transaction a crash left without its commit marker', async () => {
    const first = await start(managedConfig());
    recordUser(first, 'committed prompt');
    await first.getChatRecordingService()!.flush();
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const committedBytes = await readFile(transcriptPath);

    // The process dies after writing a transaction's events and before its
    // commit marker; its lock is reclaimed afterwards.
    const appendJsonLine = SessionWriterLease.prototype.appendJsonLine;
    const append = vi
      .spyOn(SessionWriterLease.prototype, 'appendJsonLine')
      .mockImplementation(async function (
        this: SessionWriterLease,
        value: unknown,
      ) {
        if (
          (value as { subtype?: unknown }).subtype ===
          MANAGED_SESSION_COMMIT_SUBTYPE
        ) {
          throw new Error('process died');
        }
        return appendJsonLine.call(this, value);
      });
    recordUser(first, 'lost prompt');
    await first
      .getChatRecordingService()!
      .flush()
      .catch(() => undefined);
    append.mockRestore();
    await crashWriterLock();
    expect((await readFile(transcriptPath)).length).toBeGreaterThan(
      committedBytes.length,
    );

    const second = await start(restoringConfig());
    expect(await activeChatTexts(second)).toEqual(['committed prompt']);
    // The committed prefix stays; the tail moved to the diagnostic file.
    expect(
      (await readFile(transcriptPath)).subarray(0, committedBytes.length),
    ).toEqual(committedBytes);
    await expect(
      readFile(`${transcriptPath}.uncommitted-tail`, 'utf8'),
    ).resolves.toContain(MANAGED_SESSION_EVENT_SUBTYPE);
    recordUser(second, 'after the repair');
    await second.getChatRecordingService()!.flush();
    expect(await activeChatTexts(second)).toEqual([
      'committed prompt',
      'after the repair',
    ]);
    await second.closeSessionWriter();
    expect(await lockRecord()).toMatchObject({ state: 'sealed' });
  });

  it('keeps its title where the session list and a restore read it', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    const titleRecords = async () =>
      (
        await readFile(
          sessionService().getSessionTranscriptPath(SESSION_ID),
          'utf8',
        )
      ).split('"domain":"session_metadata"').length - 1;
    await expect(
      recorder.recordCustomTitle('Early title', 'auto'),
    ).resolves.toBe(true);
    // The session list scans 64 KiB at each end of the log. The rename lands
    // past the head window, and the records after it would push it past the tail
    // window too if the recorder did not re-anchor it.
    for (let index = 0; index < 45; index++) {
      recordUser(config, `before the rename ${index}`);
    }
    await recorder.flush();
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const renamedAt = (await stat(transcriptPath)).size;
    await expect(
      recorder.recordCustomTitle('Renamed title', 'manual'),
    ).resolves.toBe(true);
    for (let index = 0; index < 45; index++) {
      recordUser(config, `after the rename ${index}`);
    }
    await recorder.flush();
    expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
      title: 'Renamed title',
      source: 'manual',
    });
    // Re-anchors come no more often than every 32 KiB of growth.
    const offsets: number[] = [];
    let offset = 0;
    for (const line of (await readFile(transcriptPath, 'utf8')).split('\n')) {
      if (line.includes('"domain":"session_metadata"')) offsets.push(offset);
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    expect(offsets.length).toBeGreaterThan(4);
    for (let index = 1; index < offsets.length; index++) {
      if (offsets[index] === renamedAt) continue;
      expect(offsets[index]! - offsets[index - 1]!).toBeGreaterThanOrEqual(
        32 * 1024,
      );
    }
    await config.closeSessionWriter();

    const restored = await start(restoringConfig());
    expect(restored.getChatRecordingService()!.getCurrentCustomTitle()).toBe(
      'Renamed title',
    );
    // A restored rename commits one record, not the rename and a re-anchor.
    const before = await titleRecords();
    await expect(
      restored
        .getChatRecordingService()!
        .recordCustomTitle('Final title', 'manual'),
    ).resolves.toBe(true);
    await restored.getChatRecordingService()!.flush();
    expect(await titleRecords()).toBe(before + 1);
    expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
      title: 'Final title',
    });
    await restored.closeSessionWriter();
  });

  it('re-anchors its title on finalize after renewals alone moved the log on', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    for (let index = 0; index < 40; index++) {
      recordUser(config, `prompt ${index}`);
    }
    await recorder.flush();
    await expect(
      recorder.recordCustomTitle('Idle title', 'manual'),
    ).resolves.toBe(true);
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const titledAt = (await stat(transcriptPath)).size;
    // While the session is idle, the renewal timer is the only writer.
    const { authority } = (
      config as unknown as { managedSession: ManagedSession }
    ).managedSession;
    while ((await stat(transcriptPath)).size - titledAt < 70 * 1024) {
      await authority.renewActivation({ leaseDurationMs: 5 * 60 * 1000 });
    }
    expect(sessionService().getSessionTitleInfo(SESSION_ID)?.title).not.toBe(
      'Idle title',
    );

    recorder.finalize();
    await recorder.flush();
    expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
      title: 'Idle title',
    });
    // The title it wrote is not on the chain the next record continues.
    recordUser(config, 'after finalize');
    const texts = await activeChatTexts(config);
    expect(texts[0]).toBe('prompt 0');
    expect(texts.at(-1)).toBe('after finalize');
    await config.closeSessionWriter();
  });

  it.each([
    'a handoff close',
    'a close after a failed write',
    'a crash',
  ] as const)(
    'keeps a rename that renewals moved out of the list windows through %s',
    async (ending) => {
      const building = managedConfig();
      // The takeover policy the ACP host sets; without it a handoff close is
      // an ordinary one.
      if (ending === 'a handoff close') {
        building.setSessionWriterTakeoverPolicy('certified');
      }
      const config = await start(building);
      const recorder = config.getChatRecordingService()!;
      await recorder.recordCustomTitle('Early title', 'auto');
      for (let index = 0; index < 40; index++) {
        recordUser(config, `prompt ${index}`);
      }
      await recorder.flush();
      await expect(
        recorder.recordCustomTitle('Renamed title', 'manual'),
      ).resolves.toBe(true);
      const transcriptPath =
        sessionService().getSessionTranscriptPath(SESSION_ID);
      const renamedAt = (await stat(transcriptPath)).size;
      const { authority } = (
        config as unknown as { managedSession: ManagedSession }
      ).managedSession;
      while ((await stat(transcriptPath)).size - renamedAt < 70 * 1024) {
        await authority.renewActivation({ leaseDurationMs: 5 * 60 * 1000 });
      }
      // The session list now finds only the early title, in the head window.
      expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
        title: 'Early title',
      });

      if (ending === 'a handoff close') {
        // The daemon's Managed shutdown closes the writer without finalize().
        await config.closeSessionWriter({ handoff: true });
        expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
          title: 'Renamed title',
        });
      } else if (ending === 'a close after a failed write') {
        const write = ManagedSessionRecordSink.prototype.write;
        const failing = vi
          .spyOn(ManagedSessionRecordSink.prototype, 'write')
          .mockImplementation(async function (
            this: ManagedSessionRecordSink,
            record: ChatRecord,
          ) {
            if (record.type === 'user') throw new Error('disk full');
            return write.call(this, record);
          });
        recordUser(config, 'not recorded');
        await expect(recorder.flush()).rejects.toThrow('disk full');
        failing.mockRestore();
        await config.closeSessionWriter().catch(() => undefined);
        expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
          title: 'Renamed title',
        });
      } else {
        // The process dies; its lock is reclaimed afterwards.
        await crashWriterLock();
      }

      const restored = await start(restoringConfig());
      expect(restored.getChatRecordingService()!.getCurrentCustomTitle()).toBe(
        'Renamed title',
      );
      recordUser(restored, 'after the restore');
      await restored.getChatRecordingService()!.flush();
      await restored.closeSessionWriter();
      expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
        title: 'Renamed title',
      });
    },
  );

  it('adds no title on finalize right behind an anchor', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    await recorder.recordCustomTitle('Managed title', 'manual');
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const titleRecords = async () =>
      (await readFile(transcriptPath, 'utf8')).split(
        '"domain":"session_metadata"',
      ).length - 1;
    // Records until an anchor lands behind the last of them.
    let anchored = false;
    for (let index = 0; index < 40 && !anchored; index++) {
      const before = await titleRecords();
      recordUser(config, `prompt ${index}`);
      await recorder.flush();
      anchored = (await titleRecords()) > before;
    }
    expect(anchored).toBe(true);
    const count = await titleRecords();

    recorder.finalize();
    await recorder.flush();
    expect(await titleRecords()).toBe(count);
    await config.closeSessionWriter();
  });

  it('restores its session source', async () => {
    const first = await start(managedConfig());
    await expect(
      first.getChatRecordingService()!.recordSessionSource('creator', 'one'),
    ).resolves.toBe(true);
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();

    const projection = await sessionService().readRestoreProjection(
      SESSION_ID,
      { replay: { kind: 'none' } },
    );
    expect(projection?.runtime.recording).toMatchObject({
      sourceType: 'creator',
      sourceId: 'one',
    });
    const restored = await start(restoringConfig());
    const recorder = restored.getChatRecordingService()!;
    // As on a Legacy restore: the source is already recorded, and another is
    // refused.
    await expect(recorder.recordSessionSource('creator', 'one')).resolves.toBe(
      true,
    );
    await expect(recorder.recordSessionSource('intruder', 'two')).resolves.toBe(
      false,
    );
    await recorder.flush();
    const raw = await readFile(
      sessionService().getSessionTranscriptPath(SESSION_ID),
      'utf8',
    );
    expect(raw.split('"domain":"session_source"')).toHaveLength(2);
    await restored.closeSessionWriter();
  });

  // An unreadable file is made with chmod, which neither Windows nor root
  // honours.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a reclaimed lock when it cannot read the log',
    async () => {
      const first = await start(managedConfig());
      recordUser(first, 'first prompt');
      await first.getChatRecordingService()!.flush();
      const transcriptPath =
        sessionService().getSessionTranscriptPath(SESSION_ID);
      const crashed = await crashWriterLock();
      try {
        // The lock is reclaimed first; then the log becomes unreadable and the
        // restore fails.
        const config = managedConfig({
          sessionRestoreProjectionSource: async () => {
            await chmod(transcriptPath, 0o000);
            throw new Error('projection unavailable');
          },
        });
        vi.spyOn(
          config as unknown as { initializeInternal(): Promise<void> },
          'initializeInternal',
        ).mockResolvedValue(undefined);
        await expect(config.initialize()).rejects.toThrow(
          'projection unavailable',
        );
        await config.closeSessionWriter().catch(() => undefined);
        // Nothing tells whether the log holds Managed records, so the Managed
        // lock it took over stays in place rather than being dropped.
        const kept = await lockRecord();
        expect(kept).toMatchObject({ state: 'active', schema_version: 3 });
        expect(kept['owner_id']).not.toBe(crashed['owner_id']);
      } finally {
        await chmod(transcriptPath, 0o644);
      }
    },
  );

  it('writes a due anchor right behind the record that made it due', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    await recorder.recordSessionSource('test-source');
    // Queued at once, so the source falls due while most of them still wait.
    for (let index = 0; index < 30; index++) {
      recordUser(config, `burst ${index}`);
    }
    await recorder.flush();

    const records = await readManagedSessionRecords({
      transcriptPath: sessionService().getSessionTranscriptPath(SESSION_ID),
      runtimeBaseDir: runtimeDir,
      sessionKey: localManagedSessionKey(projectDir, SESSION_ID),
    });
    const sources = records.flatMap((record, index) =>
      record.subtype === 'session_source' ? [index] : [],
    );
    expect(sources).toHaveLength(2);
    const anchorAt = sources[1]!;
    // Among the queued records, with the record before it in the log as its
    // parent rather than the last record queued.
    expect(anchorAt).toBeLessThan(records.length - 1);
    expect(records[anchorAt]!.parentUuid).toBe(records[anchorAt - 1]!.uuid);
    await config.closeSessionWriter();
  });

  it('does not anchor the title that a rename in flight replaces', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    await recorder.recordCustomTitle('Old title', 'manual');
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const { authority } = (
      config as unknown as { managedSession: ManagedSession }
    ).managedSession;
    // The log moves past the re-anchor threshold while the rename is written,
    // so the anchor falls due as the rename lands.
    const write = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record: ChatRecord) {
        const payload = record.systemPayload as
          | { customTitle?: unknown }
          | undefined;
        if (payload?.customTitle === 'New title') {
          const from = (await stat(transcriptPath)).size;
          while ((await stat(transcriptPath)).size - from < 34 * 1024) {
            await authority.renewActivation({
              leaseDurationMs: 5 * 60 * 1000,
            });
          }
        }
        return write.call(this, record);
      },
    );

    await expect(
      recorder.recordCustomTitle('New title', 'manual'),
    ).resolves.toBe(true);
    await recorder.flush();
    expect(sessionService().getSessionTitleInfo(SESSION_ID)).toMatchObject({
      title: 'New title',
    });
    vi.restoreAllMocks();
    await config.closeSessionWriter();
  });

  it('seals the log when the title anchor written on close fails', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;
    await recorder.recordCustomTitle('Managed title', 'manual');
    recordUser(config, 'committed prompt');
    await recorder.flush();
    // Renewals alone make the title due, so its anchor is written on close.
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const from = (await stat(transcriptPath)).size;
    const { authority } = (
      config as unknown as { managedSession: ManagedSession }
    ).managedSession;
    while ((await stat(transcriptPath)).size - from < REANCHOR_GROWTH_BYTES) {
      await authority.renewActivation({ leaseDurationMs: 5 * 60 * 1000 });
    }
    const write = ManagedSessionRecordSink.prototype.write;
    const failing = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record: ChatRecord,
      ) {
        if (record.subtype === 'custom_title') throw new Error('disk full');
        return write.call(this, record);
      });

    await config.closeSessionWriter();
    expect(failing).toHaveBeenCalledWith(
      expect.objectContaining({ subtype: 'custom_title' }),
    );
    failing.mockRestore();
    expect(await lockRecord()).toMatchObject({
      state: 'sealed',
      schema_version: 3,
    });
    // The failed anchor does not skip the stop: the log records that the
    // session stopped advancing before the seal.
    const scan = await LocalJsonlManagedSessionJournalStore.read(
      sessionService().getSessionTranscriptPath(SESSION_ID),
      localManagedSessionKey(projectDir, SESSION_ID),
    );
    expect(scan.activation?.phase).toBe('released');
    const restored = await start(restoringConfig());
    expect(await activeChatTexts(restored)).toEqual(['committed prompt']);
    await restored.closeSessionWriter();
  });

  it('keeps a record committed when the anchor behind it fails', async () => {
    const first = await start(managedConfig());
    await first
      .getChatRecordingService()!
      .recordCustomTitle('Managed title', 'manual');
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();

    // A restored session anchors its title behind the first record it writes.
    const restored = await start(restoringConfig());
    const write = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record: ChatRecord) {
        if (record.subtype === 'custom_title') throw new Error('disk full');
        return write.call(this, record);
      },
    );
    const recorder = restored.getChatRecordingService()!;
    await expect(recorder.recordSessionSource('test-source')).resolves.toBe(
      true,
    );
    // Only the writes after it fail.
    await expect(recorder.flush()).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    await restored.closeSessionWriter().catch(() => undefined);
    expect(await lockRecord()).toMatchObject({ state: 'sealed' });
    const projection = await sessionService().readRestoreProjection(
      SESSION_ID,
      { replay: { kind: 'none' } },
    );
    expect(projection?.runtime.recording).toMatchObject({
      sourceType: 'test-source',
    });
  });

  it('keeps the chain through records that are not messages', async () => {
    // The same records on a Legacy session, whose chain includes the title.
    const describeChain = async (config: Config) =>
      (await config.getChatRecordingService()!.readActiveTranscriptChain()).map(
        (record) =>
          record.type === 'user'
            ? `user:${(
                (record.message?.parts ?? []) as Array<{ text?: string }>
              )
                .map((part) => part.text)
                .join('')}`
            : (record.subtype ?? record.type),
      );
    const recordSequence = async (config: Config, sessionId: string) => {
      const recorder = config.getChatRecordingService()!;
      recordUser(config, 'A');
      await recorder.recordCustomTitle('Title', 'manual');
      recorder.recordTurnResult({
        promptId: `${sessionId}########1`,
        state: 'completed',
        endedAt: Date.now(),
      });
      await recorder.recordSessionSource('test-source');
      recordUser(config, 'B');
      // What a session switch or an artifact migration writes before the
      // session goes on.
      recorder.finalize();
      recordUser(config, 'C');
      await recorder.flush();
    };

    const legacyId = randomUUID();
    const legacy = await start(
      managedConfig({ sessionId: legacyId, sessionExecutionEngine: 'legacy' }),
    );
    await recordSequence(legacy, legacyId);
    const legacyChain = await describeChain(legacy);
    await legacy.closeSessionWriter();

    const managed = await start(managedConfig());
    await recordSequence(managed, SESSION_ID);
    // The owner record precedes a Managed header and a Managed title is
    // metadata, so neither is in the chain; everything else is the chain
    // Legacy keeps.
    const expected = legacyChain.filter(
      (entry) =>
        entry !== 'custom_title' && entry !== 'session_execution_engine',
    );
    expect(expected).toEqual([
      'user:A',
      'turn_result',
      'session_source',
      'user:B',
      'user:C',
    ]);
    expect(await describeChain(managed)).toEqual(expected);
    await managed.closeSessionWriter();

    const restored = await start(restoringConfig());
    expect(await describeChain(restored)).toEqual(expected);
    await restored.closeSessionWriter();
  });

  it('refuses a record its log cannot carry and keeps recording', async () => {
    const config = await start(managedConfig());
    const recorder = config.getChatRecordingService()!;

    await expect(
      recorder.recordUserTextElements({ content: 'hello', textElements: [] }),
    ).rejects.toThrow(ManagedSessionRecordRefusedError);
    // A carried kind in a shape its mapping cannot take is refused the same
    // way, before it reaches the log.
    await expect(recorder.recordCustomTitle('', 'manual')).resolves.toBe(false);
    // Written without waiting: dropped instead of failing later writes.
    recorder.recordNotification([{ text: 'background done' }], 'done');

    recordUser(config, 'still recorded');
    await recorder.flush();
    expect(await activeChatTexts(config)).toEqual(['still recorded']);
    const raw = await readFile(
      sessionService().getSessionTranscriptPath(SESSION_ID),
      'utf8',
    );
    expect(raw).not.toContain('background done');
    expect(raw).not.toContain('user_text_elements');
    await config.closeSessionWriter();
    expect(await lockRecord()).toMatchObject({ state: 'sealed' });
  });

  it.each<[string, Partial<ConfigParameters>]>([
    ['without chat recording', { chatRecording: false }],
    ['without the writer lease', { sessionWriterLeaseEnabled: false }],
  ])('refuses a Managed session %s', async (_name, params) => {
    const config = managedConfig(params);
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);

    await expect(config.initialize()).rejects.toThrow(
      'managed execution requires chat recording and a writer lease',
    );
    await expect(
      stat(sessionService().getSessionTranscriptPath(SESSION_ID)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each<[string, () => Config]>([
    [
      'a restore',
      () => {
        // Closed while the restore reads its projection.
        const source = sessionService();
        const closing = managedConfig({
          sessionRestoreProjectionSource: async () => {
            void closing.closeSessionWriter().catch(() => undefined);
            return source.readRestoreProjection(SESSION_ID, {
              replay: { kind: 'none' },
            });
          },
        });
        return closing;
      },
    ],
    [
      'a new session',
      () => {
        // Closed while the create publishes the resources its header needs.
        const closing = managedConfig();
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(async function (
          this: LocalManagedSessionResourceStore,
          kind: string,
          bytes: Buffer,
        ) {
          void closing.closeSessionWriter().catch(() => undefined);
          return publish.call(this, kind, bytes);
        });
        return closing;
      },
    ],
  ])('seals the log when a close interrupts %s', async (name, build) => {
    if (name === 'a restore') {
      const first = await start(managedConfig());
      recordUser(first, 'first prompt');
      await first.closeSessionWriter();
    }
    const config = build();
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow();
    await config.closeSessionWriter().catch(() => undefined);
    vi.restoreAllMocks();

    expect(await lockRecord()).toMatchObject({
      state: 'sealed',
      schema_version: 3,
    });
    const restored = await start(restoringConfig());
    recordUser(restored, 'after the close');
    await restored.getChatRecordingService()!.flush();
    expect(await activeChatTexts(restored)).toEqual(
      name === 'a restore'
        ? ['first prompt', 'after the close']
        : ['after the close'],
    );
    await restored.closeSessionWriter();
  });

  it('keeps the lock of a Managed log it cannot read', async () => {
    const first = await start(managedConfig());
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    // A line the Managed format does not allow after its header, and no lock.
    await writeFile(
      transcriptPath,
      `${await readFile(transcriptPath, 'utf8')}${JSON.stringify({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: projectDir,
        version: 'test',
        message: { role: 'user', parts: [{ text: 'raw' }] },
      })}\n`,
    );
    await rm(getSessionWriterLockPath(runtimeDir, SESSION_ID));

    const config = managedConfig();
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow('unknown subtype');
    await config.closeSessionWriter().catch(() => undefined);
    // No position to seal it at, so it stays held rather than released.
    expect(await lockRecord()).toMatchObject({
      state: 'active',
      schema_version: 3,
    });
  });

  it('refuses to open a Legacy-owned transcript as a Managed log', async () => {
    const legacy = await start(
      managedConfig({ sessionExecutionEngine: 'legacy' }),
    );
    recordUser(legacy, 'legacy prompt');
    await legacy.closeSessionWriter();
    const before = await readFile(
      sessionService().getSessionTranscriptPath(SESSION_ID),
    );

    const config = restoringConfig();
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow(
      SessionExecutionEngineError,
    );
    expect(
      await readFile(sessionService().getSessionTranscriptPath(SESSION_ID)),
    ).toEqual(before);
    // Nothing Managed was written, so the lock is released for Legacy.
    await expect(
      stat(getSessionWriterLockPath(runtimeDir, SESSION_ID)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a restore whose projection names another owner', async () => {
    const first = await start(managedConfig());
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();
    const transcriptPath =
      sessionService().getSessionTranscriptPath(SESSION_ID);
    const before = await readFile(transcriptPath);

    // The projection is checked before the log is opened, which writes to it.
    const source = sessionService();
    const config = managedConfig({
      sessionRestoreProjectionSource: async () => {
        const projection = (await source.readRestoreProjection(SESSION_ID, {
          replay: { kind: 'none' },
        }))!;
        return {
          ...projection,
          executionEngine: {
            ...projection.executionEngine,
            engine: 'legacy',
          } as typeof projection.executionEngine,
        };
      },
    });
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow(
      SessionExecutionEngineError,
    );
    await config.closeSessionWriter().catch(() => undefined);
    expect(await readFile(transcriptPath)).toEqual(before);
    expect(await lockRecord()).toMatchObject({ state: 'sealed' });
  });

  it("leaves a Legacy session's handoff seal in place", async () => {
    const legacy = managedConfig({ sessionExecutionEngine: 'legacy' });
    legacy.setSessionWriterTakeoverPolicy('certified');
    await start(legacy);
    recordUser(legacy, 'legacy prompt');
    await legacy.closeSessionWriter({ handoff: true });
    const sealed = await lockRecord();
    expect(sealed).toMatchObject({ state: 'sealed', schema_version: 2 });
    const before = await readFile(
      sessionService().getSessionTranscriptPath(SESSION_ID),
    );

    // Refused before the lease is taken, so the seal a Legacy successor
    // checks the transcript against is never retired.
    const config = restoringConfig();
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow(
      SessionExecutionEngineError,
    );
    await config.closeSessionWriter().catch(() => undefined);
    expect(await lockRecord()).toEqual(sealed);
    expect(
      await readFile(sessionService().getSessionTranscriptPath(SESSION_ID)),
    ).toEqual(before);
  });

  it('releases the lock of a new session that fails before writing anything', async () => {
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockRejectedValue(new Error('resource store unavailable'));
    const config = managedConfig();
    vi.spyOn(
      config as unknown as { initializeInternal(): Promise<void> },
      'initializeInternal',
    ).mockResolvedValue(undefined);
    await expect(config.initialize()).rejects.toThrow(
      'resource store unavailable',
    );
    await config.closeSessionWriter().catch(() => undefined);
    // Nothing was written, so there is nothing for a lock to guard.
    await expect(
      stat(sessionService().getSessionTranscriptPath(SESSION_ID)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(getSessionWriterLockPath(runtimeDir, SESSION_ID)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('seals a handoff close whose last flush failed', async () => {
    const building = managedConfig();
    building.setSessionWriterTakeoverPolicy('certified');
    const config = await start(building);
    recordUser(config, 'committed prompt');
    await config.getChatRecordingService()!.flush();
    const write = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record: ChatRecord) {
        if (record.type === 'user') throw new Error('disk full');
        return write.call(this, record);
      },
    );
    recordUser(config, 'not recorded');

    // A Legacy handoff keeps its lock active here; a Managed log is sealed at
    // its committed position, which the failed record is not part of.
    await config.closeSessionWriter({ handoff: true }).catch(() => undefined);
    vi.restoreAllMocks();
    expect(await lockRecord()).toMatchObject({
      state: 'sealed',
      schema_version: 3,
    });
    const restored = await start(restoringConfig());
    expect(await activeChatTexts(restored)).toEqual(['committed prompt']);
    await restored.closeSessionWriter();
  });

  it('restores a session whose title body is missing', async () => {
    const first = await start(managedConfig());
    await first
      .getChatRecordingService()!
      .recordCustomTitle('Managed title', 'manual');
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();
    await rm(
      path.join(
        managedSessionResourceRoot(runtimeDir, SESSION_ID),
        'managed-session_metadata',
      ),
      { recursive: true },
    );

    // A damaged title costs the title, not the session.
    await expect(
      sessionService().readLiveRestoreProjection(SESSION_ID, {
        replay: { kind: 'none' },
      }),
    ).resolves.toBeDefined();
    const restored = await start(restoringConfig());
    expect(
      restored.getChatRecordingService()!.getCurrentCustomTitle(),
    ).toBeUndefined();
    expect(await activeChatTexts(restored)).toEqual(['first prompt']);
    await restored.closeSessionWriter();
  });

  it('gives back the seal it took over when the log does not match it', async () => {
    const first = await start(managedConfig());
    recordUser(first, 'first prompt');
    await first.closeSessionWriter();
    // A seal that names an earlier commit than the log holds, as when the log
    // changed after the session was sealed.
    const sealed = await lockRecord();
    const mismatched = {
      ...sealed,
      last_commit_sequence: (sealed['last_commit_sequence'] as number) - 1,
    };
    await writeFile(
      getSessionWriterLockPath(runtimeDir, SESSION_ID),
      JSON.stringify(mismatched),
    );

    // Refused every time, with the log's own error rather than as writer
    // contention.
    for (let attempt = 0; attempt < 2; attempt++) {
      const config = restoringConfig();
      vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      ).mockResolvedValue(undefined);
      await expect(config.initialize()).rejects.toThrow(
        ManagedSessionConflictError,
      );
      await config.closeSessionWriter().catch(() => undefined);
      expect(await lockRecord()).toMatchObject({
        state: 'sealed',
        last_commit_sequence: mismatched.last_commit_sequence,
        committed_prefix_hash: sealed['committed_prefix_hash'],
      });
    }
  });

  it.each([
    ['a Legacy recorder that already accepts records', 'legacy'],
    ['a Managed recorder that already accepts records', 'managed'],
  ] as const)('refuses to bind a log to %s', async (_name, engine) => {
    const config = await start(
      managedConfig({ sessionExecutionEngine: engine }),
    );
    expect(() =>
      config.getChatRecordingService()!.bindManagedSink({
        canCarry: () => true,
        write: async () => undefined,
        project: async () => [],
        stopAdvancing: async () => undefined,
        commitProof: () => ({
          last_commit_sequence: 0,
          committed_prefix_hash: '0'.repeat(64),
        }),
        logSize: () => undefined,
      }),
    ).toThrow(SessionWriterUnavailableError);
    await config.closeSessionWriter();
  });

  it('refuses to bind a second log before activation', () => {
    const recorder = managedConfig().getChatRecordingService()!;
    const writer = {
      canCarry: () => true,
      write: async () => undefined,
      project: async () => [],
      stopAdvancing: async () => undefined,
      commitProof: () => ({
        last_commit_sequence: 0,
        committed_prefix_hash: '0'.repeat(64),
      }),
      logSize: () => undefined,
    };
    recorder.bindManagedSink(writer);
    expect(() => recorder.bindManagedSink(writer)).toThrow(
      SessionWriterUnavailableError,
    );
  });
});
