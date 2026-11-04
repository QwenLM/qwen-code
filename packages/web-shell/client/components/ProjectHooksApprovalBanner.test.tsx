// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ProjectHooksApprovalBanner } from './ProjectHooksApprovalBanner';

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
  // Plain render + macrotask flush: act() never drains while the banner's
  // poll interval keeps scheduling work in this environment.
  root!.render(
    <I18nProvider language="en">
      <ProjectHooksApprovalBanner />
    </I18nProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return container;
}

describe('ProjectHooksApprovalBanner', () => {
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
    const banner = element.querySelector(
      '[data-testid="project-hooks-approval-banner"]',
    );
    expect(banner).not.toBeNull();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-lines"]')
        ?.textContent,
    ).toContain('node hook-marker.mjs');
    element
      .querySelector<HTMLButtonElement>(
        '[data-testid="project-hooks-approve"]',
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).toHaveBeenCalledWith('approve');
  });

  it('reject records the keep-disabled decision', async () => {
    workspaceHooks.mockResolvedValue({ pendingApproval: true, hooks: [] });
    approveWorkspaceHooks.mockResolvedValue({
      decision: 'reject',
      reloaded: true,
    });
    const element = await mount();
    element
      .querySelector<HTMLButtonElement>('[data-testid="project-hooks-reject"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveWorkspaceHooks).toHaveBeenCalledWith('reject');
  });

  it('stays hidden when nothing awaits approval', async () => {
    workspaceHooks.mockResolvedValue({ hooks: [] });
    const element = await mount();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-banner"]'),
    ).toBeNull();
  });

  it('stays hidden when the daemon lacks the route', async () => {
    workspaceHooks.mockRejectedValue(new Error('404'));
    const element = await mount();
    expect(
      element.querySelector('[data-testid="project-hooks-approval-banner"]'),
    ).toBeNull();
  });
});
