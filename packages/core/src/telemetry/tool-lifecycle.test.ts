/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';
import { createToolLifecycle } from './tool-lifecycle.js';

describe('tool lifecycle', () => {
  it('captures original recorder and separates execution from final outcome', () => {
    const oldRecorder = { recordUiTelemetryEvent: vi.fn() };
    const newRecorder = { recordUiTelemetryEvent: vi.fn() };
    let recorder = oldRecorder;
    let sessionId = 'old';
    const config = {
      getSessionId: () => sessionId,
      getChatRecordingService: () => recorder,
    } as unknown as Config;
    const call = createToolLifecycle(config, 'same', 'read');
    expect(call.start(100)).toMatchObject({ startedAt: 100, sessionId: 'old' });
    recorder = newRecorder;
    sessionId = 'new';
    expect(call.finish('error', 'success', 20)).toMatchObject({
      outcome: 'error',
      executionStatus: 'success',
      executionDurationMs: 20,
      sessionId: 'old',
    });
    expect(call.finish('success', 'success')).toBeUndefined();
    expect(call.start()).toBeUndefined();
    expect(oldRecorder.recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
    expect(newRecorder.recordUiTelemetryEvent).not.toHaveBeenCalled();
  });
  it('preserves not_started without fabricated times and gives repeated IDs unique occurrences', () => {
    const record = vi.fn();
    const config = {
      getSessionId: () => 'owner',
      getChatRecordingService: () => ({ recordUiTelemetryEvent: record }),
    } as unknown as Config;
    const a = createToolLifecycle(config, 'same', 'read', {
      persist: false,
      subagentId: 'child',
    });
    const b = createToolLifecycle(config, 'same', 'read', {
      persist: false,
      subagentId: 'child',
    });
    const ended = a.finish('cancelled', 'not_started');
    expect(ended).toMatchObject({
      outcome: 'cancelled',
      executionStatus: 'not_started',
      subagentId: 'child',
    });
    expect(ended).not.toHaveProperty('startedAt');
    expect(ended).not.toHaveProperty('executionDurationMs');
    expect(ended?.executionId).not.toEqual(b.start()?.executionId);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('tool lifecycle isolation', () => {
  it('keeps suppression after leaving its async context', () => {
    const record = vi.fn();
    const config = {
      getSessionId: () => 'owner',
      getChatRecordingService: () => ({ recordUiTelemetryEvent: record }),
    } as unknown as Config;
    const call = runWithChatRecordingSuppressed(() =>
      createToolLifecycle(config, 'hidden', 'read_file'),
    );
    expect(call.start()).toBeUndefined();
    expect(call.finish('success', 'success', 1)).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('writes late terminals to the original real JSONL after session rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-tool-rotation-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    vi.stubEnv('QWEN_HOME', join(root, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'runtime'));
    vi.stubEnv('QWEN_SESSION_ID', '');
    const config = new Config({
      sessionId: 'tool-session-a',
      cwd: workspace,
      targetDir: workspace,
      debugMode: false,
      model: 'test-model',
      chatRecording: true,
      sessionWriterLeaseEnabled: false,
      usageStatisticsEnabled: false,
      telemetry: { enabled: false },
    });
    const original = config.getChatRecordingService()!;
    try {
      const first = createToolLifecycle(config, 'reused-call', 'read_file');
      const started = first.start();
      config.startNewSession('tool-session-b');
      const current = config.getChatRecordingService()!;
      expect(current).not.toBe(original);
      first.finish('cancelled', 'success', 20);
      const second = createToolLifecycle(config, 'reused-call', 'read_file');
      second.start();
      second.finish('success', 'success', 1);
      await original.flush();
      await current.flush();
      for (const owner of ['tool-session-a', 'tool-session-b']) {
        const contents = await readFile(
          join(config.storage.getProjectDir(), 'chats', `${owner}.jsonl`),
          'utf8',
        );
        const rows = contents
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter(
            (row) =>
              row.systemPayload?.uiEvent?.['event.name'] === 'tool_lifecycle',
          );
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.systemPayload.uiEvent.phase)).toEqual([
          'started',
          'ended',
        ]);
        for (const row of rows) {
          expect(row.sessionId).toBe(owner);
          expect(row.systemPayload.uiEvent.sessionId).toBe(owner);
          if (owner === 'tool-session-a')
            expect(row.systemPayload.uiEvent.executionId).toBe(
              started?.executionId,
            );
          else
            expect(row.systemPayload.uiEvent.executionId).not.toBe(
              started?.executionId,
            );
        }
      }
    } finally {
      await original.flush();
      await config.getChatRecordingService()?.flush();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
