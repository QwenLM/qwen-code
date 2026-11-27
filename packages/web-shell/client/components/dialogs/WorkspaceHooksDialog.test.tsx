// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const workspaceHooks = vi.fn();
const approveWorkspaceHooks = vi.fn();
const workspaceByCwd = vi.fn(() => ({
  workspaceHooks,
  approveWorkspaceHooks,
}));
const client = { workspaceByCwd };

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({
    client,
  }),
  useWorkspaceEventSignals: () => undefined,
}));

const { WorkspaceHooksDialog } = await import('./WorkspaceHooksDialog');

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
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

describe('WorkspaceHooksDialog', () => {
  it('loads hooks for the target workspace and submits hash-bound approval', async () => {
    workspaceHooks
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/secondary',
        initialized: true,
        disabled: false,
        pendingApproval: true,
        pendingApprovalHash: 'hash-123',
        pendingApprovalHooks: ['PreToolUse: ./check.sh'],
        hooks: [
          {
            kind: 'hook',
            eventName: 'PreToolUse',
            source: 'project',
            matcher: 'Bash',
            enabled: false,
            disabledReason: 'untrusted',
            config: { type: 'command', command: './check.sh' },
          },
        ],
        events: {},
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/work/secondary',
        initialized: true,
        disabled: false,
        pendingApproval: false,
        hooks: [
          {
            kind: 'hook',
            eventName: 'PreToolUse',
            source: 'project',
            matcher: 'Bash',
            enabled: true,
            config: { type: 'command', command: './check.sh' },
          },
        ],
        events: {},
      });
    approveWorkspaceHooks.mockResolvedValue({ ok: true });

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceHooksDialog workspaceCwd="/work/secondary" />
        </I18nProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('PreToolUse: ./check.sh');
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/work/secondary');

    const approveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Approve hooks',
    );
    expect(approveButton).toBeDefined();

    await act(async () => {
      approveButton!.click();
    });

    expect(approveWorkspaceHooks).toHaveBeenCalledWith('approve', 'hash-123');
    await vi.waitFor(() => {
      expect(
        container.querySelector(
          '[data-testid="workspace-hooks-pending-approval"]',
        ),
      ).toBeNull();
    });
  });

  it('shows empty state when no hooks are configured', async () => {
    workspaceHooks.mockResolvedValue({
      v: 1,
      workspaceCwd: '/work/empty',
      initialized: true,
      disabled: false,
      hooks: [],
      events: {},
    });

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceHooksDialog workspaceCwd="/work/empty" />
        </I18nProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'No hooks configured for this workspace.',
      );
    });
  });
});
