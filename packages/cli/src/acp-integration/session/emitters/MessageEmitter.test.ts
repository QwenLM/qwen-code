/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageEmitter } from './MessageEmitter.js';
import type { SessionContext } from '../types.js';
import {
  apiActivityTracker,
  type Config,
  type GoalRecord,
  type GoalSnapshotV2,
} from '@qwen-code/qwen-code-core';

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 2,
  objective: 'ship goal support',
  status: 'active',
  evidenceCursor: { recordId: 'record-1' },
  turnCount: 2,
  activeTimeMs: 1234,
  createdAt: 100,
  updatedAt: 200,
  lastReason: 'continuing',
};

const snapshot = (
  goal: GoalRecord | null = GOAL,
  activity: GoalSnapshotV2['activity'] = 'idle',
): GoalSnapshotV2 => ({ v: 2, goal, activity });

describe('MessageEmitter', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let emitter: MessageEmitter;

  beforeEach(() => {
    // emitUsageMetadata drains the process-global API-activity tracker onto a
    // live frame's `_meta`; zero it so a nonzero count from another test can't
    // inject apiErrors/apiRetries keys into these exact-`_meta` assertions.
    apiActivityTracker.drain();
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      sessionId: 'test-session-id',
      config: {} as Config,
      sendUpdate: sendUpdateSpy,
    };
    emitter = new MessageEmitter(mockContext);
  });

  describe('emitUserMessage', () => {
    it('should send user_message_chunk update with text content', async () => {
      await emitter.emitUserMessage('Hello, world!');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello, world!' },
      });
    });

    it('should handle empty text', async () => {
      await emitter.emitUserMessage('');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '' },
      });
    });

    it('should handle multiline text', async () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      await emitter.emitUserMessage(multilineText);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: multilineText },
      });
    });

    it('should include source metadata when provided', async () => {
      await emitter.emitUserMessage('scheduled prompt', 1_700_000_000_000, {
        source: 'cron',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'scheduled prompt' },
        _meta: {
          timestamp: 1_700_000_000_000,
          source: 'cron',
        },
      });
    });
  });

  describe('emitAgentMessage', () => {
    it('should send agent_message_chunk update with text content', async () => {
      await emitter.emitAgentMessage('I can help you with that.');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I can help you with that.' },
      });
    });

    it('should include subagent parent metadata when provided', async () => {
      await emitter.emitAgentMessage('Subagent progress', undefined, {
        parentToolCallId: 'agent-parent-1',
        subagentType: 'general-purpose',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Subagent progress' },
        _meta: {
          parentToolCallId: 'agent-parent-1',
          subagentType: 'general-purpose',
        },
      });
    });
  });

  describe('emitSlashCommandOutput', () => {
    it('should identify slash-command output in metadata', async () => {
      await emitter.emitSlashCommandOutput('Compressing context...');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Compressing context...' },
        _meta: { source: 'slash_command' },
      });
    });
  });

  describe('emitGoalState', () => {
    it('emits v2 before the matching legacy status in one update', async () => {
      const value = snapshot();

      await emitter.emitGoalState(value, 'create');

      const update = sendUpdateSpy.mock.calls[0][0] as {
        _meta: Record<string, unknown>;
      };
      expect(Object.keys(update._meta)).toEqual(['goalState', 'goalStatus']);
      expect(update).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          goalState: value,
          goalStatus: {
            kind: 'set',
            condition: GOAL.objective,
            iterations: GOAL.turnCount,
            setAt: GOAL.createdAt,
            durationMs: GOAL.activeTimeMs,
            lastReason: GOAL.lastReason,
          },
        },
      });
    });

    it('appends the matching terminal projection after v2 and status', async () => {
      const completed = snapshot({ ...GOAL, status: 'complete' });

      await emitter.emitGoalState(completed, 'complete');

      const update = sendUpdateSpy.mock.calls[0][0] as {
        _meta: Record<string, unknown>;
      };
      expect(Object.keys(update._meta)).toEqual([
        'goalState',
        'goalStatus',
        'goalTerminal',
      ]);
      expect(update._meta['goalTerminal']).toEqual({
        kind: 'achieved',
        condition: GOAL.objective,
        iterations: GOAL.turnCount,
        durationMs: GOAL.activeTimeMs,
        lastReason: GOAL.lastReason,
      });
    });

    it('emits pause as a non-terminal paused status', async () => {
      const paused = snapshot({ ...GOAL, status: 'paused' });

      await emitter.emitGoalState(paused, 'pause');

      const update = sendUpdateSpy.mock.calls[0][0] as {
        _meta: Record<string, unknown>;
      };
      expect(update._meta['goalStatus']).toMatchObject({ kind: 'paused' });
      expect(update._meta).not.toHaveProperty('goalTerminal');
    });

    it('uses the previous goal when projecting a clear', async () => {
      await emitter.emitGoalState(snapshot(null), 'clear', GOAL);

      expect(sendUpdateSpy.mock.calls[0][0]).toMatchObject({
        _meta: {
          goalState: { v: 2, goal: null, activity: 'idle' },
          goalStatus: { kind: 'cleared', condition: GOAL.objective },
        },
      });
    });

    it('emits only v2 for activity-only updates', async () => {
      const running = snapshot(GOAL, 'running');

      await emitter.emitGoalState(running);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { goalState: running },
      });
    });
  });

  describe('emitStopHookLoop', () => {
    it('emits generic Stop-hook loop metadata', async () => {
      await emitter.emitStopHookLoop(3, ['continue'], 1);

      const update = sendUpdateSpy.mock.calls[0][0] as {
        _meta: Record<string, unknown>;
      };
      expect(update._meta).toEqual({
        stopHookLoop: {
          iterationCount: 3,
          reasons: ['continue'],
          stopHookCount: 1,
        },
      });
      expect(update._meta).not.toHaveProperty('goalState');
    });
  });

  describe('emitGoalStatus', () => {
    it('should send a goal status update in metadata', async () => {
      const status = {
        kind: 'set' as const,
        condition: 'ship goal support',
        setAt: 1234,
      };

      await emitter.emitGoalStatus(status);

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          goalStatus: status,
        },
      });
    });
  });

  describe('emitAgentThought', () => {
    it('should send agent_thought_chunk update with text content', async () => {
      await emitter.emitAgentThought('Let me think about this...');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think about this...' },
      });
    });

    it('should include subagent parent metadata when provided', async () => {
      await emitter.emitAgentThought('Subagent thought', undefined, {
        parentToolCallId: 'agent-parent-1',
        subagentType: 'general-purpose',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Subagent thought' },
        _meta: {
          parentToolCallId: 'agent-parent-1',
          subagentType: 'general-purpose',
        },
      });
    });
  });

  describe('emitMessage', () => {
    it('should emit user message when role is user', async () => {
      await emitter.emitMessage('User input', 'user');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'User input' },
      });
    });

    it('should emit agent message when role is assistant and isThought is false', async () => {
      await emitter.emitMessage('Agent response', 'assistant', false);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Agent response' },
      });
    });

    it('should emit agent message when role is assistant and isThought is not provided', async () => {
      await emitter.emitMessage('Agent response', 'assistant');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Agent response' },
      });
    });

    it('should emit agent thought when role is assistant and isThought is true', async () => {
      await emitter.emitAgentThought('Thinking...');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      });
    });

    it('should ignore isThought when role is user', async () => {
      // Even if isThought is true, user messages should still be user_message_chunk
      await emitter.emitMessage('User input', 'user', true);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'User input' },
      });
    });
  });

  describe('multiple emissions', () => {
    it('should handle multiple sequential emissions', async () => {
      await emitter.emitUserMessage('First');
      await emitter.emitAgentMessage('Second');
      await emitter.emitAgentThought('Third');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(3);
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(1, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'First' },
      });
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Second' },
      });
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(3, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Third' },
      });
    });
  });

  describe('emitUsageMetadata', () => {
    it('should emit agent_message_chunk with _meta.usage containing token counts', async () => {
      const usageMetadata = {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 25,
        totalTokenCount: 175,
        cachedContentTokenCount: 10,
      };

      await emitter.emitUsageMetadata(usageMetadata);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 175,
            thoughtTokens: 25,
            cachedReadTokens: 10,
          },
        },
      });
    });

    it('should include durationMs in _meta when provided', async () => {
      const usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 2,
        totalTokenCount: 17,
        cachedContentTokenCount: 1,
      };

      await emitter.emitUsageMetadata(usageMetadata, 'done', 1234);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
        _meta: {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 17,
            thoughtTokens: 2,
            cachedReadTokens: 1,
          },
          durationMs: 1234,
        },
      });
    });

    it('drains model API errors/retries onto a live frame and stamps them', async () => {
      apiActivityTracker.recordError();
      apiActivityTracker.recordError();
      apiActivityTracker.recordRetry();

      // Live round (durationMs present) → the counts are drained and stamped.
      await emitter.emitUsageMetadata({ totalTokenCount: 1 }, '', 500);
      expect(sendUpdateSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          _meta: expect.objectContaining({ apiErrors: 2, apiRetries: 1 }),
        }),
      );

      // A second live round with nothing pending carries neither key (the first
      // emit drained the tracker to zero).
      await emitter.emitUsageMetadata({ totalTokenCount: 1 }, '', 500);
      const secondMeta = sendUpdateSpy.mock.lastCall?.[0]._meta;
      expect(secondMeta).not.toHaveProperty('apiErrors');
      expect(secondMeta).not.toHaveProperty('apiRetries');
    });

    it('does not drain the tracker on a replay frame (no durationMs)', async () => {
      apiActivityTracker.recordError();

      // Replay path omits durationMs → must not consume the pending count nor
      // stamp it onto a frame the daemon ignores for replay.
      await emitter.emitUsageMetadata({ totalTokenCount: 1 });
      const replayMeta = sendUpdateSpy.mock.lastCall?.[0]._meta;
      expect(replayMeta).not.toHaveProperty('apiErrors');
      // The count survived for the next live frame to report.
      expect(apiActivityTracker.peek().errors).toBe(1);
    });

    it('accumulates token counts and API time into the context cumulative usage', async () => {
      const cumulativeUsage = {
        promptTokens: 0,
        cachedTokens: 0,
        candidateTokens: 0,
        apiTimeMs: 0,
      };
      const ctx: SessionContext = {
        sessionId: 'test-session-id',
        config: {} as Config,
        sendUpdate: sendUpdateSpy,
        cumulativeUsage,
      };
      const e = new MessageEmitter(ctx);
      await e.emitUsageMetadata(
        {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 10,
        },
        '',
        800,
      );
      await e.emitUsageMetadata(
        {
          promptTokenCount: 30,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 5,
        },
        '',
        200,
      );

      expect(cumulativeUsage).toEqual({
        promptTokens: 130,
        cachedTokens: 15,
        candidateTokens: 70,
        apiTimeMs: 1000,
      });
    });

    it('accumulates tokens but not API time when no duration is provided (replay)', async () => {
      const cumulativeUsage = {
        promptTokens: 0,
        cachedTokens: 0,
        candidateTokens: 0,
        apiTimeMs: 0,
      };
      const ctx: SessionContext = {
        sessionId: 'test-session-id',
        config: {} as Config,
        sendUpdate: sendUpdateSpy,
        cumulativeUsage,
      };
      await new MessageEmitter(ctx).emitUsageMetadata({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
      });

      expect(cumulativeUsage).toEqual({
        promptTokens: 100,
        cachedTokens: 10,
        candidateTokens: 50,
        apiTimeMs: 0,
      });
    });

    it('skips non-finite usage and durations so they do not poison the accumulator', async () => {
      const cumulativeUsage = {
        promptTokens: 5,
        cachedTokens: 1,
        candidateTokens: 2,
        apiTimeMs: 100,
      };
      const ctx: SessionContext = {
        sessionId: 'test-session-id',
        config: {} as Config,
        sendUpdate: sendUpdateSpy,
        cumulativeUsage,
      };
      // NaN survives `?? 0` (NaN ?? 0 === NaN); a non-finite duration or token
      // would otherwise make every later snapshot NaN forever.
      await new MessageEmitter(ctx).emitUsageMetadata(
        {
          promptTokenCount: Number.NaN,
          candidatesTokenCount: 10,
          cachedContentTokenCount: Number.POSITIVE_INFINITY,
        },
        '',
        Number.NaN,
      );

      expect(cumulativeUsage).toEqual({
        promptTokens: 5, // NaN skipped
        cachedTokens: 1, // Infinity skipped
        candidateTokens: 12, // 2 + 10
        apiTimeMs: 100, // NaN duration skipped
      });
    });
  });
});
