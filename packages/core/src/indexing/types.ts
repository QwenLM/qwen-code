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

/**
 * Interface for graph storage operations.
 */
export interface IGraphStore {
  initialize(): Promise<void>;
  insertEntities(entities: GraphEntity[]): Promise<void>;
  insertRelations(relations: GraphRelation[]): Promise<void>;
  getEntitiesByChunkIds(chunkIds: string[]): Promise<string[]>;
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown[]>;
  deleteByFilePath(filePath: string): Promise<void>;
  getStats(): Promise<{ nodeCount: number; edgeCount: number }>;
  close(): Promise<void>;
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
  /** Extracted dependency subgraph. */
  subgraph: GraphSubgraph | null;
  /** Formatted text view of code. */
  textView: string;
  /** Mermaid-formatted graph view. */
  graphView: string | null;
}

// ===== Graph Types =====

/**
 * Type of code entity in the knowledge graph.
 */
export type EntityType =
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'variable'
  | 'type';

/**
 * Type of relationship between entities.
 */
export type RelationType =
  | 'IMPORTS'
  | 'EXPORTS'
  | 'CONTAINS'
  | 'CALLS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'USES'
  | 'DEFINES';

/**
 * A code entity node in the knowledge graph.
 */
export interface GraphEntity {
  /** Unique identifier: `${filePath}#${name}`. */
  id: string;
  /** Entity name. */
  name: string;
  /** Entity type. */
  type: EntityType;
  /** Source file path. */
  filePath: string;
  /** Starting line number. */
  startLine: number;
  /** Ending line number. */
  endLine: number;
  /** Function/class signature. */
  signature?: string;
  /** Documentation comment. */
  docstring?: string;
  /** Associated chunk ID. */
  chunkId?: string;
}

/**
 * A relationship edge in the knowledge graph.
 */
export interface GraphRelation {
  /** Source entity ID. */
  sourceId: string;
  /** Target entity ID. */
  targetId: string;
  /** Relationship type. */
  type: RelationType;
  /** Additional metadata. */
  metadata?: {
    /** Line number where relation occurs. */
    line?: number;
    /** Import alias. */
    alias?: string;
  };
}

/**
 * A subgraph extracted from the knowledge graph.
 */
export interface GraphSubgraph {
  /** Entities in the subgraph. */
  entities: GraphEntity[];
  /** Relations in the subgraph. */
  relations: GraphRelation[];
  /** Seed entity IDs. */
  seedIds: string[];
  /** Traversal depth. */
  depth: number;
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
