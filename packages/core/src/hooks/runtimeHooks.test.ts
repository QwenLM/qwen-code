/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookSystem } from './hookSystem.js';
import { DefaultHookCoordinator } from './coordinators.js';
import { Config } from '../config/config.js';
import { HookType, HookEventName, ConfigSource } from './types.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Mock console methods
vi.stubGlobal('console', {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

vi.mock('../goal/registerGoalHooks.js', () => ({
  getGoalHooksConfiguration: vi.fn().mockReturnValue({}),
}));

describe('Runtime Hooks', () => {
  let hookSystem: HookSystem;
  let config: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    const testDir = path.join(os.tmpdir(), 'test-runtime-hooks');
    fs.mkdirSync(testDir, { recursive: true });

    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      model: 'gemini-3-flash-preview',
      targetDir: testDir,
      sessionId: 'test-session',
      debugMode: false,
      cwd: testDir,
    });
    hookSystem = new HookSystem(config);
  });

  it('should register a runtime hook', async () => {
    await hookSystem.initialize();

    const action = vi.fn().mockResolvedValue(undefined);
    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'test-hook',
        action,
      },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );

    const hooks = hookSystem.getAllHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].config.type).toBe(HookType.Runtime);
    expect((hooks[0].config as { name: string }).name).toBe('test-hook');
    expect(hooks[0].source).toBe(ConfigSource.Runtime);
  });

  it.each([undefined, ['https://example.com/prompt.png']])(
    'passes the entry request-set ID through the coordinator to runtime hooks with images %j',
    async (imageUrls) => {
      await hookSystem.initialize();
      const onSubmit = vi.fn();
      const onEnd = vi.fn();
      hookSystem.registerHook(
        { type: HookType.Runtime, name: 'capture-submit', action: onSubmit },
        HookEventName.UserPromptSubmit,
      );
      hookSystem.registerHook(
        { type: HookType.Runtime, name: 'capture-end', action: onEnd },
        HookEventName.QueryEnd,
      );
      const coordinator = new DefaultHookCoordinator(hookSystem);

      await coordinator.fireBefore(
        'prompt-1',
        'hello',
        imageUrls,
        'request-set-1',
      );
      await coordinator.fireBefore(
        'prompt-1',
        'hello',
        imageUrls,
        'request-set-1',
      );
      await hookSystem.fireQueryEndEvent(
        'request-set-1',
        undefined,
        'test-model',
        'end_turn',
      );

      expect(onSubmit).toHaveBeenCalledOnce();
      const submitInput = onSubmit.mock.calls[0][0];
      expect(submitInput).toMatchObject({
        session_id: 'test-session',
        hook_event_name: HookEventName.UserPromptSubmit,
        prompt: 'hello',
        request_set_id: 'request-set-1',
      });
      expect(submitInput).not.toHaveProperty('prompt_id');
      expect(submitInput.image_urls).toEqual(imageUrls);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd.mock.calls[0][0].request_set_id).toBe(
        submitInput.request_set_id,
      );
      coordinator.dispose();
    },
  );

  it('keeps internal runtime hooks active when user hooks are disabled', async () => {
    await hookSystem.initialize();
    const ordinary = vi.fn().mockResolvedValue(undefined);
    const internal = vi.fn().mockResolvedValue(undefined);
    hookSystem.registerHook(
      { type: HookType.Runtime, name: 'ordinary', action: ordinary },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );
    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'internal',
        action: internal,
        internal: true,
      },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );
    config.setAllHooksDisabled(true);

    await hookSystem
      .getEventHandler()
      .firePreToolUseEvent('TestTool', {}, 'tool-use-1');

    expect(ordinary).not.toHaveBeenCalled();
    expect(internal).toHaveBeenCalledOnce();
  });

  it('should execute a runtime hook', async () => {
    await hookSystem.initialize();

    const action = vi.fn().mockImplementation(async () => ({
      decision: 'allow',
      systemMessage: 'Hook ran',
    }));

    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'test-hook',
        action,
      },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );

    const result = await hookSystem
      .getEventHandler()
      .firePreToolUseEvent('TestTool', { foo: 'bar' }, 'tool-use-1');

    expect(action).toHaveBeenCalled();
    expect(action.mock.calls[0][0]).toMatchObject({
      tool_name: 'TestTool',
      tool_input: { foo: 'bar' },
      hook_event_name: 'PreToolUse',
    });

    expect(result.finalOutput?.systemMessage).toBe('Hook ran');
  });

  it('should handle runtime hook errors', async () => {
    await hookSystem.initialize();

    const action = vi.fn().mockRejectedValue(new Error('Hook failed'));

    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'fail-hook',
        action,
      },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );

    // Should not throw, but handle error gracefully
    await hookSystem
      .getEventHandler()
      .firePreToolUseEvent('TestTool', {}, 'tool-use-2');

    expect(action).toHaveBeenCalled();
  });

  it('should pass lifecycle context to Stop runtime hooks', async () => {
    await hookSystem.initialize();

    const businessInfo: Readonly<BusinessInfo> = {
      version: 'test',
      id: 'business-1',
      product: 'cli',
      type: 'agent',
    };
    const action = vi.fn().mockResolvedValue(undefined);

    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'stop-hook',
        action,
      },
      HookEventName.Stop,
    );

    await hookSystem.fireStopEvent('prompt', 'response', false, {
      parentRequestSetId: 'request-set-1',
      parentBusinessInfo: businessInfo,
    });

    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        hook_event_name: HookEventName.Stop,
        last_assistant_message: 'response',
        parent_request_set_id: 'request-set-1',
        parent_business_info: businessInfo,
      }),
      expect.any(Object),
    );
  });

  it('should preserve runtime hooks across re-initialization', async () => {
    await hookSystem.initialize();

    hookSystem.registerHook(
      {
        type: HookType.Runtime,
        name: 'persist-hook',
        action: async () => {},
      },
      HookEventName.PreToolUse,
      { matcher: 'TestTool' },
    );

    expect(hookSystem.getAllHooks()).toHaveLength(1);

    // Re-initialize
    await hookSystem.initialize();

    expect(hookSystem.getAllHooks()).toHaveLength(1);
    expect((hookSystem.getAllHooks()[0].config as { name: string }).name).toBe(
      'persist-hook',
    );
  });
});
