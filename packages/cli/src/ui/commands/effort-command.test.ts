/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { type CommandContext } from './types.js';
import { effortCommand } from './effort-command.js';
import { SettingScope } from '../../config/settings.js';
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
          getModel: vi.fn().mockReturnValue('unregistered-model'),
          getReasoningEffort,
          setReasoningEffort,
        } as unknown as Config,
        settings: {
          setValue,
          isTrusted: true,
          user: { settings: {} },
          workspace: { settings: {} },
          merged: {},
          forScope: vi.fn().mockReturnValue({ settings: {} }),
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

  it('normalizes aliases such as x-high', async () => {
    await effortCommand.action!(context, 'x-high');
    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
  });

  it('normalizes and persists effort per registered model', async () => {
    vi.mocked(context.services.config!.getModel).mockReturnValue('qwen3.8-max');
    const res = await effortCommand.action!(context, 'max');
    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningPreferences',
      { 'qwen3.8-max': { effort: 'xhigh' } },
    );
    expect((res as { content: string }).content).toContain('normalized');
  });

  it('persists registered-model preferences to the scope owning the model key', async () => {
    // Workspace owns `model` (reasoningPreferences) but no `modelProviders`;
    // the modelProviders-ownership fallback would pick the user scope and the
    // write would be shadowed by the workspace entry.
    const workspaceSettings = { model: { reasoningPreferences: {} } };
    const scopedContext = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn().mockReturnValue('qwen3.8-max'),
          getReasoningEffort,
          setReasoningEffort,
        } as unknown as Config,
        settings: {
          setValue,
          isTrusted: true,
          user: { settings: {} },
          workspace: { settings: workspaceSettings },
          merged: {},
          forScope: vi.fn((scope: SettingScope) => ({
            settings: scope === SettingScope.Workspace ? workspaceSettings : {},
          })),
        } as never,
      },
    });

    await effortCommand.action!(scopedContext, 'medium');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'model.reasoningPreferences',
      { 'qwen3.8-max': { effort: 'medium' } },
    );
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
