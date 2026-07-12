/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review parse-args`: deterministic argument parsing for the /review
// skill. The flag grammar (`--comment`, `--effort <level>`, `--effort=<level>`)
// and the target disambiguation (PR number / PR URL / file path / local diff)
// used to live as prose in SKILL.md, which the model re-simulated on every
// run; three separate parsing bugs shipped that way. This module is the
// single source of truth: the skill passes the raw argument string in and
// uses the JSON verdict verbatim.
//
// Scope: pure argument classification only. Anything that needs repo state —
// matching a PR URL's owner/repo against `git remote -v`, checking that a
// file path exists — stays with the caller.

import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

export type ReviewEffort = 'low' | 'medium' | 'high';

export type ReviewTarget =
  | { type: 'pr-number'; number: number }
  | {
      type: 'pr-url';
      url: string;
      owner: string;
      repo: string;
      number: number;
    }
  | { type: 'file'; path: string }
  | { type: 'local' };

export interface ParsedReviewArgs {
  target: ReviewTarget;
  /** Resolved effort after defaults and the `--comment` override. */
  effort: ReviewEffort;
  effortSource: 'explicit' | 'default' | 'forced-by-comment';
  comment: {
    /** `--comment` appeared in the arguments. */
    requested: boolean;
    /** `--comment` applies (the target is a PR). */
    effective: boolean;
  };
  /** Non-flag tokens beyond the first target token, reported not guessed. */
  extraTokens: string[];
  /** Unrecognized `--flags`, reported not guessed. */
  unknownFlags: string[];
  warnings: string[];
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

const PR_URL_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

function isEffort(value: string): value is ReviewEffort {
  return EFFORT_LEVELS.has(value);
}

function isFlag(token: string): boolean {
  return token.startsWith('--');
}

function isPureInteger(token: string): boolean {
  return /^\d+$/.test(token);
}

/**
 * Split a raw argument string on whitespace, honouring double- and
 * single-quoted segments so file paths with spaces survive.
 */
export function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let sawAny = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawAny = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || sawAny) tokens.push(current);
      current = '';
      sawAny = false;
      continue;
    }
    current += ch;
  }
  if (current || sawAny) tokens.push(current);
  return tokens;
}

function classifyToken(token: string): ReviewTarget | null {
  if (isFlag(token)) return null;
  if (isPureInteger(token)) {
    return { type: 'pr-number', number: Number(token) };
  }
  const urlMatch = PR_URL_RE.exec(token);
  if (urlMatch) {
    return {
      type: 'pr-url',
      url: token,
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: Number(urlMatch[3]),
    };
  }
  return { type: 'file', path: token };
}

export function parseReviewArgs(raw: string): ParsedReviewArgs {
  const tokens = tokenizeArgs(raw);
  const warnings: string[] = [];
  const unknownFlags: string[] = [];

  let commentRequested = false;
  let explicitEffort: ReviewEffort | null = null;

  // First pass: pull out flags (and each `--effort`'s value token, when the
  // spaced form legitimately consumes one). Non-flag tokens are kept in
  // order; invalid spaced `--effort` values are kept as *candidates* whose
  // disposal is decided after we know whether any other token is the target.
  interface Kept {
    token: string;
    /** True when this token arrived as an invalid `--effort` value. */
    fromInvalidEffortValue: boolean;
  }
  const kept: Kept[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '--comment') {
      commentRequested = true;
      continue;
    }

    if (token === '--effort' || token.startsWith('--effort=')) {
      if (token.includes('=')) {
        // `--effort=<value>`: self-contained; never consumes a second token.
        const value = token.slice(token.indexOf('=') + 1);
        if (isEffort(value)) {
          explicitEffort = value;
        } else {
          warnings.push(
            `Invalid --effort value ${JSON.stringify(value)}; using the default effort.`,
          );
        }
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      if (next !== undefined && isEffort(next)) {
        explicitEffort = next;
        i++;
        continue;
      }
      if (next === undefined || isFlag(next)) {
        // Flag-final, or followed by another flag: the value is simply
        // missing. Never consume a flag as a value.
        warnings.push('--effort requires a value; using the default effort.');
        continue;
      }
      // Spaced form with an invalid non-flag value. Whether `next` is a
      // discarded typo or the review target is decided below, once we know
      // whether any other token can be the target.
      kept.push({ token: next, fromInvalidEffortValue: true });
      i++;
      continue;
    }

    if (isFlag(token)) {
      unknownFlags.push(token);
      warnings.push(`Unrecognized flag ${JSON.stringify(token)}; ignored.`);
      continue;
    }

    kept.push({ token, fromInvalidEffortValue: false });
  }

  // Disposal rule for invalid `--effort` values: a typo is discarded when
  // any *other* token is the target; it survives only when it is itself the
  // sole target candidate (`/review --effort 6711`).
  const hasOtherCandidate = kept.some((k) => !k.fromInvalidEffortValue);
  const targetTokens: string[] = [];
  for (const k of kept) {
    if (k.fromInvalidEffortValue && hasOtherCandidate) {
      warnings.push(
        `Invalid --effort value ${JSON.stringify(k.token)} discarded; using the default effort.`,
      );
      continue;
    }
    if (k.fromInvalidEffortValue) {
      warnings.push(
        `Invalid --effort value ${JSON.stringify(k.token)}; treating it as the review target and using the default effort.`,
      );
    }
    targetTokens.push(k.token);
  }

  const target: ReviewTarget =
    targetTokens.length === 0
      ? { type: 'local' }
      : (classifyToken(targetTokens[0]) ?? { type: 'local' });
  const extraTokens = targetTokens.slice(1);
  if (extraTokens.length > 0) {
    warnings.push(
      `Ignoring extra argument(s): ${extraTokens.map((t) => JSON.stringify(t)).join(', ')}.`,
    );
  }

  const isPr = target.type === 'pr-number' || target.type === 'pr-url';

  const commentEffective = commentRequested && isPr;
  if (commentRequested && !isPr) {
    warnings.push(
      'Warning: `--comment` flag is ignored because the review target is not a PR.',
    );
  }

  let effort: ReviewEffort;
  let effortSource: ParsedReviewArgs['effortSource'];
  if (explicitEffort !== null) {
    effort = explicitEffort;
    effortSource = 'explicit';
  } else {
    effort = isPr ? 'high' : 'medium';
    effortSource = 'default';
  }
  // Posting requires a verified review: an *effective* --comment forces
  // high. An ignored --comment (non-PR target) must not change the effort.
  if (commentEffective && effort !== 'high') {
    effort = 'high';
    effortSource = 'forced-by-comment';
    warnings.push(
      '`--comment` requires a verified review; running at high effort.',
    );
  }

  return {
    target,
    effort,
    effortSource,
    comment: { requested: commentRequested, effective: commentEffective },
    extraTokens,
    unknownFlags,
    warnings,
  };
}

interface ParseArgsCliArgs {
  raw: string | undefined;
  out: string | undefined;
}

export const parseArgsCommand: CommandModule = {
  command: 'parse-args [raw]',
  describe:
    'Parse the /review skill argument string (--comment, --effort, target disambiguation) and emit the verdict as JSON',
  builder: (yargs) =>
    yargs
      .positional('raw', {
        type: 'string',
        describe:
          'The raw argument string, passed as a single (quoted) argument; omit for a no-argument local review',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the JSON verdict to this path',
      }),
  handler: (argv) => {
    const { raw, out } = argv as unknown as ParseArgsCliArgs;
    const parsed = parseReviewArgs(raw ?? '');
    const json = JSON.stringify(parsed, null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
  },
};
