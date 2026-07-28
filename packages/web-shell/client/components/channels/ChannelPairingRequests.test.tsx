/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonChannelPairingApprovalResult,
  DaemonChannelPairingRequestsSnapshot,
} from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { ChannelPairingRequests } = await import('./ChannelPairingRequests');
const { I18nProvider } = await import('../../i18n');

const PENDING: DaemonChannelPairingRequestsSnapshot = {
  requests: [
    {
      senderId: 'user-42',
      senderName: 'Ada',
      code: 'ABCD1234',
      createdAt: Date.parse('2026-07-28T00:00:00.000Z'),
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

async function renderRequests({
  channelName = 'release-bot',
  list = vi.fn().mockResolvedValue(PENDING),
  approve = vi.fn(),
}: {
  channelName?: string;
  list?: (name: string) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approve?: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
} = {}) {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ChannelPairingRequests
          channelName={channelName}
          listRequests={list}
          approveRequest={approve}
        />
      </I18nProvider>,
    );
  });
  return { list, approve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T00:05:00.000Z'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('ChannelPairingRequests', () => {
  it('loads and displays pending requests for the selected Channel', async () => {
    const { list } = await renderRequests();

    expect(list).toHaveBeenCalledWith('release-bot');
    expect(container.textContent).toContain('Pending requests');
    expect(container.textContent).toContain('Ada');
    expect(container.textContent).toContain('user-42');
    expect(container.textContent).toContain('ABCD1234');
    expect(container.textContent).toContain('5 min ago');
  });

  it('approves a request and replaces the list with the daemon response', async () => {
    const approval: DaemonChannelPairingApprovalResult = {
      approved: PENDING.requests[0],
      requests: [],
    };
    const approve = vi.fn().mockResolvedValue(approval);
    await renderRequests({ approve });

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      button?.click();
    });

    expect(approve).toHaveBeenCalledWith('release-bot', 'ABCD1234');
    expect(container.textContent).toContain('Ada can now use this Channel.');
    expect(container.textContent).toContain('No pending requests');
    expect(container.textContent).not.toContain('ABCD1234');
  });

  it('keeps a request visible when approval fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('Approval failed.'));
    await renderRequests({ approve });

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      button?.click();
    });

    expect(container.textContent).toContain('Approval failed.');
    expect(container.textContent).toContain('ABCD1234');
  });

  it('retries after loading requests fails', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Pairing list unavailable.'))
      .mockResolvedValueOnce(PENDING);
    await renderRequests({ list });

    expect(container.textContent).toContain('Pairing list unavailable.');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Try again',
    );
    await act(async () => {
      retry?.click();
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('ABCD1234');
  });

  it('ignores an approval response after the selected Channel changes', async () => {
    let resolveApproval:
      | ((result: DaemonChannelPairingApprovalResult) => void)
      | undefined;
    const approve = vi.fn(
      () =>
        new Promise<DaemonChannelPairingApprovalResult>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const nextRequest = {
      senderId: 'user-91',
      senderName: 'Lin',
      code: 'WXYZ5678',
      createdAt: Date.now(),
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ requests: [nextRequest] });
    await renderRequests({ list, approve });

    const approveButton = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      approveButton?.click();
    });
    await renderRequests({ channelName: 'other-bot', list, approve });
    expect(container.textContent).toContain('WXYZ5678');

    await act(async () => {
      resolveApproval?.({
        approved: PENDING.requests[0],
        requests: [],
      });
    });

    expect(container.textContent).toContain('WXYZ5678');
    expect(container.textContent).not.toContain(
      'Ada can now use this Channel.',
    );
  });

  it('does not show requests from the previous Channel while loading', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(PENDING)
      .mockReturnValueOnce(
        new Promise<DaemonChannelPairingRequestsSnapshot>(() => undefined),
      );
    await renderRequests({ list });
    expect(container.textContent).toContain('ABCD1234');

    await renderRequests({ channelName: 'other-bot', list });

    expect(container.textContent).not.toContain('ABCD1234');
  });
});
