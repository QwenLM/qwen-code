// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { workspaceGitHubPullRequests, workspaceClient } = vi.hoisted(() => {
  const workspaceGitHubPullRequests = vi.fn();
  const workspaceClient = {
    workspaceByCwd: () => ({ workspaceGitHubPullRequests }),
  };
  return { workspaceGitHubPullRequests, workspaceClient };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({ client: workspaceClient }),
  };
});

const { BindSessionPrDialog } = await import('./BindSessionPrDialog');

const OPEN_PR = {
  number: 16865,
  url: 'https://github.com/QwenLM/qwen-code/pull/16865',
  title: 'feat: something',
  state: 'open',
};

describe('BindSessionPrDialog', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      pullRequests: [OPEN_PR],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(props: { busy?: boolean; error?: string } = {}) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <BindSessionPrDialog
            workspaceCwd="/repo"
            busy={props.busy ?? false}
            error={props.error}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });
    return { onSubmit, onClose };
  }

  function input() {
    return document.querySelector<HTMLInputElement>(
      'input[aria-label="Bind PR"]',
    )!;
  }

  async function type(value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function submit() {
    await act(async () => {
      input().form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
  }

  it('binds a full URL without state and without fetching the list', async () => {
    const { onSubmit } = await render();
    const url = 'https://github.com/QwenLM/qwen-code/pull/16865';
    await type(url);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({ number: 16865, url });
    expect(workspaceGitHubPullRequests).not.toHaveBeenCalled();
  });

  it('parses a URL with a subpath and query', async () => {
    const { onSubmit } = await render();
    const url = 'https://github.com/QwenLM/qwen-code/pull/16865/files?x=1';
    await type(url);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({ number: 16865, url });
  });

  it('resolves a bare number through the open PR list', async () => {
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    expect(workspaceGitHubPullRequests).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      number: 16865,
      url: OPEN_PR.url,
      state: 'open',
    });
  });

  it('asks for the URL when the number is not in the open list', async () => {
    const { onSubmit } = await render();
    await type('42');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '#42',
    );
  });

  it('binds a draft PR by number, recording it as open', async () => {
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      pullRequests: [{ ...OPEN_PR, state: 'draft' }],
    });
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      number: 16865,
      url: OPEN_PR.url,
      state: 'open',
    });
  });

  it('caches the PR list across submissions', async () => {
    const { onSubmit } = await render();
    await type('42');
    await submit();
    await type('43');
    await submit();
    expect(workspaceGitHubPullRequests).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('surfaces a list fetch failure and asks for the URL', async () => {
    workspaceGitHubPullRequests.mockRejectedValue(new Error('boom'));
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'full PR URL',
    );
  });

  it('rejects invalid input without fetching', async () => {
    const { onSubmit } = await render();
    await type('not-a-pr');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(workspaceGitHubPullRequests).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('rejects a URL whose number exceeds the bound', async () => {
    const { onSubmit } = await render();
    await type('https://github.com/o/r/pull/1234567890');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows the daemon error and blocks submission while busy', async () => {
    const { onSubmit } = await render({ busy: true, error: 'daemon says no' });
    expect(input().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'daemon says no',
    );
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit an IME confirmation Enter', async () => {
    const { onSubmit } = await render();
    await type('16865');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      input().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
