/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
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
  let getReasoningPreference: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let notifySettingsChanged: ReturnType<typeof vi.fn>;
  let context: CommandContext;

  beforeEach(() => {
    // Stateful by default so the read-back in the success path mirrors the real
    // Config: setReasoningEffort lands the tier, getReasoningEffort reflects it.
    let currentEffort: string | undefined;
    setReasoningEffort = vi.fn((effort?: string) => {
      currentEffort = effort;
    });
    getReasoningEffort = vi.fn(() => currentEffort);
    getReasoningPreference = vi.fn();
    setValue = vi.fn();
    notifySettingsChanged = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getReasoningEffort,
          getReasoningPreference,
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
      session: { notifySettingsChanged },
    });
  });

  it('opens the picker dialog when called with no args interactively', async () => {
    const res = await effortCommand.action!(context, '');
    expect(res).toMatchObject({ type: 'dialog', dialog: 'effort' });
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('reports explicit disabled reasoning separately from an unset effort', async () => {
    getReasoningPreference.mockReturnValue(false);
    const nonInteractive = { ...context, executionMode: 'non_interactive' };

    const res = await effortCommand.action!(
      nonInteractive as typeof context,
      '',
    );

    expect((res as { content: string }).content).toContain(
      'Thinking is disabled.',
    );
    expect((res as { content: string }).content).not.toContain(
      'using the model/provider default',
    );
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
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(notifySettingsChanged).toHaveBeenCalledWith({
      key: 'model.reasoningEffort',
      value: 'high',
      scope: 'user',
    });
    expect(res).toMatchObject({ messageType: 'info' });
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
    expect(notifySettingsChanged).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('reports the workspace scope selected for persistence', async () => {
    context.services.settings.workspace.settings = { modelProviders: {} };

    await effortCommand.action!(context, 'medium');

    expect(notifySettingsChanged).toHaveBeenCalledWith({
      key: 'model.reasoningEffort',
      value: 'medium',
      scope: 'workspace',
    });
  });

  it('does not notify when the settings write fails', async () => {
    setValue.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(effortCommand.action!(context, 'medium')).rejects.toThrow(
      'disk full',
    );
    expect(notifySettingsChanged).not.toHaveBeenCalled();
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
      undefined,
      { throwOnWriteFailure: true },
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
      undefined,
      { throwOnWriteFailure: true },
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
