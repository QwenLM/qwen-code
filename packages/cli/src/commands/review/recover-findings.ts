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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  wasDeliveredVerbatim,
  briefPath,
} from './lib/prompt-record.js';
import { priorSessionIds } from './lib/run-ledger.js';
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
  /** Every `.findings.md` in the record dir — the model-state snapshots. */
  findingsFiles: FindingsFileEntry[];
  /** Highest round among certified reverse-audit agents, null if none. */
  latestReverseAuditRound: number | null;
  /** The budget-stop marker still standing, if any (round-cap survives). */
  budgetStop: BudgetStop | null;
  /** How many earlier sessions the run ledger names. */
  priorSessions: number;
}

const ROUND_IN_KEY_RE = /--round-(\d+)(?:--|$)/;

/**
 * Certify one transcript against one built prompt — the same bar coverage
 * holds a live launch to: the CLI-built prompt arrived verbatim, and the
 * agent demonstrably opened its brief or the diff. Prose proves nothing.
 */
function meetsBar(rec: AgentRecord, planPath: string, key: string): boolean {
  const briefNeedle = JSON.stringify(briefPath(planPath, key));
  const openedBrief = rec.successfulCallArgs.some((a) =>
    a.includes(briefNeedle),
  );
  return openedBrief || rec.diffToolCalls > 0;
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
  const plan = planRaw as { diffPathAbsolute?: unknown };
  const diffPath =
    typeof plan.diffPathAbsolute === 'string' && plan.diffPathAbsolute !== ''
      ? plan.diffPathAbsolute
      : undefined;
  const sinceMs = statSync(planPath).mtimeMs;

  const built = readRecordedPrompts(planPath);
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
  const matchesOf = new Map<AgentRecord, string[]>();
  for (const rec of records) {
    const keys: string[] = [];
    for (const [key, prompt] of built) {
      if (prompt.trim() === '') continue;
      if (wasDeliveredVerbatim(rec.launchPrompt, prompt)) keys.push(key);
    }
    matchesOf.set(rec, keys);
  }

  const recovered = new Map<string, AgentRecord>();
  for (const [rec, keys] of matchesOf) {
    if (keys.length !== 1) continue; // unmatched, or the injectivity refusal
    const key = keys[0];
    if (!meetsBar(rec, planPath, key)) continue;
    if (rec.finalText.trim() === '') continue;
    // Prefer the newest certified transcript per key — a relaunch supersedes
    // the launch it repaired.
    const existing = recovered.get(key);
    if (existing === undefined || rec.mtimeMs > existing.mtimeMs) {
      recovered.set(key, rec);
    }
  }

  const recoveredKeys = [...recovered.keys()].sort();
  const missingKeys = [...built.keys()]
    .filter((k) => built.get(k)?.trim() !== '' && !recovered.has(k))
    .sort();

  // The findings lists earlier rounds wrote — the on-disk snapshots of the
  // orchestrator's cumulative state. Enumerated from the record dir the CLI
  // owns; names decode back to keys exactly (they were percent-encoded).
  const recordDir = promptRecordDir(planPath);
  const findingsFiles: FindingsFileEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(recordDir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.findings.md')) continue;
    let key: string;
    try {
      key = decodeURIComponent(name.slice(0, -'.findings.md'.length));
    } catch {
      continue;
    }
    const m = ROUND_IN_KEY_RE.exec(key);
    findingsFiles.push({
      key,
      path: join(recordDir, name),
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
    sections.push(`## ${key}`, '', rec.finalText.trim(), '');
  }
  atomicWriteFileSync(outPath, sections.join('\n'), { noFollow: true });

  return {
    schemaVersion: 1,
    out: outPath,
    recoveredKeys,
    missingKeys,
    findingsFiles,
    latestReverseAuditRound,
    budgetStop: readBudgetStop(planPath),
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
