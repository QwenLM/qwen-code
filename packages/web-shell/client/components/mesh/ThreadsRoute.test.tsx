// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadsRoute, type ThreadsApi } from './ThreadsRoute';
import type { ThreadDetailView } from './ThreadView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.useRealTimers();
});

const DETAIL: ThreadDetailView = {
  id: 'th_1',
  title: 'Investigate the flake',
  body: '',
  status: 'in_progress',
  reason: '1 run still working',
  posts: [],
  runs: [],
  budget: { turnsUsed: 0, turnLimit: 12, tokensUsed: 0, tokenLimit: 200_000 },
};

function api(overrides: Partial<ThreadsApi> = {}): ThreadsApi {
  return {
    listThreads: vi.fn(async () => ({
      threads: [
        {
          id: 'th_1',
          title: 'Investigate the flake',
          status: 'in_progress' as const,
          reason: '1 run still working',
          updatedAt: 1,
          liveRunCount: 1,
        },
      ],
    })),
    getThread: vi.fn(async () => DETAIL),
    previewReply: vi.fn(async () => ({ targets: [] })),
    postReply: vi.fn(async () => ({})),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ThreadsRoute', () => {
  it('lists threads, then opens the one that was clicked', async () => {
    const client = api();
    const container = render(<ThreadsRoute api={client} />);
    await flush();

    expect(container.textContent).toContain('Investigate the flake');

    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Investigate the flake'),
    )!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(client.getThread).toHaveBeenCalledWith('th_1');
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('tells the reader what to do when the daemon is unreachable', async () => {
    const container = render(
      <ThreadsRoute
        api={api({
          listThreads: vi.fn(async () => {
            throw new Error('ECONNREFUSED');
          }),
        })}
      />,
    );
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('ECONNREFUSED');
    expect(alert?.textContent).toContain('qwen serve');
  });

  it('never lets a slow preview answer a draft that has moved on', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: { targets: [] }) => void> = [];
    const previewReply = vi.fn(
      () =>
        new Promise<{ targets: [] }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const container = render(
      <ThreadsRoute api={api({ previewReply: previewReply as never })} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Investigate the flake'),
    )!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const textarea = container.querySelector('textarea')!;
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    await act(async () => {
      setValue('first draft');
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      setValue('second draft');
      vi.advanceTimersByTime(300);
    });

    // Both requests are in flight; answer the stale one last.
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]!({ targets: [] });
      resolvers[0]!({ targets: [] });
      await Promise.resolve();
    });

    // The preview describes the post about to be sent, so a late answer to an
    // older draft must not win. Both resolved empty here; what the test pins
    // is that the debounce fired once per settled draft, not once per keypress.
    expect(previewReply).toHaveBeenCalledTimes(2);
    expect(previewReply).toHaveBeenLastCalledWith('th_1', 'second draft');
  });

  it('clears the draft and reloads both views after a reply lands', async () => {
    const client = api();
    const container = render(<ThreadsRoute api={client} />);
    await flush();
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Investigate the flake'),
    )!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, 'have another look');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Post reply',
    )!;
    await act(async () => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(client.postReply).toHaveBeenCalledWith('th_1', 'have another look');
    expect(container.querySelector('textarea')!.value).toBe('');
    // The list can change too: a reply that books work moves a thread out of
    // "needs you", so both views reload.
    expect(client.listThreads).toHaveBeenCalledTimes(2);
    expect(client.getThread).toHaveBeenCalledTimes(2);
  });
});
