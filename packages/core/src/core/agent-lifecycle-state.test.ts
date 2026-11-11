/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_BUSINESS_PRODUCT, ENV_BUSINESS_SUB_TASK, ENV_BUSINESS_TYPE } from "../config/brand.js";

import { describe, it, expect, afterEach } from 'vitest';
import {
  AgentLifecycleState,
  createQueryBusinessInfo,
  resolveBusinessIdentity,
} from './agent-lifecycle-state.js';
import { BusinessStageError } from '../qoder/business-info.js';

const ENV_KEYS = [
  ENV_BUSINESS_PRODUCT,
  ENV_BUSINESS_SUB_TASK,
  ENV_BUSINESS_TYPE,
] as const;

describe('resolveBusinessIdentity', () => {
  it('并发 Query 的显式业务类型分别固化，不修改全局默认值', async () => {
    const before = resolveBusinessIdentity();
    const [agent, review] = await Promise.all([
      createQueryBusinessInfo('session-a', '分析', 'turn-a', undefined, 'auto', 'agent'),
      createQueryBusinessInfo('session-b', '评审', 'turn-b', undefined, 'auto', 'code_review'),
    ]);
    expect(agent).toMatchObject({ id: 'turn-a', type: 'agent', product: before.product });
    expect(review).toMatchObject({ id: 'turn-b', type: 'code_review', product: before.product });
    expect(resolveBusinessIdentity()).toEqual(before);
  });
  const original: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    [ENV_BUSINESS_PRODUCT]: process.env[ENV_BUSINESS_PRODUCT],
    [ENV_BUSINESS_SUB_TASK]: process.env[ENV_BUSINESS_SUB_TASK],
    [ENV_BUSINESS_TYPE]: process.env[ENV_BUSINESS_TYPE],
  };

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function clearAll() {
    for (const key of ENV_KEYS) delete process.env[key];
  }

  it('defaults to cli/agent when no env vars are set', () => {
    clearAll();
    expect(resolveBusinessIdentity()).toEqual({ product: 'cli', type: 'agent' });
  });

  it('lets ENV_BUSINESS_TYPE override the default type', () => {
    clearAll();
    process.env[ENV_BUSINESS_TYPE] = 'custom-type';
    expect(resolveBusinessIdentity()).toEqual({
      product: 'cli',
      type: 'custom-type',
    });
  });

  it('lets ENV_BUSINESS_PRODUCT override the product without affecting type', () => {
    clearAll();
    process.env[ENV_BUSINESS_PRODUCT] = 'custom-product';
    expect(resolveBusinessIdentity()).toEqual({
      product: 'custom-product',
      type: 'agent',
    });
  });

  it('lets both env vars override at once', () => {
    clearAll();
    process.env[ENV_BUSINESS_PRODUCT] = 'p';
    process.env[ENV_BUSINESS_TYPE] = 't';
    expect(resolveBusinessIdentity()).toEqual({ product: 'p', type: 't' });
  });

  it('env override wins over integration mode for both fields', () => {
    clearAll();
    process.env[ENV_BUSINESS_PRODUCT] = 'p';
    process.env[ENV_BUSINESS_TYPE] = 't';
    expect(resolveBusinessIdentity()).toEqual({ product: 'p', type: 't' });
  });

  it('reads ENV_BUSINESS_SUB_TASK into root business info', async () => {
    clearAll();
    process.env[ENV_BUSINESS_SUB_TASK] = 'code-review-summary';

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'summarize changes',
    );

    expect(lifecycle.businessInfo).toEqual(
      expect.objectContaining({
        product: 'cli',
        type: 'agent',
        sub_task: 'code-review-summary',
      }),
    );
  });

  it('uses a bounded prompt prefix for long root business names', async () => {
    clearAll();
    const prompt = `0123456789${'x'.repeat(200_000)}`;

    const lifecycle = await AgentLifecycleState.create('session-1', prompt);

    expect(lifecycle.businessInfo.name).toBe('0123456789');
  });

  it('omits empty ENV_BUSINESS_SUB_TASK from root business info', async () => {
    clearAll();
    process.env[ENV_BUSINESS_SUB_TASK] = '';

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'summarize changes',
    );

    expect(lifecycle.businessInfo).not.toHaveProperty('sub_task');
  });

  it('lets explicit prompt-suggestion querySource override env sub_task', async () => {
    clearAll();
    process.env[ENV_BUSINESS_SUB_TASK] = 'env-task';

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'suggest next prompt',
      'prompt_suggestion',
    );

    expect(lifecycle.businessInfo).toEqual(
      expect.objectContaining({
        sub_task: 'prompt_suggestion',
      }),
    );
  });

  it('maps a built-in subagent type instead of inheriting the parent sub_task', async () => {
    clearAll();
    process.env[ENV_BUSINESS_SUB_TASK] = 'env-task';

    const lifecycle = await AgentLifecycleState.createForSubagent(
      'session-1',
      'inspect the repository',
      {
        version: '1.2.3',
        id: 'parent-business-id',
        sub_task: 'parent-task',
      },
      'prompt-subagent-1',
      'parent-request-set-1',
      'Explore',
    );

    expect(lifecycle.businessInfo).toEqual(
      expect.objectContaining({
        id: 'parent-business-id',
        sub_task: 'agent_sub_explore',
      }),
    );
    expect(lifecycle.subagentContext?.agentType).toBe('Explore');
  });

  it('uses the custom subagent label when an older caller omits its type', async () => {
    clearAll();

    const lifecycle = await AgentLifecycleState.createForSubagent(
      'session-1',
      'inspect the repository',
      { version: '1.2.3', id: 'parent-business-id' },
    );

    expect(lifecycle.businessInfo.sub_task).toBe('agent_sub_custom');
    expect(lifecycle.subagentContext?.agentType).toBe('subagent');
  });

  it('does not expose a custom agent name as a business dimension', async () => {
    clearAll();

    const lifecycle = await AgentLifecycleState.createForSubagent(
      'session-1',
      'review the repository',
      { version: '1.2.3', id: 'parent-business-id' },
      'prompt-subagent-custom',
      'parent-request-set-1',
      'TeamSpecificReviewer',
    );

    expect(lifecycle.businessInfo.sub_task).toBe('agent_sub_custom');
    expect(lifecycle.subagentContext?.agentType).toBe('TeamSpecificReviewer');
  });

  it('uses caller-provided requestSetId for root lifecycle and aligns businessInfo.id', async () => {
    clearAll();

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'trace this turn',
      'sdk',
      'assistant-message-id-1',
    );

    expect(lifecycle.requestSetId).toBe('assistant-message-id-1');
    expect(lifecycle.businessInfo.id).toBe('assistant-message-id-1');
  });

  it('uses a preallocated requestSetId without overriding businessInfo.id', async () => {
    clearAll();

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'trace this turn',
      'sdk',
      undefined,
      'preallocated-request-set-1',
    );

    expect(lifecycle.requestSetId).toBe('preallocated-request-set-1');
    expect(lifecycle.businessInfo.id).not.toBe('preallocated-request-set-1');
  });

  it('keeps the external override precedence over a preallocated requestSetId', async () => {
    clearAll();

    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'trace this turn',
      'sdk',
      'external-request-set-1',
      'preallocated-request-set-1',
    );

    expect(lifecycle.requestSetId).toBe('external-request-set-1');
    expect(lifecycle.businessInfo.id).toBe('external-request-set-1');
  });

  it('maps max_turns to an error business stage', async () => {
    clearAll();
    const lifecycle = await AgentLifecycleState.create(
      'session-1',
      'continue until the turn limit',
    );

    lifecycle.finalize('max_turns');

    expect(lifecycle.businessInfo).toEqual(
      expect.objectContaining({
        stage: BusinessStageError,
        end_at: expect.any(Number),
      }),
    );
  });
});


describe('preallocated business attribution', () => {
  it('keeps the supplied business independently of task IDs and copies it', async () => {
    const parent = Object.freeze({
      id: 'main-business',
      name: 'original prompt',
      product: 'cli',
      type: 'agent',
      version: '1',
    });
    const state = await AgentLifecycleState.create(
      'session',
      'derived prompt',
      'tui',
      'task-id',
      undefined,
      parent,
    );
    expect(state.businessInfo).toEqual(parent);
    expect(state.businessInfo).not.toBe(parent);
    expect(state.requestSetId).toBe('task-id');
  });
});


it('inherits the frozen user model through lifecycle and subagent routing', async () => {
  const business = await createQueryBusinessInfo(
    'session',
    'prompt',
    'business',
    'tui',
    'ultimate',
  );
  const main = await AgentLifecycleState.create(
    'session',
    'prompt',
    'tui',
    'task',
    undefined,
    business,
  );
  const child = await AgentLifecycleState.createForSubagent(
    'session',
    'child',
    main.businessInfo,
    'child-prompt',
    'task',
    'Explore',
  );
  expect(child.businessInfo).toMatchObject({
    id: 'business',
    model_key: 'ultimate',
    sub_task: 'agent_sub_explore',
  });
  expect(business).toMatchObject({ id: 'business', model_key: 'ultimate' });
  expect(business.sub_task).toBeUndefined();
});
