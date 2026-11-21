/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { DaemonGoogleOAuthFlow } from '@qwen-code/sdk/daemon';
import {
  GoogleOAuthFlowPanel,
  type GoogleOAuthTransport,
} from './GoogleOAuthFlowPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.toLowerCase() === label.toLowerCase(),
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

async function renderPanel({
  root,
  transport,
  onActivated = vi.fn().mockResolvedValue(undefined),
  onOpenExternal = vi.fn(),
  onClose = vi.fn(),
}: {
  root: Root;
  transport: GoogleOAuthTransport;
  onActivated?: (flow: DaemonGoogleOAuthFlow) => void | Promise<void>;
  onOpenExternal?: (url: string) => void | Promise<void>;
  onClose?: () => void;
}) {
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <GoogleOAuthFlowPanel
          transport={transport}
          workspace="/workspace"
          onOpenExternal={onOpenExternal}
          onActivated={onActivated}
          onClose={onClose}
        />
      </I18nProvider>,
    );
  });
  const rerender = (
    nextTransport: GoogleOAuthTransport,
    workspace?: string,
  ) => {
    root.render(
      <I18nProvider language="en">
        <GoogleOAuthFlowPanel
          transport={nextTransport}
          workspace={workspace}
          onOpenExternal={onOpenExternal}
          onActivated={onActivated}
          onClose={onClose}
        />
      </I18nProvider>,
    );
  };
  return { onClose, rerender };
}

describe('GoogleOAuthFlowPanel', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows the authorization URL, submits a manual code, and cancels', async () => {
    let ready = false;
    const transport = {
      startGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'awaiting-code',
        authorizationUrl: 'https://accounts.google.test/oauth',
      }),
      getGoogleOAuthLogin: vi.fn().mockImplementation(async () =>
        ready
          ? {
              id: 'flow-1',
              status: 'ready',
              modelId: 'gemini-4-argon',
              userData: {
                projectId: 'managed-project',
                userTier: 'free-tier',
              },
            }
          : {
              id: 'flow-1',
              status: 'awaiting-code',
              authorizationUrl: 'https://accounts.google.test/oauth',
            },
      ),
      submitGoogleOAuthCode: vi.fn().mockImplementation(async () => {
        ready = true;
      }),
      cancelGoogleOAuthLogin: vi.fn().mockResolvedValue(undefined),
    };
    const onOpenExternal = vi.fn();
    const onActivated = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoogleOAuthFlowPanel
            transport={transport}
            workspace="/workspace"
            onOpenExternal={onOpenExternal}
            onActivated={onActivated}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });

    const link = document.querySelector(
      'a[href="https://accounts.google.test/oauth"]',
    );
    expect(link).not.toBeNull();
    expect(onOpenExternal).toHaveBeenCalledWith(
      'https://accounts.google.test/oauth',
    );
    const input = document.querySelector(
      'input[aria-label="Authorization code"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'manual-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(transport.submitGoogleOAuthCode).toHaveBeenCalledWith(
      'flow-1',
      'manual-code',
      { workspace: '/workspace' },
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    });
    expect(onActivated).toHaveBeenCalledTimes(1);

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'cancel',
    );
    expect(cancel).toBeDefined();
    await act(async () => (cancel as HTMLButtonElement).click());
    expect(transport.cancelGoogleOAuthLogin).toHaveBeenCalledWith('flow-1', {
      workspace: '/workspace',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the panel open and reports a cancellation failure', async () => {
    const onClose = vi.fn();
    const transport = {
      startGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'awaiting-code',
      }),
      getGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'awaiting-code',
      }),
      submitGoogleOAuthCode: vi.fn(),
      cancelGoogleOAuthLogin: vi
        .fn()
        .mockRejectedValue(new Error('cancel failed')),
    };
    await renderPanel({ root: root!, transport, onClose });
    const cancel = button('cancel');
    await act(async () => cancel.click());
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'cancel failed',
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waits for the old cancellation before starting a retry', async () => {
    const cancellation = deferred<void>();
    const transport = {
      startGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'awaiting-code',
      }),
      getGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'error',
        errorMessage: 'poll failed',
      }),
      submitGoogleOAuthCode: vi.fn(),
      cancelGoogleOAuthLogin: vi.fn(() => cancellation.promise),
    };
    await renderPanel({ root: root!, transport });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'poll failed',
      ),
    );
    await act(async () => button('Try again').click());
    expect(transport.startGoogleOAuthLogin).toHaveBeenCalledOnce();
    await act(async () => {
      cancellation.resolve();
      await cancellation.promise;
    });
    await vi.waitFor(() => {
      expect(transport.startGoogleOAuthLogin).toHaveBeenCalledTimes(2);
    });
  });

  it('starts a new flow when the transport or workspace changes', async () => {
    const makeTransport = (id: string) => ({
      startGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id,
        status: 'awaiting-code',
        authorizationUrl: `https://${id}.test/oauth`,
      }),
      getGoogleOAuthLogin: vi
        .fn()
        .mockImplementation(() => new Promise<never>(() => undefined)),
      submitGoogleOAuthCode: vi.fn(),
      cancelGoogleOAuthLogin: vi.fn().mockResolvedValue(undefined),
    });
    const first = makeTransport('old-flow');
    const second = makeTransport('new-flow');
    const result = await renderPanel({ root: root!, transport: first });
    await vi.waitFor(() =>
      expect(first.startGoogleOAuthLogin).toHaveBeenCalledOnce(),
    );
    await act(async () => {
      result.rerender(second, '/workspace-b');
    });
    await vi.waitFor(() => {
      expect(second.startGoogleOAuthLogin).toHaveBeenCalledOnce();
      expect(document.querySelector('a')?.getAttribute('href')).toBe(
        'https://new-flow.test/oauth',
      );
    });
  });

  it('retries a failed model activation without repeating OAuth', async () => {
    const parentClose = vi.fn();
    const onActivated = vi
      .fn()
      .mockRejectedValueOnce(new Error('activation failed'))
      .mockImplementation(async () => parentClose());
    const transport = {
      startGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'awaiting-code',
      }),
      getGoogleOAuthLogin: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'ready',
        modelId: 'gemini-4-argon',
      }),
      submitGoogleOAuthCode: vi.fn(),
      cancelGoogleOAuthLogin: vi.fn().mockResolvedValue(undefined),
    };
    const { onClose } = await renderPanel({
      root: root!,
      transport,
      onClose: parentClose,
      onActivated,
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'activation failed',
      );
    });
    await act(async () => button('Try again').click());
    await vi.waitFor(() => expect(onActivated).toHaveBeenCalledTimes(2));
    expect(transport.startGoogleOAuthLogin).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores an old authorization-code completion after retrying', async () => {
    vi.useFakeTimers();
    const oldPost = deferred<never>();
    const nextPost = deferred<never>();
    let flowNumber = 0;
    let polls = 0;
    const retryPoll = deferred<void>();
    const transport = {
      startGoogleOAuthLogin: vi.fn().mockImplementation(async () => {
        flowNumber += 1;
        return { id: `flow-${flowNumber}`, status: 'awaiting-code' };
      }),
      getGoogleOAuthLogin: vi.fn().mockImplementation(async (id: string) => {
        polls += 1;
        if (id === 'flow-1' && polls === 1) {
          return { id, status: 'awaiting-code' };
        }
        if (id === 'flow-1') await retryPoll.promise;
        return id === 'flow-1'
          ? { id, status: 'error', errorMessage: 'poll failed' }
          : { id, status: 'awaiting-code' };
      }),
      submitGoogleOAuthCode: vi.fn((id: string) => {
        if (id === 'flow-1') {
          retryPoll.resolve();
          return oldPost.promise;
        }
        return nextPost.promise;
      }),
      cancelGoogleOAuthLogin: vi.fn().mockResolvedValue(undefined),
    };
    await renderPanel({ root: root!, transport });
    const firstInput = document.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(firstInput, 'old-code');
      firstInput.dispatchEvent(new Event('input', { bubbles: true }));
      firstInput.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(transport.submitGoogleOAuthCode).toHaveBeenCalledWith(
      'flow-1',
      'old-code',
      { workspace: '/workspace' },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'poll failed',
    );
    await act(async () => button('Try again').click());
    await vi.waitFor(() =>
      expect(transport.startGoogleOAuthLogin).toHaveBeenCalledTimes(2),
    );
    const secondInput = document.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(secondInput, 'new-code');
      secondInput.dispatchEvent(new Event('input', { bubbles: true }));
      secondInput.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(secondInput.disabled).toBe(true);
    await act(async () => oldPost.reject(new Error('old auth failed')));
    expect(secondInput.disabled).toBe(true);
    expect(document.body.textContent).not.toContain('old auth failed');
  });

  it.each([
    ['en', 'Sign in with Google'],
    ['zh-CN', '使用 Google 账号登录'],
    ['zh-TW', '使用 Google 帳號登入'],
    ['ru', 'Войти через Google'],
  ] as const)(
    'renders the Google title through the %s locale catalog',
    async (language, title) => {
      const transport = {
        startGoogleOAuthLogin: vi.fn(() => new Promise(() => undefined)),
        getGoogleOAuthLogin: vi.fn(),
        submitGoogleOAuthCode: vi.fn(),
        cancelGoogleOAuthLogin: vi.fn(),
      };
      await act(async () => {
        root!.render(
          <I18nProvider language={language}>
            <GoogleOAuthFlowPanel
              transport={transport}
              workspace={undefined}
              onOpenExternal={vi.fn()}
              onActivated={vi.fn()}
              onClose={vi.fn()}
            />
          </I18nProvider>,
        );
      });
      expect(
        document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
      ).toBe(title);
    },
  );
});
