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

import type {
  GraphEntity,
  GraphSubgraph,
  RelationType,
  ScoredChunk,
} from './types.js';

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
 * Arrow styles for different relation types in Mermaid diagrams.
 */
const ARROW_STYLES: Record<RelationType, string> = {
  CALLS: '-->|calls|',
  IMPORTS: '-.->|imports|',
  EXTENDS: '==>|extends|',
  IMPLEMENTS: '-.->|implements|',
  CONTAINS: '-->|contains|',
  EXPORTS: '-->|exports|',
  USES: '-->|uses|',
  DEFINES: '-->|defines|',
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

    const lines: string[] = ['## Relevant Code\n'];
    let charCount = lines[0]!.length;

    for (const chunk of processedChunks) {
      // Build chunk section
      const chunkLines = this.formatChunkSection(chunk);
      const chunkText = chunkLines.join('\n');
      const chunkChars = chunkText.length;

      // Check token budget
      if (charCount + chunkChars > maxChars) {
        // Try to fit at least a truncated version
        const remaining = maxChars - charCount;
        if (remaining > 200) {
          lines.push(this.formatTruncatedChunk(chunk, remaining));
        }
        break;
      }

      lines.push(chunkText);
      charCount += chunkChars;
    }

    return lines.join('\n');
  }

  /**
   * Builds a Mermaid graph view of the dependency subgraph.
   *
   * @param subgraph Graph subgraph to visualize.
   * @returns Mermaid-formatted graph string.
   */
  buildGraphView(subgraph: GraphSubgraph): string {
    if (subgraph.entities.length === 0) {
      return '';
    }

    const lines: string[] = ['## Dependency Graph\n', '```mermaid', 'graph LR'];

    // Track which entities are seeds for styling
    const seedSet = new Set(subgraph.seedIds);

    // Add nodes
    for (const entity of subgraph.entities) {
      const nodeId = this.sanitizeMermaidId(entity.id);
      const label = this.formatEntityLabel(entity);
      const style = seedSet.has(entity.id) ? ':::seed' : '';
      lines.push(`  ${nodeId}["${label}"]${style}`);
    }

    // Add edges
    const addedEdges = new Set<string>();
    for (const relation of subgraph.relations) {
      const edgeKey = `${relation.sourceId}->${relation.targetId}`;
      if (addedEdges.has(edgeKey)) continue;
      addedEdges.add(edgeKey);

      const sourceId = this.sanitizeMermaidId(relation.sourceId);
      const targetId = this.sanitizeMermaidId(relation.targetId);
      const arrow = ARROW_STYLES[relation.type] ?? '-->';

      lines.push(`  ${sourceId} ${arrow} ${targetId}`);
    }

    // Add seed node styling
    lines.push('  classDef seed fill:#f9f,stroke:#333');
    lines.push('```');

    return lines.join('\n');
  }

  /**
   * Builds a combined context with both text and graph views.
   *
   * @param chunks Scored chunks.
   * @param subgraph Optional dependency subgraph.
   * @param maxTokens Token budget.
   * @returns Combined context string.
   */
  buildCombinedContext(
    chunks: ScoredChunk[],
    subgraph: GraphSubgraph | null,
    maxTokens?: number,
  ): string {
    const budget = maxTokens ?? this.config.maxTokens;

    // Allocate 80% to text, 20% to graph
    const textBudget = Math.floor(budget * 0.8);
    const graphBudget = Math.floor(budget * 0.2);

    const parts: string[] = [];

    // Add text view
    const textView = this.buildTextView(chunks, textBudget);
    if (textView) {
      parts.push(textView);
    }

    // Add graph view if available and fits budget
    if (subgraph && subgraph.entities.length > 0) {
      const graphView = this.buildGraphView(subgraph);
      if (graphView.length <= graphBudget * this.config.charsPerToken) {
        parts.push(graphView);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Formats a single chunk as a markdown code section.
   */
  private formatChunkSection(chunk: ScoredChunk): string[] {
    const lines: string[] = [];

    // Header with file path and line numbers
    if (this.config.includeFilePaths) {
      const header = this.config.includeLineNumbers
        ? `### ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
        : `### ${chunk.filePath}`;
      lines.push(header);
    }

    // Code block with language detection
    const language = this.config.detectLanguage
      ? this.detectLanguage(chunk.filePath)
      : '';
    lines.push('```' + language);
    lines.push(chunk.content);
    lines.push('```\n');

    return lines;
  }

  /**
   * Formats a truncated chunk to fit remaining budget.
   */
  private formatTruncatedChunk(chunk: ScoredChunk, maxChars: number): string {
    const header = `### ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (truncated)`;
    const language = this.detectLanguage(chunk.filePath);
    const overhead = header.length + language.length + 20; // Account for markdown syntax
    const contentBudget = maxChars - overhead;

    if (contentBudget <= 0) {
      return '';
    }

    const truncatedContent =
      chunk.content.substring(0, contentBudget) + '\n// ...truncated';

    return [header, '```' + language, truncatedContent, '```'].join('\n');
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
  private detectLanguage(filePath: string): string {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return LANGUAGE_MAP[ext.toLowerCase()] ?? '';
  }

  /**
   * Formats an entity label for Mermaid display.
   */
  private formatEntityLabel(entity: GraphEntity): string {
    const shortType = entity.type.charAt(0).toUpperCase();
    const name =
      entity.name.length > 30
        ? entity.name.substring(0, 27) + '...'
        : entity.name;
    return `${shortType}:${name}`;
  }

  /**
   * Sanitizes an ID for use in Mermaid diagrams.
   * Replaces special characters with underscores.
   */
  private sanitizeMermaidId(id: string): string {
    return id
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
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
