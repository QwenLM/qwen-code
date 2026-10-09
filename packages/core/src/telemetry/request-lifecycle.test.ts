/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../config/config.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { subagentIdentityContext } from '../utils/subagentNameContext.js';
import { startRequestLifecycle } from './request-lifecycle.js';

function fixture() {
  const recordUiTelemetryEvent = vi.fn();
  const notifyRequestLifecycle = vi.fn();
  const config = {
    getSessionId: () => 'owner',
    getChatRecordingService: () => ({ recordUiTelemetryEvent }),
    notifyRequestLifecycle,
  } as unknown as Config;
  return { config, recordUiTelemetryEvent, notifyRequestLifecycle };
}

describe('request lifecycle persistence', () => {
  it.each(['cancelled', 'error'] as const)(
    'keeps late %s terminals in the original session after rotation',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'qwen-lifecycle-rotation-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      vi.stubEnv('QWEN_HOME', join(root, 'home'));
      vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'runtime'));
      vi.stubEnv('QWEN_SESSION_ID', '');
      const config = new Config({
        sessionId: 'session-a',
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
      const live = vi.fn();
      const unsubscribe = config.onRequestLifecycle(live);
      try {
        const request = subagentIdentityContext.run(
          { id: 'child', type: 'agent' },
          () =>
            startRequestLifecycle(
              config,
              'old-execution',
              'old-prompt',
              'model',
            ),
        );
        config.startNewSession('session-b');
        const current = config.getChatRecordingService()!;
        expect(current).not.toBe(original);
        request.finish(outcome);
        startRequestLifecycle(
          config,
          'new-execution',
          'new-prompt',
          'model',
        ).finish('success');
        await original.flush();
        await current.flush();
        const readEvents = async (session: string) => {
          const contents = await readFile(
            join(config.storage.getProjectDir(), 'chats', `${session}.jsonl`),
            'utf8',
          );
          return contents
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as ChatRecord)
            .filter(
              (record) =>
                record.type === 'system' && record.subtype === 'ui_telemetry',
            );
        };
        const a = await readEvents('session-a');
        const b = await readEvents('session-b');
        expect(a).toHaveLength(2);
        expect(a).toMatchObject([
          {
            sessionId: 'session-a',
            systemPayload: {
              uiEvent: {
                executionId: 'old-execution',
                sessionId: 'session-a',
                subagentId: 'child',
                phase: 'started',
              },
            },
          },
          {
            sessionId: 'session-a',
            systemPayload: {
              uiEvent: {
                executionId: 'old-execution',
                sessionId: 'session-a',
                subagentId: 'child',
                phase: 'ended',
                outcome,
              },
            },
          },
        ]);
        expect(b).toHaveLength(2);
        for (const record of b) {
          expect(record).toMatchObject({
            sessionId: 'session-b',
            systemPayload: {
              uiEvent: { executionId: 'new-execution', sessionId: 'session-b' },
            },
          });
        }
        expect(live.mock.calls.map(([event]) => event)).toMatchObject([
          {
            executionId: 'old-execution',
            sessionId: 'session-a',
            phase: 'started',
          },
          {
            executionId: 'old-execution',
            sessionId: 'session-a',
            phase: 'ended',
            outcome,
          },
          {
            executionId: 'new-execution',
            sessionId: 'session-b',
            phase: 'started',
          },
          {
            executionId: 'new-execution',
            sessionId: 'session-b',
            phase: 'ended',
            outcome: 'success',
          },
        ]);
      } finally {
        unsubscribe();
        await original.close();
        await config.getChatRecordingService()?.close();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('retains the start owner after leaving subagent context and ends once', () => {
    const f = fixture();
    const request = subagentIdentityContext.run(
      { id: 'child', type: 'agent' },
      () => startRequestLifecycle(f.config, 'execution', 'prompt', 'model'),
    );
    request.finish('interrupted');
    request.finish('success');
    expect(f.recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
    const events = f.notifyRequestLifecycle.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      expect.objectContaining({
        phase: 'started',
        subagentId: 'child',
        sessionId: 'owner',
      }),
      expect.objectContaining({
        phase: 'ended',
        subagentId: 'child',
        outcome: 'interrupted',
        reason: 'consumer_closed',
      }),
    ]);
    expect(events[1].endedAt - events[0].startedAt).toBe(events[1].durationMs);
    expect(f.recordUiTelemetryEvent.mock.calls.map(([event]) => event)).toEqual(
      events.map((event) => ({ ...event, 'event.name': 'request_lifecycle' })),
    );
  });

  it('continues live delivery when recording fails', () => {
    const f = fixture();
    f.recordUiTelemetryEvent.mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    const request = startRequestLifecycle(
      f.config,
      'execution',
      'prompt',
      'model',
    );
    expect(() => request.finish('error')).not.toThrow();
    expect(f.notifyRequestLifecycle).toHaveBeenCalledTimes(2);
  });

  it('preserves recording when a live listener fails', () => {
    const f = fixture();
    f.notifyRequestLifecycle.mockImplementation(() => {
      throw new Error('listener failed');
    });
    const request = startRequestLifecycle(
      f.config,
      'execution',
      'prompt',
      'model',
    );
    expect(() => request.finish('success')).not.toThrow();
    expect(f.recordUiTelemetryEvent).toHaveBeenCalledTimes(2);
  });
});
