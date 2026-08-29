/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Hand a resumed run the interrupted attempt's agent results, from the
// harness's records — never from the orchestrator's memory of them.
//
// A review's findings normally live only in the orchestrator's context: each
// agent returns inline, and no file carries the returns. A resumed run is a
// NEW session, so that context is gone — but the harness's transcripts are
// not, and each one ends with the agent's own final text. This command pairs
// the CLI's prompt records with those transcripts (the same two-author proof
// `check-coverage` runs on) and writes the certified agents' final texts to a
// file the resumed orchestrator reads back.
//
// It is an assessment, not a gate: exit 0 with whatever could be recovered,
// and `check-coverage` remains the authority on what is still owed. The one
// hard failure is missing transcript infrastructure — a resume with no
// evidence to read should say so rather than print an empty recovery.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommandModule } from 'yargs';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  readRunTranscripts,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './lib/transcripts.js';
import {
  promptRecordDir,
  readRecordedPrompts,
  deliveredVerbatimLines,
  flattenPrompt,
  promptLines,
  findingsPointerOf,
} from './lib/prompt-record.js';
import { priorSessionIds } from './lib/run-ledger.js';
import { assignedChunk, pointedAt } from './lib/coverage.js';
import {
  chunkOfKey,
  declaresOwnUncoverable,
  openedBrief,
  readFindingsPointer,
} from './lib/certification.js';
import { readBudgetStop, type BudgetStop } from './lib/deadline.js';

interface RecoverFindingsArgs {
  plan: string;
  out: string;
}

/** One findings list a prior round left on disk, named by its record key. */
interface FindingsFileEntry {
  key: string;
  path: string;
  /** The `--round-<k>` baked into the key, when the key carries one. */
  round: number | null;
}

export interface RecoverFindingsResult {
  schemaVersion: 1;
  out: string;
  /** Keys whose agent was certified and whose final text was recovered. */
  recoveredKeys: string[];
  /** Keys the CLI built a prompt for with no certifiable transcript. */
  missingKeys: string[];
  /**
   * Every `.findings.md` in the record dir whose path a CERTIFIED
   * transcript's recorded prompt points at — the model-state snapshots.
   * The record dir is attempt-1-writable, and a planted list the mtime
   * fence admits would otherwise be relayed as the interrupted attempt's
   * own cumulative state; the pointer a certified agent was launched with
   * is the authorship corroboration, and a file it names nowhere is not
   * enumerated.
   */
  findingsFiles: FindingsFileEntry[];
  /** Highest round among certified reverse-audit agents, null if none. */
  latestReverseAuditRound: number | null;
  /** The budget-stop marker still standing, if any (round-cap survives). */
  budgetStop: BudgetStop | null;
  /** How many earlier sessions the run ledger names. */
  priorSessions: number;
  /**
   * The errno when the prompt-record directory could not be listed, else
   * null. An empty recovery and an unreadable one must not print alike: the
   * first says the interrupted attempt achieved nothing, the second says
   * this run cannot tell.
   */
  recordDirUnreadable: string | null;
}

const ROUND_IN_KEY_RE = /--round-(\d+)(?:--|$)/;

/**
 * Certify one transcript against one built prompt — the SAME bar the live
 * pipeline holds a launch to, branch for branch.
 *
 * It used to be a re-implementation, and re-implementing a bar means drifting
 * from it: five review rounds found five branches where the copy was weaker
 * than the original. The atoms now come from `lib/certification.ts` — the
 * one definition each of the chunk-scoped uncoverable veto, the
 * brief-opened floor, and the findings-pointer read — so what remains here
 * is only the composition recovery needs (the `returned` field read among
 * them).
 */
function meetsBar(
  rec: AgentRecord,
  planPath: string,
  key: string,
  builtPrompt: string,
  plan: { chunks: Array<{ id: number; startLine: number; endLine: number }> },
): boolean {
  // RETURNED first, like every certification consumer: `finalText` keeps the
  // last non-empty assistant text, which includes progress narrated between
  // tool calls, and a mid-flight-dead agent's narration must not be handed
  // to the resumed orchestrator as certified final text.
  if (!rec.returned) return false;
  // The DUTY chunk — the territory whose diff read the key demands — comes
  // from the key, with the prompt as fallback: recovery is matching a record
  // to a KEY the CLI built, which names the chunk directly.
  const chunk = chunkOfKey(key) ?? assignedChunk(rec);
  // The VETO chunk is the record's OWN assignment — `assignedChunk(rec)`,
  // exactly as both pipeline authorities key it (coverage's walk and its
  // `certifies()`). A per-chunk audit key names a chunk, but the production
  // per-chunk audit prompt carries no `chunk N of M` line, and keying the
  // veto on the KEY's chunk dropped a certified auditor whose final text
  // QUOTED its own chunk's declaration (the briefs mandate verbatim
  // quoting) — while coverage counted the same record as recovered work:
  // two authorities of one pipeline answering oppositely about one
  // transcript. `latestReverseAuditRound` regressed with the drop and the
  // resumed run restarted a round the dead attempt had completed.
  if (declaresOwnUncoverable(rec, assignedChunk(rec))) return false;
  // EVERY role opens its brief — the live walk gates `ok` on `unreadBriefs`
  // for chunk agents too: the brief carries the severity bar, the finding
  // format and the project's own rules, and a chunk agent that skipped it
  // reviewed against rules it never saw.
  if (!openedBrief(rec, planPath, key)) return false;
  if (/^chunk-\d+$/.test(key)) {
    // The chunk ROLE only — its proof of territory is the diff it opened,
    // and its prompt names no findings list. Keyed on the exact bare form:
    // `chunk !== null` also matched per-chunk VERIFY shards
    // (`verify--chunk-N--…`), certifying them on a diff read alone and
    // skipping the findings floor coverage's `deliveryOf` holds every
    // verify key to.
    return rec.diffToolCalls > 0;
  }
  // The chunk-less roles (whole-diff auditors) have no chunk floor, but the
  // live walk still holds them to the reads their OWN prompt spelled out —
  // pointed at diff lines and never opened the diff is `unopenedAgents`
  // there. Mirrored here, or a round-level auditor that opened the brief
  // and the findings list but never the diff certifies, its round counts
  // as reviewed, and the territory is never relaunched.
  const chunklessFloor =
    pointedAt(builtPrompt, plan).length === 0 || rec.diffToolCalls > 0;
  // The findings floor keys on the POINTER the recorded prompt names — not a
  // path derived from the record key, which never matches for per-chunk
  // reverse-audit keys (their findings file is keyed without the chunk).
  // Deriving from the key made the floor silently vanish for exactly those
  // auditors, and compose-time then ruled the same key `findings-unread`.
  const pointer = findingsPointerOf(builtPrompt);
  if (!readFindingsPointer(rec, pointer)) return false;
  return chunk !== null ? rec.diffToolCalls > 0 : chunklessFloor;
}

export function recoverFindings(
  args: RecoverFindingsArgs,
  env: NodeJS.ProcessEnv = process.env,
): RecoverFindingsResult {
  const planPath = args.plan;
  const outPath = resolve(args.out);
  if (outPath === resolve(planPath)) {
    throw new Error('--out must not overwrite the plan');
  }
  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read the plan report ${planPath}: ${(err as Error).message}`,
    );
  }
  const plan = planRaw as { diffPathAbsolute?: unknown; chunks?: unknown };
  const planChunks = {
    chunks: (Array.isArray(plan.chunks) ? plan.chunks : []).filter(
      (c): c is { id: number; startLine: number; endLine: number } =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { id?: unknown }).id === 'number' &&
        typeof (c as { startLine?: unknown }).startLine === 'number' &&
        typeof (c as { endLine?: unknown }).endLine === 'number',
    ),
  };
  const diffPath =
    typeof plan.diffPathAbsolute === 'string' && plan.diffPathAbsolute !== ''
      ? plan.diffPathAbsolute
      : undefined;
  const sinceMs = statSync(planPath).mtimeMs;
  // The plan mtime is this run's epoch. Nothing clears the record dir, and a
  // resume re-runs the review at the SAME plan path, so an unfenced read
  // would enumerate keys earlier runs of this PR built — `missingKeys` would
  // name obligations this run does not owe. The trusted writers here (the
  // CLI and the developer) never rewind that mtime, so the fence is a plain
  // staleness cut, not an integrity check.
  const built = readRecordedPrompts(planPath, sinceMs);
  // The current session has launched nothing yet when this runs — that is
  // the point of running it — so its missing transcript dir is the expected
  // state, not the infrastructure failure it would be for check-coverage.
  const records = readRunTranscripts(planPath, sinceMs, env, diffPath, {
    currentDirOptional: true,
  });

  // Pair each transcript with the built prompts it delivered verbatim. The
  // injectivity rule is retirement's: a transcript that matches MORE THAN ONE
  // built prompt certifies none of them — "one agent taking a stack of
  // chunks" must not resurface on the recovery path.
  // Flatten each launch once and split each built prompt once: the pairing
  // is N×M, and `wasDeliveredVerbatim` would otherwise redo both halves of
  // that work on every pair (the helper family exists for exactly this).
  const builtLines = new Map<string, string[]>();
  for (const [key, prompt] of built) {
    if (prompt.trim() === '') continue;
    builtLines.set(key, promptLines(prompt));
  }
  const matchesOf = new Map<AgentRecord, string[]>();
  for (const rec of records) {
    const launch = flattenPrompt(rec.launchPrompt);
    const keys: string[] = [];
    for (const [key, lines] of builtLines) {
      if (deliveredVerbatimLines(launch, lines)) keys.push(key);
    }
    matchesOf.set(rec, keys);
  }

  // Certified transcripts PER KEY. The injectivity rule is retirement's: a
  // transcript that matched MORE THAN ONE built prompt (one agent taking a
  // stack of chunks) certifies none of them. A legitimate relaunch can leave
  // two certified transcripts for one key; the newest by mtime is the
  // interrupted attempt's latest word, so it wins.
  const recovered = new Map<string, AgentRecord>();
  const recoveredMtime = new Map<string, number>();
  for (const [rec, keys] of matchesOf) {
    if (keys.length !== 1) continue; // unmatched, or the injectivity refusal
    const key = keys[0];
    if (!meetsBar(rec, planPath, key, built.get(key) ?? '', planChunks)) {
      continue;
    }
    if (rec.finalText.trim() === '') continue;
    const prior = recoveredMtime.get(key);
    if (prior === undefined || rec.mtimeMs > prior) {
      recovered.set(key, rec);
      recoveredMtime.set(key, rec.mtimeMs);
    }
  }

  const recoveredKeys = [...recovered.keys()].sort();
  const missingKeys = [...built.keys()]
    .filter((k) => built.get(k)?.trim() !== '' && !recovered.has(k))
    .sort();

  // The findings lists a CERTIFIED agent was actually pointed at: the
  // pointer each recovered key's recorded prompt carries. The enumeration
  // below admits only these — the record dir is attempt-1-writable, and a
  // planted `.findings.md` the mtime fence admits is exactly the foreign
  // state this corroboration keeps out.
  const corroboratedFindings = new Set<string>();
  for (const key of recoveredKeys) {
    const pointer = findingsPointerOf(built.get(key) ?? '');
    if (pointer !== null) corroboratedFindings.add(resolve(pointer));
  }

  // The findings lists earlier rounds wrote — the on-disk snapshots of the
  // orchestrator's cumulative state. Enumerated from the record dir the CLI
  // owns; names decode back to keys exactly (they were percent-encoded).
  const recordDir = promptRecordDir(planPath);
  const findingsFiles: FindingsFileEntry[] = [];
  let names: string[] = [];
  let recordDirUnreadable: string | null = null;
  try {
    names = readdirSync(recordDir).sort();
  } catch (err) {
    names = [];
    // "Could not look" and "there was nothing" print identically otherwise:
    // an empty recovery on a run whose records are unreachable would read as
    // an interrupted attempt that had simply achieved nothing.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      recordDirUnreadable = code ?? (err as Error).message;
    }
  }
  for (const name of names) {
    if (!name.endsWith('.findings.md')) continue;
    let key: string;
    try {
      key = decodeURIComponent(name.slice(0, -'.findings.md'.length));
    } catch {
      continue;
    }
    const path = join(recordDir, name);
    // lstat, never stat: a symlink is not the file it points at. `statSync`
    // would fence on the TARGET's mtime — attacker-chosen — and the read
    // the resumed orchestrator makes would follow the link out of the
    // record dir entirely, `resolve()` being lexical. Only a regular file
    // of this dir can be a findings list this run may hand on.
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // The run-epoch fence every reader here applies: nothing clears the
    // record dir, so a PREVIOUS review of the same PR leaves its rounds'
    // findings lists behind, and handing one to a resumed run would restore
    // a foreign attempt's state as this one's.
    if (st.mtimeMs < sinceMs) continue;
    // The corroborated pointer proves a certified agent was POINTED at this
    // path — the authorship link the enumeration needs. A file no certified
    // prompt names is not this run's cumulative state and is left out.
    if (!corroboratedFindings.has(resolve(path))) continue;
    const m = ROUND_IN_KEY_RE.exec(key);
    findingsFiles.push({
      key,
      path,
      round: m ? Number(m[1]) : null,
    });
  }

  let latestReverseAuditRound: number | null = null;
  for (const key of recoveredKeys) {
    if (!key.startsWith('reverse-audit')) continue;
    const m = ROUND_IN_KEY_RE.exec(key);
    if (!m) continue;
    const round = Number(m[1]);
    if (latestReverseAuditRound === null || round > latestReverseAuditRound) {
      latestReverseAuditRound = round;
    }
  }

  const sections: string[] = [
    '# Recovered agent results',
    '',
    'Written by `qwen review recover-findings` from the harness transcripts',
    "of the interrupted attempt. Each section is one certified agent's own",
    'final text, verbatim. Findings in here still owe Step 4 verification',
    'unless a findings list already carries them as verified.',
    '',
  ];
  for (const key of recoveredKeys) {
    const rec = recovered.get(key) as AgentRecord;
    // Keys embed PR file paths (the invariant agents), and git allows
    // newlines in filenames — a raw key would let a hostile path forge
    // `## ` section boundaries in the one channel this command exists to
    // keep clean. Control characters carry no finding text; a space
    // cannot forge structure.
    const header =
      // eslint-disable-next-line no-control-regex -- control chars are exactly what must not reach the markdown
      key.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
    sections.push(`## ${header}`, '', rec.finalText.trim(), '');
  }
  // The sibling with the identical --plan/--out contract does this too. The
  // recovered list can be the only surviving copy of an interrupted attempt's
  // results, and a missing parent directory turned that into a raw ENOENT
  // crash — in exactly the post-mortem context this command exists for.
  mkdirSync(dirname(outPath), { recursive: true });
  atomicWriteFileSync(outPath, sections.join('\n'), { noFollow: true });

  return {
    schemaVersion: 1,
    out: outPath,
    recoveredKeys,
    missingKeys,
    findingsFiles,
    latestReverseAuditRound,
    budgetStop: readBudgetStop(planPath),
    recordDirUnreadable,
    priorSessions: priorSessionIds(planPath, env).length,
  };
}

export const recoverFindingsCommand: CommandModule = {
  command: 'recover-findings',
  describe:
    'Recover the certified agent results of an interrupted review run from the harness transcripts, for a resumed run to read back',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'The plan report from Step 1 (fetch-pr output)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Where to write the recovered final texts (Markdown, one section per certified agent)',
      })
      .version(false),
  handler: (argv) => {
    try {
      const result = recoverFindings(argv as unknown as RecoverFindingsArgs);
      writeStdoutLine(JSON.stringify(result));
      writeStderrLine(
        `recover-findings: ${result.recoveredKeys.length} agent result(s) recovered, ` +
          `${result.missingKeys.length} still owed; wrote ${result.out}`,
      );
      if (result.recordDirUnreadable !== null) {
        writeStderrLine(
          `WARNING: the prompt-record directory could not be read ` +
            `(${result.recordDirUnreadable}); this recovery is a floor, not a ` +
            `complete account of the interrupted attempt.`,
        );
      }
    } catch (err) {
      if (err instanceof TranscriptsUnavailableError) {
        writeStderrLine(`recover-findings: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  },
};
