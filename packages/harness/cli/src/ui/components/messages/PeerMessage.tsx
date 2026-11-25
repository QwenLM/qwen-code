/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Feed row for a message that arrived from another session.
 *
 * A peer message is delivered as an `isMeta` prompt, so nothing in the ordinary
 * user-message path renders it: without this row the model answers a question
 * the user never saw asked. See
 * docs/designs/2026-08-08-cross-session-peer-messaging.md.
 *
 * Everything shown here is peer-authored. It is sanitized and bounded by the
 * core helpers this module calls — never by the caller — because this is the one
 * peer-facing surface with no approval gate in front of it.
 */

import type { FC } from 'react';
import { Box, Text } from 'ink';
import {
  boundPeerBodyForFeed,
  formatPeerAttribution,
  parseCrossSessionEnvelope,
  unwrapPeerMessageText,
  type PeerAttribution,
} from '@qwen-code/core';
import type { HistoryItemCustomContent } from '../../types.js';
import { theme } from '../../semantic-colors.js';
import { figures } from '../../utils/figures.js';

/** The parts of a peer origin this row reads, from a command or a message. */
export interface PeerOriginLike {
  from?: string;
  name?: string;
  body?: string;
  attachmentCount?: number;
  /** Registry membership of `from` on arrival; absent on older transcripts. */
  knownPeer?: boolean;
}

export interface PeerMessageProps {
  /** Sanitized and bounded by {@link boundPeerBodyForFeed}. */
  body: string;
  attribution: PeerAttribution;
  attachmentCount?: number;
  omittedLines?: number;
  /** The sender's address named no registered session when it arrived. */
  unregistered?: boolean;
}

function Attribution({
  attribution,
}: {
  attribution: PeerAttribution;
}) {
  return (
    <>
      {attribution.name}
      {attribution.handleSuffix ? (
        // A correction, not the subject: the handle only appears when it
        // disagrees with — or is missing from — what the sender called itself.
        <Text dimColor> {attribution.handleSuffix}</Text>
      ) : null}
    </>
  );
}

function describeAttachments(count: number): string {
  return `${count} file${count === 1 ? '' : 's'} arrived with this message and ${
    count === 1 ? 'has' : 'have'
  } been copied into this session.`;
}

export const PeerMessage: FC<PeerMessageProps> = ({
  body,
  attribution,
  attachmentCount = 0,
  omittedLines = 0,
  unregistered = false,
}) => {
  // Exactly one sigil. `formatPeerAttribution` returns `@peer` for a sender it
  // could not identify, and prefixing that reads `@ @peer`. The test is on the
  // name rather than a comparison against the constant, which core owns — so a
  // later `@`-leading label is covered without this layer knowing its value.
  const sigil = attribution.name.startsWith('@') ? '' : '@ ';

  // No fold state is read, deliberately. A `custom_content` item stores an
  // already-built element, so anything conditional here would be captured at
  // whatever the state was when the message arrived. Rendering unconditionally
  // is what makes the stored element safe to replay, and it is why the row can
  // no longer claim to be expandable — see the overflow registration this
  // replaced.
  return (
    <Box flexDirection="column">
      <Text color={theme.ui.focus}>
        {sigil}
        <Attribution attribution={attribution} />
        {unregistered ? <Text dimColor> (unregistered)</Text> : null}{' '}
        {figures.pointer}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text>{body}</Text>
        {omittedLines > 0 ? (
          <Text dimColor>
            {figures.ellipsis} {omittedLines} more line
            {omittedLines === 1 ? '' : 's'}
          </Text>
        ) : null}
        {attachmentCount > 0 ? (
          <Text color={theme.status.warning}>
            {describeAttachments(attachmentCount)}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

/**
 * Recovers what the peer actually wrote.
 *
 * `origin.body` is the message before the transport prefixed it with `@"path"`
 * attachment references, so it is preferred over the prompt wherever it exists —
 * on a live command always, and on a persisted message for anything this build
 * wrote. Parsing is the fallback for a transcript from an older build, and it
 * has to unwrap first because the stored text carries the header and safety
 * notice that `wrapPeerMessage` adds for the model.
 */
function bodyOf(text: string, origin?: PeerOriginLike): string | undefined {
  if (typeof origin?.body === 'string') return origin.body;
  const envelope = parseCrossSessionEnvelope(unwrapPeerMessageText(text).trim());
  return envelope?.body;
}

/**
 * Builds the feed row for one inbound peer message.
 *
 * **Always returns an item.** A builder that can return `null` while the message
 * still reaches the model is what hid these rows in the first place: the message
 * ran, and nothing on screen said so. Every fallback above exists to keep that
 * unreachable, and the return type is what enforces it.
 */
export function buildPeerMessageHistoryItem(source: {
  text: string;
  origin?: PeerOriginLike;
  displaySummary?: string;
}): HistoryItemCustomContent {
  const { origin } = source;
  // `??`, not `||`: an envelope may legitimately carry an empty body, and
  // treating that as "nothing to show" walked the fallback chain all the way
  // down to the envelope markup — putting the frame the model reads on screen
  // in place of the message that had none.
  const raw =
    bodyOf(source.text, origin) ?? source.displaySummary ?? source.text;
  const { body, omittedLines } = boundPeerBodyForFeed(raw);
  const attribution = formatPeerAttribution({
    ...(origin?.from !== undefined && { from: origin.from }),
    ...(origin?.name !== undefined && { claimedName: origin.name }),
  });

  return {
    type: 'custom_content',
    content: (
      <PeerMessage
        body={body}
        attribution={attribution}
        {...(origin?.attachmentCount !== undefined && {
          attachmentCount: origin.attachmentCount,
        })}
        {...(omittedLines > 0 && { omittedLines })}
        {...(origin?.knownPeer === false && { unregistered: true })}
      />
    ),
  };
}
