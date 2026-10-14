/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yargs, { type CommandModule } from 'yargs';
import type { ImportPreview } from './memory/codex-import.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';

interface ImportArguments {
  source?: string;
  'project-map'?: string;
  select?: string[];
  'dry-run': boolean;
  'review-source'?: string;
  json: boolean;
}

function printable(text: string): string {
  return text.replace(
    // Keep source text reviewable without executing terminal controls.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function readProjectMap(
  file: string | undefined,
): Promise<Record<string, string> | undefined> {
  if (file === undefined) return undefined;
  const content = await fs.readFile(file, 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('--project-map must contain valid JSON.');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.entries(value).every(
      ([source, target]) =>
        path.isAbsolute(source) &&
        typeof target === 'string' &&
        path.isAbsolute(target),
    )
  ) {
    throw new Error(
      '--project-map must contain a JSON object mapping absolute source project paths to absolute target directories.',
    );
  }
  return value as Record<string, string>;
}

function renderPreview(preview: ImportPreview): string {
  const lines = [
    preview.dryRun
      ? 'Codex memory import preview (no writes)'
      : 'Codex memory import result',
    `Source digest: ${preview.sourceDigest}`,
  ];
  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
  if (preview.entries.length === 0) lines.push('No import candidates found.');
  for (const entry of preview.entries) {
    lines.push(
      '',
      `[${entry.status}] ${entry.id} — ${entry.name}`,
      `Type: ${entry.type}`,
      `Source: ${entry.sourceFile}:${entry.sourceLine}`,
      `Source date: ${entry.updatedAt ?? 'unknown'}`,
      `Scope: ${entry.scope === 'user' ? (entry.scopeReason ? 'user (global fallback)' : 'user') : `project (${entry.resolvedProject ?? entry.sourceProject ?? 'unresolved'})`}`,
      ...(entry.sourceProject
        ? [`Source project: ${entry.sourceProject}`]
        : []),
      ...(entry.resolvedProject
        ? [`Resolved project: ${entry.resolvedProject}`]
        : []),
      `Destination: ${entry.targetRoot ?? 'unresolved'}`,
    );
    if (entry.scopeReason) lines.push(`Global fallback: ${entry.scopeReason}`);
    if (entry.reason) lines.push(`Reason: ${entry.reason}`);
    lines.push(entry.content);
  }
  for (const note of preview.reviewNotes) {
    lines.push('', `Source amendment to review: ${note.path}`, note.content);
  }
  if (preview.dryRun) {
    lines.push(
      '',
      'To import, select reviewed candidate IDs with --select and omit --dry-run.',
    );
    if (preview.reviewNotes.length > 0) {
      lines.push(
        `After reviewing source amendments, also pass --review-source ${preview.sourceDigest}.`,
      );
    }
  }
  return lines.join('\n');
}

const codexImportCommand: CommandModule<object, ImportArguments> = {
  command: 'codex',
  describe: 'Selectively import Codex memories into private Qwen memory',
  builder: (parser) =>
    parser
      .option('source', {
        type: 'string',
        requiresArg: true,
        description:
          'Codex memory directory (default: $CODEX_HOME/memories or ~/.codex/memories)',
      })
      .option('project-map', {
        type: 'string',
        requiresArg: true,
        description:
          'JSON file mapping absolute source project paths to absolute target directories',
      })
      .option('select', {
        type: 'array',
        string: true,
        requiresArg: true,
        description:
          'Reviewed candidate IDs to import (repeatable); without IDs, review interactively or preview in scripts',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        description:
          'Preview without writing anything, including when --select is supplied',
      })
      .option('review-source', {
        type: 'string',
        requiresArg: true,
        description:
          'Source digest from a reviewed preview; required to apply when source amendments exist',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Print the complete preview or result as JSON',
      })
      .strict(),
  handler: async (args) => {
    try {
      const projectMap = await readProjectMap(args.projectMap);
      const { runCodexImport } = await import('./memory/codex-import.js');
      const preview = await runCodexImport({
        source: args.source,
        projectMap,
        selectedIds: args.select,
        dryRun: args.dryRun,
        reviewedSource: args.reviewSource,
      });
      if (
        preview.dryRun &&
        !args.json &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      ) {
        const { showMemoryImportPreview } = await import(
          '../ui/components/StandaloneMemoryImportPreview.js'
        );
        const selection = await showMemoryImportPreview(
          preview,
          args.select,
          args.source,
          !args.dryRun,
        );
        if (
          !args.dryRun &&
          selection?.action === 'import' &&
          selection.selectedIds.length
        ) {
          const result = await runCodexImport({
            source: args.source,
            projectMap,
            selectedIds: selection.selectedIds,
            dryRun: false,
            reviewedSource: preview.sourceDigest,
          });
          const selected = result.entries.filter((entry) =>
            selection.selectedIds.includes(entry.id),
          );
          writeStdoutLine(
            `Import complete: ${selected.filter((entry) => entry.status === 'imported').length} new memories; ${selected.filter((entry) => entry.status === 'previously-imported').length} already handled.`,
          );
          return;
        }
        writeStdoutLine('Preview closed. No memories written.');
        if (args.dryRun) {
          writeStdoutLine(
            'To import interactively, rerun without --dry-run and any --select options, review the selection, then press i to confirm. All eligible candidates are selected by default.',
          );
        }
        return;
      }
      writeStdoutLine(
        printable(
          args.json ? JSON.stringify(preview, null, 2) : renderPreview(preview),
        ),
      );
    } catch (error) {
      writeStderrLine(
        printable(error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    }
  },
};

export const memoryCommand: CommandModule = {
  command: 'memory',
  describe: 'Manage native memories offline',
  builder: (parser) =>
    parser
      .command({
        command: 'import',
        describe: 'Preview or selectively import external memories',
        builder: (importParser) =>
          importParser.command(codexImportCommand).demandCommand(1),
        handler: () => {},
      })
      .demandCommand(1)
      .version(false),
  handler: () => {},
};

export async function runMemoryCommand(argv: readonly string[]): Promise<void> {
  try {
    await yargs([])
      .scriptName('qwen')
      .command(memoryCommand)
      .help()
      .alias('h', 'help')
      .version(false)
      .strict()
      .demandCommand(1)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync([...argv]);
  } catch (error) {
    writeStderrLine(
      printable(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}
