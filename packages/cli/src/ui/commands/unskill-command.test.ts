/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unskillCommand } from './unskill-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';

describe('unskillCommand', () => {
  let unloadSkillBody: ReturnType<typeof vi.fn>;
  let unloadSkills: ReturnType<typeof vi.fn>;
  let loadedNames: Set<string>;

  beforeEach(() => {
    unloadSkillBody = vi
      .fn()
      .mockReturnValue({ cleared: true, tokensSaved: 72 });
    unloadSkills = vi.fn();
    loadedNames = new Set(['demo-poem', 'review']);
  });

  function makeContext(args: string): CommandContext {
    const skillTool = {
      name: 'skill',
      getLoadedSkillNames: () => loadedNames,
      unloadSkills,
    };
    return createMockCommandContext({
      invocation: { raw: `/unskill ${args}`, name: 'unskill', args },
      services: {
        config: {
          getToolRegistry: () => ({ getAllTools: () => [skillTool] }),
          getGeminiClient: () => ({ getChat: () => ({ unloadSkillBody }) }),
        },
      },
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
  }

  it('prints usage when no skill name is given', async () => {
    const result = await unskillCommand.action!(makeContext(''), '');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect((result as { content: string }).content).toContain('/unskill');
    expect(unloadSkillBody).not.toHaveBeenCalled();
  });

  it('reports when the skill is not loaded', async () => {
    const result = await unskillCommand.action!(
      makeContext('missing'),
      'missing',
    );
    expect((result as { content: string }).content).toContain('not loaded');
    expect(unloadSkillBody).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('unloads the body, un-tracks the name, and reports tokens freed', async () => {
    const result = await unskillCommand.action!(
      makeContext('demo-poem'),
      'demo-poem',
    );
    expect(unloadSkillBody).toHaveBeenCalledWith('demo-poem');
    expect(unloadSkills).toHaveBeenCalledWith(['demo-poem']);
    expect((result as { content: string }).content).toContain('demo-poem');
    expect((result as { content: string }).content).toContain('72');
  });

  it('still un-tracks when no body remained in history', async () => {
    unloadSkillBody.mockReturnValue({ cleared: false, tokensSaved: 0 });
    const result = await unskillCommand.action!(
      makeContext('demo-poem'),
      'demo-poem',
    );
    expect(unloadSkills).toHaveBeenCalledWith(['demo-poem']);
    expect((result as { content: string }).content).toContain(
      'can be reloaded',
    );
  });

  it('completion lists only loaded skill names matching the prefix', async () => {
    const completions = await unskillCommand.completion!(makeContext(''), 'de');
    expect(completions).toEqual(['demo-poem']);
  });
});
