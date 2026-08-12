/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Defect-LAYER coverage for a diff that models an external executable system.
//
// The reverse audit's stop rule is "two consecutive dry rounds": no auditor
// found a new gap. That is sound evidence about the layer the auditors walked
// and silent about every layer they did not. On a guard that re-implements a
// shell — PR #8687 — the abundant TOKEN-layer bypasses (a comment that eats the
// command, a glob, an `-oc` bundle) filled every round while the STATE layer
// (what a function/eval/subshell propagates or drops) went unexamined; a dry
// round on the token layer said nothing about it, and the loop could converge
// with a whole class untouched. "No new gaps" needs to become "which layers has
// nothing been filed against."
//
// A layer counts as COVERED when an auditor RECEIPTED it — a structured line,
// `Layer walked: <id> — <note>`, whose note may record a finding or a clean
// walk. Coverage is the RECEIPT, not the finding: a marker-less finding does not
// count its layer, so an auditor must name every layer it walked. The marker has
// the exact shape and discipline of the `Budget gap:` line (budget.ts): a line
// the parser reads, not a phrase it guesses at. Keyword inference exists too, but only as an OPT-IN estimate for
// measuring transcripts recorded before the auditor brief asked for the marker
// (the A/B baseline); the marker is the authority, because an agent parrots what
// it is handed and a coverage claim guessed from prose is the same self-consistent
// blind spot the layer taxonomy exists to break.
//
// This module is pure: it computes coverage, it decides nothing. The cap that
// consumes it — one `unreviewedDimensions` entry per unwalked layer, which can
// only withhold an Approve, never end the loop — ships alongside it in
// `layer-audit-gate.ts`. What stays deferred behind an A/B is the RISKIER half:
// letting an unwalked layer EXTEND the reverse-audit loop rather than only cap
// the verdict. Nothing here can make the loop stop sooner.

/** One defect layer of a modeled executable system. */
export interface DefectLayer {
  /** The id an auditor writes in its `Layer walked:` receipt. Kebab-case. */
  id: string;
  /** How the layer is named to a human reading a coverage report. */
  label: string;
  /**
   * The parenthetical the reverse-audit brief shows the auditor for this layer.
   * The brief's layer list is RENDERED from this taxonomy (see
   * `renderShellLayerBriefList`), so the ids the parser reads and the ids the
   * auditor is asked to receipt cannot drift — one edit here moves both.
   */
  briefHint: string;
  /**
   * Lowercased substrings that INFER this layer was touched, for the opt-in
   * keyword estimate over marker-less (pre-brief) transcripts. Never the
   * authority — the structured receipt is. Deliberately specific: a token so
   * generic it matches any review return would report every layer covered and
   * defeat the measurement.
   */
  signals: string[];
}

/**
 * The shell/git execution model's defect layers, coarsest surface to deepest
 * semantics. This is the built-in taxonomy for the one modeled system the skill
 * has measured (`daemon-git-worktree-guard.ts`). The coverage functions take a
 * `taxonomy` argument so a different modeled system (a SQL planner, a markdown
 * sanitizer, a wire-protocol codec) can be measured by a programmatic caller that
 * passes its own list — but no manifest channel wires such a list through yet, so
 * the shipped gate measures `SHELL_MODEL_LAYERS` only. Arming the
 * `modeled-executable-system` domain on a non-shell diff is out of scope today:
 * it would owe the shell layers forever. Wiring the taxonomy through the manifest
 * is the follow-up that lifts that limit.
 */
export const SHELL_MODEL_LAYERS: readonly DefectLayer[] = [
  {
    id: 'lexing',
    briefHint: 'quoting, comments, globs, backticks, continuations',
    label:
      'lexing & quoting (comments, globs, backticks, quotes, continuations)',
    signals: [
      'token',
      'lexer',
      'tokeniz',
      'comment',
      'glob',
      'backtick',
      'ansi-c',
      "$'",
      'backslash',
      'continuation',
      'quoting',
    ],
  },
  {
    id: 'expansion',
    briefHint: 'word-splitting, command substitution, brace/param/tilde',
    label:
      'expansion (word-splitting, command substitution, brace/param/tilde)',
    signals: [
      'word-split',
      'word split',
      'command substitution',
      '$(',
      'brace expansion',
      'parameter expansion',
      'tilde',
    ],
  },
  {
    id: 'scope-propagation',
    briefHint:
      'what a function/`eval`/subshell/pipeline body propagates back or drops — cwd, exports, definitions',
    label:
      'scope & state propagation across function/eval/subshell/pipeline calls',
    signals: [
      'propagat',
      'cwdafter',
      'trackedcwd',
      'working directory',
      'nested body',
      'nested scope',
      'state-return',
      'state return',
      'does not propagate',
      'carried back',
      'merge back',
    ],
  },
  {
    id: 'resolution-order',
    briefHint:
      'a function shadowing `git`/`cd`, `command`/`builtin` bypass, `export -f` — and the removals `unset -f`/`unalias`/`export -n -f`',
    label:
      'name resolution order (function vs builtin vs external, command/builtin, export -f)',
    signals: [
      'resolution order',
      'shadow',
      'builtin',
      'command git',
      'export -f',
      'function named',
      'dispatch order',
      'shadowing',
    ],
  },
  {
    id: 'inheritance',
    briefHint:
      '`set -a`/allexport into a child or `$(…)`, and its reset `set +a`/`+o`',
    label:
      'option inheritance (set -a / allexport into a child or substitution)',
    signals: [
      'inherit',
      'allexport',
      'set -a',
      'set +a',
      '+o allexport',
      'exported into',
    ],
  },
  {
    id: 'toctou',
    briefHint: 'a planted `.git`, a relink, tar-then-commit — check-then-use',
    label:
      'oracle / filesystem timing (planted .git, relink, tar-then-commit, check-then-use)',
    signals: [
      'toctou',
      'time-of-check',
      'time of check',
      'planted',
      'relink',
      'gitfile',
      'check-then-use',
      'decision time',
    ],
  },
];

/**
 * The taxonomy rendered as the inline layer list the reverse-audit brief hands
 * an auditor — the SINGLE source of truth for the ids the parser reads and the
 * ids the brief asks the auditor to receipt, so the two cannot drift. Each entry
 * is the id in backticks and its hint: `` `lexing` (quoting, …), `expansion` (…) ``.
 * agent-briefs interpolates this into the reverse-audit brief, which is also what
 * makes this module reachable from the shipped bundle.
 */
export function renderShellLayerBriefList(
  taxonomy: readonly DefectLayer[] = SHELL_MODEL_LAYERS,
): string {
  return taxonomy.map((l) => `\`${l.id}\` (${l.briefHint})`).join(', ');
}

/** The marker an auditor writes to receipt a walked layer — the `Budget gap:`
 *  analogue. `Layer walked: <id> — <note>`; the note is free text after the id. */
const LAYER_RECEIPT_LINE_RE =
  /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*[*_~]{0,3}layer\s+walked[*_~]{0,3}[ \t]*[:：][\s*_~`]*([a-z][a-z0-9-]*)/i;

/** Cheap pre-filter so the line walk skips returns with no marker at all. */
const LAYER_HINT_RE = /layer\s+walked/i;

/**
 * The layer ids an auditor return RECEIPTS via the structured marker, validated
 * against the taxonomy (an unknown id is ignored, never coined). Fenced code and
 * blockquotes are skipped exactly as `budgetGapDisclosures` skips them — this
 * skill reviews its own PRs, and a return that QUOTES the marker is not USING it.
 */
/**
 * CommonMark-correct fenced-code tracking, biased toward SKIPPING. A QUOTED
 * `Layer walked:` marker must never read as a live receipt — that is the
 * credit/release direction — so openers are recognised GENEROUSLY (0-3 spaces of
 * indent, an optional list-item prefix, then three or more backticks or tildes;
 * whatever follows is ignored) and closers STRICTLY (the same fence character,
 * at least the opening run length, at most 3 spaces of indent, and only
 * whitespace after). A naive symmetric toggle diverged from CommonMark three
 * probe-verified ways, each releasing a quoted marker: a mismatched fence line
 * (`~~~` inside a ``` block, or a shorter run) closed early, a list-item fence
 * (`- ` then the run) never opened, and a fence line with trailing content
 * closed a block GitHub keeps open.
 */
function opensFence(line: string): { char: string; len: number } | null {
  const m = /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)]) +)?(`{3,}|~{3,})/.exec(line);
  return m ? { char: m[1][0], len: m[1].length } : null;
}

function closesFence(
  line: string,
  fence: { char: string; len: number },
): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1][0] === fence.char && m[1].length >= fence.len;
}

/**
 * The lines an auditor is USING, not quoting: fenced code (above), blockquotes,
 * and indented code blocks removed. Shared by the receipt parser and the opt-in
 * prose estimate so neither credits a layer from quoted text — the module's
 * "a return that QUOTES the marker is not USING it" invariant, in one place.
 */
function* usedLines(finalText: string): Generator<string> {
  let fence: { char: string; len: number } | null = null;
  for (const line of finalText.split(/\r?\n/)) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = opensFence(line);
    if (opened) {
      fence = opened;
      continue;
    }
    // A blockquote is a quotation by definition; an indented code block (four or
    // more leading spaces, or a leading tab) is quoted code.
    if (/^[ \t]*>/.test(line)) continue;
    if (/^(?: {4,}|\t)/.test(line)) continue;
    yield line;
  }
}

export function parseLayerReceipts(
  finalText: string,
  taxonomy: readonly DefectLayer[] = SHELL_MODEL_LAYERS,
): Set<string> {
  const ids = new Set<string>();
  if (!LAYER_HINT_RE.test(finalText)) return ids;
  const known = new Set(taxonomy.map((l) => l.id));
  for (const line of usedLines(finalText)) {
    const m = LAYER_RECEIPT_LINE_RE.exec(line);
    if (!m) continue;
    const id = m[1].toLowerCase();
    if (known.has(id)) ids.add(id);
  }
  return ids;
}

/**
 * The layer ids a return's PROSE infers, for the opt-in keyword estimate. Only
 * consulted when `keywordFallback` is on — a marker-less transcript (the A/B
 * baseline) has no receipts, and this is the best coverage guess available for
 * it. Approximate by construction: a receipt is the authority.
 */
export function inferLayersFromProse(
  finalText: string,
  taxonomy: readonly DefectLayer[] = SHELL_MODEL_LAYERS,
): Set<string> {
  // Over the USED lines only — the estimate must not credit a layer from a
  // signal that lives in quoted code or a blockquote, the same invariant the
  // structured parser enforces.
  const lower = [...usedLines(finalText)].join('\n').toLowerCase();
  const ids = new Set<string>();
  for (const layer of taxonomy) {
    if (layer.signals.some((s) => lower.includes(s))) ids.add(layer.id);
  }
  return ids;
}

export interface LayerCoverage {
  /** Layer id → whether any return covered it (receipt, or inferred when on). */
  covered: Record<string, boolean>;
  /** Ids no return covered — the owed scope a converged loop would hide. */
  uncovered: string[];
  /** For each covered id, the indices of the returns that covered it. */
  coveredBy: Record<string, number[]>;
}

/**
 * Coverage of a taxonomy across a run's auditor returns. A layer is covered when
 * a return RECEIPTS it (the authority) or, with `keywordFallback`, when a return's
 * prose infers it (the pre-marker estimate). Order-stable and pure.
 */
export function layerCoverage(
  finalTexts: readonly string[],
  opts: {
    taxonomy?: readonly DefectLayer[];
    keywordFallback?: boolean;
  } = {},
): LayerCoverage {
  const taxonomy = opts.taxonomy ?? SHELL_MODEL_LAYERS;
  const coveredBy: Record<string, number[]> = {};
  for (const layer of taxonomy) coveredBy[layer.id] = [];
  finalTexts.forEach((text, i) => {
    const ids = parseLayerReceipts(text, taxonomy);
    if (opts.keywordFallback) {
      for (const id of inferLayersFromProse(text, taxonomy)) ids.add(id);
    }
    for (const id of ids) coveredBy[id].push(i);
  });
  const covered: Record<string, boolean> = {};
  const uncovered: string[] = [];
  for (const layer of taxonomy) {
    const hit = coveredBy[layer.id].length > 0;
    covered[layer.id] = hit;
    if (!hit) uncovered.push(layer.id);
  }
  return { covered, uncovered, coveredBy };
}

/** Ids no return covered — the short answer `layerCoverage` wraps. */
export function uncoveredLayers(
  finalTexts: readonly string[],
  opts: { taxonomy?: readonly DefectLayer[]; keywordFallback?: boolean } = {},
): string[] {
  return layerCoverage(finalTexts, opts).uncovered;
}

/**
 * The repository-context `domains` sentinel a maintainer sets to declare a diff
 * a modeled executable system whose reverse audit owes per-layer coverage. It
 * rides an EXISTING manifest field (`domains`) rather than a new schema key, so
 * the strict repository-context validator is untouched: a maintainer adds a
 * matching rule to `.qwen/review-context.json` that emits this domain when the
 * diff touches the guard/interpreter it applies to, and the gate below keys on
 * it. Absent it, the gate is inert — every ordinary review is unaffected.
 */
export const MODELED_SYSTEM_DOMAIN = 'modeled-executable-system';

/**
 * Uncovered layers rendered as ready `unreviewedDimensions` entries — the cap
 * the reverse audit owes when a defect layer of a modeled system was never
 * walked. This is the SAFE direction and the whole point of the staging: it can
 * only withhold an Approve (compose-review caps a would-be Approve to Comment on
 * any `unreviewedDimensions` entry) and discloses the gap; it never ends the
 * loop early, never blocks a Request changes, never touches convergence. An
 * empty return (every layer walked, or nothing to read) caps nothing.
 *
 * The entry opens `reverse-audit layer coverage — ` rather than the bare
 * `reverse audit — ` an orchestrator writes for a whiffed auditor scope: the
 * latter prefix-matches compose-review's `reverse audit` coverage SUBJECT (a
 * delivery gap `verificationGaps` can emit), and the caller-echo dedup would
 * then shadow these per-layer lines out of the rendered "Not reviewed" section
 * in that narrow window. The distinct prefix keeps each layer's disclosure its
 * own line; the verdict cap is unaffected either way (it counts the entry before
 * that filter runs).
 */
export function owedLayerDimensions(
  finalTexts: readonly string[],
  opts: { taxonomy?: readonly DefectLayer[]; keywordFallback?: boolean } = {},
): string[] {
  return uncoveredLayers(finalTexts, opts).map(
    (id) =>
      `reverse-audit layer coverage — the ${id} layer of a modeled executable system was never walked`,
  );
}
