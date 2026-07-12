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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

export type ReviewEffort = 'low' | 'medium' | 'high';

export type ReviewTarget =
  | { type: 'pr-number'; number: number }
  | {
      type: 'pr-url';
      /** Canonicalized: lowercased scheme and host, query/fragment dropped. */
      url: string;
      host: string;
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

// The verdict's owner/repo/number are interpolated into `gh` commands by the
// caller, so they must be established trustworthily, not merely extracted:
// the scheme is case-insensitive, the number must END at the path segment
// (`/pull/42oops` is not PR 42), and owner/repo are restricted to GitHub's
// name charset — which as a side effect keeps shell metacharacters out of
// every derived value.
const PR_URL_RE =
  /^(https?):\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[/?#])/i;

/**
 * Case-insensitive: `--effort High` has exactly one plausible meaning, and
 * classifying `High` as a file-path target (as a case-sensitive match once
 * did) sends the caller off to stat a file that does not exist. The verdict
 * always carries the lowercase form.
 */
function asEffort(value: string): ReviewEffort | null {
  const lower = value.toLowerCase();
  return EFFORT_LEVELS.has(lower) ? (lower as ReviewEffort) : null;
}

/**
 * Single-dash tokens count as flags too: `-c` is never a plausible review
 * target, and classifying it as a file path demoted the real target the
 * user typed right after it into `extraTokens`.
 */
function isFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
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

/**
 * `'invalid-url'` marks a token that looks like a URL but is not a valid PR
 * URL. It must not fall through to the `file` classification — a target the
 * user typed as a URL is never a file path, and guessing one would send the
 * caller off to stat a nonsense path instead of surfacing the typo.
 */
function classifyToken(token: string): ReviewTarget | 'invalid-url' | null {
  if (isFlag(token)) return null;
  if (isPureInteger(token)) {
    return { type: 'pr-number', number: Number(token) };
  }
  const urlMatch = PR_URL_RE.exec(token);
  if (urlMatch) {
    const [, scheme, host, owner, repo, num] = urlMatch;
    const lowerHost = host.toLowerCase();
    return {
      type: 'pr-url',
      url: `${scheme.toLowerCase()}://${lowerHost}/${owner}/${repo}/pull/${Number(num)}`,
      host: lowerHost,
      owner,
      repo,
      number: Number(num),
    };
  }
  if (/^https?:\/\//i.test(token)) return 'invalid-url';
  return { type: 'file', path: token };
}

export function parseReviewArgs(raw: string): ParsedReviewArgs {
  const tokens = tokenizeArgs(raw);
  const warnings: string[] = [];
  const unknownFlags: string[] = [];

  let commentRequested = false;
  let explicitEffort: ReviewEffort | null = null;

  // Warnings about a rejected `--effort` occurrence must state what effort
  // is ACTUALLY in effect — which is not known until every occurrence is
  // seen (a later valid one wins) and the `--comment` override has run. So
  // rejected occurrences are recorded here and their warnings composed at
  // the end; emitting "using the default effort" inline once told the user
  // the default applied while an earlier valid `--effort low` stayed active.
  type EffortIssue =
    | { kind: 'invalid-eq'; value: string }
    | { kind: 'missing' }
    | { kind: 'discarded'; value: string }
    | { kind: 'kept-as-target'; value: string };
  const effortIssues: EffortIssue[] = [];

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
        const effortValue = asEffort(value);
        if (effortValue !== null) {
          explicitEffort = effortValue;
        } else {
          effortIssues.push({ kind: 'invalid-eq', value });
        }
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
      const nextEffort = next !== undefined ? asEffort(next) : null;
      if (nextEffort !== null) {
        explicitEffort = nextEffort;
        i++;
        continue;
      }
      if (next === undefined || isFlag(next)) {
        // Flag-final, or followed by another flag: the value is simply
        // missing. Never consume a flag as a value.
        effortIssues.push({ kind: 'missing' });
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
      effortIssues.push({ kind: 'discarded', value: k.token });
      continue;
    }
    if (k.fromInvalidEffortValue) {
      effortIssues.push({ kind: 'kept-as-target', value: k.token });
    }
    targetTokens.push(k.token);
  }

  // Pick the first classifiable target token. A token that looks like a URL
  // but is not a valid PR URL is refused, not guessed at: it goes into
  // `extraTokens` with its own warning instead of becoming the target.
  let target: ReviewTarget = { type: 'local' };
  let targetAssigned = false;
  const extraTokens: string[] = [];
  const trailingExtras: string[] = [];
  for (const tok of targetTokens) {
    if (targetAssigned) {
      extraTokens.push(tok);
      trailingExtras.push(tok);
      continue;
    }
    const classified = classifyToken(tok);
    if (classified === 'invalid-url') {
      warnings.push(
        `Unrecognized URL ${JSON.stringify(tok)} — not a GitHub PR URL (expected …/pull/<number>); refusing to guess a target from it.`,
      );
      extraTokens.push(tok);
      continue;
    }
    target = classified ?? { type: 'local' };
    targetAssigned = true;
  }
  if (trailingExtras.length > 0) {
    warnings.push(
      `Ignoring extra argument(s): ${trailingExtras.map((t) => JSON.stringify(t)).join(', ')}.`,
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

  // Now the resolution is final; compose the deferred effort warnings so
  // each states what is actually in effect.
  const resolution =
    effortSource === 'explicit'
      ? `--effort ${effort} (the last valid occurrence) is in effect`
      : effortSource === 'forced-by-comment'
        ? '`--comment` forces high effort'
        : 'using the default effort';
  for (const issue of effortIssues) {
    switch (issue.kind) {
      case 'invalid-eq':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)}; ${resolution}.`,
        );
        break;
      case 'missing':
        warnings.push(`--effort requires a value; ${resolution}.`);
        break;
      case 'discarded':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)} discarded; ${resolution}.`,
        );
        break;
      case 'kept-as-target':
        warnings.push(
          `Invalid --effort value ${JSON.stringify(issue.value)}; treating it as the review target — ${resolution}.`,
        );
        break;
      default:
        break;
    }
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
  stdin: boolean | undefined;
  out: string | undefined;
}

export const parseArgsCommand: CommandModule = {
  command: 'parse-args [raw]',
  describe:
    'Parse the /review skill argument string (--comment, --effort, target disambiguation) and emit the verdict as JSON; pass the string on stdin via --stdin (a positional that begins with a dash never reaches this handler — yargs rejects it as an unknown flag)',
  builder: (yargs) =>
    yargs
      .positional('raw', {
        type: 'string',
        describe:
          'The raw argument string as a single (quoted) argument — only safe when it cannot begin with a dash or contain quotes; otherwise use --stdin',
      })
      .option('stdin', {
        type: 'boolean',
        describe:
          'Read the raw argument string from stdin (one trailing newline is stripped). Immune to flag-first strings and shell quoting; this is the form the /review skill uses.',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the JSON verdict to this path',
      }),
  handler: (argv) => {
    const { raw, stdin, out } = argv as unknown as ParseArgsCliArgs;
    if (stdin && raw !== undefined) {
      throw new Error(
        'parse-args: pass the raw string either as the positional argument or on --stdin, not both',
      );
    }
    // Tokens after a `--` separator never bind to the [raw] positional —
    // they stay in argv._ — so `parse-args -- '--effort low'` used to
    // return a silently wrong local/default verdict. Refuse instead.
    // argv._ also carries the command path itself, whose shape depends on
    // nesting (`['parse-args']` standalone, `['review', 'parse-args']`
    // under the real CLI) — skip that prefix, or the guard rejects every
    // real nested invocation.
    const positionals = (argv['_'] as unknown[]).map(String);
    let commandPrefix = 0;
    while (
      commandPrefix < positionals.length &&
      (positionals[commandPrefix] === 'review' ||
        positionals[commandPrefix] === 'parse-args')
    ) {
      commandPrefix++;
    }
    const unbound = positionals.slice(commandPrefix);
    if (unbound.length > 0) {
      throw new Error(
        `parse-args: unexpected extra argument(s) ${JSON.stringify(unbound)} — a raw string that begins with a flag must be passed via --stdin, not after --`,
      );
    }
    const rawStr = stdin
      ? readFileSync(0, 'utf8').replace(/\r?\n$/, '')
      : (raw ?? '');
    const parsed = parseReviewArgs(rawStr);
    const json = JSON.stringify(parsed, null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
  },
};
