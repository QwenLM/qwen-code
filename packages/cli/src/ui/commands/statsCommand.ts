/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  type CommandContext,
  type SlashCommand,
  type MessageActionReturn,
  type OpenDialogActionReturn,
  CommandKind,
} from './types.js';
import { getCurrentLanguage, t } from '../../i18n/index.js';
import { calculateCost } from '../../utils/costCalculator.js';
import {
  exportTokenUsageSummary,
  isSubpath,
  queryTokenUsage,
  type TokenUsageExportFormat,
  type TokenUsageGroupSummary,
  type TokenUsagePeriod,
  type TokenUsageSummary,
} from '@qwen-code/qwen-code-core';

const VALID_EXPORT_FORMATS = new Set<TokenUsageExportFormat>(['csv', 'json']);

type ParsedStatsExportArgs = {
  period: TokenUsagePeriod;
  value?: string;
  format: TokenUsageExportFormat;
  outputPath?: string;
};

function formatInteger(value: number): string {
  return new Intl.NumberFormat(getCurrentLanguage()).format(value);
}

function formatGroupLines(
  titleKey: string,
  groups: TokenUsageGroupSummary[],
): string[] {
  if (groups.length === 0) {
    return [t(titleKey), `  ${t('No usage data.')}`];
  }
  return [
    t(titleKey),
    ...groups.map((group) => {
      const label =
        group.model && group.authType
          ? `${group.model} (${group.authType})`
          : group.model || group.authType || group.source || group.key;
      return `  ${t('{{label}}: {{tokens}} tokens ({{requests}} requests)', {
        label,
        tokens: formatInteger(group.totalTokens),
        requests: formatInteger(group.requests),
      })}`;
    }),
  ];
}

function formatTokenUsageSummary(summary: TokenUsageSummary): string {
  const label =
    summary.period === 'day'
      ? t('Daily token usage for {{value}}', { value: summary.value })
      : t('Monthly token usage for {{value}}', { value: summary.value });

  return [
    label,
    t('Total: {{tokens}} tokens', {
      tokens: formatInteger(summary.totals.totalTokens),
    }),
    t('Requests: {{requests}}', {
      requests: formatInteger(summary.totals.requests),
    }),
    '',
    t('Breakdown:'),
    `  ${t('Input: {{tokens}}', {
      tokens: formatInteger(summary.totals.inputTokens),
    })}`,
    `  ${t('Output: {{tokens}}', {
      tokens: formatInteger(summary.totals.outputTokens),
    })}`,
    `  ${t('Cached (included in Input): {{tokens}}', {
      tokens: formatInteger(summary.totals.cachedTokens),
    })}`,
    `  ${t('Thoughts: {{tokens}}', {
      tokens: formatInteger(summary.totals.thoughtsTokens),
    })}`,
    '',
    ...formatGroupLines('By model:', summary.byModel),
    '',
    ...formatGroupLines('By auth type:', summary.byAuthType),
    '',
    ...formatGroupLines('By model/auth type:', summary.byModelAndAuthType),
    '',
    ...formatGroupLines('By source:', summary.bySource),
    '',
    t('Note: generation timing (TTFT/TPS) belongs to generation metrics.'),
  ].join('\n');
}

function asMessage(
  content: string,
  messageType: MessageActionReturn['messageType'] = 'info',
): MessageActionReturn {
  return {
    type: 'message',
    messageType,
    content,
  };
}

function addInteractiveMessage(
  context: CommandContext,
  content: string,
  type: MessageType.INFO | MessageType.ERROR = MessageType.INFO,
): void {
  context.ui.addItem(
    {
      type,
      text: content,
    },
    Date.now(),
  );
}

async function showTokenUsageStats(
  context: CommandContext,
  period: TokenUsagePeriod,
  args: string,
): Promise<MessageActionReturn | void> {
  try {
    const value = args.trim() || undefined;
    const summary = await queryTokenUsage({ period, value });
    const content = formatTokenUsageSummary(summary);
    if (context.executionMode !== 'interactive') {
      return asMessage(content);
    }
    addInteractiveMessage(context, content);
  } catch (error) {
    const content = t('Failed to load token usage stats: {{error}}', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (context.executionMode !== 'interactive') {
      return asMessage(content, 'error');
    }
    addInteractiveMessage(context, content, MessageType.ERROR);
  }
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < args.length; index++) {
    const char = args[index]!;
    if (quote) {
      if (char === '\\') {
        if (args[index + 1] === quote) {
          current += quote;
          index++;
        } else {
          current += char;
        }
        continue;
      }
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote !== undefined) {
    throw new Error(t('Unclosed quote in arguments.'));
  }
  if (quote !== undefined) {
    throw new Error(t('Unclosed quote in arguments.'));
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function statsExportPathError(): MessageActionReturn {
  return asMessage(
    t('Token usage export path must be within the project working directory.'),
    'error',
  );
}

function statsExportTargetMissingError(
  targetPath: string,
): MessageActionReturn {
  return asMessage(
    t('Export target does not exist: {{path}}', { path: targetPath }),
    'error',
  );
}

async function realpathNearestExisting(
  targetDirectory: string,
  cwd: string,
): Promise<string> {
  let currentDirectory = targetDirectory;

  while (isSubpath(cwd, currentDirectory)) {
    try {
      return await fs.realpath(currentDirectory);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      const parentDirectory = path.dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        break;
      }
      currentDirectory = parentDirectory;
    }
  }

  throw new Error(
    t('Cannot resolve export path within the working directory.'),
  );
}

async function validateStatsExportExistingParent(
  cwd: string,
  outputDirectory: string,
): Promise<MessageActionReturn | undefined> {
  const [realCwd, realExistingParent] = await Promise.all([
    fs.realpath(cwd),
    realpathNearestExisting(outputDirectory, cwd),
  ]);

  if (!isSubpath(realCwd, realExistingParent)) {
    return statsExportPathError();
  }

  return undefined;
}

async function validateStatsExportDirectory(
  cwd: string,
  outputDirectory: string,
): Promise<MessageActionReturn | undefined> {
  const [realCwd, realOutputDirectory] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(outputDirectory),
  ]);

  if (!isSubpath(realCwd, realOutputDirectory)) {
    return statsExportPathError();
  }

  return undefined;
}

function validateStatsExportPathShape(
  targetPath: string,
): MessageActionReturn | undefined {
  // Avoid Windows alternate data streams such as "report.csv:secret".
  if (process.platform === 'win32' && path.basename(targetPath).includes(':')) {
    return statsExportPathError();
  }

  return undefined;
}

async function validateStatsExportFileTarget(
  targetPath: string,
): Promise<MessageActionReturn | undefined> {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return statsExportPathError();
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  return undefined;
}

async function validateStatsExportFinalFile(
  cwd: string,
  targetPath: string,
): Promise<MessageActionReturn | undefined> {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return statsExportTargetMissingError(targetPath);
    }
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return statsExportPathError();
  }

  const [realCwd, realTargetPath] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(targetPath),
  ]);

  if (!isSubpath(realCwd, realTargetPath)) {
    return statsExportPathError();
  }

  return undefined;
}

function createTemporaryExportPath(
  outputDirectory: string,
  targetPath: string,
): string {
  return path.join(
    outputDirectory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
}

function isSamePath(leftPath: string, rightPath: string): boolean {
  return isSubpath(leftPath, rightPath) && isSubpath(rightPath, leftPath);
}

async function validateStatsExportDirectoryIdentity(
  cwd: string,
  outputDirectory: string,
  expectedRealOutputDirectory: string,
): Promise<MessageActionReturn | undefined> {
  const [realCwd, realOutputDirectory] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(outputDirectory),
  ]);

  if (
    !isSubpath(realCwd, realOutputDirectory) ||
    !isSamePath(expectedRealOutputDirectory, realOutputDirectory)
  ) {
    return statsExportPathError();
  }

  return undefined;
}

async function writeStatsExportFileAtomically(
  cwd: string,
  outputDirectory: string,
  targetPath: string,
  content: string,
): Promise<MessageActionReturn | undefined> {
  const initialDirectoryError = await validateStatsExportDirectory(
    cwd,
    outputDirectory,
  );
  if (initialDirectoryError) {
    return initialDirectoryError;
  }

  const [realCwd, realOutputDirectory] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(outputDirectory),
  ]);
  const realTargetPath = path.join(
    realOutputDirectory,
    path.basename(targetPath),
  );

  if (!isSubpath(realCwd, realTargetPath)) {
    return statsExportPathError();
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    let tempPath: string | undefined = createTemporaryExportPath(
      realOutputDirectory,
      targetPath,
    );

    try {
      if (!isSubpath(realCwd, tempPath)) {
        return statsExportPathError();
      }

      const preTempDirectoryError = await validateStatsExportDirectoryIdentity(
        cwd,
        outputDirectory,
        realOutputDirectory,
      );
      if (preTempDirectoryError) {
        return preTempDirectoryError;
      }

      const preTempFileError =
        await validateStatsExportFileTarget(realTargetPath);
      if (preTempFileError) {
        return preTempFileError;
      }

      const file = await fs.open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(content, { encoding: 'utf-8' });
      } finally {
        await file.close();
      }

      const tempFileError = await validateStatsExportFinalFile(cwd, tempPath);
      if (tempFileError) {
        return tempFileError;
      }

      const preRenameDirectoryError =
        await validateStatsExportDirectoryIdentity(
          cwd,
          outputDirectory,
          realOutputDirectory,
        );
      if (preRenameDirectoryError) {
        return preRenameDirectoryError;
      }

      const preRenameFileError =
        await validateStatsExportFileTarget(realTargetPath);
      if (preRenameFileError) {
        return preRenameFileError;
      }

      await fs.rename(tempPath, realTargetPath);
      tempPath = undefined;

      return validateStatsExportFinalFile(cwd, realTargetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    } finally {
      if (tempPath) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
  }

  throw new Error(t('Could not create a temporary export file.'));
}

function parseStatsExportArgs(args: string): ParsedStatsExportArgs {
  const tokens = tokenizeArgs(args);
  let period: TokenUsagePeriod | undefined;
  let value: string | undefined;
  let format: TokenUsageExportFormat = 'csv';
  let outputPath: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--format' || token === '-f') {
      const next = tokens[++index];
      if (!next || !VALID_EXPORT_FORMATS.has(next as TokenUsageExportFormat)) {
        throw new Error(t('Expected --format csv or --format json.'));
      }
      format = next as TokenUsageExportFormat;
      continue;
    }
    if (token.startsWith('--format=')) {
      const next = token.slice('--format='.length);
      if (!VALID_EXPORT_FORMATS.has(next as TokenUsageExportFormat)) {
        throw new Error(t('Expected --format csv or --format json.'));
      }
      format = next as TokenUsageExportFormat;
      continue;
    }
    if (token === '--output' || token === '-o') {
      const next = tokens[++index];
      if (!next) {
        throw new Error(t('Expected a file path after --output.'));
      }
      outputPath = next;
      continue;
    }
    if (token.startsWith('--output=')) {
      outputPath = token.slice('--output='.length);
      continue;
    }
    if (!period && (token === 'daily' || token === 'day')) {
      period = 'day';
      continue;
    }
    if (!period && (token === 'monthly' || token === 'month')) {
      period = 'month';
      continue;
    }
    if (!value) {
      value = token;
      continue;
    }
    if (!outputPath) {
      outputPath = token;
      continue;
    }
    throw new Error(
      t('Unexpected argument: {{argument}}', { argument: token }),
    );
  }

  if (!period) {
    throw new Error(
      t(
        'Usage: /stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]',
      ),
    );
  }

  return {
    period,
    value,
    format,
    outputPath,
  };
}

function getConfigCwd(context: CommandContext): string {
  const config = context.services.config;
  return config?.getWorkingDir() || config?.getProjectRoot() || process.cwd();
}

async function writeStatsExport(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  try {
    const parsed = parseStatsExportArgs(args);
    const summary = await queryTokenUsage({
      period: parsed.period,
      value: parsed.value,
    });
    const content = await exportTokenUsageSummary({
      period: summary.period,
      value: summary.value,
      format: parsed.format,
    });
    const cwd = path.resolve(getConfigCwd(context));
    const defaultFilename = `qwen-token-usage-${summary.period}-${summary.value}.${parsed.format}`;
    const targetPath = path.resolve(cwd, parsed.outputPath || defaultFilename);
    const outputDirectory = path.dirname(targetPath);

    if (!isSubpath(cwd, targetPath) || !isSubpath(cwd, outputDirectory)) {
      return statsExportPathError();
    }

    const pathShapeError = validateStatsExportPathShape(targetPath);
    if (pathShapeError) {
      return pathShapeError;
    }

    const parentError = await validateStatsExportExistingParent(
      cwd,
      outputDirectory,
    );
    if (parentError) {
      return parentError;
    }

    await fs.mkdir(outputDirectory, { recursive: true });

    const postMkdirError = await validateStatsExportDirectory(
      cwd,
      outputDirectory,
    );
    if (postMkdirError) {
      return postMkdirError;
    }

    const preWriteFileError = await validateStatsExportFileTarget(targetPath);
    if (preWriteFileError) {
      return preWriteFileError;
    }

    const writeError = await writeStatsExportFileAtomically(
      cwd,
      outputDirectory,
      targetPath,
      content,
    );
    if (writeError) {
      return writeError;
    }

    return asMessage(
      t('Token usage exported to {{format}}: {{path}}', {
        format: parsed.format.toUpperCase(),
        path: path.relative(cwd, targetPath),
      }),
    );
  } catch (error) {
    return asMessage(
      t('Failed to export token usage stats: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      }),
      'error',
    );
  }
}

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  get description() {
    return t('Show usage statistics dashboard.');
  },
  argumentHint: '[model|tools|daily|monthly|export]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: (
    context: CommandContext,
  ): OpenDialogActionReturn | MessageActionReturn | void => {
    if (context.executionMode !== 'interactive') {
      const now = new Date();
      const { sessionStartTime, promptCount, metrics } = context.session.stats;
      const wallDuration = sessionStartTime
        ? now.getTime() - sessionStartTime.getTime()
        : 0;
      let totalPromptTokens = 0;
      let totalCandidateTokens = 0;
      let totalRequests = 0;
      for (const modelMetrics of Object.values(metrics.models)) {
        totalPromptTokens += modelMetrics.tokens.prompt;
        totalCandidateTokens += modelMetrics.tokens.candidates;
        totalRequests += modelMetrics.api.totalRequests;
      }
      return {
        type: 'message',
        messageType: 'info',
        content: [
          t('Session duration: {{duration}}', {
            duration: formatDuration(wallDuration),
          }),
          t('Prompts: {{count}}', { count: String(promptCount) }),
          t('API requests: {{count}}', { count: String(totalRequests) }),
          t('Tokens — prompt: {{prompt}}, output: {{output}}', {
            prompt: String(totalPromptTokens),
            output: String(totalCandidateTokens),
          }),
          t('Tool calls: {{total}} ({{success}} ok, {{fail}} fail)', {
            total: String(metrics.tools.totalCalls),
            success: String(metrics.tools.totalSuccess),
            fail: String(metrics.tools.totalFail),
          }),
          t('Files: +{{added}} / -{{removed}} lines', {
            added: String(metrics.files.totalLinesAdded),
            removed: String(metrics.files.totalLinesRemoved),
          }),
        ].join('\n'),
      };
    }

    return { type: 'dialog', dialog: 'stats' };
  },
  subCommands: [
    {
      name: 'model',
      get description() {
        return t('Show model-specific usage statistics.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext): MessageActionReturn | void => {
        if (context.executionMode !== 'interactive') {
          const { metrics } = context.session.stats;
          const pricing = context.services.settings.merged.modelPricing;
          const lines: string[] = [];
          for (const [modelName, modelMetrics] of Object.entries(
            metrics.models,
          )) {
            lines.push(
              `${modelName}: ${t('prompt')}=${modelMetrics.tokens.prompt}, ${t('output')}=${modelMetrics.tokens.candidates}, ${t('cached')}=${modelMetrics.tokens.cached}`,
            );
            const cost = calculateCost({
              inputTokens: modelMetrics.tokens.prompt,
              outputTokens:
                modelMetrics.tokens.candidates + modelMetrics.tokens.thoughts,
              pricing: pricing?.[modelName],
            });
            if (cost != null) {
              lines.push(
                `  ${t('Estimated cost: ${{cost}}', { cost: cost.toFixed(4) })}`,
              );
            }
          }
          if (lines.length === 0) {
            lines.push(t('No model usage data yet.'));
          }
          return {
            type: 'message',
            messageType: 'info',
            content: lines.join('\n'),
          };
        }
        context.ui.addItem(
          {
            type: MessageType.MODEL_STATS,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'tools',
      get description() {
        return t('Show tool-specific usage statistics.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext): MessageActionReturn | void => {
        if (context.executionMode !== 'interactive') {
          const { metrics } = context.session.stats;
          const { tools } = metrics;
          const toolNames = Object.keys(tools.byName);
          const content =
            toolNames.length > 0
              ? [
                  t('Tool calls: {{total}} ({{success}} ok, {{fail}} fail)', {
                    total: String(tools.totalCalls),
                    success: String(tools.totalSuccess),
                    fail: String(tools.totalFail),
                  }),
                  ...toolNames.map((name) => `  ${name}`),
                ].join('\n')
              : t('No tool usage data yet.');
          return { type: 'message', messageType: 'info', content };
        }
        context.ui.addItem(
          {
            type: MessageType.TOOL_STATS,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'daily',
      altNames: ['day'],
      get description() {
        return t('Show daily token usage statistics.');
      },
      argumentHint: '[YYYY-MM-DD]',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext, args: string) =>
        showTokenUsageStats(context, 'day', args),
    },
    {
      name: 'monthly',
      altNames: ['month'],
      get description() {
        return t('Show monthly token usage statistics.');
      },
      argumentHint: '[YYYY-MM]',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: (context: CommandContext, args: string) =>
        showTokenUsageStats(context, 'month', args),
    },
    {
      name: 'export',
      get description() {
        return t('Export token usage statistics to CSV or JSON.');
      },
      argumentHint:
        '<daily|monthly> [date|month] [--format csv|json] [--output path]',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn | void> => {
        const result = await writeStatsExport(context, args);
        if (context.executionMode !== 'interactive') {
          return result;
        }
        addInteractiveMessage(
          context,
          result.content,
          result.messageType === 'error' ? MessageType.ERROR : MessageType.INFO,
        );
      },
    },
  ],
};
