/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { tokenizeArgs } from '../review/parse-args.js';
import { resolveAuditRoot, type AuditEffort } from './lib/files-plan.js';

const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export interface ParsedAuditArgs {
  targetPath: string;
  targetPathAbsolute: string;
  effort: AuditEffort;
}

export function parseAuditArgs(raw: string): ParsedAuditArgs {
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
    const { out } = argv as unknown as ParseArgsCliArgs;
    const raw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    const json = JSON.stringify(parseAuditArgs(raw), null, 2);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, 'utf8');
    }
    writeStdoutLine(json);
  },
};
