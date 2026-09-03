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
import { CONTROL, inertText } from './lib/inert-text.js';
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

/**
 * The names the LEDGER owns. Everything else the candidate carries is anchor
 * state and travels with it.
 *
 * This was an allowlist of candidate fields, and it was forgotten three times
 * in three rounds — `lastModelId`, then `source`, then `untracked` — each
 * time silently: the promoted cache simply lacked the field, the gate that
 * read it evaluated `undefined` and fell open, and nothing failed loudly. The
 * capture is the only writer of anchor state, so anchor state is whatever the
 * capture wrote; enumerating it here duplicates a fact that lives there and
 * drifts from it. A DENY list cannot drift the same way: a new candidate
 * field travels by default, and the thing that must not travel — a ledger key
 * the candidate tries to smuggle — is the short, stable set.
 */
const LEDGER_FIELDS = [
  'round',
  'findings',
  'findingsCount',
  'verdict',
  'lastReviewDate',
] as const;

/** Every key the candidate carries that the ledger does not own. */
function candidateFieldsOf(candidate: Record<string, unknown>): string[] {
  return Object.keys(candidate).filter(
    (k) => !(LEDGER_FIELDS as readonly string[]).includes(k),
  );
}

/**
 * Where, if anywhere, `value` carries a control character: every string at
 * any depth, map KEYS included — a verdicts map is keyed by file paths, and
 * git permits almost any byte in one. Null when clean; otherwise the dotted
 * location, for the refusal to name.
 */
function controlledAt(value: unknown, at: string): string | null {
  if (typeof value === 'string') return CONTROL.test(value) ? at : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = controlledAt(value[i], `${at}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const here = `${at}.${key}`;
      if (CONTROL.test(key)) return here;
      const hit = controlledAt(inner, here);
      if (hit !== null) return hit;
    }
  }
  return null;
}

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

  // The ledger contributes ONLY the names it owns. Spreading it whole and
  // then overwriting the anchor names left a hole the deny list cannot see:
  // an anchor name THIS candidate happens not to carry (`fileVerdicts` on a
  // local candidate) is not a ledger field and not a candidate key, so a
  // ledger carrying it would have written anchor state. Building from the
  // owned set instead makes that unrepresentable — and a ledger key outside
  // the contract SKILL.md states is dropped, which is the safe direction: it
  // can be a typo or an attempt to write anchor state, and it is never
  // something a reader needs.
  const merged: Record<string, unknown> = {};
  for (const key of LEDGER_FIELDS) {
    if (key in ledger) merged[key] = ledger[key];
  }
  for (const key of candidateFieldsOf(candidate)) {
    // Candidate fields LAST: the anchor must win any collision (see header).
    merged[key] = candidate[key];
  }
  // Command-owned, stamped at promotion: spread FIRST it was silently
  // overridable by a ledger key — the precedence inversion this command
  // exists to prevent, in its own output.
  merged['lastReviewDate'] = new Date().toISOString();

  // The promoted cache is read back by commands that print these values on a
  // refusal, and the next round hands `lastCommitSha` to git as an argument;
  // a control-charactered value would make the cache the intake for a forged
  // terminal line. Refuse at the writing end, where a human is present,
  // rather than escaping it at every reader. Swept over what is about to be
  // PERSISTED — the merged object, keys and values, at every depth — rather
  // than over a list of fields: the list drifted twice (top-level candidate
  // scalars only, while the verdicts map is keyed by file paths and the
  // ledger's findings are model prose), and a sweep of the output cannot.
  // ONE class, imported rather than re-derived: this sweep and `inertText`'s
  // classifier drifted apart twice as well, and a value that passes here is
  // persisted raw at a deterministic in-repo path and printed back through
  // `inertText` on a refusal, so a gap in either is a forged terminal line.
  const hit = controlledAt(merged, 'cache');
  if (hit !== null) {
    throw new Error(
      `cache-commit: \`${inertText(hit)}\` carries control characters — ` +
        'refusing to persist a value that forges terminal output (or a git ' +
        'argument) when read back.',
    );
  }

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
  writeStdoutLine(`Committed review cache to ${inertText(args.out)}`);
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
          'A small JSON file with the round ledger: round, verdict, ' +
          'findingsCount, findings[]',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'The cache file to write (.qwen/review-cache/<target>.json)',
      })
      .strict(),
  handler: (argv) => runCacheCommit(argv as unknown as CacheCommitArgs),
};
