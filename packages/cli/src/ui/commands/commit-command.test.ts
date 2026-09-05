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
    // Refuse obvious secret files — anchored on the prohibition so an
    // inverted rule fails rather than surviving on the bare keywords.
    expect(text).toMatch(
      /never stage or commit files that look like they contain secrets/i,
    );
    expect(text.toLowerCase()).toContain('.env');
    // Skip empty commits.
    expect(text).toMatch(/nothing to commit/i);
    expect(text).toMatch(/never pass `--allow-empty`/i);
  });

  it('describes co-author attribution the way the platform applies it', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text).toContain('Co-authored-by');
    expect(text).toMatch(/general\.gitCoAuthor\.commit/);
    expect(text).toMatch(/already appends the configured/i);
    expect(text).toMatch(/do not add your own ai-assistance trailer/i);
    // Not automatic without an inline -m/-am, and must not claim to be.
    expect(text).toMatch(/no-op when the commit carries no inline/i);
    // The #3935 misconception this replaces must never come back.
    expect(text).not.toMatch(/nothing injects it automatically/i);
  });

  it('gives the model a fallback for a repository with no commits yet', async () => {
    const ctx = createMockCommandContext();
    const result = await commitCommand.action!(ctx, '');
    const text = promptText(result);
    expect(text).toMatch(/no commits yet/i);
    expect(text).toMatch(/skip them/i);
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
