/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const EXPORT_PARENT_COMMAND_NAME = 'export' as const;

export const EXPORT_PARENT_COMMAND_DESCRIPTION =
  'Export current session to a file. Available formats: html, md, json, jsonl.';

export const EXPORT_SESSION_FORMATS = ['html', 'md', 'json', 'jsonl'] as const;

export type SessionExportFormat = (typeof EXPORT_SESSION_FORMATS)[number];

export const EXPORT_SUBCOMMAND_SPECS: ReadonlyArray<{
  name: SessionExportFormat;
  description: string;
}> = [
  { name: 'html', description: 'Export session to HTML format' },
  { name: 'md', description: 'Export session to markdown format' },
  { name: 'json', description: 'Export session to JSON format' },
  {
    name: 'jsonl',
    description: 'Export session to JSONL format (one message per line)',
  },
];

export function isSessionExportFormat(
  value: string,
): value is SessionExportFormat {
  return EXPORT_SESSION_FORMATS.includes(value as SessionExportFormat);
}

export function getExportSubcommandRequiredMessage(): string {
  const availableLines = EXPORT_SUBCOMMAND_SPECS.map(
    (subcommand) => `  - ${subcommand.name}: ${subcommand.description}`,
  );
  return `Command '/${EXPORT_PARENT_COMMAND_NAME}' requires a subcommand. Available:\n${availableLines.join('\n')}`;
}
