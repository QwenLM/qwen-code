// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { ManagedSessionCwdControl } from './ManagedSessionCwdControl';
import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import type { useManagedCwdChange } from './use-managed-cwd-change';

describe('ManagedSessionCwdControl', () => {
  let root: Root;
  let container: HTMLDivElement;
  let portal: HTMLDivElement;
  let summary: ManagedAgentSessionSummary;
  let submit: ReturnType<typeof vi.fn>;
  let cwd: ReturnType<typeof useManagedCwdChange>;
  async function render(
    disabledReason?: string,
    language: 'en' | 'zh-CN' = 'en',
  ) {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <WebShellPortalRootContext.Provider value={portal}>
            <ManagedSessionCwdControl
              summary={summary}
              supported
              cwd={cwd}
              disabledReason={disabledReason}
              onSubmit={submit}
            />
          </WebShellPortalRootContext.Provider>
        </I18nProvider>,
      ),
    );
  }
  async function click(label: string, inPortal = false) {
    const button = [
      ...(inPortal ? portal : container).querySelectorAll('button'),
    ].find((node) => node.textContent === label)!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  }
  async function input(value: string) {
    const node = portal.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function send() {
    await act(async () =>
      portal
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
  }
  beforeEach(() => {
    container = document.createElement('div');
    portal = document.createElement('div');
    document.body.append(container, portal);
    root = createRoot(container);
    summary = {
      sessionId: 's1',
      title: 'S',
      workspace: {
        workspaceId: 'ws',
        cwdRelative: 'A',
        contextRevision: 1,
        state: 'ready',
      },
      createdAt: 1,
      updatedAt: 1,
      admittedAt: 1,
      phase: 'completed',
      runtimeReady: true,
      runtimeState: 'ready',
      capabilities: { canSend: true, canCancel: false, cwdChange: true },
    };
    submit = vi.fn().mockResolvedValue(false);
    cwd = {
      key: 'key',
      busy: false,
      blocked: false,
      submit: vi.fn(),
      confirm: vi.fn(),
      isBlocked: () => false,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
  });

  it('uses the scoped portal, focuses the input and restores the trigger on close', async () => {
    await render();
    await click('Change directory');
    expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(portal.querySelector('input'));
    await click('Close', true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(container.querySelector('button'));
  });

  it('requires explicit acknowledgement of a revision changed while the dialog is open', async () => {
    await render();
    await click('Change directory');
    await input('B');
    summary = {
      ...summary,
      workspace: {
        ...summary.workspace!,
        cwdRelative: 'C',
        contextRevision: 2,
      },
    };
    await render();
    await send();
    expect(submit).not.toHaveBeenCalled();
    expect(portal.textContent).toContain('changed to C');
    await click('Use the current directory context', true);
    await send();
    expect(submit).toHaveBeenCalledExactlyOnceWith('B', 2);
  });

  it('restores focus to the operation status when the trigger is disabled during a change', async () => {
    await render();
    await click('Change directory');
    cwd = { ...cwd, blocked: true, busy: true };
    await render();
    expect(container.textContent).toContain('Changing directory');
    expect(container.textContent).not.toContain('not confirmed yet');
    await click('Close', true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      document.activeElement?.closest('[data-testid="managed-cwd-control"]'),
    ).toBe(container.querySelector('[data-testid="managed-cwd-control"]'));
  });

  it('preserves whitespace and Unicode and rejects empty or identical paths', async () => {
    await render();
    await click('Change directory');
    await send();
    expect(submit).not.toHaveBeenCalled();
    await input('');
    await send();
    expect(submit).not.toHaveBeenCalled();
    await input(' 中文 dir ');
    await send();
    expect(submit).toHaveBeenCalledWith(' 中文 dir ', 1);
  });

  it('explains a disabled entry and keeps recovery available after capability revocation', async () => {
    await render('Waiting for an approval');
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(container.textContent).toContain('Waiting for an approval');
    summary = {
      ...summary,
      capabilities: { ...summary.capabilities, cwdChange: false },
    };
    cwd = { ...cwd, blocked: true, errorCode: 'unconfirmed' };
    await render();
    await click('Continue confirming');
    expect(cwd.confirm).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Change directory');
  });

  it('provides translated labels and a recovery button within an open modal', async () => {
    await render(undefined, 'zh-CN');
    await click('切换目录');
    expect(portal.querySelector('input')!.getAttribute('aria-label')).toContain(
      '根目录',
    );
    cwd = { ...cwd, blocked: true, errorCode: 'unconfirmed' };
    await render(undefined, 'zh-CN');
    await click('继续确认', true);
    expect(cwd.confirm).toHaveBeenCalledOnce();
  });
});
