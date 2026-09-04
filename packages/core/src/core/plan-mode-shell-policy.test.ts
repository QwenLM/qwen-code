/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { PermissionCheckContext } from '../permissions/types.js';
import { ToolNames } from '../tools/tool-names.js';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import {
  decoratePlanModeShellConfirmation,
  evaluatePlanModeShellPolicy,
  validatePlanModeShellApproval,
  validatePlanModeShellContext,
} from './plan-mode-shell-policy.js';

const UNKNOWN_WARNING =
  'Plan mode could not determine whether this shell command is read-only. Approval applies only to this exact invocation once; it may modify system state, and Plan mode will remain active.';
const STALE_MESSAGE =
  'Plan-mode shell approval is no longer valid because the mode, permission policy, or exact invocation changed. Submit a new tool call.';

function createContext(toolName: string, command: string) {
  return {
    toolName,
    command,
    toolParams: { command },
  } satisfies PermissionCheckContext;
}

function createConfig(
  options: {
    mode?: ApprovalMode;
    revision?: number;
    targetDir?: () => string;
    permissionManager?: Partial<PermissionManager>;
  } = {},
): Config {
  return {
    getApprovalMode: vi.fn(() => options.mode ?? ApprovalMode.PLAN),
    getApprovalModeRevision: vi.fn(() => options.revision ?? 7),
    getTargetDir: vi.fn(() => options.targetDir?.() ?? '/workspace'),
    getPermissionManager: vi.fn(() =>
      options.permissionManager
        ? (options.permissionManager as PermissionManager)
        : undefined,
    ),
  } as unknown as Config;
}

async function evaluate(
  command: string,
  options: {
    toolName?: string;
    config?: Config;
    requestArgs?: Record<string, unknown>;
    invocationParams?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
) {
  const toolName = options.toolName ?? ToolNames.SHELL;
  const requestArgs = options.requestArgs ?? { command };
  const invocationParams = options.invocationParams ?? { command };
  return evaluatePlanModeShellPolicy({
    config: options.config ?? createConfig(),
    toolName,
    requestArgs,
    invocationParams,
    permissionContext: createContext(toolName, command),
    signal: options.signal ?? new AbortController().signal,
  });
}

function execConfirmation(): ToolCallConfirmationDetails {
  return {
    type: 'exec',
    title: 'Confirm shell',
    command: "python -c 'print(1)'",
    rootCommand: 'python',
    warnings: ['existing warning'],
    onConfirm: vi.fn(),
  };
}

describe('plan-mode shell policy', () => {
  it.each([
    ['git status', 'read-only'],
    ['touch changed.txt', 'write'],
    ["python -c 'print(1)'", 'unknown'],
  ] as const)('classifies %s as %s', async (command, expected) => {
    await expect(evaluate(command)).resolves.toMatchObject({
      classification: expected,
      rawCommand: command,
    });
  });

  it('classifies monitor safetyCommand rather than the wrapper', async () => {
    await expect(
      evaluate("/bin/bash -c 'git status &' ignored", {
        toolName: ToolNames.MONITOR,
      }),
    ).resolves.toMatchObject({ classification: 'read-only' });
    await expect(
      evaluate("/bin/bash -c 'python script.py &' ignored", {
        toolName: ToolNames.MONITOR,
      }),
    ).resolves.toMatchObject({ classification: 'unknown' });
  });

  it('does not apply outside Plan mode or to non-shell tools', async () => {
    await expect(
      evaluate('git status', {
        config: createConfig({ mode: ApprovalMode.DEFAULT }),
      }),
    ).resolves.toEqual({ classification: 'not-applicable' });
    await expect(
      evaluate('git status', { toolName: ToolNames.READ_FILE }),
    ).resolves.toEqual({ classification: 'not-applicable' });
  });

  it('races classification with abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluate('git status', { signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });

  it('invalidates mode revisions and exact request or invocation changes', async () => {
    let mode = ApprovalMode.PLAN;
    let revision = 3;
    const config = {
      getApprovalMode: () => mode,
      getApprovalModeRevision: () => revision,
      getTargetDir: () => '/workspace',
      getPermissionManager: () => undefined,
    } as unknown as Config;
    const decision = await evaluate('git status', { config });
    const signal = new AbortController().signal;

    await expect(
      validatePlanModeShellContext({
        config,
        decision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git status' },
        signal,
      }),
    ).resolves.toBeUndefined();

    mode = ApprovalMode.DEFAULT;
    revision++;
    mode = ApprovalMode.PLAN;
    revision++;
    await expect(
      validatePlanModeShellContext({
        config,
        decision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git status' },
        signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);

    const freshDecision = await evaluate('git status', { config });
    await expect(
      validatePlanModeShellContext({
        config,
        decision: freshDecision,
        requestArgs: { command: 'git diff' },
        invocationParams: { command: 'git status' },
        signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);
    await expect(
      validatePlanModeShellContext({
        config,
        decision: freshDecision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git diff' },
        signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);
  });

  it('binds ambient working directory without invalidating explicit directories', async () => {
    let targetDir = '/workspace/one';
    const config = createConfig({ targetDir: () => targetDir });
    const signal = new AbortController().signal;
    const ambientDecision = await evaluate("python -c 'print(1)'", {
      config,
    });

    targetDir = '/workspace/two';
    await expect(
      validatePlanModeShellContext({
        config,
        decision: ambientDecision,
        requestArgs: { command: "python -c 'print(1)'" },
        invocationParams: { command: "python -c 'print(1)'" },
        signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);

    const explicitArgs = {
      command: "python -c 'print(1)'",
      directory: '/workspace/fixed',
    };
    const explicitDecision = await evaluate(explicitArgs.command, {
      config,
      requestArgs: explicitArgs,
      invocationParams: explicitArgs,
    });
    targetDir = '/workspace/three';
    await expect(
      validatePlanModeShellContext({
        config,
        decision: explicitDecision,
        requestArgs: explicitArgs,
        invocationParams: explicitArgs,
        signal,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when current permission rules deny or throw', async () => {
    const denyConfig = createConfig({
      permissionManager: { evaluate: vi.fn().mockResolvedValue('deny') },
    });
    const denyDecision = await evaluate('git status', { config: denyConfig });
    await expect(
      validatePlanModeShellContext({
        config: denyConfig,
        decision: denyDecision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git status' },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);

    const errorConfig = createConfig({
      permissionManager: { evaluate: vi.fn().mockRejectedValue(new Error()) },
    });
    const errorDecision = await evaluate('git status', {
      config: errorConfig,
    });
    await expect(
      validatePlanModeShellContext({
        config: errorConfig,
        decision: errorDecision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git status' },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);
  });

  it.each(['allow', 'ask', 'default'] as const)(
    'keeps the selected route when permission recheck returns %s',
    async (permission) => {
      const config = createConfig({
        permissionManager: {
          evaluate: vi.fn().mockResolvedValue(permission),
        },
      });
      const decision = await evaluate('git status', { config });

      await expect(
        validatePlanModeShellContext({
          config,
          decision,
          requestArgs: { command: 'git status' },
          invocationParams: { command: 'git status' },
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('rechecks the frozen cwd and tool params needed by virtual denies', async () => {
    const evaluatePermission = vi.fn().mockResolvedValue('deny');
    const config = createConfig({
      permissionManager: { evaluate: evaluatePermission },
    });
    const requestArgs = { command: 'git status' };
    const invocationParams = {
      command: 'git status',
      directory: '/workspace',
    };
    const decision = await evaluate('git status', {
      config,
      requestArgs,
      invocationParams,
    });

    await expect(
      validatePlanModeShellContext({
        config,
        decision,
        requestArgs,
        invocationParams,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(STALE_MESSAGE);
    expect(evaluatePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: ToolNames.SHELL,
        command: 'git status',
        cwd: '/workspace',
        toolParams: invocationParams,
      }),
    );
  });

  it('owns a permission rejection when evaluation synchronously aborts', async () => {
    const controller = new AbortController();
    const evaluatePermission = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('late permission rejection'));
    });
    const config = createConfig({
      permissionManager: { evaluate: evaluatePermission },
    });
    const decision = await evaluate('git status', { config });

    await expect(
      validatePlanModeShellContext({
        config,
        decision,
        requestArgs: { command: 'git status' },
        invocationParams: { command: 'git status' },
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(evaluatePermission).toHaveBeenCalledOnce();
  });

  it('decorates unknown exec and edit confirmations idempotently', async () => {
    const decision = await evaluate("python -c 'print(1)'");
    const once = decoratePlanModeShellConfirmation(
      decision,
      execConfirmation(),
    );
    const twice = decoratePlanModeShellConfirmation(decision, once);
    expect(twice).toMatchObject({ hideAlwaysAllow: true });
    if (twice.type === 'exec') {
      expect(twice.warnings).toEqual(['existing warning', UNKNOWN_WARNING]);
    }

    const edit = decoratePlanModeShellConfirmation(decision, {
      type: 'edit',
      title: 'Confirm edit',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileDiff: 'diff',
      originalContent: '',
      newContent: 'x',
      onConfirm: vi.fn(),
    });
    expect(edit).toMatchObject({
      hideAlwaysAllow: true,
      hideModify: true,
      skipIdeDiff: true,
      warnings: [
        UNKNOWN_WARNING,
        "Exact shell command: `python -c 'print(1)'`",
      ],
    });
  });

  it('hides persistent approval for read-only shell prompts', async () => {
    const decision = await evaluate('git status');
    expect(
      decoratePlanModeShellConfirmation(decision, execConfirmation()),
    ).toMatchObject({ hideAlwaysAllow: true });
  });

  it('rejects unsupported unknown confirmation surfaces', async () => {
    const decision = await evaluate("python -c 'print(1)'");
    expect(() =>
      decoratePlanModeShellConfirmation(decision, {
        type: 'info',
        title: 'Unexpected',
        prompt: 'Unexpected',
        onConfirm: vi.fn(),
      }),
    ).toThrow('no approval surface is available');
  });

  it('accepts only exact one-off approval and clears its payload', async () => {
    const config = createConfig();
    const decision = await evaluate("python -c 'print(1)'", { config });
    const base = {
      config,
      decision,
      requestArgs: { command: "python -c 'print(1)'" },
      invocationParams: { command: "python -c 'print(1)'" },
      signal: new AbortController().signal,
    };

    await expect(
      validatePlanModeShellApproval({
        ...base,
        outcome: ToolConfirmationOutcome.ProceedOnce,
        payload: {
          updatedInput: { command: "python -c 'print(1)'" },
          permissionRules: ['Bash(python:*)'],
        },
      }),
    ).resolves.toEqual({ outcome: ToolConfirmationOutcome.ProceedOnce });

    for (const input of [
      {
        outcome: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      {
        outcome: ToolConfirmationOutcome.ProceedOnce,
        payload: { updatedInput: { command: 'touch changed.txt' } },
      },
      {
        outcome: ToolConfirmationOutcome.ProceedOnce,
        payload: { newContent: 'changed' },
      },
    ]) {
      await expect(
        validatePlanModeShellApproval({ ...base, ...input }),
      ).resolves.toEqual({
        outcome: ToolConfirmationOutcome.Cancel,
        payload: { cancelMessage: STALE_MESSAGE },
      });
    }
  });

  it('preserves cancellation after the approval signal is aborted', async () => {
    const config = createConfig();
    const decision = await evaluate("python -c 'print(1)'", { config });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      validatePlanModeShellApproval({
        config,
        decision,
        requestArgs: { command: "python -c 'print(1)'" },
        invocationParams: { command: "python -c 'print(1)'" },
        signal: abortController.signal,
        outcome: ToolConfirmationOutcome.Cancel,
        payload: { cancelMessage: 'Host cancelled approval' },
      }),
    ).resolves.toEqual({
      outcome: ToolConfirmationOutcome.Cancel,
      payload: { cancelMessage: 'Host cancelled approval' },
    });
  });
});
