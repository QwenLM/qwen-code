/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig, type ConfigParameters } from './config.js';
import { Storage } from './storage.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolMode } from '../tools/code-mode.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { LlmChat } from '../core/llm-chat.js';
import { CompressionStatus } from '../core/turn.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { ExecutionEnvironment } from '../services/execution-environment.js';
import { buildSessionHistoryFromConversation } from '../services/session-api-history.js';
import { runWithInvocationContext } from '../utils/invocation-context.js';

let root: string;
let projectDir: string;
let configs: Config[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-workflow-mode-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  Storage.setRuntimeBaseDir(path.join(root, 'runtime'));
  configs = [];
  vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '');
  vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '');
});

afterEach(async () => {
  await Promise.all(configs.map((config) => config.closeSessionWriter()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Storage.setRuntimeBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

function createConfig(params: Partial<ConfigParameters> = {}): Config {
  const config = new Config({
    sessionId: randomUUID(),
    cwd: projectDir,
    targetDir: projectDir,
    debugMode: false,
    model: 'test-model',
    chatRecording: true,
    workflowsEnabled: true,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
    ...params,
  });
  configs.push(config);
  vi.spyOn(
    config as unknown as { initializeInternal(): Promise<void> },
    'initializeInternal',
  ).mockResolvedValue();
  vi.spyOn(config, 'getToolRegistry').mockReturnValue({
    getAllToolNames: () => [ToolNames.WORKFLOW],
    getAllTools: () => [],
    getTool: () => undefined,
  } as unknown as ToolRegistry);
  vi.spyOn(config, 'isWorkflowNameOnly').mockReturnValue(true);
  vi.spyOn(config, 'getToolMode').mockReturnValue(ToolMode.Direct);
  return config;
}

async function modeRecords(config: Config): Promise<ChatRecord[]> {
  const contents = await readFile(config.getTranscriptPath(), 'utf8').catch(
    () => '',
  );
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatRecord)
    .filter((record) => record.subtype === 'session_workflow_mode');
}

describe('Config durable workflow mode', () => {
  it.each([false, true])(
    'rejects a daemon-denied mode write %s before persistence or publication',
    async (enabled) => {
      const config = createConfig({ trustedFolder: true });
      await config.initialize();
      const listener = vi.fn();
      config.onWorkflowModeChange(listener);
      const context = {
        version: 1 as const,
        sessionId: config.getSessionId(),
        promptId: 'untrusted-owner',
        workflowModeWriteAllowed: false,
      };

      await expect(
        runWithInvocationContext(context, () =>
          config.setWorkflowMode(enabled),
        ),
      ).rejects.toThrow('Workspace is not trusted');
      expect(await modeRecords(config)).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
      expect(config.getWorkflowMode().requested).toBe(false);
      expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
    },
  );

  it.each([undefined, true])(
    'preserves status/off with unavailable tools when daemon permission is %s',
    async (workflowModeWriteAllowed) => {
      const config = createConfig({ workflowsEnabled: false });
      await config.initialize();
      const context = {
        version: 1 as const,
        sessionId: config.getSessionId(),
        promptId: 'allowed-owner',
        ...(workflowModeWriteAllowed !== undefined
          ? { workflowModeWriteAllowed }
          : {}),
      };
      await runWithInvocationContext(context, async () => {
        expect(config.getWorkflowMode().available).toBe(false);
        await expect(config.setWorkflowMode(false)).resolves.toMatchObject({
          requested: false,
          available: false,
        });
      });
      expect(
        (await modeRecords(config)).map((record) => record.systemPayload),
      ).toEqual([{ enabled: false }]);
    },
  );

  it('writes the first explicit false and coalesces committed identical writes', async () => {
    const config = createConfig();
    await config.initialize();
    expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
    const listener = vi.fn();
    config.onWorkflowModeChange(listener);
    await Promise.all([
      config.setWorkflowMode(false),
      config.setWorkflowMode(false),
    ]);
    expect(
      (await modeRecords(config)).map((record) => record.systemPayload),
    ).toEqual([{ enabled: false }]);
    expect(config.getWorkflowMode()).toEqual({
      requested: false,
      available: true,
      effective: false,
    });
    await config.setWorkflowMode(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      requested: true,
      available: true,
      effective: true,
    });
  });

  it('does not publish failed or still-pending persistence', async () => {
    const config = createConfig();
    await config.initialize();
    const recorder = config.getChatRecordingService()!;
    let reject!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const write = vi
      .spyOn(recorder, 'recordSessionWorkflowMode')
      .mockReturnValueOnce(blocked);
    const listener = vi.fn();
    config.onWorkflowModeChange(listener);
    const pending = config.setWorkflowMode(true);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(config.getWorkflowMode().requested).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    reject(new Error('disk failed'));
    expect(await failure).toMatchObject({ message: 'disk failed' });
    expect(config.getWorkflowMode().requested).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    await config.setWorkflowMode(true);
    expect(config.getWorkflowMode().requested).toBe(true);
    expect(await modeRecords(config)).toHaveLength(1);
  });

  it('restores true/false records and applies the staged override after restore once', async () => {
    const original = createConfig({ workflowMode: true });
    await original.initialize();
    const sessionId = original.getSessionId();
    const data = await original.getSessionService().loadSession(sessionId);
    expect(data).toBeDefined();
    const resumed = createConfig({ sessionId, sessionData: data });
    await resumed.initialize();
    expect(resumed.getWorkflowMode().effective).toBe(true);
    expect(await modeRecords(resumed)).toHaveLength(1);
    const notice = resumed.prepareWorkflowMode(null);
    expect(notice.reminder).toContain('is enabled');
    notice.onModelRequestDispatched?.();

    const overridden = createConfig({
      sessionId,
      sessionData: data,
      workflowMode: false,
    });
    await overridden.initialize();
    expect(overridden.getWorkflowMode().requested).toBe(false);
    expect((await modeRecords(overridden)).at(-1)?.systemPayload).toEqual({
      enabled: false,
    });
    overridden.startNewSession();
    expect(overridden.getWorkflowMode().requested).toBe(false);
    expect(overridden.prepareWorkflowMode(null).reminder).toBeUndefined();
    expect(await modeRecords(overridden)).toHaveLength(0);
  });

  it('uses the writer-authoritative restore before applying an explicit false override', async () => {
    const original = createConfig({ workflowMode: false });
    await original.initialize();
    const sessionId = original.getSessionId();
    const stale = await original.getSessionService().loadSession(sessionId);
    await original.setWorkflowMode(true);
    await original.closeSessionWriter();

    const authoritative = createConfig({
      sessionId,
      sessionData: stale,
      experimentalZedIntegration: true,
      sessionWriterLeaseEnabled: true,
    });
    await authoritative.initialize();
    expect(authoritative.getWorkflowMode().requested).toBe(true);
    expect(await modeRecords(authoritative)).toHaveLength(2);
    await authoritative.closeSessionWriter();

    const overridden = createConfig({
      sessionId,
      sessionData: stale,
      experimentalZedIntegration: true,
      sessionWriterLeaseEnabled: true,
      workflowMode: false,
    });
    await overridden.initialize();
    expect(overridden.getWorkflowMode().requested).toBe(false);
    expect(
      (await modeRecords(overridden)).map((record) => record.systemPayload),
    ).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }]);
  });

  it('pins an old pending append to its original transcript after a switch', async () => {
    const config = createConfig();
    await config.initialize();
    const oldPath = config.getTranscriptPath();
    const oldId = config.getSessionId();
    const recorder = config.getChatRecordingService()!;
    const append = recorder.recordSessionWorkflowMode.bind(recorder);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi
      .spyOn(recorder, 'recordSessionWorkflowMode')
      .mockImplementationOnce(async (enabled) => {
        await held;
        await append(enabled);
      });
    const pending = config.setWorkflowMode(true);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    config.startNewSession();
    finish();
    expect(await failure).toMatchObject({
      message: 'Workflow mode session changed',
    });
    expect(config.getWorkflowMode().requested).toBe(false);
    expect(await modeRecords(config)).toHaveLength(0);
    const persisted = (await readFile(oldPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    expect(persisted).toContainEqual(
      expect.objectContaining({
        sessionId: oldId,
        subtype: 'session_workflow_mode',
        systemPayload: { enabled: true },
      }),
    );
  });

  it('stages only before initialization and rejects invalid or conflicting values', async () => {
    const config = createConfig({ workflowMode: false });
    config.stageInitialWorkflowMode(false);
    expect(() => config.stageInitialWorkflowMode(true)).toThrow('Conflicting');
    expect(() =>
      config.stageInitialWorkflowMode('false' as unknown as boolean),
    ).toThrow('boolean');
    expect(await modeRecords(config)).toHaveLength(0);
    await config.initialize();
    expect(() => config.stageInitialWorkflowMode(false)).toThrow(
      'before initialization',
    );
  });

  it('fails initialization when the staged choice cannot be applied', async () => {
    const config = createConfig({
      workflowMode: true,
      workflowsEnabled: false,
    });
    await expect(config.initialize()).rejects.toThrow('unavailable');
    expect(await modeRecords(config)).toHaveLength(0);
  });

  it('retains requested on while unavailable and allows a durable off', async () => {
    const config = createConfig({ workflowMode: true });
    await config.initialize();
    const announced = config.prepareWorkflowMode(null);
    announced.onModelRequestDispatched?.();
    const listener = vi.fn();
    config.onWorkflowModeChange(listener);
    config.setWorkflowsEnabled(false);
    expect(config.getWorkflowMode()).toEqual({
      requested: true,
      available: false,
      effective: false,
      reason: 'workflow_unavailable',
    });
    await expect(config.setWorkflowMode(true)).rejects.toThrow('unavailable');
    expect(await modeRecords(config)).toHaveLength(1);
    expect(config.prepareWorkflowMode(null).reminder).toContain(
      'temporarily unavailable',
    );
    await config.setWorkflowMode(false);
    expect((await modeRecords(config)).at(-1)?.systemPayload).toEqual({
      enabled: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fences a late old-session write and restores rollback mode state', async () => {
    const config = createConfig();
    await config.initialize();
    await config.setWorkflowMode(true);
    config.prepareWorkflowMode(null).onModelRequestDispatched?.();
    const oldId = config.getSessionId();
    const snapshot = await config.captureWorkflowModeState();
    const oldToken = config.prepareWorkflowMode(null);
    const recorder = config.getChatRecordingService()!;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi
      .spyOn(recorder, 'recordSessionWorkflowMode')
      .mockReturnValueOnce(held);
    const pending = config.setWorkflowMode(false);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    config.startNewSession();
    const listener = vi.fn();
    config.onWorkflowModeChange(listener);
    finish();
    expect(await failure).toMatchObject({
      message: 'Workflow mode session changed',
    });
    oldToken.onModelRequestDispatched?.();
    expect(config.getWorkflowMode().requested).toBe(false);
    expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    config.startNewSession(oldId);
    config.restoreWorkflowModeState(snapshot);
    oldToken.onModelRequestDispatched?.();
    expect(config.getWorkflowMode().effective).toBe(true);
    expect(await config.captureWorkflowModeState()).toEqual({
      ...snapshot,
      pending: true,
      announced: undefined,
      turns: 0,
    });
    expect(config.getChatRecordingService()?.getSessionWorkflowMode()).toBe(
      true,
    );
    const notice = config.prepareWorkflowMode(null);
    expect(notice.reminder).toContain('is enabled');
    notice.onModelRequestDispatched?.();
    expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
  });

  it('reannounces off after rollback replays a compressed enabled notice', async () => {
    const config = createConfig({ workflowMode: true });
    await config.initialize();
    const recorder = config.getChatRecordingService()!;
    const enabled = config.prepareWorkflowMode(null);
    expect(enabled.reminder).toContain('is enabled');
    const reply = [
      { text: 'thinking '.repeat(100), thought: true },
      { text: 'answer' },
    ];
    recorder.recordUserMessage('before compression');
    recorder.recordAssistantTurn({ model: 'test-model', message: reply });
    const chat = new LlmChat(
      config,
      {},
      [
        {
          role: 'user',
          parts: [{ text: enabled.reminder }, { text: 'before compression' }],
        },
        { role: 'model', parts: reply },
      ],
      recorder,
    );
    enabled.onModelRequestDispatched?.();
    const client = config.getLlmClient();
    vi.spyOn(client, 'getChat').mockReturnValue(chat);
    expect((await client.tryCompressChatFast()).compressionStatus).toBe(
      CompressionStatus.COMPRESSED,
    );

    await config.setWorkflowMode(false);
    const off = config.prepareWorkflowMode(null);
    expect(off.reminder).toContain('is off');
    recorder.recordUserMessage('after compression');
    chat.addHistory({
      role: 'user',
      parts: [{ text: off.reminder }, { text: 'after compression' }],
    });
    recorder.recordAssistantTurn({
      model: 'test-model',
      message: [{ text: 'off acknowledged' }],
    });
    off.onModelRequestDispatched?.();
    const snapshot = await config.captureWorkflowModeState();
    expect(snapshot).toMatchObject({ requested: false, pending: false });
    await recorder.flush();
    const oldId = config.getSessionId();
    const data = await config.getSessionService().loadSession(oldId);
    expect(data).toBeDefined();
    const { apiHistory } = buildSessionHistoryFromConversation(
      data!.conversation,
    );
    expect(JSON.stringify(apiHistory)).toContain('Workflow mode is enabled');
    expect(JSON.stringify(apiHistory)).not.toContain('Workflow mode is off');

    config.startNewSession();
    config.startNewSession(oldId, data);
    config.restoreWorkflowModeState(snapshot);
    expect(config.getWorkflowMode()).toMatchObject({
      requested: false,
      effective: false,
    });
    expect(config.getChatRecordingService()?.getSessionWorkflowMode()).toBe(
      false,
    );
    const recovered = config.prepareWorkflowMode(null);
    expect(recovered.reminder).toContain('Workflow mode is off');
    recovered.onModelRequestDispatched?.();
    for (let turn = 0; turn < 30; turn++) {
      expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
    }
    expect(
      (await modeRecords(config)).map((record) => record.systemPayload),
    ).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it('keeps a never-recorded default session quiet after rollback', async () => {
    const config = createConfig();
    await config.initialize();
    const oldId = config.getSessionId();
    const snapshot = await config.captureWorkflowModeState();
    config.startNewSession();
    config.startNewSession(oldId);
    config.restoreWorkflowModeState(snapshot);
    expect(await config.captureWorkflowModeState()).toEqual(snapshot);
    expect(config.prepareWorkflowMode(null).reminder).toBeUndefined();
    expect(
      config.getChatRecordingService()?.getSessionWorkflowMode(),
    ).toBeUndefined();
    expect(await modeRecords(config)).toEqual([]);
  });

  it.each(['commitTelemetrySwap', 'abortTelemetrySwap'] as const)(
    'rejects mode writes until a session switch ends with %s',
    async (settle) => {
      const config = createConfig();
      await config.initialize();
      await config.setWorkflowMode(false);
      const client = config.getLlmClient();
      const listener = vi.fn();
      config.onWorkflowModeChange(listener);

      expect(client.beginTelemetrySwap()).toBe(true);
      for (const enabled of [true, false]) {
        await expect(config.setWorkflowMode(enabled)).rejects.toThrow(
          'A session switch is in progress',
        );
      }
      expect(config.getWorkflowMode().requested).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect((await modeRecords(config)).map((r) => r.systemPayload)).toEqual([
        { enabled: false },
      ]);

      client[settle]();
      await expect(config.setWorkflowMode(true)).resolves.toMatchObject({
        requested: true,
        effective: true,
      });
      expect((await modeRecords(config)).map((r) => r.systemPayload)).toEqual([
        { enabled: false },
        { enabled: true },
      ]);
    },
  );

  it('includes in-flight and queued mode writes in the rollback snapshot', async () => {
    const config = createConfig();
    await config.initialize();
    await config.setWorkflowMode(false);
    const oldId = config.getSessionId();
    const recorder = config.getChatRecordingService()!;
    const record = recorder.recordSessionWorkflowMode.bind(recorder);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi
      .spyOn(recorder, 'recordSessionWorkflowMode')
      .mockImplementationOnce(async (enabled) => {
        await held;
        return record(enabled);
      });
    const pending = config.setWorkflowMode(true);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const queuedOff = config.setWorkflowMode(false);
    const queuedOn = config.setWorkflowMode(true);
    const client = config.getLlmClient();
    expect(client.beginTelemetrySwap()).toBe(true);
    let captured = false;
    const snapshotPromise = Promise.resolve(
      config.captureWorkflowModeState(),
    ).then((snapshot) => {
      captured = true;
      return snapshot;
    });
    await Promise.resolve();
    const capturedBeforeWriteFinished = captured;
    finish();
    const acknowledgments = await Promise.all([pending, queuedOff, queuedOn]);
    expect(capturedBeforeWriteFinished).toBe(false);
    expect(acknowledgments.map((state) => state.requested)).toEqual([
      true,
      false,
      true,
    ]);
    const snapshot = await snapshotPromise;
    expect(snapshot.requested).toBe(true);
    const data = await config.getSessionService().loadSession(oldId);
    config.startNewSession();
    config.startNewSession(oldId, data);
    config.restoreWorkflowModeState(snapshot);
    client.abortTelemetrySwap();
    const live = config.getWorkflowMode();
    expect(live.effective).toBe(true);
    expect((await modeRecords(config)).map((r) => r.systemPayload)).toEqual([
      { enabled: false },
      { enabled: true },
      { enabled: false },
      { enabled: true },
    ]);

    await config.closeSessionWriter();
    const cold = createConfig({ sessionId: oldId, sessionData: data });
    await cold.initialize();
    expect(cold.getWorkflowMode()).toEqual(live);
  });

  it('does not share mode authority with derived, managed, remote or unrecorded owners', async () => {
    const parent = createConfig({ workflowMode: true });
    await parent.initialize();
    const child = deriveConfig(parent, {});
    const cases = [
      child,
      createConfig({ chatRecording: false }),
      createConfig({ sessionExecutionEngine: 'managed' }),
      createConfig({ executionEnvironment: {} as ExecutionEnvironment }),
    ];
    const agent = createConfig();
    agent.setSessionSource('agent');
    agent.markSessionAgentSession();
    cases.push(agent);
    for (const sourceType of ['agent', 'agent-host']) {
      const hidden = createConfig();
      hidden.setSessionSource(sourceType);
      cases.push(hidden);
    }
    for (const config of cases) {
      expect(config.isWorkflowModeSupported()).toBe(false);
      expect(config.getWorkflowMode()).toMatchObject({
        requested: false,
        effective: false,
      });
      expect(config.hasWorkflowModeContext()).toBe(false);
      await expect(config.setWorkflowMode(false)).rejects.toThrow(
        'unsupported',
      );
      expect(() => config.stageInitialWorkflowMode(true)).toThrow(
        'unsupported',
      );
    }
    expect(parent.getWorkflowMode().effective).toBe(true);
  });
});
