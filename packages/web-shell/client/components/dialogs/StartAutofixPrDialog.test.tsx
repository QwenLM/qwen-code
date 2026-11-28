// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { indexAutofixPrWatches } from '../../utils/autofixPrWatches';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { workspaceGitHubPullRequests, workspaceClient } = vi.hoisted(() => {
  const workspaceGitHubPullRequests = vi.fn();
  const workspaceClient = {
    workspaceByCwd: vi.fn(() => ({ workspaceGitHubPullRequests })),
  };
  return { workspaceGitHubPullRequests, workspaceClient };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { StartAutofixPrDialog } = await import('./StartAutofixPrDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const primaryWs: DaemonWorkspaceCapability = {
  id: 'main',
  cwd: '/w/main',
  primary: true,
  trusted: true,
  kind: 'ordinary',
};

describe('StartAutofixPrDialog', () => {
  it('loads open PRs, lets the user pick one, and builds the /autofix-pr command with options', async () => {
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/w/main',
      available: true,
      pullRequests: [
        {
          number: 42,
          title: 'Fix CI flake',
          url: 'https://github.com/o/r/pull/42',
          author: 'alice',
          headRefName: 'fix/ci',
          state: 'open',
          reviewDecision: 'changes_requested',
          checks: 'failing',
          updatedAt: 1_700_000_000,
        },
        {
          number: 43,
          title: 'Already watched PR',
          url: 'https://github.com/o/r/pull/43',
          author: 'bob',
          headRefName: 'feat/x',
          state: 'open',
          reviewDecision: 'approved',
          checks: 'passing',
          updatedAt: 1_700_000_000,
        },
      ],
    });
    const watchIndex = indexAutofixPrWatches(
      new Map([
        [
          '',
          {
            available: true,
            watches: [
              {
                pr: 43,
                repo: 'o/r',
                host: 'github.com',
                url: 'https://github.com/o/r/pull/43',
                headRefName: 'feat/x',
                headSha: 'a'.repeat(40),
                pushes: 0,
                maxPushes: 10,
                session: 's1',
                preparedAt: null,
                lastCheck: null,
                checkedRecently: true,
                lastRound: null,
                stopped: null,
                watch: {
                  every: 2,
                  reply: true,
                  instructions: '',
                  task: 'feedc0ffee12',
                },
                ended: null,
                needsHuman: [],
                worktreeExists: true,
                fix: null,
              },
            ],
          },
        ],
      ]),
    );
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <I18nProvider language="en">
          <StartAutofixPrDialog
            workspaces={[primaryWs]}
            defaultWorkspaceCwd="/w/main"
            watchIndex={watchIndex}
            onStart={onStart}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    );
    expect(options).toHaveLength(2);
    expect(options[1]?.textContent).toContain('Watching');

    // Click PR #42 to fill the input.
    act(() => {
      options[0]!.click();
    });

    // Customize interval, uncheck reply, add instructions.
    const everyInput = document.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    const replyCheckbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    const instructionsInput = document.querySelector<HTMLInputElement>(
      'input[placeholder*="public API"]',
    )!;
    act(() => {
      setInputValue(everyInput, '5');
      replyCheckbox.click();
      setInputValue(instructionsInput, 'keep API stable');
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(onStart).toHaveBeenCalledWith({
      prompt:
        '/autofix-pr https://github.com/o/r/pull/42 --every 5 --no-reply keep API stable',
      workspaceCwd: '/w/main',
      sessionTitle: 'Autofix PR #42',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports one-shot mode and validates invalid PR input', async () => {
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/w/main',
      available: true,
      pullRequests: [],
    });
    const onStart = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <I18nProvider language="en">
          <StartAutofixPrDialog
            workspaces={[primaryWs]}
            defaultWorkspaceCwd="/w/main"
            onStart={onStart}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const prInput = document.querySelector<HTMLInputElement>(
      'input[placeholder*="PR URL"]',
    )!;
    const form = document.querySelector('form')!;

    act(() => {
      setInputValue(prInput, 'not-a-pr');
    });
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a GitHub pull request URL',
    );
    expect(onStart).not.toHaveBeenCalled();

    const onceRadio = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((el) => el.textContent?.includes('--once'))!;
    act(() => {
      onceRadio.click();
      setInputValue(prInput, '#99');
    });
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(onStart).toHaveBeenCalledWith({
      prompt: '/autofix-pr 99 --once',
      workspaceCwd: '/w/main',
      sessionTitle: 'Autofix PR #99',
    });
  });
});
