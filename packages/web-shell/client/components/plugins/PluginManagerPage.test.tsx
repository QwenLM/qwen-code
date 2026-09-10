/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../extensions/ExtensionsManagerPage', () => ({
  ExtensionsManagerPage: () => <div>Extensions</div>,
}));
vi.mock('../agents/AgentsManagerPage', () => ({
  AgentsManagerPage: () => <div>Agents</div>,
}));
vi.mock('../skills/SkillsManagerPage', async () => {
  const React = await import('react');
  return {
    SkillsManagerPage: (props: {
      workspaceCwd?: string;
      workspaceControl?: ReactNode;
      embedded?: { onDetailChange(open: boolean): void };
    }) => {
      const [detail, setDetail] = React.useState(false);
      return detail ? (
        <div>
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
