/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import { MessageType } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import type { Config, SkillDefinition } from '@qwen-code/core';
import {
  type LoadedSettings,
  createTestMergedSettings,
} from '../../config/settings.js';

vi.mock('../../utils/skillUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/skillUtils.js')>();
  return {
    ...actual,
    linkSkill: vi.fn(),
  };
});

vi.mock('../../utils/skillConsent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/skillConsent.js')>();
  return {
    ...actual,
    requestConsentInteractive: vi.fn().mockResolvedValue(true),
    skillsConsentString: vi.fn().mockResolvedValue('Mock Consent'),
  };
});

import { linkSkill } from '../../utils/skillUtils.js';

describe('skillsCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.useFakeTimers();
    const skills = [
      {
        name: 'skill1',
        description: 'desc1',
        location: '/loc1',
        body: 'body1',
      },
      {
        name: 'skill2',
        description: 'desc2',
        location: '/loc2',
        body: 'body2',
      },
    ];
    context = createMockCommandContext({
      services: {
        agentContext: {
          getSkillManager: vi.fn().mockReturnValue({
            getAllSkills: vi.fn().mockReturnValue(skills),
            getSkills: vi.fn().mockReturnValue(skills),
            isAdminEnabled: vi.fn().mockReturnValue(true),
            getSkill: vi
              .fn()
              .mockImplementation(
                (name: string) => skills.find((s) => s.name === name) ?? null,
              ),
          }),
          get config() {
            return this;
          },
        } as unknown as Config,
        settings: {
          merged: createTestMergedSettings({ skills: { disabled: [] } }),
          project: { path: '/workspace' },
          setValue: vi.fn(),
        } as unknown as LoadedSettings,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return skillBrowser dialog action', async () => {
    const action = skillsCommand.action!;
    const result = await action({} as Parameters<typeof action>[0], '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'skillBrowser',
    });
  });

  it('should have correct name and description', () => {
    expect(skillsCommand.name).toBe('skills');
    expect(skillsCommand.description).toBe('Manage agent skills');
    expect(skillsCommand.requiredStartupGates).toEqual(['commands']);
  });

  it('should only have link and reload subCommands', () => {
    expect(skillsCommand.subCommands).toBeDefined();
    const names = skillsCommand.subCommands!.map((s) => s.name);
    expect(names).toEqual(['link', 'reload']);
  });

  describe('link', () => {
    it('should link a skill successfully', async () => {
      const linkCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'link',
      )!;
      vi.mocked(linkSkill).mockResolvedValue([
        { name: 'test-skill', location: '/path' },
      ]);

      await linkCmd.action!(context, '/some/path');

      expect(linkSkill).toHaveBeenCalledWith(
        '/some/path',
        'user',
        expect.any(Function),
        expect.any(Function),
      );
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Successfully linked skills from "/some/path" (user).',
        }),
      );
    });

    it('should link a skill with workspace scope', async () => {
      const linkCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'link',
      )!;
      vi.mocked(linkSkill).mockResolvedValue([
        { name: 'test-skill', location: '/path' },
      ]);

      await linkCmd.action!(context, '/some/path --scope workspace');

      expect(linkSkill).toHaveBeenCalledWith(
        '/some/path',
        'workspace',
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('should show error if link fails', async () => {
      const linkCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'link',
      )!;
      vi.mocked(linkSkill).mockRejectedValue(new Error('Link failed'));

      await linkCmd.action!(context, '/some/path');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Failed to link skills: Link failed',
        }),
      );
    });

    it('should show error if path is missing', async () => {
      const linkCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'link',
      )!;
      await linkCmd.action!(context, '');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Usage: /skills link <path> [--scope user|workspace]',
        }),
      );
    });
  });

  describe('reload', () => {
    it('should reload skills successfully and show success message', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      // Make reload take some time so timer can fire
      const reloadSkillsMock = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      context.services.agentContext!.config.reloadSkills = reloadSkillsMock;

      const actionPromise = reloadCmd.action!(context, '');

      // Initially, no pending item (flicker prevention)
      expect(context.ui.setPendingItem).not.toHaveBeenCalled();

      // Fast forward 100ms to trigger the pending item
      await vi.advanceTimersByTimeAsync(100);
      expect(context.ui.setPendingItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Reloading agent skills...',
        }),
      );

      // Fast forward another 100ms (reload complete), but pending item should stay
      await vi.advanceTimersByTimeAsync(100);
      expect(context.ui.setPendingItem).not.toHaveBeenCalledWith(null);

      // Fast forward to reach 500ms total
      await vi.advanceTimersByTimeAsync(300);
      await actionPromise;

      expect(reloadSkillsMock).toHaveBeenCalled();
      expect(context.ui.reloadCommands).toHaveBeenCalled();
      expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Agent skills reloaded successfully.',
        }),
      );
    });

    it('should show new skills count after reload', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      const reloadSkillsMock = vi.fn().mockImplementation(async () => {
        const skillManager =
          context.services.agentContext!.config.getSkillManager();
        vi.mocked(skillManager.getSkills).mockReturnValue([
          { name: 'skill1' },
          { name: 'skill2' },
          { name: 'skill3' },
        ] as SkillDefinition[]);
      });
      context.services.agentContext!.config.reloadSkills = reloadSkillsMock;

      await reloadCmd.action!(context, '');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Agent skills reloaded successfully. 1 newly available skill.',
        }),
      );
    });

    it('should show removed skills count after reload', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      const reloadSkillsMock = vi.fn().mockImplementation(async () => {
        const skillManager =
          context.services.agentContext!.config.getSkillManager();
        vi.mocked(skillManager.getSkills).mockReturnValue([
          { name: 'skill1' },
        ] as SkillDefinition[]);
      });
      context.services.agentContext!.config.reloadSkills = reloadSkillsMock;

      await reloadCmd.action!(context, '');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Agent skills reloaded successfully. 1 skill no longer available.',
        }),
      );
    });

    it('should show both added and removed skills count after reload', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      const reloadSkillsMock = vi.fn().mockImplementation(async () => {
        const skillManager =
          context.services.agentContext!.config.getSkillManager();
        vi.mocked(skillManager.getSkills).mockReturnValue([
          { name: 'skill2' }, // skill1 removed, skill3 added
          { name: 'skill3' },
        ] as SkillDefinition[]);
      });
      context.services.agentContext!.config.reloadSkills = reloadSkillsMock;

      await reloadCmd.action!(context, '');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: 'Agent skills reloaded successfully. 1 newly available skill and 1 skill no longer available.',
        }),
      );
    });

    it('should show error if configuration is missing', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      context.services.agentContext = null;

      await reloadCmd.action!(context, '');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Could not retrieve configuration.',
        }),
      );
    });

    it('should show error if reload fails', async () => {
      const reloadCmd = skillsCommand.subCommands!.find(
        (s) => s.name === 'reload',
      )!;
      const error = new Error('Reload failed');
      const reloadSkillsMock = vi.fn().mockImplementation(async () => {
        await new Promise((_, reject) => setTimeout(() => reject(error), 200));
      });
      context.services.agentContext!.config.reloadSkills = reloadSkillsMock;

      const actionPromise = reloadCmd.action!(context, '');
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(400);
      await actionPromise;

      expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Failed to reload skills: Reload failed',
        }),
      );
    });
  });
});
