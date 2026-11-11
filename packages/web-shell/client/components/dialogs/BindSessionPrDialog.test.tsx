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

const { workspaceGitHubPullRequests, workspaceByCwd, workspaceClient } =
  vi.hoisted(() => {
    const workspaceGitHubPullRequests = vi.fn();
    const workspaceByCwd = vi.fn(() => ({ workspaceGitHubPullRequests }));
    const workspaceClient = { workspaceByCwd };
    return { workspaceGitHubPullRequests, workspaceByCwd, workspaceClient };
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

const LIST_RESPONSE = {
  v: 1,
  workspaceCwd: '/repo',
  available: true,
  pullRequests: [OPEN_PR],
};

describe('BindSessionPrDialog', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceGitHubPullRequests.mockResolvedValue(LIST_RESPONSE);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    props: { busy?: boolean; error?: string; workspaceCwd?: string } = {},
  ) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <BindSessionPrDialog
            workspaceCwd={props.workspaceCwd ?? '/repo'}
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

  it('normalizes a URL with a subpath and query to the canonical key', async () => {
    const { onSubmit } = await render();
    await type('https://github.com/QwenLM/qwen-code/pull/16865/files?x=1');
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      number: 16865,
      url: 'https://github.com/QwenLM/qwen-code/pull/16865',
    });
  });

  it('resolves a bare number against the calling workspace', async () => {
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    expect(workspaceByCwd).toHaveBeenCalledWith('/repo');
    expect(workspaceGitHubPullRequests).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      number: 16865,
      url: OPEN_PR.url,
      state: 'open',
    });
  });

  it('accepts the #N shorthand like the CLI does', async () => {
    const { onSubmit } = await render();
    await type('#16865');
    await submit();
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
      ...LIST_RESPONSE,
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

  it('reports a non-git workspace as unavailable, not as a missing number', async () => {
    workspaceGitHubPullRequests.mockResolvedValue({
      ...LIST_RESPONSE,
      available: false,
      pullRequests: [],
    });
    const { onSubmit } = await render();
    await type('42');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'not a git repository',
    );
  });

  it('skips list resolution entirely for a cwd-less legacy session', async () => {
    const { onSubmit } = await render({ workspaceCwd: '' });
    await type('16865');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(workspaceByCwd).not.toHaveBeenCalled();
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

  it('rejects a URL whose number is not a safe integer', async () => {
    const { onSubmit } = await render();
    await type('https://github.com/o/r/pull/99999999999999999999');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('strips URL credentials from the submitted payload', async () => {
    const { onSubmit } = await render();
    await type(
      'https://x-access-token:ghs_abc123@github.com/QwenLM/qwen-code/pull/16865',
    );
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      number: 16865,
      url: 'https://github.com/QwenLM/qwen-code/pull/16865',
    });
  });

  it('rejects an uppercase /PULL/ spelling like the core canonicalizer', async () => {
    const { onSubmit } = await render();
    await type('https://github.com/QwenLM/qwen-code/PULL/16865');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(workspaceGitHubPullRequests).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('surfaces install guidance when the daemon reports gh unavailable', async () => {
    workspaceGitHubPullRequests.mockRejectedValue({
      body: { code: 'github_cli_unavailable' },
    });
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'gh auth login',
    );
  });

  it('shows the daemon error and blocks a typed submission while busy', async () => {
    const { onSubmit } = await render({ busy: true, error: 'daemon says no' });
    await type('https://github.com/QwenLM/qwen-code/pull/16865');
    expect(input().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'daemon says no',
    );
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prefers a fresh local validation error over the stale host error', async () => {
    await render({ error: 'daemon says no' });
    await type('not-a-pr');
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a PR number or a full PR URL.',
    );
  });

  it('clears the local error when the input changes', async () => {
    await render();
    await type('42');
    await submit();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await type('https://github.com/QwenLM/qwen-code/pull/16865');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('issues one fetch and one submit for a double submit while resolving', async () => {
    let resolveList!: (value: typeof LIST_RESPONSE) => void;
    workspaceGitHubPullRequests.mockReturnValue(
      new Promise<typeof LIST_RESPONSE>((resolve) => {
        resolveList = resolve;
      }),
    );
    const { onSubmit } = await render();
    await type('16865');
    await submit();
    // The form guard must absorb the second submit while the list is in
    // flight (the cache is still empty at this point).
    await submit();
    await act(async () => {
      resolveList(LIST_RESPONSE);
    });
    expect(workspaceGitHubPullRequests).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does not submit an in-flight resolution after the parent unmounts the dialog', async () => {
    let resolveList!: (value: typeof LIST_RESPONSE) => void;
    workspaceGitHubPullRequests.mockReturnValue(
      new Promise<typeof LIST_RESPONSE>((resolve) => {
        resolveList = resolve;
      }),
    );
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <BindSessionPrDialog
            workspaceCwd="/repo"
            busy={false}
            onSubmit={onSubmit}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    await type('16865');
    await submit();
    // The parent unmounts the dialog while the list request is in flight.
    await act(async () => {
      root.render(<I18nProvider language="en">{null}</I18nProvider>);
    });
    await act(async () => {
      resolveList(LIST_RESPONSE);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the dialog dismissible while the list resolves', async () => {
    let resolveList!: (value: typeof LIST_RESPONSE) => void;
    workspaceGitHubPullRequests.mockReturnValue(
      new Promise<typeof LIST_RESPONSE>((resolve) => {
        resolveList = resolve;
      }),
    );
    const { onClose } = await render();
    await type('16865');
    await submit();
    // No modal trap: Cancel stays enabled during a slow list fetch.
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'cancel');
    expect(cancel).not.toBeUndefined();
    expect(cancel!.disabled).toBe(false);
    act(() => cancel!.click());
    expect(onClose).toHaveBeenCalled();
    await act(async () => {
      resolveList(LIST_RESPONSE);
    });
  });

  it('marks the form busy and keeps Cancel enabled during the bind write', async () => {
    const { onClose } = await render({ busy: true });
    await type('https://github.com/QwenLM/qwen-code/pull/16865');
    expect(input().form!.getAttribute('aria-busy')).toBe('true');
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'cancel');
    expect(cancel!.disabled).toBe(false);
    act(() => cancel!.click());
    expect(onClose).toHaveBeenCalled();
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
