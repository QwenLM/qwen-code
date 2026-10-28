// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type {
  ManagedAgentProvider,
  ManagedSessionWorktree,
} from './managed-agent-provider';
import { ManagedSessionWorktrees } from './ManagedSessionWorktrees';

const worktree: ManagedSessionWorktree = {
  id: 'worktree-a',
  sessionId: 'deleted-session',
  workspaceId: 'ws-a',
  state: 'ready',
  branch: 'worktree-managed-a',
  baseCommit: 'a'.repeat(40),
  cwdRelative: '.qwen-managed-session-worktrees/a',
  operationId: 'op-a',
  revision: 2,
};

describe('ManagedSessionWorktrees', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: NonNullable<ManagedAgentProvider['sessionWorktrees']>;

  async function flush() {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }

  async function render() {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ManagedSessionWorktrees
            provider={{
              storageKey: 'host:tenant:actor',
              sessionWorktrees: api,
            }}
            workspaceId="ws-a"
            clientId="client-a"
            open
            onOpenChange={vi.fn()}
          />
        </I18nProvider>,
      );
      await flush();
    });
  }

  async function click(label: string, dialog = '[role="dialog"]') {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(`${dialog} button`),
    ].find((item) => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  beforeEach(() => {
    api = {
      options: vi.fn(),
      list: vi.fn().mockResolvedValue({ data: [worktree] }),
      inspect: vi.fn().mockResolvedValue({ worktree, canCleanup: true }),
      cleanup: vi
        .fn()
        .mockResolvedValue({ ...worktree, state: 'removing', revision: 3 }),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps deleted-session worktrees accessible at Workspace scope and confirms directory-only cleanup', async () => {
    await render();
    expect(document.body.textContent).toContain('deleted-session');
    expect(document.body.textContent).toContain('keeps the branch');
    expect(api.inspect).not.toHaveBeenCalled();
    await click('Inspect cleanup');
    expect(api.inspect).toHaveBeenCalledWith(
      'ws-a',
      'worktree-a',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    await click('Remove worktree directory');
    expect(api.cleanup).not.toHaveBeenCalled();
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain('Git branch will be retained');
    await click('Remove worktree directory', '[role="alertdialog"]');
    expect(api.cleanup).toHaveBeenCalledWith(
      'ws-a',
      'worktree-a',
      expect.objectContaining({
        clientId: 'client-a',
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it('shows cleanup blockers and never offers force deletion', async () => {
    vi.mocked(api.inspect).mockResolvedValue({
      worktree,
      canCleanup: false,
      cleanupBlocker: 'worktree_dirty',
    });
    await render();
    await click('Inspect cleanup');
    expect(document.body.textContent).toContain('worktree_dirty');
    expect(document.body.textContent).toContain(
      'uncommitted changes, untracked files or ignored files',
    );
    expect(
      [...document.querySelectorAll('button')].some(
        (item) => item.textContent === 'Remove worktree directory',
      ),
    ).toBe(false);
    expect(api.cleanup).not.toHaveBeenCalled();
  });

  it('reuses the cleanup request key after an uncertain response', async () => {
    vi.mocked(api.cleanup).mockRejectedValueOnce(
      new TypeError('Lost response'),
    );
    await render();
    await click('Inspect cleanup');
    await click('Remove worktree directory');
    await click('Remove worktree directory', '[role="alertdialog"]');
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain('Lost response');
    await click('Remove worktree directory', '[role="alertdialog"]');
    expect(vi.mocked(api.cleanup).mock.calls[1]![2].idempotencyKey).toBe(
      vi.mocked(api.cleanup).mock.calls[0]![2].idempotencyKey,
    );
  });
});
