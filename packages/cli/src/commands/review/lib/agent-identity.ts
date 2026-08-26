/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The identity line `agent-prompt` bakes into every launch it builds —
// `You are review agent `<role>` — <label>[ (round N)].[ Your file: `<path>`.]`
// — and the ONE parser for it. Two independent copies existed (cost-ledger's
// row labels and coverage's disclosure labels), which is how the format and
// its readers drift apart: when the builder changes and a copy is missed,
// that reader silently falls back to first-line prose.
//
// What each caller decides for itself is WHICH line to feed the parser.
// cost-ledger trusts only the prompt's first line (the text below can QUOTE
// other agents' identity lines, and a whole-launch match would hand the
// quoted label to the agent carrying the quote); coverage scans for the
// first line-anchored identity line, because orchestrators prepend context
// lines to the launches they write (measured: twelve finders shared one
// PR-summary first line, and every disclosure rendered the same PR quote).

/**
 * A role that IS a chunk assignment — `chunk 3 of 7` — labels as its id.
 * Both readers key on the chunk role slot of the identity line —
 * coverage's `CHUNK_RE` anchors that line's shape around the same slot —
 * so a launch the one assigns, the other labels. A hand-edited `Chunk 3 of
 * 7` used to resolve as a chunk owner in the posted body and a role agent
 * in the ledger row. Anchored, because here the whole role slot is the
 * candidate, not a substring of a prompt.
 */
const CHUNK_ROLE_RE = /^chunk\s+(\d+)\s+of\s+\d+$/i;

const IDENTITY_LINE_RE = /^You are review agent `([^`\n]+)`(.*)$/;

/**
 * The label for ONE identity line, or null when the line is not one.
 *
 * Precedence mirrors what each suffix distinguishes: a chunk role is its
 * chunk id; a round suffix separates pipeline stages that share a role
 * (verify round 1 vs 2); the owned-file suffix separates the per-heavy-file
 * launches of an invariant role. Round wins over file when both appear —
 * the same order cost-ledger's rows always used.
 */
export function labelFromIdentityLine(line: string): string | null {
  // CRLF tolerance: callers hand over lines split on `\n` alone (and
  // cost-ledger slices at the first `\n`), so a prompt recorded with CRLF
  // endings leaves a trailing `\r` that `$` will not anchor past — every
  // parse would fail and every label fall back to first-line prose, the
  // exact defect the parser exists to end.
  const m = IDENTITY_LINE_RE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  const [, role, rest] = m;
  const chunk = CHUNK_ROLE_RE.exec(role);
  if (chunk) return `chunk ${chunk[1]}`;
  const round = /\(round (\d+)\)/.exec(rest);
  if (round) return `agent ${role} (round ${round[1]})`;
  const file = /Your file: `([^`\n]+)`/.exec(rest);
  if (file) return `agent ${role} (${file[1]})`;
  return `agent ${role}`;
}

/**
 * The first line-anchored identity line in a launch prompt, parsed. For a
 * CLI-built launch the identity IS line one, so its own line always wins
 * over anything quoted below it; a launcher-prepended context line is prose
 * and never matches, so the agent's own line is still the first hit.
 */
export function labelFromLaunchPrompt(prompt: string): string | null {
  // One multiline scan, not a split: this runs for every agent record of
  // every coverage pass, and launcher-built prompts carry a diff-sized tail
  // that a line-array materializes for nothing.
  const m = /^You are review agent `[^`\n]+`[^\n]*/m.exec(prompt);
  return m ? labelFromIdentityLine(m[0]) : null;
}
