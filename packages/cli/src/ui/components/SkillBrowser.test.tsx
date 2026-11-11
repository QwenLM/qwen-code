/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir, type Config } from '@qwen-code/core';
import { cleanup, renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { SkillBrowser } from './SkillBrowser.js';
import { SkillDetailView } from './SkillDetailView.js';

const FAKE_KEY = {
  name: '',
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
  insertable: false,
  sequence: '',
};

describe('SkillBrowser', () => {
  afterEach(() => {
    cleanup();
  });

  it('infers a loaded ~/.agents/skills entry as a user source', async () => {
    const skill = {
      name: 'legacy-agent-skill',
      description: 'legacy skill',
      location: path.join(
        homedir(),
        '.agents',
        'skills',
        'legacy-agent-skill',
        'SKILL.md',
      ),
      body: '',
    };
    const manager = {
      getAllDiscoveredSkills: vi.fn().mockReturnValue([skill]),
      getAllSkills: vi.fn().mockReturnValue([skill]),
      isConditionallyVisible: vi.fn().mockReturnValue(true),
      getLoadErrors: vi.fn().mockReturnValue([]),
    };
    const config = {
      getSkillManager: vi.fn().mockReturnValue(manager),
    } as unknown as Config;

    const { lastFrame, unmount } = await renderWithProviders(
      <SkillBrowser
        config={config}
        settings={createMockSettings()}
        onOpenConfig={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('Project (0)');
    expect(frame).toContain('User (1)');
    unmount();
  });

  it('shows a lower-priority discovered skill as shadowed by the active source', async () => {
    const projectSkill = {
      name: 'shared-skill',
      description: 'project version',
      location: '/repo/.qwen/skills/shared-skill/SKILL.md',
      body: '',
      source: 'project',
    };
    const userSkill = {
      ...projectSkill,
      description: 'user version',
      location: '/home/user/.qwen/skills/shared-skill/SKILL.md',
      source: 'user',
    };
    const manager = {
      getAllDiscoveredSkills: vi
        .fn()
        .mockReturnValue([projectSkill, userSkill]),
      getAllSkills: vi.fn().mockReturnValue([userSkill]),
      isConditionallyVisible: vi.fn().mockReturnValue(true),
      getLoadErrors: vi.fn().mockReturnValue([]),
    };
    const config = {
      getSkillManager: vi.fn().mockReturnValue(manager),
    } as unknown as Config;

    const { lastFrame, unmount } = await renderWithProviders(
      <SkillBrowser
        config={config}
        settings={createMockSettings()}
        onOpenConfig={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('Project (1)');
    expect(frame).toContain('User (1)');
    expect(frame).toContain('shared-skill');
    expect(frame).toContain('shadowed by User');
    unmount();
  });

  it('does not reload the skill list when toggling fails to persist', async () => {
    const skill = {
      name: 'project-skill',
      description: 'project skill',
      location: '/repo/.qwen/skills/project-skill/SKILL.md',
      body: '',
      source: 'project',
    };
    const manager = {
      getAllDiscoveredSkills: vi.fn().mockReturnValue([skill]),
      getAllSkills: vi.fn().mockReturnValue([skill]),
      isConditionallyVisible: vi.fn().mockReturnValue(true),
      getLoadErrors: vi.fn().mockReturnValue([]),
    };
    const reloadSkills = vi.fn().mockResolvedValue(undefined);
    const config = {
      getSkillManager: vi.fn().mockReturnValue(manager),
      reloadSkills,
    } as unknown as Config;
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(false);

    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        <SkillBrowser
          config={config}
          settings={settings}
          onOpenConfig={vi.fn()}
          onExit={vi.fn()}
        />,
        { settings },
      );
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:down',
        FAKE_KEY,
      );
    });
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:down',
        FAKE_KEY,
      );
    });
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeFallback('Dialog', {
        ...FAKE_KEY,
        name: 'c',
        sequence: 'c',
        insertable: true,
      });
    });
    await waitUntilReady();

    expect(settings.setValue).toHaveBeenCalled();
    expect(reloadSkills).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the skill detail state when toggling fails to persist', async () => {
    const skill = {
      name: 'project-skill',
      description: 'project skill',
      location: '/repo/.qwen/skills/project-skill/SKILL.md',
      source: 'project' as const,
      enabled: true,
    };
    const reloadSkills = vi.fn().mockResolvedValue(undefined);
    const config = { reloadSkills } as unknown as Config;
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(false);
    const onSave = vi.fn();

    const { capturedRegistry, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <SkillDetailView
          skill={skill}
          config={config}
          settings={settings}
          onClose={vi.fn()}
          onSave={onSave}
        />,
        { settings },
      );
    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );
    });
    await waitUntilReady();

    const enabledLine = lastFrame()
      ?.split('\n')
      .find((line) => line.includes('Enabled'));
    expect(settings.setValue).toHaveBeenCalled();
    expect(enabledLine).toContain('Yes');
    expect(enabledLine).not.toContain('No');
    expect(reloadSkills).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    unmount();
  });
});
