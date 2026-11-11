/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedCommand } from '../input/types.js';
import { coreEvents } from '../utils/events.js';
import { peerHandle } from './peer-address.js';
import { summarizeHeldMessage } from './peer-message-preview.js';
import {
  HOLD_SETTLEMENT_BUDGET_MS,
  MAX_HELD_MESSAGES,
  UNREGISTERED_NOTICE_WINDOW_MS,
  _resetInboundPolicyForTest,
  applyInboundPolicy,
  decideInboundPolicy,
  describeEffectiveInboundPolicy,
  listHeldMessages,
  modeClassOf,
  reevaluateHeldMessages,
  resolveHeldMessage,
  setCrossSessionInboundResolver,
  setHeldMessageListener,
  setPeerReceiptSink,
  setPermissionModeGetter,
  setReviewSurfaceAvailable,
  settleHeldMessagesOnShutdown,
  type HeldApprovalRequest,
  type PeerMessageStatus,
} from './inbound-policy.js';

/**
 * The characters `sanitizeForDisplay` exists to remove.
 *
 * Checked by inclusion rather than by regex: a character class holding a control
 * character is itself the thing lint objects to, and the list reads better as a
 * list.
 */
const UNSAFE_DISPLAY_CHARS = ['\u001b', '\u200b', '\u202e', '\u2500'];

function hasUnsafeDisplayChars(text: string): boolean {
  return UNSAFE_DISPLAY_CHARS.some((character) => text.includes(character));
}

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock('../services/messageQueueManager.js', () => ({
  enqueue: enqueueMock,
  enqueuePendingNotification: vi.fn(),
}));
vi.mock('../utils/events.js', () => ({
  coreEvents: { emitFeedback: vi.fn() },
}));

// The mode-emit gate is off by default, which is what makes an undeclared
// sender the normal case. Tests that care about an attestation opt in.
const modeEmit = vi.hoisted(() => ({ enabled: false }));
vi.mock('./cross-session-feature.js', () => ({
  isCrossSessionMessagingEnabled: () => true,
  isPeerModeEmitEnabled: () => modeEmit.enabled,
}));

const discardMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock('./peer-files.js', () => ({ discardPeerFiles: discardMock }));

function command(text: string): QueuedCommand {
  return { prompt: text, commandMode: 'prompt' };
}

function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    command: command(text),
    from: 'uds:/tmp/peer.sock',
    hints: {},
    ...overrides,
  };
}

describe('inbound policy', () => {
  let receipts: Array<{
    from: string;
    status: PeerMessageStatus;
    knownPeer?: boolean;
  }>;

  beforeEach(() => {
    _resetInboundPolicyForTest();
    modeEmit.enabled = false;
    enqueueMock.mockClear();
    discardMock.mockClear();
    receipts = [];
    setPeerReceiptSink((msg, status) => {
      receipts.push({ from: msg.from, status, knownPeer: msg.knownPeer });
    });
  });

  afterEach(() => _resetInboundPolicyForTest());

  describe('mode classification', () => {
    it('treats only bypassPermissions as bypass class', () => {
      expect(modeClassOf('yolo')).toBe('bypass');
      expect(modeClassOf('default')).toBe('prompting');
      expect(modeClassOf('acceptEdits')).toBe('prompting');
      expect(modeClassOf('auto')).toBe('prompting');
      // dontAsk denies rather than auto-approves, so it is not bypass class.
      expect(modeClassOf('dontAsk')).toBe('prompting');
    });
  });

  describe('decideInboundPolicy', () => {
    it('honours an explicit setting over everything else', () => {
      setCrossSessionInboundResolver(() => ({
      policy: 'refuse',
      source: 'user',
    }));
      setPermissionModeGetter(() => 'default');
      expect(decideInboundPolicy({ selfSent: true }).policy).toBe('refuse');
    });

    it('accepts a message from our own descendant', () => {
      setPermissionModeGetter(() => 'yolo');
      expect(decideInboundPolicy({ selfSent: true }).policy).toBe('accept');
    });

    it('holds when the local permission mode is unknown', () => {
      const decision = decideInboundPolicy({});
      expect(decision.policy).toBe('hold');
      expect(decision.cause).toBe('mode-unknown');
    });

    it('accepts a sender whose declared class matches ours', () => {
      modeEmit.enabled = true;
      setPermissionModeGetter(() => 'default');
      expect(decideInboundPolicy({ fromMode: 'prompting' }).policy).toBe('accept');
    });

    it('holds a sender whose declared class differs', () => {
      modeEmit.enabled = true;
      setPermissionModeGetter(() => 'default');
      const decision = decideInboundPolicy({ fromMode: 'bypass' });
      expect(decision.policy).toBe('hold');
      expect(decision.cause).toBe('mode-mismatch');
    });

    // The receiver discards an attestation while the gate is off, so a peer on
    // an older build cannot shorten its own path to `accept`.
    it('ignores a declared class while the gate is off', () => {
      setPermissionModeGetter(() => 'yolo');
      const decision = decideInboundPolicy({ fromMode: 'bypass' });
      expect(decision.policy).toBe('hold');
      expect(decision.cause).toBe('no-mode-asserted');
    });

    // With the gate off nothing declares, so a prompting session accepts peer
    // traffic outright and `mode-mismatch` is unreachable.
    it('accepts undeclared traffic when we prompt, with the gate off', () => {
      setPermissionModeGetter(() => 'default');
      const decision = decideInboundPolicy({ fromMode: 'bypass' });
      expect(decision.policy).toBe('accept');
      expect(decision.cause).toBe('default-accept');
    });

    it('holds an undeclared sender when we are in bypass class', () => {
      setPermissionModeGetter(() => 'yolo');
      expect(decideInboundPolicy({}).cause).toBe('no-mode-asserted');
    });

    it('accepts an undeclared sender when we prompt', () => {
      setPermissionModeGetter(() => 'default');
      expect(decideInboundPolicy({}).policy).toBe('accept');
    });

    describe('unregistered senders', () => {
      it('holds a sender whose address names no registered session', () => {
        setPermissionModeGetter(() => 'default');
        expect(decideInboundPolicy({ knownPeer: false })).toEqual({
          policy: 'hold',
          cause: 'unregistered-sender',
        });
      });

      it('accepts a registered sender exactly as before', () => {
        setPermissionModeGetter(() => 'default');
        expect(decideInboundPolicy({ knownPeer: true })).toEqual({
          policy: 'accept',
          cause: 'default-accept',
        });
      });

      // Ahead of the mode check, so a message arriving during startup is held
      // under a cause that asks rather than one that waits silently.
      it('decides before the local permission mode is known', () => {
        expect(decideInboundPolicy({ knownPeer: false }).cause).toBe(
          'unregistered-sender',
        );
      });

      it('is not carried past by a matching declared class', () => {
        modeEmit.enabled = true;
        setPermissionModeGetter(() => 'default');
        expect(
          decideInboundPolicy({ fromMode: 'prompting', knownPeer: false }).cause,
        ).toBe('unregistered-sender');
      });

      it('names itself over no-mode-asserted in bypass class', () => {
        setPermissionModeGetter(() => 'yolo');
        expect(decideInboundPolicy({ knownPeer: false }).cause).toBe(
          'unregistered-sender',
        );
      });

      it('yields to our own descendant', () => {
        setPermissionModeGetter(() => 'default');
        expect(
          decideInboundPolicy({ selfSent: true, knownPeer: false }).policy,
        ).toBe('accept');
      });

      it('yields to an explicit accept', () => {
        setPermissionModeGetter(() => 'default');
        setCrossSessionInboundResolver(() => ({
          policy: 'accept',
          source: 'user',
        }));
        expect(decideInboundPolicy({ knownPeer: false }).policy).toBe('accept');
      });

      it('is refused where nobody can review it', () => {
        setPermissionModeGetter(() => 'default');
        setReviewSurfaceAvailable(false);
        expect(decideInboundPolicy({ knownPeer: false })).toEqual({
          policy: 'refuse',
          cause: 'no-review-surface',
        });
      });
    });
  });

  describe('applyInboundPolicy', () => {
    beforeEach(() => setPermissionModeGetter(() => 'default'));

    it('enqueues an accepted message and reports delivery', () => {
      expect(applyInboundPolicy(message('hi'))).toBe('accept');
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(receipts).toEqual([
        { from: 'uds:/tmp/peer.sock', status: 'delivered' },
      ]);
    });

    it('drops a refused message without enqueuing', () => {
      setCrossSessionInboundResolver(() => ({
      policy: 'refuse',
      source: 'user',
    }));
      expect(applyInboundPolicy(message('hi'))).toBe('refused');
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(receipts[0]?.status).toBe('denied');
    });

    it('parks a held message and reports it held', () => {
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
      expect(applyInboundPolicy(message('hi'))).toBe('held');
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(listHeldMessages()).toHaveLength(1);
      expect(receipts[0]?.status).toBe('held');
    });

    it('evicts the oldest entry past the cap and expires it', () => {
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
      for (let i = 0; i <= MAX_HELD_MESSAGES; i++) {
        applyInboundPolicy(message(`msg-${i}`));
      }
      const held = listHeldMessages();
      expect(held).toHaveLength(MAX_HELD_MESSAGES);
      expect(summarizeHeldMessage(held[0]).preview).toBe('msg-1');
      expect(receipts.some((r) => r.status === 'expired')).toBe(true);
    });
  });

  describe('resolveHeldMessage', () => {
    beforeEach(() => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
    });

    it('delivers on approve', () => {
      applyInboundPolicy(message('do it'));
      const id = listHeldMessages()[0].id;
      expect(resolveHeldMessage(id, 'approve')).toBe('delivered');
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(listHeldMessages()).toHaveLength(0);
    });

    it('drops on deny and tells the sender', () => {
      applyInboundPolicy(message('do it'));
      const id = listHeldMessages()[0].id;
      expect(resolveHeldMessage(id, 'deny')).toBe('dropped');
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(receipts.at(-1)?.status).toBe('denied');
    });

    it('reports an unknown id as gone', () => {
      expect(resolveHeldMessage('nope', 'approve')).toBe('gone');
    });

    /**
     * Every hold is announced when it arrives. Approval ends visibly — the
     * message itself appears in the feed — but a denial or an expiry used to
     * write nothing, leaving "Held a message from X" as the last word on a
     * thread that had in fact finished.
     */
    describe('closes the thread it opened', () => {
      function feedbackTexts(): string[] {
        return vi
          .mocked(coreEvents.emitFeedback)
          .mock.calls.map((call) => String(call[1]));
      }

      it('says so on deny, naming the sender it announced', () => {
        applyInboundPolicy(message('do it', { fromName: 'bar' }));
        const announced = feedbackTexts().at(-1) ?? '';

        resolveHeldMessage(listHeldMessages()[0].id, 'deny');

        const closing = feedbackTexts().at(-1) ?? '';
        expect(closing).toContain('Declined');
        // Same sender, same spelling: two different renderings of one identity
        // read as two different messages.
        const sender = `bar -${peerHandle('/tmp/peer.sock')}`;
        expect(announced).toContain(sender);
        expect(closing).toContain(sender);
      });

      it('says so on expiry', () => {
        applyInboundPolicy(message('do it'));
        resolveHeldMessage(listHeldMessages()[0].id, 'expire');

        expect(feedbackTexts().at(-1)).toContain('expired');
      });

      /** Approval is not announced here — the delivered message is the ending. */
      it('stays quiet on approve', () => {
        applyInboundPolicy(message('do it'));
        const before = feedbackTexts().length;

        resolveHeldMessage(listHeldMessages()[0].id, 'approve');

        expect(feedbackTexts()).toHaveLength(before);
      });
    });
  });

  describe('reevaluateHeldMessages', () => {
    it('delivers entries that now resolve to accept', () => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
      applyInboundPolicy(message('later'));

      setCrossSessionInboundResolver(() => ({
      policy: 'accept',
      source: 'user',
    }));
      reevaluateHeldMessages();

      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(listHeldMessages()).toHaveLength(0);
    });

    it('drops entries that now resolve to refuse', () => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
      applyInboundPolicy(message('later'));

      setCrossSessionInboundResolver(() => ({
      policy: 'refuse',
      source: 'user',
    }));
      reevaluateHeldMessages();

      expect(enqueueMock).not.toHaveBeenCalled();
      expect(listHeldMessages()).toHaveLength(0);
    });

    it('keeps entries that still hold', () => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
      applyInboundPolicy(message('later'));
      reevaluateHeldMessages();
      expect(listHeldMessages()).toHaveLength(1);
    });
  });

  describe('settings-source attribution', () => {
    beforeEach(() => setPermissionModeGetter(() => 'default'));

    it('marks a user-scoped hold as an explicit setting', () => {
      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'user',
      }));
      expect(decideInboundPolicy({}).cause).toBe('explicit-setting');
    });

    it('marks a repository-scoped hold distinctly', () => {
      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'repo',
      }));
      expect(decideInboundPolicy({}).cause).toBe('repo-setting');
      applyInboundPolicy(message('hi'));
      expect(listHeldMessages()[0]?.cause).toBe('repo-setting');
    });

    it('reports the effective policy with no message in hand', () => {
      setCrossSessionInboundResolver(() => ({
        policy: 'refuse',
        source: 'repo',
      }));
      expect(describeEffectiveInboundPolicy()).toEqual({
        policy: 'refuse',
        cause: 'repo-setting',
      });
    });
  });

  describe('no review surface', () => {
    beforeEach(() => setReviewSurfaceAvailable(false));

    it('refuses a hold that came from permission-mode parity', () => {
      setPermissionModeGetter(() => 'yolo');
      const decision = decideInboundPolicy({});
      expect(decision).toEqual({
        policy: 'refuse',
        cause: 'no-review-surface',
      });
    });

    it('refuses a parity hold caused by a mode mismatch', () => {
      modeEmit.enabled = true;
      setPermissionModeGetter(() => 'default');
      expect(decideInboundPolicy({ fromMode: 'bypass' }).policy).toBe('refuse');
    });

    it('honours an explicitly configured hold', () => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'user',
      }));
      const decision = decideInboundPolicy({});
      expect(decision.policy).toBe('hold');
      expect(decision.cause).toBe('explicit-setting');
    });

    it('honours a repository-configured hold', () => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'repo',
      }));
      expect(decideInboundPolicy({}).policy).toBe('hold');
    });

    it('leaves accept untouched', () => {
      setPermissionModeGetter(() => 'default');
      expect(decideInboundPolicy({}).policy).toBe('accept');
    });
  });

  describe('shutdown settlement', () => {
    beforeEach(() => {
      setPermissionModeGetter(() => 'default');
      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'user',
      }));
    });

    it('does nothing when nothing is held', async () => {
      expect(await settleHeldMessagesOnShutdown()).toBe(0);
    });

    it('expires every held message and tells each sender', async () => {
      applyInboundPolicy(message('one'));
      applyInboundPolicy(message('two'));
      receipts.length = 0;

      expect(await settleHeldMessagesOnShutdown()).toBe(2);
      expect(listHeldMessages()).toHaveLength(0);
      expect(receipts.map((r) => r.status)).toEqual(['expired', 'expired']);
    });

    it('gives up within the budget when receipts never complete', async () => {
      // A peer that accepts the connection but never closes it would otherwise
      // hold the process open for the client's full five-second timeout.
      setPeerReceiptSink(() => new Promise<void>(() => {}));
      applyInboundPolicy(message('stuck'));

      const startedAt = Date.now();
      await settleHeldMessagesOnShutdown(50);
      expect(Date.now() - startedAt).toBeLessThan(HOLD_SETTLEMENT_BUDGET_MS);
      expect(listHeldMessages()).toHaveLength(0);
    });

    it('survives a sink that throws', async () => {
      setPeerReceiptSink(() => {
        throw new Error('socket gone');
      });
      applyInboundPolicy(message('doomed'));
      await expect(settleHeldMessagesOnShutdown()).resolves.toBe(1);
    });

    it('clears the queue so a late arrival cannot be stranded', async () => {
      applyInboundPolicy(message('one'));
      await settleHeldMessagesOnShutdown();
      expect(listHeldMessages()).toHaveLength(0);
      expect(await settleHeldMessagesOnShutdown()).toBe(0);
    });
  });
  describe('approval requests', () => {
    let requests: HeldApprovalRequest[];

    /** A surface that takes the question. */
    const asking = (request: HeldApprovalRequest): boolean => {
      requests.push(request);
      return true;
    };

    /** A surface that sees the request and declines to ask about it. */
    const declining = (request: HeldApprovalRequest): boolean => {
      requests.push(request);
      return false;
    };

    beforeEach(() => {
      requests = [];
      setPermissionModeGetter(() => 'yolo');
      setHeldMessageListener(asking);
    });

    // [AC2] The `held` receipt explains the terminal one that follows it, so it
    // has to be on the wire first even when the surface answers in the same
    // tick. A listener that resolves synchronously is the case that catches it.
    it('sends the held receipt before a synchronous answer', () => {
      setHeldMessageListener((request) => {
        resolveHeldMessage(request.id, 'approve');
        return false;
      });

      applyInboundPolicy(message('answered immediately'));

      expect(receipts.map((r) => r.status)).toEqual(['held', 'delivered']);
    });

    // [AC1] A bypass receiver with nobody declaring a class is the default
    // configuration, and is the case the whole feature exists for.
    it('asks about a hold caused by an undeclared sender', () => {
      applyInboundPolicy(message('run this'));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.cause).toBe('no-mode-asserted');
      expect(requests[0]?.summary.preview).toBe('run this');
    });

    // [RA9] Resolved once on arrival and carried, because both consumers need it
    // and one of them — the receipt sink — must not do I/O. The dialog used to
    // resolve it again after rendering an unqualified claim.
    it('[RA9] carries the arrival-time known-peer answer to both consumers', () => {
      applyInboundPolicy(message('run this', { knownPeer: true }));

      expect(requests[0]?.knownPeer).toBe(true);
      expect(receipts).toEqual([
        { from: 'uds:/tmp/peer.sock', status: 'held', knownPeer: true },
      ]);
    });

    it('[RA9] defaults to unknown when the transport did not say', () => {
      applyInboundPolicy(message('run this'));
      expect(requests[0]?.knownPeer).toBe(false);
    });

    /**
     * [RA13] The notice announcing a hold names the sender, and that name is a
     * string the sender typed into its own envelope.
     *
     * It used to be interpolated raw, one line away from the summary that exists
     * to make peer text safe to display: a sender could clear the receiver's
     * screen, or draw a box around text of its choosing, in the very message
     * telling the user there was something to approve.
     */
    describe('[RA13] a hostile claimed name', () => {
      const HOSTILE = '\u001b[2Jwiped\u202e\u200b\u2500\u2500';

      function lastFeedback(): string {
        const calls = vi.mocked(coreEvents.emitFeedback).mock.calls;
        return String(calls.at(-1)?.[1] ?? '');
      }

      it('strips control characters from the notice', () => {
        applyInboundPolicy(message('run this', { fromName: HOSTILE }));

        expect(lastFeedback()).toContain('wiped');
        expect(hasUnsafeDisplayChars(lastFeedback())).toBe(false);
      });

      /**
       * A nameless sender is now announced by the handle its address derives to,
       * rather than by the address itself. Two reasons: the handle is the string
       * `/peers` and the approval dialog already show, and an address is a socket
       * path — sanitizing one leaves a line of filesystem noise where the
       * sender's identity should be.
       */
      it('names the address-derived handle when no name was claimed', () => {
        const socketPath = '/tmp/elsewhere.sock\u001b\u2500';
        applyInboundPolicy(
          message('run this', { from: 'uds:%2Ftmp%2Felsewhere.sock\u001b\u2500' }),
        );

        expect(lastFeedback()).toContain(`-${peerHandle(socketPath)}`);
        expect(lastFeedback()).not.toContain('elsewhere');
        expect(hasUnsafeDisplayChars(lastFeedback())).toBe(false);
      });

      // The class is scoped to what can impersonate this CLI's own chrome, so
      // ordinary CJK punctuation has to survive it untouched.
      it('leaves an ordinary non-ASCII name intact', () => {
        applyInboundPolicy(
          message('run this', { fromName: '\u6784\u5efa\u4f1a\u8bdd\uff08\u4e3b\uff09' }),
        );

        expect(lastFeedback()).toContain(
          '\u6784\u5efa\u4f1a\u8bdd\uff08\u4e3b\uff09',
        );
      });

      // The dialog and the notice describe the same message, so they are built
      // from one summary rather than two.
      it('shows the surface the same summary the notice was built from', () => {
        applyInboundPolicy(message('run this', { fromName: HOSTILE }));

        expect(requests[0]?.summary.claimedName).toBe('[2Jwiped');
        expect(lastFeedback()).toContain(requests[0].summary.claimedName);
      });
    });

    // [AC1] The other prompting cause, reachable only with the gate on.
    it('asks about a mode mismatch', () => {
      modeEmit.enabled = true;
      setPermissionModeGetter(() => 'default');
      applyInboundPolicy(message('run this', { hints: { fromMode: 'bypass' } }));
      expect(requests[0]?.cause).toBe('mode-mismatch');
    });

    // [AC8] An explicit hold is a standing instruction, not a question, and
    // prompting per message would nullify the setting the user chose.
    it('does not ask about an explicitly configured hold', () => {
      setCrossSessionInboundResolver(() => ({ policy: 'hold', source: 'user' }));
      applyInboundPolicy(message('parked'));
      expect(requests).toHaveLength(0);
      expect(listHeldMessages()).toHaveLength(1);
    });

    // The mirror of the case above: the same value, arriving from a file the
    // repository ships to everyone who clones it, is not this user's standing
    // instruction. Left silent, a checked-in setting could remove the prompt a
    // session would otherwise have raised on its own.
    it('asks about a repository-configured hold', () => {
      setCrossSessionInboundResolver(() => ({ policy: 'hold', source: 'repo' }));
      applyInboundPolicy(message('shipped by the repo'));
      expect(requests).toHaveLength(1);
      expect(requests[0].cause).toBe('repo-setting');
    });

    // [AC8] mode-unknown drains itself once the getter is installed.
    it('does not ask when the permission mode is unknown', () => {
      setPermissionModeGetter(undefined);
      setHeldMessageListener(asking);
      applyInboundPolicy(message('early'));
      expect(requests).toHaveLength(0);
      expect(listHeldMessages()[0]?.cause).toBe('mode-unknown');
    });

    // [AC2] Approving delivers the message the peer actually sent.
    it('delivers the full body on approval', () => {
      applyInboundPolicy(message('the whole thing'));
      const id = requests[0].id;
      expect(resolveHeldMessage(id, 'approve')).toBe('delivered');
      expect(enqueueMock.mock.calls[0]?.[0]?.prompt).toBe('the whole thing');
      expect(receipts.at(-1)?.status).toBe('delivered');
    });

    // [AC14] Every path that removes the entry withdraws the question first.
    it('aborts the request when the message is released', () => {
      // Declined, so the entry is releasable: a pinned one would stay put.
      setHeldMessageListener(declining);
      applyInboundPolicy(message('released'));
      const request = requests[0];
      expect(request.signal.aborted).toBe(false);

      setCrossSessionInboundResolver(() => ({
        policy: 'accept',
        source: 'user',
      }));
      reevaluateHeldMessages();
      expect(request.signal.aborted).toBe(true);
    });

    it('aborts the request when the message is evicted', () => {
      setCrossSessionInboundResolver(() => ({ policy: 'hold', source: 'user' }));
      setHeldMessageListener(asking);
      setCrossSessionInboundResolver(undefined);

      applyInboundPolicy(message('first'));
      const first = requests[0];
      // Eviction is deliberately not pinned: it is an external condition the
      // user cannot answer, so an outstanding question does not block it.
      for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
        applyInboundPolicy(message(`filler-${i}`));
      }
      expect(first.signal.aborted).toBe(true);
    });

    it('aborts the request at shutdown', async () => {
      applyInboundPolicy(message('going away'));
      const request = requests[0];
      await settleHeldMessagesOnShutdown();
      expect(request.signal.aborted).toBe(true);
    });

    // [AC14] Belt and braces: the abort withdraws the dialog, and an answer
    // that arrives anyway finds nothing to act on.
    it('treats a late answer as a no-op', async () => {
      applyInboundPolicy(message('gone'));
      const id = requests[0].id;
      await settleHeldMessagesOnShutdown();
      expect(resolveHeldMessage(id, 'approve')).toBe('gone');
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    // [AC15] Once a question is in front of a human it is theirs to answer.
    // Otherwise switching permission mode for an unrelated reason would deliver
    // the peer's instruction and make the prompt vanish unanswered.
    it('pins an outstanding request against re-evaluation', () => {
      applyInboundPolicy(message('asked about'));
      const request = requests[0];

      setPermissionModeGetter(() => 'default');
      reevaluateHeldMessages();

      expect(enqueueMock).not.toHaveBeenCalled();
      expect(request.signal.aborted).toBe(false);
      expect(listHeldMessages()).toHaveLength(1);

      expect(resolveHeldMessage(request.id, 'approve')).toBe('delivered');
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    // [AC15] The pin is exactly one entry wide.
    it('releases other entries in the same pass', () => {
      applyInboundPolicy(message('asked about'));
      // The surface takes one question at a time; the second hold is queued.
      setHeldMessageListener(declining);
      applyInboundPolicy(message('not asked about'));

      setPermissionModeGetter(() => 'default');
      reevaluateHeldMessages();

      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(enqueueMock.mock.calls[0]?.[0]?.prompt).toBe('not asked about');
      expect(listHeldMessages()).toHaveLength(1);
    });

    // [AC13] A listener that declines leaves the entry unpinned, so it is not
    // held hostage by a question nobody was asked.
    it('asks about a sender whose address names no registered session', () => {
      setPermissionModeGetter(() => 'default');
      applyInboundPolicy(message('ghost', { hints: { knownPeer: false } }));
      expect(requests).toHaveLength(1);
      expect(requests[0].cause).toBe('unregistered-sender');
    });

    // A hold's cause is what decides whether anyone is asked, so keeping the
    // arrival-time one left this hold sitting silently in /peers once the mode
    // it was waiting on turned out to warrant a question.
    it('asks once a re-judged hold becomes a question', () => {
      setPermissionModeGetter(undefined);
      applyInboundPolicy(message('early'));
      expect(requests).toHaveLength(0);
      expect(listHeldMessages()[0]?.cause).toBe('mode-unknown');

      setPermissionModeGetter(() => 'yolo');

      expect(listHeldMessages()[0]?.cause).toBe('no-mode-asserted');
      expect(requests).toHaveLength(1);
      expect(requests[0].cause).toBe('no-mode-asserted');
      expect(requests[0].heldCount).toBe(1);
    });

    it('does not ask again when a re-judged hold was already a question', () => {
      setHeldMessageListener(declining);
      applyInboundPolicy(message('queued'));
      expect(requests).toHaveLength(1);

      reevaluateHeldMessages();
      expect(requests).toHaveLength(1);
    });

    it('lets a surface answer a re-judged hold synchronously', () => {
      setPermissionModeGetter(undefined);
      applyInboundPolicy(message('early'));
      setHeldMessageListener((request) => {
        requests.push(request);
        resolveHeldMessage(request.id, 'approve');
        return true;
      });

      setPermissionModeGetter(() => 'yolo');

      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(listHeldMessages()).toHaveLength(0);
    });

    // Eviction is not blocked by a question, but given a choice it takes an
    // entry nobody is looking at.
    it('evicts an entry nobody is being asked about first', () => {
      applyInboundPolicy(message('asked about'));
      const first = requests[0];
      setHeldMessageListener(declining);
      for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
        applyInboundPolicy(message(`filler-${i}`));
      }
      expect(first.signal.aborted).toBe(false);
      const previews = listHeldMessages().map(
        (entry) => summarizeHeldMessage(entry).preview,
      );
      expect(previews[0]).toBe('asked about');
      expect(previews).not.toContain('filler-0');
    });

    it('does not pin a request the surface declined', () => {
      setHeldMessageListener(declining);
      applyInboundPolicy(message('declined'));

      setPermissionModeGetter(() => 'default');
      reevaluateHeldMessages();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    // [AC11] Expiry says nobody was there; denial says someone refused.
    it('separates expiry from denial on the wire', () => {
      applyInboundPolicy(message('timed out'));
      resolveHeldMessage(requests[0].id, 'expire');
      expect(receipts.at(-1)?.status).toBe('expired');

      applyInboundPolicy(message('refused'));
      resolveHeldMessage(requests[1].id, 'deny');
      expect(receipts.at(-1)?.status).toBe('denied');
    });
  });

  /**
   * A forged address is free, so these holds can arrive as fast as a process
   * can write. The user gets one notice per window and `/peers` keeps the rest;
   * the queue gives up forged entries before anything else.
   */
  describe('unregistered-sender flood', () => {
    const feedback = () =>
      vi
        .mocked(coreEvents.emitFeedback)
        .mock.calls.map(([, text]) => String(text))
        .filter((text) => text.startsWith('Held a message'));

    const ghost = (i: number) =>
      message(`ghost-${i}`, {
        from: `uds:/tmp/test-socks/ghost-${i}.sock`,
        hints: { knownPeer: false },
      });

    beforeEach(() => {
      vi.mocked(coreEvents.emitFeedback).mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => vi.useRealTimers());

    it('announces a burst once and keeps every entry listable', () => {
      setPermissionModeGetter(() => 'default');
      for (let i = 0; i < 150; i++) applyInboundPolicy(ghost(i));

      expect(feedback()).toHaveLength(1);
      expect(listHeldMessages()).toHaveLength(MAX_HELD_MESSAGES);
    });

    it('counts the suppressed holds in the next window', () => {
      setPermissionModeGetter(() => 'default');
      for (let i = 0; i < 5; i++) applyInboundPolicy(ghost(i));

      vi.advanceTimersByTime(UNREGISTERED_NOTICE_WINDOW_MS);
      applyInboundPolicy(ghost(5));

      expect(feedback()).toHaveLength(2);
      expect(feedback()[1]).toContain('4 more held from unregistered senders');
    });

    it('does not suppress notices for other causes', () => {
      setPermissionModeGetter(() => 'yolo');
      applyInboundPolicy(ghost(0));
      applyInboundPolicy(message('registered', { hints: { knownPeer: true } }));
      applyInboundPolicy(ghost(1));

      expect(feedback()).toHaveLength(2);
    });

    it('evicts forged entries before a registered one', () => {
      setPermissionModeGetter(() => 'yolo');
      applyInboundPolicy(message('registered', { hints: { knownPeer: true } }));
      for (let i = 0; i < 150; i++) applyInboundPolicy(ghost(i));

      const held = listHeldMessages();
      expect(held).toHaveLength(MAX_HELD_MESSAGES);
      expect(held[0]?.cause).toBe('no-mode-asserted');
      expect(summarizeHeldMessage(held[0]).preview).toBe('registered');
    });
  });

  describe('released priority', () => {
    // [AC19] `later` describes the arrival, not a decision the user has since
    // made, so an approved message is not deferred a second time.
    it('drops a later priority on approval', () => {
      setPermissionModeGetter(() => 'yolo');
      applyInboundPolicy({
        ...message('deferred'),
        command: { prompt: 'deferred', commandMode: 'prompt', priority: 'later' },
      });
      const [held] = listHeldMessages();
      resolveHeldMessage(held.id, 'approve');
      expect(enqueueMock.mock.calls[0]?.[0]?.priority).toBe('next');
    });

    it('drops a later priority on release', () => {
      setPermissionModeGetter(() => 'yolo');
      applyInboundPolicy({
        ...message('deferred'),
        command: { prompt: 'deferred', commandMode: 'prompt', priority: 'later' },
      });
      setPermissionModeGetter(() => 'default');
      reevaluateHeldMessages();
      expect(enqueueMock.mock.calls[0]?.[0]?.priority).toBe('next');
    });
  });

  describe('attachments', () => {
    const withFiles = () => ({
      ...message('has files'),
      attachmentPaths: ['/uploads/a.txt', '/uploads/b.txt'],
      sessionId: 'session-1',
    });

    beforeEach(() => setPermissionModeGetter(() => 'yolo'));

    // [AC16] Files are written on arrival — deferring would re-read the
    // sender's paths and approve different bytes — so a message that is never
    // accepted has to clean up after itself.
    it('discards attachments on denial', () => {
      applyInboundPolicy(withFiles());
      resolveHeldMessage(listHeldMessages()[0].id, 'deny');
      expect(discardMock).toHaveBeenCalledWith(
        ['/uploads/a.txt', '/uploads/b.txt'],
        'session-1',
      );
    });

    it('discards attachments on expiry', () => {
      applyInboundPolicy(withFiles());
      resolveHeldMessage(listHeldMessages()[0].id, 'expire');
      expect(discardMock).toHaveBeenCalledTimes(1);
    });

    it('discards attachments at shutdown', async () => {
      applyInboundPolicy(withFiles());
      await settleHeldMessagesOnShutdown();
      expect(discardMock).toHaveBeenCalledTimes(1);
    });

    it('keeps attachments on approval', () => {
      applyInboundPolicy(withFiles());
      resolveHeldMessage(listHeldMessages()[0].id, 'approve');
      expect(discardMock).not.toHaveBeenCalled();
    });

    it('keeps attachments when a policy change releases the message', () => {
      applyInboundPolicy(withFiles());
      setPermissionModeGetter(() => 'default');
      reevaluateHeldMessages();
      expect(discardMock).not.toHaveBeenCalled();
    });

    // [AC16] The count is disclosed, because approving "a message" that
    // silently brought files is not an informed decision.
    it('reports the attachment count to the review surface', () => {
      const requests: HeldApprovalRequest[] = [];
      setHeldMessageListener((request) => {
        requests.push(request);
        return true;
      });
      applyInboundPolicy(withFiles());
      expect(requests[0]?.summary.attachmentCount).toBe(2);
    });
  });
});
