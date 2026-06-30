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
          getReasoningEffort,
          setReasoningEffort,
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

  it('rejects an unknown tier without mutating config or settings', async () => {
    const res = await effortCommand.action!(context, 'turbo');
    expect(setReasoningEffort).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('completes tier prefixes', async () => {
    expect(await effortCommand.completion!(context, 'hi')).toEqual(['high']);
    expect(await effortCommand.completion!(context, 'x')).toEqual(['xhigh']);
    expect(await effortCommand.completion!(context, '')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});
