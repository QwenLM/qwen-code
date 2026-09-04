/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const workspaceState = vi.hoisted(() => ({
  workspaceCwd: '/work/primary',
  capabilities: {
    workspaces: [
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
    ],
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => workspaceState,
}));

vi.mock('../extensions/ExtensionsManagerPage', () => ({
  ExtensionsManagerPage: () => <div>Extensions</div>,
}));
vi.mock('../skills/SkillsManagerPage', () => ({
  SkillsManagerPage: () => <div>Skills</div>,
}));
vi.mock('../agents/AgentsManagerPage', () => ({
  AgentsManagerPage: () => <div>Agents</div>,
}));
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

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  workspaceState.capabilities.workspaces[0]!.trusted = true;
});

describe('PluginManagerPage MCP workspace selection', () => {
  it('shows the multi-workspace selector and locks it in MCP detail', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
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
        container?.querySelector('button[aria-label="Workspace"]'),
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
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
