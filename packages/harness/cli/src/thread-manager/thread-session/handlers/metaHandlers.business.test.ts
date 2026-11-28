/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createUserMessage,
  SessionTitleService,
} from '@qwen-code/core';
import { generateSessionTitle } from './metaHandlers.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';

describe('control title business', () => {
  it.each(['修复登录', '其他展示正文'])('无 ID 委派请求通过真实标题服务，模型仍使用 description：%s', async (description) => {
    const original = createUserMessage('<qoder_delegated_input_sources>来源</qoder_delegated_input_sources>\n修复登录', {
      origin: { kind: 'human' }, requestSetId: 'original-turn',
      businessIdentity: { product: 'app', type: 'agent', id: 'original-turn', model_key: 'ultimate' },
    });
    const inference = vi.fn(async () => ({
      completed: Promise.resolve({ blocks: [{ type: 'text', text: '{"title":"修复登录"}' }] }),
    }));
    const setTopic = vi.fn();
    const session = {
      requireConfig: () => ({
        getSessionId: () => 'session', getModel: () => 'auto', topicState: { setTopic },
        getModelProviderManager: () => ({
          select: async () => ({ model: { key: 'lite', source: 'qwen-provider', limits: { maxOutputTokens: 4096 } }, config: {} }),
          inference,
        }),
      }),
      peekQueryRunner: () => ({ getMessages: () => [original] }),
      signal: new AbortController().signal,
    } as unknown as ThreadSessionInternals;
    expect(await generateSessionTitle(session, {} as never, { description })).toEqual({ title: '修复登录' });
    expect(inference).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.objectContaining({ messages: expect.arrayContaining([{ role: 'user', content: description }]) }),
      qoder: expect.objectContaining({
        business: expect.objectContaining({
          ...original.businessIdentity!,
          type: 'title_generation',
          sub_task: 'title_generation',
        }),
        taskRouting: expect.objectContaining({ taskId: 'agent_summary' }),
      }),
    }));
    expect(setTopic).toHaveBeenCalledWith('修复登录', undefined);
  });

  it('恢复/分叉会话未跑首轮时先装配 runner 再解析归属', async () => {
    // runner 懒建到首个 prompt；宿主在 open_session 后、首轮前调标题能力时
    // peek 拿到 null，必须触发装配才能拿到恢复历史里的业务快照。
    const original = createUserMessage('实际执行正文', {
      requestSetId: 'turn',
      businessIdentity: { product: 'app', type: 'agent', id: 'turn', model_key: 'auto' },
    });
    const lazyRunner = {
      getTitleSourceMessages: async () => [original],
      getMessages: () => [original],
    };
    const generate = vi
      .spyOn(SessionTitleService.prototype, 'generateTitle')
      .mockResolvedValue('标题');
    const session = {
      requireConfig: () => ({
        getSessionId: () => 'session',
        getModel: () => 'auto',
        getUtilityLlmClient: () => ({}),
      }),
      peekQueryRunner: () => null,
      ensureQueryRunner: async () => lazyRunner,
      signal: new AbortController().signal,
    } as unknown as ThreadSessionInternals;
    try {
      expect(
        await generateSessionTitle(session, {} as never, {
          description: '展示正文',
          sourceUserMessageId: original.uuid,
        }),
      ).toEqual({ title: '标题' });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          businessInfo: expect.objectContaining({ id: 'turn', model_key: 'auto' }),
        }),
      );
      generate.mockClear();
      expect(
        await generateSessionTitle(session, {} as never, {
          description: '实际执行正文',
        }),
      ).toEqual({ title: '标题' });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          businessInfo: expect.objectContaining({ id: 'turn' }),
        }),
      );
    } finally {
      generate.mockRestore();
    }
  });

  it('按 ID 的标题请求区分归属错误和模型失败', async () => {
    const original = createUserMessage('实际执行正文', {
      requestSetId: 'turn',
      businessIdentity: { product: 'app', type: 'agent', id: 'turn', model_key: 'auto' },
    });
    const generate = vi.spyOn(SessionTitleService.prototype, 'generateTitle').mockResolvedValue(null);
    const session = {
      requireConfig: () => ({ getSessionId: () => 'session', getModel: () => 'auto' }),
      peekQueryRunner: () => ({ getTitleSourceMessages: async () => [original] }),
      signal: new AbortController().signal,
    } as unknown as ThreadSessionInternals;
    try {
      await expect(generateSessionTitle(session, {} as never, { description: '展示正文', sourceUserMessageId: 'wrong' }))
        .rejects.toMatchObject({ code: 'TITLE_BUSINESS_NOT_FOUND' });
      expect(generate).not.toHaveBeenCalled();
      await expect(generateSessionTitle(session, {} as never, { description: '展示正文', sourceUserMessageId: original.uuid }))
        .rejects.toMatchObject({ code: 'TITLE_GENERATION_FAILED' });
      generate.mockRejectedValue(new Error('network unavailable'));
      await expect(generateSessionTitle(session, {} as never, { description: '展示正文', sourceUserMessageId: original.uuid }))
        .rejects.toMatchObject({ code: 'TITLE_GENERATION_FAILED' });
    } finally {
      generate.mockRestore();
    }
  });

  it('captures the matching old turn before asynchronous generation', async () => {
    const old = createUserMessage('first');
    old.requestSetId = 'old';
    old.businessModelKey = 'ultimate';
    const next = createUserMessage('second');
    next.requestSetId = 'next';
    next.businessModelKey = 'auto';
    const messages = [old, next];
    const generate = vi
      .spyOn(SessionTitleService.prototype, 'generateTitle')
      .mockResolvedValue('Title');
    const session = {
      requireConfig: () => ({
        getSessionId: () => 'session',
        getModel: () => 'auto',
        getUtilityLlmClient: () => ({}),
      }),
      peekQueryRunner: () => ({ getMessages: () => messages }),
      signal: new AbortController().signal,
    } as unknown as ThreadSessionInternals;
    try {
      expect(
        await generateSessionTitle(session, {} as never, {
          description: 'first',
        }),
      ).toEqual({ title: 'Title' });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          businessInfo: expect.objectContaining({
            id: 'old',
            model_key: 'ultimate',
          }),
        }),
      );
      generate.mockClear();
      expect(
        await generateSessionTitle(session, {} as never, {
          description: 'missing',
        }),
      ).toEqual({ title: 'Title' });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          businessInfo: expect.objectContaining({
            id: 'old',
            model_key: 'ultimate',
          }),
        }),
      );
    } finally {
      generate.mockRestore();
    }
  });
});
