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
import type { DaemonCapabilities } from '@qwen-code/web-shell/daemon-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { connectionState, skillsState, workspaceState } = vi.hoisted(() => ({
  connectionState: {
    current: {
      clientId: 'client-1',
      sessionId: undefined as string | undefined,
      workspaceCwd: '/workspace/demo' as string | undefined,
    },
  },
  skillsState: {
    current: {
      status: undefined,
      skills: [] as DaemonWorkspaceSkillStatus[],
      configSkills: undefined as DaemonWorkspaceSkillStatus[] | undefined,
      loading: false,
      error: undefined,
      ensureRuntime: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
      reloadConfig: vi.fn(),
      setEnabled: vi.fn(),
      install: vi.fn(),
      installArchive: vi.fn(),
      lookupInstallAttempt: vi.fn(),
      remove: vi.fn(),
    },
  },
  workspaceState: {
    current: {
      workspaceCwd: '/workspace/demo',
      client: {},
      capabilities: {
        features: ['workspace_skill_settings_toggle'],
        limits: undefined as DaemonCapabilities['limits'],
      },
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connectionState.current,
  useSkills: () => ({
    ...skillsState.current,
    configStatus: {
      skills: skillsState.current.configSkills ?? skillsState.current.skills,
    },
  }),
  useWorkspace: () => workspaceState.current,
}));

const { SkillsManagerPage } = await import('./SkillsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

async function renderPage(
  workspaceCwd?: string,
  onUseSkill = vi.fn(),
): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <SkillsManagerPage
          onClose={vi.fn()}
          onUseSkill={onUseSkill}
          workspaceCwd={workspaceCwd}
        />
      </I18nProvider>,
    );
  });
}

async function openSkill(name: string): Promise<void> {
  const skill = container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  expect(skill).not.toBeNull();
  await act(async () => {
    skill!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

async function selectSkillAction(action = 'Enable'): Promise<void> {
  const actions = container.querySelector<HTMLElement>(
    '[data-testid="skill-actions"]',
  );
  expect(actions).not.toBeNull();
  await act(async () => {
    actions!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.trim() === action);
  expect(item).toBeDefined();
  await act(async () => {
    item!.click();
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
  skillsState.current.configSkills = undefined;
  skillsState.current.loading = false;
  skillsState.current.error = undefined;
  skillsState.current.ensureRuntime.mockReset().mockResolvedValue(undefined);
  skillsState.current.reload.mockReset();
  skillsState.current.reloadConfig.mockReset().mockResolvedValue(undefined);
  skillsState.current.setEnabled.mockReset().mockResolvedValue({
    changed: true,
  });
  skillsState.current.install.mockReset();
  skillsState.current.installArchive.mockReset();
  skillsState.current.lookupInstallAttempt.mockReset();
  skillsState.current.remove.mockReset();
  workspaceState.current.capabilities.features = [
    'workspace_skill_settings_toggle',
  ];
  workspaceState.current.capabilities.limits = undefined;
  connectionState.current.sessionId = undefined;
  connectionState.current.workspaceCwd = '/workspace/demo';
  workspaceState.current.client = {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SkillsManagerPage', () => {
  async function uploadArchive(size: number) {
    await renderPage();
    const open = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Upload',
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const tab = Array.from(dialog.querySelectorAll('[role="tab"]')).find(
      (item) => item.textContent === 'ZIP',
    );
    await act(async () =>
      tab!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      ),
    );
    const file = new File(['zip'], 'demo.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', { value: size });
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () =>
      input.dispatchEvent(new Event('change', { bubbles: true })),
    );
    const submit = Array.from(dialog.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Upload',
    );
    await act(async () => submit!.click());
    return file;
  }

  it('passes native capabilities and their advertised limit into the install dialog', async () => {
    workspaceState.current.capabilities.features = [
      'workspace_skill_manage',
      'skill_archive_install',
    ];
    workspaceState.current.capabilities.limits = {
      maxSkillArchiveBytes: 10 * 1024 * 1024,
    };
    await uploadArchive(12 * 1024 * 1024);
    expect(document.body.textContent).toContain('10 MiB compressed limit');
    expect(skillsState.current.installArchive).not.toHaveBeenCalled();
    expect(skillsState.current.install).not.toHaveBeenCalled();
  });

  it('keeps a confirmed archive installation successful when runtime activation fails', async () => {
    workspaceState.current.capabilities.features = [
      'workspace_skill_manage',
      'skill_archive_install',
    ];
    skillsState.current.installArchive.mockResolvedValue({
      skillName: 'demo',
      scope: 'workspace',
      attemptId: 'attempt',
      archiveSha256: 'a'.repeat(64),
    });
    skillsState.current.ensureRuntime.mockImplementation(
      async (options?: { throwOnError?: boolean }) => {
        if (options?.throwOnError) throw new Error('runtime unavailable');
      },
    );
    const file = await uploadArchive(20 * 1024 * 1024);
    expect(skillsState.current.installArchive).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo', data: file }),
      'workspace',
    );
    expect(skillsState.current.reloadConfig).toHaveBeenCalledOnce();
    expect(skillsState.current.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(skillsState.current.ensureRuntime).toHaveBeenLastCalledWith({
      throwOnError: true,
    });
    expect(document.body.textContent).toContain('installed successfully');
    expect(document.body.textContent).toContain(
      'runtime activation failed: runtime unavailable',
    );
    expect(skillsState.current.install).not.toHaveBeenCalled();
    expect(skillsState.current.lookupInstallAttempt).not.toHaveBeenCalled();
  });

  const disabledSkill: DaemonWorkspaceSkillStatus = {
    kind: 'skill',
    status: 'disabled',
    name: 'review',
    description: 'Review code',
    level: 'user',
    modelInvocable: true,
    disabledReason: 'default',
  };

  it('keeps the setting notice in the list when the refreshed catalog omits the Skill', async () => {
    skillsState.current.skills = [disabledSkill];
    skillsState.current.reloadConfig.mockImplementation(async () => {
      skillsState.current.skills = [];
      await renderPage();
      return { skills: [] };
    });

    await renderPage();
    await openDisabledSkill('review');
    await selectSkillAction();

    expect(container.textContent).toContain('0 skills');
    expect(container.textContent).toContain('Workspace setting updated.');
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-slot="alert"] [aria-label="close"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.click();
    });
    expect(container.textContent).not.toContain('Workspace setting updated.');
  });

  it('shows a rejected write and releases the busy state without reporting success', async () => {
    skillsState.current.skills = [disabledSkill];
    skillsState.current.setEnabled.mockRejectedValueOnce(
      new Error('Settings write denied'),
    );

    await renderPage();
    await openDisabledSkill('review');
    await selectSkillAction();

    expect(container.textContent).toContain('Settings write denied');
    expect(container.textContent).not.toContain('Skill enabled.');
    expect(skillsState.current.reloadConfig).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="skill-actions"]',
      )?.disabled,
    ).toBe(false);
    expect(runButton()?.disabled).toBe(true);
  });

  it.each(['system', 'user', 'systemDefaults'] as const)(
    'can disable a workspace declaration while %s settings keep the Skill locked',
    async (lockedScope) => {
      const locked = {
        ...disabledSkill,
        disabledReason: 'hard' as const,
        lockedScope,
      };
      skillsState.current.skills = [locked];
      skillsState.current.reloadConfig.mockResolvedValue({ skills: [locked] });

      await renderPage('/workspace/secondary');
      await openDisabledSkill('review');
      await selectSkillAction('Disable in this workspace');

      expect(skillsState.current.setEnabled).toHaveBeenCalledExactlyOnceWith(
        'review',
        false,
        { clientId: undefined },
      );
      expect(container.textContent).toContain(
        'Workspace setting updated. Effective Skill availability did not change.',
      );
      expect(runButton()?.disabled).toBe(true);
    },
  );

  describe.each(['workspace', 'client', 'unmount'] as const)(
    'when the toggle scope changes via %s',
    (change) => {
      it.each(['write', 'refresh'])(
        'discards a stale result during the %s',
        async (phase) => {
          let finish!: () => void;
          const pending = new Promise<void>((resolve) => {
            finish = resolve;
          });
          skillsState.current.skills = [disabledSkill];
          if (phase === 'write') {
            skillsState.current.setEnabled.mockImplementationOnce(async () => {
              await pending;
              return { changed: true };
            });
          } else {
            skillsState.current.reloadConfig.mockImplementationOnce(
              async () => {
                await pending;
                return { skills: [] };
              },
            );
          }

          await renderPage();
          await openDisabledSkill('review');
          await selectSkillAction();
          if (change === 'workspace') {
            await renderPage('/workspace/secondary');
          } else if (change === 'client') {
            workspaceState.current.client = {};
            await renderPage();
          } else {
            await act(async () => root.render(null));
          }
          await act(async () => {
            finish();
            await pending;
          });

          expect(container.textContent).not.toContain(
            'Workspace setting updated.',
          );
          expect(container.textContent).not.toContain('Skill enabled.');
          expect(skillsState.current.reloadConfig).toHaveBeenCalledTimes(
            phase === 'write' ? 0 : 1,
          );
          if (change !== 'unmount') {
            expect(
              container.querySelector<HTMLButtonElement>(
                '[data-testid="skill-actions"]',
              )?.disabled,
            ).toBe(false);
          }
        },
      );
    },
  );

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
    skillsState.current.reloadConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/demo',
      initialized: true,
      skills: [enabledSkill],
      errors: [],
    });

    await renderPage();
    await openDisabledSkill(disabledSkill.name);
    await selectSkillAction();

    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      disabledSkill.name,
      true,
      { clientId: 'client-1' },
    );
  });

  it('omits the active workspace client id for a selected workspace', async () => {
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

    await renderPage('/workspace/secondary');
    await openDisabledSkill('review');
    await selectSkillAction();

    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      'review',
      true,
      { clientId: undefined },
    );
    connectionState.current.workspaceCwd = '/workspace/secondary';
    await renderPage();
    await selectSkillAction();
    expect(skillsState.current.setEnabled).toHaveBeenLastCalledWith(
      'review',
      true,
      { clientId: undefined },
    );
  });

  it('keeps the client id for an explicitly selected active workspace', async () => {
    connectionState.current.workspaceCwd = '/workspace/secondary';
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

    await renderPage('/workspace/secondary');
    await openDisabledSkill('review');
    await selectSkillAction();

    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      'review',
      true,
      { clientId: 'client-1' },
    );
  });

  it('keeps runtime-discovered installed Skills manageable', async () => {
    skillsState.current.skills = [
      {
        kind: 'skill',
        status: 'disabled',
        name: 'external',
        description: 'Added outside the daemon',
        level: 'project',
        modelInvocable: true,
        disabledReason: 'hard',
      },
    ];
    skillsState.current.configSkills = [];

    await renderPage();
    await openDisabledSkill('external');
    await selectSkillAction();

    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      'external',
      true,
      { clientId: 'client-1' },
    );
  });

  it('does not run a Skill from a workspace other than the active session', async () => {
    const onUseSkill = vi.fn();
    skillsState.current.skills = [
      {
        kind: 'skill',
        status: 'ok',
        name: 'deploy',
        description: 'Deploy from the selected workspace',
        level: 'project',
        modelInvocable: true,
      },
    ];

    connectionState.current.workspaceCwd = '/workspace/secondary';
    await renderPage(undefined, onUseSkill);
    await openSkill('deploy');

    expect(runButton()?.disabled).toBe(true);
    runButton()?.click();
    expect(onUseSkill).not.toHaveBeenCalled();
    await renderPage('/workspace/secondary', onUseSkill);
    expect(runButton()?.disabled).toBe(false);
  });

  it('does not target the primary workspace from a live session', async () => {
    const onUseSkill = vi.fn();
    connectionState.current.sessionId = 'live-session';
    connectionState.current.workspaceCwd = undefined;
    skillsState.current.skills = [
      {
        kind: 'skill',
        status: 'ok',
        name: 'deploy',
        description: 'Deploy from the primary workspace',
        level: 'project',
        modelInvocable: true,
      },
    ];

    await renderPage(undefined, onUseSkill);
    await openSkill('deploy');

    expect(runButton()?.disabled).toBe(true);
    runButton()?.click();
    expect(onUseSkill).not.toHaveBeenCalled();

    const actions = container.querySelector<HTMLElement>(
      '[data-testid="skill-actions"]',
    );
    await act(async () => {
      actions!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const disable = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === 'Disable');
    expect(disable).toBeDefined();
    await act(async () => {
      disable!.click();
      await Promise.resolve();
    });
    expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
      'deploy',
      false,
      { clientId: undefined },
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
    skillsState.current.reloadConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/demo',
      initialized: true,
      skills: [enabledSkill],
      errors: [],
    });

    await renderPage();
    await openDisabledSkill(disabledSkill.name);
    await selectSkillAction();
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
      skillsState.current.reloadConfig.mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace/demo',
        initialized: true,
        skills: [skill],
        errors: [],
      });

      await renderPage();
      await openDisabledSkill(skill.name);
      expect(runButton()?.disabled).toBe(true);

      await selectSkillAction();

      expect(skillsState.current.setEnabled).toHaveBeenCalledWith(
        skill.name,
        true,
        { clientId: 'client-1' },
      );
      expect(skillsState.current.reloadConfig).toHaveBeenCalledTimes(1);
      skillsState.current.skills = [{ ...skill }];
      await renderPage();
      expect(container.textContent).toContain(notice);
      expect(container.textContent).toContain('disabled');
      expect(runButton()?.disabled).toBe(true);
    },
  );
});
