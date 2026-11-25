/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Approval prompts for held cross-session peer messages.
 *
 * Registers this session as the review surface for the inbound gate. Only the
 * TUI does so: headless and ACP sessions have nowhere to show a prompt and keep
 * the text notice plus `/peers`, which is why the gate treats a listener as
 * optional rather than assuming one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isCrossSessionMessagingEnabled,
  resolveHeldMessage,
  setHeldMessageListener,
  withdrawHeldMessageClaim,
  type HeldApprovalRequest,
} from '@qwen-code/core';
import { resolvePeerApprovalTimeoutMs } from '../../config/dialogExpiry.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  PeerInboundApprovalChoice,
  type PeerInboundApprovalRequestState,
  type PeerInboundApprovalResult,
} from '../components/PeerInboundApprovalDialog.js';

export interface UsePeerInboundApprovalParams {
  settings: LoadedSettings;
  /**
   * Whether a prompt raised now would actually be on screen.
   *
   * False while any other dialog or permission prompt owns the surface. The
   * approval dialog renders last of all of them, so a request taken while one of
   * them is up would be pinned and timing out where nobody can see it.
   */
  canPrompt: boolean;
}

export interface UsePeerInboundApprovalResult {
  /** The message currently being asked about, or null. */
  peerInboundApprovalRequest: PeerInboundApprovalRequestState | null;
  handlePeerInboundApproval: (result: PeerInboundApprovalResult) => void;
}

export function usePeerInboundApproval({
  settings,
  canPrompt,
}: UsePeerInboundApprovalParams): UsePeerInboundApprovalResult {
  const [request, setRequest] =
    useState<PeerInboundApprovalRequestState | null>(null);

  // The gate calls the listener from a socket callback and reads back, in the
  // same tick, whether we took the question. React state is too late for that,
  // so the outstanding id is tracked in a ref.
  const outstandingIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const canPromptRef = useRef(canPrompt);
  canPromptRef.current = canPrompt;

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    outstandingIdRef.current = null;
    setRequest(null);
  }, []);

  useEffect(() => {
    if (!isCrossSessionMessagingEnabled()) return undefined;

    const onHeld = (held: HeldApprovalRequest): boolean => {
      // One prompt at a time. A second hold stays in the queue with its text
      // notice rather than stacking a dialog behind this one; returning false
      // tells the gate we are not asking, so it does not treat the entry as
      // pinned by a question nobody is being asked.
      if (outstandingIdRef.current !== null) return false;
      // Another surface owns the screen. Taking the question anyway would pin the
      // entry and start its expiry behind a dialog that never renders it.
      // Declining leaves it queued with its text notice and `/peers`, exactly as
      // a second concurrent hold is handled.
      if (!canPromptRef.current) return false;
      outstandingIdRef.current = held.id;

      setRequest({
        id: held.id,
        cause: held.cause,
        summary: held.summary,
        otherHeldCount: Math.max(0, held.heldCount - 1),
        // The weakest identity signal there is, and offered as exactly that: a
        // registry lookup, no probe, resolved by the transport when the message
        // arrived. Asking again here rendered the dialog with an unqualified
        // claim first and corrected it a tick later.
        knownPeer: held.knownPeer,
      });

      // Withdrawn when the message leaves the queue some other way — released
      // by a policy change, evicted, or settled at shutdown.
      held.signal.addEventListener(
        'abort',
        () => {
          if (outstandingIdRef.current === held.id) clear();
        },
        { once: true },
      );

      const timeoutMs = resolvePeerApprovalTimeoutMs(settingsRef.current);
      if (timeoutMs > 0) {
        timerRef.current = setTimeout(() => {
          if (outstandingIdRef.current !== held.id) return;
          // Distinct from a denial: `expired` tells the sending model nobody
          // was there, where `denied` says a human considered it and refused.
          resolveHeldMessage(held.id, 'expire');
          clear();
        }, timeoutMs);
      }

      return true;
    };

    setHeldMessageListener(onHeld);
    return () => {
      setHeldMessageListener(undefined);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [clear]);

  // The claim is given back when the screen is taken from us, not merely withheld
  // when it was never ours: a tool permission prompt can appear while this dialog
  // is already up, and it renders in front of this one.
  useEffect(() => {
    if (canPrompt) return;
    const id = outstandingIdRef.current;
    if (id === null) return;
    withdrawHeldMessageClaim(id);
    clear();
  }, [canPrompt, clear]);

  const handlePeerInboundApproval = useCallback(
    (result: PeerInboundApprovalResult) => {
      const id = outstandingIdRef.current;
      // Cleared first so the abort fired by resolving does not re-enter.
      clear();
      if (id === null) return;
      resolveHeldMessage(
        id,
        result.choice === PeerInboundApprovalChoice.APPROVE
          ? 'approve'
          : 'deny',
      );
    },
    [clear],
  );

  return { peerInboundApprovalRequest: request, handlePeerInboundApproval };
}
