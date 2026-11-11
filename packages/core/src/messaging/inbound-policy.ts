/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inbound gate for cross-session peer messages.
 *
 * Three policies: `accept` delivers into the prompt queue, `hold` parks the
 * message for human review, and `refuse` drops it. When the setting is unset the
 * policy falls back to permission-mode parity, so a peer running with fewer
 * restrictions than us cannot steer this session without review.
 *
 * A hold that represents an unresolved trust question — the sender's class does
 * not match ours, or nobody declared one and we bypass permission checks — is
 * offered to the user as an approval request. Everything else parks silently for
 * `/peers`, because an explicitly configured `hold` is a standing instruction
 * rather than a question.
 */

import { randomUUID } from 'node:crypto';
import type { QueuedCommand } from '../input/types.js';
import { PermissionModes, type PermissionMode } from '../permissions/manager/decision/index.js';
import { enqueue } from '../services/messageQueueManager.js';
import { coreEvents } from '../utils/events.js';
import { runLogger } from '../utils/runLogger.js';
import type { PeerModeClass } from './cross-session-envelope.js';
import { isPeerModeEmitEnabled } from './cross-session-feature.js';
import { discardPeerFiles } from './peer-files.js';
import {
  formatPeerAttribution,
  joinPeerAttribution,
  summarizeHeldMessage,
  type HeldMessageSummary,
} from './peer-message-preview.js';

export type CrossSessionInbound = 'accept' | 'hold' | 'refuse';

/** Ordering used when a lower-trust settings scope may only tighten. */
export const INBOUND_SEVERITY: Record<CrossSessionInbound, number> = {
  accept: 0,
  hold: 1,
  refuse: 2,
};

/** Delivery outcome reported back to the sender. */
export type PeerMessageStatus = 'held' | 'denied' | 'expired' | 'delivered';

/**
 * Which settings layer produced an explicit policy.
 *
 * `repo` is the workspace file alone: `.qwen/settings.json` is the one a
 * repository ships to everyone who clones it. The workspace-*local* file sits
 * beside it on disk but is the reader's own per-project override, so it counts
 * as `user` — see `cli/src/config/crossSessionInbound.ts` for why that
 * distinction is worth drawing.
 */
export type CrossSessionInboundSource = 'user' | 'repo';

export interface ResolvedCrossSessionInbound {
  policy: CrossSessionInbound;
  source: CrossSessionInboundSource;
}

/** Why a message ended up held; surfaced in `/peers` for diagnosis. */
export type HoldCause =
  | 'explicit-setting'
  | 'repo-setting'
  | 'mode-mismatch'
  | 'mode-unknown'
  | 'no-mode-asserted'
  | 'unregistered-sender';

/** Causes produced by permission-mode parity rather than by a settings value. */
const PARITY_CAUSES: readonly HoldCause[] = [
  'mode-mismatch',
  'mode-unknown',
  'no-mode-asserted',
  'unregistered-sender',
];

/**
 * Causes that raise an approval request rather than parking silently.
 *
 * Each represents a question the gate cannot answer on its own. `mode-unknown`
 * is a transient startup state that drains itself, and `explicit-setting` is the
 * user's own standing instruction — a decision they already made, so re-asking
 * it is noise.
 *
 * `repo-setting` is here for the mirror image of that reason. It is the same
 * value arriving from a file a repository ships to everyone who clones it, which
 * makes it precisely *not* the reader's own standing instruction. Without this,
 * a checked-in `security.crossSessionInbound: hold` silently removed the
 * approval prompt a session would otherwise have raised on its own — a
 * repository quietly deciding that this user does not get asked.
 *
 * `unregistered-sender` is a claimed address that names no session this machine
 * has a record of — the one trust question the registry can answer at all.
 */
const PROMPTING_CAUSES: readonly HoldCause[] = [
  'mode-mismatch',
  'no-mode-asserted',
  'repo-setting',
  'unregistered-sender',
];

/** Longest hold queue before the oldest entry is evicted. */
export const MAX_HELD_MESSAGES = 100;

/** Total time shutdown settlement may spend notifying senders. */
export const HOLD_SETTLEMENT_BUDGET_MS = 300;

/**
 * Window inside which `unregistered-sender` holds share one notice.
 *
 * Per cause rather than per sender: the address is exactly what a flooder
 * varies, so a per-sender window would limit nothing.
 */
export const UNREGISTERED_NOTICE_WINDOW_MS = 10_000;

export interface InboundPolicyDecision {
  policy: CrossSessionInbound;
  cause: HoldCause | 'default-accept' | 'self-sent' | 'no-review-surface';
}

export interface PeerMessageHints {
  selfSent?: boolean;
  fromMode?: PeerModeClass;
  /**
   * Whether the claimed address named a session in the local registry on
   * arrival. Absent means nobody asked; only `false` holds.
   *
   * Carried here rather than beside the message because re-judging a held
   * entry reads its hints alone, and must not forget the answer.
   */
  knownPeer?: boolean;
}

export interface PendingPeerMessage {
  command: QueuedCommand;
  from: string;
  fromName?: string;
  msgId?: string;
  /**
   * Whether {@link from} named a session in the local registry on arrival.
   *
   * Resolved once by the transport, because the answer is wanted twice — by the
   * approval surface, and by the receipt sink, which must stay synchronous.
   */
  knownPeer?: boolean;
  hints: PeerMessageHints;
  /** Attachments already copied into this session's uploads directory. */
  attachmentPaths?: string[];
  /** Session that owns those attachments, needed to discard them. */
  sessionId?: string;
}

export interface HeldPeerMessage {
  id: string;
  receivedAt: number;
  from: string;
  fromName?: string;
  msgId?: string;
  /** See {@link PendingPeerMessage.knownPeer}. A snapshot taken on arrival. */
  knownPeer: boolean;
  cause: HoldCause;
  command: QueuedCommand;
  hints: PeerMessageHints;
  attachmentPaths?: string[];
  sessionId?: string;
}

/** One held message offered to a human for a decision. */
export interface HeldApprovalRequest {
  id: string;
  cause: HoldCause;
  /**
   * Whether the claimed address named a session in the local registry.
   *
   * Carried with the request rather than resolved by the surface: it is the same
   * answer the transport already needed, and resolving it again after the dialog
   * is up means rendering an unqualified claim first.
   */
  knownPeer: boolean;
  /** Queue depth including this message. */
  heldCount: number;
  summary: HeldMessageSummary;
  /** Fires when the message leaves the queue by any other path. */
  signal: AbortSignal;
}

type ReceiptSink = (
  message: { from: string; msgId?: string; knownPeer?: boolean },
  status: PeerMessageStatus,
) => void | Promise<void>;

/** Internal bookkeeping kept off the published `HeldPeerMessage` shape. */
interface HeldEntry extends HeldPeerMessage {
  controller: AbortController;
  /** True while a human is being asked about this message. */
  outstanding: boolean;
}

let inboundResolver:
  | (() => ResolvedCrossSessionInbound | undefined)
  | undefined;
let permissionModeGetter: (() => PermissionMode | undefined) | undefined;
let receiptSink: ReceiptSink | undefined;
let heldListener: ((request: HeldApprovalRequest) => boolean) | undefined;
let reviewSurfaceAvailable = true;
const heldMessages: HeldEntry[] = [];
/** Notice suppression for `unregistered-sender` holds; see the window constant. */
let unregisteredNotice: { lastAt: number; suppressed: number } | undefined;

/**
 * Registers the layered settings read. The CLI owns settings, so core asks for
 * the resolved value rather than reaching into `LoadedSettings` itself.
 */
export function setCrossSessionInboundResolver(
  resolver: (() => ResolvedCrossSessionInbound | undefined) | undefined,
): void {
  inboundResolver = resolver;
}

/**
 * Declares whether a human can review held messages in this session.
 *
 * False for a non-interactive session bound only because an explicit socket
 * path was passed: `/peers` exists there but nobody is at a prompt to run it.
 */
export function setReviewSurfaceAvailable(available: boolean): void {
  reviewSurfaceAvailable = available;
}

/**
 * Registers the permission-mode read.
 *
 * Installing a getter re-judges anything held while it was missing: the gate
 * fails closed to `mode-unknown` when it cannot read the mode, and those holds
 * would otherwise sit in the queue for the life of the session.
 */
export function setPermissionModeGetter(
  getter: (() => PermissionMode | undefined) | undefined,
): void {
  permissionModeGetter = getter;
  if (getter !== undefined) reevaluateHeldMessages();
}

/** Registers the transport callback used to answer senders with a receipt. */
export function setPeerReceiptSink(sink: ReceiptSink | undefined): void {
  receiptSink = sink;
}

/**
 * Registers the surface that asks a human about a held message.
 *
 * Deliberately optional and per-frontend: the TUI registers one, headless and
 * ACP do not and keep the text notice plus `/peers`.
 *
 * The listener returns whether it is asking. `false` — one request is already
 * outstanding, or this surface cannot prompt right now — leaves the message
 * queued and releasable, because an entry nobody is being asked about must not
 * be pinned against the next policy change.
 */
export function setHeldMessageListener(
  listener: ((request: HeldApprovalRequest) => boolean) | undefined,
): void {
  heldListener = listener;
}

/**
 * Classifies a permission mode for parity comparison.
 *
 * Only bypassPermissions auto-approves. `dontAsk` is fail-closed and `auto`
 * still blocks whatever its classifier does not deem safe, so both are
 * prompting class. See design §5 decision 5.
 *
 * A *plan* session would otherwise count as bypass class when bypass is one
 * keystroke away. `PERMISSION_MODES` has no plan member
 * (`permissions/types.ts:19-25`), and no other mode is a staging area for
 * bypass in the way plan is, so there is nothing here to classify that way.
 */
export function modeClassOf(mode: PermissionMode | undefined): PeerModeClass {
  return mode === PermissionModes.Yolo ? 'bypass' : 'prompting';
}

/** This session's mode class, or undefined when the mode is unknown. */
export function currentModeClass(): PeerModeClass | undefined {
  const mode = permissionModeGetter?.();
  return mode === undefined ? undefined : modeClassOf(mode);
}

/**
 * Resolves the policy for one inbound message.
 *
 * An explicit setting always wins. Otherwise a message from our own descendant
 * is accepted, a sender whose address names no registered session is held, an
 * unknown local mode fails closed to `hold`, a declared sender class must match
 * ours, and an undeclared sender is accepted only when we are not running in
 * bypass class.
 */
export function decideInboundPolicy(
  hints: PeerMessageHints = {},
): InboundPolicyDecision {
  return applyReviewSurfaceRule(decideBeforeReviewSurface(hints));
}

function decideBeforeReviewSurface(
  hints: PeerMessageHints,
): InboundPolicyDecision {
  const explicit = inboundResolver?.();
  if (explicit !== undefined) {
    return {
      policy: explicit.policy,
      cause: explicit.source === 'repo' ? 'repo-setting' : 'explicit-setting',
    };
  }

  if (hints.selfSent) return { policy: 'accept', cause: 'self-sent' };

  // Ahead of the mode checks because it does not depend on them. The parity
  // argument for accepting an undeclared sender — a peer cannot use us to skip
  // a check it would face itself — assumes the sender is a session at all, and
  // an address no session registered is no evidence of that.
  if (hints.knownPeer === false) {
    return { policy: 'hold', cause: 'unregistered-sender' };
  }

  const myClass = currentModeClass();
  if (myClass === undefined) return { policy: 'hold', cause: 'mode-unknown' };

  // An attestation is only honoured while the gate is on. It is self-declared
  // and forgeable, so with the gate off it is discarded rather than trusted —
  // on both sides, since a peer on an older build would keep sending one.
  const declared = isPeerModeEmitEnabled() ? hints.fromMode : undefined;

  if (declared !== undefined) {
    return declared === myClass
      ? { policy: 'accept', cause: 'default-accept' }
      : { policy: 'hold', cause: 'mode-mismatch' };
  }

  return myClass === 'bypass'
    ? { policy: 'hold', cause: 'no-mode-asserted' }
    : { policy: 'accept', cause: 'default-accept' };
}

/**
 * Downgrades a hold to a refusal when nobody can review it.
 *
 * Deliberately limited to parity defaults. A parity hold is our inference, so we
 * may refine it once we know review is impossible; an explicitly configured
 * `hold` is the user's instruction, and the setting's own documentation promises
 * that an explicit value always wins. Those holds are honoured and settled at
 * shutdown instead.
 */
function applyReviewSurfaceRule(
  decision: InboundPolicyDecision,
): InboundPolicyDecision {
  if (reviewSurfaceAvailable) return decision;
  if (decision.policy !== 'hold') return decision;
  if (!PARITY_CAUSES.includes(decision.cause as HoldCause)) return decision;
  return { policy: 'refuse', cause: 'no-review-surface' };
}

/**
 * The policy a message with no declared sender mode would receive right now.
 *
 * Used by `/peers` to state the effective policy unconditionally, including
 * when the answer is `refuse` and no message is ever held to explain it.
 */
export function describeEffectiveInboundPolicy(): InboundPolicyDecision {
  return decideInboundPolicy({});
}

/**
 * The parts of a message a receipt is addressed by.
 *
 * Spelled out rather than passing the message itself: a receipt sink is a
 * transport, and handing it the command and the attachment paths would let it
 * reach for either.
 */
function receiptFor(message: {
  from: string;
  msgId?: string;
  knownPeer?: boolean;
}): { from: string; msgId?: string; knownPeer?: boolean } {
  return {
    from: message.from,
    ...(message.msgId !== undefined && { msgId: message.msgId }),
    ...(message.knownPeer !== undefined && { knownPeer: message.knownPeer }),
  };
}

/**
 * Fires a receipt.
 *
 * Returns whatever the sink returns so shutdown settlement can await a batch;
 * every other caller ignores it and stays fire-and-forget.
 */
function sendReceipt(
  message: { from: string; msgId?: string; knownPeer?: boolean },
  status: PeerMessageStatus,
): void | Promise<void> {
  try {
    return receiptSink?.(message, status);
  } catch (error) {
    runLogger.debug(`[inbound-policy] Receipt sink failed: ${error}`);
    return undefined;
  }
}

/**
 * How a held message's sender is named in every notice about it.
 *
 * One formatter for the hold notice, the closing notices and the approval
 * dialog: a message announced as held and later reported denied must name the
 * same sender both times, or the two lines read as two different messages.
 */
function senderLabel(entry: {
  from: string;
  fromName?: string;
}): string {
  return joinPeerAttribution(
    formatPeerAttribution({
      from: entry.from,
      ...(entry.fromName !== undefined && { claimedName: entry.fromName }),
    }),
  );
}

/**
 * Closes out a hold the user was told about.
 *
 * `hold()` announces every parked message. Approval ends visibly — the message
 * itself appears in the feed — but a denial or an expiry writes nothing, which
 * left "Held a message from X" as the last word on a thread that had in fact
 * finished. Says what happened rather than who did it: a policy change, a
 * shutdown and a human answering the dialog all arrive here.
 */
function announceHoldResolved(
  entry: HeldEntry,
  outcome: 'denied' | 'expired',
): void {
  coreEvents.emitFeedback(
    'info',
    outcome === 'denied'
      ? `Declined the held message from ${senderLabel(entry)}.`
      : `The held message from ${senderLabel(entry)} expired without review.`,
  );
}

/**
 * Removes an entry's attachments.
 *
 * Only for outcomes where the message is never delivered — the files are about
 * to be read on every other path.
 */
function discardAttachments(entry: HeldEntry): void {
  if (!entry.attachmentPaths?.length || entry.sessionId === undefined) return;
  void discardPeerFiles(entry.attachmentPaths, entry.sessionId).catch(
    () => undefined,
  );
}

/**
 * Detaches an entry from the queue and withdraws any request open against it.
 *
 * Aborting first means a surface asking about this message stops asking before
 * anything else observes the queue without it.
 */
function detach(index: number): HeldEntry | undefined {
  const [entry] = heldMessages.splice(index, 1);
  if (!entry) return undefined;
  entry.outstanding = false;
  entry.controller.abort();
  return entry;
}

/**
 * Hands a peer message to the model's queue.
 *
 * The one place a cross-session message reaches the model — accepted on
 * arrival, approved from a hold, or released by re-evaluation.
 */
function deliver(command: QueuedCommand): void {
  enqueue(command);
}

/**
 * Strips a deferral that no longer describes anything.
 *
 * `later` says something about when the message *arrived*; once a human has
 * approved it, or a policy change has released it, deferring again would make
 * an explicit decision wait a second time.
 */
function releaseCommand(command: QueuedCommand): QueuedCommand {
  return command.priority === 'later'
    ? { ...command, priority: 'next' }
    : command;
}

/**
 * The cause a hold is recorded under.
 *
 * A decision only reaches `hold` with one of the accept-side causes when an
 * explicit setting said `hold`, so those name the setting.
 */
function holdCauseOf(cause: InboundPolicyDecision['cause']): HoldCause {
  return cause === 'default-accept' ||
    cause === 'self-sent' ||
    cause === 'no-review-surface'
    ? 'explicit-setting'
    : cause;
}

/**
 * Which entry makes room when the queue is full.
 *
 * Unregistered senders go first, so a flood of forged addresses can only push
 * out its own kind. An entry a human is being asked about goes last: evicting
 * it withdraws a question while the answer is being typed.
 */
function pickEvictionIndex(): number {
  const unregistered = heldMessages.findIndex(
    (entry) => entry.cause === 'unregistered-sender' && !entry.outstanding,
  );
  if (unregistered !== -1) return unregistered;
  const idle = heldMessages.findIndex((entry) => !entry.outstanding);
  return idle === -1 ? 0 : idle;
}

/**
 * Tells the user a message is held, and offers it for approval when its cause
 * is a question.
 *
 * Shared by the arrival path and by re-judging, so the two cannot describe a
 * hold differently.
 */
function presentHold(entry: HeldEntry): void {
  // Built once and shared with the review surface. Every string in it is peer-
  // authored, and this is the type that decides how such a string may be shown;
  // going around it — interpolating `fromName` straight into the notice below —
  // is what let a sender put ANSI escapes and fake dialog borders on the
  // terminal of the user about to judge it.
  const summary = summarizeHeldMessage({
    command: entry.command,
    from: entry.from,
    ...(entry.fromName !== undefined && { fromName: entry.fromName }),
    ...(entry.attachmentPaths !== undefined && {
      attachmentPaths: entry.attachmentPaths,
    }),
  });

  const asked = offerForApproval(entry, summary);
  announceHold(entry, asked);
}

/**
 * Emits the hold notice, collapsing a burst of `unregistered-sender` holds.
 *
 * Without this the message is invisible until the user happens to run /peers.
 * The wording distinguishes a hold that is being asked about from one that is
 * only queued, so a silent hold does not read like a prompt that never came.
 */
function announceHold(entry: HeldEntry, asked: boolean): void {
  let tail = '';
  if (entry.cause === 'unregistered-sender') {
    const now = Date.now();
    if (
      unregisteredNotice !== undefined &&
      now - unregisteredNotice.lastAt < UNREGISTERED_NOTICE_WINDOW_MS
    ) {
      unregisteredNotice.suppressed += 1;
      return;
    }
    const suppressed = unregisteredNotice?.suppressed ?? 0;
    if (suppressed > 0) {
      tail = ` (${suppressed} more held from unregistered senders — run /peers)`;
    }
    unregisteredNotice = { lastAt: now, suppressed: 0 };
  }

  const sender = senderLabel(entry);
  coreEvents.emitFeedback(
    'info',
    asked
      ? `Held a message from ${sender} for your approval.${tail}`
      : `Held a message from ${sender} for review — run /peers to approve or deny it.${tail}`,
  );
}

function hold(message: PendingPeerMessage, cause: HoldCause): 'held' {
  if (heldMessages.length >= MAX_HELD_MESSAGES) {
    const evicted = detach(pickEvictionIndex());
    if (evicted) {
      discardAttachments(evicted);
      void sendReceipt(receiptFor(evicted), 'expired');
      // Same reasoning as the other two closures: this one was announced when it
      // arrived, and dropping it silently to make room is exactly the case where
      // the user is owed the ending.
      announceHoldResolved(evicted, 'expired');
    }
  }

  const entry: HeldEntry = {
    id: randomUUID().slice(0, 8),
    receivedAt: Date.now(),
    from: message.from,
    ...(message.fromName !== undefined && { fromName: message.fromName }),
    ...(message.msgId !== undefined && { msgId: message.msgId }),
    knownPeer: message.knownPeer ?? false,
    cause,
    command: message.command,
    hints: message.hints,
    ...(message.attachmentPaths?.length && {
      attachmentPaths: message.attachmentPaths,
    }),
    ...(message.sessionId !== undefined && { sessionId: message.sessionId }),
    controller: new AbortController(),
    outstanding: false,
  };
  heldMessages.push(entry);

  // The receipt goes out before the review surface is offered the message, so a
  // listener that answers synchronously cannot put `delivered` or `denied` on
  // the wire ahead of the `held` that explains them.
  void sendReceipt(receiptFor(entry), 'held');

  presentHold(entry);
  return 'held';
}

/**
 * Offers a held message to the registered review surface.
 *
 * Takes the summary rather than building its own, so the dialog and the notice
 * that announces it can never describe the message differently.
 *
 * @returns whether a human is now being asked.
 */
function offerForApproval(
  entry: HeldEntry,
  summary: HeldMessageSummary,
): boolean {
  if (heldListener === undefined) return false;
  if (!PROMPTING_CAUSES.includes(entry.cause)) return false;

  try {
    const asked = heldListener({
      id: entry.id,
      cause: entry.cause,
      knownPeer: entry.knownPeer,
      heldCount: heldMessages.length,
      summary,
      signal: entry.controller.signal,
    });
    // The mark pins the entry against release, so it is set from the surface's
    // answer rather than in advance: an entry nobody is being asked about stays
    // releasable by the next policy or permission-mode change.
    entry.outstanding = asked;
    return asked;
  } catch (error) {
    runLogger.debug(`[inbound-policy] Held-message listener failed: ${error}`);
    entry.outstanding = false;
    return false;
  }
}

/**
 * Applies the resolved policy, enqueuing, holding or dropping the message.
 *
 * Callers must have already dropped `refuse` traffic before materializing any
 * attachment; passing a refused message here is safe but late.
 */
export function applyInboundPolicy(
  message: PendingPeerMessage,
  decision: InboundPolicyDecision = decideInboundPolicy(message.hints),
): 'accept' | 'held' | 'refused' {
  switch (decision.policy) {
    case 'accept':
      deliver(message.command);
      void sendReceipt(receiptFor(message), 'delivered');
      return 'accept';
    case 'refuse':
      void sendReceipt(receiptFor(message), 'denied');
      return 'refused';
    case 'hold':
      return hold(message, holdCauseOf(decision.cause));
    default:
      return 'refused';
  }
}

/**
 * Withdraws a review surface's claim on a held message, leaving it queued.
 *
 * The counterpart to a listener returning true. A surface that took the question
 * and then lost the screen has to give it back: the mark pins the entry against
 * release by {@link reevaluateHeldMessages}, and its expiry would go on running
 * somewhere nobody can see it.
 *
 * Deliberately does not abort the entry's signal — that means "left the queue",
 * and this entry has not.
 *
 * @returns whether a claim was actually withdrawn.
 */
export function withdrawHeldMessageClaim(id: string): boolean {
  const entry = heldMessages.find((candidate) => candidate.id === id);
  if (!entry?.outstanding) return false;
  entry.outstanding = false;
  // Names no sender on purpose: what matters is that a question went back into
  // the queue, and the user's next step is /peers, which lists them all.
  coreEvents.emitFeedback(
    'info',
    'A held peer message is back in the queue — run /peers to approve or deny it.',
  );
  return true;
}

/** Snapshot of the hold queue, oldest first. */
export function listHeldMessages(): readonly HeldPeerMessage[] {
  return heldMessages.map(({ controller: _c, outstanding: _o, ...rest }) => rest);
}

/**
 * Resolves one held message by user action.
 *
 * Returns `gone` when the id no longer exists, which happens when the entry was
 * evicted or already resolved.
 */
export function resolveHeldMessage(
  id: string,
  action: 'approve' | 'deny' | 'expire',
): 'delivered' | 'dropped' | 'gone' {
  const index = heldMessages.findIndex((entry) => entry.id === id);
  if (index === -1) return 'gone';
  const entry = detach(index);
  if (!entry) return 'gone';

  if (action === 'approve') {
    deliver(releaseCommand(entry.command));
    void sendReceipt(receiptFor(entry), 'delivered');
    return 'delivered';
  }

  const expired = action === 'expire';
  discardAttachments(entry);
  void sendReceipt(receiptFor(entry), expired ? 'expired' : 'denied');
  announceHoldResolved(entry, expired ? 'expired' : 'denied');
  return 'dropped';
}

/**
 * Re-runs the gate over the hold queue after a policy or permission-mode change.
 *
 * Entries that now resolve to `accept` are delivered and entries that now
 * resolve to `refuse` are dropped; anything still holding stays put.
 *
 * An entry a human is currently being asked about is left alone. Once a decision
 * is in front of someone it belongs to them — otherwise switching permission
 * mode for an unrelated reason would deliver the peer's instruction and make the
 * open question disappear unanswered.
 *
 * An entry that stays held takes the cause it holds for *now*. When that cause
 * newly calls for a question it is asked: keeping the arrival-time cause is how
 * a startup `mode-unknown` hold in a bypass session sat silently in `/peers`
 * after the mode it was waiting on turned out to warrant a prompt.
 */
export function reevaluateHeldMessages(): void {
  if (heldMessages.length === 0) return;
  const pending = [...heldMessages];
  heldMessages.length = 0;
  const newlyPrompting: HeldEntry[] = [];

  for (const entry of pending) {
    if (entry.outstanding) {
      heldMessages.push(entry);
      continue;
    }

    const decision = decideInboundPolicy(entry.hints);
    if (decision.policy === 'accept') {
      entry.controller.abort();
      deliver(releaseCommand(entry.command));
      void sendReceipt(receiptFor(entry), 'delivered');
      continue;
    }
    if (decision.policy === 'refuse') {
      entry.controller.abort();
      discardAttachments(entry);
      void sendReceipt(receiptFor(entry), 'denied');
      announceHoldResolved(entry, 'denied');
      continue;
    }
    const cause = holdCauseOf(decision.cause);
    if (cause !== entry.cause) {
      if (
        PROMPTING_CAUSES.includes(cause) &&
        !PROMPTING_CAUSES.includes(entry.cause)
      ) {
        newlyPrompting.push(entry);
      }
      entry.cause = cause;
    }
    heldMessages.push(entry);
  }

  // After the queue is whole again: the surface reads its depth, and one that
  // answers synchronously resolves the entry by looking it up there.
  for (const entry of newlyPrompting) {
    if (heldMessages.includes(entry)) presentHold(entry);
  }
}

/**
 * Settles everything still held because this session is shutting down.
 *
 * Best-effort and time-boxed: receipts go out concurrently and the batch is
 * raced against `budgetMs`. Settling serially is not an option — the client's
 * default send timeout is five seconds and the queue holds up to
 * {@link MAX_HELD_MESSAGES}, so one unreachable peer would stall exit.
 *
 * Anything not settled inside the budget is abandoned. That leaves its sender
 * exactly where an ungraceful exit would: its next send fails at connect and
 * `SendMessage` reports that the session is gone.
 *
 * @returns how many messages were drained.
 */
export async function settleHeldMessagesOnShutdown(
  budgetMs: number = HOLD_SETTLEMENT_BUDGET_MS,
): Promise<number> {
  if (heldMessages.length === 0) return 0;

  // Clear first so a late arrival cannot land in a queue nobody will drain.
  const pending = heldMessages.splice(0);
  const sends = pending.map((entry) => {
    entry.outstanding = false;
    entry.controller.abort();
    discardAttachments(entry);
    return Promise.resolve(sendReceipt(receiptFor(entry), 'expired')).catch(
      () => undefined,
    );
  });

  await Promise.race([
    Promise.allSettled(sends),
    new Promise<void>((resolve) => {
      // unref so the deadline timer itself never holds the loop open.
      setTimeout(resolve, budgetMs).unref?.();
    }),
  ]);

  runLogger.debug(
    `[inbound-policy] Settled ${pending.length} held message(s) at shutdown`,
  );
  return pending.length;
}

/** @internal Test helper — clears all module state. */
export function _resetInboundPolicyForTest(): void {
  inboundResolver = undefined;
  permissionModeGetter = undefined;
  receiptSink = undefined;
  heldListener = undefined;
  reviewSurfaceAvailable = true;
  unregisteredNotice = undefined;
  for (const entry of heldMessages) entry.controller.abort();
  heldMessages.length = 0;
}
