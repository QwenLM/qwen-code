/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from '../commands/types.js';

/**
 * Characters a mid-input `/` may follow: whitespace, or the fullwidth
 * punctuation Chinese prose puts before a token.
 *
 * Only fullwidth marks are listed. Halfwidth equivalents are covered by the
 * space that English writing puts before the `/` anyway, and adding them would
 * turn ordinary text like `a,/b` into a trigger. Fullwidth curly quotes
 * (`“` `”`) are deliberately absent too — macOS and Word produce them in
 * *English* text, so `run “/usr` would start a command lookup on `usr`.
 *
 * This is the single source of truth: `highlight.ts` consumes the same
 * constant so a mid-line command that triggers a ghost is also the one that
 * gets highlighted.
 */
export const MID_INPUT_SLASH_SEPARATORS = '\\s。、，；：？！（）';

/**
 * A mid-input command token is a `/` that follows one of the separators above,
 * plus at least one command-name character, anchored at the cursor. Requiring
 * a leading separator is what keeps this path disjoint from the line-start `/`
 * dropdown, which owns fuzzy matching and subcommands.
 *
 * At least one character is required after the `/` on purpose: a bare `/`
 * appears in ordinary prose and arithmetic ("50 / 3"), and completing it to an
 * arbitrary alphabetically-first command would be noise rather than help.
 */
const MID_INPUT_SLASH_REGEX = new RegExp(
  `[${MID_INPUT_SLASH_SEPARATORS}]/([a-zA-Z0-9._:-]+)$`,
);

/**
 * Extracts the partial command name of a mid-input `/` token.
 *
 * Callers pass the text preceding the cursor **on the cursor's logical line**,
 * prefixed with a synthetic `'\n'` when the cursor is not on the first line.
 * That prefix makes a continuation line's leading `/` match (its real
 * predecessor is a newline) while the very first character of the input still
 * does not — that case belongs to the dropdown.
 *
 * Working per-line rather than slicing the whole buffer avoids a code-unit vs.
 * code-point mismatch: text-buffer offsets are code-point based, but
 * `String.prototype.slice` is not.
 *
 * @returns The typed partial name without the leading `/`, or null.
 */
export function findMidInputSlashQuery(
  textBeforeCursor: string,
): string | null {
  const match = MID_INPUT_SLASH_REGEX.exec(textBeforeCursor);
  return match ? match[1] : null;
}

export interface CommandGhostMatch {
  /**
   * The token to insert after the `/`. A complete command name when exactly one
   * command matched, otherwise the prefix every matching command agrees on.
   * Never contains whitespace or `/`.
   */
  token: string;
  /**
   * Whether exactly one command matched, i.e. `token` is a complete name and no
   * longer name shares it. Decides the trailing space on accept — the same rule
   * bash uses, where an ambiguous common prefix never gets one.
   */
  isUniqueMatch: boolean;
  /** The not-yet-typed remainder, rendered as ghost text. Never empty. */
  suffix: string;
}

// Mirrors findCommandByPart / commandMatchTier: name → displayName → altName.
const CANDIDATE_TIERS = ['name', 'displayName', 'altName'] as const;

interface Candidate {
  text: string;
  tier: number;
  command: SlashCommand;
}

function collectCandidates(cmd: SlashCommand): Candidate[] {
  const candidates: Candidate[] = [
    { text: cmd.name, tier: CANDIDATE_TIERS.indexOf('name'), command: cmd },
  ];

  if (cmd.displayName) {
    candidates.push({
      text: cmd.displayName,
      tier: CANDIDATE_TIERS.indexOf('displayName'),
      command: cmd,
    });
  }

  for (const alt of cmd.altNames ?? []) {
    candidates.push({
      text: alt,
      tier: CANDIDATE_TIERS.indexOf('altName'),
      command: cmd,
    });
  }

  // A candidate containing whitespace (e.g. an MCP prompt's
  // "server:prompt (MCP)" displayName) would be split into two tokens once
  // inserted, so it can never be a valid completion target. `/` is excluded for
  // the same reason plus one more: the ghost and the dropdown stay disjoint
  // only because no candidate can match a token that starts with `/`, and
  // loaders pass display names through unvalidated. The same command's
  // canonical name is still a candidate.
  return candidates.filter((candidate) => !/[\s/]/.test(candidate.text));
}

/**
 * Longest common prefix, compared by code point rather than code unit.
 *
 * Command names come from directory names and may contain astral characters;
 * a code-unit comparison could stop between a surrogate pair and produce a
 * token containing half of one.
 */
function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) {
    return '';
  }
  let prefix = [...values[0]];
  for (let i = 1; i < values.length && prefix.length > 0; i++) {
    const chars = [...values[i]];
    let shared = 0;
    while (
      shared < prefix.length &&
      shared < chars.length &&
      prefix[shared] === chars[shared]
    ) {
      shared++;
    }
    prefix = prefix.slice(0, shared);
  }
  return prefix.join('');
}

/**
 * Finds the ghost completion for a partial command name.
 *
 * Prefix-only by design: ghost text is a literal continuation of what the user
 * typed, so a fuzzy match's "completion" could not be appended to the input.
 * The dropdown keeps fuzzy search.
 *
 * When several commands match, the ghost is their longest common prefix rather
 * than a pick among them — asserting one name would be wrong far more often
 * than right for a catalog with many same-prefix skills. Only when the matches
 * share nothing at all does it fall back to naming the shortest one, so that a
 * short prefix still gets a hint instead of silence.
 *
 * Either way, a completion that several commands still share is reported as
 * non-unique, and the caller leaves the trailing space off.
 */
export function findBestCommandGhostMatch(
  commands: readonly SlashCommand[],
  query: string,
): CommandGhostMatch | null {
  if (!query) {
    return null;
  }

  const lowerQuery = query.toLowerCase();
  const matches: Candidate[] = [];

  for (const cmd of commands) {
    // Same filter the dropdown's fzf index uses.
    if (cmd.hidden) {
      continue;
    }
    for (const candidate of collectCandidates(cmd)) {
      if (candidate.text.toLowerCase().startsWith(lowerQuery)) {
        matches.push(candidate);
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Tier pruning has to happen before the common prefix is computed: mixing an
  // `ab-name` (tier 0) with an `ab-display` (tier 1) would collapse to `ab-`
  // and quietly undo "name beats displayName".
  const bestTier = Math.min(...matches.map((candidate) => candidate.tier));
  const bestTierMatches = matches.filter(
    (candidate) => candidate.tier === bestTier,
  );

  // One command must not compete with itself: `/tasks` carries altNames `bg`
  // and `background`, and letting both into the prefix computation would make
  // an unambiguous command look ambiguous. Shortest spelling wins per command.
  const byCommand = new Map<SlashCommand, Candidate>();
  for (const candidate of bestTierMatches) {
    const existing = byCommand.get(candidate.command);
    if (
      !existing ||
      candidate.text.length < existing.text.length ||
      (candidate.text.length === existing.text.length &&
        candidate.text.localeCompare(existing.text) < 0)
    ) {
      byCommand.set(candidate.command, candidate);
    }
  }
  const finalists = [...byCommand.values()];

  if (finalists.length === 1) {
    // Slice by typed length so the candidate's original casing is preserved —
    // the inserted token has to stay resolvable by findCommandByPart.
    const { text } = finalists[0];
    const suffix = text.slice(query.length);
    return suffix ? { token: text, isUniqueMatch: true, suffix } : null;
  }

  // Compared case-sensitively: `DEPLOY-a` and `deploy-b` share no casing, so
  // there is nothing both of them agree on. `query` is ASCII (the trigger regex
  // says so), so slicing by its length is safe on the code-unit indexed string.
  const sharedSuffix = longestCommonPrefix(
    finalists.map((candidate) => candidate.text.slice(query.length)),
  );
  if (sharedSuffix) {
    return {
      token: query + sharedSuffix,
      isUniqueMatch: false,
      suffix: sharedSuffix,
    };
  }

  // The matches diverge immediately (`/he` → help, herdr). Staying silent here
  // reads as a broken feature: measured against a real catalog it costs the
  // ghost two thirds of one-character prefixes. Offer the shortest match
  // instead — still flagged non-unique, so Tab inserts it without the trailing
  // space that would claim the token is finished.
  const shortest = finalists.reduce((best, candidate) =>
    candidate.text.length < best.text.length ||
    (candidate.text.length === best.text.length &&
      candidate.text.localeCompare(best.text) < 0)
      ? candidate
      : best,
  );
  // Sliced by typed length so the candidate keeps its own casing and stays
  // resolvable by findCommandByPart.
  const suffix = shortest.text.slice(query.length);
  return suffix
    ? { token: shortest.text, isUniqueMatch: false, suffix }
    : null;
}
