/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { commitCommand } from './commit-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind, type SubmitPromptActionReturn } from './types.js';

function promptText(result: unknown): string {
  expect(result).toMatchObject({ type: 'submit_prompt' });
  const content = (result as SubmitPromptActionReturn).content as Array<{
    text: string;
  }>;
  expect(Array.isArray(content)).toBe(true);
  expect(content).toHaveLength(1);
  return content[0].text;
}

describe('commitCommand', () => {
  it('has the expected metadata', () => {
    expect(commitCommand.name).toBe('commit');
    expect(commitCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(commitCommand.supportedModes).toEqual(['interactive']);
    expect(commitCommand.description).toBeTruthy();
  });

  it('returns a submit_prompt action on zero args so the model does the work', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('instructs the model to gather commit context', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text).toContain('git status');
    expect(text).toContain('git diff HEAD');
    expect(text).toContain('git log');
    expect(text.toLowerCase()).toContain('branch');
  });

  it('requires selective staging instead of blindly adding everything', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text).toContain('git add');
    expect(text).toMatch(/do not run `git add -A`/i);
  });

  it('supports multi-line commit messages with subject and body', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text.toLowerCase()).toContain('subject');
    expect(text.toLowerCase()).toContain('body');
    expect(text.toLowerCase()).toContain('multi-line');
  });

  it('includes the safety guards from the design review', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    // Never amend without an explicit user request.
    expect(text).toMatch(/never use `--amend`/i);
    // Never bypass git hooks.
    expect(text).toMatch(/never pass `--no-verify`/i);
    // Refuse obvious secret files.
    expect(text.toLowerCase()).toContain('.env');
    expect(text.toLowerCase()).toContain('secrets');
    // Skip empty commits.
    expect(text).toMatch(/nothing to commit/i);
    expect(text).toContain('--allow-empty');
  });

  it('keeps co-author attribution explicit in the commit message text', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text).toContain('Co-authored-by');
  });

  it('passes user-provided instructions through to the model', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(
      ctx,
      'only stage the parser changes',
    );
    const text = promptText(result);
    expect(text).toContain('only stage the parser changes');
  });

  it('trims whitespace-only args and still drafts the message', async () => {
    const ctx = createMockCommandContext();
    const withBlankArgs = await commitCommand.action!(ctx, '   ');
    const withNoArgs = await commitCommand.action!(ctx, '');
    expect(promptText(withBlankArgs)).toBe(promptText(withNoArgs));
  });
});
