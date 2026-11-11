/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import type { HeldApprovalRequest } from '@qwen-code/core';
import { PeerInboundApprovalChoice } from '../components/PeerInboundApprovalDialog.js';
import { usePeerInboundApproval } from './usePeerInboundApproval.js';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => ({
  isCrossSessionMessagingEnabled: vi.fn(() => true),
  setHeldMessageListener: vi.fn(),
  resolveHeldMessage: vi.fn(),
  withdrawHeldMessageClaim: vi.fn(() => true),
  isKnownPeerAddress: vi.fn(async () => false),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...mocks };
});

const settings = {
  user: { path: '/home/dev/.qwen/settings.json', settings: {} },
  project: { path: '/repo/.qwen/settings.json', settings: {} },
  local: { path: '/repo/.qwen/settings.local.json', settings: {} },
  flag: { path: '/tmp/flag.json', settings: {} },
} as unknown as LoadedSettings;

/** The listener the hook registered with the gate. */
function registeredListener(): (request: HeldApprovalRequest) => boolean {
  const calls = mocks.setHeldMessageListener.mock.calls;
  const listener = calls.map(([fn]) => fn).filter(Boolean).at(-1);
  if (!listener) throw new Error('no listener registered');
  return listener as (request: HeldApprovalRequest) => boolean;
}

function heldRequest(
  id: string,
  controller = new AbortController(),
  knownPeer = false,
) {
  return {
    request: {
      id,
      cause: 'no-mode-asserted' as const,
      knownPeer,
      heldCount: 1,
      summary: {
        preview: `preview ${id}`,
        body: `body ${id}`,
        truncated: false,
        attachmentCount: 0,
        claimedAddress: 'uds:/tmp/peer.sock',
      },
      signal: controller.signal,
    },
    controller,
  };
}

describe('usePeerInboundApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(true);
    mocks.isKnownPeerAddress.mockResolvedValue(false);
  });

  afterEach(() => vi.useRealTimers());

  it('raises a request for a held message', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    const { request } = heldRequest('abc');

    act(() => registeredListener()(request));

    expect(result.current.peerInboundApprovalRequest?.id).toBe('abc');
    expect(result.current.peerInboundApprovalRequest?.summary.body).toBe(
      'body abc',
    );
  });

  // [AC13] The queue holds up to 100; prompting is capped at one so a chatty
  // peer cannot produce a stack of dialogs to dismiss.
  it('declines a second request while one is open', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    let firstAsked = false;
    let secondAsked = true;
    act(() => {
      firstAsked = registeredListener()(heldRequest('first').request);
    });
    act(() => {
      secondAsked = registeredListener()(heldRequest('second').request);
    });

    // The refusal is the return value: an entry nobody is being asked about
    // must stay releasable rather than pinned by a question that never opened.
    expect(firstAsked).toBe(true);
    expect(secondAsked).toBe(false);
    expect(result.current.peerInboundApprovalRequest?.id).toBe('first');
  });

  it('accepts a new request once the first is answered', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    act(() => registeredListener()(heldRequest('first').request));
    act(() =>
      result.current.handlePeerInboundApproval({
        choice: PeerInboundApprovalChoice.APPROVE,
      }),
    );
    let asked = false;
    act(() => {
      asked = registeredListener()(heldRequest('second').request);
    });

    expect(result.current.peerInboundApprovalRequest?.id).toBe('second');
    expect(asked).toBe(true);
  });

  it('[AC2] resolves the message on approve and on deny', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));

    act(() => registeredListener()(heldRequest('yes').request));
    act(() =>
      result.current.handlePeerInboundApproval({
        choice: PeerInboundApprovalChoice.APPROVE,
      }),
    );
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith('yes', 'approve');

    act(() => registeredListener()(heldRequest('no').request));
    act(() =>
      result.current.handlePeerInboundApproval({
        choice: PeerInboundApprovalChoice.DENY,
      }),
    );
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith('no', 'deny');
    expect(result.current.peerInboundApprovalRequest).toBeNull();
  });

  // [AC11] Expiry is a distinct outcome: `expired` tells the sending model
  // nobody was there, where `denied` says a human considered it and refused.
  it('expires an unanswered request on the resolved deadline', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    act(() => registeredListener()(heldRequest('slow').request));

    await act(async () => { vi.advanceTimersByTime(299_000); });
    expect(mocks.resolveHeldMessage).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith('slow', 'expire');
    expect(result.current.peerInboundApprovalRequest).toBeNull();
  });

  it('does not expire a request that was already answered', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    act(() => registeredListener()(heldRequest('quick').request));
    act(() =>
      result.current.handlePeerInboundApproval({
        choice: PeerInboundApprovalChoice.APPROVE,
      }),
    );
    await act(async () => { vi.advanceTimersByTime(600_000); });

    expect(mocks.resolveHeldMessage).toHaveBeenCalledTimes(1);
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith('quick', 'approve');
  });

  // [AC14] Released, evicted or settled at shutdown: the question is withdrawn
  // rather than left on screen offering to deny something already delivered.
  it('withdraws the dialog when the gate aborts the request', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    const { request, controller } = heldRequest('withdrawn');
    act(() => registeredListener()(request));

    act(() => controller.abort());

    expect(result.current.peerInboundApprovalRequest).toBeNull();
    expect(mocks.resolveHeldMessage).not.toHaveBeenCalled();
  });

  it('accepts a new request after a withdrawal', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    const { request, controller } = heldRequest('withdrawn');
    act(() => registeredListener()(request));
    act(() => controller.abort());
    act(() => registeredListener()(heldRequest('next').request));

    expect(result.current.peerInboundApprovalRequest?.id).toBe('next');
  });

  it('reports how many other messages are waiting', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    const { request } = heldRequest('busy');
    act(() => registeredListener()({ ...request, heldCount: 4 }));

    expect(result.current.peerInboundApprovalRequest?.otherHeldCount).toBe(3);
  });

  /**
   * [RA9] The weakest identity signal there is, and it arrives with the request.
   *
   * Resolving it here instead meant rendering the dialog with an unqualified
   * claim and correcting it a tick later, and doing a second registry read for an
   * answer the transport already had.
   */
  it('[RA9] marks a sender the registry knew about on arrival', async () => {
    const { result } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    act(() =>
      registeredListener()(
        heldRequest('known', new AbortController(), true).request,
      ),
    );

    expect(result.current.peerInboundApprovalRequest?.knownPeer).toBe(true);
    expect(mocks.isKnownPeerAddress).not.toHaveBeenCalled();
  });

  /**
   * [RA8] The approval dialog renders behind every other surface, so a question
   * taken while one of them is up would be pinned and time out where nobody can
   * see it. Declining is the same answer a second concurrent hold gets: the
   * message stays queued with its notice and `/peers`.
   */
  it('[RA8] declines to ask while another surface owns the screen', async () => {
    const { result } = await renderHook(() =>
      usePeerInboundApproval({ settings, canPrompt: false }),
    );

    let asked = true;
    act(() => {
      asked = registeredListener()(heldRequest('blocked').request);
    });

    expect(asked).toBe(false);
    expect(result.current.peerInboundApprovalRequest).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  // [RA8] The other half: a tool permission prompt can appear while this dialog
  // is already up, and it renders in front. Holding the claim would leave the
  // message pinned against release with its expiry still running.
  it('[RA8] gives the claim back when the screen is taken away', async () => {
    const { result, rerender } = await renderHook(
      ({ canPrompt }: { canPrompt: boolean }) =>
        usePeerInboundApproval({ settings, canPrompt }),
      { initialProps: { canPrompt: true } },
    );
    act(() => registeredListener()(heldRequest('displaced').request));
    expect(result.current.peerInboundApprovalRequest?.id).toBe('displaced');

    await act(async () => {
      rerender({ canPrompt: false });
    });

    expect(mocks.withdrawHeldMessageClaim).toHaveBeenCalledWith('displaced');
    expect(result.current.peerInboundApprovalRequest).toBeNull();
    // Not a denial and not an expiry: the message is still queued.
    expect(mocks.resolveHeldMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // [AC22] Nothing registers when the feature is off.
  it('registers no listener when cross-session messaging is disabled', async () => {
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(false);
    await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    expect(mocks.setHeldMessageListener).not.toHaveBeenCalled();
  });

  it('unregisters on unmount', async () => {
    const { unmount } = await renderHook(() => usePeerInboundApproval({ settings, canPrompt: true }));
    unmount();
    expect(mocks.setHeldMessageListener).toHaveBeenLastCalledWith(undefined);
  });
});
