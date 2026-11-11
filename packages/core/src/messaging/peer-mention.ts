/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@`-mentioning a peer session in the composer.
 *
 * Two halves of one grammar. The completion writes a token here, and the submit
 * path reads it back — so escaping and parsing are defined together, and a
 * character the completion escapes always continues a token while the same
 * character typed bare always ends it.
 *
 * Lives beside `peer-listing.ts` rather than in the attachment pipeline because
 * the label it must agree with is the one the label ladder assigns, and the
 * resolver it must agree with is the one `SendMessage` uses. Any label handed to
 * the model is proved to resolve back to its peer before it leaves here.
 *
 * See docs/designs/2026-08-17-at-mention-peer-sessions.md.
 */

import { escapePath, unescapePath } from '../utils/paths.js';
import { sanitizeForDisplay } from './peer-message-preview.js';
import {
  addressLabel,
  resolvePeerRecipient,
  type PeerEntry,
  type ResolvePeerOptions,
} from './peer-listing.js';

/**
 * How a typed `@`-token is resolved, as opposed to a `to:` a model supplied.
 *
 * The bare-base-name tier is off. An untitled peer's base name is its working
 * directory's basename, so `api`, `docs`, `web` and `core` are all live
 * recipients and all ordinary words — "look at the @core module" would resolve
 * to a session and inject a reminder naming it. Nothing upstream catches this:
 * the file mention regex deliberately excludes bare dotless segments, so no
 * file attachment is ever produced to claim the token first.
 *
 * Nothing discoverable is lost. The completion inserts the *label*, never the
 * bare base name, and the row is still found by typing the directory name
 * because the search key carries it.
 */
const TYPED_MENTION: ResolvePeerOptions = { allowBareBaseName: false };

/**
 * Characters that end an unescaped mention token.
 *
 * Mirrors `escapePath`'s POSIX escape set so the two directions agree by
 * construction, plus `,` — which `escapePath` leaves bare but which reads as
 * sentence punctuation far more often than as part of a name, and which
 * {@link escapePeerLabel} therefore escapes on our behalf.
 */
const TERMINATORS = " \\t\\n\\r()\\[\\]{};|*?$`'\"#&<>!~\\\\,";

/**
 * `@` at a word boundary, then a run in which a backslash escapes the next
 * character and an unescaped terminator ends the run.
 *
 * A trailing `.` ends the token but an interior one does not — the same
 * `\.(?!$|\s)` shape `AT_MENTION_HIGHLIGHT_REGEX_SOURCE` uses — so `talk to
 * @reviewer.` mentions `reviewer` while `@qwen-5.1` stays whole.
 */
const PEER_MENTION_PATTERN = new RegExp(
  `(?:^|\\s)@((?:\\\\.|[^${TERMINATORS}.]|\\.(?!$|\\s))+)`,
  'g',
);

/**
 * Longest label that may reach the model.
 *
 * The bound is for the *cwd-derived* branch, not the titled one: the registry
 * already truncates `name` to 120, but `cwd` takes the 512-character default,
 * and an untitled peer is named after `path.basename(cwd)`. This is the only
 * bound on that path.
 */
export const MAX_MENTIONABLE_LABEL_LENGTH = 120;

/** Most candidates an ambiguous mention lists. */
export const MAX_ASK_CANDIDATES = 3;

/**
 * Characters a mentionable label may not contain.
 *
 * Angle brackets are the load-bearing entry: every attachment reaches the model
 * inside a `<system-reminder>` block, so a session that titles itself with a
 * closing tag would otherwise close that block from the inside. `sanitizeForDisplay`
 * does not cover this — it strips controls, zero-width, bidi and box-drawing
 * only — so its idempotence alone would leave the injection open.
 */
const UNMENTIONABLE = /[<>\n\r\t]/;

/**
 * Whether a label is safe to render to the model and to show in a row.
 *
 * A filter rather than a transform on purpose: a sanitized label may no longer
 * resolve, so emitting one would hand the model a token that fails on send.
 */
export function isMentionableLabel(label: string): boolean {
  if (label.length === 0) return false;
  if (label.length > MAX_MENTIONABLE_LABEL_LENGTH) return false;
  if (UNMENTIONABLE.test(label)) return false;
  return sanitizeForDisplay(label) === label;
}

/**
 * Escapes a label for insertion after `@`.
 *
 * `escapePath` plus `,`, which it leaves bare but which the grammar above
 * treats as a terminator.
 */
export function escapePeerLabel(label: string): string {
  return escapePath(label).replace(/,/g, '\\,');
}

/**
 * The `@`-tokens in a prompt, unescaped and deduped.
 *
 * Deduped case-sensitively because `resolvePeerRecipient` compares labels with
 * `===`; folding case here would admit tokens the resolver would then reject.
 * Tokens failing {@link isMentionableLabel} are dropped at the door, so
 * everything downstream — including the mention echoed back to the model — is
 * vetted by construction rather than by a later pass remembering to check.
 */
export function parsePeerMentions(input: string): string[] {
  if (!input.includes('@')) return [];

  const seen = new Set<string>();
  const pattern = new RegExp(
    PEER_MENTION_PATTERN.source,
    PEER_MENTION_PATTERN.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const token = unescapePath(match[1]);
    if (isMentionableLabel(token)) seen.add(token);
  }
  return [...seen];
}

/**
 * A label for this peer that is safe to render and provably resolves back to
 * it, or undefined when no such label exists.
 *
 * The re-check is not ceremony. `assignPeerLabels` exhausts its ladder by
 * assigning the last rung unconditionally, so two peers sharing a base name
 * *and* a truncated-hash ref get the same label — which then resolves
 * ambiguously, not to either of them.
 *
 * The handle fallback keeps a peer whose title the character rule rejects
 * reachable rather than silently dropped: every ladder rung embeds the title,
 * but `-46` does not, and the resolver accepts it at the handle tier. Handles
 * are two hex characters and can collide, which is what the identity check
 * catches.
 */
export function mentionableLabelFor(
  peers: readonly PeerEntry[],
  peer: PeerEntry,
): string | undefined {
  for (const label of [addressLabel(peers, peer), `-${peer.handle}`]) {
    if (!isMentionableLabel(label)) continue;
    const again = resolvePeerRecipient(peers, label, TYPED_MENTION);
    if (again !== undefined && 'peer' in again && again.peer === peer) {
      return label;
    }
  }
  return undefined;
}

/** One addressable option offered for a mention. */
export interface PeerMentionCandidate {
  /** A label that resolves to exactly this peer. */
  label: string;
  /**
   * Facts that tell one same-named session from another, already sanitized.
   *
   * Empty for a `resolved` mention, where there is nothing to tell apart. For an
   * `ask` it is the whole point: "which of these two did you mean" is not a
   * question anyone can answer from two opaque labels.
   */
  detail: string;
}

/** How a single `@`-token resolved against the live listing. */
export interface PeerMentionResolution {
  /** The token as typed, unescaped. */
  mention: string;
  status: 'resolved' | 'ask';
  /** Options that each resolve uniquely; one when resolved, ≤3 when ask. */
  candidates: PeerMentionCandidate[];
  /** Total matches; exceeds `candidates.length` when truncated. */
  total: number;
}

/**
 * A peer's distinguishing facts, flattened to one safe line.
 *
 * `cwd` and `status` come off the wire from a peer that named itself, so they
 * get the same treatment a label does *plus* whitespace folding — a detail
 * string is interpolated into a reminder, and `sanitizeForDisplay` keeps
 * newlines and tabs and does not touch angle brackets. Truncated rather than
 * rejected: unlike a label, this is never addressed, so a clipped `cwd` is
 * still useful where a clipped label would be a dead token.
 */
function flattenDetail(peer: PeerEntry): string {
  const facts = [
    peer.session.kind ?? 'interactive',
    peer.session.status ?? 'unknown',
    peer.session.cwd ? `cwd ${peer.session.cwd}` : undefined,
  ].filter((fact): fact is string => fact !== undefined);

  return sanitizeForDisplay(facts.join(', '))
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
}

/** Longest detail string carried on a candidate. */
const MAX_DETAIL_LENGTH = 160;

/**
 * Resolves parsed tokens against the live listing.
 *
 * Uses the resolver `SendMessage` will use, so a token that resolves here
 * resolves there. A token matching nothing — or matching only peers with no
 * usable label — yields nothing at all: the user's text passes through
 * untouched, which is what the rest of the `@` pipeline does on a miss.
 */
export function resolvePeerMentions(
  mentions: readonly string[],
  peers: readonly PeerEntry[],
): PeerMentionResolution[] {
  const results: PeerMentionResolution[] = [];

  for (const mention of mentions) {
    const match = resolvePeerRecipient(peers, mention, TYPED_MENTION);

    if (match !== undefined && 'peer' in match) {
      const label = mentionableLabelFor(peers, match.peer);
      if (label === undefined) {
        continue;
      }
      results.push({
        mention,
        status: 'resolved',
        // No detail: there is nothing to tell apart, and every extra fact here
        // is peer-authored text in a reminder for no benefit.
        candidates: [{ label, detail: '' }],
        total: 1,
      });
      continue;
    }

    if (match !== undefined && 'ambiguous' in match) {
      const seen = new Set<string>();
      const vetted: PeerMentionCandidate[] = [];
      for (const peer of match.candidates) {
        if (vetted.length >= MAX_ASK_CANDIDATES) break;
        const label = mentionableLabelFor(peers, peer);
        if (label === undefined || seen.has(label)) continue;
        seen.add(label);
        vetted.push({ label, detail: flattenDetail(peer) });
      }

      if (vetted.length === 0) {
        // An ask with nothing to ask about is worse than silence.
        continue;
      }
      results.push({
        mention,
        status: 'ask',
        candidates: vetted,
        // The full match count, not the vetted one: the user asked about a name
        // that matches four sessions, and that stays true when only three can
        // be named.
        total: match.count,
      });
      continue;
    }

    // Not found, or a well-formed address nobody answers at. Either way there
    // is nothing to tell the model that it could act on.
  }

  return results;
}
