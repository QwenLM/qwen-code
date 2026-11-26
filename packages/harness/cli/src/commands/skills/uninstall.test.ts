/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUninstallSkill = vi.hoisted(() => vi.fn());
const mockExitCli = vi.hoisted(() => vi.fn());

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: mockExitCli,
}));

vi.mock('../../utils/skillUtils.js', () => ({
  uninstallSkill: mockUninstallSkill,
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

import { handleUninstall, createUninstallCommand } from './uninstall.js';

describe('skill uninstall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  describe('uninstallCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createUninstallCommand();
      expect(cmd.name()).toBe('uninstall');
      expect(cmd.description()).toBe('Uninstalls an agent skill by name.');
    });

    it('should expose -s as a short alias of --scope and accept project', () => {
      const cmd = createUninstallCommand();
      const scopeOption = cmd.options.find((o) => o.long === '--scope');
      expect(scopeOption?.short).toBe('-s');
      expect(scopeOption?.argChoices).toEqual([
        'user',
        'workspace',
        'project',
      ]);
    });
  });

  it('should call uninstallSkill with correct arguments for user scope', async () => {
    mockUninstallSkill.mockResolvedValue({
      location: '/mock/user/skills/test-skill',
    });

    await handleUninstall({
      name: 'test-skill',
      scope: 'user',
    });

    expect(mockUninstallSkill).toHaveBeenCalledWith('test-skill', 'user');
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Successfully uninstalled skill: test-skill'),
    );
    expect(emitFeedback).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('location: /mock/user/skills/test-skill'),
    );
  });

  it('should call uninstallSkill with correct arguments for workspace scope', async () => {
    mockUninstallSkill.mockResolvedValue({
      location: '/mock/workspace/skills/test-skill',
    });

    await handleUninstall({
      name: 'test-skill',
      scope: 'workspace',
    });

    expect(mockUninstallSkill).toHaveBeenCalledWith('test-skill', 'workspace');
  });

  it('should log an error if skill is not found', async () => {
    mockUninstallSkill.mockResolvedValue(null);

    await handleUninstall({ name: 'test-skill' });

    expect(emitFeedback).toHaveBeenCalledWith(
      'error',
      'Skill "test-skill" is not installed in the user scope.',
    );
  });

  it('should handle errors gracefully', async () => {
    mockUninstallSkill.mockRejectedValue(new Error('Uninstall failed'));

    await handleUninstall({ name: 'test-skill' });

    expect(emitFeedback).toHaveBeenCalledWith('error', 'Uninstall failed');
    expect(mockExitCli).toHaveBeenCalledWith(1);
  });
});
