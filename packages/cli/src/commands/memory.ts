/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Argv, CommandModule } from 'yargs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { previewSource, readLocalSource } from '../memory-import/source.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

// The JSON envelopes are the result of this command; exiting on an
// unflushed async write truncates them on a pipe.
const writeStdoutLineFlushed = (message: string): Promise<void> =>
  new Promise((resolve, reject) =>
    process.stdout.write(
      message.endsWith('\n') ? message : `${message}\n`,
      (error) => (error ? reject(error) : resolve()),
    ),
  );

export const memoryCommand: CommandModule = {
  command: 'memory',
  describe: 'Preview and import external memories',
  builder: (argv: Argv) =>
    argv
      .command({
        command: 'import codex',
        describe:
          'Preview Codex memory; explicitly confirm selected sections to consolidate',
        builder: (args: Argv) =>
          args
            .positional('codex', {
              type: 'string',
              describe: 'External memory source',
              choices: ['codex'],
            })
            .option('source', {
              type: 'string',
              describe: 'Codex memories directory',
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
              describe: 'JSON array of {id, scope: project|user}',
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
              writeStdoutLine(
                `Preview only: ${preview.sections.length} source sections. No memory was written.`,
              );
              for (const group of preview.groups)
                writeStdoutLine(
                  `[${group.sectionIds.length} sections] ${group.scope}: ${JSON.stringify(group.sourceProject ?? 'No project hint')}`,
                );
              writeStdoutLine(
                `Estimated usage (all selectable sections): ${preview.estimate.modelCalls} model calls, ${preview.estimate.sourceTokens} source tokens, up to ${preview.estimate.maxOutputTokens} output tokens; ${preview.estimate.reservedTokens} reserved token units including context.`,
              );
              writeStdoutLine(
                `Task limits: ${preview.estimate.limits.maxCalls} calls / ${preview.estimate.limits.maxReservedTokens} reserved token units. Estimates are not billing quotes; explicit selection and existing context affect usage.`,
              );
              if (preview.estimate.exceedsBudget)
                writeStdoutLine(
                  'Warning: the full selection may exceed the task budget; select fewer sections before confirming.',
                );
              for (const warning of preview.warnings)
                writeStdoutLine(`Warning: ${JSON.stringify(warning)}`);
              writeStdoutLine(
                'Use --json for section IDs, details and source text. To import, provide --apply --selection <JSON file> --idempotency-key <key>. Unassigned sections require an explicit scope.',
              );
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
          const stat = await fs.lstat(args['selection']);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
            throw new Error('Selection must be a bounded regular JSON file.');
          const selection: unknown = JSON.parse(
            await fs.readFile(args['selection'], 'utf8'),
          );
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
