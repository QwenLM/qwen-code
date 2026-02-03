/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Chunk,
  ChunkMetadata,
  ChunkType,
  IChunkingService,
} from './types.js';
import {
  createParser,
  detectTreeSitterLanguage,
  type SupportedLanguage,
  type SyntaxNode,
  type Parser,
  type Tree,
  type ParseResult,
} from './treeSitterParser.js';

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
 * Node types that can be chunked for each language.
 */
const CHUNKABLE_NODE_TYPES: Record<string, string[]> = {
  typescript: [
    'function_declaration',
    'method_definition',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'export_statement',
    'lexical_declaration', // const/let with arrow functions
  ],
  tsx: [
    'function_declaration',
    'method_definition',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'export_statement',
    'lexical_declaration',
  ],
  javascript: [
    'function_declaration',
    'method_definition',
    'class_declaration',
    'export_statement',
    'lexical_declaration',
  ],
  jsx: [
    'function_declaration',
    'method_definition',
    'class_declaration',
    'export_statement',
    'lexical_declaration',
  ],
  python: ['function_definition', 'class_definition', 'decorated_definition'],
};

/**
 * Mapping from AST node types to chunk types.
 */
const NODE_TYPE_TO_CHUNK_TYPE: Record<string, ChunkType> = {
  function_declaration: 'function',
  function_definition: 'function',
  method_definition: 'method',
  class_declaration: 'class',
  class_definition: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'interface',
  export_statement: 'module',
  lexical_declaration: 'function',
  decorated_definition: 'function',
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
   * Performs AST-based chunking with a pre-parsed tree.
   */
  private astChunkWithTree(
    filepath: string,
    content: string,
    tree: Tree,
    language: SupportedLanguage,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const nodeTypes = CHUNKABLE_NODE_TYPES[language] || [];

    // Collect all chunkable nodes
    const chunkableNodes: SyntaxNode[] = [];
    this.collectChunkableNodes(tree.rootNode, nodeTypes, chunkableNodes);

    // If no chunkable nodes found, treat the whole file as one chunk
    if (chunkableNodes.length === 0) {
      return this.lineBasedChunk(filepath, content, language);
    }

    // Sort nodes by start position
    chunkableNodes.sort((a, b) => a.startIndex - b.startIndex);

    // Process each node
    let lastEndIndex = 0;
    for (const node of chunkableNodes) {
      // Add any content between nodes as a block chunk
      if (node.startIndex > lastEndIndex) {
        const betweenContent = content.slice(lastEndIndex, node.startIndex);
        const trimmed = betweenContent.trim();
        if (
          trimmed.length > 0 &&
          this.countTokens(trimmed) >= this.config.minChunkTokens
        ) {
          const betweenChunk = this.createBlockChunk(
            filepath,
            betweenContent,
            this.getLineNumber(content, lastEndIndex),
            this.getLineNumber(content, node.startIndex - 1),
            language,
            chunks.length,
          );
          chunks.push(betweenChunk);
        }
      }

      // Process the node
      const nodeContent = content.slice(node.startIndex, node.endIndex);
      const tokenCount = this.countTokens(nodeContent);

      if (tokenCount <= this.config.maxChunkTokens) {
        // Node fits in a single chunk
        const chunk = this.createAstChunk(
          filepath,
          node,
          nodeContent,
          content,
          language,
          chunks.length,
        );
        chunks.push(chunk);
      } else {
        // Node too large, split it
        const subChunks = this.splitLargeNode(
          filepath,
          node,
          content,
          language,
          chunks.length,
        );
        chunks.push(...subChunks);
      }

      lastEndIndex = node.endIndex;
    }

    // Handle remaining content after last node
    if (lastEndIndex < content.length) {
      const remainingContent = content.slice(lastEndIndex);
      const trimmed = remainingContent.trim();
      if (
        trimmed.length > 0 &&
        this.countTokens(trimmed) >= this.config.minChunkTokens
      ) {
        const remainingChunk = this.createBlockChunk(
          filepath,
          remainingContent,
          this.getLineNumber(content, lastEndIndex),
          this.getLineNumber(content, content.length - 1),
          language,
          chunks.length,
        );
        chunks.push(remainingChunk);
      }
    }

    // Merge small adjacent chunks
    const mergedChunks = this.mergeSmallChunks(chunks);

    // Re-index chunks
    return mergedChunks.map((chunk, index) => ({ ...chunk, index }));
  }

  /**
   * Performs AST-based chunking.
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

    const chunks: Chunk[] = [];
    const nodeTypes = CHUNKABLE_NODE_TYPES[language] || [];

    // Collect all chunkable nodes
    const chunkableNodes: SyntaxNode[] = [];
    this.collectChunkableNodes(tree.rootNode, nodeTypes, chunkableNodes);

    // If no chunkable nodes found, treat the whole file as one chunk
    if (chunkableNodes.length === 0) {
      return this.lineBasedChunk(filepath, content, language);
    }

    // Sort nodes by start position
    chunkableNodes.sort((a, b) => a.startIndex - b.startIndex);

    // Process each node
    let lastEndIndex = 0;
    for (const node of chunkableNodes) {
      // Add any content between nodes as a block chunk
      if (node.startIndex > lastEndIndex) {
        const betweenContent = content.slice(lastEndIndex, node.startIndex);
        const trimmed = betweenContent.trim();
        if (
          trimmed.length > 0 &&
          this.countTokens(trimmed) >= this.config.minChunkTokens
        ) {
          const betweenChunk = this.createBlockChunk(
            filepath,
            betweenContent,
            this.getLineNumber(content, lastEndIndex),
            this.getLineNumber(content, node.startIndex - 1),
            language,
            chunks.length,
          );
          chunks.push(betweenChunk);
        }
      }

      // Process the node
      const nodeContent = content.slice(node.startIndex, node.endIndex);
      const tokenCount = this.countTokens(nodeContent);

      if (tokenCount <= this.config.maxChunkTokens) {
        // Node fits in a single chunk
        const chunk = this.createAstChunk(
          filepath,
          node,
          nodeContent,
          content,
          language,
          chunks.length,
        );
        chunks.push(chunk);
      } else {
        // Node too large, split it
        const subChunks = this.splitLargeNode(
          filepath,
          node,
          content,
          language,
          chunks.length,
        );
        chunks.push(...subChunks);
      }

      lastEndIndex = node.endIndex;
    }

    // Handle remaining content after last node
    if (lastEndIndex < content.length) {
      const remainingContent = content.slice(lastEndIndex);
      const trimmed = remainingContent.trim();
      if (
        trimmed.length > 0 &&
        this.countTokens(trimmed) >= this.config.minChunkTokens
      ) {
        const remainingChunk = this.createBlockChunk(
          filepath,
          remainingContent,
          this.getLineNumber(content, lastEndIndex),
          this.getLineNumber(content, content.length - 1),
          language,
          chunks.length,
        );
        chunks.push(remainingChunk);
      }
    }

    // Merge small adjacent chunks
    const mergedChunks = this.mergeSmallChunks(chunks);

    // Re-index chunks
    return mergedChunks.map((chunk, index) => ({ ...chunk, index }));
  }

  /**
   * Recursively collects chunkable nodes from the AST.
   */
  private collectChunkableNodes(
    node: SyntaxNode,
    nodeTypes: string[],
    result: SyntaxNode[],
  ): void {
    if (nodeTypes.includes(node.type)) {
      result.push(node);
      // Don't recurse into chunkable nodes to avoid duplication
      return;
    }

    for (const child of node.children) {
      if (child) {
        this.collectChunkableNodes(child, nodeTypes, result);
      }
    }
  }

  /**
   * Creates a chunk from an AST node.
   */
  private createAstChunk(
    filepath: string,
    node: SyntaxNode,
    nodeContent: string,
    fullContent: string,
    language: string,
    index: number,
  ): Chunk {
    const chunkType = NODE_TYPE_TO_CHUNK_TYPE[node.type] || 'block';
    const metadata = this.extractMetadata(
      node,
      nodeContent,
      fullContent,
      language,
    );

    return {
      id: uuidv4(),
      filepath,
      content: nodeContent,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      index,
      contentHash: this.computeHash(nodeContent),
      type: chunkType,
      metadata,
    };
  }

  /**
   * Creates a block chunk for non-AST content.
   */
  private createBlockChunk(
    filepath: string,
    content: string,
    startLine: number,
    endLine: number,
    language: string,
    index: number,
  ): Chunk {
    return {
      id: uuidv4(),
      filepath,
      content,
      startLine,
      endLine,
      index,
      contentHash: this.computeHash(content),
      type: 'block',
      metadata: { language },
    };
  }

  /**
   * Splits a large AST node into smaller chunks.
   */
  private splitLargeNode(
    filepath: string,
    node: SyntaxNode,
    fullContent: string,
    language: string,
    startIndex: number,
  ): Chunk[] {
    const nodeContent = fullContent.slice(node.startIndex, node.endIndex);
    const lines = nodeContent.split('\n');
    const chunks: Chunk[] = [];

    let currentLines: string[] = [];
    let currentTokens = 0;
    let chunkStartLine = node.startPosition.row + 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.countTokens(line);

      if (
        currentTokens + lineTokens > this.config.maxChunkTokens &&
        currentLines.length > 0
      ) {
        // Save current chunk
        const chunkContent = currentLines.join('\n');
        chunks.push({
          id: uuidv4(),
          filepath,
          content: chunkContent,
          startLine: chunkStartLine,
          endLine: chunkStartLine + currentLines.length - 1,
          index: startIndex + chunks.length,
          contentHash: this.computeHash(chunkContent),
          type: NODE_TYPE_TO_CHUNK_TYPE[node.type] || 'block',
          metadata: { language },
        });

        // Start new chunk with overlap
        const overlapLines = this.getOverlapLines(
          currentLines,
          this.config.overlapTokens,
        );
        currentLines = [...overlapLines, line];
        chunkStartLine = node.startPosition.row + 1 + i - overlapLines.length;
        currentTokens = this.countTokens(currentLines.join('\n'));
      } else {
        currentLines.push(line);
        currentTokens += lineTokens;
      }
    }

    // Save last chunk
    if (currentLines.length > 0) {
      const chunkContent = currentLines.join('\n');
      chunks.push({
        id: uuidv4(),
        filepath,
        content: chunkContent,
        startLine: chunkStartLine,
        endLine: chunkStartLine + currentLines.length - 1,
        index: startIndex + chunks.length,
        contentHash: this.computeHash(chunkContent),
        type: NODE_TYPE_TO_CHUNK_TYPE[node.type] || 'block',
        metadata: { language },
      });
    }

    return chunks;
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
   * Merges adjacent small chunks.
   */
  private mergeSmallChunks(chunks: Chunk[]): Chunk[] {
    if (chunks.length <= 1) return chunks;

    const result: Chunk[] = [];
    let current: Chunk | null = null;

    for (const chunk of chunks) {
      const chunkTokens = this.countTokens(chunk.content);

      if (!current) {
        current = chunk;
        continue;
      }

      const currentTokens = this.countTokens(current.content);

      // Merge if both are small and combined size is acceptable
      if (
        chunkTokens < this.config.minChunkTokens &&
        currentTokens < this.config.minChunkTokens &&
        currentTokens + chunkTokens <= this.config.maxChunkTokens &&
        current.filepath === chunk.filepath
      ) {
        // Merge chunks
        current = {
          ...current,
          content: current.content + '\n' + chunk.content,
          endLine: chunk.endLine,
          contentHash: this.computeHash(current.content + '\n' + chunk.content),
        };
      } else {
        // Save current and start new
        result.push(current);
        current = chunk;
      }
    }

    if (current) {
      result.push(current);
    }

    return result;
  }

  /**
   * Extracts metadata from an AST node.
   * @param node - The AST node
   * @param nodeContent - Pre-computed content of the node (for signature extraction)
   * @param fullContent - Full file content (for name extraction using indices)
   * @param language - The programming language
   */
  private extractMetadata(
    node: SyntaxNode,
    nodeContent: string,
    fullContent: string,
    language: string,
  ): ChunkMetadata {
    const metadata: ChunkMetadata = { language };

    // Extract name based on node type (use fullContent for index-based extraction)
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const name = fullContent.slice(nameNode.startIndex, nameNode.endIndex);

      if (
        node.type === 'function_declaration' ||
        node.type === 'function_definition'
      ) {
        metadata.functionName = name;
      } else if (
        node.type === 'class_declaration' ||
        node.type === 'class_definition'
      ) {
        metadata.className = name;
      } else if (node.type === 'method_definition') {
        metadata.functionName = name;
        // Try to get class name from parent
        const parentClass = this.findParentOfType(node, [
          'class_declaration',
          'class_definition',
        ]);
        if (parentClass) {
          const classNameNode = parentClass.childForFieldName('name');
          if (classNameNode) {
            metadata.className = fullContent.slice(
              classNameNode.startIndex,
              classNameNode.endIndex,
            );
          }
        }
      }
    }

    // Extract signature (first line) - use pre-computed nodeContent
    const firstLine = nodeContent.split('\n')[0];
    if (firstLine) {
      metadata.signature = firstLine.trim();
    }

    return metadata;
  }

  /**
   * Finds a parent node of specific types.
   */
  private findParentOfType(
    node: SyntaxNode,
    types: string[],
  ): SyntaxNode | null {
    let current = node.parent;
    while (current) {
      if (types.includes(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
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
   * Gets line number from character index.
   */
  private getLineNumber(content: string, charIndex: number): number {
    const prefix = content.slice(0, charIndex);
    return prefix.split('\n').length;
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
