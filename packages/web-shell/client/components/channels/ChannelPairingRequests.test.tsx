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
  DaemonChannelPairingApprovalsSnapshot,
  DaemonChannelPairingRequestsSnapshot,
  DaemonChannelPairingRevocationRequest,
  DaemonChannelPairingRevocationResult,
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

const GROUP_PENDING: DaemonChannelPairingRequestsSnapshot = {
  requests: [
    {
      senderId: 'user-42',
      senderName: 'Ada',
      subject: {
        type: 'group',
        id: 'group-7',
        name: 'Release Team',
      },
      code: 'GROUP123',
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
  listApprovals = vi.fn().mockResolvedValue({ senderIds: ['paired-user'] }),
  revokeApproval = vi.fn(),
  staticAllowedUsers = [],
  language = 'en',
}: {
  channelName?: string;
  list?: (name: string) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approve?: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
  listApprovals?: (
    name: string,
  ) => Promise<DaemonChannelPairingApprovalsSnapshot>;
  revokeApproval?: (
    name: string,
    request: DaemonChannelPairingRevocationRequest,
  ) => Promise<DaemonChannelPairingRevocationResult>;
  staticAllowedUsers?: readonly string[];
  language?: 'en' | 'zh-CN';
} = {}) {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
        <ChannelPairingRequests
          channelName={channelName}
          listRequests={list}
          approveRequest={approve}
          listApprovals={listApprovals}
          revokeApproval={revokeApproval}
          staticAllowedUsers={staticAllowedUsers}
        />
      </I18nProvider>,
    );
  });
  return { list, approve, listApprovals, revokeApproval };
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
    const { list, listApprovals } = await renderRequests();

    expect(list).toHaveBeenCalledWith('release-bot');
    expect(listApprovals).toHaveBeenCalledWith('release-bot');
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

  it('identifies the group and requesting member for a group pairing request', async () => {
    const approval: DaemonChannelPairingApprovalResult = {
      approved: GROUP_PENDING.requests[0],
      requests: [],
    };
    const approve = vi.fn().mockResolvedValue(approval);
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({ senderIds: [], groupIds: [] })
      .mockResolvedValueOnce({ senderIds: [], groupIds: ['group-7'] });
    await renderRequests({
      list: vi.fn().mockResolvedValue(GROUP_PENDING),
      approve,
      listApprovals,
    });

    expect(container.textContent).toContain('Group: Release Team');
    expect(container.textContent).toContain('group-7');
    expect(container.textContent).toContain('Requested by Ada');
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Approve Group: Release Team, code GROUP123"]',
    );

    await act(async () => {
      button?.click();
    });

    expect(approve).toHaveBeenCalledWith('release-bot', 'GROUP123');
    expect(container.textContent).toContain(
      'Group: Release Team can now use this Channel.',
    );
    expect(container.textContent).toContain('No pending requests');
    expect(container.textContent).not.toContain('GROUP123');
    expect(container.textContent).not.toContain('No pairing approvals');
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-7"]'),
    ).not.toBeNull();
  });

  it('shows pairing approvals and distinguishes configured allowlist access', async () => {
    await renderRequests({
      listApprovals: vi.fn().mockResolvedValue({
        senderIds: ['paired-user', 'second-user'],
      }),
      staticAllowedUsers: ['configured-user'],
    });

    expect(container.textContent).toContain('Pairing approvals');
    expect(container.textContent).toContain('paired-user');
    expect(container.textContent).toContain('second-user');
    expect(container.textContent).toContain(
      'Configured allowlist users remain allowed after a pairing approval is revoked.',
    );
    expect(container.textContent).toContain('configured-user');
  });

  it('retries after loading pairing approvals fails', async () => {
    const error = Object.assign(new Error('Approval list unavailable.'), {
      status: 503,
      body: { error: 'Approval list unavailable.' },
    });
    const listApprovals = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ senderIds: ['paired-user'] });
    await renderRequests({ listApprovals });

    expect(container.textContent).toContain('Approval list unavailable.');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Try again',
    );
    await act(async () => {
      retry?.click();
    });

    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
  });

  it('confirms and revokes only the selected pairing approval', async () => {
    const revokeApproval = vi.fn().mockResolvedValue({
      revoked: 'paired-user',
      senderIds: ['second-user'],
    });
    await renderRequests({
      listApprovals: vi.fn().mockResolvedValue({
        senderIds: ['paired-user', 'second-user'],
      }),
      revokeApproval,
    });

    const revoke = Array.from(container.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'Revoke paired-user',
    );
    await act(async () => {
      revoke?.click();
    });

    expect(document.body.textContent).toContain(
      'Revoke pairing approval for paired-user?',
    );
    expect(revokeApproval).not.toHaveBeenCalled();

    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(revokeApproval).toHaveBeenCalledWith('release-bot', {
      senderId: 'paired-user',
    });
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).toBeNull();
    expect(container.textContent).toContain('second-user');
    expect(container.textContent).toContain(
      'Pairing approval for paired-user was revoked.',
    );
  });

  it('lists and revokes a group pairing approval by group ID', async () => {
    const revokeApproval = vi.fn().mockResolvedValue({
      revoked: 'group-7',
      senderIds: ['paired-user'],
      groupIds: ['group-8'],
    });
    await renderRequests({
      listApprovals: vi.fn().mockResolvedValue({
        senderIds: ['paired-user'],
        groupIds: ['group-7', 'group-8'],
      }),
      revokeApproval,
    });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke Group: group-7"]',
    );
    await act(async () => {
      revoke?.click();
    });

    expect(document.body.textContent).toContain(
      'Revoke pairing approval for Group: group-7?',
    );
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(revokeApproval).toHaveBeenCalledWith('release-bot', {
      groupId: 'group-7',
    });
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-7"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-8"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      'Pairing approval for Group: group-7 was revoked.',
    );
  });

  it('does not approve a request while a revoke is in flight', async () => {
    const revokeApproval = vi
      .fn()
      .mockReturnValue(
        new Promise<DaemonChannelPairingRevocationResult>(() => undefined),
      );
    const approve = vi.fn();
    await renderRequests({ approve, revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    await act(async () => {
      revoke?.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    const approveButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((item) => item.textContent?.trim() === 'Approve');
    expect(approveButton?.disabled).toBe(true);
    approveButton?.click();
    expect(approve).not.toHaveBeenCalled();
  });

  it('does not revoke an approval while an approval is in flight', async () => {
    const approve = vi
      .fn()
      .mockReturnValue(
        new Promise<DaemonChannelPairingApprovalResult>(() => undefined),
      );
    const revokeApproval = vi.fn();
    await renderRequests({ approve, revokeApproval });

    const approveButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((item) => item.textContent?.trim() === 'Approve');
    await act(async () => {
      approveButton?.click();
    });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    expect(revoke?.disabled).toBe(true);
    revoke?.click();
    expect(revokeApproval).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('cancels the revoke confirmation without revoking the approval', async () => {
    const revokeApproval = vi.fn();
    await renderRequests({ revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    await act(async () => {
      revoke?.click();
    });

    const cancel = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Cancel',
    );
    await act(async () => {
      cancel?.click();
    });

    expect(revokeApproval).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
  });

  it('keeps an approval visible when revoking it fails', async () => {
    const revokeError = Object.assign(new Error('Revocation failed.'), {
      status: 500,
      body: { error: 'Revocation failed.' },
    });
    const listApprovals = vi
      .fn()
      .mockResolvedValue({ senderIds: ['paired-user'] });
    const revokeApproval = vi.fn().mockRejectedValue(revokeError);
    await renderRequests({ listApprovals, revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    await act(async () => {
      revoke?.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(container.textContent).toContain('Revocation failed.');
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
    expect(listApprovals).toHaveBeenCalledTimes(1);
  });

  it('approves a request and replaces the list with the daemon response', async () => {
    const approval: DaemonChannelPairingApprovalResult = {
      approved: PENDING.requests[0],
      requests: [],
    };
    const approve = vi.fn().mockResolvedValue(approval);
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({ senderIds: [] })
      .mockResolvedValueOnce({ senderIds: ['user-42'] });
    await renderRequests({ approve, listApprovals });

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
    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('button[aria-label="Revoke user-42"]'),
    ).not.toBeNull();
  });

  it('refreshes pairing approvals when a revoke target is already gone', async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({ senderIds: ['paired-user'] })
      .mockResolvedValueOnce({ senderIds: [] });
    const revokeError = Object.assign(new Error('Approval is gone.'), {
      status: 404,
      body: {
        error: 'Pairing approval was not found.',
        code: 'channel_pairing_approval_not_found',
      },
    });
    const revokeApproval = vi.fn().mockRejectedValue(revokeError);
    await renderRequests({ listApprovals, revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    await act(async () => {
      revoke?.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No pairing approvals');
    expect(container.textContent).not.toContain(
      'Pairing approval was not found.',
    );
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).toBeNull();
  });

  it('refreshes group approvals when a group revoke target is already gone', async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({
        senderIds: ['paired-user'],
        groupIds: ['group-7', 'group-8'],
      })
      .mockResolvedValueOnce({
        senderIds: ['paired-user'],
        groupIds: ['group-8'],
      });
    const revokeError = Object.assign(new Error('Approval is gone.'), {
      status: 404,
      body: {
        error: 'Pairing approval was not found.',
        code: 'channel_pairing_approval_not_found',
      },
    });
    const revokeApproval = vi.fn().mockRejectedValue(revokeError);
    await renderRequests({ listApprovals, revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke Group: group-7"]',
    );
    await act(async () => {
      revoke?.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(
      'Pairing approval was not found.',
    );
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-7"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-8"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
  });

  it('shows an error when refreshing after a missing approval fails', async () => {
    const refreshError = Object.assign(new Error('Refresh failed.'), {
      status: 503,
      body: { error: 'Refresh failed.' },
    });
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({ senderIds: ['paired-user'] })
      .mockRejectedValueOnce(refreshError);
    const revokeError = Object.assign(new Error('Approval is gone.'), {
      status: 404,
      body: {
        error: 'Pairing approval was not found.',
        code: 'channel_pairing_approval_not_found',
      },
    });
    const revokeApproval = vi.fn().mockRejectedValue(revokeError);
    await renderRequests({ listApprovals, revokeApproval });

    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke paired-user"]',
    );
    await act(async () => {
      revoke?.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Revoke approval',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Refresh failed.');
    expect(
      container.querySelector('button[aria-label="Revoke paired-user"]'),
    ).not.toBeNull();
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

  it('does not show approvals from the previous Channel while loading', async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce({
        senderIds: ['paired-user'],
        groupIds: ['group-7'],
      })
      .mockReturnValueOnce(
        new Promise<DaemonChannelPairingApprovalsSnapshot>(() => undefined),
      );
    await renderRequests({ listApprovals });
    expect(container.textContent).toContain('paired-user');
    expect(
      container.querySelector('button[aria-label="Revoke Group: group-7"]'),
    ).not.toBeNull();

    await renderRequests({ channelName: 'other-bot', listApprovals });

    expect(container.textContent).not.toContain('paired-user');
    expect(container.textContent).not.toContain('group-7');
  });
});
