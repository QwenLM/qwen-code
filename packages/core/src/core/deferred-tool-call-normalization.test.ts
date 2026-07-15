/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode, Config } from '../config/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  getFunctionSchemaFingerprint,
  ToolRegistry,
} from '../tools/tool-registry.js';
import type { ToolCallRequestInfo } from './turn.js';
import {
  normalizeDeferredToolCallRequest,
  providerToolName,
} from './deferred-tool-call-normalization.js';

const baseConfigParams = {
  cwd: '/tmp',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  sandbox: undefined,
  targetDir: '/test/dir',
  debugMode: false,
  userMemory: '',
  geminiMdFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
};

function createRegistry(): ToolRegistry {
  const config = new Config(baseConfigParams);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  return registry;
}

function request(
  name: string,
  args: Record<string, unknown> = {},
): ToolCallRequestInfo {
  return {
    callId: 'call-1',
    name,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt-1',
  };
}

describe('normalizeDeferredToolCallRequest', () => {
  it('passes ordinary tool requests through unchanged', async () => {
    const registry = createRegistry();
    const original = request(ToolNames.READ_FILE, { path: 'README.md' });

    const result = await normalizeDeferredToolCallRequest(original, registry);

    expect(result).toEqual({ ok: true, request: original });
  });

  it('normalizes a valid proxy request to the deferred target', async () => {
    const registry = createRegistry();
    const target = new MockTool({
      name: ToolNames.CRON_CREATE,
      shouldDefer: true,
    });
    registry.registerTool(target);
    registry.markProxySchemaPresented({
      name: ToolNames.CRON_CREATE,
      schemaFingerprint: getFunctionSchemaFingerprint(target.schema),
    });

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 9 * * *' },
      }),
      registry,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedTool).toBe(target);
      expect(result.request.name).toBe(ToolNames.CRON_CREATE);
      expect(result.request.args).toEqual({ schedule: '0 9 * * *' });
      expect(result.request.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
      expect(providerToolName(result.request)).toBe(
        ToolNames.DEFERRED_TOOL_CALL,
      );
    }
  });

  it('rejects a target replaced while normalization is in progress', async () => {
    const registry = createRegistry();
    const authorizedTool = new MockTool({
      name: ToolNames.CRON_CREATE,
      shouldDefer: true,
    });
    const replacementTool = new MockTool({
      name: ToolNames.CRON_CREATE,
      shouldDefer: true,
    });
    registry.registerTool(authorizedTool);
    vi.spyOn(registry, 'ensureTool').mockResolvedValue(authorizedTool);
    vi.spyOn(registry, 'getTool').mockReturnValue(replacementTool);

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 9 * * *' },
      }),
      registry,
    );

    expect(result).toMatchObject({
      ok: false,
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: { message: expect.stringContaining('changed') },
    });
  });

  it.each([
    ['missing name', { arguments: {} }, 'must be the exact deferred tool name'],
    [
      'empty name',
      { name: '  ', arguments: {} },
      'must be the exact deferred tool name',
    ],
    [
      'non-object arguments',
      { name: ToolNames.CRON_CREATE, arguments: 'bad' },
      'must be an object',
    ],
    [
      'array arguments',
      { name: ToolNames.CRON_CREATE, arguments: [] },
      'must be an object',
    ],
    [
      'null arguments',
      { name: ToolNames.CRON_CREATE, arguments: null },
      'must be an object',
    ],
    [
      'self-target',
      { name: ToolNames.DEFERRED_TOOL_CALL, arguments: {} },
      'cannot target itself',
    ],
  ])('rejects malformed proxy request: %s', async (_name, args, message) => {
    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, args),
      createRegistry(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
      expect(result.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
      expect(result.error.message).toContain(message);
    }
  });

  it('rejects a missing target tool', async () => {
    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: {},
      }),
      createRegistry(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(ToolErrorType.TOOL_NOT_REGISTERED);
      expect(result.error.message).toContain('is not available');
    }
  });

  it('rejects a target tool that fails to load', async () => {
    const registry = createRegistry();
    vi.spyOn(registry, 'ensureTool').mockRejectedValueOnce(
      new Error('factory exploded'),
    );

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: {},
      }),
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
      expect(result.errorType).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(result.error.message).toContain(
        'Failed to load deferred tool "cron_create": factory exploded',
      );
    }
  });

  it('rejects a target that is not proxy-eligible deferred', async () => {
    const registry = createRegistry();
    registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.READ_FILE,
        arguments: {},
      }),
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
      expect(result.error.message).toContain('not eligible');
    }
  });

  it('rejects a deferred target whose schema was not presented', async () => {
    const registry = createRegistry();
    registry.registerTool(
      new MockTool({ name: ToolNames.CRON_CREATE, shouldDefer: true }),
    );

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: {},
      }),
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
      expect(result.error.message).toContain('has not been fetched');
    }
  });
});
