/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Peer-session @-mention attachment generator.
 *
 * A thin wrapper over `messaging/peer-mention.ts`, which owns the grammar and
 * the resolution. All this adds is the pipeline's two questions: has some
 * earlier pass already claimed this token, and is it worth enumerating peers at
 * all.
 *
 * Runs last of the three mention passes, because "already claimed" is answered
 * by what the first two *produced*.
 */

import * as path from 'node:path';
import { isCrossSessionMessagingEnabled } from '../../messaging/cross-session-feature.js';
import { listAllPeers } from '../../messaging/peer-listing.js';
import {
  parsePeerMentions,
  resolvePeerMentions,
} from '../../messaging/peer-mention.js';
import { type Attachment, PeerMentionAttachment } from '../types.js';

/**
 * The `@`-tokens an earlier pass has already spoken for.
 *
 * Keyed on what was *produced*, never on what a token looks like: a name that
 * matches the file regex but resolved to no file — a peer whose directory
 * basename contains a dot, say — has not been claimed by anything and must
 * still reach the peer parser.
 *
 * Note the two field names. Every file-ish attachment carries `filename`, but a
 * directory carries `path`; missing that would send every `@somedir/` prompt
 * through a peer enumeration.
 */
function claimedTokens(produced: readonly Attachment[]): {
  paths: Set<string>;
  agents: Set<string>;
} {
  const paths = new Set<string>();
  const agents = new Set<string>();

  for (const attachment of produced) {
    if (attachment.type === 'agent_mention') {
      agents.add(attachment.agentType);
      continue;
    }
    if (attachment.type === 'directory') {
      paths.add(attachment.path);
      continue;
    }
    const filename = (attachment as { filename?: unknown }).filename;
    if (typeof filename === 'string') paths.add(filename);
  }

  return { paths, agents };
}

/**
 * `peer_mention` attachments for a human-typed TUI prompt.
 *
 * Lazy by construction, in the order the guards get cheaper to fail: the
 * feature gate is an env read, `includes('@')` is a scan, and only a token that
 * survived both earlier passes justifies enumerating peers — which costs a
 * registry read plus a liveness probe per row.
 *
 * The listing is always read fresh. The completion may serve a throttled cache
 * because a stale suggestion is one the user can ignore, but a stale resolution
 * here is a label the model is told to send to.
 */
export async function processPeerMentions(
  input: string,
  cwd: string,
  produced: readonly Attachment[],
): Promise<PeerMentionAttachment[]> {
  if (!input.includes('@')) return [];
  if (!isCrossSessionMessagingEnabled()) return [];

  const mentions = parsePeerMentions(input);
  if (mentions.length === 0) return [];

  const { paths, agents } = claimedTokens(produced);
  const unclaimed = mentions.filter(
    (mention) =>
      !agents.has(mention) && !paths.has(path.resolve(cwd, mention)),
  );
  if (unclaimed.length === 0) return [];

  const peers = await listAllPeers();
  if (peers.length === 0) return [];

  return resolvePeerMentions(unclaimed, peers).map(
    (resolution) =>
      new PeerMentionAttachment({
        type: 'peer_mention' as const,
        mention: resolution.mention,
        status: resolution.status,
        candidates: resolution.candidates,
        total: resolution.total,
      }),
  );
}
