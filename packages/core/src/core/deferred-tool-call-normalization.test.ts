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
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolCallRequestInfo } from './turn.js';
import {
  formatPermissionToolIdentity,
  normalizeDeferredToolCallRequest,
  providerToolName,
  unwrapDeferredToolCallShape,
  withPermissionToolIdentity,
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

function createRegistry(options?: {
  withoutProxyPair?: boolean;
}): ToolRegistry {
  const config = new Config(baseConfigParams);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  if (!options?.withoutProxyPair) {
    registry.registerFactory(
      ToolNames.TOOL_SEARCH,
      async () => new MockTool({ name: ToolNames.TOOL_SEARCH }),
    );
    registry.registerFactory(
      ToolNames.DEFERRED_TOOL_CALL,
      async () => new MockTool({ name: ToolNames.DEFERRED_TOOL_CALL }),
      { allowReservedName: true },
    );
  }
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

  it('normalizes a legacy migrated name to the canonical target', async () => {
    const registry = createRegistry();
    const target = new MockTool({
      name: ToolNames.AGENT,
      shouldDefer: true,
    });
    registry.registerTool(target);
    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: 'task',
        arguments: { description: 'legacy alias call' },
      }),
      registry,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedTool).toBe(target);
      expect(result.request.name).toBe(ToolNames.AGENT);
      expect(result.request.args).toEqual({
        description: 'legacy alias call',
      });
      expect(result.request.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
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
      const attemptedTarget = (args as Record<string, unknown>)['name'];
      expect(result.targetName).toBe(
        typeof attemptedTarget === 'string' && attemptedTarget.trim()
          ? attemptedTarget
          : undefined,
      );
      expect(result.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
      expect(result.error.message).toContain(message);
    }
  });

  it('rejects a missing target tool', async () => {
    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: 'task',
        arguments: {},
      }),
      createRegistry(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.targetName).toBe(ToolNames.AGENT);
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

  it('rejects a deferred target that is declared directly', async () => {
    const registry = createRegistry();
    registry.registerTool(
      new MockTool({ name: ToolNames.CRON_CREATE, shouldDefer: true }),
    );
    registry.revealDeferredTool(ToolNames.CRON_CREATE);

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
      expect(result.error.message).toContain('Call directly');
    }
  });

  it('targets a live eligible deferred tool directly', async () => {
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.name).toBe(ToolNames.CRON_CREATE);
      expect(result.request.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
    }
  });

  it('rejects a wrapper call when the discovery/proxy pair is unregistered', async () => {
    const registry = createRegistry({ withoutProxyPair: true });
    const ensureTool = vi.spyOn(registry, 'ensureTool');
    registry.registerTool(
      new MockTool({ name: ToolNames.CRON_CREATE, shouldDefer: true }),
    );

    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 9 * * *' },
      }),
      registry,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
      expect(result.errorType).toBe(ToolErrorType.TOOL_NOT_REGISTERED);
      expect(result.error.message).toContain('not available in this session');
      expect(result.error.message).toContain('directly by its real name');
      expect(result.error.message).not.toContain(ToolNames.TOOL_SEARCH);
    }
    // The rejection must happen before any target resolution side effect.
    expect(ensureTool).not.toHaveBeenCalled();
  });

  it('keeps Object.prototype-colliding target names intact for diagnostics', async () => {
    const result = await normalizeDeferredToolCallRequest(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: 'constructor',
        arguments: {},
      }),
      createRegistry(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.targetName).toBe('constructor');
      expect(result.errorType).toBe(ToolErrorType.TOOL_NOT_REGISTERED);
      expect(result.error.message).toContain('"constructor"');
    }
  });
});

describe('unwrapDeferredToolCallShape', () => {
  it('passes non-wrapper requests through unchanged', () => {
    const ordinary = request(ToolNames.READ_FILE, { path: 'README.md' });

    expect(unwrapDeferredToolCallShape(ordinary)).toBe(ordinary);
  });

  it.each([
    ['missing name', { arguments: {} }],
    ['blank name', { name: '  ', arguments: {} }],
    ['non-string name', { name: 42, arguments: {} }],
    ['missing arguments', { name: ToolNames.CRON_CREATE }],
    ['string arguments', { name: ToolNames.CRON_CREATE, arguments: 'bad' }],
    ['array arguments', { name: ToolNames.CRON_CREATE, arguments: [] }],
  ])('returns malformed wrapper request unchanged: %s', (_label, args) => {
    const malformed = request(ToolNames.DEFERRED_TOOL_CALL, args);

    expect(unwrapDeferredToolCallShape(malformed)).toBe(malformed);
  });

  it('unwraps a well-formed wrapper call to the canonical target', () => {
    const unwrapped = unwrapDeferredToolCallShape(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: 'task',
        arguments: { description: 'legacy alias call' },
      }),
    );

    expect(unwrapped.name).toBe(ToolNames.AGENT);
    expect(unwrapped.args).toEqual({ description: 'legacy alias call' });
    expect(unwrapped.providerName).toBe(ToolNames.DEFERRED_TOOL_CALL);
    expect(unwrapped.callId).toBe('call-1');
  });

  it('preserves the target arguments of repeated calls to the same target', () => {
    const first = unwrapDeferredToolCallShape(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 9 * * *' },
      }),
    );
    const second = unwrapDeferredToolCallShape(
      request(ToolNames.DEFERRED_TOOL_CALL, {
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 18 * * *' },
      }),
    );

    expect(first.name).toBe(ToolNames.CRON_CREATE);
    expect(second.name).toBe(ToolNames.CRON_CREATE);
    expect(first.args).toEqual({ schedule: '0 9 * * *' });
    expect(second.args).toEqual({ schedule: '0 18 * * *' });
    expect(first.args).not.toEqual(second.args);
  });
});

describe('permission tool identity', () => {
  it('keeps ordinary tool messages unchanged', () => {
    const ordinaryRequest = request(ToolNames.READ_FILE);

    expect(formatPermissionToolIdentity(ordinaryRequest)).toBe('"read_file"');
    expect(withPermissionToolIdentity('policy says no', ordinaryRequest)).toBe(
      'policy says no',
    );
  });

  it('shows both the target and provider route for proxy calls', () => {
    const proxyRequest = {
      ...request(ToolNames.CRON_CREATE),
      providerName: ToolNames.DEFERRED_TOOL_CALL,
    };

    expect(formatPermissionToolIdentity(proxyRequest)).toBe(
      '"cron_create" via "tool_call"',
    );
    expect(withPermissionToolIdentity('policy says no', proxyRequest)).toBe(
      'policy says no (tool "cron_create" via "tool_call")',
    );
  });
});
