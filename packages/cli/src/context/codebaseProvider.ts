/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context provider for @codebase queries.
 * Implements a prompt processor that intercepts @codebase{query} syntax
 * and injects relevant code snippets from the codebase index.
 */

import { flatMapTextParts, type ScoredChunk } from '@qwen-code/qwen-code-core';
import type { CommandContext } from '../ui/commands/types.js';
import { MessageType } from '../ui/types.js';
import type {
  IPromptProcessor,
  PromptPipelineContent,
} from '../services/prompt-processors/types.js';
import { extractInjections } from '../services/prompt-processors/injectionParser.js';

/**
 * The trigger string for codebase query injection.
 */
export const CODEBASE_INJECTION_TRIGGER = '@codebase{';

/**
 * Detail level for context output.
 * - 'brief': Only file path, line range, and truncated content preview
 * - 'full': Complete chunk content with all details
 */
export type ContextDetailLevel = 'brief' | 'full';

/**
 * Configuration for the codebase provider.
 */
export interface CodebaseProviderConfig {
  /** Maximum tokens to include in context. Default: 4000. */
  maxTokens?: number;
  /** Number of results to retrieve. Default: 10. */
  topK?: number;
  /** Enable graph expansion. Default: false (for performance). */
  enableGraph?: boolean;
  /** Detail level for context output. Default: 'full'. */
  detail?: ContextDetailLevel;
  /** Max content length for brief mode preview. Default: 100. */
  briefPreviewLength?: number;
}

/**
 * Default configuration for codebase provider.
 */
export const DEFAULT_CODEBASE_PROVIDER_CONFIG: Required<CodebaseProviderConfig> =
  {
    maxTokens: 4000,
    topK: 10,
    enableGraph: false,
    detail: 'full',
    briefPreviewLength: 100,
  };

/**
 * Prompt processor that handles @codebase{query} syntax.
 * Retrieves relevant code snippets and injects them into the prompt.
 *
 * Usage:
 * - `@codebase{how is authentication implemented}` - Retrieves auth-related code
 * - `@codebase{file upload handler}` - Retrieves file upload code
 * - `@codebase{query|brief}` - Retrieves with brief output format
 * - `@codebase{query|full}` - Retrieves with full output format
 */
export class CodebaseProvider implements IPromptProcessor {
  private readonly config: Required<CodebaseProviderConfig>;

  constructor(config: CodebaseProviderConfig = {}) {
    this.config = { ...DEFAULT_CODEBASE_PROVIDER_CONFIG, ...config };
  }

  async process(
    input: PromptPipelineContent,
    context: CommandContext,
  ): Promise<PromptPipelineContent> {
    const appConfig = context.services.config;
    if (!appConfig) {
      return input;
    }

    return flatMapTextParts(input, async (text) => {
      // Check for @codebase{...} syntax
      if (!text.includes(CODEBASE_INJECTION_TRIGGER)) {
        return [{ text }];
      }

      const injections = extractInjections(text, CODEBASE_INJECTION_TRIGGER);
      if (injections.length === 0) {
        return [{ text }];
      }

      const output: PromptPipelineContent = [];
      let lastIndex = 0;

      for (const injection of injections) {
        const prefix = text.substring(lastIndex, injection.startIndex);
        if (prefix) {
          output.push({ text: prefix });
        }

        // Parse query and optional detail parameter
        const { query, detail } = this.parseInjectionContent(injection.content);

        if (!query) {
          // Empty query, skip
          lastIndex = injection.endIndex;
          continue;
        }

        try {
          const retrievedContent = await this.retrieveContext(
            query,
            detail,
            context,
          );
          if (retrievedContent) {
            output.push({ text: retrievedContent });
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: `Retrieved ${this.config.topK} code snippets for: "${query}" (${detail} mode)`,
              },
              Date.now(),
            );
          } else {
            context.ui.addItem(
              {
                type: MessageType.WARNING,
                text: `No results found for codebase query: "${query}"`,
              },
              Date.now(),
            );
            // Include the original query as context
            output.push({
              text: `[Codebase search: "${query}" - no results found]`,
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[CodebaseProvider] Failed to retrieve context for "${query}": ${message}`,
          );
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Failed to search codebase: ${message}`,
            },
            Date.now(),
          );
          // Leave a placeholder
          output.push({
            text: `[Codebase search failed: "${query}"]`,
          });
        }

        lastIndex = injection.endIndex;
      }

      const suffix = text.substring(lastIndex);
      if (suffix) {
        output.push({ text: suffix });
      }

      return output;
    });
  }

  /**
   * Parses injection content to extract query and optional detail parameter.
   * Format: "query" or "query|brief" or "query|full"
   */
  private parseInjectionContent(content: string): {
    query: string;
    detail: ContextDetailLevel;
  } {
    const trimmed = content.trim();
    const pipeIndex = trimmed.lastIndexOf('|');

    if (pipeIndex === -1) {
      return { query: trimmed, detail: this.config.detail };
    }

    const possibleDetail = trimmed
      .substring(pipeIndex + 1)
      .trim()
      .toLowerCase();
    if (possibleDetail === 'brief' || possibleDetail === 'full') {
      return {
        query: trimmed.substring(0, pipeIndex).trim(),
        detail: possibleDetail,
      };
    }

    // Not a valid detail parameter, treat entire string as query
    return { query: trimmed, detail: this.config.detail };
  }

  /**
   * Retrieves relevant code context for a query.
   */
  private async retrieveContext(
    query: string,
    detail: ContextDetailLevel,
    context: CommandContext,
  ): Promise<string | null> {
    const indexService = context.services.config?.getIndexService();
    if (!indexService) {
      throw new Error(
        'Codebase index not initialized. Run /codebase rebuild first.',
      );
    }

    const progress = indexService.getStatus();
    if (progress.status !== 'done') {
      throw new Error(
        `Codebase index is not ready. Current status: ${progress.status}`,
      );
    }

    // Get the retrieval service from IndexService
    const retrievalService = await indexService.getRetrievalServiceAsync();
    if (!retrievalService) {
      throw new Error(
        'Retrieval service not available. Index may not be fully initialized.',
      );
    }

    // Perform retrieval
    const result = await retrievalService.retrieve(query, {
      topK: this.config.topK,
      maxTokens: this.config.maxTokens,
      enableGraph: this.config.enableGraph,
    });

    if (!result.chunks || result.chunks.length === 0) {
      return null;
    }

    // Format the results based on detail level
    return this.formatContext(query, result.chunks, detail);
  }

  /**
   * Formats retrieved chunks into context string.
   */
  private formatContext(
    query: string,
    chunks: ScoredChunk[],
    detail: ContextDetailLevel,
  ): string {
    const header = `## Codebase Context for: "${query}"\n\n`;

    if (detail === 'brief') {
      return header + this.formatBriefContext(chunks);
    } else {
      return header + this.formatFullContext(chunks);
    }
  }

  /**
   * Formats chunks in brief mode.
   * Shows file path, line range, and truncated content preview.
   */
  private formatBriefContext(chunks: ScoredChunk[]): string {
    const lines: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const lineRange =
        chunk.startLine && chunk.endLine
          ? `L${chunk.startLine}-L${chunk.endLine}`
          : '';

      // Create a brief content preview
      const preview = this.createBriefPreview(chunk.content);

      lines.push(
        `### ${i + 1}. ${chunk.filePath}${lineRange ? ` (${lineRange})` : ''}`,
      );
      lines.push('');
      lines.push(`> ${preview}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Formats chunks in full mode.
   * Shows complete chunk content with metadata.
   */
  private formatFullContext(chunks: ScoredChunk[]): string {
    const lines: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const lineRange =
        chunk.startLine && chunk.endLine
          ? ` (lines ${chunk.startLine}-${chunk.endLine})`
          : '';

      lines.push(`### ${i + 1}. ${chunk.filePath}${lineRange}`);
      lines.push('');

      // Detect language for syntax highlighting
      const lang = this.detectLanguage(chunk.filePath);
      lines.push(`\`\`\`${lang}`);
      lines.push(chunk.content);
      lines.push('```');
      lines.push('');

      // Add relevance score if available
      if (chunk.score !== undefined) {
        lines.push(`*Relevance: ${(chunk.score * 100).toFixed(1)}%*`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Creates a brief preview of chunk content.
   * Extracts the first meaningful line and truncates if needed.
   */
  private createBriefPreview(content: string): string {
    // Remove leading whitespace and empty lines
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return '(empty)';
    }

    // Get first non-comment line if possible
    let previewLine = lines[0]!.trim();
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comment lines for preview
      if (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      ) {
        previewLine = trimmed;
        break;
      }
    }

    // Truncate if too long
    if (previewLine.length > this.config.briefPreviewLength) {
      previewLine =
        previewLine.substring(0, this.config.briefPreviewLength) + '...';
    }

    // Escape markdown special characters
    return previewLine.replace(/([`*_[\]])/g, '\\$1');
  }

  /**
   * Detects programming language from file extension.
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rb: 'ruby',
      java: 'java',
      kt: 'kotlin',
      go: 'go',
      rs: 'rust',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      scala: 'scala',
      sql: 'sql',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      md: 'markdown',
      vue: 'vue',
      svelte: 'svelte',
    };
    return langMap[ext] || ext || 'text';
  }
}
