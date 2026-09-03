/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  createLiveTaskTools,
  LIVE_TASK_TOOL_NAMES,
} from './live-task-tools.js';

describe('createLiveTaskTools', () => {
  it('registers exactly the five Codex Live task operations', () => {
    const tools = createLiveTaskTools(vi.fn());
    expect(tools.map((tool) => tool.name)).toEqual(LIVE_TASK_TOOL_NAMES);
    expect(
      tools.find((tool) => tool.name === 'create_thread')?.description,
    ).toContain('The active Live conversation is not that separate task');
    expect(
      tools.find((tool) => tool.name === 'wait_threads')?.description,
    ).toContain('does not mean that a task failed');
  });

  it('uses the trusted app-task permission path and forwards the request', async () => {
    const execute = vi.fn(async (name, params) => ({ name, params }));
    const tool = createLiveTaskTools(execute)[0]!;
    const invocation = tool.build({ limit: 3 });

    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    const result = await invocation.execute(new AbortController().signal);

    expect(execute).toHaveBeenCalledWith('list_threads', { limit: 3 });
    expect(JSON.parse(String(result.llmContent))).toEqual({
      name: 'list_threads',
      params: { limit: 3 },
    });
  });

  it('returns an observation timeout as a completed tool result', async () => {
    const execute = vi.fn(async () => ({
      timedOut: true,
      wake: null,
      polls: [{ status: 'running' }],
    }));
    const tool = createLiveTaskTools(execute).find(
      (candidate) => candidate.name === 'wait_threads',
    )!;

    const result = await tool
      .build({ targets: [{ threadId: 'task-1', hostId: 'local' }] })
      .execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toEqual({
      timedOut: true,
      wake: null,
      polls: [{ status: 'running' }],
    });
  });
});
