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

/** Non-newline whitespace: the slot lives inside one backticked line. */
const WS = '[^\\S\\n]';

/**
 * The chunk role slot — `chunk 3 of 7` and the drift this file has measured
 * around it — as a regex SOURCE, spelled once.
 *
 * Case by character class rather than `/i`, because the source is spliced
 * into two regexes with different needs: `CHUNK_ROLE_RE` below matches a
 * whole role slot, and coverage's `CHUNK_RE` (the anti-forgery shape pin)
 * puts it behind the identity-line prefix, which must stay case-sensitive —
 * `agent-prompt`'s `inertMarkerLines` neutralizes forgeable lines by that
 * exact prefix, and a `/i` over the whole pattern would let a `you are
 * review agent` forgery ride past the inerter. Whitespace inside the slot
 * is any run of NON-newline whitespace: the slot lives inside one backticked
 * line (`[^`\n]+`), and a `\s+` that spanned a newline once assigned a chunk
 * the label parser refused, leaving one record half-owned (R32-1).
 *
 * The DRIFT AFFIXES — a `territory ` prefix, a hyphen for the space
 * (`chunk-3`), `/` for `of`, a missing count, a trailing `(round N)` — are
 * part of this source rather than a second grammar somewhere else, and that
 * is the point. Coverage's launch POSTURE had them hand-spelled: a slot
 * `chunk 1 of 2 (round 1)` was a chunk launch to the posture and nothing at
 * all to the assignment, so the record walked the credit gate on the
 * WHOLE-DIFF arm — token only, no count, no territory — and a stale round-1
 * record certified four chunks of an eight-chunk re-plan (R39-13); the same
 * gap left a `chunk 2 of 2 (round 2)` owner unnamed in every chunk-keyed
 * channel while the ledger answered `no-agent` over lines it had read
 * (R39-10). Two grammars for one question drift; one cannot.
 *
 * The count stays OPTIONAL and the id does not: `assignedChunkTotal` reads
 * `null` for a countless slot, and every credit-grade seal ANDs on the count
 * agreeing with this plan's chunk count — so a slot that carries no count
 * earns no coverage, exactly as it earned none when it was unreadable. What
 * it gains is a name, a cause and a disclosure.
 */
export const CHUNK_ROLE_SLOT_SOURCE =
  `(?:[tT][eE][rR][rR][iI][tT][oO][rR][yY]${WS}+)?` +
  `[cC][hH][uU][nN][kK](?:${WS}|-)+(\\d+)` +
  `(?:${WS}*(?:[oO][fF]|\\/)${WS}*(\\d+))?` +
  `(?:${WS}*\\([rR][oO][uU][nN][dD]${WS}+\\d+\\))?`;

/**
 * A role that IS a chunk assignment — `chunk 3 of 7` — labels as its id.
 * ONE parser decides both the label and the assignment: coverage's
 * `chunkAssignmentFromLaunchPrompt` below reads the same first identity
 * line and the same slot, so a launch the one assigns, the other labels —
 * by construction, not by two regexes kept in step by hand. A hand-edited
 * `Chunk 3 of 7` used to resolve as a chunk owner in the posted body and a
 * role agent in the ledger row; a `chunk 2 of 2 ` with a trailing space
 * inside the backticks was labeled a role and never assigned, so its
 * honest declaration was dropped and its reads certified the chunk (R32-1).
 * Surrounding non-newline whitespace in the slot is tolerated for that
 * reason. Anchored, because here the whole role slot is the candidate, not
 * a substring of a prompt.
 */
const CHUNK_ROLE_RE = new RegExp(`^${WS}*${CHUNK_ROLE_SLOT_SOURCE}${WS}*$`);

const IDENTITY_LINE_RE = /^You are review agent `([^`\n]+)`(.*)$/;

/**
 * The first line-anchored identity line of a launch, or null. The ONE scan
 * both `labelFromLaunchPrompt` and `chunkAssignmentFromLaunchPrompt` read:
 * for a CLI-built launch the identity IS line one, so its own line always
 * wins over anything quoted below it; a launcher-prepended context line is
 * prose and never matches, so the agent's own line is still the first hit.
 * One multiline scan, not a split: this runs for every agent record of
 * every coverage pass, and launcher-built prompts carry a diff-sized tail
 * that a line-array materializes for nothing.
 */
function firstIdentityLine(prompt: string): string | null {
  const m = /^You are review agent `[^`\n]+`[^\n]*/m.exec(prompt);
  return m ? m[0] : null;
}

/**
 * The chunk a launch's FIRST identity line assigns, with the `of M` count
 * that seals the assignment to a plan — or null when that line is a role's,
 * or there is none.
 *
 * Derived from the same line and the same slot regex as the label, so the
 * two cannot disagree: a record is `chunk N` to the ledger exactly when it
 * is assigned N here. Before this, assignment was decided by a separate
 * regex over the whole launch — the FIRST chunk-shaped identity line
 * anywhere — while the label read the first identity line of ANY shape, and
 * the two drifted on orchestrator-controlled text: a role launch quoting a
 * chunk launch below its own identity line was assigned the quoted chunk
 * and its quoted declaration was admitted, stripping live coverage; a
 * trailing space inside the backticks de-assigned a record the label parser
 * still read; a newline inside the slot assigned a record the label parser
 * refused (R32-1). A line one parser refuses is not an identity for the
 * other.
 */
export function chunkAssignmentFromLaunchPrompt(
  prompt: string,
): { id: number; total: number | null } | null {
  const line = firstIdentityLine(prompt);
  if (line === null) return null;
  const m = IDENTITY_LINE_RE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  const chunk = CHUNK_ROLE_RE.exec(m[1]);
  if (chunk === null) return null;
  // A drifted slot may carry no count at all (`chunk 3`, `territory chunk
  // 3`). `null` is the honest answer, and every credit-grade seal refuses
  // it — an absent count cannot agree with this plan's chunk count.
  return {
    id: Number(chunk[1]),
    total: chunk[2] === undefined ? null : Number(chunk[2]),
  };
}

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
  const line = firstIdentityLine(prompt);
  return line === null ? null : labelFromIdentityLine(line);
}

/**
 * The raw role slot of a launch's first identity line — the text between the
 * backticks, untrimmed — or null when the launch carries none. For a caller
 * that must decide what KIND of launch an unrecognised identity line names
 * (coverage's role-vs-drifted-chunk-launch question) without re-deriving the
 * label grammar.
 */
export function identityRoleSlot(prompt: string): string | null {
  const line = firstIdentityLine(prompt);
  if (line === null) return null;
  const m = IDENTITY_LINE_RE.exec(line.replace(/\r$/, ''));
  return m ? m[1] : null;
}
