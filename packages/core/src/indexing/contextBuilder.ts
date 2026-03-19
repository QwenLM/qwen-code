/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context builder for formatting retrieval results.
 * Converts code chunks and graph data into LLM-consumable context,
 * with token budget management and duplicate handling.
 */

import type { ScoredChunk } from './types.js';

/**
 * Configuration for context building.
 */
export interface ContextBuilderConfig {
  /** Maximum tokens in generated context. Default: 8000. */
  maxTokens: number;
  /** Average characters per token (approximation). Default: 4. */
  charsPerToken: number;
  /** Include line numbers in code blocks. Default: true. */
  includeLineNumbers: boolean;
  /** Include file path headers. Default: true. */
  includeFilePaths: boolean;
  /** Deduplicate overlapping chunks. Default: true. */
  deduplicateChunks: boolean;
  /** Language detection for syntax highlighting. Default: true. */
  detectLanguage: boolean;
}

/**
 * Default configuration for ContextBuilder.
 */
export const DEFAULT_CONTEXT_BUILDER_CONFIG: ContextBuilderConfig = {
  maxTokens: 8000,
  charsPerToken: 4,
  includeLineNumbers: true,
  includeFilePaths: true,
  deduplicateChunks: true,
  detectLanguage: true,
};

/**
 * Language detection based on file extension.
 */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.swift': 'swift',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.md': 'markdown',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/**
 * Context builder for formatting retrieval results into LLM context.
 * Handles token budgeting, deduplication, and various output formats.
 */
export class ContextBuilder {
  private readonly config: ContextBuilderConfig;

  /**
   * Creates a new ContextBuilder instance.
   * @param config Optional configuration overrides.
   */
  constructor(config: Partial<ContextBuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_BUILDER_CONFIG, ...config };
  }

  /**
   * Builds a text view of code chunks with markdown formatting.
   *
   * @param chunks Scored chunks to include.
   * @param maxTokens Optional token limit override.
   * @returns Formatted markdown text containing code blocks.
   */
  buildTextView(chunks: ScoredChunk[], maxTokens?: number): string {
    const tokenBudget = maxTokens ?? this.config.maxTokens;
    const maxChars = tokenBudget * this.config.charsPerToken;

    // Deduplicate chunks if enabled
    const processedChunks = this.config.deduplicateChunks
      ? this.deduplicateChunks(chunks)
      : chunks;

    const title = '## Relevant Code(Sort by relevance)';
    const chunkTexts = processedChunks.map((chunk) =>
      this.formatChunkSection(chunk),
    );
    let charCount =
      title.length + chunkTexts.reduce((sum, header) => sum + header.length, 0);

    for (let i = 0; i < processedChunks.length; i++) {
      const chunk = processedChunks[i];
      const chunkHeaderLength = chunkTexts[i]!.length;
      const chunkFullContent = this.formatChunkSection(chunk, true);
      const chunkFullLength = chunkFullContent.length;

      // Check if adding the full chunk exceeds the budget
      if (charCount + (chunkFullLength - chunkHeaderLength) < maxChars) {
        chunkTexts[i] = chunkFullContent; // Use full content
        charCount += chunkFullLength - chunkHeaderLength;
      } else {
        break; // Stop adding more chunks if we exceed the budget
      }
    }

    return `${title}\n${chunkTexts.join('\n')}`;
  }

  /**
   * Builds a combined context with text view.
   *
   * @param chunks Scored chunks.
   * @param maxTokens Token budget.
   * @returns Combined context string.
   */
  buildCombinedContext(chunks: ScoredChunk[], maxTokens?: number): string {
    const budget = maxTokens ?? this.config.maxTokens;
    return this.buildTextView(chunks, budget);
  }

  private formatChunkSection(
    chunk: ScoredChunk,
    withContent?: boolean,
  ): string {
    const lines: string[] = [];

    // Header with file path and line numbers
    if (this.config.includeFilePaths) {
      const header = this.config.includeLineNumbers
        ? `### ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
        : `### ${chunk.filePath}`;
      lines.push(header);
    }
    if (withContent && chunk.content) {
      lines.push(chunk.content);
      lines.push('\n');
    }
    return lines.join('\n');
  }

  /**
   * Removes duplicate or heavily overlapping chunks.
   */
  private deduplicateChunks(chunks: ScoredChunk[]): ScoredChunk[] {
    const seen = new Map<string, ScoredChunk>();

    for (const chunk of chunks) {
      // Key by file path and approximate line range
      const key = `${chunk.filePath}:${Math.floor(chunk.startLine / 10)}`;

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, chunk);
      } else {
        // Keep the one with higher score
        if (chunk.score > existing.score) {
          seen.set(key, chunk);
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Detects programming language from file extension.
   */
  detectLanguage(filePath: string): string {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return LANGUAGE_MAP[ext.toLowerCase()] ?? '';
  }

  /**
   * Estimates token count from character count.
   *
   * @param text Text to estimate.
   * @returns Estimated token count.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.config.charsPerToken);
  }

  /**
   * Trims content to fit token budget.
   *
   * @param content Content to trim.
   * @param maxTokens Maximum tokens.
   * @returns Trimmed content.
   */
  trimToTokenBudget(content: string, maxTokens: number): string {
    const maxChars = maxTokens * this.config.charsPerToken;
    if (content.length <= maxChars) {
      return content;
    }
    return content.substring(0, maxChars - 3) + '...';
  }
}
