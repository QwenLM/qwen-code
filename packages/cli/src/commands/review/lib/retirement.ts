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
// writes can retire a chunk — a schedule the subject of the checks could edit
// is a schedule that retires whatever chunk is inconvenient to audit. Past
// that pairing, a launch is read only for what keeps a chunk under audit
// (#10136 R25-1): the blocks it names or ran, its session and when it returned,
// and — for a launch that certifies nothing — the yield it filed.
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
import { basename, resolve, sep } from 'node:path';
import { readRunTranscripts, type AgentRecord } from './transcripts.js';
import { REVERSE_AUDIT_EXAMPLE_RECEIPT } from './agent-briefs.js';
import { readFindingsPointer } from './certification.js';
import {
  INLINE_LAYER_WALKED_RE,
  LAYER_RECEIPT_LINE_RE,
} from './audit-layers.js';
import {
  deliveredVerbatimLines,
  findingsFilePath,
  findingsPointerOf,
  flattenPrompt,
  promptLines,
  promptRecordDir,
  readRecordedPrompts,
  recordedPromptPath,
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
  | 'findings list unread'
  | 'launch not paired with the record of its block'
  | 'launch named several blocks';

/** One transcript's classified return, with the failed bar when not dry. */
interface Classification {
  outcome: AuditOutcome;
  /** Defined exactly when `outcome` is `unknown`. */
  failure: CertificationFailure | null;
  /**
   * Defined exactly when `outcome` is `yielded`: the first filed finding's
   * file — the entry a later launch's findings list must carry to prove
   * the merge between them ran (#10136 R26-1's partial-merge witness).
   */
  filedFile?: string;
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
   * Chunks the fix-audit posture narrowed out of the wave (#10104): not a delta
   * territory, and the most recent LAUNCH on record is provably dry — every
   * member of every round in it certified dry. A launch is one round, except
   * the convergence pair: rounds 1 and 2 are built together against one
   * findings list, so a dry pair member cannot have seen what its partner filed
   * (#10136 R17-1, R20-2). Every earlier launch's findings entered the list
   * before the latest launch was built — the loop merges before every round
   * build — unless the latest launch ran on the very list bytes of an earlier
   * round with a member not certified dry, which says the merge never ran, or
   * unless some return on record that was not dry (a launch that certified
   * nothing, or left no record, included) does not share one stamped session
   * with every dry receipt of the latest launch — across a resume only
   * `recover-findings` could have carried it onto the list — or unless such a
   * return was written after the latest launch's first record was built, so
   * that launch's list cannot carry it. A block a launch names but did not pair
   * with — its record lost, or the delivery altered — still counts in its
   * round: named through the brief the launch points at or the rest of the
   * block it delivered, or through the brief its agent opened, which a launch
   * that paired with some record counts only for a block whose record no launch
   * paired with, and that launch then certifies nothing (#10136 R25-1). Unlike
   * a retired chunk, a narrowed one gets no alternating cold check: on a
   * critical-posture round the wave re-launches the delta territories under the
   * ordinary retirement rules and every non-delta chunk the previous waves
   * could not certify dry. The note disclosing the narrowing IS this list.
   * Empty whenever the caller passed no narrowing context.
   */
  narrowed: Array<{ chunkId: number; dryRound: number }>;
  /**
   * No chunk is due: retired chunks are between cold checks, posture-narrowed
   * chunks have left the wave (#10104 — on a fix-audit round a non-delta
   * chunk converges on its single dry launch), and the audit has converged.
   */
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
const RECORD_KEY_RE = /^reverse-audit--chunk-(\d+)--round-(\d+)--([0-9a-f]+)$/;

/**
 * Every launch the builder emits for this loop carries the literal role id —
 * the identity line and the brief path both spell it, whitespace-free, so no
 * re-wrap can hide it — and each record's own lines carry it too, so a
 * transcript that could verbatim-match any record must contain it, and so does
 * the call that opened a block's brief, whose path spells it. That makes it a
 * sound cheap cut over the transcripts before the pairing walk.
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
      return { outcome: 'yielded', failure: null, filedFile: file };
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
 * The launch a reverse-audit round was built in. Rounds 1 and 2 are the
 * convergence pair — both built, on one findings list and in one workflow,
 * before either returns (SKILL.md Step 5), whatever order a concurrency
 * limit then runs them in — so they are ONE launch, the way SKILL.md counts
 * the pair for convergence. Every later round is its own launch, built after
 * the merge of everything before it.
 */
function launchOf(round: number): number {
  return Math.max(round, CONVERGENCE_PAIR_LAST_ROUND);
}

/** The later round of the convergence pair. */
const CONVERGENCE_PAIR_LAST_ROUND = 2;

/**
 * Which chunks round `round` owes an auditor, from the audit history the
 * harness and the prompt records agree on — plus every block a launch names
 * but did not itself pair with, which can only keep a chunk under audit.
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
 * substantive dry LAUNCH — every member of it dry — and no alternating cold
 * check brings it back. That is the posture's deliberate recall trade
 * ("re-launch only the chunks that produced findings in the previous wave,
 * plus the delta chunks"), read the way SKILL.md reads "previous": the
 * convergence pair is one wave. It narrows the wave's WIDTH instead of
 * lowering the round cap, because the late waves are where measured
 * fix-induced Criticals kept surfacing. The failure directions are
 * unchanged: an `unknown` outcome still reads as hot, a yield still
 * re-launches, and with no narrowing context the schedule is exactly what
 * it always was.
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
    digest: string;
    lines: string[];
    territory: Array<[number, number]>;
    findings: string;
    pointer: string | null;
    key: string;
    /** When its block was built — birth time, else last write — for the clock. */
    builtAt: number;
  }> = [];
  for (const [key, prompt] of built) {
    const m = RECORD_KEY_RE.exec(key);
    if (!m) continue;
    const r = Number(m[2]);
    if (r >= round) continue;
    // The block's first build in this attempt, as far as the record shows.
    // `recordPrompt` rewrites a record in place, so a reprint under the same
    // key — Step 5's single-auditor repair — moves its mtime but not its birth
    // time; the earlier of the two is read, so a birth time later than the
    // last write (mtime set back) never dates a record past it. A record born
    // before the plan is a dead attempt's that this attempt wrote again, and a
    // filesystem that keeps no birth time reports 0: both date from the last
    // write. A record whose first write was lost is born at the repair that
    // wrote it. A record whose time cannot be read (a race with a cleanup)
    // reads as built before every return, so any earlier return that was not
    // dry holds its launch.
    let builtAt = -Infinity;
    try {
      const st = statSync(recordedPromptPath(planPath, key));
      builtAt =
        st.birthtimeMs >= since
          ? Math.min(st.birthtimeMs, st.mtimeMs)
          : st.mtimeMs;
    } catch {
      // Left at -Infinity.
    }
    records.push({
      chunkId: Number(m[1]),
      round: r,
      digest: m[3],
      // Flattened ONCE per record, beside the once-per-transcript flatten
      // below: the pairing walk pays neither half per (record, transcript)
      // pair.
      lines: promptLines(prompt),
      territory: bakedRanges(prompt, diffPath),
      findings: findingsListFor(prompt, recordDir, findingsMemo),
      pointer: findingsPointerOf(prompt),
      key,
      builtAt,
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
  // side down to the launches that carry the role marker first — a launch
  // that could match any record contains it, and so does a call that opened
  // a block's brief (see REVERSE_AUDIT_MARKER) — and
  // flatten each survivor ONCE instead of once per pair (the record side is
  // already flattened once per record, above). A transcript the cut drops
  // certifies nothing; if its record was lost as well, nothing here names its
  // block either — a double fault DESIGN.md lists.
  const candidates = transcripts
    .filter(
      (t) =>
        t.launchPrompt.includes(REVERSE_AUDIT_MARKER) ||
        t.successfulCallArgs.some((a) => a.includes(REVERSE_AUDIT_MARKER)),
    )
    .map((t) => ({ transcript: t, flat: flattenPrompt(t.launchPrompt) }));
  const matchesByRecord = records.map((rec) =>
    candidates
      .filter((c) => deliveredVerbatimLines(c.flat, rec.lines))
      .map((c) => c.transcript),
  );
  // Which record keys each launch paired with, and which keys it names.
  // Every launch block points its agent at the brief filed under the
  // record's own key, in this plan's record dir (`writeBrief`), so a
  // transcript names every key it was launched for whether or not the record
  // beside the brief survived. The keys are read from the flattened launch,
  // the text the pairing itself reads: a delivery the delivery check accepts —
  // a path re-wrapped at one of its spaces — names the same keys. The match
  // reads only the tail every absolute spelling of this plan's record dir
  // shares — the dir's own name, then the key, in any letter case — so a plan
  // spelled through a symlinked directory, a relative path or another case
  // (the same directory on a case-insensitive filesystem) names the same
  // keys, and a path that merely ends that way names a key too, which costs
  // an audit.
  const paired = new Map<AgentRecord, Set<string>>();
  matchesByRecord.forEach((matches, i) => {
    for (const t of matches) {
      const keys = paired.get(t) ?? new Set<string>();
      keys.add(records[i].key);
      paired.set(t, keys);
    }
  });
  const recordTail = sep + basename(recordDir) + sep;
  const briefKeyRe = (lead: string, tail: string, quote: string) =>
    new RegExp(
      `${quote}${lead}${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
        `reverse-audit--chunk-(\\d+)--round-(\\d+)--([0-9a-f]+)\\.brief\\.md${quote}`,
      'gi',
    );
  const launchedKey = briefKeyRe('', flattenPrompt(recordTail), '');
  // Two more ways a launch names a block. Its delivery may carry every line of
  // the block's record but the brief line, dropped or re-spelled on the way —
  // read against every record except those of a (chunk, round) the launch
  // paired with, since a rebuild on an empty list can differ from its
  // sibling's record in the brief line alone. And a launch that paired with no
  // record names the brief its agent opened: a call the harness recorded,
  // read as a whole JSON string value ending in that tail, the evidence
  // `openedBrief` reads. A paired launch's own record already names its
  // block, and opening a sibling's brief is not running it: for a paired
  // launch an opened brief counts only when no launch paired with its block's
  // record — lost or too partly written to pair, a dead attempt's, or of a
  // round not yet history — and then it names that block like any other, so
  // the launch certifies nothing.
  const openedKey = briefKeyRe(
    '[^"]*',
    JSON.stringify(recordTail).slice(1, -1),
    '"',
  );
  const briefless = records.map((rec) => {
    const brief = flattenPrompt(
      `${recordTail}${encodeURIComponent(rec.key)}.brief.md`,
    ).toLowerCase();
    return rec.lines.filter((l) => !l.toLowerCase().includes(brief));
  });
  const keyOf = (m: RegExpMatchArray) => ({
    chunk: Number(m[1]),
    round: Number(m[2]),
    digest: m[3],
    key: `reverse-audit--chunk-${m[1]}--round-${m[2]}--${m[3]}`,
  });
  const pairedKeys = new Set(
    records
      .filter((_, i) => matchesByRecord[i].length > 0)
      .map((rec) => rec.key),
  );
  const named = new Map<
    AgentRecord,
    Array<{ chunk: number; round: number; digest: string; key: string }>
  >();
  for (const { transcript: t, flat } of candidates) {
    const keys = [...flat.matchAll(launchedKey)].map(keyOf);
    const own = records.filter((rec) => paired.get(t)?.has(rec.key));
    records.forEach((rec, i) => {
      if (own.some((o) => o.chunkId === rec.chunkId && o.round === rec.round)) {
        return;
      }
      if (!deliveredVerbatimLines(flat, briefless[i])) return;
      const { chunkId: chunk, round: r, digest, key } = rec;
      keys.push({ chunk, round: r, digest, key });
    });
    const opened = t.successfulCallArgs.flatMap((args) =>
      [...args.matchAll(openedKey)].map(keyOf),
    );
    keys.push(
      ...(paired.has(t)
        ? opened.filter((n) => !pairedKeys.has(n.key))
        : opened),
    );
    named.set(t, keys);
  }
  // A launch certifies a record only when it pairs with that record alone
  // AND names no key but that record's. Counting paired records alone let a
  // lost record turn the shortcut this guard exists for — one agent handed
  // several blocks — back into a certificate for the block whose record
  // survived (#10136 R25-1). A launch that certifies nothing still proves
  // heat: the classification walk below counts its yield.
  const certifiesAlone = (t: AgentRecord): boolean => {
    const own = paired.get(t);
    return own?.size === 1 && (named.get(t) ?? []).every((n) => own.has(n.key));
  };
  // Launches the pairing walk could not tie to a record (#10136 R25-1). A
  // record's write and its read are both best-effort (`recordPrompt`,
  // `readRecordedPrompts`), and a fail-open build prints every chunk whatever
  // the schedule said, so a round can run — its prompt delivered, its return
  // filed — and leave no record for this walk to pair; a delivery the
  // orchestrator altered pairs with nothing either, beside a record that
  // survived. Read as absent, that launch vanished from the chunk's history:
  // a stale dry launch before it read as the latest one, and a lost cold
  // check let a retired chunk skip, and converge, over the yield it filed. So
  // every key a launch names but did not pair with, for a round before the
  // one being built, joins that round's history below — as the yield it
  // filed, or as a member that certified nothing — with its digest, its
  // session and when it returned.
  const lostLaunches: Array<{
    chunk: number;
    round: number;
    digest: string;
    session: string;
    returnedAt: number;
    yielded: boolean;
    /** The finding a yielded lost launch filed — the witness's subject. */
    filedFile?: string;
  }> = [];
  for (const [t, keys] of named) {
    for (const n of keys) {
      if (n.round >= round || paired.get(t)?.has(n.key)) continue;
      // A key whose record is on disk but older than the plan belongs to a
      // dead attempt at the same plan path, and so does a late transcript
      // naming it: the record fence reads that record as absent, not lost. A
      // retry whose rewrite of that record failed hides its own launch here,
      // which takes the dead attempt and the failed write together.
      try {
        if (statSync(recordedPromptPath(planPath, n.key)).mtimeMs < since) {
          continue;
        }
      } catch {
        // No record on disk: lost, or never written — the case read here.
      }
      // What it returned: a yield counts as one and outranks a dry sibling of
      // its round in the fold, as any yield does. Its quotation guard reads
      // the list the CLI filed under the key's own round and digest, spelled
      // as `findingsFileFor` spells it (a drift reads an empty list, which only
      // costs audits), never a pointer the delivered text could steer; a list
      // that is not on disk reads as empty, which counts a quotation as a
      // filing. Nothing it returned can certify dry: it proves no territory.
      let list = '';
      try {
        list = readFileSync(
          findingsFilePath(
            planPath,
            `reverse-audit--round-${n.round}--${n.digest}`,
          ),
          'utf8',
        );
      } catch {
        // No list on disk: every file line reads as a filing.
      }
      const lostClassification = classifyReturn(t, [], list, true);
      lostLaunches.push({
        chunk: n.chunk,
        round: n.round,
        digest: n.digest,
        session: t.recordedSession,
        returnedAt: t.mtimeMs,
        yielded: lostClassification.outcome === 'yielded',
        filedFile: lostClassification.filedFile,
      });
    }
  }
  // Every record's classifications AND the bar each uncertified one fell
  // at: a record no transcript matches reads `no matching transcript`; one
  // whose only matches cannot certify it alone reads `launch matched multiple
  // records` or `launch named several blocks`; one a transcript certifies
  // carries the classifier's own bar. These are what the round's diagnostic
  // names when a chunk that looked certifiable never retires (#9206) — the
  // refusal is the same fail-toward-audit refusal it always was, only no
  // longer silent.
  const classificationsByRecord: Classification[][] = [];
  const failuresByRecord: CertificationFailure[][] = [];
  /** The transcript of each classification, index for index. */
  const returnsByRecord: AgentRecord[][] = [];
  /** The launches that could not certify a record alone. */
  const ambiguousByRecord: AgentRecord[][] = [];
  matchesByRecord.forEach((matches, i) => {
    // The findings-read fact rides INTO the classification and gates only
    // the dry branch there: applied out here as a filter it also
    // suppressed filed YIELDS, flipping a round to dry and retiring a
    // chunk that had a live finding. The POINTER was extracted once from
    // the RAW prompt by the same call `findingsListFor` uses: extracting
    // again from trim-normalized lines asks the same question under a
    // different normalization, and trimming defeats the `^…$` anchors
    // that reject indented quotations.
    const classify = (t: AgentRecord): Classification =>
      classifyReturn(
        t,
        records[i].territory,
        records[i].findings,
        readFindingsPointer(t, records[i].pointer),
      );
    const unique = matches.filter(certifiesAlone);
    const shared = matches.filter((t) => !certifiesAlone(t));
    // A launch that certifies nothing still proves heat (#10136 R25-1): a
    // yield it filed joins this record's fold, so a dry relaunch of the same
    // record cannot decide the round over it. Anything short of a yield
    // certifies nothing.
    const heat = shared.filter((t) => classify(t).outcome === 'yielded');
    const classifications: Classification[] = [
      ...unique.map(classify),
      ...heat.map(
        (): Classification => ({ outcome: 'yielded', failure: null }),
      ),
    ];
    classificationsByRecord.push(classifications);
    returnsByRecord.push([...unique, ...heat]);
    // A launch that does not certify its record alone certifies none of the
    // records it touches. `recover-findings` refuses one that matched several
    // records the same way, so across a resume whatever it filed may never
    // reach the list: it rides as a return that was not dry.
    ambiguousByRecord.push(shared);
    if (classifications.some((c) => c.outcome === 'dry')) {
      // The record certified dry, so its failures have nothing left to
      // explain; a yield beside the dry outranks it in the fold and explains
      // its own heat.
      failuresByRecord.push([]);
      return;
    }
    const failures: CertificationFailure[] = [];
    if (matches.length === 0) failures.push('no matching transcript');
    for (const t of shared) {
      failures.push(
        (paired.get(t)?.size ?? 0) > 1
          ? 'launch matched multiple records'
          : 'launch named several blocks',
      );
    }
    for (const c of classifications) {
      if (c.failure !== null) failures.push(c.failure);
    }
    failuresByRecord.push(failures);
  });

  // chunk id → prior round → every outcome that round's records produced,
  // plus the certification failures behind its unknowns. A record with no
  // certifying transcript and no yield (a blank partial write, an undelivered
  // build, a launch that cannot certify it alone and filed nothing)
  // contributes no outcome to the fold, and a round of only such records
  // classifies `unknown`: the round was scheduled for this chunk, and nothing
  // proves it dry. The narrowing still counts such a record as an uncertified
  // member (`memberOutcomes`, `heldSessions`), and every block a launch names
  // but did not pair with joins its round too.
  const history = new Map<
    number,
    Map<
      number,
      {
        outcomes: AuditOutcome[];
        failures: CertificationFailure[];
        /** The findings-list digests this round's launches were built on. */
        digests: Set<string>;
        /**
         * The sessions of this round's returns that were not dry (a launch
         * that certified nothing, or left no record, included), and of its
         * dry receipts — the resume rule in the narrowing branch.
         */
        heldSessions: Set<string>;
        drySessions: Set<string>;
        /**
         * When this round's first record was built, and when its latest
         * return that was not dry was written — the clock in the narrowing
         * branch.
         */
        builtAt: number;
        heldReturnedAt: number;
        /**
         * One outcome per audit MEMBER of the round. The round-level fold
         * above hides these — `mergeOutcomes` folds `['unknown', 'dry']` to
         * `'dry'` — and the narrowing branch needs them: a launch holding one
         * dry receipt beside an uncertified sibling is not a launch that
         * certified the territory (#10136 R20-2). A record with no
         * certifying transcript and no yield is a member too — it names no
         * outcome of its own, and the round was still scheduled for it.
         */
        memberOutcomes: AuditOutcome[];
        /**
         * The filed files of this round's yielded members — the lines a
         * later launch's list must carry (#10136 R26-1).
         */
        filedFiles: Set<string>;
      }
    >
  >();
  const entryFor = (chunkId: number, r: number) => {
    let byRound = history.get(chunkId);
    if (!byRound) {
      byRound = new Map();
      history.set(chunkId, byRound);
    }
    let entry = byRound.get(r);
    if (!entry) {
      entry = {
        outcomes: [],
        failures: [],
        digests: new Set<string>(),
        heldSessions: new Set<string>(),
        drySessions: new Set<string>(),
        builtAt: Infinity,
        heldReturnedAt: -Infinity,
        memberOutcomes: [],
        filedFiles: new Set<string>(),
      };
      byRound.set(r, entry);
    }
    return entry;
  };
  records.forEach((rec, i) => {
    const entry = entryFor(rec.chunkId, rec.round);
    entry.outcomes.push(...classificationsByRecord[i].map((c) => c.outcome));
    entry.failures.push(...failuresByRecord[i]);
    for (const c of classificationsByRecord[i]) {
      if (c.filedFile !== undefined) entry.filedFiles.add(c.filedFile);
    }
    if (classificationsByRecord[i].length === 0) {
      // A record with no certifying transcript and no yield: nothing proves
      // it dry, and the round was scheduled for it — an uncertified member,
      // not an absent one. `outcomes` is left alone, so the round's fold is
      // unchanged by it; the narrowing reads the member.
      entry.memberOutcomes.push('unknown');
    } else {
      entry.memberOutcomes.push(
        ...classificationsByRecord[i].map((c) => c.outcome),
      );
    }
    entry.digests.add(rec.digest);
    entry.builtAt = Math.min(entry.builtAt, rec.builtAt);
    const hold = (t: AgentRecord) => {
      entry.heldSessions.add(t.recordedSession);
      entry.heldReturnedAt = Math.max(entry.heldReturnedAt, t.mtimeMs);
    };
    classificationsByRecord[i].forEach((c, j) => {
      const t = returnsByRecord[i][j];
      if (c.outcome === 'dry') entry.drySessions.add(t.recordedSession);
      else hold(t);
    });
    ambiguousByRecord[i].forEach(hold);
    // …and it is a member of the round that certified nothing: beside a dry
    // relaunch of the same record it may still carry a filing that never
    // merged, so the launch it belongs to is not dry in every member. (A
    // record with no classification already counts as one `unknown` above.)
    if (
      ambiguousByRecord[i].length > 0 &&
      classificationsByRecord[i].length > 0
    ) {
      entry.memberOutcomes.push('unknown');
    }
  });
  // …and every block a launch names but did not pair with, a member of that
  // block's round (#10136 R25-1): a yield joins the fold as any yield does, and
  // a launch that filed nothing adds no outcome but names its failure.
  for (const lost of lostLaunches) {
    const entry = entryFor(lost.chunk, lost.round);
    if (lost.yielded) entry.outcomes.push('yielded');
    else entry.failures.push('launch not paired with the record of its block');
    entry.memberOutcomes.push(lost.yielded ? 'yielded' : 'unknown');
    if (lost.filedFile !== undefined) entry.filedFiles.add(lost.filedFile);
    entry.digests.add(lost.digest);
    entry.heldSessions.add(lost.session);
    entry.heldReturnedAt = Math.max(entry.heldReturnedAt, lost.returnedAt);
  }

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
        digests: [...entry.digests],
        heldSessions: [...entry.heldSessions],
        drySessions: [...entry.drySessions],
        builtAt: entry.builtAt,
        heldReturnedAt: entry.heldReturnedAt,
        memberOutcomes: entry.memberOutcomes,
        filedFiles: [...entry.filedFiles],
      }))
      .sort((a, b) => a.round - b.round);
    // The posture narrowing, ruled before retirement so a non-delta chunk
    // never earns a cold-check slot the posture does not run.
    //
    // The bar is ORDER, never the findings list's rendering (#10136 R20-3).
    // One dry receipt prices a chunk out only when it cannot have been built
    // before an earlier yield's or uncertified receipt's findings entered the
    // cumulative list, and the loop fixes that order itself: findings merge
    // unconditionally before every round build, and the one exception is the
    // convergence pair, whose two rounds are built together against one list
    // (SKILL.md Step 5). So the unit is the LAUNCH. A dry receipt counts only
    // when every member of its launch is dry — a dry pair member beside a
    // yielding or uncertified partner, or a dry relaunch beside its round's
    // uncertified sibling, was built before what they filed (#10136 R17-1,
    // R20-2) — and every non-dry return of an earlier launch that came back
    // before the dry launch was built is, by that order, already on the list
    // it was built against.
    //
    // Eight review rounds of reading the list instead — its entry set, the
    // locations a return filed, the quotation a return made — each found a
    // rendering (a re-wrapped list, a range, an aggregate, a `./` prefix, a
    // second finding at one location) where a misreading GRANTED the
    // narrowing. Order has no rendering. The one list fact kept is exact
    // bytes: an earlier round with a member not certified dry, whose findings
    // digest is also one of the dry launch's, says the merge between them
    // never ran, and it only ever keeps the chunk in the wave. So does the
    // clock below, for a return that came back after the dry launch was
    // built.
    //
    // The order is the LIVE orchestrator's, though: it merges the returns it
    // received. A resumed session receives the interrupted attempt's returns
    // only through `recover-findings`, whose bar (brief opened, findings list
    // read, diff read) is stricter than this module's scan — so every return
    // on record that was not dry (a yield, or an `unknown` that may carry a
    // filing the quotation guard refused) must share ONE stamped session with
    // every dry receipt of the latest launch, or it holds the narrowing. The
    // session boundary is exact; a second copy of recovery's bar here would
    // be one more re-implementation to drift.
    if (narrowing != null && !narrowing.deltaChunkIds.has(chunkId)) {
      const latest = audits[audits.length - 1];
      if (latest !== undefined && latest.outcome === 'dry') {
        const launch = launchOf(latest.round);
        const members = audits.filter((a) => launchOf(a.round) === launch);
        const launchDry = members.every((a) =>
          a.memberOutcomes.every((o) => o === 'dry'),
        );
        const unmerged = audits.some(
          (a) =>
            launchOf(a.round) < launch &&
            // Member-level, like the launch bar: a round folded dry beside an
            // uncertified member may still hold a filing that never merged.
            // A round dry in every member changes nothing on the list, so
            // sharing its bytes is the ordinary case, not a skipped merge.
            a.memberOutcomes.some((o) => o !== 'dry') &&
            a.digests.some((d) => members.some((m) => m.digests.includes(d))),
        );
        const launchSessions = new Set(members.flatMap((m) => m.drySessions));
        // When any return on record was not dry, it and every dry receipt of
        // the latest launch must share ONE stamped session: a launch whose
        // dry receipts span two sessions, or a return no session stamped,
        // cannot show that the live merge covered it. An all-dry history
        // filed nothing and needs no merge.
        // Every round, not only earlier launches: a return inside the latest
        // launch that was not dry already fails `launchDry`.
        const acrossResume = audits.some((a) =>
          a.heldSessions.some(
            (s) => s === '' || [...launchSessions].some((d) => d !== s),
          ),
        );
        // The clock tells the same order from the other side: a return that
        // was not dry, written after the latest launch's first record was
        // built, cannot be on the list that launch was built against — a
        // block of an earlier round launched again inside a later wave pairs
        // with its own old record, on a digest the dry launch does not share.
        const launchBuiltAt = Math.min(...members.map((m) => m.builtAt));
        const lateReturn = audits.some(
          (a) => launchOf(a.round) < launch && a.heldReturnedAt > launchBuiltAt,
        );
        // The partial-merge witness (#10136 R26-1) — refusal only, never a
        // grant. `unmerged`'s byte comparison detects a TOTAL merge skip; a
        // partial one (the live orchestrator merged some of a round's
        // returns and dropped one) always changes the bytes, so the
        // tripwire stays false and the narrowing would be granted over a
        // finding that never reached any list. The merge is a prose
        // instruction to the model (SKILL.md Step 5), not a mechanism, so
        // prove it on the one artifact the merge wrote: the findings file
        // the dry launch was built from. For each earlier round with a
        // yielded member, the list a member of this launch was built from
        // — read from the file the CLI filed under that launch's own round
        // and digest, the same call the lost-launch path makes, never a
        // pointer a delivered text could steer — must carry the yield's
        // filed `**File:**` line (the membership test `classifyReturn`
        // already applies). A misreading can only refuse, which is the
        // direction this module states for itself; a file absent from disk
        // is no evidence either way, so the check skips it and today's
        // rules stand.
        const launchLists: string[] = [];
        for (const m of members) {
          for (const d of m.digests) {
            try {
              launchLists.push(
                readFileSync(
                  findingsFilePath(
                    planPath,
                    `reverse-audit--round-${m.round}--${d}`,
                  ),
                  'utf8',
                ),
              );
            } catch {
              // Not on disk: no evidence either way.
            }
          }
        }
        const partialMerge =
          launchLists.length > 0 &&
          audits.some(
            (a) =>
              launchOf(a.round) < launch &&
              a.filedFiles.some((f) =>
                launchLists.some((l) => !l.includes(`**File:** ${f}`)),
              ),
          );
        if (
          launchDry &&
          !unmerged &&
          !acrossResume &&
          !lateReturn &&
          !partialMerge
        ) {
          narrowed.push({ chunkId, dryRound: latest.round });
          continue;
        }
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
