// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const { workspaceGitDiff, workspaceGitLog, workspaceClient } = vi.hoisted(
  () => {
    const workspaceGitDiff = vi.fn();
    const workspaceGitLog = vi.fn();
    const workspaceClient = {
      workspaceByCwd: () => ({
        workspaceGitDiff,
        workspaceGitDiffFile: vi.fn(),
        workspaceGitLog,
        workspaceGitCommitDetail: vi.fn(),
      }),
    };
    return { workspaceGitDiff, workspaceGitLog, workspaceClient };
  },
);

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({ client: workspaceClient }),
  };
});

const { GitDialog } = await import('./GitDialog');

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(initialView: 'diff' | 'log' = 'diff') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitDialog
          workspaceCwd="/repo"
          initialView={initialView}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('GitDialog', () => {
  it('switches views inside one dialog with complete tab semantics', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitLog.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      entries: [],
      hasMore: false,
    });
    mount();
    await flush();

    const dialog = document.body.querySelector('[data-web-shell-dialog]');
    const historyTab = document.getElementById('git-dialog-tab-log');
    const panel = document.getElementById('git-dialog-panel');
    expect(dialog).toBeTruthy();
    expect(historyTab?.getAttribute('aria-selected')).toBe('false');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('git-dialog-tab-diff');

    await act(async () => {
      historyTab?.click();
    });
    await flush();

    expect(
      document.body.querySelectorAll('[data-web-shell-dialog]'),
    ).toHaveLength(1);
    expect(historyTab?.getAttribute('aria-selected')).toBe('true');
    expect(panel?.getAttribute('aria-labelledby')).toBe('git-dialog-tab-log');
    expect(workspaceGitLog).toHaveBeenCalledWith(50, 0);
  });

  it('supports arrow-key tab navigation', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitLog.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      entries: [],
      hasMore: false,
    });
    mount();
    await flush();

    const diffTab = document.getElementById('git-dialog-tab-diff');
    await act(async () => {
      diffTab?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    await flush();

    expect(
      document
        .getElementById('git-dialog-tab-log')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
