/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';

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

/**
 * Tests the text immediately AFTER a captured id: an optional run of trailing
 * punctuation/symbols followed by either a non-space, non-punctuation code point
 * OR a CONNECTOR (`\p{Pc}`) means the id is STITCHED to more of a visible word
 * GitHub renders as one token (a letter/digit/mark — `toctou_x`, `toctoué` — a
 * punctuation-then-more run — `toctou.x`, `toctou‐x` — the dropped-node sentinel
 * — `` toctou`x` `` — or a lone connector, which UAX#29 joins with no word break:
 * `toctou_` renders one word). A clean receipt has nothing but non-connector
 * trailing punctuation before the next space: `toctou`, `toctou.`, `toctou — note`.
 */
const TRAILING_STITCH = /^[\p{P}\p{S}]*(?:[^\s\p{P}\p{S}]|\p{Pc})/u;

/**
 * The one CommonMark tokenizer this module uses. A hand-rolled fence/blockquote
 * scanner diverged from the spec round after round — a second parser is a
 * divergence hunt, and this skill's own lesson is that the oracle must come from
 * the authority the code is modelling. So it defers to `markdown-it`, the parser
 * GitHub's own family uses, and reads receipts from the prose it RENDERS (see
 * `usedLines`). `html: true` so raw HTML is tokenized — and thus excluded — too.
 */
const MD = new MarkdownIt({ html: true });

// Stands in for a dropped inline node (code span, inline HTML, image) in the
// reconstructed prose. A single NON-whitespace, non-marker code point (U+0000):
// unlike a newline it does not FORGE a line start, and unlike an empty string it
// does not let the text on either side STITCH — the receipt regex's leading
// anchor (`^\s*…`) and its id class (`[\s*_~\`]*[a-z]`) both reject it, so a
// marker only ever begins a reconstructed line when it truly begins a visible one.
const DROPPED_INLINE = '\u0000';

// Directionality controls REORDER visible text rather than hide it, so deleting
// them would make the reconstruction the LOGICAL text, not what a human sees
// (`<RLO>Layer walked: toctou` displays reversed — never a readable receipt). Map
// them to the dropped-node sentinel instead: opaque, so they break a match right
// where they disrupt the visible reading. `\p{Bidi_Control}` is the whole family
// (LRM/RLM/ALM, embeddings/overrides U+202A–202E, isolates U+2066–2069),
// property-defined so it cannot drift.
const BIDI_CONTROL = /\p{Bidi_Control}/gu;

// Code points GitHub renders as NOTHING (truly invisible, not reordering): every
// non-bidi format character (`\p{Cf}` — zero-width spaces/joiners, BOM, soft
// hyphen, …) and variation selector, plus VT, FORM FEED (CSS does not collapse it
// to a space), the combining grapheme joiner, and the line/paragraph separators
// (not `\p{Cf}`). A Unicode PROPERTY class, not a hand-enumerated one, so it
// cannot silently MISS a member the way a list does — enumerating by hand is what
// left the bidi isolates open. Same family the sanitizer's `PROMPT_UNSAFE_INVISIBLES`
// (channels/base) guards, the same drift-proof way. markdown-it decodes numeric
// entities at parse time, so any of these can land in a text child (`&#8203;`,
// `&#12;`). Left in the prose view they would glue a marker phrase GitHub shows
// fused (`layerwalked`) or wedge invisibly between an id and following text;
// deleted so the reconstruction is what a human sees (a wedge just before a REAL
// break still leaves a clean receipt). Bidi controls are `\p{Cf}` too, but the
// sentinel map above already replaced them.
const INVISIBLE_FORMAT =
  /[\p{Cf}\p{Variation_Selector}\u000B\u034F\u000C\u2028\u2029]/gu; // eslint-disable-line no-control-regex, no-misleading-character-class

/**
 * The lines an auditor is USING, not quoting — the VISIBLE PROSE markdown-it
 * renders, reconstructed from its token stream. A quoted block (a fenced or
 * indented code block, an HTML block, or anything inside a blockquote) yields
 * nothing; a prose block (paragraph, heading, list item) yields its text nodes
 * and visible line breaks, with inline code spans, raw HTML (tags, comments,
 * attribute values, raw-text elements) and the title/alt attributes of links and
 * images reduced to a non-line-starting sentinel — GitHub renders those as
 * nothing, as monospace, or inline/escaped, never as a line-leading receipt.
 *
 * Reading the rendered prose, not the source lines, is what closes the divergence
 * outright: a block-only pass still leaked a marker hidden in an INLINE construct
 * — a multi-line inline code span, an HTML comment or attribute, a link title, a
 * link-reference continuation — as a live receipt, and enumerating those one by
 * one just opens the next. A parser throw (unconstructed in practice) falls back
 * to the raw source lines, where the anchored receipt regex still holds.
 */
function* usedLines(finalText: string): Generator<string> {
  const src = finalText.replace(/\r\n?/g, '\n');
  let tokens: ReturnType<typeof MD.parse>;
  try {
    tokens = MD.parse(src, {});
  } catch {
    yield* src.split('\n');
    return;
  }
  let blockquoteDepth = 0;
  for (const t of tokens) {
    if (t.type === 'blockquote_open') blockquoteDepth++;
    else if (t.type === 'blockquote_close') blockquoteDepth--;
    else if (t.type === 'inline' && blockquoteDepth === 0) {
      // The visible prose of this inline, reconstructed the way GitHub lays it
      // out. A visible line break — a soft/hard break, or a `<br>` tag, which
      // GitHub renders as one — splits the line. Every OTHER inline node — a code
      // span, other inline HTML (a raw tag, a comment, or a raw-text element like
      // `<script>`/`<title>` whose inner text markdown-it exposes as a child but
      // GitHub shows only inline or escaped), or an image — does NOT start a new
      // visible line on GitHub, so it must not start one here: it is replaced by
      // `DROPPED_INLINE`, a non-whitespace sentinel that neither forges a line
      // start (`x <script>Layer walked: id` stays one line, marker mid-line →
      // rejected, as GitHub renders it) nor lets fragments stitch (`Layer walked:
      // <x>id` → the id capture stops at the sentinel). `text` is prose, except a
      // raw newline in it can only come from a decoded numeric entity (`&#10;`) —
      // a real source break is a `softbreak`/`hardbreak` TOKEN, never text — and
      // GitHub collapses that entity LF to whitespace, so it must not split a line
      // either. Emphasis and link open/close nodes are NEITHER a break nor a
      // sentinel: their visible text children flow through (a link's visible text
      // is a real receipt).
      let prose = '';
      for (const c of t.children ?? []) {
        if (c.type === 'text')
          prose += c.content
            .replace(/[\r\n]+/g, ' ')
            .replace(BIDI_CONTROL, DROPPED_INLINE)
            .replace(INVISIBLE_FORMAT, '');
        else if (c.type === 'softbreak' || c.type === 'hardbreak')
          prose += '\n';
        else if (
          c.type === 'html_inline' &&
          // A real GitHub break: `<br>`, self-closing, or with attributes — but
          // NOT a `<br-…>` custom element (a hyphen keeps the tag name going, and
          // GitHub strips the non-allowlisted tag, leaving no break). After `br`
          // the tag must END, or continue with whitespace/slash then attributes.
          /^<br(?:[ \t\n\f\r/][^>]*)?>$/i.test(c.content)
        )
          prose += '\n';
        else if (
          c.type === 'code_inline' ||
          c.type === 'html_inline' ||
          c.type === 'image'
        )
          prose += DROPPED_INLINE;
      }
      yield* prose.split('\n');
    }
    // fence, code_block, html_block, and any inline inside a blockquote yield
    // nothing — they are quoted.
  }
}

/**
 * The layer ids an auditor return RECEIPTS via the structured marker, validated
 * against the taxonomy (an unknown id is ignored, never coined). Reads only the
 * USED lines (`usedLines` strips fenced code, blockquotes and indented code) —
 * this skill reviews its own PRs, and a return that QUOTES the marker is not
 * USING it.
 */
export function parseLayerReceipts(
  finalText: string,
  taxonomy: readonly DefectLayer[] = SHELL_MODEL_LAYERS,
): Set<string> {
  const ids = new Set<string>();
  // Cheap pre-filter. It reads RAW text but the parser reads DECODED, markup-joined
  // prose, so it must not veto a marker whose words are split by inline markup —
  // even MID-word, and even when BOTH words are (`La*yer* wal*ked*`) — or are
  // entity-encoded (`Layer&#32;walked`). Strip the inline-markup delimiters first,
  // then skip only when BOTH words are absent from that AND no entity could decode
  // into them; a single surviving word (or any entity) runs the full parse.
  const bare = finalText.replace(/[*_~`[\]()]/g, '');
  if (
    !/layer/i.test(bare) &&
    !/walked/i.test(bare) &&
    !/&[#a-z]/i.test(finalText)
  )
    return ids;
  const known = new Set(taxonomy.map((l) => l.id));
  for (const line of usedLines(finalText)) {
    const m = LAYER_RECEIPT_LINE_RE.exec(line);
    if (!m) continue;
    // Trailing stitch: the id capture is un-anchored at its end, so anything that
    // renders JOINED to the id disqualifies the receipt — GitHub shows one token
    // (`toctoux`, `toctou_x`, `toctou.x`, `toctou‐x`, `toctou` + a dropped node),
    // never a receipt. A clean receipt's id ends its visible word: the run up to
    // the next space must be nothing but trailing PUNCTUATION/symbols (`toctou`,
    // `toctou.`, `toctou — note`). So reject when that run holds any non-space,
    // non-punctuation code point — a letter, digit, mark, connector, OR the
    // dropped-node sentinel — after an optional punctuation prefix. This one rule
    // is the mirror of the leading-stitch guard and subsumes the sentinel check.
    if (TRAILING_STITCH.test(line.slice(m[0].length))) continue;
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
  // Over the USED lines only, sharing the receipt parser's quotation view: a
  // signal in a fenced/indented block, a blockquote, OR an inline code span is
  // dropped. For a receipt that is exactly right (a quoted marker is not a
  // receipt); for this estimate it can UNDER-count a layer an auditor named in
  // backticks (`` `set -a` ``), but that only infers FEWER layers → owes more →
  // the over-cap (fail-safe) direction, acceptable for a non-authoritative guess.
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
    // `coveredBy` is a local tally only — which returns hit each layer is not a
    // fact any production reader needs, just the boolean that derives from it.
    const hit = coveredBy[layer.id].length > 0;
    covered[layer.id] = hit;
    if (!hit) uncovered.push(layer.id);
  }
  return { covered, uncovered };
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
