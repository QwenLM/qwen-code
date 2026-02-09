/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Storage } from '../../config/storage.js';
import type {
  BuildCheckpoint,
  Chunk,
  FileMetadata,
  IMetadataStore,
  IndexingProgress,
  IndexStatus,
  ScoredChunk,
} from '../types.js';

/**
 * SQL schema for the metadata database.
 * Includes tables for file metadata, chunks, FTS index, embedding cache,
 * index status, and build checkpoints.
 */
const SCHEMA = `
-- File metadata table
CREATE TABLE IF NOT EXISTS file_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    last_modified INTEGER NOT NULL,
    size INTEGER NOT NULL,
    language TEXT,
    indexed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_file_meta_path ON file_meta(path);
CREATE INDEX IF NOT EXISTS idx_file_meta_hash ON file_meta(content_hash);

-- Code chunks table
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_type TEXT,
    metadata_json TEXT,
    FOREIGN KEY (file_id) REFERENCES file_meta(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

-- Embedding cache table (avoids recomputing embeddings)
CREATE TABLE IF NOT EXISTS embedding_cache (
    cache_key TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- FTS5 full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
    file_path,
    content,
    content='chunks',
    content_rowid='rowid',
    tokenize='trigram'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO fts_chunks(rowid, file_path, content) VALUES (new.rowid, new.file_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO fts_chunks(fts_chunks, rowid, file_path, content) VALUES('delete', old.rowid, old.file_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO fts_chunks(fts_chunks, rowid, file_path, content) VALUES('delete', old.rowid, old.file_path, old.content);
    INSERT INTO fts_chunks(rowid, file_path, content) VALUES (new.rowid, new.file_path, new.content);
END;

-- Index status table (singleton)
CREATE TABLE IF NOT EXISTS index_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'idle',
    phase INTEGER DEFAULT 0,
    phase_progress INTEGER DEFAULT 0,
    overall_progress INTEGER DEFAULT 0,
    scanned_files INTEGER DEFAULT 0,
    total_files INTEGER DEFAULT 0,
    chunked_files INTEGER DEFAULT 0,
    embedded_chunks INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 0,
    stored_chunks INTEGER DEFAULT 0,
    start_time INTEGER,
    estimated_time_remaining INTEGER,
    error TEXT,
    failed_files_json TEXT
);

INSERT OR IGNORE INTO index_status (id) VALUES (1);

-- Build checkpoint table for crash recovery
CREATE TABLE IF NOT EXISTS build_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT,
    last_processed_path TEXT,
    pending_chunk_ids_json TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

INSERT OR IGNORE INTO build_checkpoint (id, phase) VALUES (1, NULL);
`;

/**
 * Gets the index directory path for a project.
 * @param projectHash SHA-256 hash of the project root path.
 * @returns Absolute path to the index directory.
 */
export function getIndexDir(projectHash: string): string {
  return path.join(Storage.getGlobalQwenDir(), 'index', projectHash);
}

/**
 * SQLite-based metadata storage for codebase indexing.
 * Handles file metadata, chunks, FTS index, embedding cache, and status tracking.
 */
export class MetadataStore implements IMetadataStore {
  private db: Database.Database;
  private readonly dbPath: string;

  /**
   * Creates a new MetadataStore instance.
   * @param projectHash SHA-256 hash of the project root path (first 16 chars recommended).
   */
  constructor(projectHash: string) {
    this.dbPath = path.join(getIndexDir(projectHash), 'metadata.db');

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database with WAL mode for better concurrent performance
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize schema
    this.db.exec(SCHEMA);
  }

  /**
   * Inserts or updates file metadata in a single transaction.
   * @param files Array of file metadata to insert.
   */
  insertFileMeta(files: FileMetadata[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO file_meta (path, content_hash, last_modified, size, language)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((files: FileMetadata[]) => {
      for (const file of files) {
        insert.run(
          file.path,
          file.contentHash,
          file.lastModified,
          file.size,
          file.language ?? null,
        );
      }
    });

    transaction(files);
  }

  /**
   * Gets file metadata by path.
   * @param filePath Relative file path.
   * @returns FileMetadata or null if not found.
   */
  getFileMeta(filePath: string): FileMetadata | null {
    const row = this.db
      .prepare(
        `
      SELECT path, content_hash as contentHash, last_modified as lastModified, size, language
      FROM file_meta WHERE path = ?
    `,
      )
      .get(filePath) as
      | {
          path: string;
          contentHash: string;
          lastModified: number;
          size: number;
          language: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      path: row.path,
      contentHash: row.contentHash,
      lastModified: row.lastModified,
      size: row.size,
      language: row.language ?? undefined,
    };
  }

  /**
   * Gets all indexed file metadata.
   * @returns Array of all FileMetadata records.
   */
  getAllFileMeta(): FileMetadata[] {
    const rows = this.db
      .prepare(
        `
      SELECT path, content_hash as contentHash, last_modified as lastModified, size, language
      FROM file_meta
    `,
      )
      .all() as Array<{
      path: string;
      contentHash: string;
      lastModified: number;
      size: number;
      language: string | null;
    }>;

    return rows.map((row) => ({
      path: row.path,
      contentHash: row.contentHash,
      lastModified: row.lastModified,
      size: row.size,
      language: row.language ?? undefined,
    }));
  }

  /**
   * Deletes file metadata by paths.
   * Associated chunks will be deleted via CASCADE.
   * @param paths Array of file paths to delete.
   */
  deleteFileMeta(paths: string[]): void {
    if (paths.length === 0) return;

    const placeholders = paths.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM file_meta WHERE path IN (${placeholders})`)
      .run(...paths);
  }

  /**
   * Inserts chunks in batches for optimal performance.
   * @param chunks Array of chunks to insert.
   */
  insertChunks(chunks: Chunk[]): void {
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO chunks 
      (id, file_id, file_path, content, start_line, end_line, chunk_index, content_hash, chunk_type, metadata_json)
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?
      FROM file_meta WHERE path = ?
    `);

    const BATCH_SIZE = 500;
    const transaction = this.db.transaction((batch: Chunk[]) => {
      for (const chunk of batch) {
        insertChunk.run(
          chunk.id,
          chunk.filepath,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          chunk.index,
          chunk.contentHash,
          chunk.type,
          JSON.stringify(chunk.metadata),
          chunk.filepath,
        );
      }
    });

    // Process in batches
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      transaction(chunks.slice(i, i + BATCH_SIZE));
    }
  }

  /**
   * Gets all chunks for a file.
   * @param filePath File path.
   * @returns Array of chunks for the file.
   */
  getChunksByFilePath(filePath: string): Chunk[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, file_path as filepath, content, start_line as startLine, end_line as endLine,
             chunk_index as "index", content_hash as contentHash, chunk_type as type, metadata_json
      FROM chunks WHERE file_path = ?
      ORDER BY chunk_index
    `,
      )
      .all(filePath) as Array<{
      id: string;
      filepath: string;
      content: string;
      startLine: number;
      endLine: number;
      index: number;
      contentHash: string;
      type: string;
      metadata_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      filepath: row.filepath,
      content: row.content,
      startLine: row.startLine,
      endLine: row.endLine,
      index: row.index,
      contentHash: row.contentHash,
      type: row.type as Chunk['type'],
      metadata: JSON.parse(row.metadata_json || '{}'),
    }));
  }

  /**
   * Deletes chunks by file paths.
   * @param filePaths Array of file paths whose chunks should be deleted.
   */
  deleteChunksByFilePath(filePaths: string[]): void {
    if (filePaths.length === 0) return;

    const placeholders = filePaths.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM chunks WHERE file_path IN (${placeholders})`)
      .run(...filePaths);
  }

  /**
   * Gets the first chunk from the most recently modified files.
   * Uses a single optimized SQL query with JOIN and window functions.
   *
   * @param limit Maximum number of chunks to return.
   * @returns Array of scored chunks from recent files.
   */
  getRecentChunks(limit: number): ScoredChunk[] {
    // Use a subquery with ROW_NUMBER() to get only the first chunk (chunk_index = 0) from each file,
    // joined with file_meta to get last_modified for sorting
    const rows = this.db
      .prepare(
        `
      SELECT 
        c.id,
        c.file_path as filePath,
        c.content,
        c.start_line as startLine,
        c.end_line as endLine,
        f.last_modified as lastModified,
        ROW_NUMBER() OVER (ORDER BY f.last_modified DESC) as recency_rank
      FROM chunks c
      INNER JOIN file_meta f ON c.file_path = f.path
      WHERE c.chunk_index = 0
      ORDER BY f.last_modified DESC
      LIMIT ?
    `,
      )
      .all(limit) as Array<{
      id: string;
      filePath: string;
      content: string;
      startLine: number;
      endLine: number;
      lastModified: number;
      recency_rank: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      filePath: row.filePath,
      content: row.content,
      startLine: row.startLine,
      endLine: row.endLine,
      // Score based on recency: most recent = 1.0, decreasing by 0.05 per rank
      score: Math.max(0, 1.0 - (row.recency_rank - 1) * 0.05),
      rank: row.recency_rank,
      source: 'recent' as const,
    }));
  }

  /**
   * Gets the primary programming languages in the repository.
   * Returns languages sorted by file count (most common first).
   * Excludes null/undefined languages.
   * @param limit Maximum number of languages to return (default: 5).
   * @returns Array of language names, e.g., ['typescript', 'javascript', 'python'].
   */
  getPrimaryLanguages(): string[] {
    const rows = this.db
      .prepare(
        `
      SELECT language, COUNT(*) as file_count
      FROM file_meta
      WHERE language IS NOT NULL AND language != ''
      GROUP BY language
      ORDER BY file_count DESC
      LIMIT ?
    `,
      )
      .all(5) as Array<{ language: string; file_count: number }>;
    const allFileCounts = rows.reduce((sum, row) => sum + row.file_count, 0);
    // Only return languages that make up at least 30% of files
    const filteredRows = rows.filter(
      (row) => row.file_count / allFileCounts >= 0.2,
    );

    return filteredRows.map((row) => row.language);
  }

  /**
   * Performs BM25 full-text search on chunks.
   * @param query Search query string.
   * @param limit Maximum number of results.
   * @returns Array of scored chunks.
   */
  searchFTS(query: string, limit: number): ScoredChunk[] {
    // Escape special FTS5 characters and tokenize
    const sanitizedQuery = this.sanitizeFTSQuery(query);
    if (!sanitizedQuery) return [];

    const rows = this.db
      .prepare(
        `
      SELECT 
        c.id,
        c.file_path as filePath,
        c.content,
        c.start_line as startLine,
        c.end_line as endLine,
        bm25(fts_chunks, 1.0, 0.75) as score
      FROM fts_chunks
      JOIN chunks c ON fts_chunks.rowid = c.rowid
      WHERE fts_chunks MATCH ?
      ORDER BY score
      LIMIT ?
    `,
      )
      .all(sanitizedQuery, limit) as Array<{
      id: string;
      filePath: string;
      content: string;
      startLine: number;
      endLine: number;
      score: number;
    }>;

    return rows.map((row, index) => ({
      id: row.id,
      filePath: row.filePath,
      content: row.content,
      startLine: row.startLine,
      endLine: row.endLine,
      score: row.score,
      rank: index + 1,
      source: 'bm25' as const,
    }));
  }

  /**
   * Sanitizes a query string for FTS5.
   * Filters out single characters and special FTS5 characters.
   * @param query Raw query string.
   * @returns Sanitized query string, or empty string if no valid terms.
   */
  private sanitizeFTSQuery(query: string): string {
    // Remove special FTS5 characters and wrap terms in quotes
    const terms = query
      .replace(/[*:^"(){}[\]]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 1); // Filter single characters for better search quality

    if (terms.length === 0) {
      return '';
    }

    return terms.map((term) => `"${term}"`).join(' OR ');
  }

  /**
   * Gets cached embedding by cache key.
   * @param cacheKey Cache key (usually hash of content + metadata).
   * @returns Embedding array or null if not cached.
   */
  getEmbeddingCache(cacheKey: string): number[] | null {
    const row = this.db
      .prepare('SELECT embedding FROM embedding_cache WHERE cache_key = ?')
      .get(cacheKey) as { embedding: Buffer } | undefined;

    if (!row) return null;

    // Convert Buffer to Float32Array then to number[]
    const float32 = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    return Array.from(float32);
  }

  /**
   * Stores an embedding in the cache.
   * @param cacheKey Cache key.
   * @param embedding Embedding array.
   */
  setEmbeddingCache(cacheKey: string, embedding: number[]): void {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO embedding_cache (cache_key, embedding)
      VALUES (?, ?)
    `,
      )
      .run(cacheKey, buffer);
  }

  /**
   * Gets the current index status.
   * @returns Current IndexingProgress.
   */
  getIndexStatus(): IndexingProgress {
    const row = this.db
      .prepare(
        `
      SELECT status, phase, phase_progress, overall_progress,
             scanned_files, total_files, chunked_files,
             embedded_chunks, total_chunks, stored_chunks,
             start_time, estimated_time_remaining, error, failed_files_json
      FROM index_status WHERE id = 1
    `,
      )
      .get() as {
      status: IndexStatus;
      phase: number;
      phase_progress: number;
      overall_progress: number;
      scanned_files: number;
      total_files: number;
      chunked_files: number;
      embedded_chunks: number;
      total_chunks: number;
      stored_chunks: number;
      start_time: number | null;
      estimated_time_remaining: number | null;
      error: string | null;
      failed_files_json: string | null;
    };

    return {
      status: row.status,
      phase: row.phase,
      phaseProgress: row.phase_progress,
      overallProgress: row.overall_progress,
      scannedFiles: row.scanned_files,
      totalFiles: row.total_files,
      chunkedFiles: row.chunked_files,
      embeddedChunks: row.embedded_chunks,
      totalChunks: row.total_chunks,
      storedChunks: row.stored_chunks,
      startTime: row.start_time ?? 0,
      estimatedTimeRemaining: row.estimated_time_remaining ?? undefined,
      error: row.error ?? undefined,
      failedFiles: row.failed_files_json
        ? JSON.parse(row.failed_files_json)
        : undefined,
    };
  }

  /**
   * Updates the index status.
   * @param status Partial status update.
   */
  updateIndexStatus(status: Partial<IndexingProgress>): void {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (status.status !== undefined) {
      updates.push('status = ?');
      values.push(status.status);
    }
    if (status.phase !== undefined) {
      updates.push('phase = ?');
      values.push(status.phase);
    }
    if (status.phaseProgress !== undefined) {
      updates.push('phase_progress = ?');
      values.push(status.phaseProgress);
    }
    if (status.overallProgress !== undefined) {
      updates.push('overall_progress = ?');
      values.push(status.overallProgress);
    }
    if (status.scannedFiles !== undefined) {
      updates.push('scanned_files = ?');
      values.push(status.scannedFiles);
    }
    if (status.totalFiles !== undefined) {
      updates.push('total_files = ?');
      values.push(status.totalFiles);
    }
    if (status.chunkedFiles !== undefined) {
      updates.push('chunked_files = ?');
      values.push(status.chunkedFiles);
    }
    if (status.embeddedChunks !== undefined) {
      updates.push('embedded_chunks = ?');
      values.push(status.embeddedChunks);
    }
    if (status.totalChunks !== undefined) {
      updates.push('total_chunks = ?');
      values.push(status.totalChunks);
    }
    if (status.storedChunks !== undefined) {
      updates.push('stored_chunks = ?');
      values.push(status.storedChunks);
    }
    if (status.startTime !== undefined) {
      updates.push('start_time = ?');
      values.push(status.startTime);
    }
    if (status.estimatedTimeRemaining !== undefined) {
      updates.push('estimated_time_remaining = ?');
      values.push(status.estimatedTimeRemaining);
    }
    if (status.error !== undefined) {
      updates.push('error = ?');
      values.push(status.error);
    }
    if (status.failedFiles !== undefined) {
      updates.push('failed_files_json = ?');
      values.push(JSON.stringify(status.failedFiles));
    }

    if (updates.length === 0) return;

    this.db
      .prepare(`UPDATE index_status SET ${updates.join(', ')} WHERE id = 1`)
      .run(...values);
  }

  /**
   * Gets the current build checkpoint.
   * @returns BuildCheckpoint or null if no checkpoint exists.
   */
  getCheckpoint(): BuildCheckpoint | null {
    const row = this.db
      .prepare(
        `
      SELECT phase, last_processed_path, pending_chunk_ids_json, updated_at
      FROM build_checkpoint WHERE id = 1
    `,
      )
      .get() as {
      phase: string | null;
      last_processed_path: string | null;
      pending_chunk_ids_json: string | null;
      updated_at: number;
    };

    if (!row.phase) return null;

    return {
      phase: row.phase as IndexStatus,
      lastProcessedPath: row.last_processed_path,
      pendingChunkIds: row.pending_chunk_ids_json
        ? JSON.parse(row.pending_chunk_ids_json)
        : [],
      updatedAt: row.updated_at,
    };
  }

  /**
   * Saves a build checkpoint.
   * @param checkpoint Checkpoint to save.
   */
  saveCheckpoint(checkpoint: BuildCheckpoint): void {
    this.db
      .prepare(
        `
      UPDATE build_checkpoint SET
        phase = ?,
        last_processed_path = ?,
        pending_chunk_ids_json = ?,
        updated_at = ?
      WHERE id = 1
    `,
      )
      .run(
        checkpoint.phase,
        checkpoint.lastProcessedPath,
        JSON.stringify(checkpoint.pendingChunkIds),
        checkpoint.updatedAt,
      );
  }

  /**
   * Clears the build checkpoint.
   */
  clearCheckpoint(): void {
    this.db
      .prepare(
        `
      UPDATE build_checkpoint SET
        phase = NULL,
        last_processed_path = NULL,
        pending_chunk_ids_json = NULL,
        updated_at = ?
      WHERE id = 1
    `,
      )
      .run(Date.now());
  }

  /**
   * Gets statistics about the stored data.
   * @returns Object with file count, chunk count, and cache size.
   */
  getStats(): { fileCount: number; chunkCount: number; cacheCount: number } {
    const fileCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM file_meta').get() as {
        count: number;
      }
    ).count;
    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
        count: number;
      }
    ).count;
    const cacheCount = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM embedding_cache')
        .get() as {
        count: number;
      }
    ).count;

    return { fileCount, chunkCount, cacheCount };
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }
}
