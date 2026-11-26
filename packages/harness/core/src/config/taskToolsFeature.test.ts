/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from './agent-loop-context.js';
import { Config } from './config.js';
import { TASKS_FEATURE_ENV } from './feature-flags.js';
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../tools/tool-names.js';

describe('persistent task tool registration', () => {
  const baseParams = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test-session',
    targetDir: os.tmpdir(),
    cwd: os.tmpdir(),
    model: 'gemini-1.5-pro',
    debugMode: false,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the four task tools and omits TodoWrite by default', async () => {
    const config = new Config(baseParams);
    await config.initialize();
    const registry = (config as AgentLoopContext).toolRegistry;

    expect(registry.getTool(TASK_CREATE_TOOL_NAME)).toBeDefined();
    expect(registry.getTool(TASK_GET_TOOL_NAME)).toBeDefined();
    expect(registry.getTool(TASK_UPDATE_TOOL_NAME)).toBeDefined();
    expect(registry.getTool(TASK_LIST_TOOL_NAME)).toBeDefined();
    expect(registry.getTool(WRITE_TODOS_TOOL_NAME)).toBeUndefined();
    const visibleToolNames = registry
      .getFunctionDeclarations()
      .map((declaration) => declaration.name);
    expect(visibleToolNames).toEqual(
      expect.arrayContaining([
        TASK_CREATE_TOOL_NAME,
        TASK_GET_TOOL_NAME,
        TASK_UPDATE_TOOL_NAME,
        TASK_LIST_TOOL_NAME,
      ]),
    );
  });

  it('registers only TodoWrite when persistent tasks are disabled', async () => {
    vi.stubEnv(TASKS_FEATURE_ENV, 'false');
    const config = new Config(baseParams);
    await config.initialize();
    const registry = (config as AgentLoopContext).toolRegistry;

    expect(registry.getTool(TASK_CREATE_TOOL_NAME)).toBeUndefined();
    expect(registry.getTool(TASK_GET_TOOL_NAME)).toBeUndefined();
    expect(registry.getTool(TASK_UPDATE_TOOL_NAME)).toBeUndefined();
    expect(registry.getTool(TASK_LIST_TOOL_NAME)).toBeUndefined();
    expect(registry.getTool(WRITE_TODOS_TOOL_NAME)).toBeDefined();
  });

  it('accepts the standard numeric false value', async () => {
    vi.stubEnv(TASKS_FEATURE_ENV, '0');
    const config = new Config(baseParams);
    await config.initialize();
    const registry = (config as AgentLoopContext).toolRegistry;

    expect(registry.getTool(TASK_CREATE_TOOL_NAME)).toBeUndefined();
    expect(registry.getTool(WRITE_TODOS_TOOL_NAME)).toBeDefined();
  });

  it('switches the task store when the active session changes', () => {
    const config = new Config(baseParams);
    const initialStore = config.getTaskStore();

    config.setSessionId('resumed-session');
    const resumedStore = config.getTaskStore();

    expect(initialStore.taskListId).toBe('test-session');
    expect(resumedStore.taskListId).toBe('resumed-session');
    expect(resumedStore).not.toBe(initialStore);
  });
});
