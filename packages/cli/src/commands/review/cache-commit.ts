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

import { createHash } from 'node:crypto';
import type { CommandModule } from 'yargs';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { inertText } from './lib/inert-text.js';
import { assertUnredirectedParent } from './lib/paths.js';

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
 *  the ledger, exactly as the ledger cannot overwrite the anchor.
 *
 *  This list is the one place that decides what survives promotion, so a
 *  field added on the producer side has to be added HERE too — a candidate
 *  field the local flow wrote and this list omitted was silently dropped,
 *  and the next round's gate then refused its own anchor for ever, blaming
 *  a stale cache format. */
const CANDIDATE_FIELDS = [
  'v',
  'target',
  'headSha',
  'files',
  'stateId',
  'lastCommitSha',
  'mergeBaseSha',
  'fileVerdicts',
  // The path the target token was flattened from, on a file review. The next
  // round's anchor gate compares it (`safeTarget` is not injective, so the
  // token alone cannot tell two files apart), and this allowlist is what
  // decides whether it survives promotion. Left out, every file-path review
  // promoted through this command lost its anchor permanently: the promoted
  // cache carried no `source`, the gate refused it as "an unrecorded path",
  // and every later round degraded to a full review. The hand-merge this
  // command replaced spread the whole candidate, so it survived there — the
  // mechanical allowlist is precisely what dropped it.
  'source',
  // The identity that certified the round, and an ANCHOR field like the rest
  // of this list even though it names a model rather than a tree. The capture
  // records it from what the runtime published — provider-qualified,
  // `<model>@<digest>` — because the alternative is a token routed through
  // the orchestrator's output, and `{{model}}` interpolates the BARE model
  // id: two provider configurations exposing one model name write the same
  // string and pass each other's same-model gate, which is the whole contract
  // the anchor rests on. Left out of this list, a hand-written ledger key
  // would win the collision and put that bare token back in the cache.
  'lastModelId',
] as const;

function runCacheCommit(args: CacheCommitArgs): void {
  const candidate = readJsonObject(args.candidate, 'the cache candidate');
  const ledger = readJsonObject(args.ledger, 'the round ledger');

  // The two fields every incremental check reads are non-negotiable: a cache
  // without a model has no same-model contract to enforce, and Step 1 would
  // fail-open it into a full review forever; better to refuse loudly now.
  //
  // Read off the CANDIDATE, which is where both captures record it, and never
  // off the ledger. A ledger value is one the orchestrator typed, and the only
  // token it can type is `{{model}}` — the BARE model id, which two provider
  // configurations exposing one model name share. The captures record what the
  // runtime published instead, provider-qualified, so the string that gets
  // compared is the one that tells those two apart.
  const candidateModel = candidate['lastModelId'];
  if (typeof candidateModel !== 'string' || candidateModel === '') {
    throw new Error(
      'cache-commit: the candidate must carry a non-empty `lastModelId` — ' +
        'the incremental anchor is a same-model contract, and the capture is ' +
        'what records who certified it.',
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
    // C1 (U+0080–U+009F) as well as C0 and DEL. A C0-only sweep let U+009B
    // (8-bit CSI) and U+009D (8-bit OSC) through into the cache, which sits
    // at a deterministic in-repo path this command's own threat model calls
    // tamperable; the next round reads the value back and prints it on a
    // refusal through escapers that share the same C0-only blind spot, so the
    // sequence reaches the operator's terminal intact and xterm/VTE-class
    // terminals act on it. House convention already sweeps C1 (`budget.ts`,
    // `textUtils.ts`, `memory/indexer.ts`).
    // eslint-disable-next-line no-control-regex
    typeof v === 'string' && /[\u0000-\u001f\u007f-\u009f]/.test(v);
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
  // basename IS the target by the cache's naming contract — except for a FILE
  // review, whose cache is `file-<token>-<digest of the source path>.json`
  // because the flattened token alone does not discriminate the subject
  // (`src/foo.ts` and `src_foo.ts` share one). Both halves are checked there:
  // the token against the candidate's `target`, and the digest against its
  // `source`, so promoting one file's candidate into another file's cache is
  // refused even when their tokens collide.
  const stem = basename(args.out).replace(/\.json$/, '');
  const fileForm = /^file-(.*)-([0-9a-f]{8})$/.exec(stem);
  const outTarget = fileForm ? fileForm[1] : stem;
  if (fileForm) {
    const source = candidate['source'];
    const expected =
      typeof source === 'string'
        ? createHash('sha256').update(source).digest('hex').slice(0, 8)
        : null;
    if (expected !== fileForm[2]) {
      throw new Error(
        `cache-commit: --out names the cache of a different source path ` +
          `than the candidate's (${inertText(String(source ?? 'none'), 96)}) ` +
          '— refusing to promote across file targets.',
      );
    }
  }
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
  assertUnredirectedParent(args.out, 'cache', 'cache-commit');
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
