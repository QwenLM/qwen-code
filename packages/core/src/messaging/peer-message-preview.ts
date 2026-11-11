/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Display summaries for held peer messages.
 *
 * A held message is shown to a human who is about to decide whether to run it,
 * so everything peer-authored is sanitized and bounded before it reaches a
 * surface. The summary type carries the disclosures with it — truncation, the
 * attachment count, and the fact that identity is only claimed — so no surface
 * can render a summary while omitting them.
 *
 * The promise, stated exactly: **before you decide what to do with a message,
 * every string that message brought with it has been sanitized.** The subject is
 * the message. The peer listing around it — display names and cwds read from the
 * session registry — is an address book rather than message content, and is not
 * covered here: a session that names itself in escape sequences damages its own
 * addressability, which is a different problem from misleading the person
 * holding the approval prompt.
 */

import type { QueuedCommand } from '../input/types.js';
import { peerHandleFromAddress } from './peer-address.js';

/** Longest one-line preview, used by `/peers` and the dialog header. */
export const MAX_PREVIEW_LENGTH = 120;

/** Most body lines a dialog shows. */
export const MAX_BODY_LINES = 8;

/** Longest single body line a dialog shows. */
export const MAX_BODY_LINE_LENGTH = 240;

/**
 * Most body lines the conversation feed shows when expanded.
 *
 * Looser than the dialog's bound because the feed is reading material rather
 * than the basis of a decision, and tighter than unbounded because the inbound
 * frame cap is a megabyte: without a bound here one peer can push everything
 * else off the screen, and the feed is neither scrollable nor cheap to redraw.
 */
export const MAX_FEED_BODY_LINES = 40;

/** Longest single body line the feed shows. */
export const MAX_FEED_BODY_LINE_LENGTH = 2000;

/** Longest claimed name retained. */
export const MAX_CLAIMED_NAME_LENGTH = 80;

/**
 * Characters removed before peer text is displayed.
 *
 * Scoped to what could impersonate this CLI's own chrome or subvert how the
 * terminal lays text out, rather than to punctuation in general:
 *
 * - C0/C1 controls except newline and tab, which covers ANSI escapes;
 * - zero-width characters, bidi overrides and isolates, which can reorder a line
 *   so it reads as something other than what will run;
 * - box-drawing and block elements, which are what dialog borders are made of.
 *
 * Deliberately *not* a general Unicode quote/bracket/dash strip. Those classes
 * are ordinary punctuation in Chinese and Japanese text, and removing them would
 * mangle the common case to defend against the rare one.
 */
const UNSAFE_DISPLAY_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F' + // controls, incl. ESC
    '\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069' + // zero-width, bidi
    '\\u2500-\\u259F' + // box drawing and block elements
    ']',
  'g',
);

/** Strips display-unsafe characters, preserving newlines and tabs. */
export function sanitizeForDisplay(text: string): string {
  return text.replace(UNSAFE_DISPLAY_CHARS, '');
}

/** Stands in for a sender that offered neither a name nor a usable address. */
export const UNKNOWN_PEER_LABEL = '@peer';

/**
 * Whether a label already ends in a given suffix, ignoring anything a relay
 * appended.
 *
 * A teammate relaying through a session signs `<session> / <member>`
 * (`agents/teams/agent-team-tools.ts`), so the part that carries the handle is the
 * segment before the separator. Registry-free on purpose: the same rule has to
 * apply on the peer listing, which has a whole population in hand, and on a
 * single arriving message, which has nothing but itself.
 */
export function labelCarriesHandle(label: string, suffix: string): boolean {
  const session = label.split(' / ')[0]?.trimEnd() ?? '';
  return session.endsWith(`-${suffix}`);
}

export interface PeerAttribution {
  /** Primary token: the claimed name, the handle alone, or `@peer`. */
  name: string;
  /**
   * The address-derived handle, present only when {@link name} does not already
   * carry it. Rendered secondary — it is a correction, not the subject.
   */
  handleSuffix?: string;
}

/**
 * Names the sender of one message, for every surface that shows it to a human.
 *
 * Both inputs are sender-authored. The handle is the half that can be checked:
 * it is derived from the address the sender asks for replies at, so it either
 * agrees with the claimed name or exposes that the two disagree.
 *
 * An untitled session already signs itself `base-<handle>`
 * (`displayNameForSession`), which is why the handle is *compared* rather than
 * prepended. Printing it unconditionally renders the same two hex digits twice
 * on the ordinary row and spends the reader's attention on agreement; comparing
 * lets a consistent claim read as one clean name and makes a disagreeing one
 * the thing that stands out.
 *
 * Sanitizes here rather than trusting callers: this is the type through which
 * peer-authored names reach a terminal.
 */
export function formatPeerAttribution(message: {
  from?: string;
  claimedName?: string;
}): PeerAttribution {
  const handle =
    message.from !== undefined ? peerHandleFromAddress(message.from) : undefined;
  const name = sanitizeForDisplay(message.claimedName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLAIMED_NAME_LENGTH);

  if (!name) {
    return { name: handle ? `-${handle}` : UNKNOWN_PEER_LABEL };
  }
  if (handle === undefined || labelCarriesHandle(name, handle)) {
    return { name };
  }
  return { name, handleSuffix: `-${handle}` };
}

/** Joins an attribution for a single-line context. */
export function joinPeerAttribution(attribution: PeerAttribution): string {
  return attribution.handleSuffix
    ? `${attribution.name} ${attribution.handleSuffix}`
    : attribution.name;
}

export interface HeldMessageSummary {
  /** Single line, sanitized and capped at {@link MAX_PREVIEW_LENGTH}. */
  preview: string;
  /** Sanitized body for a dialog, bounded by lines and line length. */
  body: string;
  /** True when {@link body} omits part of the message. */
  truncated: boolean;
  /**
   * Attachments already copied into this session's uploads directory.
   *
   * Disclosed rather than merely counted internally: approving a message that
   * silently brought files is not an informed decision.
   */
  attachmentCount: number;
  /** Sender-authored display name. Claimed, never verified. */
  claimedName?: string;
  /** Sender-authored reply address. Claimed, never verified. */
  claimedAddress: string;
}

/** Stands in for a peer that sent an envelope with nothing inside it. */
export const EMPTY_BODY_PLACEHOLDER = '(empty message)';

function bodyTextOf(command: QueuedCommand): string | undefined {
  // A peer command's `prompt` is the envelope the *model* reads, so previewing
  // it spends the whole budget on markup and shows none of the message.
  // `origin.body` is the same text before wrapping — and before the `@"path"`
  // attachment prefix, which the summary discloses separately as a count.
  const origin = command.origin;
  if (origin?.kind === 'peer' && typeof origin.body === 'string') {
    // An envelope may legitimately carry an empty body — the parser defaults it
    // to '' — and rendering that as blank space tells a reviewer even less than
    // the markup this replaces.
    return origin.body.trim() === '' ? EMPTY_BODY_PLACEHOLDER : origin.body;
  }
  if (typeof command.prompt === 'string') return command.prompt;
  if (typeof command.displaySummary === 'string') return command.displaySummary;
  return undefined;
}

/** Describes a body we cannot preview, without coercing it to a string. */
function describeOpaqueBody(command: QueuedCommand): string {
  const blocks = Array.isArray(command.prompt) ? command.prompt.length : 0;
  const chars = Array.isArray(command.prompt)
    ? JSON.stringify(command.prompt).length
    : 0;
  return `Unpreviewable content: ${blocks} block(s), ~${chars} chars`;
}

function toPreview(text: string): string {
  const collapsed = sanitizeForDisplay(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PREVIEW_LENGTH
    ? `${collapsed.slice(0, MAX_PREVIEW_LENGTH)}…`
    : collapsed;
}

function bound(
  text: string,
  maxLines: number,
  maxLineLength: number,
): { body: string; omittedLines: number; truncatedLine: boolean } {
  const lines = sanitizeForDisplay(text).split('\n');
  const kept = lines.slice(0, maxLines);
  let truncatedLine = false;

  const bounded = kept.map((line) => {
    if (line.length <= maxLineLength) return line;
    truncatedLine = true;
    return `${line.slice(0, maxLineLength)}…`;
  });

  return {
    body: bounded.join('\n').trim(),
    omittedLines: Math.max(0, lines.length - maxLines),
    truncatedLine,
  };
}

function toBoundedBody(text: string): { body: string; truncated: boolean } {
  const { body, omittedLines, truncatedLine } = bound(
    text,
    MAX_BODY_LINES,
    MAX_BODY_LINE_LENGTH,
  );
  return { body, truncated: omittedLines > 0 || truncatedLine };
}

export interface BoundedPeerBody {
  /** Sanitized body, bounded by line count and line length. */
  body: string;
  /** Lines dropped from the end, for the caller to disclose. */
  omittedLines: number;
}

/**
 * Bounds a peer body for the conversation feed.
 *
 * Separate bounds from {@link summarizeHeldMessage}'s, same sanitizer. The
 * omitted count is returned rather than folded into the text so the caller can
 * render it as chrome instead of as something the peer appears to have written.
 */
export function boundPeerBodyForFeed(text: string): BoundedPeerBody {
  const source = text.trim() === '' ? EMPTY_BODY_PLACEHOLDER : text;
  const { body, omittedLines } = bound(
    source,
    MAX_FEED_BODY_LINES,
    MAX_FEED_BODY_LINE_LENGTH,
  );
  return { body, omittedLines };
}

export interface SummarizableMessage {
  command: QueuedCommand;
  from: string;
  fromName?: string;
  attachmentPaths?: readonly string[];
}

/**
 * Builds the display summary for one held message.
 *
 * Pure and synchronous: it is called on the inbound path, where blocking on I/O
 * would stall the socket reader.
 */
export function summarizeHeldMessage(
  message: SummarizableMessage,
): HeldMessageSummary {
  const text = bodyTextOf(message.command);
  const source = text ?? describeOpaqueBody(message.command);
  const { body, truncated } = toBoundedBody(source);

  const claimedName =
    message.fromName === undefined
      ? undefined
      : sanitizeForDisplay(message.fromName).trim().slice(0, MAX_CLAIMED_NAME_LENGTH);

  return {
    preview: toPreview(source),
    body,
    // An opaque body is fully described by its placeholder, so it is not a
    // truncation the user needs warning about.
    truncated: text === undefined ? false : truncated,
    attachmentCount: message.attachmentPaths?.length ?? 0,
    ...(claimedName ? { claimedName } : {}),
    claimedAddress: sanitizeForDisplay(message.from).slice(0, 300),
  };
}
