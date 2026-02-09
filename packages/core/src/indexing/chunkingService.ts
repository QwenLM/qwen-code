/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Chunk, ChunkType, IChunkingService } from './types.js';
import {
  createParser,
  detectTreeSitterLanguage,
  type SupportedLanguage,
  type Parser,
  type Tree,
  type ParseResult,
} from './treeSitterParser.js';
import { codeChunker } from './codeChunker.js';

/**
 * Configuration for the chunking service.
 */
export interface ChunkingConfig {
  /** Maximum tokens per chunk. Default: 512. */
  maxChunkTokens: number;
  /** Minimum tokens per chunk (smaller chunks are merged). Default: 100. */
  minChunkTokens: number;
  /** Overlap tokens between chunks. Default: 50. */
  overlapTokens: number;
  /** Maximum lines per chunk (hard limit). Default: 100. */
  maxChunkLines: number;
}

/**
 * Default chunking configuration.
 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkTokens: 512,
  minChunkTokens: 100,
  overlapTokens: 50,
  maxChunkLines: 100,
};

/**
 * Maximum file size for chunking (1MB).
 * Files larger than this are skipped to avoid performance issues.
 */
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Known text file extensions that should be indexed.
 * Files without extensions or with unknown extensions are skipped.
 */
const TEXT_FILE_EXTENSIONS = new Set([
  // Programming languages
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.pyw',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hxx',
  '.cs',
  '.rb',
  '.rake',
  '.php',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.lua',
  '.r',
  '.R',
  '.scala',
  '.pl',
  '.pm',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.hs',
  '.lhs',
  '.ml',
  '.mli',
  '.v',
  '.sv',
  '.vhd',
  '.vhdl',
  // Web
  '.html',
  '.htm',
  '.xhtml',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.vue',
  '.svelte',
  // Data/Config
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.xsl',
  '.xslt',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.env.example',
  '.env.local',
  '.properties',
  // Documentation
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.txt',
  '.text',
  '.adoc',
  '.asciidoc',
  // Build/Config
  '.gradle',
  '.maven',
  '.cmake',
  '.makefile',
  '.mk',
  '.dockerfile',
  '.tf',
  '.tfvars',
  // SQL
  '.sql',
  '.psql',
  '.plsql',
  // Other
  '.graphql',
  '.gql',
  '.proto',
  '.thrift',
]);

/**
 * ChunkingService provides AST-aware code chunking with fallback to line-based chunking.
 */
export class ChunkingService implements IChunkingService {
  private config: ChunkingConfig;
  private parserCache = new Map<SupportedLanguage, Parser>();

  constructor(config: Partial<ChunkingConfig> = {}) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  }

  /**
   * Chunks a file into semantically meaningful pieces.
   *
   * @param filepath - The file path
   * @param content - The file content
   * @param preParseResult - Optional pre-parsed AST to avoid duplicate parsing
   * @returns Array of chunks (empty if file should be skipped)
   */
  async chunkFile(
    filepath: string,
    content: string,
    preParseResult?: ParseResult | null,
  ): Promise<Chunk[]> {
    // Skip files that should not be indexed
    if (this.shouldSkipFile(filepath, content)) {
      return [];
    }

    // Use pre-parsed AST if provided
    if (preParseResult) {
      return this.astChunkWithTree(
        filepath,
        content,
        preParseResult.tree,
        preParseResult.language,
      );
    }

    const language = detectTreeSitterLanguage(filepath);

    // Try AST chunking for supported languages
    if (language) {
      try {
        return await this.astChunk(filepath, content, language);
      } catch (error) {
        // AST parsing failed, fallback to line-based chunking
        console.warn(
          `AST parsing failed for ${filepath}, falling back to line-based chunking: ${error}`,
        );
      }
    }

    // Fallback: line-based chunking
    const detectedLang = this.detectLanguageFromPath(filepath);
    return this.lineBasedChunk(filepath, content, detectedLang);
  }

  /**
   * Determines if a file should be skipped from indexing.
   * Skips: large files (>1MB), binary files, files without extensions.
   */
  private shouldSkipFile(filepath: string, content: string): boolean {
    // Check file size (1MB limit)
    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > MAX_FILE_SIZE_BYTES) {
      return true;
    }

    // Check for file extension
    const ext = path.extname(filepath).toLowerCase();
    if (!ext) {
      // No extension - skip unless it's a known extensionless file
      const basename = path.basename(filepath).toLowerCase();
      const knownExtensionlessFiles = new Set([
        'makefile',
        'dockerfile',
        'jenkinsfile',
        'vagrantfile',
        'gemfile',
        'rakefile',
        'procfile',
        'brewfile',
        'cmakelists.txt', // Has .txt but often referenced without
      ]);
      if (!knownExtensionlessFiles.has(basename)) {
        return true;
      }
    } else if (!TEXT_FILE_EXTENSIONS.has(ext)) {
      // Unknown extension - likely binary or non-code file
      return true;
    }

    // Check for binary content (NULL bytes or high ratio of non-printable chars)
    if (this.isBinaryContent(content)) {
      return true;
    }

    return false;
  }

  /**
   * Checks if content appears to be binary (non-text).
   * Uses heuristics: presence of NULL bytes or high ratio of non-printable characters.
   */
  private isBinaryContent(content: string): boolean {
    // Check first 8KB for binary indicators (optimization for large files)
    const sampleSize = Math.min(content.length, 8192);
    const sample = content.slice(0, sampleSize);

    // NULL byte is a strong indicator of binary content
    if (sample.includes('\0')) {
      return true;
    }

    // Count non-printable characters (excluding common whitespace)
    let nonPrintableCount = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      // Non-printable: 0x00-0x08, 0x0E-0x1F (excluding tab, newline, carriage return)
      if ((code >= 0 && code <= 8) || (code >= 14 && code <= 31)) {
        nonPrintableCount++;
      }
    }

    // If more than 10% non-printable, likely binary
    const nonPrintableRatio = nonPrintableCount / sampleSize;
    if (nonPrintableRatio > 0.1) {
      return true;
    }

    return false;
  }

  /**
   * Performs AST-based chunking with a pre-parsed tree using smart collapse strategy.
   *
   * Uses Continue's codeChunker approach:
   * - Small nodes are kept intact
   * - Large classes are collapsed with method signatures preserved
   * - Large functions are collapsed to signature + "{ ... }"
   * - Children are recursively processed
   */
  private async astChunkWithTree(
    filepath: string,
    content: string,
    tree: Tree,
    language: SupportedLanguage,
  ): Promise<Chunk[]> {
    const chunks: Chunk[] = [];

    // Use the Continue-style code chunker
    let index = 0;
    for await (const chunkWithoutId of codeChunker(
      tree.rootNode,
      content,
      this.config.maxChunkTokens,
    )) {
      // Skip empty chunks
      if (!chunkWithoutId.content.trim()) {
        continue;
      }

      // Create full chunk with ID and metadata
      const chunk: Chunk = {
        id: uuidv4(),
        filepath,
        content: chunkWithoutId.content,
        startLine: chunkWithoutId.startLine + 1, // Convert to 1-based
        endLine: chunkWithoutId.endLine + 1, // Convert to 1-based
        index,
        contentHash: this.computeHash(chunkWithoutId.content),
        type: this.detectChunkType(chunkWithoutId.content),
        metadata: {
          language,
          signature: this.extractSignature(chunkWithoutId.content),
        },
      };

      chunks.push(chunk);
      index++;
    }

    // If no chunks were generated, fall back to line-based chunking
    if (chunks.length === 0) {
      return this.lineBasedChunk(filepath, content, language);
    }

    return chunks;
  }

  /**
   * Detects the chunk type from content.
   */
  private detectChunkType(content: string): ChunkType {
    const firstLine = content.split('\n')[0] || '';
    const trimmed = firstLine.trim();

    if (trimmed.startsWith('class ') || trimmed.includes(' class ')) {
      return 'class';
    }
    if (trimmed.startsWith('interface ') || trimmed.includes(' interface ')) {
      return 'interface';
    }
    if (
      trimmed.startsWith('function ') ||
      trimmed.includes(' function ') ||
      trimmed.includes('=>') ||
      trimmed.startsWith('async function')
    ) {
      return 'function';
    }
    if (
      trimmed.includes('(') &&
      (trimmed.startsWith('public ') ||
        trimmed.startsWith('private ') ||
        trimmed.startsWith('protected ') ||
        trimmed.startsWith('async ') ||
        trimmed.startsWith('static '))
    ) {
      return 'method';
    }
    if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
      return 'function';
    }

    return 'block';
  }

  /**
   * Extracts signature (first meaningful line) from content.
   */
  private extractSignature(content: string): string | undefined {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      ) {
        return trimmed;
      }
    }
    return undefined;
  }

  /**
   * Performs AST-based chunking using smart collapse strategy.
   */
  private async astChunk(
    filepath: string,
    content: string,
    language: SupportedLanguage,
  ): Promise<Chunk[]> {
    const parser = await this.getParser(language);
    const tree = parser.parse(content);

    // If parsing failed, fallback to line-based chunking
    if (!tree) {
      return this.lineBasedChunk(filepath, content, language);
    }

    return this.astChunkWithTree(filepath, content, tree, language);
  }

  /**
   * Performs line-based chunking with sliding window.
   */
  private lineBasedChunk(
    filepath: string,
    content: string,
    language: string,
  ): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];

    let currentLines: string[] = [];
    let startLine = 1;
    let tokenCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.countTokens(line);

      if (lineTokens > this.config.maxChunkTokens) {
        continue; // Skip lines that are too long
      }

      if (
        tokenCount + lineTokens > this.config.maxChunkTokens &&
        currentLines.length > 0
      ) {
        // Save current chunk
        const chunkContent = currentLines.join('\n');
        chunks.push({
          id: uuidv4(),
          filepath,
          content: chunkContent,
          startLine,
          endLine: startLine + currentLines.length - 1,
          index: chunks.length,
          contentHash: this.computeHash(chunkContent),
          type: 'block',
          metadata: { language },
        });

        // Prepare next chunk with overlap
        const overlapLines = this.getOverlapLines(
          currentLines,
          this.config.overlapTokens,
        );
        currentLines = [...overlapLines, line];
        startLine = i + 1 - overlapLines.length + 1;
        tokenCount = this.countTokens(currentLines.join('\n'));
      } else {
        currentLines.push(line);
        tokenCount += lineTokens;
      }
    }

    // Save last chunk
    if (currentLines.length > 0) {
      const chunkContent = currentLines.join('\n');
      chunks.push({
        id: uuidv4(),
        filepath,
        content: chunkContent,
        startLine,
        endLine: startLine + currentLines.length - 1,
        index: chunks.length,
        contentHash: this.computeHash(chunkContent),
        type: 'block',
        metadata: { language },
      });
    }

    return chunks;
  }

  /**
   * Gets or creates a parser for a language.
   */
  private async getParser(language: SupportedLanguage): Promise<Parser> {
    let parser = this.parserCache.get(language);
    if (!parser) {
      parser = await createParser(language);
      this.parserCache.set(language, parser);
    }
    return parser;
  }

  /**
   * Counts tokens in content (rough estimate: 1 token ≈ 4 characters).
   */
  private countTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * Gets overlap lines from the end of a chunk.
   */
  private getOverlapLines(lines: string[], overlapTokens: number): string[] {
    const result: string[] = [];
    let tokenCount = 0;

    for (let i = lines.length - 1; i >= 0 && tokenCount < overlapTokens; i--) {
      const lineTokens = this.countTokens(lines[i]);
      if (tokenCount + lineTokens <= overlapTokens) {
        result.unshift(lines[i]);
        tokenCount += lineTokens;
      } else {
        break;
      }
    }

    return result;
  }

  /**
   * Computes SHA-256 hash of content.
   */
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Detects language from file path extension.
   */
  private detectLanguageFromPath(filepath: string): string {
    const ext = filepath.split('.').pop()?.toLowerCase() || '';
    const extensionMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      py: 'python',
      pyi: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      kt: 'kotlin',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      swift: 'swift',
      sh: 'shell',
      bash: 'shell',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
    };
    return extensionMap[ext] || 'text';
  }
}
