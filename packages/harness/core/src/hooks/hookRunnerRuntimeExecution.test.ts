/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { HookRunner } from './hookRunner.js';
import { normalizeExtensionFeatures } from '../extensions/extension-features.js';
import {
  HookEventName,
  HookType,
  ConfigSource,
  type HookAction,
  type RuntimeHookConfig,
} from './types.js';

function makeConfig(
  overrides: Partial<Record<keyof Config, unknown>> = {},
): Config {
  return {
    getProjectRoot: () => '/repo',
    isTrustedFolder: () => true,
    isInteractive: () => true,
    sanitizationConfig: { enableEnvironmentVariableRedaction: true },
    getSessionId: () => 'session-execution',
    getAllowedHttpHookUrls: () => undefined,
    getModel: () => 'gemini-2.0-flash',
    getSetting: (section: string) => {
      if (section === 'exampleSection') {
        return { nested: true };
      }
      return undefined;
    },
    ...overrides,
  } as unknown as Config;
}

describe('HookRunner runtime execution context wiring', () => {
  it.each([HookEventName.PostToolUse, HookEventName.PostToolUseFailure])(
    'carries features privately for %s without retaining the previous call',
    async (event) => {
      const runner = new HookRunner(makeConfig());
      const action = vi.fn<HookAction>(async () => undefined);
      const runtime: RuntimeHookConfig = {
        type: HookType.Runtime,
        name: 'features',
        action,
        internal: true,
      };
      const features = normalizeExtensionFeatures(
        'mcp',
        { eventId: 'one' }
      );
      const execution = Object.freeze({
        name: 'mcp_list',
        durationMs: 12,
        status: 'error',
        errorType: 'MCP_TOOL_ERROR',
        errorCode: 'EXPLICIT'
      });
      const input = {
        session_id: 's',
        cwd: '/repo',
        transcript_path: '',
        hook_event_name: event,
        tool_name: 'mcp_list',
        tool_use_id: 't',
        tool_input: {},
        tool_response: {},
        error: 'failure',
      };
      await runner.executeHook(
        runtime,
        event,
        input as never,
        undefined,
        0,
        {
          requestAttribution: {
            extensionFeatures: features,
            extensionExecution: execution
          },
        }
      );
      expect(
        vi.mocked(action).mock.calls[0][1]?.execution?.extensionFeatures,
      ).toBe(features);
      expect(
        vi.mocked(action).mock.calls[0][1]?.execution?.extensionExecution).toBe(execution);
      expect(vi.mocked(action).mock.calls[0][0]).not.toHaveProperty(
        'extensionFeatures',
      );
      expect(JSON.stringify(input)).not.toContain('eventId');
      expect(JSON.stringify(input)).not.toContain('EXPLICIT');
      expect(vi.mocked(action).mock.calls[0][0]).not.toHaveProperty(
        'extensionExecution');
      await runner.executeHook(
        runtime,
        event,
        input as never
      );
      expect(
        vi.mocked(action).mock.calls[1][1]?.execution?.extensionFeatures,
      ).toBeUndefined();
    },
  );
  it('passes a live execution context to the runtime action', async () => {
    const owner = { sessionId: 'session-execution' };
    const config = makeConfig({ getBuiltinSessionContext: () => owner });
    const runner = new HookRunner(config);
    const action: HookAction = vi.fn(async () => undefined);
    const runtime: RuntimeHookConfig = {
      type: HookType.Runtime,
      event: HookEventName.PreToolUse,
      name: 'test-runtime',
      action,
      source: ConfigSource.User,
    } as RuntimeHookConfig;

    await runner.executeHook(runtime, HookEventName.PreToolUse, {
      session_id: 'session-execution',
      transcript_path: '/tmp/transcript',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Shell',
      tool_input: {},
    } as never);

    const actionMock = vi.mocked(action);
    expect(actionMock).toHaveBeenCalledOnce();
    const options = actionMock.mock.calls[0][1];
    expect(options?.execution).toBeDefined();
    expect(options?.execution?.getSessionContext?.()).toBe(owner);
    expect(typeof options?.execution?.isSdkMode).toBe('boolean');
    expect(options?.execution?.getSetting('exampleSection')).toEqual({
      nested: true,
    });
    expect(options?.execution?.getSetting('unknownSection')).toBeUndefined();
  });

  it('starts explicitly opted-in completed-write PostToolUse after parent cancellation', async () => {
    const runner = new HookRunner(makeConfig());
    const action: HookAction = vi.fn(async (_input, options) => {
      expect(options?.signal.aborted).toBe(false);
    });
    const runtime: RuntimeHookConfig = {
      type: HookType.Runtime,
      name: 'internal-file-write',
      action,
      internal: true,
      runAfterCancellation: 'completed-file-write',
      timeout: 1,
    };
    const controller = new AbortController();
    controller.abort();

    const result = await runner.executeHook(
      runtime,
      HookEventName.PostToolUse,
      {
        session_id: 'session-write',
        transcript_path: '/tmp/transcript',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-use-1',
        tool_name: 'Write',
        tool_input: {},
        tool_response: {},
        file_write: {
          file_path: '/repo/file.ts',
          workspace_path: '/repo',
          original_content: '',
          proposed_content: 'after',
          written_content: 'after',
        },
      } as never,
      controller.signal,
    );

    expect(result.success).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it('still skips internal Runtime Hooks without the cancellation capability', async () => {
    const runner = new HookRunner(makeConfig());
    const action: HookAction = vi.fn(async () => undefined);
    const runtime: RuntimeHookConfig = {
      type: HookType.Runtime,
      name: 'internal-file-write',
      action,
      internal: true,
    };
    const controller = new AbortController();
    controller.abort();

    const result = await runner.executeHook(
      runtime,
      HookEventName.PostToolUse,
      {
        session_id: 'session-write',
        transcript_path: '/tmp/transcript',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tool-use-1',
        tool_name: 'Write',
        tool_input: {},
        tool_response: {},
        file_write: {
          file_path: '/repo/file.ts',
          workspace_path: '/repo',
          original_content: '',
          proposed_content: 'after',
          written_content: 'after',
        },
      } as never,
      controller.signal,
    );

    expect(result.success).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('delegates getSetting to Config.getSetting for arbitrary sections', async () => {
    const getSetting = vi.fn((section: string) =>
      section === 'otherSection' ? { nested: false } : undefined,
    );
    const config = makeConfig({ getSetting } as Partial<
      Record<keyof Config, unknown>
    >);
    const runner = new HookRunner(config);
    const action: HookAction = vi.fn(async () => undefined);
    const runtime: RuntimeHookConfig = {
      type: HookType.Runtime,
      event: HookEventName.PostToolUse,
      name: 'test-runtime',
      action,
      source: ConfigSource.User,
    } as RuntimeHookConfig;

    await runner.executeHook(runtime, HookEventName.PostToolUse, {
      session_id: 'session-arbitrary',
      transcript_path: '/tmp/transcript',
      cwd: '/repo',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {},
    } as never);

    const options = vi.mocked(action).mock.calls[0][1];
    const result = options?.execution?.getSetting('otherSection');
    expect(result).toEqual({ nested: false });
    expect(getSetting).toHaveBeenCalledWith('otherSection');
  });
});
