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

const { workspaceState } = vi.hoisted(() => ({
  workspaceState: {
    workspaceCwd: '/work/a',
    capabilities: {
      features: ['workspace_skills_config_runtime'],
      workspaces: [
        { id: 'a', cwd: '/work/a', primary: true, trusted: false },
        { id: 'b', cwd: '/work/b', primary: false, trusted: true },
      ],
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => workspaceState,
}));

vi.mock('../extensions/ExtensionsManagerPage', () => ({
  ExtensionsManagerPage: () => <div>extensions</div>,
}));
vi.mock('../mcp/McpManagerPage', () => ({
  McpManagerPage: () => <div>mcp</div>,
}));
vi.mock('../agents/AgentsManagerPage', () => ({
  AgentsManagerPage: () => <div>agents</div>,
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

const { PluginManagerPage } = await import('./PluginManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  workspaceState.capabilities.features = ['workspace_skills_config_runtime'];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PluginManagerPage Skills workspace selector', () => {
  it('shows the selector on the list and disables it on Skill detail', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <PluginManagerPage
            mcpMessage={null}
            loadMcpMessage={vi.fn()}
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
          />
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
          <PluginManagerPage
            mcpMessage={null}
            loadMcpMessage={vi.fn()}
            onClose={vi.fn()}
            onUseSkill={vi.fn()}
          />
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
