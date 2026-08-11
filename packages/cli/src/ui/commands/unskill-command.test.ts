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
  let hasSkillBodyInHistory: ReturnType<typeof vi.fn>;
  let unloadSkills: ReturnType<typeof vi.fn>;
  let loadedNames: Set<string>;
  /** `null` simulates a SkillManager whose cache has not committed yet. */
  let realSkillNames: string[] | null;

  beforeEach(() => {
    unloadSkillBody = vi
      .fn()
      .mockReturnValue({ cleared: true, tokensSaved: 72 });
    hasSkillBodyInHistory = vi.fn().mockReturnValue(false);
    unloadSkills = vi.fn();
    loadedNames = new Set(['demo-poem', 'review']);
    realSkillNames = ['demo-poem', 'review', 'dormant'];
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
          getGeminiClient: () => ({
            getChat: () => ({ unloadSkillBody, hasSkillBodyInHistory }),
          }),
          getSkillManager: () => ({
            getCachedSkills: () =>
              realSkillNames === null
                ? null
                : realSkillNames.map((name) => ({ name })),
          }),
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
      makeContext('dormant'),
      'dormant',
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

  it('rejects a tracked name that is not a skill (model-invocable command)', async () => {
    // The skill tool's command-executor fallback tracks command names in
    // loadedSkillNames; /unskill must not blank command execution results
    // under skill-body semantics.
    loadedNames.add('deploy-cmd');
    const result = await unskillCommand.action!(
      makeContext('deploy-cmd'),
      'deploy-cmd',
    );
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain('not a skill');
    expect(unloadSkillBody).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('skips the real-skill check when the skill cache is not committed', async () => {
    realSkillNames = null;
    loadedNames.add('deploy-cmd');
    const result = await unskillCommand.action!(
      makeContext('deploy-cmd'),
      'deploy-cmd',
    );
    expect(unloadSkillBody).toHaveBeenCalledWith('deploy-cmd');
    expect((result as { content: string }).content).toContain('72');
  });

  it('falls back to history when tracking was lost (--resume)', async () => {
    loadedNames = new Set();
    hasSkillBodyInHistory.mockReturnValue(true);
    const result = await unskillCommand.action!(
      makeContext('demo-poem'),
      'demo-poem',
    );
    expect(hasSkillBodyInHistory).toHaveBeenCalledWith('demo-poem');
    expect(unloadSkillBody).toHaveBeenCalledWith('demo-poem');
    expect(unloadSkills).toHaveBeenCalledWith(['demo-poem']);
    expect((result as { content: string }).content).toContain('72');
  });

  it('still reports not loaded when neither tracking nor history has the body', async () => {
    loadedNames = new Set();
    hasSkillBodyInHistory.mockReturnValue(false);
    const result = await unskillCommand.action!(
      makeContext('demo-poem'),
      'demo-poem',
    );
    expect((result as { content: string }).content).toContain('not loaded');
    expect(unloadSkillBody).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('bypasses the cached-skill gate for a mid-session deleted skill whose body is still in history', async () => {
    // Skill was loaded (tracked) but later deleted from disk — it's
    // gone from the committed cache yet its body still occupies context.
    realSkillNames = ['review', 'dormant'];
    hasSkillBodyInHistory.mockReturnValue(true);
    const result = await unskillCommand.action!(
      makeContext('demo-poem'),
      'demo-poem',
    );
    expect(unloadSkillBody).toHaveBeenCalledWith('demo-poem');
    expect(unloadSkills).toHaveBeenCalledWith(['demo-poem']);
    expect((result as { content: string }).content).toContain('72');
  });

  it('completion lists only loaded skill names matching the prefix', async () => {
    const completions = await unskillCommand.completion!(makeContext(''), 'de');
    expect(completions).toEqual(['demo-poem']);
  });

  it('completion excludes tracked command names that are not skills', async () => {
    loadedNames.add('deploy-cmd');
    const completions = await unskillCommand.completion!(makeContext(''), '');
    expect(completions).toEqual(['demo-poem', 'review']);
  });
});
