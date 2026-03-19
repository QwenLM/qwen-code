/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  IndexConfig,
  IndexingProgress,
  IndexStatus,
  FileMetadata,
  Chunk,
  ChangeSet,
  IFileScanner,
  IChunkingService,
  IEmbeddingService,
  IMetadataStore,
  IVectorStore,
  ISymbolGraphStore,
  BuildCheckpoint,
} from './types.js';
import { DEFAULT_INDEX_CONFIG } from './defaults.js';
import { FileScanner } from './fileScanner.js';
import { ChunkingService } from './chunkingService.js';
import { SymbolExtractor } from './symbolExtractor.js';
import { EmbeddingService, type ILlmClient } from './embeddingService.js';
import { EmbeddingCache } from './embeddingCache.js';
import { parseFile } from './treeSitterParser.js';
import {
  PerformanceProfiler,
  type ProfilingSummary,
} from './performanceProfiler.js';

/**
 * Callback for progress updates.
 */
export type ProgressCallback = (progress: IndexingProgress) => void;

/**
 * IndexManager coordinates the entire indexing pipeline:
 * Scanner → Chunker → SymbolExtractor → Embedder → Store
 */
export class IndexManager {
  private projectRoot: string;
  private config: IndexConfig;

  // Components
  private fileScanner: IFileScanner;
  private chunkingService: IChunkingService;
  private symbolExtractor: SymbolExtractor;
  private embeddingService: IEmbeddingService;
  private metadataStore: IMetadataStore;
  private vectorStore: IVectorStore;
  private symbolGraphStore: ISymbolGraphStore | null;

  // State
  private progress: IndexingProgress;
  private isPaused = false;
  private isCancelled = false;
  private progressCallback: ProgressCallback | null = null;
  private cachedFileMeta: FileMetadata[] | null = null;

  // Performance profiling
  private profiler: PerformanceProfiler;
  private enableProfiling: boolean = true;

  // Batch sizes
  private readonly FILE_BATCH_SIZE = 100;

  constructor(
    projectRoot: string,
    metadataStore: IMetadataStore,
    vectorStore: IVectorStore,
    llmClient: ILlmClient,
    config: Partial<IndexConfig> = {},
    symbolGraphStore: ISymbolGraphStore | null = null,
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.config = { ...DEFAULT_INDEX_CONFIG, ...config };

    // Initialize components
    this.fileScanner = new FileScanner(this.projectRoot);
    this.chunkingService = new ChunkingService({
      maxChunkTokens: this.config.chunkMaxTokens,
      overlapTokens: this.config.chunkOverlapTokens,
    });
    this.symbolExtractor = new SymbolExtractor(this.projectRoot);

    // Initialize embedding service with cache
    const embeddingCache = new EmbeddingCache(metadataStore);
    this.embeddingService = new EmbeddingService(llmClient, embeddingCache, {
      batchSize: this.config.embeddingBatchSize,
    });

    this.metadataStore = metadataStore;
    this.vectorStore = vectorStore;
    this.symbolGraphStore = symbolGraphStore;

    // Initialize profiler
    this.profiler = PerformanceProfiler.getInstance();

    // Initialize progress
    this.progress = this.createInitialProgress();
  }

  /**
   * Build the entire index from scratch.
   * Supports resuming from checkpoint if available.
   *
   * @param onProgress - Optional callback for progress updates
   * @param options - Build options including pre-computed file count and checkpoint resume
   */
  async build(
    onProgress?: ProgressCallback,
    options?: { preComputedFileCount?: number; resumeFromCheckpoint?: boolean },
  ): Promise<void> {
    this.progressCallback = onProgress || null;
    this.isPaused = false;
    this.isCancelled = false;
    this.progress = this.createInitialProgress();

    // Start profiling
    if (this.enableProfiling) {
      this.profiler.start();
    }

    // Check for existing checkpoint to resume from
    const checkpoint =
      options?.resumeFromCheckpoint !== false
        ? this.metadataStore.getCheckpoint()
        : null;
    const resumePhase = checkpoint?.phase;

    try {
      // Phase 1: Scan files (skip if already past this phase)
      if (
        !resumePhase ||
        resumePhase === 'scanning' ||
        resumePhase === 'idle'
      ) {
        await this.scanPhase(options?.preComputedFileCount);
        if (this.isCancelled) return;
      } else {
        // Load cached file meta from store
        this.cachedFileMeta = this.metadataStore.getAllFileMeta();
        this.updateProgress({
          status: 'scanning',
          phase: 1,
          totalFiles: this.cachedFileMeta.length,
          scannedFiles: this.cachedFileMeta.length,
          phaseProgress: 100,
          overallProgress: 25,
        });
      }

      // Phase 2: Chunk files (skip if already past this phase)
      if (
        !resumePhase ||
        resumePhase === 'scanning' ||
        resumePhase === 'chunking'
      ) {
        await this.chunkPhase();
        if (this.isCancelled) return;
      } else {
        // Count existing chunks
        const files =
          this.cachedFileMeta ?? this.metadataStore.getAllFileMeta();
        let totalChunks = 0;
        for (const file of files) {
          totalChunks += this.metadataStore.getChunksByFilePath(
            file.path,
          ).length;
        }
        this.updateProgress({
          status: 'chunking',
          phase: 2,
          chunkedFiles: files.length,
          totalChunks,
          phaseProgress: 100,
          overallProgress: 50,
        });
      }

      // Phase 3: Generate embeddings (resume from checkpoint if available)
      await this.embeddingPhase(checkpoint?.lastProcessedPath);
      if (this.isCancelled) return;

      // Phase 4: Store to vector database
      await this.storePhase();

      // Phase 5: Resolve cross-file symbol edges by global name matching
      this.resolveSymbolEdges();

      // Mark as done
      this.updateProgress({
        status: 'done',
        phase: 4,
        phaseProgress: 100,
        overallProgress: 100,
      });
      this.metadataStore.clearCheckpoint();

      // Stop profiling and log report
      if (this.enableProfiling) {
        this.profiler.stop();
        // console.log(this.profiler.formatReport());
      }
    } catch (error) {
      // Stop profiling on error
      if (this.enableProfiling && this.profiler.isActive()) {
        this.profiler.stop();
        // console.log(this.profiler.formatReport());
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateProgress({ status: 'error', error: errorMsg });
      throw error;
    }
  }

  /**
   * Perform incremental update based on changes.
   *
   * @param changes - The change set to process
   * @param onProgress - Optional callback for progress updates
   */
  async incrementalUpdate(
    changes: ChangeSet,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    this.progressCallback = onProgress || null;
    this.isPaused = false;
    this.isCancelled = false;

    try {
      // Handle deletions first (fastest)
      if (changes.deleted.length > 0) {
        await this.handleDeletions(changes.deleted);
      }

      // Handle modifications (delete then re-add)
      if (changes.modified.length > 0) {
        const modifiedPaths = changes.modified.map((f) => f.path);
        await this.handleDeletions(modifiedPaths);
      }

      // Process new and modified files together
      const filesToProcess = [...changes.added, ...changes.modified];
      if (filesToProcess.length > 0) {
        await this.processFiles(filesToProcess);
      }

      // Resolve cross-file symbol edges by global name matching
      this.resolveSymbolEdges();

      this.updateProgress({ status: 'done' });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateProgress({ status: 'error', error: errorMsg });
      throw error;
    }
  }

  /**
   * Build index using streaming mode for large repositories.
   * This method processes files in smaller batches to avoid memory overflow.
   * Recommended for repositories with more than 50,000 files.
   *
   * Uses true streaming file scanning to minimize memory usage - file list is
   * never fully loaded into memory, instead processed batch by batch.
   *
   * @param onProgress - Optional callback for progress updates
   * @param options - Build options
   * @param options.streamBatchSize - Number of files to process per batch. Default: 100.
   * @param options.preComputedFileCount - Pre-computed file count to avoid duplicate scanning.
   */
  async buildStreaming(
    onProgress?: ProgressCallback,
    options?: { streamBatchSize?: number; preComputedFileCount?: number },
  ): Promise<void> {
    const streamBatchSize = options?.streamBatchSize ?? 100;
    this.progressCallback = onProgress || null;
    this.isPaused = false;
    this.isCancelled = false;
    this.progress = this.createInitialProgress();

    try {
      // Phase 1: Count files (use pre-computed if available)
      this.updateProgress({ status: 'scanning', phase: 1, phaseProgress: 0 });
      const totalFiles =
        options?.preComputedFileCount ??
        (await this.fileScanner.countFiles(this.projectRoot));
      this.updateProgress({ totalFiles, phaseProgress: 10 });

      if (this.isCancelled) return;

      // Phase 2-4: Stream process files in batches using true streaming
      let processedFiles = 0;
      let totalChunks = 0;
      let embeddedChunks = 0;

      // Check if streaming method is available (implemented in FileScanner)
      const scanner = this.fileScanner as FileScanner;
      const streamingMethod = scanner.scanFilesStreaming?.bind(scanner);

      if (streamingMethod) {
        // Use true streaming - files are yielded in batches without loading all into memory
        for await (const batch of streamingMethod(
          this.projectRoot,
          streamBatchSize,
        )) {
          await this.waitIfPaused();
          if (this.isCancelled) return;

          // Process each file in the batch
          const batchResult = await this.processBatchStreaming(batch);
          processedFiles += batchResult.processedFiles;
          totalChunks += batchResult.totalChunks;
          embeddedChunks += batchResult.embeddedChunks;

          // Update progress after each batch
          const overallProgress = Math.round(
            (processedFiles / totalFiles) * 100,
          );
          this.updateProgress({
            scannedFiles: processedFiles,
            chunkedFiles: processedFiles,
            totalChunks,
            embeddedChunks,
            storedChunks: embeddedChunks,
            overallProgress,
            phase: 2,
            phaseProgress: overallProgress,
          });

          // Save checkpoint after each batch
          this.saveCheckpoint();
        }
      } else {
        // Fallback: load all files but process in batches (legacy behavior)
        const allFiles = await this.fileScanner.scanFiles(this.projectRoot);

        for (let i = 0; i < allFiles.length; i += streamBatchSize) {
          await this.waitIfPaused();
          if (this.isCancelled) return;

          const batch = allFiles.slice(i, i + streamBatchSize);
          const batchResult = await this.processBatchStreaming(batch);
          processedFiles += batchResult.processedFiles;
          totalChunks += batchResult.totalChunks;
          embeddedChunks += batchResult.embeddedChunks;

          // Update progress after each batch
          const overallProgress = Math.round(
            (processedFiles / totalFiles) * 100,
          );
          this.updateProgress({
            scannedFiles: processedFiles,
            chunkedFiles: processedFiles,
            totalChunks,
            embeddedChunks,
            storedChunks: embeddedChunks,
            overallProgress,
            phase: 2,
            phaseProgress: overallProgress,
          });

          // Save checkpoint after each batch
          this.saveCheckpoint();
        }
      }

      // Resolve cross-file symbol edges by global name matching
      this.resolveSymbolEdges();

      // Optimize vector store at the end
      this.updateProgress({ status: 'storing', phase: 4, phaseProgress: 50 });
      this.vectorStore.optimize();

      // Mark as done
      this.updateProgress({
        status: 'done',
        phase: 4,
        phaseProgress: 100,
        overallProgress: 100,
      });
      this.metadataStore.clearCheckpoint();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateProgress({ status: 'error', error: errorMsg });
      throw error;
    }
  }

  /**
   * Process a batch of files through the full pipeline.
   * Used by buildStreaming for both streaming and fallback modes.
   */
  private async processBatchStreaming(batch: FileMetadata[]): Promise<{
    processedFiles: number;
    totalChunks: number;
    embeddedChunks: number;
  }> {
    let processedFiles = 0;
    let totalChunks = 0;
    let embeddedChunks = 0;

    for (const file of batch) {
      try {
        // Read content
        const content = await this.readFileContent(file.path);

        // Parse AST once for both chunking and entity extraction
        const parseResult = await parseFile(file.path, content);

        // Chunk using pre-parsed AST
        const chunks = await this.chunkingService.chunkFile(
          file.path,
          content,
          parseResult,
        );

        if (chunks.length === 0) {
          processedFiles++;
          continue;
        }

        // Store file metadata
        this.metadataStore.insertFileMeta([file]);
        this.metadataStore.insertChunks(chunks);
        totalChunks += chunks.length;

        // Extract symbols for symbol graph (using same AST)
        await this.extractAndStoreSymbols(
          file.path,
          content,
          chunks,
          parseResult,
        );

        // Generate embeddings and store immediately
        const chunkEmbeddings = await this.embeddingService.embedChunks(chunks);
        await this.vectorStore.insertBatch(chunkEmbeddings);
        embeddedChunks += chunkEmbeddings.length;

        processedFiles++;
      } catch (error) {
        console.warn(`Failed to process file ${file.path}: ${error}`);
        this.addFailedFile(file.path);
        processedFiles++;
      }
    }

    return { processedFiles, totalChunks, embeddedChunks };
  }

  /**
   * Pause the indexing process.
   */
  pause(): void {
    this.isPaused = true;
    this.updateProgress({ status: 'paused' });
    this.saveCheckpoint();
  }

  /**
   * Resume the indexing process.
   */
  resume(): void {
    this.isPaused = false;
    this.updateProgress({ status: this.getPhaseStatus() });
  }

  /**
   * Cancel the indexing process.
   */
  cancel(): void {
    this.isCancelled = true;
    this.updateProgress({ status: 'idle' });
  }

  /**
   * Get current progress.
   */
  getProgress(): IndexingProgress {
    return { ...this.progress };
  }

  // ===== Phase Implementations =====

  /**
   * Phase 1: Scan files.
   * @param preComputedFileCount - Pre-computed file count to avoid duplicate scanning.
   */
  private async scanPhase(preComputedFileCount?: number): Promise<void> {
    this.updateProgress({ status: 'scanning', phase: 1, phaseProgress: 0 });

    // Use pre-computed count or count files
    const totalFiles =
      preComputedFileCount ??
      (await this.profiler.trackAsync('FileScanner.countFiles', () =>
        this.fileScanner.countFiles(this.projectRoot),
      ));
    this.updateProgress({ totalFiles });

    // Scan all files
    const files = await this.profiler.trackAsync('FileScanner.scanFiles', () =>
      this.fileScanner.scanFiles(this.projectRoot),
    );
    this.updateProgress({
      scannedFiles: files.length,
      phaseProgress: 100,
      overallProgress: 25,
    });

    // Store file metadata and cache for later phases
    this.profiler.track('MetadataStore.insertFileMeta', () => {
      this.metadataStore.insertFileMeta(files);
    });
    this.cachedFileMeta = files;
  }

  /**
   * Phase 2: Chunk files.
   */
  private async chunkPhase(): Promise<void> {
    this.updateProgress({ status: 'chunking', phase: 2, phaseProgress: 0 });

    // Use cached file list or fetch from store
    const files = this.cachedFileMeta ?? this.metadataStore.getAllFileMeta();
    let chunkedFiles = 0;
    let totalChunks = 0;

    for (let i = 0; i < files.length; i += this.FILE_BATCH_SIZE) {
      await this.waitIfPaused();
      if (this.isCancelled) return;

      const batch = files.slice(i, i + this.FILE_BATCH_SIZE);
      const batchChunks: Chunk[] = [];

      for (const file of batch) {
        try {
          const content = await this.profiler.trackAsync('fs.readFile', () =>
            this.readFileContent(file.path),
          );

          // Parse AST once for both chunking and entity extraction
          const parseResult = await this.profiler.trackAsync(
            'TreeSitter.parseFile',
            () => parseFile(file.path, content),
          );

          // Use pre-parsed AST for chunking
          const chunks = await this.profiler.trackAsync(
            'ChunkingService.chunkFile',
            () =>
              this.chunkingService.chunkFile(file.path, content, parseResult),
          );
          batchChunks.push(...chunks);

          // Extract symbols for symbol graph (using same AST)
          await this.profiler.trackAsync(
            'SymbolExtractor.extractAndStore',
            () =>
              this.extractAndStoreSymbols(
                file.path,
                content,
                chunks,
                parseResult,
              ),
          );

          chunkedFiles++;
        } catch (error) {
          console.warn(`Failed to chunk file ${file.path}: ${error}`);
          this.addFailedFile(file.path);
        }
      }

      // Store chunks
      if (batchChunks.length > 0) {
        this.profiler.track('MetadataStore.insertChunks', () => {
          this.metadataStore.insertChunks(batchChunks);
        });
        totalChunks += batchChunks.length;
      }

      // Update progress
      const phaseProgress = Math.round((chunkedFiles / files.length) * 100);
      this.updateProgress({
        chunkedFiles,
        totalChunks,
        phaseProgress,
        overallProgress: 25 + Math.round(phaseProgress * 0.25),
      });

      this.saveCheckpoint();
    }
  }

  /**
   * Phase 3: Generate embeddings.
   * @param resumeFromPath - If provided, skip files up to and including this path
   */
  private async embeddingPhase(resumeFromPath?: string | null): Promise<void> {
    this.updateProgress({ status: 'embedding', phase: 3, phaseProgress: 0 });

    // Use cached file list or fetch from store
    const files = this.cachedFileMeta ?? this.metadataStore.getAllFileMeta();
    let resumeEmbeddedChunks = 0;
    let skipMode = !!resumeFromPath;
    const chunksNeedEmbed: Chunk[] = [];

    for (const file of files) {
      // Skip files until we reach the resume point
      if (skipMode) {
        if (file.path === resumeFromPath) {
          skipMode = false;
        }
        // Count existing embeddings for skipped files
        const existingChunks = this.metadataStore.getChunksByFilePath(
          file.path,
        );
        resumeEmbeddedChunks += existingChunks.length;
        continue;
      }

      await this.waitIfPaused();
      if (this.isCancelled) return;

      const chunks = this.profiler.track(
        'MetadataStore.getChunksByFilePath',
        () => this.metadataStore.getChunksByFilePath(file.path),
      );
      if (chunks.length === 0) continue;

      chunksNeedEmbed.push(...chunks);
    }

    const chunkEmbeddings = await this.profiler.trackAsync(
      'EmbeddingService.embedChunks',
      () =>
        this.embeddingService.embedChunks(chunksNeedEmbed, (finishedChunks) => {
          // Update progress
          const phaseProgress = Math.round(
            ((resumeEmbeddedChunks + finishedChunks) /
              this.progress.totalChunks) *
              100,
          );
          this.updateProgress({
            embeddedChunks: resumeEmbeddedChunks + finishedChunks,
            phaseProgress,
            overallProgress: 50 + Math.round(phaseProgress * 0.25),
          });

          // Save checkpoint with current file path
          this.saveCheckpointWithPath(
            chunksNeedEmbed[finishedChunks - 1].filepath,
          );
        }),
    );

    // Store to vector database
    await this.profiler.trackAsync('VectorStore.insertBatch', () =>
      this.vectorStore.insertBatch(chunkEmbeddings),
    );
  }

  /**
   * Phase 4: Final storage optimization.
   */
  private async storePhase(): Promise<void> {
    this.updateProgress({ status: 'storing', phase: 4, phaseProgress: 0 });

    // Optimize vector store
    this.profiler.track('VectorStore.optimize', () => {
      this.vectorStore.optimize();
    });

    this.updateProgress({
      storedChunks: this.progress.embeddedChunks,
      phaseProgress: 100,
      overallProgress: 100,
    });
  }

  // ===== Helper Methods =====

  /**
   * Resolve cross-file symbol edges by global name matching.
   * Called after all files are processed (full build or incremental update).
   *
   * During per-file extraction, cross-file references are stored with
   * placeholder target IDs like `?#symbolName`. This method triggers
   * SqliteGraphStore.resolveEdgesByName() to batch-resolve them
   * by matching names globally against the symbols table.
   */
  private resolveSymbolEdges(): void {
    if (!this.symbolGraphStore || !this.config.enableGraph) return;

    try {
      const resolved = this.symbolGraphStore.resolveEdgesByName();
      if (resolved > 0) {
        console.log(
          `Resolved ${resolved} cross-file symbol edges by name matching`,
        );
      }
    } catch (error) {
      console.warn(`Cross-file symbol edge resolution failed: ${error}`);
    }
  }

  /**
   * Extract symbols and store them in the symbol graph store.
   * Best-effort: failures are logged but don't block the pipeline.
   *
   * @param filePath - Relative file path.
   * @param content - File content.
   * @param chunks - Chunks produced by the chunking service (for chunk mapping).
   * @param parseResult - Optional pre-parsed AST to avoid re-parsing.
   */
  private async extractAndStoreSymbols(
    filePath: string,
    content: string,
    chunks: Chunk[],
    parseResult?: Awaited<ReturnType<typeof parseFile>> | null,
  ): Promise<void> {
    if (!this.symbolGraphStore || !this.config.enableGraph) return;

    try {
      const symbolResult = await this.symbolExtractor.extract(
        filePath,
        content,
        parseResult,
      );
      if (symbolResult.symbols.length > 0) {
        this.symbolGraphStore.insertSymbols(symbolResult.symbols);
      }
      if (symbolResult.edges.length > 0) {
        this.symbolGraphStore.insertEdges(symbolResult.edges);
      }
      if (symbolResult.imports.length > 0) {
        this.symbolGraphStore.insertImports(symbolResult.imports);
      }
      // Map chunks to symbols by line range
      const chunkMappings = chunks.map((c) => ({
        chunkId: c.id,
        startLine: c.startLine,
        endLine: c.endLine,
      }));
      this.symbolGraphStore.updateChunkMappings(filePath, chunkMappings);
    } catch (error) {
      // Symbol extraction is best-effort; don't fail the file
      console.warn(`Symbol extraction failed for ${filePath}: ${error}`);
    }
  }

  /**
   * Process a set of files through the pipeline.
   * Files exceeding 10 MB are skipped (matches FileScanner threshold).
   */
  private async processFiles(files: FileMetadata[]): Promise<void> {
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    // Filter out oversized files
    const eligible = files.filter((f) => {
      if (f.size > MAX_FILE_SIZE) {
        console.warn(
          `Skipping oversized file (${(f.size / 1024 / 1024).toFixed(1)} MB): ${f.path}`,
        );
        return false;
      }
      return true;
    });

    // Store file metadata
    this.metadataStore.insertFileMeta(eligible);

    for (const file of eligible) {
      try {
        const content = await this.readFileContent(file.path);

        // Parse AST once for chunking, entity extraction, and symbol extraction
        const parseResult = await parseFile(file.path, content);

        // Chunk the file
        const chunks = await this.chunkingService.chunkFile(
          file.path,
          content,
          parseResult,
        );
        this.metadataStore.insertChunks(chunks);

        // Extract symbols for symbol graph
        await this.extractAndStoreSymbols(
          file.path,
          content,
          chunks,
          parseResult,
        );

        // Generate embeddings and store
        const chunkEmbeddings = await this.embeddingService.embedChunks(chunks);
        await this.vectorStore.insertBatch(chunkEmbeddings);
      } catch (error) {
        console.warn(`Failed to process file ${file.path}: ${error}`);
      }
    }
  }

  /**
   * Handle file deletions in batch.
   *
   * SQLite operations (metadataStore, symbolGraphStore) are batched into
   * single calls. VectorStore deletions remain per-file because the
   * underlying zvec API only supports single-file delete.
   */
  private async handleDeletions(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    // Batch delete from metadata store (already supports array)
    this.metadataStore.deleteFileMeta(filePaths);
    this.metadataStore.deleteChunksByFilePath(filePaths);

    // Batch delete from symbol graph store
    if (this.symbolGraphStore) {
      for (const filePath of filePaths) {
        this.symbolGraphStore.deleteByFilePath(filePath);
      }
    }

    // Delete from vector store (per-file, async)
    for (const filePath of filePaths) {
      await this.vectorStore.deleteByFilePath(filePath);
    }
  }

  /**
   * Read file content.
   */
  private async readFileContent(relativePath: string): Promise<string> {
    const absolutePath = path.join(this.projectRoot, relativePath);
    return fs.readFile(absolutePath, 'utf-8');
  }

  /**
   * Wait while paused.
   */
  private async waitIfPaused(): Promise<void> {
    while (this.isPaused && !this.isCancelled) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Update progress and notify callback.
   */
  private updateProgress(update: Partial<IndexingProgress>): void {
    this.progress = { ...this.progress, ...update };
    this.metadataStore.updateIndexStatus(this.progress);

    if (this.progressCallback) {
      this.progressCallback(this.progress);
    }
  }

  /**
   * Add a failed file to the list.
   */
  private addFailedFile(filePath: string): void {
    const failedFiles = this.progress.failedFiles || [];
    failedFiles.push(filePath);
    this.updateProgress({ failedFiles });
  }

  /**
   * Get the status for the current phase.
   */
  private getPhaseStatus(): IndexStatus {
    switch (this.progress.phase) {
      case 1:
        return 'scanning';
      case 2:
        return 'chunking';
      case 3:
        return 'embedding';
      case 4:
        return 'storing';
      default:
        return 'idle';
    }
  }

  /**
   * Save checkpoint for resumable builds.
   */
  private saveCheckpoint(): void {
    const checkpoint: BuildCheckpoint = {
      phase: this.progress.status,
      lastProcessedPath: null,
      pendingChunkIds: [],
      updatedAt: Date.now(),
    };
    this.metadataStore.saveCheckpoint(checkpoint);
  }

  /**
   * Save checkpoint with the last processed file path.
   * Used during embedding phase for granular resumption.
   */
  private saveCheckpointWithPath(filePath: string): void {
    const checkpoint: BuildCheckpoint = {
      phase: this.progress.status,
      lastProcessedPath: filePath,
      pendingChunkIds: [],
      updatedAt: Date.now(),
    };
    this.metadataStore.saveCheckpoint(checkpoint);
  }

  /**
   * Create initial progress state.
   */
  private createInitialProgress(): IndexingProgress {
    return {
      status: 'idle',
      phase: 0,
      phaseProgress: 0,
      overallProgress: 0,
      scannedFiles: 0,
      totalFiles: 0,
      chunkedFiles: 0,
      embeddedChunks: 0,
      totalChunks: 0,
      storedChunks: 0,
      startTime: Date.now(),
    };
  }

  // ===== Performance Profiling Methods =====

  /**
   * Enable or disable performance profiling.
   * When enabled, all key method calls will be timed and statistics collected.
   *
   * @param enabled - Whether to enable profiling
   */
  setProfilingEnabled(enabled: boolean): void {
    this.enableProfiling = enabled;
  }

  /**
   * Check if profiling is enabled.
   */
  isProfilingEnabled(): boolean {
    return this.enableProfiling;
  }

  /**
   * Get the performance profiling summary.
   * Returns null if profiling has not been started.
   *
   * @returns Profiling summary with method statistics
   */
  getProfilingSummary(): ProfilingSummary | null {
    if (
      !this.profiler.isActive() &&
      this.profiler.getTrackedMethods().length === 0
    ) {
      return null;
    }
    return this.profiler.getSummary();
  }

  /**
   * Get formatted performance report as a string.
   * Useful for logging or displaying to users.
   *
   * @param topN - Number of top hotspots to show (default: 10)
   * @returns Formatted report string
   */
  getProfilingReport(topN: number = 10): string {
    return this.profiler.formatReport(topN);
  }

  /**
   * Get profiling data as JSON string.
   * Useful for persisting or transmitting profiling data.
   *
   * @returns JSON string of profiling summary
   */
  getProfilingJSON(): string {
    return this.profiler.toJSON();
  }
}
