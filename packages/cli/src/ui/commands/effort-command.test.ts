/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import { type CommandContext } from './types.js';
import { effortCommand } from './effort-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// t() returns the key verbatim so assertions can match on the key text.
vi.mock('../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

describe('effortCommand', () => {
  let setReasoningEffort: ReturnType<typeof vi.fn>;
  let getReasoningEffort: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let context: CommandContext;

  beforeEach(() => {
    // Stateful by default so the read-back in the success path mirrors the real
    // Config: setReasoningEffort lands the tier, getReasoningEffort reflects it.
    let currentEffort: string | undefined;
    setReasoningEffort = vi.fn((effort?: string) => {
      currentEffort = effort;
    });
    getReasoningEffort = vi.fn(() => currentEffort);
    setValue = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn().mockReturnValue('gpt-5'),
          getReasoningEffort,
          setReasoningEffort,
          getReasoningEffortOverride: vi.fn().mockReturnValue(undefined),
        } as unknown as Config,
        settings: {
          setValue,
          isTrusted: true,
          user: { settings: {} },
          workspace: { settings: {} },
        } as never,
      },
    });
  });

  it('opens the picker dialog when called with no args interactively', async () => {
    const res = await effortCommand.action!(context, '');
    expect(res).toMatchObject({ type: 'dialog', dialog: 'effort' });
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('lists tiers when called with no args non-interactively', async () => {
    const nonInteractive = { ...context, executionMode: 'non_interactive' };
    const res = await effortCommand.action!(
      nonInteractive as typeof context,
      '',
    );
    expect(res).toMatchObject({ type: 'message', messageType: 'info' });
    expect(getReasoningEffort).toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('sets and persists a valid tier', async () => {
    const res = await effortCommand.action!(context, 'high');
    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      'high',
    );
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('rejects a non-native Qwen 3.8 tier', async () => {
    Object.assign(context.services.config!, {
      getModel: () => 'qwen3.8-max',
      getAuthType: () => AuthType.USE_OPENAI,
      getContentGeneratorConfig: () => ({
        model: 'qwen3.8-max',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    });

    const rejected = await effortCommand.action!(context, 'high');
    expect(rejected).toMatchObject({ messageType: 'error' });
    expect(setReasoningEffort).not.toHaveBeenCalled();

    const accepted = await effortCommand.action!(context, 'xhigh');
    expect(accepted).toMatchObject({ messageType: 'info' });
    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
  });

  it('does not offer effort tiers for a toggle-only route', async () => {
    Object.assign(context.services.config!, {
      getModel: () => 'qwen3.7-max',
      getAuthType: () => AuthType.USE_OPENAI,
      getContentGeneratorConfig: () => ({
        model: 'qwen3.7-max',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    });

    const result = await effortCommand.action!(context, 'high');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('does not infer effort tiers for an unregistered Qwen alias', async () => {
    Object.assign(context.services.config!, {
      getModel: () => 'qwen3.8-max-preview',
      getAuthType: () => AuthType.USE_OPENAI,
      getContentGeneratorConfig: () => ({
        model: 'qwen3.8-max-preview',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    });

    const result = await effortCommand.action!(context, 'xhigh');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('keeps a valid tier session-local when persistence is disabled', async () => {
    const res = await effortCommand.action!(
      {
        ...context,
        executionPolicy: {
          allowSessionReset: false,
          allowWorkspaceSettingsWrite: false,
          persistModelSelection: false,
          blockedBuiltinCommandNames: [],
        },
      },
      'high',
    );

    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    expect(setValue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('reports thinking is disabled when setReasoningEffort is a no-op', async () => {
    // Simulate `reasoning: false`: setReasoningEffort no-ops, so the tier never
    // lands. The command must still persist it but report it has not taken
    // effect rather than a misleading "Reasoning effort: high".
    setReasoningEffort.mockImplementation(() => {});
    getReasoningEffort.mockReturnValue(undefined);
    const res = await effortCommand.action!(context, 'high');
    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    // Still persisted for future sessions.
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      'high',
    );
    expect(res).toMatchObject({ messageType: 'info' });
    expect((res as { content: string }).content).toContain(
      'thinking is currently disabled',
    );
  });

  it('reports a static override while thinking is disabled', async () => {
    setReasoningEffort.mockImplementation(() => {});
    getReasoningEffort.mockReturnValue(undefined);
    const getReasoningEffortOverride = vi.fn().mockReturnValue({
      source: 'extra_body',
      field: 'thinking_budget',
    });
    (context.services.config as unknown as Record<string, unknown>)[
      'getReasoningEffortOverride'
    ] = getReasoningEffortOverride;

    const res = await effortCommand.action!(context, 'high');

    expect((res as { content: string }).content).toContain(
      'thinking is currently disabled',
    );
    expect((res as { content: string }).content).toContain(
      'will still have higher priority',
    );
  });

  it('reports a higher-priority static thinking knob', async () => {
    const getReasoningEffortOverride = vi.fn().mockReturnValue({
      source: 'extra_body',
      field: 'thinking_budget',
    });
    (context.services.config as unknown as Record<string, unknown>)[
      'getReasoningEffortOverride'
    ] = getReasoningEffortOverride;

    const res = await effortCommand.action!(context, 'max');

    expect(setReasoningEffort).toHaveBeenCalledWith('max');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      'max',
    );
    expect(res).toMatchObject({ messageType: 'info' });
    expect((res as { content: string }).content).toContain('higher priority');
    expect((res as { content: string }).content).toContain(
      'will remain effective',
    );
  });

  it('normalizes aliases such as x-high', async () => {
    await effortCommand.action!(context, 'x-high');
    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
  });

  it('rejects an unknown tier without mutating config or settings', async () => {
    const res = await effortCommand.action!(context, 'turbo');
    expect(setReasoningEffort).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('does not offer tier autocompletion (tiers are hinted via argumentHint)', () => {
    // No completion so bare `/effort` opens the picker instead of auto-picking
    // the first tier; `/effort <tier>` still parses in the action above.
    expect(effortCommand.completion).toBeUndefined();
    expect(effortCommand.argumentHint).toBe('[low|medium|high|xhigh|max]');
  });
});
