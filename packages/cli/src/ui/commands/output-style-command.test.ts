/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import { type CommandContext } from './types.js';
import { outputStyleCommand } from './output-style-command.js';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// t() returns the key verbatim so assertions can match on the key text.
vi.mock('../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

describe('outputStyleCommand', () => {
  let setOutputStyle: ReturnType<typeof vi.fn>;
  let getOutputStyle: ReturnType<typeof vi.fn>;
  let refreshSystemInstruction: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let context: CommandContext;

  beforeEach(() => {
    // Stateful so the resolveMainSessionOutputStyle read-back after
    // setOutputStyle mirrors the real Config.
    let currentStyle: OutputStyleDefinition | undefined;
    setOutputStyle = vi.fn((style?: OutputStyleDefinition) => {
      currentStyle = style;
    });
    getOutputStyle = vi.fn(() => currentStyle);
    refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
    setValue = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getOutputStyle,
          setOutputStyle,
          getLlmClient: () => ({ refreshSystemInstruction }),
          getSystemPrompt: vi.fn().mockReturnValue(undefined),
          getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
          getInputFormat: vi.fn().mockReturnValue('text'),
          isInteractive: vi.fn().mockReturnValue(true),
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
    const res = await outputStyleCommand.action!(context, '');
    expect(res).toMatchObject({ type: 'dialog', dialog: 'output-style' });
    expect(setOutputStyle).not.toHaveBeenCalled();
  });

  it('lists styles when called with no args non-interactively', async () => {
    const nonInteractive = { ...context, executionMode: 'non_interactive' };
    const res = await outputStyleCommand.action!(
      nonInteractive as typeof context,
      '',
    );
    expect(res).toMatchObject({ type: 'message', messageType: 'info' });
    expect(getOutputStyle).toHaveBeenCalled();
    expect(setOutputStyle).not.toHaveBeenCalled();
  });

  it('sets, refreshes, and persists a style, case-insensitively', async () => {
    const res = await outputStyleCommand.action!(context, 'concise');
    expect(setOutputStyle).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Concise' }),
    );
    expect(refreshSystemInstruction).toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Concise',
    );
    expect(res).toMatchObject({ messageType: 'info' });
    expect((res as { content: string }).content).toContain(
      'Output style set to {{name}}.',
    );
  });

  it('clears the style with "default" and persists the literal', async () => {
    const res = await outputStyleCommand.action!(context, 'default');
    expect(setOutputStyle).toHaveBeenCalledWith(undefined);
    expect(refreshSystemInstruction).toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'default',
    );
    expect((res as { content: string }).content).toContain(
      'Output style cleared',
    );
  });

  it('rejects an unknown style without mutating config or settings', async () => {
    const res = await outputStyleCommand.action!(context, 'Verbose');
    expect(setOutputStyle).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('notes that the style has no effect when the system prompt is replaced', async () => {
    (
      context.services.config as unknown as {
        getSystemPrompt: ReturnType<typeof vi.fn>;
      }
    ).getSystemPrompt = vi.fn().mockReturnValue('replaced');

    const res = await outputStyleCommand.action!(context, 'Concise');

    // Still applied and persisted for when the replacement goes away.
    expect(setOutputStyle).toHaveBeenCalled();
    expect(setValue).toHaveBeenCalled();
    expect((res as { content: string }).content).toContain('has no effect');
  });

  it('still persists and reports when the live refresh fails', async () => {
    refreshSystemInstruction.mockRejectedValue(new Error('no chat yet'));
    const res = await outputStyleCommand.action!(context, 'Proactive');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Proactive',
    );
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('does not offer style autocompletion (styles are hinted via argumentHint)', () => {
    // No completion so bare `/output-style` opens the picker instead of
    // auto-picking the first style.
    expect(outputStyleCommand.completion).toBeUndefined();
    expect(outputStyleCommand.argumentHint).toBe(
      '[Concise|Proactive|Explanatory|Learning|default]',
    );
  });
});
