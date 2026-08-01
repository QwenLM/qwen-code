/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createLiveTaskTools,
  LIVE_TASK_TOOL_NAMES,
} from './live-task-tools.js';

describe('createLiveTaskTools', () => {
  it('registers exactly the five Codex Live task operations', () => {
    const tools = createLiveTaskTools(vi.fn());
    expect(tools.map((tool) => tool.name)).toEqual(LIVE_TASK_TOOL_NAMES);
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
});
