/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  IndexConfig,
  IndexingProgress,
  WorkerMessage,
  WorkerResponse,
  ChangeSet,
} from './types.js';
import { hasChanges } from './types.js';
import { MetadataStore, getIndexDir } from './stores/metadataStore.js';
import { VectorStore } from './stores/vectorStore.js';
import { GraphStore } from './stores/graphStore.js';
import { DEFAULT_INDEX_CONFIG } from './defaults.js';
import { ChangeDetector } from './changeDetector.js';
import { BranchHandler } from './branchHandler.js';
import { FileScanner } from './fileScanner.js';
import { RetrievalService } from './retrievalService.js';
import type { IGraphStore } from './types.js';
import { EmbeddingLlmClient } from './embeddingLlmClient.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';

/**
 * Check if running on Windows platform.
 */
const isWindows = os.platform() === 'win32';

/**
 * Events emitted by IndexService.
 */
export interface IndexServiceEvents {
  /** Emitted when build progress updates. */
  progress: (progress: IndexingProgress) => void;
  /** Emitted when build completes successfully. */
  build_complete: () => void;
  /** Emitted when incremental update completes. */
  update_complete: () => void;
  /** Emitted when indexing is paused. */
  paused: () => void;
  /** Emitted when indexing is resumed. */
  resumed: () => void;
  /** Emitted when indexing is cancelled. */
  cancelled: () => void;
  /** Emitted when an error occurs. */
  error: (error: Error) => void;
  /** Emitted when worker crashes and is being recovered. */
  worker_recovering: () => void;
  /** Emitted when worker recovery completes. */
  worker_recovered: () => void;
  /** Emitted when changes are detected during polling. */
  changes_detected: (changes: ChangeSet) => void;
  /** Emitted when branch change is detected. */
  branch_changed: (
    previousBranch: string | null,
    currentBranch: string,
  ) => void;
  /** Emitted when polling cycle starts. */
  poll_started: () => void;
  /** Emitted when polling cycle completes. */
  poll_complete: () => void;
}

/**
 * Configuration for IndexService.
 */
export interface IndexServiceConfig {
  /** Project root directory path. */
  projectRoot: string;
  /** Index configuration overrides. */
  config?: Partial<IndexConfig>;
  /** LLM client configuration for embeddings (used by Worker thread). */
  llmClientConfig?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
  baseLlmClient?: BaseLlmClient;
  /** Maximum worker restart attempts. Default: 3. */
  maxRestartAttempts?: number;
  /** Delay between restart attempts in ms. Default: 1000. */
  restartDelayMs?: number;
}

/**
 * IndexService provides the main thread API for codebase indexing.
 * It manages Worker lifecycle, handles errors, and provides event-based progress updates.
 *
 * Usage:
 * ```typescript
 * const service = new IndexService({
 *   projectRoot: '/path/to/project',
 *   llmClientConfig: { apiKey: 'your-api-key' },
 * });
 *
 * service.on('progress', (p) => console.log(p.status, p.overallProgress));
 * service.on('build_complete', () => console.log('Done!'));
 * service.on('error', (e) => console.error(e));
 *
 * await service.startBuild();
 * ```
 */
export class IndexService extends EventEmitter {
  private worker: Worker | null = null;
  private projectRoot: string;
  private projectHash: string;
  private config: IndexConfig;
  private llmClientConfig?: IndexServiceConfig['llmClientConfig'];
  private baseLlmClient?: BaseLlmClient;
  private maxRestartAttempts: number;
  private restartDelayMs: number;
  private restartAttempts = 0;
  private currentProgress: IndexingProgress;
  private isBuilding = false;
  private enabled = true;
  private retrievalService: RetrievalService | null = null;

  // Polling and change detection
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private changeDetector: ChangeDetector | null = null;
  private branchHandler: BranchHandler | null = null;
  private isPolling = false;

  /**
   * Creates a new IndexService instance.
   * @param serviceConfig Service configuration.
   */
  constructor(serviceConfig: IndexServiceConfig) {
    super();

    this.projectRoot = path.resolve(serviceConfig.projectRoot);
    this.projectHash = this.computeProjectHash(this.projectRoot);
    this.config = { ...DEFAULT_INDEX_CONFIG, ...serviceConfig.config };
    this.llmClientConfig = serviceConfig.llmClientConfig;
    this.baseLlmClient = serviceConfig.baseLlmClient;
    this.maxRestartAttempts = serviceConfig.maxRestartAttempts ?? 3;
    this.restartDelayMs = serviceConfig.restartDelayMs ?? 1000;

    // Initialize default progress state
    this.currentProgress = this.createInitialProgress();
  }

  /**
   * Computes a hash for the project root path.
   */
  private computeProjectHash(projectRoot: string): string {
    return crypto
      .createHash('sha256')
      .update(projectRoot)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Creates initial progress state.
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
      startTime: 0,
    };
  }

  /**
   * Gets the path to the worker script.
   * Handles both development (TypeScript) and production (JavaScript) scenarios.
   */
  private getWorkerPath(): string {
    // Get the directory of this file
    const currentDir = path.dirname(fileURLToPath(import.meta.url));

    // Try compiled JS first, then fall back to TS
    const jsPath = path.join(currentDir, 'worker', 'indexWorker.js');
    return jsPath;
  }

  /**
   * Creates and starts the worker thread.
   */
  private createWorker(): Worker {
    const workerPath = this.getWorkerPath();

    const worker = new Worker(workerPath, {
      workerData: {
        projectRoot: this.projectRoot,
        config: this.config,
        llmClientConfig: this.llmClientConfig,
      },
    });

    // Handle messages from worker
    worker.on('message', (response: WorkerResponse) => {
      this.handleWorkerResponse(response);
    });

    // Handle worker errors
    worker.on('error', (error: Error) => {
      this.handleWorkerError(error);
    });

    // Handle worker exit
    worker.on('exit', (code: number) => {
      this.handleWorkerExit(code);
    });

    return worker;
  }

  /**
   * Handles responses from the worker.
   */
  private handleWorkerResponse(response: WorkerResponse): void {
    switch (response.type) {
      case 'progress':
        this.currentProgress = response.payload;
        this.emit('progress', response.payload);
        break;

      case 'build_complete':
        this.isBuilding = false;
        this.restartAttempts = 0;
        this.emit('build_complete');
        break;

      case 'update_complete':
        this.isBuilding = false;
        this.restartAttempts = 0;
        this.emit('update_complete');
        break;

      case 'paused':
        this.currentProgress = { ...this.currentProgress, status: 'paused' };
        this.emit('paused');
        break;

      case 'resumed':
        this.emit('resumed');
        break;

      case 'cancelled':
        this.isBuilding = false;
        this.currentProgress = { ...this.currentProgress, status: 'idle' };
        this.emit('cancelled');
        break;

      case 'status':
        this.currentProgress = response.payload;
        break;

      case 'error':
      default:
        this.emit('error', new Error(response.payload.message));
        break;
    }
  }

  /**
   * Handles worker errors.
   */
  private handleWorkerError(error: Error): void {
    this.emit('error', error);

    // Attempt recovery if building
    if (this.isBuilding) {
      this.attemptRecovery();
    }
  }

  /**
   * Handles worker exit.
   */
  private handleWorkerExit(code: number): void {
    this.worker = null;

    // If exit code is non-zero and we were building, attempt recovery
    if (code !== 0 && this.isBuilding) {
      this.attemptRecovery();
    }
  }

  /**
   * Attempts to recover from worker crash.
   */
  private async attemptRecovery(): Promise<void> {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.isBuilding = false;
      this.emit(
        'error',
        new Error(`Worker crashed ${this.maxRestartAttempts} times, giving up`),
      );
      return;
    }

    this.restartAttempts++;
    this.emit('worker_recovering');

    // Wait before restarting
    await new Promise((resolve) => setTimeout(resolve, this.restartDelayMs));

    try {
      // Create new worker
      this.worker = this.createWorker();

      // Resume build from checkpoint
      this.sendMessage({
        type: 'build',
        payload: { resumeFromCheckpoint: true },
      });

      this.emit('worker_recovered');
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
      this.attemptRecovery();
    }
  }

  /**
   * Sends a message to the worker.
   */
  private sendMessage(message: WorkerMessage): void {
    if (!this.worker) {
      throw new Error('Worker not started');
    }
    this.worker.postMessage(message);
  }

  /**
   * Ensures the worker is running.
   */
  private ensureWorker(): void {
    if (!this.worker) {
      this.worker = this.createWorker();
    }
  }

  // ===== Public API =====

  /**
   * Starts a full index build.
   * If index is already complete and no changes detected, skips the build.
   * If a checkpoint exists, resumes from where it left off.
   * @param resumeFromCheckpoint Whether to resume from checkpoint. Default: true.
   * @throws Error if platform is not supported or build already in progress.
   */
  async startBuild(resumeFromCheckpoint: boolean = true): Promise<void> {
    // Platform check - Windows is not supported
    if (isWindows) {
      throw new Error('Codebase Index is not supported on Windows platform');
    }

    if (!this.enabled) {
      throw new Error('IndexService is disabled');
    }

    if (this.isBuilding) {
      throw new Error('Build already in progress');
    }

    // Check if index is already complete
    const existingStatus = await this.getIndexStatus();
    if (existingStatus && existingStatus.status === 'done') {
      // Index already complete - skip build, just emit complete event
      this.currentProgress = existingStatus;
      this.emit('progress', existingStatus);
      this.emit('build_complete');
      return;
    }

    this.isBuilding = true;
    this.restartAttempts = 0;
    this.currentProgress = {
      ...this.createInitialProgress(),
      startTime: Date.now(),
    };

    this.ensureWorker();
    this.sendMessage({
      type: 'build',
      payload: { resumeFromCheckpoint },
    });
  }

  /**
   * Gets the current index status from the metadata store.
   * @returns IndexingProgress or null if not available.
   */
  private async getIndexStatus(): Promise<IndexingProgress | null> {
    try {
      const indexDir = getIndexDir(this.projectHash);
      const dbPath = path.join(indexDir, 'metadata.db');

      // Check if database exists
      if (!fs.existsSync(dbPath)) {
        return null;
      }

      // Create a temporary MetadataStore to read status
      const store = new MetadataStore(this.projectHash);
      const status = store.getIndexStatus();
      store.close();

      return status;
    } catch {
      return null;
    }
  }

  /**
   * Starts an incremental update with the given changes.
   * @param changes The change set to process.
   */
  async startIncrementalUpdate(changes: ChangeSet): Promise<void> {
    if (this.isBuilding) {
      throw new Error('Build already in progress');
    }

    this.isBuilding = true;
    this.restartAttempts = 0;

    this.ensureWorker();
    this.sendMessage({
      type: 'incremental_update',
      payload: { changes },
    });
  }

  /**
   * Pauses the current build.
   */
  pause(): void {
    if (!this.isBuilding) {
      return;
    }

    this.ensureWorker();
    this.sendMessage({ type: 'pause' });
  }

  /**
   * Resumes a paused build.
   */
  resume(): void {
    if (this.currentProgress.status !== 'paused') {
      return;
    }

    this.ensureWorker();
    this.sendMessage({ type: 'resume' });
  }

  /**
   * Cancels the current build.
   */
  cancel(): void {
    if (!this.isBuilding) {
      return;
    }

    this.ensureWorker();
    this.sendMessage({ type: 'cancel' });
  }

  /**
   * Enables the index service.
   * Allows builds to be started.
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disables the index service.
   * Cancels any ongoing build, stops polling, and prevents new builds.
   */
  disable(): void {
    this.enabled = false;
    this.stopPolling();
    if (this.isBuilding) {
      this.cancel();
    }
  }

  /**
   * Checks if indexing is enabled.
   * @returns True if enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Checks if an index exists for the current project.
   * @returns True if index database exists.
   */
  checkIndexExists(): boolean {
    try {
      const indexPath = path.join(getIndexDir(this.projectHash), 'metadata.db');
      return fs.existsSync(indexPath);
    } catch {
      return false;
    }
  }

  // ===== Polling and Change Detection =====

  /**
   * Starts periodic polling for file changes.
   * Also initializes branch change detection.
   *
   * Polling detects file changes and triggers incremental updates automatically.
   * The interval is configured via `config.pollIntervalMs` (default: 10 minutes).
   */
  startPolling(): void {
    if (!this.enabled) {
      return;
    }

    // Stop existing polling if any
    this.stopPolling();

    // Initialize change detector if needed
    if (!this.changeDetector) {
      const metadataStore = new MetadataStore(this.projectHash);
      const fileScanner = new FileScanner(this.projectRoot);
      this.changeDetector = new ChangeDetector(fileScanner, metadataStore);
    }

    // Initialize branch handler if needed
    if (!this.branchHandler) {
      this.branchHandler = new BranchHandler(this.projectRoot);

      // Register branch change callback
      this.branchHandler.onBranchChange(
        async (previousBranch: string | null, currentBranch: string) => {
          this.emit('branch_changed', previousBranch, currentBranch);

          // Trigger change detection on branch switch
          if (this.enabled && !this.isBuilding) {
            await this.pollForChanges();
          }
        },
      );
    }

    // Start polling timer
    this.pollTimer = setInterval(() => {
      void this.pollCycle();
    }, this.config.pollIntervalMs);

    this.isPolling = true;
  }

  /**
   * Stops periodic polling.
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  /**
   * Checks if polling is currently active.
   * @returns True if polling is active.
   */
  isPollingActive(): boolean {
    return this.isPolling;
  }

  /**
   * Manually triggers a poll cycle.
   * Detects changes and starts incremental update if needed.
   *
   * @returns True if changes were detected and update started.
   */
  async pollForChanges(): Promise<boolean> {
    if (!this.enabled || this.isBuilding || !this.changeDetector) {
      return false;
    }

    try {
      this.emit('poll_started');

      const changes = await this.changeDetector.detectChanges();

      if (hasChanges(changes)) {
        this.emit('changes_detected', changes);
        await this.startIncrementalUpdate(changes);
        return true;
      }

      this.emit('poll_complete');
      return false;
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
  }

  /**
   * Executes a single poll cycle: branch check + change detection.
   */
  private async pollCycle(): Promise<void> {
    if (!this.enabled || this.isBuilding) {
      return;
    }

    try {
      // First check for branch changes
      if (this.branchHandler) {
        await this.branchHandler.checkBranchChange();
        // If branch changed, callback will trigger change detection
      }

      // Then poll for file changes
      await this.pollForChanges();
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Gets the current status.
   * @returns Current indexing progress.
   */
  getStatus(): IndexingProgress {
    return { ...this.currentProgress };
  }

  /**
   * Gets the current status asynchronously from the worker.
   * @returns Promise resolving to current indexing progress.
   */
  async getStatusAsync(): Promise<IndexingProgress> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve(this.currentProgress);
        return;
      }

      const handler = (response: WorkerResponse) => {
        if (response.type === 'status') {
          this.worker?.off('message', handler);
          resolve(response.payload);
        }
      };

      this.worker.on('message', handler);
      this.sendMessage({ type: 'get_status' });

      // Timeout after 5 seconds
      setTimeout(() => {
        this.worker?.off('message', handler);
        resolve(this.currentProgress);
      }, 5000);
    });
  }

  /**
   * Checks if a build is currently in progress.
   * @returns True if building.
   */
  isBuildInProgress(): boolean {
    return this.isBuilding;
  }

  /**
   * Checks if the index is ready for queries.
   * @returns True if index exists and build is not in progress.
   */
  isIndexReady(): boolean {
    return !this.isBuilding && this.currentProgress.status === 'done';
  }

  /**
   * Terminates the worker and cleans up resources.
   */
  async terminate(): Promise<void> {
    // Stop polling
    this.stopPolling();

    // Clean up change detector
    if (this.changeDetector) {
      this.changeDetector = null;
    }

    // Clean up branch handler
    if (this.branchHandler) {
      this.branchHandler = null;
    }

    // Terminate worker
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.isBuilding = false;
  }

  /**
   * Gets statistics about the current index.
   * @returns Object with file and chunk counts.
   */
  getStats(): {
    fileCount: number;
    chunkCount: number;
    cacheCount: number;
  } | null {
    try {
      const store = new MetadataStore(this.projectHash);
      const stats = store.getStats();
      store.close();
      return stats;
    } catch {
      return null;
    }
  }

  /**
   * Creates an async version of RetrievalService with properly initialized stores.
   * Use this when you need guaranteed store initialization.
   *
   * @returns Promise resolving to RetrievalService or null if not available.
   */
  async getRetrievalServiceAsync(): Promise<RetrievalService | null> {
    if (this.retrievalService) {
      return this.retrievalService;
    }
    // Check if index is ready
    if (!this.isIndexReady()) {
      return null;
    }
    // Check if baseLlmClient is available
    if (!this.baseLlmClient) {
      return null;
    }
    try {
      // Create stores for retrieval
      const metadataStore = new MetadataStore(this.projectHash);
      const vectorStore = new VectorStore(this.projectHash);

      // Initialize vector store
      await vectorStore.initialize();

      let graphStore: GraphStore | undefined;
      if (this.config.enableGraph) {
        graphStore = new GraphStore(this.projectHash);
        await graphStore.initialize();
      }

      // Create dummy graph store if not enabled
      const effectiveGraphStore = graphStore ?? this.createDummyGraphStore();

      const embeddingLlmClient = new EmbeddingLlmClient(this.llmClientConfig!);

      this.retrievalService = new RetrievalService(
        metadataStore,
        vectorStore,
        effectiveGraphStore,
        this.baseLlmClient,
        embeddingLlmClient,
        {
          topK: 20,
          bm25TopK: 50,
          vectorTopK: 50,
          recentTopK: 20,
          rrfK: 60,
          maxTokens: 8000,
          enableGraph: this.config.enableGraph,
          graphDepth: 2,
          maxGraphNodes: 50,
          weights: {
            bm25: 1.0,
            vector: 1.0,
            recent: 0.5,
          },
        },
      );

      return this.retrievalService;
    } catch (error) {
      console.error('Error initializing RetrievalService:', error);
      return null;
    }
  }

  /**
   * Sets the base LLM client for retrieval operations.
   * This allows updating the client after initialization.
   *
   * @param client The LLM client implementing IRetrievalLlmClient interface.
   */
  setBaseLlmClient(client: BaseLlmClient): void {
    this.baseLlmClient = client;
  }

  /**
   * Creates a dummy graph store for when graph is disabled.
   */
  private createDummyGraphStore(): IGraphStore {
    return {
      initialize: async () => {},
      close: async () => {},
      insertEntities: async () => {},
      insertRelations: async () => {},
      getEntitiesByChunkIds: async () => [],
      query: async () => [],
      deleteByFilePath: async () => {},
      getStats: async () => ({ nodeCount: 0, edgeCount: 0 }),
    };
  }

  // ===== Event Emitter Type Safety =====

  override on<K extends keyof IndexServiceEvents>(
    event: K,
    listener: IndexServiceEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override off<K extends keyof IndexServiceEvents>(
    event: K,
    listener: IndexServiceEvents[K],
  ): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof IndexServiceEvents>(
    event: K,
    ...args: Parameters<IndexServiceEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
