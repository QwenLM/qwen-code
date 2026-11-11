/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLink, createLinkCommand } from './link.js';

const mockLinkSkill = vi.hoisted(() => vi.fn());
const mockRequestConsentNonInteractive = vi.hoisted(() => vi.fn());
const mockSkillsConsentString = vi.hoisted(() => vi.fn());
const mockExitCli = vi.hoisted(() => vi.fn());

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: mockExitCli,
}));

vi.mock('../../utils/skillUtils.js', () => ({
  linkSkill: mockLinkSkill,
}));

const { emitFeedback, coreEvents } = await vi.hoisted(async () => {
  const { createMockCoreFeedback } = await import(
    '../../test-utils/mockCoreFeedback.js'
  );
  return createMockCoreFeedback({ stripAnsi: true });
});

vi.mock('@qwen-code/core', () => ({
  coreEvents,
  getErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
}));

vi.mock('../../utils/skillConsent.js', () => ({
  requestConsentNonInteractive: mockRequestConsentNonInteractive,
  skillsConsentString: mockSkillsConsentString,
}));

describe('skills link command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  describe('linkCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createLinkCommand();
      expect(cmd.name()).toBe('link');
      expect(cmd.description()).toContain('Links an agent skill');
    });

    it('should expose -s as a short alias of --scope and accept project', () => {
      const cmd = createLinkCommand();
      const scopeOption = cmd.options.find((o) => o.long === '--scope');
      expect(scopeOption?.short).toBe('-s');
      expect(scopeOption?.argChoices).toEqual([
        'user',
        'workspace',
        'project',
      ]);
    });
  });

  it('should call linkSkill with correct arguments', async () => {
    const sourcePath = '/source/path';
    mockLinkSkill.mockResolvedValue([
      { name: 'test-skill', location: '/dest/path' },
    ]);

    await handleLink({ path: sourcePath, scope: 'user' });

    expect(mockLinkSkill).toHaveBeenCalledWith(
      sourcePath,
      'user',
      expect.any(Function),
      expect.any(Function),
    );
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Successfully linked skills'),
    );
  });

  it('should handle linkSkill failure', async () => {
    mockLinkSkill.mockRejectedValue(new Error('Link failed'));

    await handleLink({ path: '/some/path' });

    expect(emitFeedback).toHaveBeenCalledWith('error', 'Link failed');
    expect(mockExitCli).toHaveBeenCalledWith(1);
  });
});
