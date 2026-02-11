/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core type definitions for the Codebase Index feature.
 * This module defines all interfaces, types, and data structures used
 * throughout the indexing system.
 */

import type { ParseResult } from './treeSitterParser.js';

// ===== Platform Support =====

/**
 * Whether the current platform is Windows.
 * Codebase Index is only supported on macOS and Linux.
 */
export const isWindows = process.platform === 'win32';

// ===== Interface Definitions =====

/**
 * Interface for file scanning operations.
 * Implementations should handle .gitignore and .qwenignore filtering.
 */
export interface IFileScanner {
  scanFiles(projectRoot?: string): Promise<FileMetadata[]>;
  countFiles(projectRoot?: string): Promise<number>;
  /**
   * Streaming file scan - yields batches of file metadata.
   * This is memory-efficient for very large repositories (100k+ files).
   */
  scanFilesStreaming?(
    projectRoot?: string,
    batchSize?: number,
  ): AsyncGenerator<FileMetadata[], void, undefined>;
  /**
   * True streaming file scan using spawned ripgrep process.
   * Processes files in batches without loading the entire file list into memory.
   */
  scanFilesStreamingLowMemory?(
    projectRoot?: string,
    batchSize?: number,
  ): AsyncGenerator<FileMetadata[], void, undefined>;
  scanSpecificFiles(filePaths: string[]): Promise<FileMetadata[]>;
}

/**
 * Interface for code chunking operations.
 */
export interface IChunkingService {
  chunkFile(
    filepath: string,
    content: string,
    preParseResult?: ParseResult | null,
  ): Promise<Chunk[]>;
}

/**
 * Interface for embedding generation.
 */
export interface IEmbeddingService {
  embedChunks(
    chunks: Chunk[],
    batchCallback?: (finishedChunks: number) => void,
  ): Promise<Array<{ chunk: Chunk; embedding: number[] }>>;
}

/**
 * Interface for metadata storage operations.
 */
export interface IMetadataStore {
  insertFileMeta(files: FileMetadata[]): void;
  getFileMeta(path: string): FileMetadata | null;
  getAllFileMeta(): FileMetadata[];
  deleteFileMeta(paths: string[]): void;
  insertChunks(chunks: Chunk[]): void;
  getChunksByFilePath(filePath: string): Chunk[];
  deleteChunksByFilePath(filePaths: string[]): void;
  searchFTS(query: string, limit: number): ScoredChunk[];
  /**
   * Gets the first chunk from the most recently modified files.
   * Optimized for recent files retrieval without loading all file metadata.
   * @param limit Maximum number of chunks to return.
   * @returns Array of scored chunks from recent files.
   */
  getRecentChunks(limit: number): ScoredChunk[];
  /**
   * Get chunks by their IDs.
   * Used by graph expansion to load related chunks discovered via traversal.
   * @param chunkIds Array of chunk IDs to retrieve.
   * @returns Array of chunks found (may be fewer than requested if some IDs don't exist).
   */
  getChunksByIds(chunkIds: string[]): Chunk[];
  /**
   * Gets the primary programming languages in the repository.
   * Returns languages sorted by file count (most common first).
   * Excludes null/undefined languages.
   * @returns Array of language names, e.g., ['typescript', 'javascript', 'python'].
   */
  getPrimaryLanguages(): string[];
  getEmbeddingCache(cacheKey: string): number[] | null;
  setEmbeddingCache(cacheKey: string, embedding: number[]): void;
  getIndexStatus(): IndexingProgress;
  updateIndexStatus(status: Partial<IndexingProgress>): void;
  getCheckpoint(): BuildCheckpoint | null;
  saveCheckpoint(checkpoint: BuildCheckpoint): void;
  clearCheckpoint(): void;
  close(): void;
}

/**
 * Interface for vector storage operations.
 */
export interface IVectorStore {
  initialize(): Promise<void>;
  insertBatch(
    docs: Array<{ chunk: Chunk; embedding: number[] }>,
  ): Promise<void>;
  query(
    queryVector: number[],
    topK: number,
    filter?: string,
  ): Promise<VectorSearchResult[]>;
  deleteByFilePath(filePath: string): Promise<void>;
  deleteByChunkIds(chunkIds: string[]): Promise<void>;
  optimize(): void;
  destroy(): void;
}

// ===== Configuration Types =====

/**
 * Configuration for the codebase indexing system.
 */
export interface IndexConfig {
  /** Total feature toggle. When disabled, no indexing operations occur. */
  enabled: boolean;
  /** Whether to automatically index new projects on first visit. */
  autoIndex: boolean;
  /** Interval (in ms) for change detection polling. Default: 600000 (10 min). */
  pollIntervalMs: number;
  /** Maximum tokens per chunk. Default: 512. */
  chunkMaxTokens: number;
  /** Overlap tokens between chunks. Default: 50. */
  chunkOverlapTokens: number;
  /** Batch size for embedding API calls. Default: 20. */
  embeddingBatchSize: number;
  /** File count threshold for streaming mode. Default: 50000. */
  streamThreshold: number;
  /** Whether to enable knowledge graph features. Default: true. */
  enableGraph: boolean;
}

/**
 * Configuration for retrieval operations.
 */
export interface RetrievalConfig {
  /** Number of final results to return. Default: 20. */
  topK: number;
  /** Number of BM25 candidates to retrieve. Default: 50. */
  bm25TopK: number;
  /** Number of vector search candidates. Default: 50. */
  vectorTopK: number;
  /** Number of recent files to consider. Default: 20. */
  recentTopK: number;
  /** RRF fusion parameter. Default: 60. */
  rrfK: number;
  /** Maximum tokens in context. Default: 8000. */
  maxTokens: number;
  /** Whether to enable graph expansion. Default: true. */
  enableGraph: boolean;
  /** Maximum graph traversal depth. Default: 2. */
  graphDepth: number;
  /** Maximum nodes in graph subgraph. Default: 50. */
  maxGraphNodes: number;
  /** Weights for different retrieval sources. */
  weights: {
    bm25: number;
    vector: number;
    recent: number;
  };
}

// ===== Data Types =====

/**
 * Metadata for a source file.
 */
export interface FileMetadata {
  /** Relative path from project root. */
  path: string;
  /** SHA-256 hash of file content. */
  contentHash: string;
  /** Last modified timestamp (ms since epoch). */
  lastModified: number;
  /** File size in bytes. */
  size: number;
  /** Detected programming language. */
  language?: string;
}

/**
 * Type of code chunk based on AST analysis.
 */
export type ChunkType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'module'
  | 'import'
  | 'config'
  | 'block';

/**
 * Metadata associated with a code chunk.
 */
export interface ChunkMetadata {
  /** Programming language of the chunk. */
  language: string;
  /** Function name if chunk is a function. */
  functionName?: string;
  /** Class name if chunk is a class or method. */
  className?: string;
  /** List of imported modules. */
  imports?: string[];
  /** List of exported symbols. */
  exports?: string[];
  /** Function/method signature. */
  signature?: string;
  /** Whether the chunk content is collapsed (body replaced with "{ ... }"). */
  collapsed?: boolean;
}

/**
 * A chunk of code extracted from a source file.
 */
export interface Chunk {
  /** Unique identifier (UUID). */
  id: string;
  /** Source file path. */
  filepath: string;
  /** Chunk content. */
  content: string;
  /** Starting line number (1-based). */
  startLine: number;
  /** Ending line number (1-based). */
  endLine: number;
  /** Index of this chunk within the file. */
  index: number;
  /** SHA-256 hash of content. */
  contentHash: string;
  /** Semantic type of the chunk. */
  type: ChunkType;
  /** Additional metadata. */
  metadata: ChunkMetadata;
}

// ===== Status Types =====

/**
 * Current status of the indexing process.
 */
export type IndexStatus =
  | 'idle'
  | 'scanning'
  | 'chunking'
  | 'embedding'
  | 'storing'
  | 'done'
  | 'paused'
  | 'error';

/**
 * Progress information for indexing operations.
 */
export interface IndexingProgress {
  /** Current status. */
  status: IndexStatus;
  /** Current phase (1-4). */
  phase: number;
  /** Progress within current phase (0-100). */
  phaseProgress: number;
  /** Overall progress (0-100). */
  overallProgress: number;
  /** Number of files scanned. */
  scannedFiles: number;
  /** Total files to process. */
  totalFiles: number;
  /** Number of files chunked. */
  chunkedFiles: number;
  /** Number of chunks embedded. */
  embeddedChunks: number;
  /** Total chunks to embed. */
  totalChunks: number;
  /** Number of chunks stored. */
  storedChunks: number;
  /** Start timestamp (ms since epoch). */
  startTime: number;
  /** Estimated remaining time (seconds). */
  estimatedTimeRemaining?: number;
  /** Error message if status is 'error'. */
  error?: string;
  /** List of files that failed processing. */
  failedFiles?: string[];
}

// ===== Change Detection Types =====

/**
 * Set of detected file changes.
 */
export interface ChangeSet {
  /** Newly added files. */
  added: FileMetadata[];
  /** Modified files (content hash changed). */
  modified: FileMetadata[];
  /** Deleted file paths. */
  deleted: string[];
}

/**
 * Checks if a ChangeSet contains any changes.
 */
export function hasChanges(changeSet: ChangeSet): boolean {
  return (
    changeSet.added.length > 0 ||
    changeSet.modified.length > 0 ||
    changeSet.deleted.length > 0
  );
}

// ===== Retrieval Types =====

/**
 * A chunk with search score information.
 */
export interface ScoredChunk {
  /** Chunk ID. */
  id: string;
  /** File path. */
  filePath: string;
  /** Chunk content. */
  content: string;
  /** Starting line number. */
  startLine: number;
  /** Ending line number. */
  endLine: number;
  /** Search score. */
  score: number;
  /** Rank in search results. */
  rank: number;
  /** Source of this result. */
  source: 'bm25' | 'vector' | 'recent';
}

/**
 * Result from vector search.
 */
export interface VectorSearchResult {
  /** Chunk ID. */
  chunkId: string;
  /** File path. */
  filePath: string;
  /** Chunk content. */
  content: string;
  /** Similarity score. */
  score: number;
  /** Rank in results. */
  rank: number;
  /** Starting line number. */
  startLine: number;
  /** Ending line number. */
  endLine: number;
}

/**
 * Final retrieval result after RRF fusion.
 */
export interface RetrievalResult extends ScoredChunk {
  /** Fused score from RRF. */
  fusedScore: number;
}

/**
 * Complete retrieval response including graph data.
 */
export interface RetrievalResponse {
  /** Retrieved code chunks. */
  chunks: ScoredChunk[];
  /** @deprecated Legacy subgraph field, always null. */
  subgraph: null;
  /** Symbol-level graph expansion result. */
  symbolExpansion?: GraphExpansionResult | null;
  /** Formatted text view of code. */
  textView: string;
  /** @deprecated Legacy graph view field, always null. */
  graphView: null;
}

// ===== Symbol Graph Types (SQLite-based) =====

/**
 * Type of symbol extracted from source code.
 */
export type SymbolType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable';

/**
 * Type of edge between symbols in the graph.
 */
export type EdgeType =
  | 'CALLS'
  | 'IMPORTS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'CONTAINS';

/**
 * A symbol definition extracted from source code.
 */
export interface SymbolDefinition {
  /** Unique identifier: `${filePath}#${qualifiedName}`. */
  id: string;
  /** Simple symbol name (e.g., "myMethod"). */
  name: string;
  /** Qualified name including parent (e.g., "MyClass.myMethod"). */
  qualifiedName: string;
  /** Symbol type. */
  type: SymbolType;
  /** Source file path. */
  filePath: string;
  /** Starting line number (1-based). */
  startLine: number;
  /** Ending line number (1-based). */
  endLine: number;
  /** Associated chunk ID (mapped by line range overlap). */
  chunkId?: string;
  /** Function/class signature (first line of definition). */
  signature?: string;
  /** Whether the symbol is exported. */
  exported: boolean;
}

/**
 * An edge between two symbols in the graph.
 */
export interface SymbolEdge {
  /** Source symbol ID (or filePath#<module> for file-level edges). */
  sourceId: string;
  /** Target symbol ID. */
  targetId: string;
  /** Edge type. */
  type: EdgeType;
  /** File where this edge occurs (for incremental deletion). */
  filePath: string;
  /** Line number where the reference occurs. */
  line?: number;
}

/**
 * An import mapping for reference resolution.
 */
export interface ImportMapping {
  /** File containing the import statement. */
  filePath: string;
  /** Local binding name (e.g., import { Foo as Bar } → "Bar"). */
  localName: string;
  /** Source module path (e.g., "./utils"). */
  sourceModule: string;
  /** Original exported name (e.g., import { Foo as Bar } → "Foo", or "default" or "*"). */
  originalName: string;
  /** Resolved file path of the source module. */
  resolvedPath?: string;
}

/**
 * Options for graph expansion from seed chunks.
 */
export interface GraphExpansionOptions {
  /** Maximum traversal depth (default: 2). */
  maxDepth?: number;
  /** Maximum number of related chunks to return (default: 30). */
  maxChunks?: number;
  /** Edge types to traverse (default: all). */
  edgeTypes?: EdgeType[];
  /** Whether to traverse both directions (default: true). */
  bidirectional?: boolean;
}

/**
 * Result of a graph expansion query.
 */
export interface GraphExpansionResult {
  /** Related chunk IDs found via graph traversal, ordered by depth. */
  relatedChunkIds: string[];
  /** Symbols found during traversal (for optional Mermaid rendering). */
  symbols: SymbolDefinition[];
  /** Edges traversed (for optional Mermaid rendering). */
  edges: SymbolEdge[];
  /** Seed chunk IDs that started the expansion. */
  seedChunkIds: string[];
}

/**
 * Interface for SQLite-based symbol graph storage.
 * Replaces the old IGraphStore with a simpler, SQLite-powered approach
 * using adjacency tables + recursive CTEs for graph traversal.
 */
export interface ISymbolGraphStore {
  /** Initialize the database tables. */
  initialize(): void;

  /** Insert symbol definitions. */
  insertSymbols(symbols: SymbolDefinition[]): void;

  /** Insert edges between symbols. */
  insertEdges(edges: SymbolEdge[]): void;

  /** Insert import mappings for reference resolution. */
  insertImports(imports: ImportMapping[]): void;

  /**
   * Delete all graph data for a file (for incremental updates).
   * This removes symbols, edges, and imports originating from the file.
   */
  deleteByFilePath(filePath: string): void;

  /**
   * Update chunk ID mappings for symbols in a file.
   * Called after chunking to associate symbols with their containing chunks.
   *
   * @param filePath - File to update mappings for.
   * @param chunkRanges - Array of { chunkId, startLine, endLine }.
   */
  updateChunkMappings(
    filePath: string,
    chunkRanges: Array<{ chunkId: string; startLine: number; endLine: number }>,
  ): void;

  /**
   * Expand from seed chunk IDs to find related chunks via graph traversal.
   * This is the primary query method - uses SQLite recursive CTEs.
   *
   * @param seedChunkIds - Chunk IDs from reranker output.
   * @param options - Expansion options (depth, max chunks, edge types).
   * @returns Related chunk IDs and traversal metadata.
   */
  expandFromChunks(
    seedChunkIds: string[],
    options?: GraphExpansionOptions,
  ): GraphExpansionResult;

  /**
   * Get symbols by chunk IDs (for Mermaid graph building).
   */
  getSymbolsByChunkIds(chunkIds: string[]): SymbolDefinition[];

  /**
   * Get edges between a set of symbols (for Mermaid graph building).
   */
  getEdgesBetweenSymbols(symbolIds: string[]): SymbolEdge[];

  /** Get statistics about the graph. */
  getStats(): { symbolCount: number; edgeCount: number; importCount: number };

  /**
   * Batch-resolve deferred cross-file edges after all files are indexed.
   *
   * During per-file extraction, cross-file references are stored with
   * placeholder target IDs like `?#symbolName`. This method resolves them
   * by matching names globally against the symbols table.
   *
   * Resolution priority:
   * 1. Import-guided: if the source file has an import for the name,
   *    prefer the symbol from the imported file
   * 2. Exported symbols: prefer exported over internal symbols
   * 3. First match: if multiple candidates, pick the first one
   *
   * Unresolvable edges (no matching symbol anywhere) are removed.
   *
   * @returns Number of edges successfully resolved.
   */
  resolveEdgesByName(): number;

  /** Close the database connection. */
  close(): void;
}

// ===== Checkpoint Types =====

/**
 * Checkpoint for resumable index building.
 */
export interface BuildCheckpoint {
  /** Current phase. */
  phase: IndexStatus;
  /** Last successfully processed file path. */
  lastProcessedPath: string | null;
  /** Chunk IDs pending embedding. */
  pendingChunkIds: string[];
  /** Checkpoint timestamp. */
  updatedAt: number;
}

// ===== Worker Message Types =====

/**
 * Messages sent from main thread to worker.
 */
export type WorkerMessage =
  | { type: 'build'; payload: { resumeFromCheckpoint?: boolean } }
  | { type: 'incremental_update'; payload: { changes?: ChangeSet } }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'get_status' };

/**
 * Messages sent from worker to main thread.
 */
export type WorkerResponse =
  | { type: 'progress'; payload: IndexingProgress }
  | { type: 'build_complete' }
  | { type: 'update_complete' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'cancelled' }
  | { type: 'status'; payload: IndexingProgress }
  | { type: 'error'; payload: { message: string } };
