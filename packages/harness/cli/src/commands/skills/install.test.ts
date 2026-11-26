/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockInstallSkill = vi.hoisted(() => vi.fn());
const mockRequestConsentNonInteractive = vi.hoisted(() => vi.fn());
const mockSkillsConsentString = vi.hoisted(() => vi.fn());
const mockExitCli = vi.hoisted(() => vi.fn());

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: mockExitCli,
}));

vi.mock('../../utils/skillUtils.js', () => ({
  installSkill: mockInstallSkill,
}));

vi.mock('../../utils/skillConsent.js', () => ({
  requestConsentNonInteractive: mockRequestConsentNonInteractive,
  skillsConsentString: mockSkillsConsentString,
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

import { handleInstall, createInstallCommand } from './install.js';

describe('skill install command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockSkillsConsentString.mockResolvedValue('Mock Consent String');
    mockRequestConsentNonInteractive.mockResolvedValue(true);
  });

  describe('installCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createInstallCommand();
      expect(cmd.name()).toBe('install');
      expect(cmd.description()).toContain('Installs an agent skill');
    });

    it('should expose -s as a short alias of --scope', () => {
      const cmd = createInstallCommand();
      const scopeOption = cmd.options.find((o) => o.long === '--scope');
      expect(scopeOption?.short).toBe('-s');
    });

    it('should accept project as a scope value alongside user and workspace', () => {
      const cmd = createInstallCommand();
      const scopeOption = cmd.options.find((o) => o.long === '--scope');
      expect(scopeOption?.argChoices).toEqual([
        'user',
        'workspace',
        'project',
      ]);
    });
  });

  it('should call installSkill with correct arguments for user scope', async () => {
    mockInstallSkill.mockImplementation(async (_s, _sc, _p, _ol, rc) => {
      await rc([]);
      return [{ name: 'test-skill', location: '/mock/user/skills/test-skill' }];
    });

    await handleInstall({
      source: 'https://example.com/repo.git',
      scope: 'user',
    });

    expect(mockInstallSkill).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'user',
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Successfully installed skill: test-skill'),
    );
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('location: /mock/user/skills/test-skill'),
    );
    expect(mockRequestConsentNonInteractive).toHaveBeenCalledWith(
      'Mock Consent String',
    );
  });

  it('should skip prompt and log consent when --consent is provided', async () => {
    mockInstallSkill.mockImplementation(async (_s, _sc, _p, _ol, rc) => {
      await rc([]);
      return [{ name: 'test-skill', location: '/mock/user/skills/test-skill' }];
    });

    await handleInstall({
      source: 'https://example.com/repo.git',
      consent: true,
    });

    expect(mockRequestConsentNonInteractive).not.toHaveBeenCalled();
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      'You have consented to the following:',
    );
    expect(emitFeedback).toHaveBeenCalledWith('info', 'Mock Consent String');
    expect(mockInstallSkill).toHaveBeenCalled();
  });

  it('should surface installation progress to the user', async () => {
    mockInstallSkill.mockImplementation(async (source, _sc, _p, onLog) => {
      onLog(`Cloning skill from ${source}...`);
      return [{ name: 'test-skill', location: '/mock/user/skills/test-skill' }];
    });

    await handleInstall({ source: 'https://example.com/repo.git' });

    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      'Cloning skill from https://example.com/repo.git...',
    );
  });

  it('should abort installation if consent is denied', async () => {
    mockRequestConsentNonInteractive.mockResolvedValue(false);
    mockInstallSkill.mockImplementation(async (_s, _sc, _p, _ol, rc) => {
      if (!(await rc([]))) {
        throw new Error('Skill installation cancelled by user.');
      }
      return [];
    });

    await handleInstall({
      source: 'https://example.com/repo.git',
    });

    expect(emitFeedback).toHaveBeenCalledWith(
      'error',
      'Skill installation cancelled by user.',
    );
    expect(mockExitCli).toHaveBeenCalledWith(1);
  });

  it('should call installSkill with correct arguments for workspace scope and subpath', async () => {
    mockInstallSkill.mockResolvedValue([
      { name: 'test-skill', location: '/mock/workspace/skills/test-skill' },
    ]);

    await handleInstall({
      source: 'https://example.com/repo.git',
      scope: 'workspace',
      path: 'my-skills-dir',
    });

    expect(mockInstallSkill).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'workspace',
      'my-skills-dir',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('should handle errors gracefully', async () => {
    mockInstallSkill.mockRejectedValue(new Error('Install failed'));

    await handleInstall({ source: '/local/path' });

    expect(emitFeedback).toHaveBeenCalledWith('error', 'Install failed');
    expect(mockExitCli).toHaveBeenCalledWith(1);
  });
});
