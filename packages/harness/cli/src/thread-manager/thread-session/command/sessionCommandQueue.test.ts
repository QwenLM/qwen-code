/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetQueueForTest,
  getCommandQueue,
  type InboundUserMessage,
} from '@qwen-code/core';
import { SessionCommandQueue } from './sessionCommandQueue.js';

function userMessage(text: string, extra: Partial<InboundUserMessage> = {}) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...extra,
  } satisfies InboundUserMessage;
}

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('SessionCommandQueue', () => {
  let queueA: SessionCommandQueue;
  let queueB: SessionCommandQueue;

  beforeEach(() => {
    _resetQueueForTest();
    queueA = new SessionCommandQueue(SESSION_A);
    queueB = new SessionCommandQueue(SESSION_B);
  });

  describe('toCommand', () => {
    /**
     * 全局队列是进程级共享的，而 drainMidTurnQueue 的过滤是
     * `cmd.sessionId !== undefined && cmd.sessionId !== params.sessionId`——
     * 未 stamp 的命令会穿透到任意会话的 mid-turn 注入点。这是多会话串话的直接来源，
     * 所以入队口不提供不带 sessionId 的路径。
     */
    it('强制 stamp sessionId 与 bridge origin，wire 上的 session_id 不参与归属判定', () => {
      const command = queueA.toCommand(
        userMessage('hi', { session_id: SESSION_B }),
      );

      expect(command.sessionId).toBe(SESSION_A);
      expect(command.origin).toEqual({ kind: 'bridge', sessionId: SESSION_A });
    });

    it('缺省 priority 为 next、commandMode 为 prompt', () => {
      const command = queueA.toCommand(userMessage('hi'));
      expect(command.priority).toBe('next');
      expect(command.commandMode).toBe('prompt');
    });

    it('保留 wire 上的 priority / shouldQuery / uuid / stopHookActive', () => {
      const command = queueA.toCommand(
        userMessage('hi', {
          priority: 'now',
          shouldQuery: false,
          uuid: 'u-1',
          stopHookActive: true,
          isMeta: true,
        }),
      );
      expect(command.priority).toBe('now');
      expect(command.shouldQuery).toBe(false);
      expect(command.uuid).toBe('u-1');
      expect(command.stopHookActive).toBe(true);
      expect(command.isMeta).toBe(true);
    });

    /**
     * `selected_skills` 是 wire 帧上的用户 Skill 选择。丢掉它意味着 daemon 声称支持
     * `selected_skills_v1` 却从不激活任何 Skill；mid-turn 注入路径（core 的
     * drainMidTurnQueue）直接消费队列命令上的这个字段，所以必须在入队口保留。
     */
    it('保留 wire 上的 selected_skills，且随命令进出共享队列', () => {
      const selectedSkills = [
        { name: 'skill-a', arguments: '--verbose' },
        { name: 'skill-b' },
      ];
      const command = queueA.toCommand(
        userMessage('hi', { selected_skills: selectedSkills }),
      );
      expect(command.selectedSkills).toEqual(selectedSkills);

      queueA.enqueueMessage(userMessage('queued', { selected_skills: selectedSkills }));
      const dequeued = queueA.dequeueNext();
      expect(dequeued?.selectedSkills).toEqual(selectedSkills);
    });

    it('wire 上没有 selected_skills 时命令不携带该字段', () => {
      const command = queueA.toCommand(userMessage('hi'));
      expect(command.selectedSkills).toBeUndefined();
    });

    it('每条命令拿到独立的进程内 queueId，用于取回原始帧', () => {
      const first = queueA.enqueueMessage(userMessage('one', { uuid: 'u-1' }));
      const second = queueA.enqueueMessage(userMessage('two', { uuid: 'u-2' }));

      expect(first.queueId).toBeDefined();
      expect(first.queueId).not.toBe(second.queueId);
      expect(queueA.originalMessage(first)?.message.content).toEqual([
        { type: 'text', text: 'one' },
      ]);
      expect(queueA.originalMessage(second)?.message.content).toEqual([
        { type: 'text', text: 'two' },
      ]);
    });

    it('字符串 content 原样作为 prompt，数组 content 作为 block 列表', () => {
      const text = queueA.toCommand({
        type: 'user',
        message: { role: 'user', content: 'plain' },
        parent_tool_use_id: null,
      });
      expect(text.prompt).toBe('plain');

      const blocks = queueA.toCommand(
        userMessage('x', {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        }),
      );
      expect(Array.isArray(blocks.prompt)).toBe(true);
    });
  });

  describe('会话归属', () => {
    it('只认领本会话的命令，别的会话的命令既不出队也不算归属', () => {
      queueA.enqueueMessage(userMessage('for-a', { uuid: 'u-a' }));
      queueB.enqueueMessage(userMessage('for-b', { uuid: 'u-b' }));

      expect(getCommandQueue()).toHaveLength(2);
      expect(queueA.queuedUuids()).toEqual(['u-a']);
      expect(queueB.queuedUuids()).toEqual(['u-b']);

      const dequeued = queueA.dequeueNext();
      expect(dequeued?.uuid).toBe('u-a');
      // B 的命令仍留在共享队列里
      expect(getCommandQueue().map((command) => command.uuid)).toEqual(['u-b']);
    });

    it('内部续跑（task-notification / peer）按会话归属认领', () => {
      queueA.enqueueMessage(
        userMessage('notify', { commandMode: 'task-notification' }),
      );
      expect(queueA.isOwnContinuation(getCommandQueue()[0]!)).toBe(true);
      expect(queueB.isOwnContinuation(getCommandQueue()[0]!)).toBe(false);
    });

    it('指向子 agent 的命令不属于主线会话', () => {
      const command = queueA.toCommand(userMessage('sub'));
      command.targetAgentId = 'agent-1';
      expect(queueA.isOwnMainThreadCommand(command)).toBe(false);
    });
  });

  describe('priority now 抢占', () => {
    it('只有本会话的 now 命令会触发抢占判断', () => {
      queueA.enqueueMessage(userMessage('a-now', { priority: 'now' }));
      expect(queueA.hasPriorityNowCommand()).toBe(true);
      expect(queueB.hasPriorityNowCommand()).toBe(false);
    });

    it('next / later 不触发抢占', () => {
      queueA.enqueueMessage(userMessage('a-next'));
      expect(queueA.hasPriorityNowCommand()).toBe(false);
    });
  });

  describe('cancelByUuid', () => {
    it('命中排队命令时移除并回报 cancelled', () => {
      queueA.enqueueMessage(userMessage('a', { uuid: 'u-a' }));
      expect(queueA.cancelByUuid('u-a')).toEqual({ cancelled: true });
      expect(getCommandQueue()).toHaveLength(0);
    });

    it('不能取消别的会话的同名 uuid', () => {
      queueA.enqueueMessage(userMessage('a', { uuid: 'shared-uuid' }));
      expect(queueB.cancelByUuid('shared-uuid')).toEqual({ cancelled: false });
      expect(getCommandQueue()).toHaveLength(1);
    });

    it('未命中时回报 cancelled:false 而不是报错', () => {
      expect(queueA.cancelByUuid('nope')).toEqual({ cancelled: false });
    });
  });

  describe('cancelQueued / discardQueued', () => {
    it('cancelQueued 只清本会话的命令', () => {
      queueA.enqueueMessage(userMessage('a1', { uuid: 'u-a1' }));
      queueA.enqueueMessage(userMessage('a2', { uuid: 'u-a2' }));
      queueB.enqueueMessage(userMessage('b1', { uuid: 'u-b1' }));

      const cancelled = queueA.cancelQueued();

      expect(cancelled.map((command) => command.uuid).sort()).toEqual([
        'u-a1',
        'u-a2',
      ]);
      expect(getCommandQueue().map((command) => command.uuid)).toEqual(['u-b1']);
    });

    it('discardQueued 之后原始帧映射被释放', () => {
      const command = queueA.enqueueMessage(userMessage('a', { uuid: 'u-a' }));
      const discarded = queueA.discardQueued();

      expect(discarded).toHaveLength(1);
      expect(queueA.originalMessage(command)).toBeUndefined();
    });
  });

  describe('uuid 接受表', () => {
    it('重复投递可被识别', () => {
      queueA.acceptUuid('u-1');
      expect(queueA.hasAcceptedUuid('u-1')).toBe(true);
      expect(queueA.hasAcceptedUuid('u-2')).toBe(false);
    });

    it('超出上限时按 FIFO 淘汰并回报被淘汰的 uuid', () => {
      let expired: string[] = [];
      for (let index = 0; index < 10_001; index++) {
        expired = queueA.acceptUuid(`u-${index}`);
      }
      expect(expired).toEqual(['u-0']);
      expect(queueA.hasAcceptedUuid('u-0')).toBe(false);
      expect(queueA.hasAcceptedUuid('u-10000')).toBe(true);
    });
  });

  describe('prune', () => {
    it('队列与在途批次都不再引用的 queueId 被回收', () => {
      const command = queueA.enqueueMessage(userMessage('a', { uuid: 'u-a' }));
      expect(queueA.originalMessage(command)).toBeDefined();

      // 出队后队列里已经没有它，映射应被回收。
      queueA.dequeueNext();
      queueA.prune();

      expect(queueA.originalMessage(command)).toBeUndefined();
    });
  });
});
