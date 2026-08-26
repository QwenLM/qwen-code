/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-chunk retirement for the Step 5 reverse-audit loop.
//
// On a 3B plan the loop launches one auditor PER CHUNK PER ROUND, up to five
// rounds. Measured on a real run (6 chunks × 5 rounds = 30 auditors, ~95
// minutes): chunks 3 and 6 came back dry in ALL five rounds, while chunks 1,
// 2 and 4 yielded in most of them. The loop's convergence rule is
// round-global — two consecutive dry ROUNDS — so one hot territory keeps
// every cold one under audit for the whole run: auditor after auditor
// re-walking code that has twice produced a substantive all-clear, on
// exactly the large reviews where the rounds they pad push the loop into the
// budget gate.
//
// So from round 3 on the schedule becomes per-chunk. A chunk whose two most
// recent audits are both substantive dry receipts is RETIRED: instead of an
// auditor every round it gets a cold check on alternating rounds, and a cold
// check that yields puts it straight back on the every-round schedule.
// Rounds 1 and 2 always fan out to every chunk — they are what establishes
// each chunk's record.
//
// The history this is read from is the same pair of artifacts every delivery
// check trusts: the prompts this CLI recorded itself building (keyed
// `reverse-audit--chunk-<n>--round-<k>--<digest>`) and the harness's own
// transcripts of the agents launched with them. Nothing the orchestrator
// writes is consulted — a schedule the subject of the checks could edit is a
// schedule that retires whatever chunk is inconvenient to audit.
//
// Everything here fails toward auditing, chunk by chunk: no transcripts, no
// matching transcript, a whiffed receipt, an unclassifiable return — each
// reads as "not dry", and a chunk that cannot prove itself cold stays hot.
// The failure mode of a bug in this file is the old behaviour (audit every
// territory every round), never a skipped one. Since #9206 the failure is
// also not SILENT: a chunk whose two most recent audits neither retired it
// nor proved it hot carries a `diagnostics` line naming the bar each round
// fell at, so a never-retiring loop is diagnosable from the round's own
// output instead of from evidence cleanup was about to destroy.

import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readRunTranscripts, type AgentRecord } from './transcripts.js';
import { REVERSE_AUDIT_EXAMPLE_RECEIPT } from './agent-briefs.js';
import { readFindingsPointer } from './certification.js';
import {
  INLINE_LAYER_WALKED_RE,
  LAYER_RECEIPT_LINE_RE,
} from './audit-layers.js';
import {
  deliveredVerbatimLines,
  findingsPointerOf,
  flattenPrompt,
  promptLines,
  promptRecordDir,
  readRecordedPrompts,
} from './prompt-record.js';
import { stripBudgetGapLines, INLINE_BUDGET_GAP_RE } from './budget.js';

/** What one prior audit of one chunk provably produced. */
export type AuditOutcome = 'yielded' | 'dry' | 'unknown';

/**
 * Why an audit that could have certified a chunk cold did not — the bar it
 * failed, named. #9206: a loop whose cold chunks never retired ran five
 * rounds to the cap without ONE word of why, because every refusal below
 * landed in the same silent `unknown`; the evidence was then cleaned up
 * unread. Failing toward auditing stays right — a chunk that cannot prove
 * itself cold stays hot — but the failure must say its name on the round's
 * own output, where the reader can act on it.
 */
export type CertificationFailure =
  | 'no matching transcript'
  | 'launch matched multiple records'
  | 'auditor never returned'
  | 'no successful tool calls'
  | 'no read of the diff'
  | 'territory read missing'
  | 'receipt not matched'
  | 'receipt not alone'
  | 'receipt lead contradicts the phrase'
  | 'receipt clause restates the all-clear'
  | 'receipt clause contradicts the phrase'
  | 'receipt clause names no walk'
  | 'receipt clause too thin'
  | 'findings list unread';

/** One transcript's classified return, with the failed bar when not dry. */
interface Classification {
  outcome: AuditOutcome;
  /** Defined exactly when `outcome` is `unknown`. */
  failure: CertificationFailure | null;
}

/** A retired chunk skipped this round, with the receipts that earned it. */
export interface RetiredChunk {
  chunkId: number;
  /** The two most recent audit rounds — both substantive dry receipts. */
  dryRounds: [number, number];
  /** The next round whose parity puts the chunk back under audit. */
  nextColdCheck: number;
}

export interface RoundSchedule {
  /** Chunk ids to build this round, in the order the caller gave them. */
  due: number[];
  /** The subset of `due` that is a retired chunk's alternating cold check. */
  coldChecks: number[];
  /** Retired chunks NOT due this round — the retirement note names these. */
  skipped: RetiredChunk[];
  /**
   * Chunks the fix-audit posture narrowed out of the wave (#10104): not a
   * delta territory, and the most recent audit on record is a substantive
   * dry receipt. Unlike a retired chunk they get no alternating cold check —
   * on a critical-posture round the wave re-launches only the delta
   * territories and whatever yielded in the previous wave, and the note
   * disclosing that IS this list. Empty whenever the caller passed no
   * narrowing context.
   */
  narrowed: Array<{ chunkId: number; dryRound: number }>;
  /** Every chunk is retired and none is due: the audit has converged. */
  converged: boolean;
  /**
   * One line per chunk whose two most recent audits are NEITHER dry enough
   * to retire NOR hot with a yield — the certification failures, named per
   * round, that leave it under audit (#9206). Empty when every chunk is
   * retired, yielded, or still establishing its record. The caller prints
   * these on STDERR; stdout is the deliverable the orchestrator pastes.
   */
  diagnostics: string[];
}

/**
 * The round part of a per-chunk reverse-audit record key, as `runAllChunks`
 * and the single-chunk rebuild path both spell it. The digest tail is matched
 * loosely on purpose: its width is the digest function's business, and a key
 * this regex misses is merely history this module cannot see — fail-open.
 */
const RECORD_KEY_RE = /^reverse-audit--chunk-(\d+)--round-(\d+)--[0-9a-f]+$/;

/**
 * Every launch the builder emits for this loop carries the literal role id —
 * the identity line and the brief path both spell it, whitespace-free, so no
 * re-wrap can hide it — and each record's own lines carry it too, so a
 * transcript that could verbatim-match any record must contain it. That makes
 * it a sound cheap cut over the transcripts before the pairing walk.
 */
const REVERSE_AUDIT_MARKER = 'reverse-audit';

/**
 * The diff lines a record's prompt points its chunk at, 1-based and
 * inclusive. Every per-chunk launch this CLI builds bakes exactly one
 * `read_file(file_path="…", offset=N, limit=M)` aimed at the diff; the dry
 * bar compares what the transcript actually read against it. Empty when the
 * prompt bakes no read, where the bar falls back to "opened the diff at
 * all" — a shape this module's own records never have.
 *
 * The scan is bound to the diff's own path because the prompt carries other
 * `read_file` lines — the brief, the findings list file — and prose quoting
 * ANY `offset=N, limit=M` pair (a read_file call under discussion, this very
 * file in a diff) would otherwise inject its range into the territory. When
 * the findings list was folded into the prompt verbatim it did exactly that:
 * `openedTheTerritory` passes on ANY overlap with ANY range, so an injected
 * range can only WIDEN the bar — an auditor whose only diff read was lines
 * 1-50 would retire a chunk whose territory is 1001-1200 the moment a
 * finding quoted `offset=0, limit=50` — the same range-blind hole the
 * territory check exists to close, reopened by honest findings. Only a read
 * aimed at the diff is territory. An unknown diff path reads as no
 * territory: the transcripts side then marks no call a diff read, every
 * transcript classifies `unknown`, and no chunk retires — the territory is
 * never consulted.
 */
export function bakedRanges(
  prompt: string,
  diffPath: string | undefined,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (diffPath === undefined) return out;
  for (const m of prompt.matchAll(
    /read_file\(\s*file_path="([^"]*)",\s*offset=(\d+),\s*limit=(\d+)/gi,
  )) {
    if (m[1] !== diffPath) continue;
    const offset = Number(m[2]);
    const limit = Number(m[3]);
    if (limit > 0) out.push([offset + 1, offset + limit]);
  }
  return out;
}

/** A finding's file line — the shape `FINDING_FORMAT` asks every role for. */
const FILE_LINE_RE = /\*\*File:\*\*\s*([^\n]*)/g;

/**
 * The other half of a filed finding. A `**File:**` line alone is not proof
 * the auditor FILED anything: the auditor was launched against a cumulative
 * findings list (a `.findings.md` file its prompt points at), and an auditor
 * explaining "already covered, not re-reporting" can echo an entry's file
 * line into its return. Every finding actually filed carries the full block
 * the format mandates — severity included — so the pair is what
 * distinguishes a report from a bare file-line echo; a quotation of a WHOLE
 * entry is caught in `classifyReturn`, where the list is on hand. Misreading
 * an echo as `yielded` is cost, not corruption (the chunk just stays hot),
 * but it is exactly the cost this module exists to stop paying.
 */
const SEVERITY_LINE_RE = /\*\*Severity:\*\*/;

/**
 * The no-issues receipt, read as the one FORM the reverse-audit brief
 * mandates for a dry return (#9213 on #9206): the phrase LEADS the return,
 * a separator opens the clause, and the clause — the rest of that line —
 * names what was re-examined. A dry return carries NOTHING else: any prose
 * before the phrase or after the receipt's line — the brief's other
 * mandated line forms, `Budget gap:` and `Layer walked:`, stripped first —
 * is not the form, reads `unknown`, and the chunk stays under audit. The
 * form is the structural half of the polarity guard: prose has no last
 * hedge, so no enumeration of hedges closes, and a return that is not
 * exactly the receipt cannot certify, whatever it says. Within the form,
 * the clause still carries a marker test, a walk test and the substance
 * floor below.
 *
 * A bare "No issues found." — the text 23 real whiffing agents returned —
 * matches the form and fails the clause checks: specific-sounding brevity
 * is not evidence of a walk. Auditors narrate in the review's output
 * language (`未发现问题` is the phrasing compose-review itself ships), so
 * the phrase accepts the zh forms beside the English ones.
 *
 * The separator admits an em/en dash anywhere (`——` doubled included), a
 * colon in either width, an ASCII hyphen only when it stands alone —
 * space-led or doubled — so the dash inside `retry-cap` never opens a
 * clause mid-word, and sentence punctuation in either width: a run whose
 * cold chunks returned `No new issues were found. Re-walked …` (period)
 * and `未发现新问题，重新走查了…` (full-width comma) never retired one of
 * them while the stop sat outside the class (#9206's widening). The
 * anchor does the quoting guard's old work — a quotation of the phrase is
 * never the LEAD, so `I cannot write "No new issues were found." …` opens
 * no clause — and it closes every hedge BEFORE the phrase the line-scoped
 * domain never saw: such prose is not the form. Opening emphasis may lead
 * (`**No issues found** — …`) in the same `**File:**` idiom the pipeline
 * writes in. The filler between phrase and separator (`were found`, a
 * parenthesised scope) is capped and word-only apart from parentheses:
 * other markdown in between is a new sentence, not this receipt.
 */
const DRY_RECEIPT_EN = '\\bno (?:new )?(?:issues?|findings?|gaps?)';
const DRY_RECEIPT_ZH =
  '|未发现(?:新的?)?(?:问题|发现)' +
  '|无新的?(?:问题|发现)' +
  '|没有(?:发现)?(?:新的?)?问题';

/**
 * The matcher's phrase: the EN alternative carries the filler between
 * phrase and separator (`were found`, `(chunk 13)`); the zh ones do not.
 */
const DRY_RECEIPT_PHRASE =
  '(?:' + DRY_RECEIPT_EN + '[ \\w()]{0,32}' + DRY_RECEIPT_ZH + ')';

/**
 * Closing emphasis/quotation that may sit between the phrase and the stop.
 * Every whitespace element here is LINE-BOUND (`[ \t]`, never `\s`): a
 * `\s*` matches `\n`, so the matcher itself spanned lines and pulled the
 * clause in from a LATER line — `No issues found —\nre-walked …` matched
 * with the next line as its clause, and the receipt-is-its-line form
 * refused nothing (#9213).
 */
const DRY_RECEIPT_TAIL = '[ \\t]*[*_)\\]"”’]*[ \\t]*';

/**
 * The ONE receipt matcher: anchored — prose before the phrase is a form
 * violation, not a receipt lead — with every separator in one class and
 * the clause captured to the END OF THE LINE: the receipt is its line,
 * and prose on any later line is the form's to refuse, not the clause's
 * to judge (#9213). The separator's own whitespace is line-bound for the
 * same reason as the tail's: the ASCII hyphen's "stands alone" rule asks
 * for a space, not any `\s`, and a separator left dangling at a line end
 * opens no clause on the next one.
 */
const DRY_RECEIPT_RE = new RegExp(
  '^[ \\t]*[*_~]*' +
    DRY_RECEIPT_PHRASE +
    DRY_RECEIPT_TAIL +
    '(?:[—–]+|[:：.,;。，；]|--+|-+[ \\t])[ \\t]*' +
    '([^\\n]*)',
  'i',
);

/** CJK ideographs — a zh clause packs its substance into far fewer chars. */
const CJK_RE = /[一-鿿]/g;

/**
 * The clause the brief's own example receipt leaves AFTER its separator —
 * extracted with the same regex that parses receipts, so the two cannot
 * drift. Empty when the example ever stops matching its own parser, which
 * disables the parrot refusal rather than refuse every clause. The
 * lowercase copy is the parrot compare itself: the example clause starts
 * lowercase because it continues the model receipt mid-sentence, and a
 * parroting auditor opening it as a NEW sentence capitalizes it — no
 * honest clause contains the model clause verbatim in any casing (#9213).
 */
const EXAMPLE_RECEIPT_CLAUSE = (
  DRY_RECEIPT_RE.exec(REVERSE_AUDIT_EXAMPLE_RECEIPT)?.[1] ?? ''
).trim();
const EXAMPLE_RECEIPT_CLAUSE_LC = EXAMPLE_RECEIPT_CLAUSE.toLowerCase();

/**
 * The polarity guard's marker vocabulary, one of the clause tests the
 * form leaves standing (#9213 on #9206): a clause carrying ANY negation,
 * incapacity, or omission marker contradicts the all-clear phrase however
 * long and object-named it is (`…found — I was unable to open the
 * generated files` clears every length floor on the admission's own
 * words) and reads `unknown`; a contrast word WITHOUT one contradicts
 * nothing — `…the list already covered them, but I re-verified the
 * readers` is the walk the receipt claims, not a hedge. The vocabulary
 * names the marker families the executed leak probes carried — incapacity
 * (`unable`), omission (`failed`, `skipped`, `unchecked`, `untested`), a
 * shallow walk (`skimmed`), zh bare-不 (`打不开`) and 跳过 — with 不过
 * exempted as the pinned innocuous connective.
 *
 * The marker list is BARE on purpose (#9272): an absence-of-problems
 * exception class (`no regressions`, 没有回归, `fail-open` jargon) was
 * tried and removed after two review rounds of executed entrances —
 * passive voice (`no regressions have been verified`), lexicalized
 * compounds (回归测试), limiter compounds (只不过) — because an
 * exception list over natural language has no last corner, the same
 * lesson the polarity guard itself learned in #9213 (the form closes
 * what enumeration cannot). The stated residue is the honest mirror:
 * absence-of-problem phrasing that IS honest (`verified no
 * regressions`, `确认没有回归`) reads `unknown` and the chunk stays
 * under audit — the never-retire cost this module already declares as
 * its failure direction, preferable to certifying one admission. The
 * list has no last word, and the residue is stated rather than
 * papered over: a marker it misses still fails toward RETIREMENT when the
 * clause ALSO names a walk; what closes that class is the form itself —
 * the brief tells an auditor that did not walk its scope to return
 * prose, not the receipt, and prose is not the form.
 */
const NEGATION_MARKER_RE =
  /\bnot\b|n['’]t\b|\bnever\b|\bno\b|\bcannot\b|\bunable\b|\bfail(?:ed|ing|s)?\b|\bskip(?:ped|ping|s)?\b|\bskim(?:med|ming|s)?\b|\bun(?:checked|tested|verified|read|opened|examined)\b|未|没|无法|跳过|不(?!过)/i;

/**
 * The brief's own all-clear vocabulary — the exact shapes
 * `DRY_RECEIPT_PHRASE` names — restates the phrase inside the receipt's
 * line (`no gaps:`, 未发现问题) instead of contradicting it. Stripped
 * before the substance floor, so a walk narrated in the brief's own words
 * is not refused by the floor and a clause made of echoed phrases cannot
 * lend it their length (the filler rides along in the strip, greedy with
 * the phrase's own). A novel positive phrasing the strip misses still
 * fails toward audit, like every other refusal here.
 */
const SATURATED_CLAUSE_RE = new RegExp(DRY_RECEIPT_PHRASE, 'gi');

/**
 * The walk the FORM's vocabulary names — the brief spells the same
 * family out when it mandates the receipt. A dry clause must carry one of
 * verbs, or name an object: a clause that names no walk proves none,
 * whatever its length and whatever markers it dodges (#9213 — the
 * unbounded hedge class no marker list closes: `overlooked`, `missed`,
 * `ignored`, `without checking`, 忽略, 略过, 遗漏 …). The test's misses
 * fail toward AUDIT — a clause whose walk verb the vocabulary does not
 * name reads `unknown` and the chunk stays hot — the opposite direction
 * of a marker miss, and the only one the module header declares.
 */
const WALK_VERB_SRC =
  '\\bwalk|\\bverif|\\btrace|\\bexamin|走查|核对|复核|核查|复查|重走';
const WALK_VERB_RE = new RegExp(WALK_VERB_SRC, 'i');

/**
 * The polarity guard, closed by FORM rather than enumeration (#9272,
 * rounds 4–6 — three shipped guard shapes were each falsified by
 * execution the round they landed: walk-verb lookaheads, passive-head
 * lookaheads, a `found` exemption; every one left an executed entrance
 * retiring a chunk on a receipt that admitted the walk was not done).
 * The bars:
 *
 * 1. THE LEAD (the phrase's own side of the separator) is stripped of
 *    its phrase cores and the residue is marker-tested: a hedge riding
 *    the filler (`…found but only skimmed.`) contradicts the claim
 *    exactly as one in the clause.
 * 2. THE CLAUSE must not contain the receipt's core AT ALL — a clause
 *    restating the all-clear (`no issues …`, 未发现问题 …) proves no
 *    walk, whatever follows the restatement, and no regex tells the
 *    honest `no issues were found verifying X` from the admission `no
 *    issues were found because nothing was verified`: both refuse as
 *    `receipt clause restates the all-clear`. This one bar retires the
 *    entire executed entrance family — passive voice, reduced passives,
 *    dash- or comma-spliced runs — with no lookahead and no list.
 * 3. What survives restatement is marker-tested bare: a clause carrying
 *    ANY negation, incapacity, or omission marker contradicts the
 *    phrase however long and object-named it is.
 *
 * The stated residue, declared rather than papered over: an admission
 * phrased with no restatement, no listed marker, and a walk verb
 * (`nothing was verified`, `overlooked the files`, 忽略/略过/遗漏)
 * still reads dry; what closes that class is the form itself — the
 * brief tells an auditor that did not walk its scope to return prose,
 * not the receipt, and prose is not the form — and a wrongly granted
 * retirement self-corrects at the next even-round cold check.
 */
const DRY_RECEIPT_PHRASE_CORE = '(?:' + DRY_RECEIPT_EN + DRY_RECEIPT_ZH + ')';
const PHRASE_CORE_RE = new RegExp(DRY_RECEIPT_PHRASE_CORE, 'gi');
/** The restatement bar's own copy — non-global, so `.test` carries no lastIndex state. */
const CLAUSE_CORE_RE = new RegExp(DRY_RECEIPT_PHRASE_CORE, 'i');

/**
 * An ENCLOSED code span or a real path is a named object at any length —
 * a stray backtick is prose punctuation, not a quotation, and "N/A" is
 * not a path (one character on the slash's left), neither is the
 * conjunction "and/or": a path has a second slash or a dotted extension.
 */
function namesAnObject(clause: string): boolean {
  return (
    /`[^`]+`/.test(clause) ||
    /\w[\w.-]+\/[\w.$-]+\/\w/.test(clause) ||
    /\w[\w.-]+\/[\w$-]+\.\w+/.test(clause)
  );
}

function namesTheWalk(clause: string): boolean {
  const stripped = clause.replace(SATURATED_CLAUSE_RE, ' ');
  return WALK_VERB_RE.test(stripped) || namesAnObject(stripped);
}

/**
 * Does the clause after the receipt's separator name anything? A named
 * object clears it at any length; otherwise ~20 flattened characters, or
 * a handful of ideographs, is the least that can name a territory; "all
 * good." can not — and the floor measures the phrase-STRIPPED clause, so
 * echoed phrases cannot lend it their length (#9213). The brief's own
 * example receipt is refused outright, in ANY casing: a clause containing
 * the example's whole clause reads as the parrot it is, while real
 * parroting is partial — the shape and a phrase or two — and a partial
 * echo passes this check; what catches that is the rest of the dry bar
 * (the territory read, the substance floor). This refusal closes the
 * cheapest path: the exact sentence every auditor is handed. Misjudging
 * here fails the way everything in this module fails — the receipt reads
 * `unknown` and the chunk stays under audit.
 */
function substantiveClause(clause: string): boolean {
  const c = clause.replace(/\s+/g, ' ').trim();
  if (c.length === 0) return false;
  if (
    EXAMPLE_RECEIPT_CLAUSE_LC.length > 0 &&
    c.toLowerCase().includes(EXAMPLE_RECEIPT_CLAUSE_LC)
  ) {
    return false;
  }
  const stripped = c.replace(SATURATED_CLAUSE_RE, ' ').trim();
  if (namesAnObject(stripped)) return true;
  if ((stripped.match(CJK_RE) ?? []).length >= 4) return true;
  return stripped.length >= 20;
}

/**
 * The cumulative findings list an auditor was launched against. Since #8597
 * the list rides a digest-named `.findings.md` file the prompt points at —
 * read it back; a prompt with no pointer predates the file shape (or its
 * file is gone), and the prompt itself is the fallback, which is where the
 * list lived before. The pointer is the CLI's own record's (never the
 * orchestrator's pasted copy, which `wasDeliveredVerbatim` allows additions
 * around), confined to this plan's record dir before reading; an unreadable
 * or out-of-bounds file degrades to the prompt: no entry matches there, a
 * quotation counts as a yield, and the chunk stays hot — every failure in
 * this module lands on the audit side. `memo` keys on the pointer so the
 * pairing walk reads each round's list once, not once per record.
 */

function findingsListFor(
  prompt: string,
  recordDir: string,
  memo: Map<string, string>,
): string {
  const pointer = findingsPointerOf(prompt);
  if (pointer === null) return prompt;
  const root = resolve(recordDir);
  const target = resolve(pointer);
  if (target !== root && !target.startsWith(root + sep)) return prompt;
  const cached = memo.get(pointer);
  if (cached !== undefined) return cached;
  try {
    const content = readFileSync(target, 'utf8');
    // Memoize ONLY a successful read: the pointer is shared by every chunk of
    // the round (the file key is chunk-free), so caching a failure's fallback
    // — THIS record's prompt — would serve one chunk's launch text as every
    // other chunk's findings list. On a miss each record falls back to its
    // OWN prompt (no entry matches there → stays hot), uncached.
    memo.set(pointer, content);
    return content;
  } catch {
    return prompt; // Fall back to this record's own prompt.
  }
}

/**
 * The return's `Layer walked:` lines — the brief's other mandated line
 * form, parsed by `audit-layers` — stripped beside the budget-gap lines,
 * so a dry return on a modeled-system diff (layer receipts ABOVE the
 * no-issues line) still stands ALONE. The matcher is audit-layers' own:
 * a line it would not read as a layer receipt is prose, and prose beside
 * the receipt is the form's refusal. Fence- and blockquote-aware like the
 * gap strip — a QUOTED layer line stays, and fails the form, the safe
 * way (#9213).
 */
function stripLayerReceiptLines(finalText: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of finalText.split(/\r?\n/)) {
    const fence = /^[ \t]*(?:```|~~~)/.test(line);
    if (fence) inFence = !inFence;
    if (
      !fence &&
      !inFence &&
      !/^[ \t]*>/.test(line) &&
      LAYER_RECEIPT_LINE_RE.test(line)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Classify one auditor's return.
 *
 * `yielded` outranks everything: a return that files a finding against a
 * real file proves the territory hot, whatever else it says. `dry` requires
 * all of a structurally substantive no-issues receipt AND the tool calls
 * that make it believable — an agent that never opened the diff has an
 * opinion about lines it did not read, which is the whiff wearing a costume
 * (measured: 80 of 129 real transcripts made no tool call, and every one
 * still returned confident, specific-sounding prose) — AND the read must
 * land in the chunk's territory: a successful read of the diff's first
 * screenful proves nothing about lines a thousand down. Anything else is
 * `unknown`, which the scheduler treats as NOT dry — and `failure` names
 * the FIRST bar that fell, in the order the bars are checked, so the
 * scheduler can say why a twice-audited chunk never retired (#9206: the
 * refusal used to land in the same silent `unknown` for all of them).
 *
 * `territory` is the diff lines the record's own prompt bakes for this
 * chunk (1-based, inclusive); empty when it bakes no read, where the old
 * bar — any successful diff read — stands.
 */
function classifyReturn(
  rec: AgentRecord,
  territory: Array<[number, number]>,
  findingsList: string,
  findingsRead: boolean,
): Classification {
  // RETURNED, before anything else — the yield branch included: `finalText`
  // keeps the last non-empty assistant text, narration included, so a
  // died-mid-flight auditor's flushed narration can carry a receipt shape
  // or a quoted finding; neither is a return.
  if (!rec.returned) {
    return { outcome: 'unknown', failure: 'auditor never returned' };
  }
  const text = rec.finalText.trim();
  if (SEVERITY_LINE_RE.test(text)) {
    // The cumulative list is on hand for this agent: since #8597 it rides
    // a digest-named findings file the launch prompt points at (before, it
    // was folded into the prompt verbatim), and every entry in it is a full
    // block — File AND Severity. An auditor explaining "already covered,
    // not re-reporting" can quote one whole, and the quotation must not
    // read as a filing: an entry whose exact file line is already on the
    // list cannot be a new finding against it. Skipping costs an audit at
    // most; counting a quotation re-opens the never-retire direction on
    // the loop's most common honest return.
    for (const m of text.matchAll(FILE_LINE_RE)) {
      const file = (m[1] ?? '').trim();
      if (file === '' || /^N\/A\b/i.test(file)) continue;
      if (findingsList.includes(`**File:** ${file}`)) continue;
      return { outcome: 'yielded', failure: null };
    }
  }
  // The receipt is judged WITHOUT its budget-gap disclosure lines. Two
  // failure modes bound this from opposite sides. An auditor's admission of
  // what its soft ceiling cut short must not double as the receipt's
  // substantive clause — stripped, a return whose only substance was its
  // disclosures reads `unknown` and the chunk stays under audit. But a
  // receipt that is substantive WITHOUT them — a real walk of the
  // territory, proven by the same tool-call and territory-read bar as
  // ever, that found nothing new and separately disclosed exploration it
  // did not take — still retires: an earlier draft read any gap-bearing
  // return as `unknown`, and since a reverse auditor's ceiling is routinely
  // met (its brief orders a 65-82 KB findings list read in full), that made
  // convergence impossible and ran every budgeted loop to the round cap —
  // the exact never-retire failure this module's own docstrings warn
  // about. The gap itself is not lost: coverage reports it and Step 3D
  // rules on it; retirement certifies the audit that DID happen, not the
  // exploration that did not.
  // Re-trimmed after the strip: a disclosure line parted from the receipt
  // by a blank line leaves a leading \n, and the anchored matcher's ^ must
  // not die on the strip's own leftover whitespace (#9213).
  const judged = stripLayerReceiptLines(stripBudgetGapLines(text)).trim();
  const receipt = DRY_RECEIPT_RE.exec(judged);
  // The clause is cut at any INLINE disclosure marker before its checks
  // run: a one-line return (`No new issues found — …; Budget gap: X`)
  // slips past the line-based strip, and the clause capture would
  // otherwise absorb the gap text and get its substantiveness from it —
  // the admission doubling as the receipt again, one line lower. The
  // `Layer walked:` label fused onto the receipt's line is the same
  // absorption one marker over: the label's own "walked" passes the walk
  // test and its length the substance floor, certifying a receipt the
  // identical two-line form refuses (#9213) — cut at whichever marker
  // comes first.
  const clause = receipt?.[1] ?? '';
  const inlineGap = INLINE_BUDGET_GAP_RE.exec(clause);
  const inlineLayer = INLINE_LAYER_WALKED_RE.exec(clause);
  const cutAt = Math.min(
    inlineGap?.index ?? clause.length,
    inlineLayer?.index ?? clause.length,
  );
  const judgedClause = clause.slice(0, cutAt);
  const unknown = (failure: CertificationFailure): Classification => ({
    outcome: 'unknown',
    failure,
  });
  if (rec.successfulToolCalls === 0) return unknown('no successful tool calls');
  if (rec.diffToolCalls === 0) return unknown('no read of the diff');
  if (!openedTheTerritory(rec.diffReads, territory))
    return unknown('territory read missing');
  if (receipt === null) return unknown('receipt not matched');
  // The receipt must STAND ALONE: the form is the whole return once the
  // structured lines are stripped, so prose after the receipt's line is
  // not the form — an admission there reads exactly as one inside the
  // clause, and the anchor refuses prose BEFORE it the same way (#9213):
  // identical prose on either side of the line, identical `unknown`.
  if (judged.slice(receipt[0].length).trim() !== '')
    return unknown('receipt not alone');
  // The polarity bars, each naming itself (#9259) and each single-domain
  // (#9272 — no bar reads across the lead/clause boundary, so the split
  // cannot hide a cross-boundary run from a guard that needs it):
  //
  // The LEAD: its own phrase core is expected there — strip it and
  // marker-test the residue, so a hedge riding the filler
  // (`…found but only skimmed.`) contradicts the claim exactly as one
  // inside the clause.
  const receiptLead = receipt[0].slice(0, receipt[0].length - clause.length);
  if (NEGATION_MARKER_RE.test(receiptLead.replace(PHRASE_CORE_RE, ' ')))
    return unknown('receipt lead contradicts the phrase');
  // The CLAUSE must not restate the all-clear at all — the form's close
  // over the executed passive/reduced-passive/spliced entrance family,
  // no enumeration (#9272).
  if (CLAUSE_CORE_RE.test(judgedClause))
    return unknown('receipt clause restates the all-clear');
  if (NEGATION_MARKER_RE.test(judgedClause))
    return unknown('receipt clause contradicts the phrase');
  if (!namesTheWalk(judgedClause))
    return unknown('receipt clause names no walk');
  if (!substantiveClause(judgedClause))
    return unknown('receipt clause too thin');
  // The DRY bar only, and last: the brief's whole method is the comparison
  // against the cumulative findings list, and a no-issues receipt from an
  // auditor that never opened the list certifies a comparison nobody made.
  // A filed YIELD (above) needs no such gate — the finding proves the
  // territory hot whatever else was skipped, and gating it before
  // classification flipped a round from yielded to dry and retired a chunk
  // with a live finding.
  if (!findingsRead) return unknown('findings list unread');
  return { outcome: 'dry', failure: null };
}

/**
 * Whether any of the transcript's reads lands in the chunk's baked
 * territory. Overlap is the bar, not containment: an honest auditor pages
 * an oversized chunk, and each page overlaps the territory even though no
 * single read holds it all. A read with no line range (a `read_file` with
 * no limit) proves no lines at all and overlaps nothing.
 */
export function openedTheTerritory(
  diffReads: Array<[number, number]>,
  territory: Array<[number, number]>,
): boolean {
  if (territory.length === 0) return true;
  return diffReads.some(([s, e]) =>
    territory.some(([ts, te]) => s <= te && ts <= e),
  );
}

/**
 * One outcome for one (chunk, round), from every record and transcript that
 * spoke to it. A round can legitimately have several of both — a same-round
 * rebuild with corrected rules is a second record; a relaunch is a second
 * transcript — and the merge fails toward auditing: any yield proves the
 * territory hot, a dry needs at least one substantive receipt and no yield,
 * and an empty set proves nothing.
 */
function mergeOutcomes(outcomes: AuditOutcome[]): AuditOutcome {
  if (outcomes.includes('yielded')) return 'yielded';
  if (outcomes.includes('dry')) return 'dry';
  return 'unknown';
}

/**
 * Which chunks round `round` owes an auditor, from the audit history the
 * harness and the prompt records agree on.
 *
 * Retirement: a chunk whose two most recent audits are both `dry` is due
 * only on even rounds — one round skipped, one round cold-checked,
 * alternating on a SINGLE global parity every retired chunk shares, so
 * staggered certificates re-align and the all-retired convergence stays
 * reachable (the loop below says why the anchor is not the chunk's own
 * parity). A retired chunk whose cold check yields simply stops satisfying
 * the two-most-recent-dry rule and is due every round again; no state is
 * kept anywhere, the history IS the state.
 *
 * Narrowing (#10104): on a fix-audit round the caller passes the delta
 * territories, and from round 3 a NON-delta chunk leaves the wave after ONE
 * substantive dry audit — no alternating cold check brings it back. That is
 * the posture's deliberate recall trade ("re-launch only the chunks that
 * produced findings in the previous wave, plus the delta chunks"), and it
 * narrows the wave's WIDTH instead of lowering the round cap, because the
 * late waves are where measured fix-induced Criticals kept surfacing. The
 * failure directions are unchanged: an `unknown` outcome still reads as
 * hot, a yield still re-launches, and with no narrowing context the
 * schedule is exactly what it always was.
 *
 * Throws whatever the transcript or record readers throw
 * (`TranscriptsUnavailableError` included): the CALLER owns the fail-open,
 * because the right degradation — build every chunk — is a build decision,
 * not a schedule.
 */
export function scheduleReverseAuditRound(
  planPath: string,
  chunkIds: number[],
  round: number,
  env: NodeJS.ProcessEnv = process.env,
  diffPath?: string,
  narrowing?: { deltaChunkIds: ReadonlySet<number> } | null,
): RoundSchedule {
  // Rounds 1 and 2 establish each chunk's record; retirement needs two
  // consecutive dry audits, so nothing can retire before round 3.
  if (round < 3) {
    return {
      due: [...chunkIds],
      coldChecks: [],
      skipped: [],
      narrowed: [],
      converged: false,
      diagnostics: [],
    };
  }

  // Transcripts older than the plan belong to a previous review in the same
  // session — the same collision `coverageFromTranscripts` guards against.
  // The records take the SAME fence: nothing clears the record dir, and the
  // CI retry of a dead attempt re-runs the review at the same plan path with
  // the dead attempt's records still on disk. The retry's honest launch —
  // its findings list a superset of the dead attempt's, in the same order —
  // verbatim-contains BOTH records for a (chunk, round), so unfenced records
  // trip the injectivity guard below (two records, one transcript, neither
  // certified): fail-safe, but retirement silently off on exactly the
  // retries with the least time left. A record older than the plan is the
  // dead attempt's, and reads as absent.
  const since = statSync(planPath).mtimeMs;
  // Run-scoped: a resumed run's earlier rounds ran in a different session,
  // and their dry receipts are exactly what lets the continuation retire
  // territory instead of re-auditing it. The fence stays the plan's mtime,
  // which a resume deliberately leaves untouched.
  // `currentDirOptional`: a resumed run schedules its next round BEFORE
  // launching any current-session agent, so its own transcript dir does not
  // exist yet; without the option this throws and re-audits territory the
  // prior attempt already retired.
  const transcripts = readRunTranscripts(planPath, since, env, diffPath, {
    currentDirOptional: true,
  });
  const built = readRecordedPrompts(planPath, since);

  // The prior-round records: one per (chunk, round) prompt this CLI built.
  // Only PRIOR rounds are history — a record of the round being built is a
  // rebuild of it (a repaired delivery), not evidence about the territory.
  const recordDir = promptRecordDir(planPath);
  const findingsMemo = new Map<string, string>();
  const records: Array<{
    chunkId: number;
    round: number;
    lines: string[];
    territory: Array<[number, number]>;
    findings: string;
    pointer: string | null;
  }> = [];
  for (const [key, prompt] of built) {
    const m = RECORD_KEY_RE.exec(key);
    if (!m) continue;
    const r = Number(m[2]);
    if (r >= round) continue;
    records.push({
      chunkId: Number(m[1]),
      round: r,
      // Flattened ONCE per record, beside the once-per-transcript flatten
      // below: the pairing walk pays neither half per (record, transcript)
      // pair.
      lines: promptLines(prompt),
      territory: bakedRanges(prompt, diffPath),
      findings: findingsListFor(prompt, recordDir, findingsMemo),
      pointer: findingsPointerOf(prompt),
    });
  }

  // Which transcripts certify which record — injectively, in the direction
  // that actually bounds the shortcut: how many RECORDS each transcript
  // matches. `wasDeliveredVerbatim` allows additions, so a launch prompt
  // that verbatim-contains SEVERAL recorded prompts matches every one of
  // them: one agent handed several blocks (or a whole round concatenated)
  // is the shortcut this module exists to catch. That shortcut is ONE
  // launch, and counting transcripts per record cannot see it — the single
  // transcript is each record's unique match, so every chunk would be
  // credited the same dry receipt and the round would retire whole. So
  // invert the relation: a transcript that matches several records names
  // no territory specifically and certifies none — the failure lands where
  // every failure here lands, on the audit side. Honest launches are
  // untouched either way: the round number and each chunk's territory are
  // baked into the prompt, so one matches exactly one record, its own —
  // and several honest transcripts for one record (the mandated whiff
  // relaunch) each certify it, the multi-transcript merge `mergeOutcomes`
  // promises.
  //
  // The pairing walk is O(records × transcripts) over multi-KB prompts, on
  // the critical path before the round is admitted — so cut the transcript
  // side down to the launches that carry the role marker first (a launch
  // that could match any record contains it; see REVERSE_AUDIT_MARKER), and
  // flatten each survivor ONCE instead of once per pair (the record side is
  // already flattened once per record, above). A transcript the cut drops
  // fails the way everything here fails: it certifies nothing, and its
  // chunk stays under audit.
  const candidates = transcripts
    .filter((t) => t.launchPrompt.includes(REVERSE_AUDIT_MARKER))
    .map((t) => ({ transcript: t, flat: flattenPrompt(t.launchPrompt) }));
  const matchesByRecord = records.map((rec) =>
    candidates
      .filter((c) => deliveredVerbatimLines(c.flat, rec.lines))
      .map((c) => c.transcript),
  );
  const recordsPerTranscript = new Map<AgentRecord, number>();
  for (const matches of matchesByRecord) {
    for (const t of matches) {
      recordsPerTranscript.set(t, (recordsPerTranscript.get(t) ?? 0) + 1);
    }
  }
  // Every record's classifications AND the bar each uncertified one fell
  // at: a record no transcript matches reads `no matching transcript`; one
  // whose only matches are ambiguous launches (themselves matching several
  // records) reads `launch matched multiple records`; one a transcript
  // certifies carries the classifier's own bar. These are what the round's
  // diagnostic names when a chunk that looked certifiable never retires
  // (#9206) — the refusal is the same fail-toward-audit refusal it always
  // was, only no longer silent.
  const classificationsByRecord: Classification[][] = [];
  const failuresByRecord: CertificationFailure[][] = [];
  matchesByRecord.forEach((matches, i) => {
    const unique = matches.filter((t) => recordsPerTranscript.get(t) === 1);
    const classifications = unique.map((t) =>
      // The findings-read fact rides INTO the classification and gates only
      // the dry branch there: applied out here as a filter it also
      // suppressed filed YIELDS, flipping a round to dry and retiring a
      // chunk that had a live finding. The POINTER was extracted once from
      // the RAW prompt by the same call `findingsListFor` uses: extracting
      // again from trim-normalized lines asks the same question under a
      // different normalization, and trimming defeats the `^…$` anchors
      // that reject indented quotations.
      classifyReturn(
        t,
        records[i].territory,
        records[i].findings,
        readFindingsPointer(t, records[i].pointer),
      ),
    );
    classificationsByRecord.push(classifications);
    if (classifications.some((c) => c.outcome === 'dry')) {
      // The round's merge takes this dry; whatever else the record's
      // launches did cannot hold the chunk back from retirement.
      failuresByRecord.push([]);
      return;
    }
    const failures: CertificationFailure[] = [];
    if (matches.length === 0) failures.push('no matching transcript');
    for (let m = 0; m < matches.length - unique.length; m++) {
      failures.push('launch matched multiple records');
    }
    for (const c of classifications) {
      if (c.failure !== null) failures.push(c.failure);
    }
    failuresByRecord.push(failures);
  });

  // chunk id → prior round → every outcome that round's records produced,
  // plus the certification failures behind its unknowns. A record no
  // transcript certifies (a blank partial write, an undelivered build, an
  // ambiguous launch) contributes nothing, and its round classifies
  // `unknown`: the round was scheduled for this chunk, and nothing proves
  // it dry.
  const history = new Map<
    number,
    Map<number, { outcomes: AuditOutcome[]; failures: CertificationFailure[] }>
  >();
  records.forEach((rec, i) => {
    let byRound = history.get(rec.chunkId);
    if (!byRound) {
      byRound = new Map();
      history.set(rec.chunkId, byRound);
    }
    const entry = byRound.get(rec.round) ?? { outcomes: [], failures: [] };
    entry.outcomes.push(...classificationsByRecord[i].map((c) => c.outcome));
    entry.failures.push(...failuresByRecord[i]);
    byRound.set(rec.round, entry);
  });

  const due: number[] = [];
  const coldChecks: number[] = [];
  const skipped: RetiredChunk[] = [];
  const narrowed: Array<{ chunkId: number; dryRound: number }> = [];
  const diagnostics: string[] = [];
  for (const chunkId of chunkIds) {
    const audits = [...(history.get(chunkId)?.entries() ?? [])]
      .map(([r, entry]) => ({
        round: r,
        outcome: mergeOutcomes(entry.outcomes),
        failures: entry.failures,
      }))
      .sort((a, b) => a.round - b.round);
    // The posture narrowing, ruled before retirement so a non-delta chunk
    // never earns a cold-check slot the posture does not run: its most
    // recent audit being provably dry is the whole bar. Everything less
    // certain — no history, an unknown, a yield — falls through to the
    // ordinary rules and stays hot, the same fail-toward-auditing floor as
    // every other refusal in this file.
    if (narrowing != null && !narrowing.deltaChunkIds.has(chunkId)) {
      const latest = audits[audits.length - 1];
      if (latest !== undefined && latest.outcome === 'dry') {
        narrowed.push({ chunkId, dryRound: latest.round });
        continue;
      }
    }
    const lastTwo = audits.slice(-2);
    const retired =
      lastTwo.length === 2 && lastTwo.every((a) => a.outcome === 'dry');
    if (!retired) {
      // Hot — including a chunk with no history at all, one whose latest
      // receipt was a whiff, and one whose cold check yielded.
      due.push(chunkId);
      // The diagnostic the silent never-retire loop never printed (#9206):
      // a chunk with two audits on record that NEITHER yielded NOR retired
      // failed certification somewhere — name the bar, round by round. A
      // yield explains its own heat, and one audit is still establishing
      // its record; both stay quiet.
      const certifiable =
        lastTwo.length === 2 && lastTwo.every((a) => a.outcome !== 'yielded');
      if (certifiable) {
        const roundNotes = lastTwo
          .filter((a) => a.outcome === 'unknown')
          .map((a) => {
            const reasons = [...new Set(a.failures)];
            return (
              `round ${a.round}: ` +
              (reasons.length > 0 ? reasons.join(', ') : 'uncertified')
            );
          });
        if (roundNotes.length > 0) {
          diagnostics.push(`chunk ${chunkId} — ${roundNotes.join('; ')}`);
        }
      }
      continue;
    }
    // Cold checks land on ONE global parity — the even rounds — not on the
    // chunk's own certificate parity. Per-chunk anchors never re-align: a
    // chunk dry in rounds 2,3 (last dry round odd) beside one dry in 1,2
    // (even) cold-checks on opposite rounds forever, the all-retired
    // CONVERGED exit can never fire, and the loop always runs to the cap —
    // on exactly the staggered large-PR shape retirement exists for. A
    // certificate that completes on an odd last-dry round simply takes its
    // first cold check one round sooner; after that every retired chunk
    // skips and cold-checks together, and convergence is reachable again.
    if (round % 2 === 0) {
      due.push(chunkId);
      coldChecks.push(chunkId);
    } else {
      skipped.push({
        chunkId,
        dryRounds: [lastTwo[0].round, lastTwo[1].round],
        // The next even round — this branch only runs on odd rounds, so
        // that is always round + 1. Whether the cap allows it is the note
        // composer's question, not the schedule's: the plan's cap
        // (`reverseAuditRoundCap` in budget.ts, floored at the huge-diff
        // tier's 3) is what the admission gate enforces.
        nextColdCheck: round + 1,
      });
    }
  }

  return {
    due,
    coldChecks,
    skipped,
    narrowed,
    // An empty `chunkIds` empties `due` vacuously — nothing was ever under
    // audit, so nothing has proven itself cold. `runAllChunks` refuses a
    // chunkless plan long before scheduling, but this function is exported,
    // and convergence is an exit-5 termination rule: it must not be
    // reachable from nothing. A narrowed-out chunk does not block
    // convergence: leaving the wave is what the posture ruled for it, and
    // the note that discloses the narrowing is the record of the trade.
    converged: chunkIds.length > 0 && due.length === 0,
    diagnostics,
  };
}
