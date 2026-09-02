/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonWorkspaceSkillStatus } from '@qwen-code/web-shell/daemon-react-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { skillsState, workspaceState } = vi.hoisted(() => ({
  skillsState: {
    current: {
      status: undefined,
      skills: [] as DaemonWorkspaceSkillStatus[],
      loading: false,
      error: undefined,
      reload: vi.fn(),
      setEnabled: vi.fn(),
      install: vi.fn(),
      remove: vi.fn(),
    },
  },
  workspaceState: {
    current: {
      capabilities: {
        features: ['workspace_skill_settings_toggle'],
      },
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useSkills: () => skillsState.current,
  useWorkspace: () => workspaceState.current,
}));

const { SkillsManagerPage } = await import('./SkillsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <SkillsManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
      </I18nProvider>,
    );
  });
}

async function openDisabledSkill(name: string): Promise<void> {
  const statusFilter = container.querySelector<HTMLElement>(
    '[aria-label="Filter skills by status"]',
  );
  expect(statusFilter).not.toBeNull();
  await act(async () => {
    statusFilter!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const disabledOption = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((item) => item.textContent?.trim() === 'Disabled');
  expect(disabledOption).toBeDefined();
  await act(async () => {
    disabledOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  const skill = container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  expect(skill).not.toBeNull();
  await act(async () => {
    skill!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function enableSelectedSkill(): Promise<void> {
  const actions = container.querySelector<HTMLElement>(
    '[data-testid="skill-actions"]',
  );
  expect(actions).not.toBeNull();
  await act(async () => {
    actions!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  const enable = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.trim() === 'Enable');
  expect(enable).toBeDefined();
  await act(async () => {
    enable!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function runButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Reference skill',
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  skillsState.current.status = undefined;
  skillsState.current.skills = [];
  skillsState.current.loading = false;
  skillsState.current.error = undefined;
  skillsState.current.reload.mockReset();
  skillsState.current.setEnabled.mockReset().mockResolvedValue({
    changed: true,
  });
  skillsState.current.install.mockReset();
  skillsState.current.remove.mockReset();
  workspaceState.current.capabilities.features = [
    'workspace_skill_settings_toggle',
  ];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SkillsManagerPage', () => {
  it('omits direct skill invocation when the host only exposes management', async () => {
    skillsState.current.skills = [
      {
        kind: 'skill',
        status: 'ok',
        name: 'review',
        description: 'Review code',
        level: 'user',
        modelInvocable: true,
      },
    ];

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <SkillsManagerPage onClose={vi.fn()} />
        </I18nProvider>,
      );
    });
    const skill = container.querySelector<HTMLElement>('[aria-label="review"]');
    expect(skill).not.toBeNull();
    await act(async () => {
      skill!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(runButton()).toBeUndefined();
    expect(
      container.querySelector('[data-testid="skill-actions"]'),
    ).not.toBeNull();
  });

  it('does not treat the retired Skill toggle capability as settings support', async () => {
    workspaceState.current.capabilities.features = ['workspace_skill_toggle'];
    skillsState.current.skills = [
      {
        kind: 'skill',
        status: 'disabled',
        name: 'review',
        description: 'Review code',
        level: 'user',
        modelInvocable: true,
        disabledReason: 'default',
      },
    ];

    await renderPage();
    await openDisabledSkill('review');

    const actions = container.querySelector<HTMLElement>(
      '[data-testid="skill-actions"]',
    );
    expect(actions).not.toBeNull();
    await act(async () => {
      actions!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const enable = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === 'Enable');
    expect(enable?.hasAttribute('data-disabled')).toBe(true);
  });

  it('allows settings writes for non-user-invocable Skills', async () => {
    const disabledSkill: DaemonWorkspaceSkillStatus = {
      kind: 'skill',
      status: 'disabled',
      name: 'model-only-helper',
      description: 'Model-only helper',
      level: 'user',
      modelInvocable: true,
      userInvocable: false,
      disabledReason: 'default',
    };
    const enabledSkill: DaemonWorkspaceSkillStatus = {
      ...disabledSkill,
      status: 'ok',
      disabledReason: undefined,
    };
    skillsState.current.skills = [disabledSkill];
    skillsState.current.reload.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/demo',
      initialized: true,
      skills: [enabledSkill],
      errors: [],
    });

    await renderPage();
    await openDisabledSkill(disabledSkill.name);
    await enableSelectedSkill();

    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      disabledSkill.name,
      true,
    );
  });

  it('shows the authoritative enabled state after a normal toggle', async () => {
    const disabledSkill: DaemonWorkspaceSkillStatus = {
      kind: 'skill',
      status: 'disabled',
      name: 'review',
      description: 'Review code',
      level: 'user',
      modelInvocable: true,
      disabledReason: 'default',
    };
    const enabledSkill: DaemonWorkspaceSkillStatus = {
      ...disabledSkill,
      status: 'ok',
      disabledReason: undefined,
    };
    skillsState.current.skills = [disabledSkill];
    skillsState.current.reload.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/demo',
      initialized: true,
      skills: [enabledSkill],
      errors: [],
    });

    await renderPage();
    await openDisabledSkill(disabledSkill.name);
    await enableSelectedSkill();
    skillsState.current.skills = [enabledSkill];
    await renderPage();

    expect(container.textContent).toContain('Skill enabled.');
    expect(container.textContent).toContain('enabled');
    expect(runButton()?.disabled).toBe(false);
  });

  it.each([
    {
      label: 'higher-scope locked',
      changed: false,
      notice:
        'Skill already has the requested workspace setting; no setting was changed.',
      skill: {
        kind: 'skill' as const,
        status: 'disabled' as const,
        name: 'locked',
        description: 'Locked by user settings',
        level: 'bundled' as const,
        modelInvocable: true,
        disabledReason: 'hard' as const,
        lockedScope: 'user' as const,
      },
    },
    {
      label: 'inactive Extension',
      changed: false,
      notice:
        'Skill already has the requested workspace setting; no setting was changed.',
      skill: {
        kind: 'skill' as const,
        status: 'disabled' as const,
        name: 'inactive',
        description: 'Inactive extension skill',
        level: 'extension' as const,
        modelInvocable: true,
        extensionName: 'demo',
        disabledReason: 'inactive_extension' as const,
      },
    },
    {
      label: 'changed default-disabled and higher-scope locked',
      changed: true,
      notice:
        'Workspace setting updated. Effective Skill availability did not change.',
      skill: {
        kind: 'skill' as const,
        status: 'disabled' as const,
        name: 'default-locked',
        description: 'Default-disabled and locked by user settings',
        level: 'bundled' as const,
        modelInvocable: true,
        disabledReason: 'hard' as const,
        lockedScope: 'user' as const,
      },
    },
  ])(
    'reports the workspace result for a $label Skill that stays disabled',
    async ({ skill, changed, notice }) => {
      skillsState.current.skills = [skill];
      skillsState.current.setEnabled.mockResolvedValueOnce({ changed });
      skillsState.current.reload.mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace/demo',
        initialized: true,
        skills: [skill],
        errors: [],
      });

      await renderPage();
      await openDisabledSkill(skill.name);
      expect(runButton()?.disabled).toBe(true);

      await enableSelectedSkill();

      expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
        skill.name,
        true,
      );
      expect(skillsState.current.reload).toHaveBeenCalledTimes(1);
      skillsState.current.skills = [{ ...skill }];
      await renderPage();
      expect(container.textContent).toContain(notice);
      expect(container.textContent).toContain('disabled');
      expect(runButton()?.disabled).toBe(true);
    },
  );
});
