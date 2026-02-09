/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The /codebase command for managing codebase indexing.
 * Provides subcommands for status, rebuild, pause, and resume operations.
 */

import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Formats a progress percentage for display.
 */
function formatProgress(progress: number): string {
  return `${Math.round(progress)}%`;
}

/**
 * Formats a status for display.
 */
function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    idle: 'Idle',
    scanning: 'Scanning files',
    chunking: 'Processing chunks',
    embedding: 'Generating embeddings',
    storing: 'Storing vectors',
    done: 'Complete',
    error: 'Error',
    paused: 'Paused',
  };
  return statusMap[status] ?? status;
}

/**
 * Formats duration in milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export const codebaseCommand: SlashCommand = {
  name: 'codebase',
  altNames: ['index'],
  get description() {
    return t(
      'Manage codebase indexing. Usage: /codebase [status|rebuild|pause|resume]',
    );
  },
  kind: CommandKind.BUILT_IN,

  action: async (context: CommandContext) => {
    // Default action shows status
    const service = context.services.config?.getIndexService();

    if (!service) {
      context.ui.addItem(
        {
          type: MessageType.WARNING,
          text: t(
            'Codebase indexing is not available. Initialize with /codebase rebuild',
          ),
        },
        Date.now(),
      );
      return;
    }

    const progress = service.getStatus();
    const statusText = [
      `Status: ${formatStatus(progress.status)}`,
      `Progress: ${formatProgress(progress.overallProgress)}`,
      progress.totalFiles > 0
        ? `Files: ${progress.scannedFiles}/${progress.totalFiles}`
        : null,
      progress.totalChunks > 0
        ? `Chunks: ${progress.embeddedChunks}/${progress.totalChunks}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: statusText,
      },
      Date.now(),
    );
  },

  subCommands: [
    {
      name: 'status',
      get description() {
        return t('Show current indexing status and progress.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const service = context.services.config?.getIndexService();

        if (!service) {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t('Codebase indexing is not initialized.'),
            },
            Date.now(),
          );
          return;
        }

        const progress = service.getStatus();
        const startTime = progress.startTime || 0;
        const elapsed = startTime > 0 ? Date.now() - startTime : 0;

        const lines = [
          `Index Status: ${formatStatus(progress.status)}`,
          `Overall Progress: ${formatProgress(progress.overallProgress)}`,
          '',
          'Details:',
          `  Files scanned: ${progress.scannedFiles}/${progress.totalFiles}`,
          `  Files chunked: ${progress.chunkedFiles}`,
          `  Chunks processed: ${progress.embeddedChunks}/${progress.totalChunks}`,
          `  Vectors stored: ${progress.storedChunks}`,
        ];

        if (elapsed > 0) {
          lines.push(`  Elapsed time: ${formatDuration(elapsed)}`);
        }

        if (progress.estimatedTimeRemaining) {
          lines.push(
            `  Estimated remaining: ${formatDuration(progress.estimatedTimeRemaining)}`,
          );
        }

        if (progress.error) {
          lines.push('', `Error: ${progress.error}`);
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: lines.join('\n'),
          },
          Date.now(),
        );
      },
    },
    {
      name: 'rebuild',
      altNames: ['build'],
      get description() {
        return t('Rebuild the entire codebase index from scratch.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const service = context.services.config?.getIndexService();

        if (!service) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Codebase indexing service is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const progress = service.getStatus();
        if (
          progress.status !== 'idle' &&
          progress.status !== 'done' &&
          progress.status !== 'error'
        ) {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t(
                'Index build is already in progress. Use /codebase status to check progress.',
              ),
            },
            Date.now(),
          );
          return;
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Starting codebase index rebuild...'),
          },
          Date.now(),
        );

        try {
          await service.startBuild();
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Failed to start index rebuild: ') + String(error),
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'pause',
      get description() {
        return t('Pause the current indexing operation.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const service = context.services.config?.getIndexService();

        if (!service) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Codebase indexing service is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const progress = service.getStatus();
        if (progress.status === 'paused') {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t('Indexing is already paused.'),
            },
            Date.now(),
          );
          return;
        }

        if (progress.status === 'idle' || progress.status === 'done') {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t('No indexing operation in progress.'),
            },
            Date.now(),
          );
          return;
        }

        try {
          service.pause();
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t('Indexing paused. Use /codebase resume to continue.'),
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Failed to pause indexing: ') + String(error),
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'resume',
      get description() {
        return t('Resume a paused indexing operation.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const service = context.services.config?.getIndexService();

        if (!service) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Codebase indexing service is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const progress = service.getStatus();
        if (progress.status !== 'paused') {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t('Indexing is not paused.'),
            },
            Date.now(),
          );
          return;
        }

        try {
          service.resume();
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: t('Indexing resumed.'),
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Failed to resume indexing: ') + String(error),
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'search',
      altNames: ['query', 'find'],
      get description() {
        return t(
          'Search the codebase index. Usage: /codebase search <query> [--rerank] [--graph] [--top <n>]',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const service = context.services.config?.getIndexService();

        if (!service) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Codebase indexing is not available. Run /codebase rebuild first.',
              ),
            },
            Date.now(),
          );
          return;
        }

        const progress = service.getStatus();
        if (progress.status !== 'done') {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text:
                t('Index is not ready. Current status: ') +
                formatStatus(progress.status),
            },
            Date.now(),
          );
          return;
        }

        // Parse arguments: /codebase search <query> [options]
        // invocation.args contains the string after the subcommand (e.g., "search query --hyde")
        const argsString = context.invocation?.args ?? '';
        // Remove the subcommand name if present and split into tokens
        const argsWithoutSubcmd = argsString.replace(/^search\s*/i, '').trim();
        const args = argsWithoutSubcmd ? argsWithoutSubcmd.split(/\s+/) : [];
        if (args.length === 0) {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t(
                'Usage: /codebase search <query> [--rerank] [--graph] [--top <n>]\n\nOptions:\n --rerank  Enable result reranking\n  --graph   Include dependency graph\n  --top <n> Number of results (default: 20)',
              ),
            },
            Date.now(),
          );
          return;
        }

        // Parse options from args
        const queryParts: string[] = [];
        let enableRerank = false;
        let enableGraph = false;
        let topK = 20;

        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === '--rerank') {
            enableRerank = true;
          } else if (arg === '--graph') {
            enableGraph = true;
          } else if (arg === '--top' && i + 1 < args.length) {
            topK = parseInt(args[i + 1] ?? '20', 20) || 20;
            i++;
          } else if (!arg?.startsWith('--')) {
            queryParts.push(arg ?? '');
          }
        }

        const query = queryParts.join(' ').trim();
        if (!query) {
          context.ui.addItem(
            {
              type: MessageType.WARNING,
              text: t('Please provide a search query.'),
            },
            Date.now(),
          );
          return;
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text:
              t('Searching codebase for: ') +
              `"${query}"` +
              (enableRerank ? ' [Rerank]' : '') +
              (enableGraph ? ' [Graph]' : ''),
          },
          Date.now(),
        );

        try {
          const startTime = performance.now();

          // Get retrieval service and perform search
          const retrievalService = await service.getRetrievalServiceAsync();
          if (!retrievalService) {
            context.ui.addItem(
              {
                type: MessageType.ERROR,
                text: t('Retrieval service is not available.'),
              },
              Date.now(),
            );
            return;
          }

          const result = await retrievalService.retrieve(query, {
            topK,
            enableGraph,
          });

          const elapsed = performance.now() - startTime;

          if (result.chunks.length === 0) {
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: t('No results found for: ') + `"${query}"`,
              },
              Date.now(),
            );
            return;
          }

          // Format results
          const lines: string[] = [
            `Found ${result.chunks.length} result(s) in ${formatDuration(elapsed)}:`,
            '',
          ];

          for (let i = 0; i < result.chunks.length; i++) {
            const chunk = result.chunks[i];
            if (!chunk) continue;

            const sourceInfo =
              'sources' in chunk
                ? ` [${(chunk as { sources: string[] }).sources.join(', ')}]`
                : '';
            const scoreInfo =
              'fusedScore' in chunk
                ? ` (score: ${((chunk as { fusedScore: number }).fusedScore * 100).toFixed(1)})`
                : '';

            lines.push(
              `${i + 1}. ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}${sourceInfo}${scoreInfo}`,
            );

            // Show preview of content (first 2 lines)
            const preview = chunk.content.split('\n').slice(0, 2).join('\n');
            lines.push(
              `   ${preview.substring(0, 100)}${preview.length > 100 ? '...' : ''}`,
            );
            lines.push('');
          }

          // Add graph info if available
          if (result.subgraph && result.subgraph.entities.length > 0) {
            lines.push('');
            lines.push(
              `Dependency Graph: ${result.subgraph.entities.length} entities, ${result.subgraph.relations.length} relations`,
            );
          }

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: lines.join('\n'),
            },
            Date.now(),
          );

          // Optionally show the full context view
          if (result.textView) {
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: '--- Context View ---\n' + result.textView,
              },
              Date.now(),
            );
          }
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Search failed: ') + String(error),
            },
            Date.now(),
          );
        }
      },
    },
  ],

  completion: async (_context: CommandContext, partialArg: string) => {
    const subcommands = ['status', 'rebuild', 'pause', 'resume', 'search'];
    if (!partialArg) {
      return subcommands;
    }
    return subcommands.filter((cmd) =>
      cmd.startsWith(partialArg.toLowerCase()),
    );
  },
};
