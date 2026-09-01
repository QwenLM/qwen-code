/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/peers` — review messages other sessions sent this one.
 *
 * A held message is invisible to the model by design, so this is the only
 * place it can be seen and released. Kept as a text command rather than a
 * modal dialog: a message can be held while the session is mid-turn, and
 * interrupting the user with a blocking prompt for something a peer chose
 * to send would be the wrong trade.
 */

import {
  canonicalizeMsgId,
  describeHoldCause,
  flattenPeerLabel,
  type HeldMessage,
} from '@qwen-code/qwen-code-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { t } from '../../i18n/index.js';
import { CommandKind } from './types.js';

/** Short handle shown to the user, so nobody has to type a full UUID. */
export function shortId(msgId: string): string {
  return msgId.replace(/-/g, '').slice(0, 6);
}

/**
 * The shortest canonicalized prefix that distinguishes this id from every
 * other held id, at least the short handle long. The list must print a
 * handle the user can type back to decide exactly this message: two ids
 * sharing their first six characters would otherwise be a dead end only
 * `all` can act on.
 */
function displayHandle(
  entry: HeldMessage,
  held: readonly HeldMessage[],
): string {
  const own = canonicalizeMsgId(entry.frame.msgId);
  let length = Math.min(shortId(entry.frame.msgId).length, own.length);
  const collides = (len: number) =>
    held.some(
      (other) =>
        other !== entry &&
        canonicalizeMsgId(other.frame.msgId).startsWith(own.slice(0, len)),
    );
  while (length < own.length && collides(length)) {
    length += 1;
  }
  return own.slice(0, length);
}

function preview(text: string, max = 100): string {
  const oneLine = flattenPeerLabel(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatHeldList(held: readonly HeldMessage[]): string {
  if (held.length === 0) return 'No messages from other sessions are waiting.';

  const lines = held.map((entry) => {
    // Every field below is peer-controlled, and this is the screen where
    // the user decides untrusted messages: a forged listing line or a
    // terminal-rewriting ESC sequence here spoofs the review itself.
    const who = flattenPeerLabel(
      entry.frame.fromName ?? entry.frame.from ?? 'unknown session',
    );
    const handle = flattenPeerLabel(displayHandle(entry, held));
    return (
      `  ${handle}  ${who}\n` +
      `      ${preview(entry.frame.message.content)}\n` +
      `      held because ${describeHoldCause(entry.cause)}`
    );
  });

  return [
    `${held.length} message${held.length === 1 ? '' : 's'} waiting for your review:`,
    ...lines,
    '',
    'Release with /peers accept <id|all>, or drop with /peers deny <id|all>.',
  ].join('\n');
}

/**
 * Resolve a user-typed handle against the held set.
 *
 * Accepts the short handle or any unique prefix of the full id. An
 * ambiguous prefix is an error rather than a guess — picking one of two
 * messages to inject into the session is not a coin flip worth taking.
 */
export function resolveHeld(
  held: readonly HeldMessage[],
  token: string,
): { kind: 'one'; msgId: string } | { kind: 'none' } | { kind: 'ambiguous' } {
  // Lowercased on both sides: a peer picks its own msgId, so the handle
  // printed by /peers can contain uppercase, and a handle the user
  // cannot retype is a dead end. Canonicalized (dashes stripped) on both
  // sides for the same reason: the printed handles have no dashes.
  const needle = token.toLowerCase();

  // An exact match wins outright: it is what lets the user pick the
  // shorter of two ids where one canonicalized id extends the other.
  const exact = held.filter(
    (entry) => canonicalizeMsgId(entry.frame.msgId) === needle,
  );
  if (exact.length === 1) return { kind: 'one', msgId: exact[0]!.frame.msgId };

  const matches = held.filter(
    (entry) =>
      canonicalizeMsgId(entry.frame.msgId).startsWith(needle) ||
      entry.frame.msgId.toLowerCase().startsWith(needle),
  );
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'one', msgId: matches[0]!.frame.msgId };
}

export const peersCommand: SlashCommand = {
  name: 'peers',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t(
      'Review messages held from other Qwen Code sessions (accept | deny)',
    );
  },
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const peerMessaging = context.services.peerMessaging;
    if (!peerMessaging) {
      // Absent for two different reasons, and telling a user to enable a
      // setting they already enabled sends them nowhere: the inbox is also
      // absent when the session failed to register or the socket failed to
      // bind (path too long, unwritable runtime dir).
      const enabled =
        context.services.settings?.merged?.agents?.crossSessionMessaging ===
        true;
      return {
        type: 'message',
        messageType: enabled ? 'error' : 'info',
        content: enabled
          ? 'Cross-session messaging is on, but this session has no inbox: it either failed to register in the session registry or failed to bind its socket. Re-run with DEBUG=1 to see the bind error.'
          : 'Cross-session messaging is off. Enable it with "agents.crossSessionMessaging": true in settings.json, then restart.',
      };
    }

    const held = peerMessaging.getHeld();
    const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);

    if (verb === undefined || verb === 'list') {
      // Decisions bind to this listing: record exactly which messages
      // the user is reviewing so a later accept/deny can refuse when the
      // set has shifted underneath.
      peerMessaging.recordHeldListing(held);
      return {
        type: 'message',
        messageType: 'info',
        content: formatHeldList(held),
      };
    }

    if (verb !== 'accept' && verb !== 'deny') {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown subcommand "${verb}". Use /peers, /peers accept <id|all>, or /peers deny <id|all>.`,
      };
    }

    const decision = verb === 'accept' ? 'approve' : 'deny';
    const target = rest[0];

    if (target === undefined) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Which message? Use /peers ${verb} <id|all> — /peers lists the ids.`,
      };
    }

    // The held set moves between listing and decision (arrivals,
    // evictions, releases): a handle that uniquely named the message the
    // user reviewed can resolve to a different one by now. Refuse
    // instead of deciding on a stale review.
    if (peerMessaging.heldSetChangedSinceListing()) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'The waiting list changed since you listed it — run /peers again to review what is waiting now.',
      };
    }

    if (held.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No messages from other sessions are waiting.',
      };
    }

    // Lowercased: the keyword and id resolution both fold case, so an
    // uppercase ALL must still mean every message, not degrade into an
    // id-prefix lookup that silently decides one of them.
    if (target.toLowerCase() === 'all') {
      // Snapshot first: deciding mutates the held list underneath us.
      const ids = held.map((entry) => entry.frame.msgId);
      let count = 0;
      let failed = 0;
      for (const msgId of ids) {
        const outcome = peerMessaging.decide(msgId, decision);
        if (outcome === 'done') count += 1;
        else if (outcome === 'failed') failed += 1;
      }
      // The user now knows what remains; bind later decisions to it.
      peerMessaging.recordHeldListing(peerMessaging.getHeld());
      return {
        type: 'message',
        messageType: 'info',
        content:
          `${verb === 'accept' ? 'Released' : 'Dropped'} ${count} message${
            count === 1 ? '' : 's'
          }.` +
          (failed > 0
            ? ` ${failed} could not be delivered and ${
                failed === 1 ? 'is' : 'are'
              } still waiting — try again once the session catches up.`
            : ''),
      };
    }

    const resolved = resolveHeld(held, target);
    if (resolved.kind === 'none') {
      return {
        type: 'message',
        messageType: 'error',
        content: `No held message matches "${target}". Run /peers to see what is waiting.`,
      };
    }
    if (resolved.kind === 'ambiguous') {
      return {
        type: 'message',
        messageType: 'error',
        content: `"${target}" matches more than one held message. Use more characters of the id.`,
      };
    }

    const outcome = peerMessaging.decide(resolved.msgId, decision);
    // The user now knows what remains; bind later decisions to it.
    peerMessaging.recordHeldListing(peerMessaging.getHeld());
    if (outcome === 'gone') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          'That message is no longer waiting — it may have expired or already been decided.',
      };
    }
    if (outcome === 'failed') {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'The session could not take the message just now — its input queue is full. It is still waiting; try again in a moment.',
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content:
        verb === 'accept'
          ? 'Released to this session. It will be picked up on the next turn.'
          : 'Dropped. The sending session has been told.',
    };
  },
};
