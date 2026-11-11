/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/peers` — review cross-session peer traffic.
 *
 * Lists reachable peer sessions and any messages the inbound gate parked, and
 * approves or denies them. Held messages are otherwise unreachable: the gate
 * deliberately keeps them out of the model's context until a human decides.
 */

import {
  assignPeerLabels,
  boundPeerIdentity,
  currentModeClass,
  describeEffectiveInboundPolicy,
  displayNameForSession,
  handleFact,
  isPeerModeEmitEnabled,
  listAllPeers,
  listHeldMessages,
  peerHandleFromAddress,
  resolveHeldMessage,
  summarizeHeldMessage,
  type HeldMessageSummary,
  type PeerEntry,
} from '@qwen-code/core';
import {
  resolveCrossSessionInbound,
  type CrossSessionInboundScope,
} from '../../config/crossSessionInbound.js';
import {
  createLocalCommandResultItem,
  type LocalCommandResultSeverity,
} from '../utils/localCommandResult.js';
import { type CommandContext, CommandKind, type SlashCommand } from './types.js';

function report(
  context: CommandContext,
  text: string,
  severity: LocalCommandResultSeverity = 'info',
): void {
  context.ui.addItem(createLocalCommandResultItem(text, severity));
}

function formatAge(receivedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - receivedAt) / 60_000));
  return minutes < 1 ? 'just now' : `${minutes}m ago`;
}

const SCOPE_LABELS: Record<CrossSessionInboundScope, string> = {
  flag: 'the --settings file',
  user: 'your user settings',
  project: "this repository's settings",
  local: 'your local project settings',
};

/**
 * One line stating the effective policy and where it came from.
 *
 * Printed unconditionally. A repository setting can override the user's own
 * choice by design, and under `refuse` nothing is ever held to hint at it, so
 * the empty-queue case is exactly when this line matters most.
 *
 * With nothing configured the line states the *rule*, not the verdict on one
 * hypothetical message. Describing a single sample used to produce a header
 * that contradicted the peers listed directly beneath it — announcing `hold`
 * above a list of peers that would every one of them be accepted.
 */
function describePolicy(context: CommandContext): string {
  const configured = resolveCrossSessionInbound(context.services.settings);
  if (configured) {
    const where = SCOPE_LABELS[configured.scope];
    const path = configured.path ? ` (${configured.path})` : '';
    const overridden =
      configured.source === 'repo'
        ? ' — a repository setting may only make this stricter, and it is doing so here'
        : '';
    return `Inbound policy: ${configured.policy} — set in ${where}${path}${overridden}`;
  }

  return `Inbound policy: not configured — ${describeParityRule()}`;
}

/**
 * The parity rule as it applies to this session right now.
 *
 * Branches on the mode-emit gate so it never describes a path the gate has
 * closed: while the gate is off nobody declares a class, so mode matching
 * cannot happen and saying otherwise would describe an unreachable outcome.
 */
function describeParityRule(): string {
  const effective = describeEffectiveInboundPolicy();

  if (effective.cause === 'mode-unknown') {
    return 'holding everything until this session\'s permission mode is known';
  }
  if (effective.cause === 'no-review-surface') {
    return 'refusing peer messages; this session is non-interactive, so a held message could never be reviewed';
  }

  // Holds whatever this session's mode is, so it is said wherever a message
  // could otherwise be accepted — not where every message is held anyway.
  const unregistered =
    '; messages from an address that matches no registered session are held for your approval';

  if (!isPeerModeEmitEnabled()) {
    return effective.policy === 'hold'
      ? 'peer messages are held for your approval while this session bypasses permission checks'
      : `peer messages are accepted; this session prompts for permissions, so a peer cannot use it to skip a check it would face itself${unregistered}`;
  }

  const ourClass = currentModeClass() === 'bypass' ? 'bypass' : 'prompting';
  return `a peer declaring the same permission posture as this session (${ourClass}) is accepted${unregistered}; anything else is held for your approval`;
}

/**
 * How this session appears in its peers' listings.
 *
 * Named with the rule peers name it by, so the line answers the question a user
 * with several terminals open actually has: which of these rows am I, and what
 * do I tell a peer to address me as.
 */
function describeSelf(context: CommandContext): string | undefined {
  const identity = boundPeerIdentity();
  if (!identity) return undefined;

  const name = displayNameForSession({
    ...(context.services.agentContext?.config?.topicState?.getTopic() !==
      undefined && {
      name: context.services.agentContext?.config?.topicState?.getTopic(),
    }),
    cwd: process.cwd(),
    messagingSocketPath: identity.socketPath,
  });
  const carried = name.endsWith(`-${identity.handle}`);
  return `This session: ${name}${carried ? '' : `, handle -${identity.handle}`}`;
}

/**
 * Attribution for one held message.
 *
 * The handle comes from the address the sender asked replies at, not from the
 * name it typed. Neither is authenticated — nothing here has kernel-verified
 * sender identity — but a handle is checkable: it either names a peer in the
 * listing directly above or it names nothing, and that is stated either way.
 *
 * Reads the summary rather than the entry: both strings the sender authored
 * reach a terminal from here, and the summary is where they have been stripped
 * of escapes, bidi overrides and the box-drawing characters this CLI's own
 * dialogs are made of. Sanitizing an address is a no-op — none of those
 * characters are legal in one — so the handle is derived from the same value.
 */
function describeSender(
  summary: HeldMessageSummary,
  peers: readonly PeerEntry[],
): string {
  const handle = peerHandleFromAddress(summary.claimedAddress);
  if (!handle) return summary.claimedName ?? summary.claimedAddress;

  const live = peers.filter((peer) => peer.handle === handle);
  if (live.length === 1) return `-${handle} (${live[0].displayName})`;
  if (live.length > 1) return `-${handle} (${live.length} peers share it)`;
  const claimed = summary.claimedName ? `; claims "${summary.claimedName}"` : '';
  return `-${handle} (not reachable${claimed})`;
}

async function renderOverview(context: CommandContext): Promise<void> {
  const [peers, held] = [await listAllPeers(), listHeldMessages()];
  const now = Date.now();
  const lines: string[] = [describePolicy(context), ''];

  const self = describeSelf(context);
  if (self) lines.push(self, '');

  lines.push(
    peers.length === 0
      ? 'Peer sessions: none reachable.'
      : `Peer sessions (${peers.length}):`,
  );
  const labels = assignPeerLabels(peers);
  for (const peer of peers) {
    const label = labels.get(peer) ?? peer.displayName;
    const handle = handleFact(label, peer);
    lines.push(
      `  ${label} — ${peer.session.kind ?? 'interactive'}, ` +
        `${peer.session.status ?? 'unknown'}, cwd ${peer.session.cwd}` +
        `${handle ? `, ${handle}` : ''}`,
    );
  }

  lines.push('');
  if (held.length === 0) {
    lines.push('Held messages: none.');
  } else {
    lines.push(`Held messages (${held.length}):`);
    for (const entry of held) {
      // The same summary the approval dialog renders, so neither surface can
      // show the body while omitting what came with it.
      const summary = summarizeHeldMessage(entry);
      lines.push(
        `  [${entry.id}] from ${describeSender(summary, peers)} · ${entry.cause} · ` +
          `${formatAge(entry.receivedAt, now)}`,
      );
      lines.push(`      ${summary.preview}`);

      const notes: string[] = [];
      if (summary.attachmentCount > 0) {
        notes.push(
          `${summary.attachmentCount} file(s) already copied into this session`,
        );
      }
      if (summary.truncated) notes.push('preview shortened; approving delivers the full message');
      if (notes.length > 0) lines.push(`      (${notes.join('; ')})`);
    }
    lines.push('');
    lines.push('Approve with /peers approve <id>, decline with /peers deny <id>.');
  }

  report(context, lines.join('\n'));
}

export const peersCommand: SlashCommand = {
  name: 'peers',
  description: 'List peer sessions and review held cross-session messages',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  argumentHint: '[approve <id> | deny <id>]',
  action: async (context: CommandContext, args: string) => {
    const [verb, id] = args.trim().split(/\s+/).filter(Boolean);
    if (!verb) {
      await renderOverview(context);
      return;
    }

    if (verb !== 'approve' && verb !== 'deny') {
      report(context, 'Usage: /peers [approve <id> | deny <id>]', 'error');
      return;
    }
    if (!id) {
      report(context, `Usage: /peers ${verb} <id>`, 'error');
      return;
    }

    const outcome = resolveHeldMessage(id, verb);
    switch (outcome) {
      case 'delivered':
        report(context, `Approved ${id}; it will run on the next turn.`);
        return;
      case 'dropped':
        report(context, `Declined ${id}; the sender was told it was denied.`);
        return;
      default:
        report(
          context,
          `No held message with id ${id}. Run /peers to see the current list.`,
          'error',
        );
    }
  },
};
