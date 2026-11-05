// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ProjectHooksApprovalCard } from './ProjectHooksApprovalCard';

const workspaceHooks = vi.fn();
const approveWorkspaceHooks = vi.fn();

vi.mock('../daemon/index.js', () => ({
  useOptionalDaemonWorkspace: () => ({
    client: { workspaceHooks, approveWorkspaceHooks },
    workspaceCwd: undefined,
  }),
  useDaemonWorkspaceEventSignals: () => undefined,
}));

vi.mock('../daemon/availability-context.js', () => ({
  useDaemonAvailability: () => 'available',
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Plain render + macrotask flush: act() never drains while the card's
  // poll interval keeps scheduling work in this environment.
  root!.render(
    <I18nProvider language="en">
      <ProjectHooksApprovalCard />
    </I18nProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return container;
}

describe('ProjectHooksApprovalCard', () => {
  it('asks for an explicit decision when project hooks are pending', async () => {
    workspaceHooks.mockResolvedValue({
      pendingApproval: true,
      pendingApprovalHooks: ['SessionStart  node hook-marker.mjs'],
      hooks: [],
    });
    approveWorkspaceHooks.mockResolvedValue({
      decision: 'approve',
      reloaded: true,
    });
    const element = await mount();
    const card = element.querySelector(
      '[data-testid="project-hooks-approval-card"] [data-web-shell-permission-panel]',
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('node hook-marker.mjs');
    element
      .querySelector<HTMLButtonElement>('[data-option-id="hooks_approve"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).toHaveBeenCalledWith('approve', undefined);
  });

  it('reject records the keep-disabled decision', async () => {
    workspaceHooks.mockResolvedValue({ pendingApproval: true, hooks: [] });
    approveWorkspaceHooks.mockResolvedValue({
      decision: 'reject',
      reloaded: true,
    });
    const element = await mount();
    element
      .querySelector<HTMLButtonElement>('[data-option-id="hooks_reject"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).toHaveBeenCalledWith('reject', undefined);
  });

  it('echoes the rendered block hash with the decision', async () => {
    workspaceHooks.mockResolvedValue({
      pendingApproval: true,
      pendingApprovalHash: 'rendered-hash',
      hooks: [],
    });
    approveWorkspaceHooks.mockResolvedValue({
      decision: 'approve',
      reloaded: true,
    });
    const element = await mount();
    element
      .querySelector<HTMLButtonElement>('[data-option-id="hooks_approve"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).toHaveBeenCalledWith(
      'approve',
      'rendered-hash',
    );
  });

  it('Escape defers without recording a decision, and a changed block re-asks', async () => {
    workspaceHooks.mockResolvedValue({
      pendingApproval: true,
      pendingApprovalHash: 'block-v1',
      hooks: [],
    });
    const element = await mount();
    const panel = element.querySelector<HTMLDivElement>(
      '[data-web-shell-permission-panel]',
    )!;
    panel.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).not.toHaveBeenCalled();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-card"]'),
    ).toBeNull();
  });

  it('pre-selects the reject side so a stray Enter never approves', async () => {
    workspaceHooks.mockResolvedValue({
      pendingApproval: true,
      pendingApprovalHooks: ['SessionStart  echo hi'],
      hooks: [],
    });
    const element = await mount();
    const selected = element.querySelector(
      '[data-web-shell-permission-option][aria-checked="true"]',
    );
    expect(selected?.getAttribute('data-option-id')).toBe('hooks_reject');
  });

  it('stays hidden when nothing awaits approval', async () => {
    workspaceHooks.mockResolvedValue({ hooks: [] });
    const element = await mount();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-card"]'),
    ).toBeNull();
  });

  it('stays hidden when the daemon lacks the route', async () => {
    workspaceHooks.mockRejectedValue(new Error('404'));
    const element = await mount();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-card"]'),
    ).toBeNull();
  });
});
