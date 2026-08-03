/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review compose-review`: deterministic event selection and body
// composition for the /review skill's Step 7 submission.
//
// This logic used to be prose — a C/S table, three event-capping overrides,
// a seven-clause body composition, and presubmit downgrade carve-outs,
// restated across four places in SKILL.md. Keeping the restatements in sync
// by hand produced five shipped bugs (four Critical), all of the same shape:
// one downstream branch not updated when an upstream rule gained a new
// state. This module is the single source of truth; the skill gathers the
// state, calls it, and uses `{event, body}` verbatim. 422 recovery is the
// same call with the updated `--comments` file — the counts are counted
// from it, never updated by hand.
//
// The model stays responsible for judgment (what is a Critical, is it
// real); this owns only the bookkeeping that follows from the counts.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  coverageFromTranscripts,
  verificationGaps,
  TranscriptsUnavailableError,
} from './lib/coverage.js';
import { shellQuotePath } from './lib/shell-quote.js';
import { gh, setGhHost } from './lib/gh.js';
import {
  isPositivePrNumber,
  hasExecutableScript,
  requiredAgents,
  reviewMode,
  type RosterPlan,
} from './lib/roster.js';
import { diffHashOf, type ScriptLintReport } from './script-lint.js';
import {
  CRITICAL_PREFIX,
  SUGGESTION_PREFIX,
  countInlineFindings,
  unmarkedComments,
  type DraftedComment,
} from './lib/inline-counts.js';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * The floor above which a zero-finding Approve is disclosed as low-signal,
 * in the plan's `srcDiffLines` — diff lines belonging to `source` files, the
 * same field the review topology is chosen from (tests, docs and generated
 * files excluded by construction). A trivial edit stays under it even
 * scattered one changed line per hunk (~8 diff lines each with context and
 * hunk header, plus 4 file-header lines), and the smallest diff the topology
 * gate calls big is 500 — so the floor sits well past the typo-fix class and
 * well before "big".
 */
export const LOW_SIGNAL_SRC_DIFF_LINES = 100;

/**
 * Reads a PR's description body, given its `owner/repo` and number. The one
 * production implementation calls `gh pr view`; the bilingual fallback uses it
 * to recover the Han signal from the live PR when the plan does not carry it.
 */
export type PrBodyFetcher = (ownerRepo: string, prNumber: string) => string;

export interface ComposeReviewInput {
  /**
   * Critical findings anchored as inline `comments` entries.
   *
   * A seam for the two CLI boundaries and the tests — NEVER a field of the
   * model-written state JSON. Both boundaries derive it from the drafted
   * comments (`compose-review --comments`, `submit`'s payload) and refuse it
   * when the JSON carries it: a count handed over beside the thing it counts
   * is a count that can disagree with it, and a dogfooded report-only run —
   * where nothing downstream recounts — moved its one Critical from
   * `bodyCriticals` to an inline comment, lost the count on the way, and this
   * function printed `Verdict: Approve` over a Critical the report listed.
   */
  criticalsInline?: number;
  /** Suggestion findings anchored inline. Same seam, same refusal. */
  suggestionsInline?: number;
  /**
   * Critical descriptions whose only copy lives in the review body — the
   * last-resort unmappable findings and 422-relocated ones. They count
   * toward `C` exactly like anchored Criticals.
   */
  bodyCriticals?: string[];
  /** Suggestions discarded as unanchorable (offline validation or 422). */
  suggestionsDiscarded?: number;
  /**
   * Existing Criticals already on the PR whose Step 6 re-check landed on
   * `cannot tell` — one line each (location + what could not be decided).
   * Not counted in `C` (the review did not confirm them), but their
   * presence forbids an approval.
   */
  cannotTellCriticals?: string[];
  /** Uncoverable chunks, e.g. `"chunk 5 (src/big.min.js)"`. */
  uncoverableChunks?: string[];
  /**
   * Dimensions nobody reviewed. A bare name (`"security"`) means its agent
   * whiffed twice and gets the standard explanation; an entry carrying its
   * own reason after an em-dash (`"issue-fidelity — linked issue #123 could
   * not be fetched"`) is rendered verbatim.
   */
  unreviewedDimensions?: string[];
  /**
   * The plan report from Step 1.
   *
   * Coverage is derived from it plus the harness's transcripts — it is not an
   * input. See the recomputation below for why a caller does not get to say
   * whether the diff was read.
   */
  planPath?: string;
  /**
   * Where to look for the harness's records. Defaults to the environment the CLI
   * exported. A test seam only — production never passes it, and a model cannot:
   * `compose-review` reads its input as JSON, and this is not serialisable into
   * anything that would change where the transcripts are found on a real run.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * How the bilingual fallback reads the live PR body when the plan carries a
   * PR identity but no `prDescriptionHasHan` (a `plan-diff` plan, or one an
   * improvising orchestrator wired in place of `fetch-pr`'s report). A test
   * seam ONLY: production leaves it undefined and the CLI reads the PR with
   * `gh pr view`. The handler **strips it from the input JSON** before use (the
   * same way it strips `env`), so a model cannot supply one — not even a
   * non-function value that would throw past the default and drop the fold. It
   * can neither force nor suppress the Chinese fold, which is the whole point of
   * keeping the signal the CLI's own.
   */
  prBodyFetcher?: PrBodyFetcher;
  /** Step 1's lightweight `pr-context` fetch failed. */
  contextUnavailable?: boolean;
  presubmit?: {
    downgradeApprove?: boolean;
    downgradeRequestChanges?: boolean;
    downgradeReasons?: string[];
  };
  /** Model id for the footer, e.g. `qwen3.7-max`. */
  modelId: string;
}

export interface ComposeReviewResult {
  event: ReviewEvent;
  body: string;
  /** The table row before caps and downgrades — for the terminal report. */
  baseEvent: ReviewEvent;
  /** Which cap states applied (empty when none). */
  cappedBy: string[];
  /** True when a presubmit flag actually changed the event. */
  downgraded: boolean;
  /**
   * What the presubmit downgrade moved the event *from*, when it moved one.
   *
   * `baseEvent` cannot answer this: it is the row before caps AND downgrades, so a
   * `REQUEST_CHANGES` that a cap already softened to `COMMENT` before the downgrade
   * ran would look the same as one the downgrade itself moved. This names the
   * transition the downgrade made, so the terminal verdict can say a Request
   * changes — a review with confirmed Criticals — was downgraded, and not let it
   * read as "Comment, nothing blocking".
   */
  downgradedFrom: 'Approve' | 'Request changes' | null;
  /**
   * The orchestrator-facing fix for each coverage/verification gap the body
   * discloses — printed to stderr by the command, never rendered into the body.
   * The body tells the PR author what the review cannot certify; this tells the
   * operator which command repairs it. Two registers, two channels.
   */
  remediation: string[];
  /**
   * Set on an APPROVE composed from zero findings over a non-trivial source
   * diff (the plan's `srcDiffLines` above `LOW_SIGNAL_SRC_DIFF_LINES`).
   * Disclosure only — the event never moves on it: the coverage gate proves
   * the agents READ the diff, not that the review had discriminating power,
   * and a dogfooded weak-model run drafted nothing from its whole roster on a
   * diff where stronger same-condition runs found a verified blocker, then
   * printed a bare confident Approve. The verdict line names the shape.
   * `agents` is the plan's required roster — all on record at APPROVE, or
   * coverage would have capped — and `srcDiffLines` the plan's own count.
   */
  lowSignal: { agents: number; srcDiffLines: number } | null;
}

function withMarker(line: string): string {
  return line.startsWith(CRITICAL_PREFIX) ? line : `${CRITICAL_PREFIX} ${line}`;
}

// The input arrives as JSON a model wrote, and the skill tells it to omit
// fields that do not apply — so absence is normal and means zero/empty. What
// must never pass is a PRESENT field of the wrong shape: `undefined + 1` is
// NaN, and NaN fails both `c >= 1` and `s >= 1`, which once turned a
// body-Critical-only input into an APPROVE that dropped the only blocker.
function toCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `compose-review: ${field} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function toStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TypeError(
      `compose-review: ${field} must be an array of strings, got ${JSON.stringify(value)}`,
    );
  }
  // A copy. The caller's array is not ours to push into, and coverage-derived
  // entries are appended to these lists — a programmatic caller that reused one
  // across two calls would find the first call's caps in the second.
  return [...(value as string[])];
}

// Booleans get the same boundary treatment as the counts: the JSON is
// model-written, and a stringified `"false"` is truthy — it once stood to
// fire the downgrade sentence on a review that was never downgraded, and to
// publish the diff-only warning on a run that fetched its context fine.
function toBool(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(
      `compose-review: ${field} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function composeReview(input: ComposeReviewInput): ComposeReviewResult {
  const criticalsInline = toCount(input.criticalsInline, 'criticalsInline');
  const suggestionsInline = toCount(
    input.suggestionsInline,
    'suggestionsInline',
  );
  const bodyCriticals = toStringList(input.bodyCriticals, 'bodyCriticals');
  const suggestionsDiscarded = toCount(
    input.suggestionsDiscarded,
    'suggestionsDiscarded',
  );
  const cannotTell = toStringList(
    input.cannotTellCriticals,
    'cannotTellCriticals',
  );
  const uncoverable = toStringList(
    input.uncoverableChunks,
    'uncoverableChunks',
  );
  const unreviewed = toStringList(
    input.unreviewedDimensions,
    'unreviewedDimensions',
  );
  // The coverage-derived disclosures, kept STRUCTURAL ({subject, reason})
  // from the site that knows the boundary — reparsing the rendered prose for
  // it was the bug. `unreviewed` above stays what the caller wrote, verbatim.
  // The `public*` fields are the body's register (`Brief.publicLabel`, a
  // path-free reason); `subject`/`reason` stay the internal keys every dedup
  // and certification check below matches on.
  const coverageEntries: Array<{
    subject: string;
    reason: string;
    publicSubject?: string;
    publicReason?: string;
    subjectZh?: string;
    reasonZh?: string;
  }> = [];
  // The fixes for the gaps above, for stderr — never for the body. The gap says
  // what the review cannot certify, to the PR author; the remediation names the
  // command that repairs it, to the orchestrator. #7012's public body was fourteen
  // lines of the second register posted to the first reader.
  const remediation: string[] = [];
  // FIX lines are commands. `<plan>` was a placeholder a reader had to notice
  // and fill; pasted literally it parses as a shell redirection. The run KNOWS
  // its plan path — substitute it, and leave only the selectors (`<id>`, `<r>`)
  // that genuinely vary per agent, resolvable from the labels alongside.
  // Shell-quoted: a workspace path containing a space would otherwise split
  // the copy-pasted repair at the space, and a bare '…' wrap broke on embedded
  // apostrophes instead. (`<plan>` stays bare — a placeholder, not a path.)
  const planRef = input.planPath ? shellQuotePath(input.planPath) : '<plan>';

  // Coverage is shown, not asserted. Whatever the caller listed by hand, the
  // report's own gaps are added to it — a run cannot approve past a chunk nobody
  // receipted or an agent that returned nothing, and it cannot do so by leaving
  // the lists empty.
  // Separate from `uncoverable`. The uncoverable renderer explains the gap as
  // "a line there exceeds the read limit", which is true of an uncoverable chunk
  // and a fabrication about a chunk nobody receipted. The public body would give
  // the author a false cause.
  const missingReceipts: number[] = [];

  // The plan's chunk→files table and the chunks somebody demonstrably read,
  // for the body renderer and the opener. Empty when no plan could be used —
  // `describeChunkGap` then counts against nothing, and the opener's
  // zero-certified test falls to the `coverage` disclosure instead.
  let plannedChunks: Array<{ id: number; files: string[] }> = [];
  let coveredChunks: number[] = [];

  // The deterministic script-lint gate. `compose-review` is the authority here:
  // it reads the report the orchestrator's `qwen review script-lint` step wrote
  // and turns it into the verdict itself, so neither the existence of a blocker
  // nor its severity depends on a model. A finding on a changed line (above
  // cosmetic `style`) is a pre-confirmed `[lint]` Critical; an uninstalled or
  // crashed checker is unreviewed scope; and — the proof it ran — a diff that
  // carries an executable script but has no readable report is itself unreviewed
  // (fail closed). The report path is derived from the plan, not the input JSON a
  // model wrote, and the plan decides whether the lint was owed.
  // The gate's own body Criticals are deterministic by PROVENANCE — `scriptLintGate`
  // ran the linter — so they never need a verifier. Track them as a SEPARATE list
  // rather than mix them into the model's criticals and subtract a COUNT: a count
  // subtraction misfires when a model claim happens to carry a `[build]`/`[test]`/
  // `[probe]` tag (filtered out before the subtract) or a gate finding's own text
  // contains one, erasing an unrelated claim's verification requirement. Identity,
  // not arithmetic, decides provenance.
  const modelBodyCriticals = [...bodyCriticals]; // input's, captured before the gate
  // Disclosed-but-non-capping notes from the gate (a deferred checker). Rendered
  // in the body on every verdict, but never fed into the cap.
  const gateDisclosed: string[] = [];
  if (input.planPath) {
    const gate = scriptLintGate(input.planPath);
    bodyCriticals.push(...gate.criticals); // render + count toward `c`, deterministic
    unreviewed.push(...gate.unreviewed);
    gateDisclosed.push(...gate.disclosed);
  }

  // The Criticals a verifier must have ruled on before this review may post them as
  // blockers. Only the MODEL's criticals are candidates — the gate's are excluded by
  // construction (they are not in `modelBodyCriticals`). Of the model's, `[build]`/
  // `[test]` (Agent 7 ran the tool) and `[probe]` (the verifier ran a probe) are
  // pre-confirmed and skip verification. `[lint]` is NOT trusted as a tag — a
  // model-written string containing it must not launder an unverified claim into a
  // blocker (that is what the gate's provenance-tracked criticals are for).
  const nonDeterministicBodyCriticals = modelBodyCriticals.filter(
    (x) => !/\[(?:build|test|probe)\]/i.test(x),
  ).length;
  const criticalsNeedingVerify =
    criticalsInline + nonDeterministicBodyCriticals;
  // Fail closed at every exit: this flag softens a Request changes below, and
  // it must end up true whenever the review posts non-deterministic Criticals
  // and CANNOT SHOW they were verified — verifier absent, transcripts
  // unreadable, or no plan to check against. "Could not show" and "was not"
  // read the same to the person the blocker would be posted at.
  let criticalsUnverified = false;

  // Coverage is NOT taken from the input. It is recomputed here, from the
  // harness's own per-agent transcripts.
  //
  // The previous shape accepted a `coverage` object inside this very JSON — a
  // document the model writes. Hardening `check-coverage` while this still
  // believed a hand-typed `{"ok": true}` would have moved the forgery one hop
  // downstream and made it *cheaper*: one object, instead of the eighteen
  // fabricated receipts it actually wrote the last time it wanted an approval.
  // A caller cannot forge what it cannot supply, so it no longer supplies this.
  //
  // What it supplies is `planPath` — a path, whose contents the CLI wrote. The
  // transcripts are found from the environment the CLI exported.
  if (!input.planPath) {
    coverageEntries.push({
      subject: 'coverage',
      reason:
        'no plan was given, so this run cannot show that any of the diff ' +
        'was read',
      subjectZh: '覆盖情况',
      reasonZh: '未提供 plan，本次运行无法证明 diff 的任何部分被读过',
    });
    criticalsUnverified = criticalsNeedingVerify >= 1;
  } else {
    try {
      const cov = coverageFromTranscripts(input.planPath, input.env);
      plannedChunks = cov.plannedChunks;
      coveredChunks = cov.coveredChunks;
      for (const id of cov.missingChunks) missingReceipts.push(id);
      for (const id of cov.uncoverableChunks) {
        // The caller may already have named this chunk, but in a richer form:
        // `chunk 5 (src/big.min.js)` vs the bare `chunk 5` here. A strict-equality
        // dedup misses that and the body reads "Not reviewed: chunk 5, chunk 5".
        // Compare by the `chunk <id>` prefix.
        const prefix = `chunk ${id}`;
        const already = uncoverable.some(
          (e) => e === prefix || e.startsWith(`${prefix} `),
        );
        if (!already) uncoverable.push(prefix);
      }
      for (const label of cov.idleAgents) {
        coverageEntries.push({
          subject: label,
          reason: 'the agent made no tool call: it read nothing',
          reasonZh: '该 agent 未发起任何工具调用：它什么都没读',
        });
      }
      if (cov.idleAgents.length > 0) {
        remediation.push(
          'idle agents: relaunch each with the same printed prompt — it already ' +
            'names the brief and the diff reads; an agent that makes no tool ' +
            'call has reviewed nothing, whatever its return says',
        );
      }
      // The defect that actually happened, named as itself. A blind agent was
      // launched with a prompt that never mentioned the diff, so it could not
      // have read it — and relaunching it would produce another agent that
      // cannot either. Do not call this a whiff; the prompt is the bug.
      // The rebuild command goes to stderr with the other remediation, not into
      // this line: the line lands in the posted body, and `qwen review
      // agent-prompt` is not something a PR author can run.
      for (const label of cov.blindAgents) {
        coverageEntries.push({
          subject: label,
          reason:
            'launched with a prompt that never named the diff file, so it ' +
            'could not have read it',
          reasonZh: '启动 prompt 从未提到 diff 文件，它不可能读过 diff',
        });
      }
      if (cov.blindAgents.length > 0) {
        remediation.push(
          'blind agents: rebuild each prompt with `"${QWEN_CODE_CLI:-qwen}" ' +
            `review agent-prompt --plan ${planRef} --chunk <id>\` (or \`--role <r>\`) ` +
            '`[--rules <rules file>]` and launch an agent with it verbatim — ' +
            'do not relaunch the old prompt; a second blind agent reads no ' +
            'more than the first',
        );
      }
      // Worked, but not on the diff. Not idle and not blind — it had the path and
      // spent its run somewhere else, which on a diff with deletions means it
      // reviewed a file the removed lines are simply not in.
      for (const label of cov.unopenedAgents) {
        coverageEntries.push({
          subject: label,
          reason:
            'pointed at diff lines it never opened: it made tool calls, but ' +
            'none of them read the diff',
          reasonZh:
            '它被指向 diff 的行却从未打开：有工具调用，但没有一次读取 diff',
        });
      }
      if (cov.unopenedAgents.length > 0) {
        remediation.push(
          'agents that never opened the diff: relaunch each with the same ' +
            'printed prompt — the prompt already names the diff and its ranges; ' +
            'the read is what proves the review happened',
        );
      }
      // The prompt was built in code and edited on the way to the agent. This caps
      // for the same reason the others do: what the agent was actually asked is not
      // what this skill's guarantees are written against.
      // `coverage.ts` already writes these self-explanatory (`… — launched with a
      // prompt that is not the one the CLI built`), so push the label as-is —
      // wrapping it in a second ` — ` clause read as one run-on sentence with two
      // dashes. Same for `missingRoles` below; `unreadBriefs` already did this.
      // rewritten, missing-role and unread-brief entries arrive structurally
      // (`cov.disclosures`, push order preserved) — their labels can carry
      // em-dashes of their own, which is why they are never reparsed here.
      coverageEntries.push(...cov.disclosures);
      if (cov.rewrittenPrompts.length > 0) {
        remediation.push(
          'rewritten launches: re-run `"${QWEN_CODE_CLI:-qwen}" review ' +
            `agent-prompt --plan ${planRef} --chunk <id>\` (or \`--role <r>\`, with ` +
            '`--file <path>` for an invariant agent) `[--rules <rules file>]` ' +
            'for each named agent and pass its output unedited — copy it, do ' +
            'not retype it. Pass --rules whenever the review loaded any, or ' +
            'the rebuilt brief silently drops the project rules',
        );
      }
      // A dimension nobody reviewed. This is exactly what `unreviewedDimensions`
      // has always meant, arrived at from the plan instead of from the orchestrator
      // noticing — which, on the run that never launched Agent 0, it did not.

      if (cov.missingRoles.length > 0) {
        remediation.push(
          'missing briefs: build every required prompt in one call — ' +
            `\`"\${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan ${planRef} ` +
            '--roster [--rules <rules file>]` — and launch one agent per block ' +
            'it prints, verbatim; `--role <n>` or `--chunk <id>` rebuilds a ' +
            'single one. Pass --rules whenever the review loaded any',
        );
      }
      // Launched, but never read the brief it was pointed at: it reviewed with no
      // dimension, no severity definitions and no project rules.

      if (cov.unreadBriefs.length > 0) {
        remediation.push(
          'unread briefs: relaunch each agent with the same printed prompt — ' +
            'the agent must OPEN the brief file the prompt names; that read ' +
            'is the receipt',
        );
      }
    } catch (err) {
      // Two different failures, and they must not wear each other's message. A
      // malformed plan is the caller's mistake and says so; missing transcripts
      // are an environment fault (a read-only HOME, a sandbox) and say *that*.
      // Both cap — a run that cannot show what it read has not shown it read
      // anything — but a reader chasing "could not read the transcripts" over a
      // plan with no `chunks[]` is chasing the wrong thing.
      const why =
        err instanceof TranscriptsUnavailableError
          ? `could not read the agents' transcripts (${err.message})`
          : `the plan could not be used (${(err as Error).message})`;
      const whyZh =
        err instanceof TranscriptsUnavailableError
          ? `无法读取 agent 的运行记录（${err.message}）`
          : `plan 无法使用（${(err as Error).message}）`;
      coverageEntries.push({
        subject: 'coverage',
        reason: `${why}, so this run cannot show that any of the diff was read`,
        subjectZh: '覆盖情况',
        reasonZh: `${whyZh}，本次运行无法证明 diff 的任何部分被读过`,
      });
    }

    // Step 4 (verify) and Step 5 (reverse audit) ran, and read their briefs?
    // `check-coverage` proves Step 3, but it runs at Step 3D — before these exist —
    // and their count is not in the plan, so its roster cannot reach them. This is
    // the floor that does, and only `compose-review` asks it, which runs at high
    // and medium effort. Reverse audit is required only at high; medium skips it by
    // design, and `verificationGaps` caps a clean medium verdict at Comment instead
    // of flagging it as missing. Verify runs at both, once the review
    // has non-deterministic findings to verify. Deterministic `[build]`/`[test]`
    // findings are pre-confirmed and skip verification by design, so they do not
    // demand a verifier — including a body Critical that carries their source tag.
    // Its own try, so a read failure here says so rather than wearing the coverage
    // message, and does not undo a coverage pass a line above it.
    try {
      const findingsToVerify =
        criticalsInline + suggestionsInline + nonDeterministicBodyCriticals;
      const verification = verificationGaps(
        input.planPath,
        { postsFindings: findingsToVerify > 0 },
        input.env,
      );
      // Structural, both languages — no boundary is recovered from rendered
      // prose (reparsing was the bug the disclosure entries already fixed).
      for (const gap of verification.gaps) {
        coverageEntries.push({
          subject: gap.subject,
          reason: gap.reason,
          subjectZh: gap.subjectZh,
          reasonZh: gap.reasonZh,
        });
      }
      remediation.push(...verification.remediation);
      criticalsUnverified =
        verification.unverifiedFindings && criticalsNeedingVerify >= 1;
    } catch (err) {
      coverageEntries.push({
        subject: 'verification',
        reason:
          `could not check that Step 4 and Step 5 ran ` +
          `(${(err as Error).message})`,
        subjectZh: '验证',
        reasonZh: `无法检查步骤 4 与步骤 5 是否运行（${(err as Error).message}）`,
      });
      // Fail closed: a verification that cannot be CHECKED is not a
      // verification that happened.
      criticalsUnverified = criticalsNeedingVerify >= 1;
    }
  }
  const contextUnavailable = toBool(
    input.contextUnavailable,
    'contextUnavailable',
  );
  const presubmitRaw: unknown = input.presubmit ?? {};
  if (typeof presubmitRaw !== 'object' || Array.isArray(presubmitRaw)) {
    throw new TypeError(
      `compose-review: presubmit must be an object, got ${JSON.stringify(presubmitRaw)}`,
    );
  }
  const presubmitObj = presubmitRaw as Record<string, unknown>;
  const downgradeApprove = toBool(
    presubmitObj['downgradeApprove'],
    'presubmit.downgradeApprove',
  );
  const downgradeRequestChanges = toBool(
    presubmitObj['downgradeRequestChanges'],
    'presubmit.downgradeRequestChanges',
  );
  const downgradeReasons = toStringList(
    presubmitObj['downgradeReasons'],
    'presubmit.downgradeReasons',
  );
  const modelId: unknown = input.modelId;
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new TypeError(
      'compose-review: modelId is required (the public footer names the reviewing model)',
    );
  }

  // `C` counts every Critical the review posts anywhere — inline or body.
  // `S` counts every *confirmed* Suggestion — anchored or discarded: the
  // verdict reflects the findings the review confirmed, not the ones that
  // anchored, so dropping every Suggestion's anchor must never upgrade the
  // event to APPROVE.
  const c = criticalsInline + bodyCriticals.length;
  const s = suggestionsInline + suggestionsDiscarded;

  const baseEvent: ReviewEvent =
    c >= 1 ? 'REQUEST_CHANGES' : s >= 1 ? 'COMMENT' : 'APPROVE';

  // Caps: states outside this run's confirmed count that forbid an
  // approval. A REQUEST_CHANGES earned by a confirmed Critical is never
  // softened by them.
  const cappedBy: string[] = [];
  if (cannotTell.length > 0) cappedBy.push('cannot-tell-existing-critical');
  if (missingReceipts.length > 0) cappedBy.push('chunk-nobody-read');
  if (uncoverable.length > 0) cappedBy.push('uncoverable-chunk');
  if (unreviewed.length + coverageEntries.length > 0) {
    cappedBy.push('unreviewed-dimension');
  }
  if (contextUnavailable) cappedBy.push('context-unavailable');
  if (criticalsUnverified) cappedBy.push('criticals-unverified');

  let event: ReviewEvent = baseEvent;
  if (event === 'APPROVE' && cappedBy.length > 0) event = 'COMMENT';
  // The ONE cap that reaches a Request changes — because it removes the
  // premise the never-soften rule stands on. "A REQUEST_CHANGES earned by a
  // confirmed Critical is never softened" presumes CONFIRMED, and this flag
  // is precisely the statement that no verifier ever ruled on the blockers.
  // The header's own principle — an unverified finding must not become a
  // public blocker (the false "leaks tokens" Critical is the exact harm) —
  // was mechanics for the Approve row only, and a real bot review shipped
  // through the gap: a CHANGES_REQUESTED on an external contributor's PR
  // (#7166) whose one Critical the body itself disclosed as unverified.
  // The findings still post, disclosed; the review just may not BLOCK on a
  // claim nobody confirmed. Manipulation check: a run that wants an Approve
  // gains nothing here (the same flag caps Approve via `unreviewed`), and a
  // run that wants to block without verifying now cannot.
  // …unless a DETERMINISTIC Critical also rides the review: a `[build]`/
  // `[test]` finding is pre-confirmed, its Request changes is earned with or
  // without a verifier, and softening it alongside its unverified sibling
  // would un-block a confirmed build failure. The unverified ones stay
  // disclosed either way.
  const deterministicBodyCriticals =
    bodyCriticals.length - nonDeterministicBodyCriticals;
  if (
    event === 'REQUEST_CHANGES' &&
    criticalsUnverified &&
    deterministicBodyCriticals === 0
  ) {
    event = 'COMMENT';
  }

  // Presubmit downgrades apply after the caps and only when the verdict
  // they name is the one on the table.
  let downgraded = false;
  let downgradedFrom: 'Approve' | 'Request changes' | null = null;
  if (event === 'APPROVE' && downgradeApprove) {
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Approve';
  } else if (
    (event === 'REQUEST_CHANGES' ||
      (baseEvent === 'REQUEST_CHANGES' && criticalsUnverified)) &&
    downgradeRequestChanges
  ) {
    // The unverified-blockers cap softened the event first, but the presubmit
    // still ruled: without this arm its reasons (self-PR, failing CI) would
    // silently vanish from the body whenever both held. The verdict line
    // keeps the unverified sentence — the more fundamental defect — and the
    // body's downgrade clause carries the presubmit reasons.
    event = 'COMMENT';
    downgraded = true;
    downgradedFrom = 'Request changes';
  }

  // A zero-finding Approve over a non-trivial source diff is disclosed, not
  // capped. Every gate above proves the agents READ the diff; none proves the
  // review could tell good code from bad, and a dogfooded weak-model run
  // drafted nothing from all of its agents on a diff where stronger runs found
  // a verified blocker — then composed a bare confident Approve. The verdict
  // stands (nothing was found, and a cap would punish every genuinely clean
  // diff), but the verdict line must say which kind of Approve this is.
  // "Non-trivial" is measured in the plan's own risk metric (`srcDiffLines`,
  // the field the topology is chosen from), so a docs-only or typo-class diff
  // keeps its bare Approve — there, finding nothing is the expected outcome.
  let lowSignal: ComposeReviewResult['lowSignal'] = null;
  if (event === 'APPROVE' && input.planPath) {
    try {
      const plan = JSON.parse(
        readFileSync(input.planPath, 'utf8'),
      ) as RosterPlan;
      const src = Number(plan.srcDiffLines ?? 0);
      if (src > LOW_SIGNAL_SRC_DIFF_LINES) {
        lowSignal = { agents: requiredAgents(plan).length, srcDiffLines: src };
      }
    } catch {
      // Unreachable on a real APPROVE — the coverage gate already read this
      // plan — and a disclosure must never take the review down.
    }
  }

  const footer = `_— ${modelId} via Qwen Code /review_`;
  // Bilingual rendering: when the plan (fetch-pr's report) says the PR
  // description contains Han characters, the posted body carries the complete
  // Chinese version collapsed under the English one — the shape this repo's
  // own PR descriptions use, decided by the plan the CLI wrote, never by the
  // caller. When the plan does not record the signal but still names the PR,
  // the switch recovers it from the live description (see `bilingualFromPlan`).
  // Fragments with no deterministic translation (model-written findings, caller
  // echoes, error interpolations) ride verbatim in both halves. The footer
  // stays outside the fold, once. A `zh === en` body has nothing translated, so
  // no empty fold is published.
  const bilingual = bilingualFromPlan(input.planPath, input.prBodyFetcher);
  const render = (parts: Bi[], sep: string): string => {
    const en = parts.map((p) => p.en).join(sep);
    if (en === '') return '';
    const zh = parts.map((p) => p.zh).join(sep);
    const text =
      bilingual && zh !== en
        ? `${en}\n\n<details>\n<summary>中文说明</summary>\n\n${zh}\n\n</details>`
        : en;
    return `${text}\n\n${footer}`;
  };

  // Clause 6 — scope nobody reviewed. Legal on COMMENT and (alongside body
  // Criticals) on REQUEST_CHANGES: the blocker must not squeeze out the
  // disclosure of what was never read.
  const notReviewedParts: Bi[] = [];
  if (missingReceipts.length > 0) {
    // One block for both channels, so an edit cannot touch the disclosure and
    // miss its repair (or vice versa) — the drift the rest of this file exists
    // to prevent.
    remediation.push(
      'chunks nobody read: build each with `"${QWEN_CODE_CLI:-qwen}" review ' +
        `agent-prompt --plan ${planRef} --chunk <id> [--rules <rules file>]\` — or ` +
        'the whole fan-out with `--roster` — and launch one agent per block, ' +
        'verbatim',
    );
    // Its own sentence, because its own cause. The clause below explains a gap
    // as a line too long to read, which is true of an *uncoverable* chunk and a
    // fabrication about one nobody receipted — the author would be told the diff
    // defeated the reader, when in fact no reader turned up.
    //
    // But a chunk whose disclosure entry already says WHY it went unread — its
    // launch never happened, or happened on a rewritten prompt — is one fact,
    // not two: "nobody read chunk 2" beside "chunk 2 — its prompt was built,
    // but no agent on record was launched with it" restates the consequence
    // next to its cause, and #7166's first post-grouping body carried
    // seventeen chunks twice exactly this way. The cap and the remediation
    // above keep the FULL list — only the posted sentence dedupes, and only
    // for subjects another sentence already explains.
    const disclosedSubjects = new Set(coverageEntries.map((e) => e.subject));
    const unexplainedReceipts = missingReceipts.filter(
      (id) => !disclosedSubjects.has(`chunk ${id}`),
    );
    if (unexplainedReceipts.length > 0) {
      const gap = describeChunkGap(unexplainedReceipts, plannedChunks);
      const pron = gap.plural ? 'them' : 'it';
      notReviewedParts.push({
        en: `Not reviewed: ${gap.phrase} — no agent reported covering ${pron}; nobody read ${pron}.`,
        zh: `未审查：${gap.phraseZh}——没有 agent 报告覆盖过这部分，也没有人读过它。`,
      });
    }
  }
  if (uncoverable.length > 0) {
    // The CLI's own entries are bare `chunk <id>` (pushed above, from the
    // report) and render through the same translation as every other chunk
    // gap; a caller's entry may already carry the file (`chunk 5
    // (src/big.min.js)`) and renders verbatim — its structure is not ours to
    // reparse.
    const bareIds: number[] = [];
    const callerNamed: string[] = [];
    for (const e of uncoverable) {
      const m = /^chunk (\d+)$/.exec(e);
      if (m) bareIds.push(Number(m[1]));
      else callerNamed.push(e);
    }
    const bareGap =
      bareIds.length > 0 ? describeChunkGap(bareIds, plannedChunks) : null;
    const shown = [...(bareGap ? [bareGap.phrase] : []), ...callerNamed];
    const shownZh = [...(bareGap ? [bareGap.phraseZh] : []), ...callerNamed];
    notReviewedParts.push({
      en: `Not reviewed: ${shown.join(', ')} — a line there exceeds the read limit.`,
      zh: `未审查：${shownZh.join('、')}——其中有一行超出单次读取上限。`,
    });
  }
  // One disclosure per subject, one sentence per cause — structurally, not by
  // reparsing prose. The first cut recovered a subject/reason boundary from
  // the rendered text (the last ` — ` segment), and a reason is free-form:
  // an invariant label carries a dash for its file, an error interpolation
  // can carry anything, and a boundary guessed wrong regroups the entries it
  // garbles. Coverage now hands the entries over as `{subject, reason}`
  // pairs; only the CALLER\'s entries are prose, and those are never parsed —
  // they are matched against known coverage subjects by prefix (exactly how
  // the chunk list above dedupes), and rendered verbatim when nothing
  // matches. A run that pasted the gate\'s own gap lines into its input
  // posted every disclosure twice — 22 clauses for 11 roles on a public PR
  // (#7188) — and the coverage-derived text wins the collision: it is the
  // evidence-bounded register this body is written in.
  const covEntries = coverageEntries;
  const callerLeft: string[] = [];
  const seenCaller = new Set<string>();
  for (const d of unreviewed) {
    if (seenCaller.has(d)) continue; // a caller pasting itself twice
    seenCaller.add(d);
    const echoesCoverage = covEntries.some(
      (e) => d === e.subject || d.startsWith(`${e.subject} — `),
    );
    if (!echoesCoverage) callerLeft.push(d);
  }
  // Bare caller names share the whiffed-agent explanation; an entry that
  // brought its own reason (after an em-dash) is rendered verbatim, its own
  // line — unparsed, ungrouped, because its structure is not ours to guess.
  const whiffedDimensions = callerLeft.filter((d) => !d.includes(' — '));
  const explainedCaller = callerLeft.filter((d) => d.includes(' — '));
  if (whiffedDimensions.length > 0) {
    notReviewedParts.push({
      en: `Not reviewed: ${whiffedDimensions.join(', ')} — the agent returned no evidence of its walk twice.`,
      zh: `未审查：${whiffedDimensions.join('、')}——该 agent 连续两次未返回任何检查过程的证据。`,
    });
  }
  for (const d of explainedCaller) {
    // Caller prose, untranslatable by construction — quoted as-is in both.
    notReviewedParts.push({
      en: `Not reviewed: ${d}.`,
      zh: `未审查：${d}。`,
    });
  }
  // Same cause, one sentence: forty-three chunks launched with rewritten
  // prompts are one failure with forty-three subjects, not forty-three
  // paragraphs — a posted body on #7166 was ninety-nine clauses over four
  // causes, the six real findings buried beneath. Grouped by the reason
  // STRING, so a reason embedding per-subject detail (an unread brief\'s own
  // path) differs per entry and keeps its own line. One subject that appears
  // under two causes keeps the FIRST — the categories push in precision
  // order, and a chunk flagged `rewritten` is also, to the roster, a
  // requirement with no verbatim launch; repeating it under the later, vaguer
  // cause would tell the author "no agent was launched" about an agent that
  // demonstrably ran.
  const seenSubjects = new Set<string>();
  const byReason = new Map<
    string,
    Array<{ subject: string; publicSubject?: string; subjectZh?: string }>
  >();
  const reasonZhOf = new Map<string, string>();
  for (const e of covEntries) {
    if (seenSubjects.has(e.subject)) continue;
    seenSubjects.add(e.subject);
    // Keyed on the reason the body will PRINT — public over internal. Two
    // unread briefs differ internally only by their brief paths; grouped on
    // those, the path-free public sentence would render once per role, which
    // is the per-subject repetition this map exists to kill.
    const key = e.publicReason ?? e.reason;
    const group = byReason.get(key) ?? [];
    group.push({
      subject: e.subject,
      publicSubject: e.publicSubject,
      subjectZh: e.subjectZh,
    });
    byReason.set(key, group);
    // One printed reason, one translation: entries sharing the printed
    // English reason share the Chinese one by construction (both derive from
    // the same source string). Entries with none fall back to the English.
    if (e.reasonZh !== undefined && !reasonZhOf.has(key)) {
      reasonZhOf.set(key, e.reasonZh);
    }
  }
  for (const [reason, entries] of byReason) {
    // Chunk subjects leave in the author's units, not the run's. `chunk 28`
    // is bookkeeping — the id selects a rebuild command on stderr, and
    // nothing on the PR page maps it to code. #7268's posted body enumerated
    // all 49 of them, unsorted, across two of these sentences; the author's
    // units are their files and, at the limit, the diff itself, which is what
    // `describeChunkGap` renders. Role subjects ride their `publicSubject`
    // (`Brief.publicLabel`) — the codename stays on stderr, where it is the
    // selector — and the partition below keys on the INTERNAL subject, so a
    // public phrase can never shadow a chunk id out of the chunk collapse.
    const chunkIds: number[] = [];
    const named: string[] = [];
    const namedZh: string[] = [];
    for (const e of entries) {
      const m = /^chunk (\d+)$/.exec(e.subject);
      if (m) chunkIds.push(Number(m[1]));
      else {
        named.push(e.publicSubject ?? e.subject);
        namedZh.push(e.subjectZh ?? e.publicSubject ?? e.subject);
      }
    }
    const gap =
      chunkIds.length > 0 ? describeChunkGap(chunkIds, plannedChunks) : null;
    const shown = [...(gap ? [gap.phrase] : []), ...named];
    const shownZh = [...(gap ? [gap.phraseZh] : []), ...namedZh];
    const reasonZh = reasonZhOf.get(reason) ?? reason;
    notReviewedParts.push({
      en: reason
        ? `Not reviewed: ${shown.join(', ')} — ${reason}.`
        : `Not reviewed: ${shown.join(', ')}.`,
      zh: reason
        ? `未审查：${shownZh.join('、')}——${reasonZh}。`
        : `未审查：${shownZh.join('、')}。`,
    });
  }

  // Clause 5 — blockers the review could neither confirm nor clear. They
  // survive every event shape: erasing one is how a review approves the
  // very thing it is asking about.
  const cannotTellBlock: Bi[] =
    cannotTell.length === 0
      ? []
      : [
          {
            en: `Unresolved, please confirm: ${cannotTell
              .map((l) => withMarker(l))
              .join(' ')}`,
            zh: `未决，请确认：${cannotTell.map((l) => withMarker(l)).join(' ')}`,
          },
        ];

  // Model-written blockers: quoted as-is in both halves.
  const bodyCriticalBlock: Bi[] = bodyCriticals
    .map((l) => withMarker(l))
    .map((l) => ({ en: l, zh: l }));

  const contextUnavailableClause: Bi = {
    en: 'Reviewed diff-only — the PR’s existing discussion could not be fetched, so this is not an approval and not a no-blockers claim.',
    zh: '仅审查了 diff——无法获取 PR 已有的讨论，因此这不构成批准，也不构成"无阻断问题"的结论。',
  };

  // A deferred checker (actionlint's embedded shell): disclosed on EVERY verdict —
  // including Approve — so the reader knows a workflow's shell was not linted, but
  // it does not cap the verdict (it is a tool limitation, not a finding or an
  // unrun-checker gap). This is the "disclosed but not capping" half.
  const deferredBlock: Bi[] = gateDisclosed.length
    ? [
        {
          en: `Not linted (tool limitation, not a blocker): ${gateDisclosed.join('; ')}.`,
          zh: `未检查（工具限制，非阻断）：${gateDisclosed.join('; ')}。`,
        },
      ]
    : [];

  if (event === 'REQUEST_CHANGES') {
    // Empty body, except the disclosures: every clause whose state holds
    // appears on every event — a confirmed blocker must not squeeze out the
    // trust warning (clause 2), an undecided existing Critical (clause 5),
    // or the unread-scope disclosure (clause 6).
    const parts = [
      ...(contextUnavailable ? [contextUnavailableClause] : []),
      ...cannotTellBlock,
      ...notReviewedParts,
      ...deferredBlock,
      ...bodyCriticalBlock,
    ];
    return {
      event,
      body: render(parts, '\n\n'),
      baseEvent,
      cappedBy,
      downgraded,
      downgradedFrom,
      remediation,
      lowSignal,
    };
  }

  if (event === 'APPROVE') {
    return {
      event,
      body: render(
        [
          { en: 'No issues found. LGTM! ✅', zh: '未发现问题。LGTM！✅' },
          ...deferredBlock,
        ],
        deferredBlock.length ? '\n\n' : ' ',
      ),
      baseEvent,
      cappedBy,
      downgraded,
      downgradedFrom,
      remediation,
      lowSignal,
    };
  }

  // COMMENT: ordered clause composition — each clause present iff its
  // condition holds, nothing else.
  const clauses: Bi[] = [];

  // 1. Downgrade sentence (only when a presubmit flag changed the event).
  if (downgraded && downgradedFrom) {
    const reasons = downgradeReasons.join('; ');
    const fromZh = downgradedFrom === 'Approve' ? '批准' : '请求修改';
    clauses.push({
      en: `⚠️ Downgraded from ${downgradedFrom} to Comment${reasons ? `: ${reasons}` : ''}.`,
      zh: `⚠️ 已从${fromZh}降级为评论${reasons ? `：${reasons}` : ''}。`,
    });
  }

  // 2. Context-unavailable clause — when present, it opens the body and no
  //    clause may certify "no blockers".
  if (contextUnavailable) {
    clauses.push(contextUnavailableClause);
  } else {
    // 3. Opener — certifying only when the review can actually certify it.
    // Certification is keyed to whether presubmit PERMITS it, not to
    // whether presubmit changed the event: a Suggestion-only review is
    // already COMMENT, so failing CI or a self-PR flips no event — but a
    // body that certifies "no blockers" over failing CI, or a self-review
    // certifying its own PR, misstates authority all the same.
    const canCertify =
      !downgraded &&
      !downgradeApprove &&
      !downgradeRequestChanges &&
      c === 0 &&
      cannotTell.length === 0 &&
      uncoverable.length === 0 &&
      unreviewed.length + coverageEntries.length === 0 &&
      // A missing receipt caps the event but was left out of certification, so a
      // body could open "Reviewed — no blockers." two lines above "nobody read
      // them." Nothing nobody read can be certified blocker-free.
      missingReceipts.length === 0;
    // The opener may not say "Reviewed." over a disclosure set that denies it.
    // #7268's posted body opened exactly that way — "Reviewed. Suggestions are
    // inline." above two sentences disclosing all 49 chunks — and the author's
    // first sentence certified the thing every following one took back. A
    // chunk counts as certified only when an agent read it AND no disclosure
    // names it: the rewritten launches on that run had demonstrably read their
    // chunks, which is why `coveredChunks` alone is not the test. The
    // `coverage` subject is the no-plan/unreadable-transcripts family — there
    // is no chunk universe to count, and what cannot be counted cannot be
    // certified.
    const disclosedChunkIds = new Set<number>();
    for (const e of coverageEntries) {
      const m = /^chunk (\d+)$/.exec(e.subject);
      if (m) disclosedChunkIds.add(Number(m[1]));
    }
    const nothingCertified =
      coverageEntries.some((e) => e.subject === 'coverage') ||
      (plannedChunks.length > 0 &&
        coveredChunks.every((id) => disclosedChunkIds.has(id)));
    clauses.push(
      nothingCertified
        ? {
            en: '⚠️ This run could not certify that any of this diff was reviewed.',
            zh: '⚠️ 本次运行无法证明这个 diff 的任何部分经过了审查。',
          }
        : canCertify
          ? { en: 'Reviewed — no blockers.', zh: '已审查——无阻断问题。' }
          : { en: 'Reviewed.', zh: '已审查。' },
    );
  }

  // 4. Suggestions clause — keyed off the POSTED count, not `s`: an
  //    all-discarded run has nothing inline, and claiming otherwise while
  //    the discarded sentence says the opposite is the round-6 collision
  //    this module exists to kill. (`s` stays right for the event — see
  //    above.)
  if (suggestionsInline > 0) {
    clauses.push({ en: 'Suggestions are inline.', zh: '建议见行内评论。' });
  }
  if (suggestionsDiscarded > 0) {
    // Self-contained: this lands in the posted body, and "see the terminal
    // output" pointed the PR author at a terminal only the operator has —
    // eight hours of real bot reviews carried that dead reference on five
    // different pull requests.
    clauses.push({
      en:
        `${suggestionsDiscarded} Suggestion-level finding(s) could not be ` +
        `anchored to a changed line and were dropped; nothing further to act ` +
        `on here.`,
      zh:
        `${suggestionsDiscarded} 条建议级发现无法锚定到改动行，已丢弃；` +
        `此处无需进一步处理。`,
    });
  }

  // 5. Unresolved existing Criticals.
  clauses.push(...cannotTellBlock);

  // 6. Not-reviewed disclosure.
  clauses.push(...notReviewedParts);

  // 6b. Deferred-checker disclosure (non-capping) — a workflow whose embedded
  //     shell actionlint would lint but we do not yet trust.
  clauses.push(...deferredBlock);

  // 7. Body Criticals — on a COMMENT that stands where a REQUEST_CHANGES
  //    would have been: the presubmit carve-out, and the unverified-blockers
  //    cap. Either way the body copy is the ONLY copy of an unanchorable
  //    blocker, and softening the event must never erase it.
  if (downgradedFrom === 'Request changes' || criticalsUnverified) {
    clauses.push(...bodyCriticalBlock);
  }

  return {
    event,
    body: render(clauses, ' '),
    baseEvent,
    cappedBy,
    downgraded,
    downgradedFrom,
    remediation,
    lowSignal,
  };
}

/**
 * A set of unreviewed chunk ids, said in the PR author's units.
 *
 * `chunk 28` is the run's own bookkeeping: the id selects a rebuild command
 * on stderr, and nothing on the PR page maps it to code. #7268's posted body
 * was two sentences enumerating all 49 of them — unsorted, because the first
 * group rode transcript order — and the one fact they carried (nothing was
 * certified) is the opener's job, not an enumeration's. The author's units
 * are their files and, at the limit, the diff itself, so the ids collapse to
 * whichever of those fits:
 *
 * - every planned chunk → `the entire diff`;
 * - a gap whose files are known and few → the files, named;
 * - anything wider (or a plan whose chunks carry no files) → a count against
 *   the plan's total.
 *
 * The ids never render. They stay in the structural entries — the caps, the
 * caller-echo dedup and the certification test all key on `chunk <id>` — and
 * in the stderr remediation, where the id is the selector a reader can act
 * on. `plural` is the phrase's grammatical number, for the one caller whose
 * sentence carries a pronoun; `phraseZh` is the same phrase for the Chinese
 * half of a bilingual body.
 */
export function describeChunkGap(
  ids: readonly number[],
  planned: ReadonlyArray<{ id: number; files: string[] }>,
): { phrase: string; phraseZh: string; plural: boolean } {
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  const inGap = new Set(uniq);
  if (planned.length > 0 && planned.every((p) => inGap.has(p.id))) {
    return { phrase: 'the entire diff', phraseZh: '整个 diff', plural: false };
  }
  // The union of the gap's files, in plan order. One unknown chunk poisons
  // the list: naming three files over a gap that also covers a fourth,
  // unnameable one would tell the author the rest of their diff was read.
  const byId = new Map(planned.map((p) => [p.id, p.files]));
  const files: string[] = [];
  let allKnown = planned.length > 0;
  for (const id of uniq) {
    const f = byId.get(id) ?? [];
    if (f.length === 0) allKnown = false;
    for (const p of f) {
      if (!files.includes(p)) files.push(p);
    }
  }
  if (allKnown && files.length <= 4) {
    return {
      phrase: `the diff ${uniq.length === 1 ? 'section' : 'sections'} covering ${files.join(', ')}`,
      phraseZh: `涉及 ${files.join('、')} 的 diff 片段`,
      plural: uniq.length > 1,
    };
  }
  return {
    phrase:
      planned.length > 0
        ? `${uniq.length} of the diff's ${planned.length} sections`
        : `${uniq.length} ${uniq.length === 1 ? 'section' : 'sections'} of the diff`,
    phraseZh:
      planned.length > 0
        ? `diff ${planned.length} 个片段中的 ${uniq.length} 个`
        : `diff 中的 ${uniq.length} 个片段`,
    plural: uniq.length > 1,
  };
}

/**
 * One body fragment, in the two languages a posted body can carry.
 *
 * `zh` renders only when `bilingualFromPlan` says the PR author writes
 * Chinese; a fragment with no deterministic translation — a model-written
 * finding, a caller echo, an interpolated error — carries the same text in
 * both, and the Chinese section quotes it as it is.
 */
interface Bi {
  en: string;
  zh: string;
}

/** The production reader: one `gh pr view` for the description body. */
const fetchPrBodyViaGh: PrBodyFetcher = (ownerRepo, prNumber) => {
  const json = gh(
    'pr',
    'view',
    prNumber,
    '--repo',
    ownerRepo,
    '--json',
    'body',
  );
  return (JSON.parse(json) as { body?: string }).body ?? '';
};

/**
 * Read the script-lint report the orchestrator wrote and turn it into verdict
 * inputs, deterministically. Returns the pre-confirmed `[lint]` Criticals (a
 * finding on a changed line, above cosmetic `style`) and the unreviewed-scope
 * entries (a checker not installed or crashed, or — owed but absent — a report
 * the run never produced). The path is DERIVED from the plan, never taken from
 * the model's input JSON, and the plan itself decides whether the lint was owed:
 * this is what takes the model out of both the block decision and the proof it ran.
 */
export function scriptLintGate(planPath: string): {
  criticals: string[];
  unreviewed: string[];
  disclosed: string[];
} {
  const criticals: string[] = [];
  const unreviewed: string[] = [];
  // Disclosed-but-NOT-capping: a `deferred` checker (actionlint) is a known tool
  // limitation, not a finding and not an unrun-checker gap — the reader is told a
  // workflow's embedded shell was not linted, but the verdict is not capped on it.
  const disclosed: string[] = [];
  let plan: {
    prNumber?: unknown;
    files?: unknown;
    diffPathAbsolute?: unknown;
  };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    // Fail CLOSED, like every other gate path: an unreadable plan means we cannot
    // tell whether the lint was owed, and "cannot tell" must not open the gate.
    unreviewed.push(
      'the executable-script lint — could not read the plan to check the gate',
    );
    return { criticals, unreviewed, disclosed };
  }
  // A diff-only (cross-repo lightweight) review has no worktree, so the
  // orchestrator could not have run script-lint — do not fail it closed for a
  // command it cannot run, exactly as the roster never owed it there.
  if (reviewMode(plan as RosterPlan) === 'diff-only') {
    return { criticals, unreviewed, disclosed };
  }
  const owed = hasExecutableScript(plan as RosterPlan);
  const reportPath = join(
    dirname(planPath),
    scriptLintReportName(plan.prNumber),
  );
  let report: ScriptLintReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptLintReport;
  } catch {
    // No report. Fail closed ONLY when the diff carried a path-detected script
    // (owed) — otherwise a diff with no scripts would be capped for a command it
    // had no reason to run.
    //
    // The one gap this leaves — a SHEBANG-only script (`hasExecutableScript` is
    // path-only, so `owed` is false for it) whose command was skipped — is closed by
    // a CONTRACT, not by this predicate: SKILL.md has the orchestrator run
    // `qwen review script-lint` on EVERY same-repo review, unconditionally. So a
    // compliant run always writes a report (even "nothing to lint"), the shebang
    // script is linted and appears in it, and it is handled below on its own
    // findings regardless of `owed`. "No report" therefore means the command did not
    // run — the `owed` cap covers the path-detectable case; the shebang case relies
    // on the always-run contract above, which is why it is stated there in prose.
    if (owed) {
      unreviewed.push(
        'the executable-script lint — `qwen review script-lint` produced no report',
      );
    }
    return { criticals, unreviewed, disclosed };
  }
  // Fail closed on a STALE report — bound to the diff's CONTENT, not a commit. The
  // report carries a hash of the diff it ran against; we re-hash the plan's current
  // diff. A mismatch means it is not this review's report: a later PR commit
  // (different diff), OR — the local case HEAD cannot see — an uncommitted edit that
  // changes the working-tree diff. An absent hash on EITHER side (the diff could not
  // be read here or there) is unverifiable and also fails closed — `!planDiffHash`
  // handles that explicitly, because `undefined !== undefined` is FALSE and would
  // otherwise accept an arbitrary hashless report. Only both sides present and equal
  // is fresh.
  const planDiffHash = diffHashOf(plan.diffPathAbsolute);
  if (!planDiffHash || report.diffHash !== planDiffHash) {
    unreviewed.push(
      'the executable-script lint — the report is stale or its diff could not be verified; re-run `qwen review script-lint`',
    );
    return { criticals, unreviewed, disclosed };
  }
  // Process the report's findings REGARDLESS of the path-only owed predicate: the
  // report can name a shebang script (`hook.sh` by its `#!`) that `pathTool` could
  // not, and returning early on the predicate would drop exactly those findings.
  for (const file of report.checked ?? []) {
    for (const f of file.findings ?? []) {
      if (f.inDiff && f.level !== 'style') {
        criticals.push(
          `${mdField(file.path)}:${f.line} ${f.code} — ${mdField(f.message)} [lint]`,
        );
      }
    }
  }
  // Each skipped entry carries its OWN reason (not installed, or an irregular file
  // like a symlink) — surface it, rather than hard-coding "not installed". A
  // deferred checker is NOT here: it is its own state, disclosed below without capping.
  for (const s of report.skipped ?? []) {
    unreviewed.push(
      `the executable-script lint — ${mdField(s.path)}: ${s.reason ?? `${s.tool} unavailable`}`,
    );
  }
  for (const e of report.errored ?? []) {
    unreviewed.push(
      `the executable-script lint — ${e.tool} errored on ${mdField(e.path)}`,
    );
  }
  // A deferred checker (actionlint) is disclosed but does not cap — the reader is
  // told the workflow's embedded shell was not linted, without making every
  // workflow PR un-Approvable on a checker we deliberately decline to run.
  for (const d of report.deferred ?? []) {
    disclosed.push(
      `the executable-script lint — ${mdField(d.path)}: ${d.reason ?? `${d.tool} deferred`}`,
    );
  }
  return { criticals, unreviewed, disclosed };
}

/**
 * Render a PR-controlled segment — a diff file path, a linter's message — safe to
 * splice into the review body we POST to GitHub. Git allows almost any byte in a
 * filename, so an unescaped path could carry `@mentions`, HTML, Markdown, or a
 * newline that forges body structure. An inline code span makes Markdown/HTML/`@`
 * inert; stripping backticks and newlines stops the value breaking out of the span
 * or forging new lines. (`capture-local`'s `display()` does the terminal-side
 * equivalent for stderr; this is the Markdown-body side.)
 */
function mdField(s: unknown): string {
  return (
    '`' +
    String(s)
      .replace(/[`\r\n]+/g, ' ')
      .trim() +
    '`'
  );
}

/**
 * The report filename the orchestrator writes and this derives — pr-numbered
 * when the plan resolved a PR, a stable local name otherwise (matching the old
 * `agent-prompt` convention so a mid-flight upgrade finds the same file).
 */
function scriptLintReportName(pr: unknown): string {
  const positive =
    (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) ||
    (typeof pr === 'string' && /^\d+$/.test(pr) && Number(pr) > 0);
  return positive
    ? `qwen-review-pr-${pr}-script-lint.json`
    : 'qwen-review-script-lint.json';
}

/**
 * Whether the posted body carries the collapsed Chinese version: the plan
 * (fetch-pr's report) recorded Han characters in the PR description. The
 * signal is the CLI's own — never the caller's, who could otherwise toggle
 * the register of a certified body. A local plan has no such field, and a
 * plan that cannot be read defaults to English-only: the language must never
 * take the review down.
 *
 * A recorded `false` is authoritative: `fetch-pr` fetched the body and found
 * no Han, so English-only is the answer and no network is spent — every
 * English-authored PR review takes this path.
 *
 * The field being *absent* is a different state, and the one that shipped an
 * English-only review over a Chinese-authored PR (#7686): `fetch-pr` always
 * writes it, but a `plan-diff` plan never does, and an orchestrator that
 * improvises the pipeline can wire `compose-review` at a plan that is not
 * `fetch-pr`'s report at all. So when the flag is missing yet the plan still
 * carries the PR's identity, recover the signal from the live PR — the real
 * description, which the caller cannot fake, so this hardens the "signal is
 * the CLI's own" property rather than loosening it. Any failure of that fetch
 * falls back to English: the language must never take the review down.
 */
function bilingualFromPlan(
  planPath: string | undefined,
  fetchPrBody: PrBodyFetcher = fetchPrBodyViaGh,
): boolean {
  if (!planPath) return false;
  let plan: {
    prDescriptionHasHan?: unknown;
    ownerRepo?: unknown;
    prNumber?: unknown;
  };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return false;
  }
  if (typeof plan?.prDescriptionHasHan === 'boolean') {
    return plan.prDescriptionHasHan;
  }
  const ownerRepo =
    typeof plan?.ownerRepo === 'string' && plan.ownerRepo
      ? plan.ownerRepo
      : undefined;
  const prNumber = isPositivePrNumber(plan?.prNumber)
    ? String(plan.prNumber)
    : undefined;
  if (!ownerRepo || !prNumber) return false;
  try {
    return /\p{Script=Han}/u.test(fetchPrBody(ownerRepo, prNumber));
  } catch {
    return false;
  }
}

interface ComposeReviewCliArgs {
  input: string | undefined;
  comments: string;
  out: string | undefined;
  /** GitHub Enterprise host — routes this command's `gh` calls via GH_HOST. */
  host?: string;
}

/**
 * The drafted inline comments, read from the file Step 6 is told to pass.
 *
 * Accepts the bare array or the full review-payload shape (`{comments: […]}`),
 * so the same file Step 7 submits can be handed over unchanged. Every entry
 * must open with a severity marker: `countInlineFindings` weighs an unmarked
 * body as nothing, and for a verdict computation "nothing" means a blocker
 * written without its marker approves the review it should have blocked.
 * Step 6 is where the draft is still cheap to fix, so it refuses here.
 */
function readDraftedComments(path: string): DraftedComment[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `compose-review: cannot read the comments file ${path}: ` +
        `${(err as Error).message}. Pass the drafted inline comments — the ` +
        `same array the review payload will carry — or a file containing [] ` +
        `when nothing anchors inline.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `compose-review: the comments file ${path} is not JSON: ${(err as Error).message}`,
    );
  }
  const comments = Array.isArray(parsed)
    ? parsed
    : (parsed as { comments?: unknown })?.comments;
  if (!Array.isArray(comments)) {
    throw new Error(
      `compose-review: the comments file ${path} must be a JSON array of ` +
        `comment objects, or a review payload with a \`comments\` array.`,
    );
  }
  const unmarked = unmarkedComments(comments as DraftedComment[]);
  if (unmarked.length > 0) {
    throw new Error(
      `compose-review: comments[${unmarked.join(', ')}] in ${path} open with ` +
        `neither ${CRITICAL_PREFIX} nor ${SUGGESTION_PREFIX}. Every inline ` +
        `comment is a finding and carries its severity first — an unmarked ` +
        `body would be counted as neither, and a blocker that weighs nothing ` +
        `approves the review it should block. Fix the draft, not the counts.`,
    );
  }
  return comments as DraftedComment[];
}

export const composeReviewCommand: CommandModule = {
  command: 'compose-review',
  describe:
    'Compute the review event and body from the drafted comments and run states (the Step 7 invariant, as code); reads the state JSON from --input or stdin',
  builder: (yargs) =>
    yargs
      .option('input', {
        type: 'string',
        describe: 'Path to the state JSON (omit to read stdin)',
      })
      .option('comments', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the drafted inline comments JSON (the review payload, or ' +
          'its bare comments array). The inline counts are counted from it, ' +
          'never typed — pass a file containing [] when nothing anchors inline.',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the {event, body} JSON to this path',
      })
      .option('host', {
        type: 'string',
        describe:
          'GitHub Enterprise host (routes gh via GH_HOST) — needed only when ' +
          'the bilingual body-language recovery has to fetch the PR description',
      }),
  handler: (argv) => {
    const { input, comments, out, host } =
      argv as unknown as ComposeReviewCliArgs;
    // Route this command's own `gh` call — the bilingual recovery's `gh pr view`
    // (see `fetchPrBodyViaGh`) — via the PR's host, exactly as fetch-pr and submit
    // do. Without it a GHE review whose plan lacks the Han flag fetches the body
    // from github.com, fails, and composes an English-only body that disagrees
    // with what `submit` (which routes by host) posts.
    setGhHost(host);
    // yargs enforces --comments on the real command line; this covers every
    // other way in (tests, programmatic calls) with the same sentence instead
    // of an ENOENT on `undefined`.
    if (!comments) {
      throw new Error(
        'compose-review: --comments is required — the inline counts are ' +
          'counted from the drafted comments file, never typed. Pass a file ' +
          'containing [] when nothing anchors inline.',
      );
    }
    const raw = readFileSync(input ?? 0, 'utf8');
    // The input is a JSON the model wrote. `env` decides where the harness
    // transcripts are read from, and it must NOT come from that JSON: a model
    // that wanted an approval could point it at a directory of transcripts it
    // fabricated, which is the whole gate reopened through one extra key. It is a
    // unit-test seam and nothing else, so it is stripped here — the real run
    // always resolves the transcripts from the environment the CLI exported.
    const parsed = JSON.parse(raw) as ComposeReviewInput;
    delete parsed.env;
    // Same reasoning for the bilingual body-language fetcher: it is a unit-test
    // seam (production reads the PR with `gh pr view`). A state JSON carrying it —
    // even a non-function value like `"suppress"` — would otherwise reach
    // `bilingualFromPlan`, be called, throw, and drop the Chinese fold through the
    // fail-safe. Stripping it here keeps the register the CLI's own, not the
    // caller's, which is the whole point of the seam.
    delete parsed.prBodyFetcher;
    // The inline counts are counted, not accepted — `submit` has refused them
    // since the count-beside-the-comments bug, and this boundary refusing them
    // too is what makes the Step 6 line and the posted verdict the same
    // computation on the same source. Silently overwriting instead would let a
    // run keep believing the number it typed.
    if (
      parsed.criticalsInline !== undefined ||
      parsed.suggestionsInline !== undefined
    ) {
      throw new Error(
        'compose-review: `criticalsInline` / `suggestionsInline` are counted ' +
          'from the --comments file, not taken from the state JSON. Remove ' +
          'them. (A dogfooded run moved its one Critical from `bodyCriticals` ' +
          'to an inline comment, dropped the count on the way, and the ' +
          'verdict line read Approve over a blocker.)',
      );
    }
    const drafted = readDraftedComments(comments);
    const result = composeReview({
      ...parsed,
      ...countInlineFindings(drafted),
    });
    // The exact terminal verdict, persisted beside the fields it is computed
    // from. `event` + `cappedBy` alone cannot reconstruct it — a presubmit
    // downgrade also depends on `downgraded`/`downgradedFrom` — and Step 8's
    // archived report copies this line rather than re-deriving a lossy one.
    const json = JSON.stringify(
      { ...result, verdictLine: verdictLine(result) },
      null,
      2,
    );
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
    // The verdict a human reads, next to the JSON a program reads.
    //
    // Step 6 prints a verdict to the terminal, and until now it *composed* one —
    // from the same prose rules this file exists to replace. So a run could skip
    // this command entirely and tell the user whatever it had concluded: dogfooded,
    // one did, and reported an Approve on a review whose coverage check had refused.
    // There is now nothing to compose. This is the sentence; print it.
    //
    // The fixes first, the verdict last. These lines are the orchestrator's copy
    // of what the body's `Not reviewed:` disclosures only describe — the body
    // names what cannot be certified for the PR author; this names the command
    // that repairs it, on the channel the author never sees.
    for (const fix of result.remediation) {
      writeStderrLine(`FIX: ${fix}`);
    }
    writeStderrLine(verdictLine(result));
  },
};

/** The terminal verdict, in the words Step 6 is told to print. */
export function verdictLine(r: ComposeReviewResult): string {
  const label: Record<ReviewEvent, string> = {
    APPROVE: 'Approve',
    REQUEST_CHANGES: 'Request changes',
    COMMENT: 'Comment',
  };
  const why: Record<string, string> = {
    'cannot-tell-existing-critical':
      'an existing blocker could not be ruled on',
    'chunk-nobody-read': 'part of the diff was never read',
    'uncoverable-chunk': 'part of the diff cannot be read at all',
    'unreviewed-dimension': 'a dimension nobody reviewed',
    'context-unavailable': "the PR's existing discussion could not be read",
  };
  let line = `Verdict: ${label[r.event]}`;
  // Why an Approve was not available — but only when one would otherwise have been.
  // A cap and a presubmit downgrade are BOTH reasons, and either can be the sole
  // one: a review with no cap state that the presubmit dropped from Approve to
  // Comment has an empty `cappedBy` and `downgraded: true`. Joining `cappedBy`
  // unconditionally then printed `an Approve was NOT available:  — downgraded …`,
  // a dangling colon over nothing. Collect the reasons first, and say the clause
  // only if there is a reason to say it.
  //
  // A coverage cap never softens a Request changes — a confirmed blocker earned
  // that, and naming a constraint that did not bind would send the reader
  // looking for an effect that is not there — so the Approve clause is gated on
  // the base having been an Approve at all. The unverified-blockers cap is the
  // one exception, because it says the confirmation never happened, and its
  // sentence must name what the reader would otherwise chase: a Comment posted
  // over visible **[Critical]** comments reads as a contradiction until the
  // line says why.
  if (
    r.baseEvent === 'REQUEST_CHANGES' &&
    r.event === 'COMMENT' &&
    r.cappedBy.includes('criticals-unverified')
  ) {
    line +=
      ' — a Request changes was NOT available: its blockers were never ' +
      'verified (they are posted, disclosed as unverified)';
  } else if (r.baseEvent === 'APPROVE' && r.event !== 'APPROVE') {
    const reasons = r.cappedBy.map((c) => why[c] ?? c);
    if (r.downgraded) reasons.push('a presubmit check failed');
    line += ` — an Approve was NOT available: ${reasons.join('; ')}`;
  } else if (r.downgradedFrom === 'Request changes') {
    // The decisive case, and the one a review caught. A presubmit downgrade can
    // move a REQUEST_CHANGES — a review with **confirmed Criticals** — down to
    // COMMENT (a self-PR, failing CI). Printed as a bare "Comment — downgraded",
    // that reads to an operator as "minor issues, nothing blocking", while the
    // review has just posted blockers inline. Say what it was.
    line +=
      ' — Request changes, downgraded to Comment by a presubmit check ' +
      '(the blockers are still posted)';
  } else if (r.downgraded) {
    // A Suggestion-only Comment the presubmit still moved: there was no Approve to
    // lose and no blocker to hide, but the event did change and the user should see
    // it did.
    line += ' — downgraded by a presubmit check';
  }
  // Not a cap and not a downgrade — the Approve stands. But a bare confident
  // Approve from a run that drafted nothing on a real diff reads as evidence
  // of quality when it is only absence of signal, so the line says which
  // Approve this is. Both numbers are the run's own: the roster the plan
  // required (all on record, or coverage would have capped) and the plan's
  // source-line count.
  if (r.event === 'APPROVE' && r.lowSignal) {
    line +=
      ` — low signal: none of the ${r.lowSignal.agents} review agents ` +
      `reported a finding on a non-trivial diff ` +
      `(${r.lowSignal.srcDiffLines} source diff lines)`;
  }
  return line;
}
