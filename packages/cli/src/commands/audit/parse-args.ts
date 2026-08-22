/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { tokenizeArgs } from '../../utils/shell-args.js';
import { resolveAuditRoot, type AuditEffort } from './lib/files-plan.js';
import { writeFileGuarded } from './lib/safe-read.js';

const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export interface ParsedAuditArgs {
  targetPath: string;
  targetPathAbsolute: string;
  effort: AuditEffort;
}

export function parseAuditArgs(raw: string): ParsedAuditArgs {
  // The tokenizer strips quotes with no escape processing, so an UNCLOSED
  // quote must never reach it: it would swallow the rest of the string
  // (flags included). Validate with the tokenizer's own nesting semantics
  // — inside an open quote the OTHER quote character is literal content,
  // so `"src/O'Brien dir"` stays balanced while `"a'"b'` does not. Raw
  // per-character parity fails both directions: it accepts semantically
  // unclosed input and refuses balanced paths that contain an apostrophe.
  let openQuote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (openQuote !== null) {
      if (ch === openQuote) openQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") openQuote = ch;
  }
  if (openQuote !== null) {
    throw new Error(
      'audit parse-args: unbalanced quote in the argument string — a ' +
        'quoted segment is not closed. A path with spaces needs a matching ' +
        'quote pair on both ends; the opposite quote character may appear ' +
        'inside a quoted path.',
    );
  }
  const tokens = tokenizeArgs(raw);
  const paths: string[] = [];
  let effort: AuditEffort = 'medium';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--effort') {
      const value = tokens[++i];
      if (!value || !EFFORT_LEVELS.has(value.toLowerCase())) {
        throw new Error(
          'audit parse-args: --effort must be low, medium, or high.',
        );
      }
      effort = value.toLowerCase() as AuditEffort;
      continue;
    }
    if (token.startsWith('--effort=')) {
      const value = token.slice('--effort='.length);
      if (!EFFORT_LEVELS.has(value.toLowerCase())) {
        throw new Error(
          'audit parse-args: --effort must be low, medium, or high.',
        );
      }
      effort = value.toLowerCase() as AuditEffort;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(
        `audit parse-args: unknown flag ${JSON.stringify(token)}.`,
      );
    }
    paths.push(token);
  }

  if (paths.length !== 1) {
    throw new Error(
      `audit parse-args: expected exactly one directory path, got ${paths.length}.`,
    );
  }

  return {
    targetPath: paths[0],
    targetPathAbsolute: resolveAuditRoot(paths[0]),
    effort,
  };
}

interface ParseArgsCliArgs {
  stdin?: boolean;
  out?: string;
}

export const parseArgsCommand: CommandModule = {
  command: 'parse-args',
  describe:
    'Parse the /audit skill argument string from stdin and emit a resolved JSON verdict',
  builder: (yargs) =>
    yargs
      .option('stdin', {
        type: 'boolean',
        demandOption: true,
        describe: 'Read the raw /audit argument string from stdin',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the JSON verdict to this path',
      }),
  handler: (argv) => {
    const { stdin, out } = argv as unknown as ParseArgsCliArgs;
    if (!stdin) {
      throw new Error(
        'audit parse-args: --stdin cannot be negated — the command is stdin-only.',
      );
    }
    const raw = readFileSync(0, 'utf8');
    const json = JSON.stringify(parseAuditArgs(raw), null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileGuarded(out, json, 'the args verdict');
    }
    writeStdoutLine(json);
  },
};
