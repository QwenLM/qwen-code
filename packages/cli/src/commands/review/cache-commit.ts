/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review cache-commit`: promote a capture's cache candidate into
// `.qwen/review-cache/`, merged with the round's model-written ledger.
//
// The cache used to be hand-written by the model from a JSON template, which
// was fine while it held six scalar fields and a findings list. The content
// anchors changed that: a candidate now carries a per-file map — a hundred
// blob pairs on a real PR — and routing that through model output is a copy
// job models get wrong in ways nobody sees (a dropped entry reads exactly
// like a file that was never captured, and the next round silently
// full-reviews or — worse — trusts a pair that was mangled in transit).
//
// So the merge is mechanical. The candidate (deterministic, written by
// `fetch-pr` or `capture-local` at capture time) provides the anchor fields;
// the ledger file (small, model-written under Step 8's prose rules) provides
// the round's verdict and findings; this command validates both and writes
// the union atomically. Precedence is the security posture: the candidate's
// fields WIN on any key collision, so a ledger cannot overwrite the anchor it
// rides beside — a mis-copied `lastCommitSha` was exactly the class of defect
// the hand-written template invited.
//
// WHETHER to promote stays the model's call, exactly as before: Step 8's
// fail-closed and effort gates decide whether this command runs at all. What
// stops being the model's call is the bytes.

import type { CommandModule } from 'yargs';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { inertText } from './lib/inert-text.js';

interface CacheCommitArgs {
  candidate: string;
  ledger: string;
  out: string;
}

function readJsonObject(path: string, what: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `cache-commit: cannot read ${what} at ${inertText(path)}: ` +
        // A JSON.parse failure embeds a snippet of the offending bytes,
        // control characters included, and this error reaches the terminal
        // through the CLI's raw stderr write.
        inertText((err as Error).message),
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `cache-commit: ${what} at ${inertText(path)} is not a JSON object`,
    );
  }
  return raw as Record<string, unknown>;
}

/** The candidate-owned fields — the ONLY keys a candidate may contribute.
 *  Everything else in a candidate file is ignored: an allowlist, so a
 *  tampered candidate cannot smuggle `round`, `verdict` or `findings` past
 *  the ledger, exactly as the ledger cannot overwrite the anchor. */
const CANDIDATE_FIELDS = [
  'v',
  'target',
  'headSha',
  'files',
  'stateId',
  'lastCommitSha',
  'mergeBaseSha',
  'fileVerdicts',
] as const;

/**
 * Refuse a write whose PARENT CHAIN is redirected.
 *
 * `noFollow` protects the final path element only. The threat this command
 * polices — a contributor branch committing a symlink at a deterministic
 * in-repo path — is satisfied one layer up just as well: plant
 * `.qwen/review-cache` itself as a link (gitignore does not stop `git add
 * -f`), and `mkdirSync(…, {recursive:true})` succeeds through it while the
 * atomic tmp+rename lands the merged cache in the attacker's directory,
 * over whatever file of that name lives there. Comparing the resolved
 * parent against its lexical form catches a link ANYWHERE in the chain,
 * which is what the final-element guard cannot do.
 */
function assertUnredirectedParent(target: string, what: string): void {
  const parent = resolve(dirname(target));
  let real: string;
  try {
    real = realpathSync(parent);
  } catch (err) {
    throw new Error(
      `cache-commit: cannot resolve the ${what} directory ${inertText(parent)}: ` +
        inertText((err as Error).message),
    );
  }
  if (real !== parent) {
    throw new Error(
      `cache-commit: the ${what} directory ${inertText(parent)} resolves to ` +
        `${inertText(real)} — a symlink in the path would redirect this ` +
        `write outside the tree it names. Refusing.`,
    );
  }
}

function runCacheCommit(args: CacheCommitArgs): void {
  const candidate = readJsonObject(args.candidate, 'the cache candidate');
  const ledger = readJsonObject(args.ledger, 'the round ledger');

  // The two fields every incremental check reads are non-negotiable: a cache
  // without a model has no same-model contract to enforce, and Step 1 would
  // fail-open it into a full review forever; better to refuse loudly now.
  const ledgerModel = ledger['lastModelId'];
  if (typeof ledgerModel !== 'string' || ledgerModel === '') {
    throw new Error(
      'cache-commit: the ledger must carry a non-empty `lastModelId` — the ' +
        'incremental anchor is a same-model contract.',
    );
  }
  // The promoted cache is read back by commands that print these values on a
  // refusal, and the next round hands `lastCommitSha` to git as an argument;
  // a control-charactered value would make the cache the intake for a forged
  // terminal line. Refuse at the writing end, where a human is present,
  // rather than escaping it at every reader. Every persisted STRING is
  // checked — the ledger's model id and each candidate-owned anchor field —
  // because the threat this command polices is a tampered candidate, and
  // policing one field of it is policing none.
  const controlled = (v: unknown): boolean =>
    // eslint-disable-next-line no-control-regex
    typeof v === 'string' && /[\u0000-\u001f\u007f]/.test(v);
  if (controlled(ledgerModel)) {
    throw new Error(
      'cache-commit: `lastModelId` carries control characters — refusing to ' +
        'persist a value that forges terminal output when read back.',
    );
  }
  for (const key of CANDIDATE_FIELDS) {
    if (controlled(candidate[key])) {
      throw new Error(
        `cache-commit: the candidate's \`${key}\` carries control ` +
          'characters — refusing to persist a value that forges terminal ' +
          'output (or a git argument) when read back.',
      );
    }
  }

  // Bind the promotion to its target: `pr-7`'s candidate committed to
  // `pr-8.json` erases pr-8's ledger under pr-7's anchor. The out path's
  // basename IS the target by the cache's naming contract.
  const outTarget = basename(args.out).replace(/\.json$/, '');
  if (candidate['target'] !== outTarget) {
    const hint =
      typeof candidate['target'] === 'string' &&
      candidate['target'].includes('/')
        ? ' The target contains "/": file-path reviews must pass the ' +
          'FLATTENED repo-relative path (src/foo.ts -> src_foo.ts) as ' +
          '--target and name the cache file the same way.'
        : '';
    throw new Error(
      `cache-commit: the candidate belongs to target ` +
        `${inertText(String(candidate['target']), 80)}, but --out names ` +
        `${inertText(outTarget, 80)} — refusing to promote across targets.` +
        hint,
    );
  }

  const merged: Record<string, unknown> = { ...ledger };
  for (const key of CANDIDATE_FIELDS) {
    // Candidate fields LAST: the anchor must win any collision (see header).
    if (key in candidate) merged[key] = candidate[key];
    else delete merged[key];
  }
  // Command-owned, stamped at promotion: spread FIRST it was silently
  // overridable by a ledger key — the precedence inversion this command
  // exists to prevent, in its own output.
  merged['lastReviewDate'] = new Date().toISOString();

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  assertUnredirectedParent(args.out, 'cache');
  // `noFollow`: the target path is deterministic and lives in the repo, so a
  // contributor branch can commit a SYMLINK there and a maintainer's review
  // would write merged-cache JSON onto the link's target — an arbitrary-file
  // clobber inside the reviewer's permissions, invisible in the reviewed
  // diff. The default resolves the chain and renames onto the resolved file;
  // this replaces the link itself.
  atomicWriteFileSync(args.out, `${JSON.stringify(merged, null, 2)}\n`, {
    noFollow: true,
  });
  writeStdoutLine(`Committed review cache to ${args.out}`);
}

export const cacheCommitCommand: CommandModule = {
  command: 'cache-commit',
  describe:
    "Promote a capture's cache candidate into .qwen/review-cache/, merged " +
    "with the round's ledger",
  builder: (y) =>
    y
      .option('candidate', {
        type: 'string',
        demandOption: true,
        describe:
          "The capture's cache candidate (the plan's `cacheCandidatePath`)",
      })
      .option('ledger', {
        type: 'string',
        demandOption: true,
        describe:
          'A small JSON file with the round ledger: lastModelId, round, ' +
          'verdict, findingsCount, findings[]',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'The cache file to write (.qwen/review-cache/<target>.json)',
      })
      .strict(),
  handler: (argv) => runCacheCommit(argv as unknown as CacheCommitArgs),
};
