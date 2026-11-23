/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { commandMetadata } from './command-metadata.js';
import type { Arguments, Argv, CommandModule } from 'yargs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { previewSource, readLocalSource } from '../memory-import/source.js';
import { ignoreBrokenPipe } from '../utils/stdioHelpers.js';

// This command's stdout is its result; exiting on an unflushed async write
// truncates it on a pipe. A reader that left (EPIPE) must not fail an
// already-committed import: the write is lost with the reader, so resolve it
// instead of rejecting.
const writeStdoutLineFlushed = (message: string): Promise<void> =>
  new Promise((resolve, reject) =>
    process.stdout.write(
      message.endsWith('\n') ? message : `${message}\n`,
      (error) =>
        error && (error as NodeJS.ErrnoException).code !== 'EPIPE'
          ? reject(error)
          : resolve(),
    ),
  );

async function selectionFile(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
    throw new Error('Selection must be a bounded regular JSON file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function handleWorktreeImport(args: Arguments): Promise<void> {
  const { runWithLocalWorktreeImportConfig } = await import(
    '../memory-import/worktree-local.js'
  );
  const {
    previewWorktreeMemory,
    assertWorktreePreview,
    assertWorktreeSelectionScope,
  } = await import('../memory-import/worktree-source.js');
  const scope =
    args['scope'] === 'workspace' || args['scope'] === 'git-root'
      ? args['scope']
      : undefined;
  await runWithLocalWorktreeImportConfig(scope, async (cwd) => {
    const preview = await previewWorktreeMemory(cwd, {
      source: typeof args['source'] === 'string' ? args['source'] : undefined,
      lexicalCwd: process.env['PWD'],
      hintWorkspaceScope: scope === undefined,
    });
    if (!args['apply']) {
      if (args['json']) await writeStdoutLineFlushed(JSON.stringify(preview));
      else
        await writeStdoutLineFlushed(
          [
            `Target owner: ${JSON.stringify(preview.target.owner)}`,
            `Target scope: ${preview.target.scope}`,
            `Target memory directory: ${JSON.stringify(preview.target.memoryRoot)}`,
            `Source digest: ${preview.digest}`,
            ...preview.sections.map(
              (item) =>
                `${item.id} ${JSON.stringify(item.sourceProject)} ${JSON.stringify(item.path)}`,
            ),
            ...preview.warnings.map(
              (warning) => `Warning: ${JSON.stringify(warning)}`,
            ),
            `Estimated upper bound for all selectable topics: ${preview.estimate.modelCalls} model calls and ${preview.estimate.reservedTokens} reserved token units.`,
            'To import, use --json and save {target, digest, selection:[{id,scope:"project"}]} to a file. Pass --apply --selection <JSON file> --idempotency-key <key>.',
          ].join('\n'),
        );
      return;
    }
    if (
      typeof args['selection'] !== 'string' ||
      typeof args['idempotency-key'] !== 'string'
    )
      throw new Error('--apply requires --selection and --idempotency-key.');
    const confirmed = await selectionFile(args['selection']);
    if (!confirmed || typeof confirmed !== 'object')
      throw new Error(
        'Selection must include the target, digest and selected IDs from an offline preview.',
      );
    const manifest = confirmed as Record<string, unknown>;
    assertWorktreePreview(preview, manifest['target'], manifest['digest']);
    assertWorktreeSelectionScope(manifest['selection']);
    const { createLocalMemoryImportService } = await import(
      '../memory-import/local.js'
    );
    const service = await createLocalMemoryImportService();
    let task = await service.submitWorktree(
      preview,
      manifest['selection'],
      args['idempotency-key'],
      manifest['target'],
      manifest['digest'],
    );
    if (args['retry']) task = await service.retry(task.id);
    task = await service.idle(task.id);
    await writeStdoutLineFlushed(JSON.stringify(task));
    if (
      task.status !== 'completed' ||
      task.items.some((item) => item.status === 'conflict')
    )
      process.exitCode = 1;
  });
}

export const memoryCommand: CommandModule = {
  ...commandMetadata.memory,
  builder: (argv: Argv) =>
    argv
      .command({
        command: 'import <kind>',
        describe:
          'Preview Codex or worktree memory and confirm selected sections to consolidate',
        builder: (args: Argv) =>
          args
            .positional('kind', {
              type: 'string',
              describe: 'Memory source',
              choices: ['codex', 'worktree'],
            })
            .option('source', {
              type: 'string',
              describe:
                'Codex memories directory or old worktree checkout or memory directory',
            })
            .option('scope', {
              type: 'string',
              choices: ['git-root', 'workspace'],
              describe: 'Target project memory scope for a worktree import',
            })
            .option('dry-run', {
              type: 'boolean',
              default: false,
              describe: 'Offline preview; no model or memory writes',
            })
            .option('json', { type: 'boolean', default: false })
            .option('apply', {
              type: 'boolean',
              default: false,
              describe:
                'Authorize model consolidation of an explicit selection',
            })
            .option('selection', {
              type: 'string',
              describe:
                'Selection JSON file. Codex uses [{id, scope}]. Worktree uses {target, digest, selection: [{id, scope: "project"}]} with the preview target and digest.',
            })
            .option('idempotency-key', {
              type: 'string',
              describe: 'Stable caller key for this selection',
            })
            .option('retry', {
              type: 'boolean',
              default: false,
              describe: 'Retry unfinished items of this submitted batch',
            })
            .strict(),
        handler: async (args) => {
          ignoreBrokenPipe();
          if (args['apply'] && args['dry-run'])
            throw new Error('--apply and --dry-run cannot be combined.');
          if (
            args['apply'] &&
            (args['bare'] || args['safeMode'] || args['safe-mode'])
          )
            throw new Error(
              'Confirmed memory import is unavailable in bare or safe mode. Offline preview remains available.',
            );
          if (
            args['source'] !== undefined &&
            typeof args['source'] !== 'string'
          )
            throw new Error('Provide a single --source directory.');
          if (args['kind'] === 'worktree') return handleWorktreeImport(args);
          if (args['scope'] !== undefined)
            throw new Error('--scope is available for worktree imports.');
          const directory =
            typeof args['source'] === 'string'
              ? args['source']
              : path.join(
                  process.env['CODEX_HOME']?.trim() ||
                    path.join(homedir(), '.codex'),
                  'memories',
                );
          const source = await readLocalSource(directory);
          const preview = previewSource(source);
          if (!args['apply']) {
            if (args['json'])
              await writeStdoutLineFlushed(JSON.stringify(preview));
            else {
              const lines = [
                `Preview only: ${preview.sections.length} source sections. No memory was written.`,
                ...preview.groups.map(
                  (group) =>
                    `[${group.sectionIds.length} sections] ${group.scope}: ${JSON.stringify(group.sourceProject ?? 'No project hint')}`,
                ),
                `Estimated usage (all selectable sections): ${preview.estimate.modelCalls} model calls, ${preview.estimate.sourceTokens} source tokens, up to ${preview.estimate.maxOutputTokens} output tokens; ${preview.estimate.reservedTokens} reserved token units including context.`,
                `Task limits: ${preview.estimate.limits.maxCalls} calls / ${preview.estimate.limits.maxReservedTokens} reserved token units. Estimates are not billing quotes; explicit selection and existing context affect usage.`,
              ];
              if (preview.estimate.exceedsBudget)
                lines.push(
                  'Warning: the full selection may exceed the task budget; select fewer sections before confirming.',
                );
              for (const warning of preview.warnings)
                lines.push(`Warning: ${JSON.stringify(warning)}`);
              lines.push(
                'Use --json for section IDs, details and source text. To import, provide --apply --selection <JSON file> --idempotency-key <key>. Unassigned sections require an explicit scope.',
              );
              await writeStdoutLineFlushed(lines.join('\n'));
            }
            return;
          }
          if (
            typeof args['selection'] !== 'string' ||
            typeof args['idempotency-key'] !== 'string'
          )
            throw new Error(
              '--apply requires --selection and --idempotency-key.',
            );
          const selection = await selectionFile(args['selection']);
          const { createLocalMemoryImportService } = await import(
            '../memory-import/local.js'
          );
          const service = await createLocalMemoryImportService();
          let task = await service.submit(
            source,
            selection,
            args['idempotency-key'],
          );
          if (args['retry']) task = await service.retry(task.id);
          task = await service.idle(task.id);
          await writeStdoutLineFlushed(JSON.stringify(task));
          if (
            task.status !== 'completed' ||
            task.items.some((item) => item.status === 'conflict')
          )
            process.exitCode = 1;
        },
      })
      .demandCommand(1)
      .version(false),
  handler: () => {},
};
