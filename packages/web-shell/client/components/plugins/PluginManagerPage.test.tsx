/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from '../managed/managed-agent-provider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface TestWorkspace {
  id: string;
  cwd: string;
  displayName?: string;
  primary: boolean;
  trusted: boolean;
}

const { workspaceState } = vi.hoisted(() => ({
  workspaceState: {
    workspaceCwd: '/work/a',
    capabilities: {
      features: [] as string[],
      workspaces: [] as Array<{
        id: string;
        cwd: string;
        displayName?: string;
        primary: boolean;
        trusted: boolean;
      }>,
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => workspaceState,
  useOptionalWorkspace: () => undefined,
}));

vi.mock('../extensions/ExtensionsManagerPage', async () => {
  const { ManagedExtensionsManagerPage } = await import(
    '../managed/ManagedExtensionsManagerPage'
  );
  return {
    ExtensionsManagerPage: (props: {
      managed?: {
        provider: ManagedAgentProvider;
        workspaceId?: string;
        sessionId?: string;
      };
      onClose: () => void;
    }) =>
      props.managed ? (
        <ManagedExtensionsManagerPage
          {...props.managed}
          onClose={props.onClose}
        />
      ) : (
        <div data-testid="daemon-extensions-page">Extensions</div>
      ),
  };
});
vi.mock('../agents/AgentsManagerPage', () => ({
  AgentsManagerPage: () => <div>Agents</div>,
}));
vi.mock('../skills/SkillsManagerPage', async () => {
  const React = await import('react');
  return {
    SkillsManagerPage: (props: {
      workspaceCwd?: string;
      workspaceControl?: ReactNode;
      embedded?: {
        onDetailChange(open: boolean): void;
        onBack?: () => void;
      };
    }) => {
      const [detail, setDetail] = React.useState(false);
      return detail ? (
        <div>
          {props.embedded?.onBack ? (
            <button
              type="button"
              aria-label="back"
              onClick={props.embedded.onBack}
            >
              back
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setDetail(false);
              props.embedded?.onDetailChange(false);
            }}
          >
            back to skills
          </button>
          <span data-testid="workspace-cwd">{props.workspaceCwd}</span>
          {props.workspaceControl}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDetail(true);
            props.embedded?.onDetailChange(true);
          }}
        >
          open skill
        </button>
      );
    },
  };
});
vi.mock('../mcp/McpManagerPage', () => ({
  McpManagerPage: (props: {
    workspaceCwd?: string;
    workspaceControl?: ReactNode;
    embedded?: { onDetailChange(open: boolean): void };
  }) => (
    <div data-testid="mcp-page" data-workspace={props.workspaceCwd}>
      {props.workspaceControl}
      <button
        type="button"
        onClick={() => props.embedded?.onDetailChange(true)}
      >
        Open detail
      </button>
    </div>
  ),
}));

const { PluginManagerPage } = await import('./PluginManagerPage');
const { I18nProvider } = await import('../../i18n');

it('keeps Managed Extensions separate from the daemon before Session selection', async () => {
  const provider = { storageKey: 'managed' } as ManagedAgentProvider;
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <PluginManagerPage
          onClose={vi.fn()}
          onUseSkill={vi.fn()}
          managedExtensions={{ provider }}
        />
      </I18nProvider>,
    ),
  );
  expect(
    container.querySelector('[data-testid="daemon-extensions-page"]'),
  ).toBeNull();
  expect(container.textContent).toContain(
    'Select a workspace and session to manage extensions.',
  );
});

it('queries the selected Managed Extension Workspace and Session and follows selection changes', async () => {
  const list = vi.fn(async () => ({ supported: true, extensions: [] }));
  const query = vi.fn(async (sessionId: string) => ({
    sessionId,
    supported: true,
    revision: 0,
    extensions: [],
    requestedExtensions: [],
  }));
  const provider = {
    storageKey: 'managed',
    extensions: { list, query, apply: vi.fn() },
  } as unknown as ManagedAgentProvider;
  const render = async (sessionId: string) => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
            managedExtensions={{
              provider,
              sessionId,
              workspaceId: `workspace-${sessionId}`,
            }}
          />
        </I18nProvider>,
      );
    });
  };
  await render('session-a');
  expect(list).toHaveBeenCalledExactlyOnceWith(
    'workspace-session-a',
    expect.anything(),
  );
  expect(query).toHaveBeenCalledExactlyOnceWith('session-a', expect.anything());
  expect(
    container.querySelector('[data-testid="daemon-extensions-page"]'),
  ).toBeNull();
  await render('session-b');
  expect(list).toHaveBeenLastCalledWith(
    'workspace-session-b',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(query).toHaveBeenLastCalledWith('session-b', expect.anything());
  expect(provider.extensions!.apply).not.toHaveBeenCalled();
});

it('keeps the Managed MCP entry separate from the daemon when no Session is selected', async () => {
  const provider = { storageKey: 'managed' } as ManagedAgentProvider;
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <PluginManagerPage
          onClose={vi.fn()}
          onUseSkill={vi.fn()}
          initialTab="mcp"
          managedMcp={{ provider }}
        />
      </I18nProvider>,
    ),
  );
  expect(container.querySelector('[data-testid="mcp-page"]')).toBeNull();
  expect(container.querySelector('[data-managed-mcp-manager]')).not.toBeNull();
  expect(container.textContent).toContain('Select a Managed Session');
  expect(container.querySelector('[aria-label="Workspace"]')).toBeNull();
});

it('queries the selected Managed Session through the MCP tab and follows Session changes', async () => {
  const query = vi.fn(async (sessionId: string) => ({
    sessionId,
    revision: 0,
    supported: true,
    availableServers: [],
    servers: [],
  }));
  const provider = {
    storageKey: 'managed',
    mcpManagement: { query, submit: vi.fn(), operation: vi.fn() },
  } as unknown as ManagedAgentProvider;
  const render = async (sessionId: string) => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
            initialTab="mcp"
            managedMcp={{
              provider,
              sessionId,
              workspaceId: `workspace-${sessionId}`,
            }}
          />
        </I18nProvider>,
      );
    });
  };
  await render('session-a');
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'session-a',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(container.querySelector('[data-testid="mcp-page"]')).toBeNull();
  expect(
    container.querySelector('[data-managed-mcp-manager]')?.textContent,
  ).toContain('session-a');
  await render('session-b');
  expect(query).toHaveBeenLastCalledWith('session-b', expect.anything());
  expect(
    container.querySelector('[data-managed-mcp-manager]')?.textContent,
  ).toContain('session-b');
  expect(
    container.querySelector('[data-managed-mcp-manager]')?.textContent,
  ).not.toContain('session-a');
  expect(provider.mcpManagement!.submit).not.toHaveBeenCalled();
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('PluginManagerPage Skills workspace selector', () => {
  beforeEach(() => {
    const skillsFixture: TestWorkspace[] = [
      { id: 'a', cwd: '/work/a', primary: true, trusted: false },
      { id: 'b', cwd: '/work/b', primary: false, trusted: true },
    ];
    workspaceState.workspaceCwd = '/work/a';
    workspaceState.capabilities.features = ['workspace_skills_config_runtime'];
    workspaceState.capabilities.workspaces = skillsFixture;
  });

  it('shows the selector on the list and disables it on Skill detail', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
        </I18nProvider>,
      );
    });

    const skillsTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Skills',
    );
    expect(skillsTab).toBeDefined();
    await act(async () => {
      skillsTab!.focus();
      skillsTab!.click();
    });

    const listSelector =
      container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(listSelector?.disabled).toBe(false);

    const openSkill = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'open skill',
    );
    await act(async () => openSkill!.click());

    const detailSelector =
      container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(detailSelector?.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="workspace-cwd"]')?.textContent,
    ).toBe('/work/b');
  });

  it.each([false, true])(
    'reports the displayed Skills workspace (split runtime: %s)',
    async (split) => {
      workspaceState.capabilities.features = split
        ? ['workspace_skills_config_runtime']
        : [];
      workspaceState.capabilities.workspaces[0]!.trusted = true;
      const onSkillsWorkspaceChange = vi.fn();
      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <PluginManagerPage
              initialTab="skills"
              skillsWorkspaceCwd="/work/b"
              onSkillsWorkspaceChange={onSkillsWorkspaceChange}
              managedSkills
              onClose={vi.fn()}
              onUseSkill={vi.fn()}
            />
          </I18nProvider>,
        );
      });
      const expected = split ? '/work/b' : '/work/a';
      expect(onSkillsWorkspaceChange).toHaveBeenLastCalledWith(expected);
      const openSkill = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'open skill',
      );
      await act(async () => openSkill!.click());
      expect(
        container.querySelector('[data-testid="workspace-cwd"]')?.textContent,
      ).toBe(expected);
    },
  );

  it('keeps legacy Skills management on the primary workspace', async () => {
    workspaceState.capabilities.features = [];
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
        </I18nProvider>,
      );
    });

    const skillsTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Skills',
    );
    await act(async () => {
      skillsTab!.focus();
      skillsTab!.click();
    });
    expect(container.querySelector('[role="combobox"]')).toBeNull();

    const openSkill = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'open skill',
    );
    await act(async () => openSkill!.click());
    expect(
      container.querySelector('[data-testid="workspace-cwd"]')?.textContent,
    ).toBe('/work/a');
  });
});

describe('PluginManagerPage back control', () => {
  const backButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to conversation"]',
    );

  it('renders a back control wired to onClose', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={onClose}
            onUseSkill={vi.fn()}
            showBackButton
          />
        </I18nProvider>,
      );
    });

    expect(backButton()).not.toBeNull();
    await act(async () => backButton()!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the back control after switching tabs', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
            showBackButton
          />
        </I18nProvider>,
      );
    });

    const mcpTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'MCP',
    );
    await act(async () => {
      mcpTab?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      mcpTab?.click();
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="mcp-page"]'),
      ).not.toBeNull();
    });
    expect(backButton()).not.toBeNull();
  });

  it('omits the back control by default', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
        </I18nProvider>,
      );
    });

    expect(backButton()).toBeNull();
  });

  it('keeps a back control in a detail view', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={onClose}
            onUseSkill={vi.fn()}
            showBackButton
            initialTab="skills"
          />
        </I18nProvider>,
      );
    });

    const openSkill = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'open skill',
    );
    await act(async () => openSkill!.click());

    expect(backButton()).toBeNull();
    const detailBack = container.querySelector<HTMLButtonElement>(
      'button[aria-label="back"]',
    );
    expect(detailBack).not.toBeNull();
    await act(async () => detailBack!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a single back control in managed mode', async () => {
    const provider = { storageKey: 'managed' } as ManagedAgentProvider;
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
            showBackButton
            managedExtensions={{ provider }}
          />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelectorAll('button[aria-label="back"]'),
    ).toHaveLength(1);
    expect(backButton()).not.toBeNull();
  });
});

describe('PluginManagerPage MCP workspace selection', () => {
  beforeEach(() => {
    const mcpFixture: TestWorkspace[] = [
      {
        id: 'primary',
        cwd: '/work/primary',
        displayName: 'Primary',
        primary: true,
        trusted: true,
      },
      {
        id: 'secondary',
        cwd: '/work/secondary',
        displayName: 'Secondary',
        primary: false,
        trusted: true,
      },
    ];
    workspaceState.workspaceCwd = '/work/primary';
    workspaceState.capabilities.features = [];
    workspaceState.capabilities.workspaces = mcpFixture;
  });

  it('shows the multi-workspace selector and locks it in MCP detail', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
        </I18nProvider>,
      );
    });

    const mcpTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'MCP',
    );
    expect(mcpTab).toBeDefined();
    await act(async () => {
      mcpTab?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      mcpTab?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('button[aria-label="Workspace"]'),
      ).not.toBeNull();
    });
    const rootSelector = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace"]',
    )!;
    expect(rootSelector.disabled).toBe(false);
    expect(
      container
        .querySelector('[data-testid="mcp-page"]')
        ?.getAttribute('data-workspace'),
    ).toBe('/work/primary');

    await act(async () => rootSelector.click());
    const secondary = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.trim() === 'Secondary');
    expect(secondary).toBeDefined();
    await act(async () => secondary?.click());
    expect(
      container
        .querySelector('[data-testid="mcp-page"]')
        ?.getAttribute('data-workspace'),
    ).toBe('/work/secondary');

    const openDetail = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open detail',
    );
    await act(async () => {
      openDetail?.click();
    });

    const detailSelector = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace"]',
    );
    expect(detailSelector?.disabled).toBe(true);
  });

  it('selects the first trusted workspace', async () => {
    workspaceState.capabilities.workspaces[0]!.trusted = false;
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage onClose={vi.fn()} onUseSkill={vi.fn()} />
        </I18nProvider>,
      );
    });

    const mcpTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'MCP',
    );
    await act(async () => {
      mcpTab?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      mcpTab?.click();
    });

    expect(
      container
        .querySelector('[data-testid="mcp-page"]')
        ?.getAttribute('data-workspace'),
    ).toBe('/work/secondary');
  });
});
