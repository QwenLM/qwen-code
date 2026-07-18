/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review resolve-anchors`: turn each finding's quoted code snippet into
// the line number GitHub needs, by matching it against the captured diff.
//
// Step 7 used to post the line number the review agent reported. GitHub rejects
// the entire Create Review call with a 422 if any one comment's line falls
// outside every hunk of its file — all-or-nothing — so a single miscounted
// anchor took every Critical in the review down with it, and the recovery path
// then *discarded* unanchorable Suggestions from the PR. This makes the number
// a computed value: the agent quotes the code (which it can see), the diff
// decides the line (which it cannot miscount).

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  resolveAnchors,
  type AnchorRequest,
  type AnchorResult,
} from './lib/anchors.js';

interface ResolveAnchorsArgs {
  diff: string;
  input: string;
  out: string;
}

/** Every request carries an id, a path and a snippet; the rest is optional. */
export function validateRequests(raw: unknown): AnchorRequest[] {
  if (!Array.isArray(raw)) {
    throw new Error('Input must be a JSON array of findings.');
  }
  const requests = raw.map((r, i) => {
    // `null` is an object to `typeof`, and indexing it throws a TypeError that
    // says nothing about which entry was wrong. Every other malformed input gets
    // a message naming the index and the field; this one deserves the same.
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(
        `Finding at index ${i} is ${JSON.stringify(r)}, not an object. ` +
          `Each entry needs {id, path, anchor} and may carry {line}.`,
      );
    }
    const o = r as Record<string, unknown>;
    for (const key of ['id', 'path', 'anchor'] as const) {
      if (typeof o[key] !== 'string' || o[key] === '') {
        throw new Error(
          `Finding at index ${i} is missing a non-empty string "${key}". ` +
            `Each entry needs {id, path, anchor} and may carry {line}.`,
        );
      }
    }
    if (o['line'] !== undefined && typeof o['line'] !== 'number') {
      throw new Error(`Finding "${o['id']}" has a non-numeric "line".`);
    }
    return {
      id: o['id'] as string,
      path: o['path'] as string,
      anchor: o['anchor'] as string,
      ...(o['line'] !== undefined ? { line: o['line'] as number } : {}),
    };
  });

  // The report splits into `resolved` and `unmatched`, so the caller cannot
  // re-join by position — it joins by id. A duplicate id therefore pairs some
  // finding with another finding's line, and posts a comment on code it is not
  // about. Refuse it here rather than let it resolve into a plausible wrong
  // answer.
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of requests) {
    if (seen.has(r.id)) dupes.add(r.id);
    seen.add(r.id);
  }
  if (dupes.size > 0) {
    throw new Error(
      `Duplicate finding id(s): ${[...dupes].join(', ')}. Ids are how each ` +
        `resolution is matched back to its finding, so they must be unique.`,
    );
  }
  return requests;
}

function runResolveAnchors(args: ResolveAnchorsArgs): void {
  let diffText: string;
  try {
    diffText = readFileSync(args.diff, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read diff file ${args.diff}: ${(err as Error).message}`,
    );
  }

  // Two failures, two messages. One `try` around both told a user with a stray
  // trailing comma that their file "could not be read", and sent them looking at
  // permissions.
  let rawText: string;
  try {
    rawText = readFileSync(args.input, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read findings file ${args.input}: ${(err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Cannot parse findings file ${args.input} as JSON: ${
        (err as Error).message
      }`,
    );
  }

  const results = resolveAnchors(diffText, validateRequests(raw));
  const resolved = results.filter((r) => r.status === 'resolved');
  const unmatched = results.filter((r) => r.status === 'unmatched');

  const report = {
    resolved,
    unmatched,
    stats: {
      total: results.length,
      resolved: resolved.length,
      unmatched: unmatched.length,
      ambiguous: resolved.filter((r) => r.ambiguous).length,
      // A confident match a long way from where the agent said it was. The
      // finding is fine; the agent's counting was not. Worth seeing.
      drifted: resolved.filter((r) => (r.drift ?? 0) > 0).length,
      loose: resolved.filter((r) => r.tier?.startsWith('loose')).length,
    },
  };

  // The directory of the path the CALLER chose, which is not necessarily
  // `.qwen/tmp` — `--out reports/anchors.json` is a legal request, and creating
  // the temp dir instead answered it with ENOENT.
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  writeStdoutLine(`Wrote resolved anchors to ${args.out}`);

  const s = report.stats;
  writeStderrLine(
    `Anchors: ${s.resolved}/${s.total} resolved` +
      (s.drifted ? `, ${s.drifted} corrected` : '') +
      (s.ambiguous ? `, ${s.ambiguous} ambiguous` : '') +
      (s.loose
        ? `, ${s.loose} matched only after normalising indentation`
        : '') +
      (s.unmatched ? `, ${s.unmatched} UNMATCHED` : ''),
  );
  for (const r of resolved as AnchorResult[]) {
    if ((r.drift ?? 0) > 0) {
      // Print the range, not just `line`. `drift` is measured against
      // `startLine`, so reporting the end line here reads as a contradiction
      // ("agent said 420, the snippet is at 420") on any multi-line anchor.
      const span =
        r.startLine === r.line ? `${r.line}` : `${r.startLine}-${r.line}`;
      writeStderrLine(
        `  corrected ${r.path}: agent said line ${r.claimedLine}, ` +
          `the snippet is at ${span}`,
      );
    }
    if (r.ambiguous) {
      writeStderrLine(
        `  ambiguous ${r.path}:${r.line} — the snippet appears ` +
          `${r.matchCount} times; picked the one nearest the agent's claim. ` +
          `A longer anchor would settle it.`,
      );
    }
  }
  for (const r of unmatched) {
    writeStderrLine(`  UNMATCHED ${r.id} (${r.path}): ${r.reason}`);
  }
}

export const resolveAnchorsCommand: CommandModule = {
  command: 'resolve-anchors',
  describe:
    "Compute each finding's diff line from its quoted code snippet (never trust an agent's line number)",
  builder: (yargs) =>
    yargs
      .option('diff', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the captured diff (`diffPath` from fetch-pr / capture-local / plan-diff)',
      })
      .option('input', {
        type: 'string',
        demandOption: true,
        describe:
          "JSON array of findings: [{id, path, anchor, line?}]. `anchor` is a verbatim snippet from the diff; `line` is the agent's claim, used only to break ties.",
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      }),
  handler: (argv) => {
    runResolveAnchors(argv as unknown as ResolveAnchorsArgs);
  },
};
