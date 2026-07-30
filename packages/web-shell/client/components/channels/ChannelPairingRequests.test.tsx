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
  language = 'en',
}: {
  channelName?: string;
  list?: (name: string) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approve?: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
  language?: 'en' | 'zh-CN';
} = {}) {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
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
    expect(container.textContent).toContain(
      'Approvals take effect immediately; Save and Cancel do not undo them.',
    );
    const approve = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    expect(approve?.getAttribute('aria-label')).toBe(
      'Approve Ada, code ABCD1234',
    );
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
    const error = Object.assign(new Error('Approval failed.'), {
      status: 409,
      body: { error: 'Approval failed.' },
    });
    const approve = vi.fn().mockRejectedValue(error);
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

  it.each([
    new TypeError('Failed to fetch'),
    new DOMException('timeout', 'TimeoutError'),
  ])(
    'uses an actionable message when the daemon does not respond',
    async (error) => {
      const list = vi.fn().mockRejectedValue(error);
      await renderRequests({ list });

      expect(container.textContent).toContain(
        'Pairing requests are temporarily unavailable. Try again.',
      );
      expect(container.textContent).not.toContain(error.message);
    },
  );

  it('uses an actionable message when approval cannot reach the daemon', async () => {
    const error = Object.assign(
      new Error(
        'POST /workspaces/:workspace/channels/:name/pairing-requests/approve: HTTP 500',
      ),
      { status: 500, body: undefined },
    );
    const approve = vi.fn().mockRejectedValue(error);
    await renderRequests({ approve });

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      button?.click();
    });

    expect(container.textContent).toContain(
      'Pairing requests are temporarily unavailable. Try again.',
    );
    expect(container.textContent).toContain('ABCD1234');
  });

  it('uses an actionable message for malformed daemon errors', async () => {
    const error = Object.assign(
      new Error(
        'POST /workspaces/:workspace/channels/:name/pairing-requests/approve: [object Object]',
      ),
      {
        status: 502,
        body: { error: { message: 'Bad gateway' } },
      },
    );
    const approve = vi.fn().mockRejectedValue(error);
    await renderRequests({ approve });

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      button?.click();
    });

    expect(container.textContent).toContain(
      'Pairing requests are temporarily unavailable. Try again.',
    );
    expect(container.textContent).not.toContain(':workspace');
    expect(container.textContent).toContain('ABCD1234');
  });

  it('refreshes the list when an approval request has expired', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ requests: [] });
    const error = Object.assign(
      new Error(
        'POST /workspaces/:workspace/channels/:name/pairing-requests/approve: Pairing request was not found or has expired.',
      ),
      {
        status: 404,
        body: {
          error: 'Pairing request was not found or has expired.',
          code: 'channel_pairing_request_not_found',
        },
      },
    );
    const approve = vi.fn().mockRejectedValue(error);
    await renderRequests({ list, approve });

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Approve',
    );
    await act(async () => {
      button?.click();
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      'Pairing request was not found or has expired.',
    );
    expect(container.textContent).not.toContain('ABCD1234');
  });

  it('retries after loading requests fails', async () => {
    const error = Object.assign(new Error('Pairing list unavailable.'), {
      status: 503,
      body: { error: 'Pairing list unavailable.' },
    });
    const list = vi
      .fn()
      .mockRejectedValueOnce(error)
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

  it('uses an actionable message for transport failures', async () => {
    const error = Object.assign(
      new Error(
        'GET /workspaces/:workspace/channels/:name/pairing-requests: HTTP 500',
      ),
      { status: 500, body: undefined },
    );
    const list = vi.fn().mockRejectedValue(error);
    await renderRequests({ list });

    expect(container.textContent).toContain(
      'Pairing requests are temporarily unavailable. Try again.',
    );
    expect(container.textContent).not.toContain(
      'GET /workspaces/:workspace/channels/:name/pairing-requests',
    );
  });

  it('uses consistent approval wording in Chinese', async () => {
    await renderRequests({ language: 'zh-CN' });

    expect(container.textContent).toContain(
      '批准会立即生效，保存或取消都不会撤销已批准的访问。',
    );
    expect(container.textContent).toContain('批准');
    expect(container.textContent).not.toContain('允许');
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
