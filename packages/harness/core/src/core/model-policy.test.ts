/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createModelSelectionPolicy,
  queryModelSelectContext,
} from './model-policy.js';
import type {
  GetModelPolicyCallback,
  ModelPolicyInput,
} from './model-policy.js';
import { testModelResolution } from '../test-utils/model-resolution.js';

const request: ModelPolicyInput = { sessionId: 'session-1', turnIndex: 0 };
function resolve(host: GetModelPolicyCallback) {
  return createModelSelectionPolicy(host)(
    { purpose: 'main', request },
    testModelResolution('base-model'),
  );
}

describe('SDK request model policy', () => {
  it('只转换宿主模型名、配置与归因，把选模留给 selector', async () => {
    const host = vi.fn(async () => ({
      model: 'policy-model',
      parameters: { reasoningEffort: 'high' as const, contextWindow: 256_000 },
      labels: { taskId: 'sdk_scene', subTask: 'billing_tag' },
    }));
    expect(await resolve(host)).toEqual({
      key: 'policy-model',
      config: {
        reasoning: { effort: 'high' },
        context: { contextWindow: 256_000 },
      },
      labels: { taskId: 'sdk_scene', subTask: 'billing_tag' },
    });
    expect(host).toHaveBeenCalledOnce();
  });

  it('仅配置覆盖不指定模型、不补默认配置', async () => {
    expect(
      await resolve(async () => ({
        parameters: { reasoningEffort: 'none', contextWindow: 128_000 },
      })),
    ).toEqual({
      key: undefined,
      config: {
        reasoning: { effort: 'none' },
        context: { contextWindow: 128_000 },
      },
      labels: undefined,
    });
  });

  it('宿主明确不覆盖时不生成补丁', async () => {
    expect(await resolve(async () => undefined)).toBeUndefined();
  });

  it.each([{}, { model: '' }])('空响应 %s 不补默认值', async (result) => {
    expect(await resolve(async () => result)).toEqual({
      key: undefined,
      config: undefined,
      labels: undefined,
    });
  });

  it('只有模型覆盖时不补配置或归因', async () => {
    expect(await resolve(async () => ({ model: 'base-model' }))).toEqual({
      key: 'base-model',
      config: undefined,
      labels: undefined,
    });
  });

  it.each([{}, { taskId: 'sdk_scene' }])(
    '独立保留归因 %s，不伪造模型',
    async (labels) => {
      expect(await resolve(async () => ({ labels }))).toEqual({
        key: undefined,
        config: undefined,
        labels,
      });
    },
  );

  it('向宿主传递已选模型、子任务身份、使用量、重试与取消信号', async () => {
    const signal = new AbortController().signal;
    const retry = { attempt: 2, lastError: 'retry', lastModelId: 'previous' };
    const host = vi.fn(async () => undefined);
    await createModelSelectionPolicy(host)(
      {
        purpose: 'task',
        signal,
        request: {
          ...request,
          agentId: 'agent-run-1',
          agentType: 'bash-agent',
          cumulativeUsage: { input_tokens: 100, output_tokens: 20 },
          retry,
        },
      },
      testModelResolution('subagent-model'),
    );
    expect(host).toHaveBeenCalledWith(
      'subagent',
      'session-1',
      0,
      'agent-run-1',
      signal,
      {
        resolvedModel: 'subagent-model',
        agentType: 'bash-agent',
        estimatedInputTokens: 100,
        retry,
      },
    );
  });

  it('基础选模失败不伪造 resolvedModel，渠道字段不进入通用选模补丁', async () => {
    const host = vi.fn(async () => ({
      model: 'external/model',
      parameters: { outerProvider: 'external' },
    }));
    expect(
      await createModelSelectionPolicy(host)(
        { purpose: 'main', request },
        undefined,
      ),
    ).toEqual({ key: 'external/model', config: undefined, labels: undefined });
    expect(host).toHaveBeenCalledWith(
      'main',
      'session-1',
      0,
      undefined,
      undefined,
      {},
    );
  });

  it('策略失败原样透传', async () => {
    const failure = new Error('boom');
    await expect(
      resolve(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe('query purpose protocol mapping', () => {
  it.each([
    { input: {}, purpose: 'main', policyPurpose: 'main' },
    { input: { isSubagent: true }, purpose: 'task', policyPurpose: 'task' },
    {
      input: { purpose: 'side_question' as const },
      purpose: 'side_question',
      policyPurpose: 'utility',
    },
    {
      input: { purpose: 'fork' as const },
      purpose: 'fork',
      policyPurpose: 'main',
    },
    {
      input: { purpose: 'fork' as const, isSubagent: true },
      purpose: 'fork',
      policyPurpose: 'task',
    },
    {
      input: { purpose: 'hook_prompt' as const, isSubagent: true },
      purpose: 'hook_prompt',
      policyPurpose: 'hook_prompt',
    },
    {
      input: {},
      purpose: 'main',
      policyPurpose: 'main',
    },
  ])(
    'maps $input to the original SDK purpose',
    ({ input, purpose, policyPurpose }) => {
      expect(queryModelSelectContext(input)).toEqual({
        purpose,
        policyPurpose,
      });
    },
  );
});
