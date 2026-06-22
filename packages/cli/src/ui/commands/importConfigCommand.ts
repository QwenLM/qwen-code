/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import {
  importClaudeMcpServers,
  type ClaudeMcpImportResult,
  type ClaudeMcpImportScope,
  type ClaudeMcpImportSource,
} from '../../config/claudeMcpImport.js';
import type {
  CommandContext,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';

const SOURCE_ALIASES: Record<string, ClaudeMcpImportSource> = {
  all: 'all',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  code: 'claude-code',
  desktop: 'claude-desktop',
  'claude-desktop': 'claude-desktop',
};

interface ParsedImportConfigArgs {
  source: ClaudeMcpImportSource;
  sourceExplicit: boolean;
  scope: ClaudeMcpImportScope;
  help: boolean;
  error?: string;
}

function parseSource(value: string): ClaudeMcpImportSource | undefined {
  return SOURCE_ALIASES[value.toLowerCase()];
}

function parseScope(value: string): ClaudeMcpImportScope | undefined {
  if (value === 'user' || value === 'project') {
    return value;
  }
  return undefined;
}

export function parseImportConfigArgs(args: string): ParsedImportConfigArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let source: ClaudeMcpImportSource = 'all';
  let sourceWasSet = false;
  let scope: ClaudeMcpImportScope = 'user';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--help' || token === '-h' || token === 'help') {
      return { source, sourceExplicit: sourceWasSet, scope, help: true };
    }

    if (token === '--from') {
      const value = tokens[++i];
      if (!value) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Missing value for --from.'),
        };
      }
      const parsed = parseSource(value);
      if (!parsed) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Unknown import source: {{source}}', { source: value }),
        };
      }
      source = parsed;
      sourceWasSet = true;
      continue;
    }

    if (token.startsWith('--from=')) {
      const value = token.slice('--from='.length);
      const parsed = parseSource(value);
      if (!parsed) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Unknown import source: {{source}}', { source: value }),
        };
      }
      source = parsed;
      sourceWasSet = true;
      continue;
    }

    if (token === '--scope' || token === '-s') {
      const value = tokens[++i];
      const parsed = value ? parseScope(value) : undefined;
      if (!parsed) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Expected --scope to be "user" or "project".'),
        };
      }
      scope = parsed;
      continue;
    }

    if (token.startsWith('--scope=')) {
      const value = token.slice('--scope='.length);
      const parsed = parseScope(value);
      if (!parsed) {
        return {
          source,
          sourceExplicit: sourceWasSet,
          scope,
          help: false,
          error: t('Expected --scope to be "user" or "project".'),
        };
      }
      scope = parsed;
      continue;
    }

    const parsed = parseSource(token);
    if (parsed && !sourceWasSet) {
      source = parsed;
      sourceWasSet = true;
      continue;
    }

    return {
      source,
      sourceExplicit: sourceWasSet,
      scope,
      help: false,
      error: t('Unknown argument: {{arg}}', { arg: token }),
    };
  }

  return { source, sourceExplicit: sourceWasSet, scope, help: false };
}

export function resolveImportSourceForScope(
  source: ClaudeMcpImportSource,
  scope: ClaudeMcpImportScope,
  sourceExplicit: boolean,
): ClaudeMcpImportSource {
  if (scope === 'project' && source === 'all' && !sourceExplicit) {
    return 'claude-code';
  }
  return source;
}

function usage(): string {
  return [
    t('Import MCP servers from Claude configs.'),
    '',
    t(
      'Usage: /import-config [all|claude-code|claude-desktop] [--scope user|project]',
    ),
    '',
    t('Examples:'),
    '  /import-config',
    '  /import-config claude-code',
    '  /import-config claude-desktop --scope user',
    '  /import-config --scope project',
  ].join('\n');
}

function formatNameList(names: string[]): string {
  if (names.length <= 6) {
    return names.join(', ');
  }
  return `${names.slice(0, 6).join(', ')} +${names.length - 6} more`;
}

export function formatClaudeMcpImportResult(
  result: ClaudeMcpImportResult,
): MessageActionReturn {
  const target = result.scope === 'user' ? 'user' : 'project';
  const importedNames = result.imported.map((entry) => entry.name);
  const skippedExisting = result.skipped
    .filter((entry) => entry.reason === 'already-exists')
    .map((entry) => entry.name);
  const skippedReserved = result.skipped
    .filter((entry) => entry.reason === 'reserved-name')
    .map((entry) => entry.name);
  const checkedPaths = result.scanned.map((entry) => entry.path);
  const lines: string[] = [];

  if (result.imported.length > 0) {
    lines.push(
      t('Imported {{count}} MCP server(s) to {{scope}} settings: {{names}}', {
        count: String(result.imported.length),
        scope: target,
        names: formatNameList(importedNames),
      }),
    );
  } else {
    lines.push(
      t('No new Claude MCP servers imported into {{scope}} settings.', {
        scope: target,
      }),
    );
  }

  if (skippedExisting.length > 0) {
    lines.push(
      t('Skipped existing server(s): {{names}}', {
        names: formatNameList([...new Set(skippedExisting)]),
      }),
    );
  }

  if (skippedReserved.length > 0) {
    lines.push(
      t('Skipped unsupported server name(s): {{names}}', {
        names: formatNameList([...new Set(skippedReserved)]),
      }),
    );
  }

  if (result.errors.length > 0) {
    lines.push('', t('Warnings:'));
    lines.push(...result.errors.map((error) => `  - ${error}`));
  }

  if (
    result.imported.length === 0 &&
    result.skipped.length === 0 &&
    result.errors.length === 0
  ) {
    lines.push('', t('Checked:'));
    lines.push(...checkedPaths.map((filePath) => `  - ${filePath}`));
  }

  const messageType =
    result.errors.length > 0 || result.skipped.length > 0 ? 'warning' : 'info';

  return {
    type: 'message',
    messageType,
    content: lines.join('\n'),
  };
}

export const importConfigCommand: SlashCommand = {
  name: 'import-config',
  get description() {
    return t('Import MCP servers from Claude configs');
  },
  argumentHint: '[all|claude-code|claude-desktop] [--scope user|project]',
  examples: [
    '/import-config',
    '/import-config claude-code',
    '/import-config claude-desktop --scope user',
    '/import-config --scope project',
  ],
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const parsed = parseImportConfigArgs(args);
    if (parsed.help) {
      return {
        type: 'message',
        messageType: 'info',
        content: usage(),
      };
    }

    if (parsed.error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `${parsed.error}\n\n${usage()}`,
      };
    }

    try {
      const importSource = resolveImportSourceForScope(
        parsed.source,
        parsed.scope,
        parsed.sourceExplicit,
      );
      const result = importClaudeMcpServers({
        source: importSource,
        scope: parsed.scope,
        settings: context.services.settings,
        cwd: context.services.config?.getTargetDir() ?? process.cwd(),
      });
      return formatClaudeMcpImportResult(result);
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          error instanceof Error
            ? error.message
            : t('Import failed: {{error}}', {
                error: String(error),
              }),
      };
    }
  },
  completion: async (_context, partialArg) => {
    const current = partialArg.trimStart();
    const candidates = [
      'all',
      'claude-code',
      'claude-desktop',
      '--scope user',
      '--scope project',
    ];
    return candidates.filter((candidate) => candidate.startsWith(current));
  },
};
