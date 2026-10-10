/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import type { ModValidationReport } from '@qwen-code/qwen-code-core/mods/mod-types.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

interface ValidateModsArgs {
  path: string;
  json?: boolean;
}

const safeText = stripAnsiAndControl;

export function formatModReport(report: ModValidationReport): string {
  const lines = [
    `Mod: ${report.discovery}`,
    `Static: ${report.static.status}`,
    `Runtime: ${report.runtime}`,
    `Target: ${report.target}`,
  ];
  if (report.entry) lines.push(`Entry: ${safeText(report.entry)}`);
  for (const requirement of report.requirements) {
    const location = requirement.file
      ? ` ${safeText(requirement.file)}${requirement.line ? `:${requirement.line}:${requirement.column ?? 1}` : ''}`
      : '';
    const matcher =
      requirement.matcher === undefined
        ? ''
        : ` matcher=${safeText(requirement.matcher)}`;
    lines.push(
      `${safeText(requirement.kind)}: ${safeText(requirement.name)} (${safeText(requirement.stage)})${location}${matcher}${requirement.hasCatch ? ' catch' : ''}`,
    );
  }
  for (const diagnostic of report.diagnostics) {
    const location = diagnostic.file
      ? ` ${safeText(diagnostic.file)}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ''}`
      : '';
    lines.push(
      `${diagnostic.severity} ${diagnostic.code}${location}: ${safeText(diagnostic.message)}`,
    );
  }
  return lines.join('\n');
}

export async function handleValidateMods(
  args: ValidateModsArgs,
): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.stdout.destroy();
    else throw error;
  });
  const { validateMods } = await import(
    '@qwen-code/qwen-code-core/mods/mod-validation.js'
  );
  const report = await validateMods(args.path);
  try {
    writeStdoutLine(
      args.json ? JSON.stringify(report) : formatModReport(report),
    );
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EPIPE'
    )
      throw error;
  }
  process.exitCode =
    report.static.status === 'invalid' || report.static.status === 'incomplete'
      ? 1
      : 0;
}

export const validateModsCommand: CommandModule = {
  command: 'validate-mods <path>',
  describe: 'Inspect local Mod declarations without executing plugin code.',
  builder: (yargs) =>
    yargs
      .positional('path', {
        type: 'string',
        describe: 'Local plugin directory.',
      })
      .option('json', { type: 'boolean', default: false })
      .strict(),
  handler: async (args) => {
    await handleValidateMods({
      path: args['path'] as string,
      json: args['json'] as boolean,
    });
  },
};
