/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for withPermissionRequestHook — the decorator that lets a
 * PermissionRequest hook answer a prompt before any channel is asked.
 *
 * The decorator wraps a presenter, so the tests drive `present(prompt, settle)`
 * directly with a recording settle and a stub bridge, and assert on the settlement
 * and on what landed on the module.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  withPermissionRequestHook,
  withPermissionRequestHookHandler,
  type AskPrompt,
  type AskSettlement,
  type PermissionRequestHookBridge,
  type PermissionRequestHookVerdict,
} from './ask-handler.js';
import { createAskMetricsStore } from './ask-facts.js';
import { createPermissionManager } from '../../test-utils/config.js';
import {
  createPermissionRequestHookBridge,
  permissionPromptNotifier,
} from './hook-bridge.js';
import { NotificationType } from '../../hooks/types.js';
import type { Config } from '../../config/config.js';

function prompt(overrides?: Partial<AskPrompt>): AskPrompt {
  return {
    toolUseId: 'tool-use-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    reason: {
      message: 'Allow this?',
      attribution: { type: 'other', reason: 'no rule' },
    },
    skippable: true,
    ...overrides,
  };
}

function moduleStub() {
  return createPermissionManager({
    cwd: '/repo',
    checkerDeps: {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => false,
      },
      mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
    },
  });
}

function bridge(
  verdict: PermissionRequestHookVerdict | undefined,
  overrides?: Partial<PermissionRequestHookBridge>,
): PermissionRequestHookBridge & {
  permission: ReturnType<typeof moduleStub>;
} {
  const permission = moduleStub();
  return {
    permission,
    // A fresh store per bridge, so a test reads only what its own hook recorded.
    askMetrics: createAskMetricsStore(),
    getVerdict: vi.fn().mockResolvedValue(verdict),
    ...overrides,
  };
}

/** A presenter that records whether it was asked to show the prompt. */
function presenterSpy() {
  const present = vi.fn(
    (_p: AskPrompt, _s: (r: AskSettlement) => void) => () => {},
  );
  return { present, refresh: vi.fn() };
}

function settleSpy() {
  const calls: AskSettlement[] = [];
  const settle = (r: AskSettlement) => {
    calls.push(r);
  };
  return { settle, calls };
}

describe('withPermissionRequestHook', () => {
  it('approves when the hook allows, carrying the amended input', async () => {
    const b = bridge({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toEqual({
      kind: 'approved',
      input: { command: 'ls -la' },
    });
  });

  it('applies the hook updatedPermissions to the module and disk', async () => {
    const settingsWriter = {
      getSettingsForSource: vi.fn(() => ({})),
      mutateSettingsForSource: vi.fn(
        (
          _source: string,
          _mutation: (data: { permissions?: unknown }) => boolean,
        ) => ({}),
      ),
    };
    const b = bridge(
      {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'addRules',
            destination: 'localSettings',
            rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
            behavior: 'allow',
          },
        ],
      },
      { settingsWriter: settingsWriter as never },
    );
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toEqual({ kind: 'approved' });
    // The rule landed on the live module under the source the hook named.
    expect(b.permission.getRules().allow['localSettings']).toEqual([
      'Bash(ls:*)',
    ]);
    // And it was persisted.
    expect(settingsWriter.mutateSettingsForSource).toHaveBeenCalled();
  });

  it('rejects when the hook denies and honours an interrupt', async () => {
    const onInterrupt = vi.fn();
    const b = bridge(
      { behavior: 'deny', interrupt: true, message: 'hook says no' },
      { onInterrupt },
    );
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // The hook's message is the refusal the model sees.
    expect(calls[0]).toEqual({ kind: 'rejected', reason: 'hook says no' });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic refusal when the hook denies silently', async () => {
    const b = bridge({ behavior: 'deny' });
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toEqual({
      kind: 'rejected',
      reason: 'Permission denied by hook.',
    });
  });

  it('shows the prompt when the hook has no opinion', async () => {
    const b = bridge(undefined);
    const presenter = presenterSpy();
    const wrapped = withPermissionRequestHook(presenter, b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(presenter.present).toHaveBeenCalledTimes(1));

    // Not settled by the hook — the presenter owns the answer now.
    expect(calls).toHaveLength(0);
  });

  it('treats a hook that throws as no opinion', async () => {
    const b = bridge(undefined);
    (b.getVerdict as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('hook blew up'),
    );
    const presenter = presenterSpy();
    const wrapped = withPermissionRequestHook(presenter, b);
    const { settle } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(presenter.present).toHaveBeenCalledTimes(1));
  });

  it('drops a late hook verdict once the prompt was torn down', async () => {
    // A verdict that resolves only after teardown must not settle anything.
    let resolveVerdict!: (v: PermissionRequestHookVerdict) => void;
    const pending = new Promise<PermissionRequestHookVerdict>((r) => {
      resolveVerdict = r;
    });
    const b = bridge(undefined);
    (b.getVerdict as ReturnType<typeof vi.fn>).mockReturnValue(pending);
    const presenter = presenterSpy();
    const wrapped = withPermissionRequestHook(presenter, b);
    const { settle, calls } = settleSpy();

    const teardown = wrapped.present(prompt(), settle);
    // The race shows the prompt immediately.
    expect(presenter.present).toHaveBeenCalledTimes(1);
    teardown(); // A recheck or cancellation took the prompt down first.
    resolveVerdict({ behavior: 'allow' });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });

  it('aborts the hook once the prompt is torn down', async () => {
    // The channel answered (allow, deny or cancel) while the hook was still
    // waiting: the hook must be stopped, not left running to its timeout.
    const b = bridge(undefined);
    (b.getVerdict as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle } = settleSpy();

    const teardown = wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(b.getVerdict).toHaveBeenCalledTimes(1));
    const { signal } = (b.getVerdict as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    teardown();

    expect(signal.aborted).toBe(true);
  });
});

describe('withPermissionRequestHookHandler hook abort', () => {
  function askCtx(signal?: AbortSignal) {
    return {
      toolUseId: 'tool-use-3',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolCheckResult: { kind: 'ask', reason: prompt().reason },
      onToolCheckResult: () => () => {},
      signal,
    } as never;
  }

  function hookSignal(b: PermissionRequestHookBridge): AbortSignal {
    return (b.getVerdict as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .signal as AbortSignal;
  }

  it('aborts the racing hook when the channel settles first', async () => {
    const b = bridge(undefined);
    (b.getVerdict as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    const inner = vi.fn(async () => ({ kind: 'rejected' }) as AskSettlement);
    const wrapped = withPermissionRequestHookHandler(inner as never, b);

    const settlement = await wrapped(askCtx());

    expect(settlement).toEqual({ kind: 'rejected' });
    expect(hookSignal(b).aborted).toBe(true);
  });

  it('aborts the racing hook when the turn is aborted', async () => {
    const b = bridge(undefined);
    (b.getVerdict as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    const turn = new AbortController();
    const inner = vi.fn(() => new Promise<never>(() => {}));
    const wrapped = withPermissionRequestHookHandler(inner as never, b);

    void wrapped(askCtx(turn.signal));
    await vi.waitFor(() => expect(b.getVerdict).toHaveBeenCalledTimes(1));
    expect(hookSignal(b).aborted).toBe(false);

    turn.abort();

    expect(hookSignal(b).aborted).toBe(true);
  });

  it('passes the turn signal to a serial headless hook', async () => {
    const b = bridge({ behavior: 'allow' });
    const turn = new AbortController();
    const wrapped = withPermissionRequestHookHandler(undefined, b);

    await wrapped(askCtx(turn.signal));

    expect(hookSignal(b)).toBe(turn.signal);
  });
});

describe('createPermissionRequestHookBridge', () => {
  it('resolves the session module lazily for channels built before it exists', () => {
    const config = {
      permissionTelemetry: { askMetrics: createAskMetricsStore() },
      getHookSystem: () => undefined,
    } as unknown as Config;
    const bridge = createPermissionRequestHookBridge(config);
    expect(bridge).toBeDefined();
    expect(bridge.settingsWriter).toBeUndefined();

    const permission = moduleStub();
    (config as unknown as { permission?: unknown }).permission = permission;
    expect(bridge.permission).toBe(permission);
  });

  it('forwards the abort signal to the PermissionRequest event', async () => {
    const firePermissionRequestEvent = vi.fn().mockResolvedValue({});
    const config = {
      permission: moduleStub(),
      permissionTelemetry: { askMetrics: createAskMetricsStore() },
      getHookSystem: () => ({ firePermissionRequestEvent }),
      getModel: () => 'model-x',
    } as unknown as Config;
    const b = createPermissionRequestHookBridge(config)!;
    const controller = new AbortController();

    await b.getVerdict({
      toolName: 'Bash',
      input: { command: 'ls' },
      suggestions: undefined,
      signal: controller.signal,
    });

    expect(firePermissionRequestEvent).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls' },
      undefined,
      controller.signal,
      'model-x',
    );
  });
});

describe('hook settlement ask facts', () => {
  it('records a presenter-wrapper hook win as the hook party', async () => {
    const b = bridge({ behavior: 'allow' });
    const wrapped = withPermissionRequestHook(presenterSpy(), b);
    const { settle, calls } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(b.askMetrics.peek('tool-use-1')).toEqual({ winnerParty: 'hook' });
  });

  it('records a handler-wrapper hook denial that beats the racing channel', async () => {
    const b = bridge({ behavior: 'deny' });
    // A channel prompt that stays pending while the hook wins the race.
    const inner = vi.fn(() => new Promise<never>(() => {}));
    const wrapped = withPermissionRequestHookHandler(inner as never, b);

    const settlement = await wrapped({
      toolUseId: 'tool-use-2',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolCheckResult: { kind: 'ask', reason: prompt().reason },
      onToolCheckResult: () => () => {},
    } as never);

    expect(settlement).toEqual({
      kind: 'rejected',
      reason: 'Permission denied by hook.',
    });
    // Race: the channel prompt goes out immediately even though the hook wins.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(b.askMetrics.peek('tool-use-2')).toEqual({ winnerParty: 'hook' });
  });

  it('records nothing when the hook has no opinion', async () => {
    const b = bridge(undefined);
    const presenter = presenterSpy();
    const wrapped = withPermissionRequestHook(presenter, b);
    const { settle } = settleSpy();

    wrapped.present(prompt(), settle);
    await vi.waitFor(() => expect(presenter.present).toHaveBeenCalledTimes(1));
    expect(b.askMetrics.peek('tool-use-1')).toBeUndefined();
  });
});

describe('permissionPromptNotifier', () => {
  it('fires the permission_prompt notification with the prompt facts', () => {
    const fireNotificationEvent = vi.fn().mockResolvedValue(undefined);
    const config = {
      getHookSystem: () => ({ fireNotificationEvent }),
    } as unknown as Config;

    permissionPromptNotifier(config)(prompt());

    expect(fireNotificationEvent).toHaveBeenCalledTimes(1);
    expect(fireNotificationEvent).toHaveBeenCalledWith(
      NotificationType.PermissionPrompt,
      'Tool Bash requires confirmation',
      {
        toolName: 'Bash',
        toolUseId: 'tool-use-1',
        input: { command: 'ls' },
        message: 'Allow this?',
      },
    );
  });

  it('does nothing when the session has no hook system', () => {
    const config = {
      getHookSystem: () => undefined,
    } as unknown as Config;

    expect(() => permissionPromptNotifier(config)(prompt())).not.toThrow();
  });
});

describe('withPermissionRequestHookHandler and a bypass-immune ask', () => {
  it('hands a catastrophic-removal ask to the channel without racing the hook', async () => {
    const b = bridge({ behavior: 'allow' });
    const inner = vi.fn(async () => ({ kind: 'rejected' as const }));
    const wrapped = withPermissionRequestHookHandler(inner as never, b);

    const settlement = await wrapped({
      toolUseId: 'tool-use-immune',
      toolName: 'Bash',
      input: { command: 'rm -rf ~' },
      toolCheckResult: {
        kind: 'ask',
        reason: {
          message: "Dangerous rm operation detected: '~'",
          attribution: {
            type: 'safetyCheck',
            reason: 'Dangerous rm operation on critical path: ~',
            safetyCheckKind: 'dangerousRemoval',
            bypassImmune: true,
          },
        },
        suggestions: [],
      },
      onToolCheckResult: () => () => {},
    } as never);

    // The channel's answer stands; the hook's allow was never consulted.
    expect(settlement).toEqual({ kind: 'rejected' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(b.getVerdict).not.toHaveBeenCalled();
  });
});
