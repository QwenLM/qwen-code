/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as crypto from 'node:crypto';

import type {
  WorkerMessage,
  WorkerResponse,
  IndexingProgress,
  IndexConfig,
  ChangeSet,
} from '../types.js';
import { MetadataStore } from '../stores/metadataStore.js';
import { VectorStore } from '../stores/vectorStore.js';
import { GraphStore } from '../stores/graphStore.js';
import { IndexManager } from '../indexManager.js';
import { CheckpointManager } from '../checkpointManager.js';
import { DEFAULT_INDEX_CONFIG } from '../defaults.js';
import { EmbeddingLlmClient } from '../embeddingLlmClient.js';

/**
 * Worker initialization data passed from the main thread.
 */
interface WorkerInitData {
  projectRoot: string;
  config?: Partial<IndexConfig>;
  llmClientConfig?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
}

/**
 * Index Worker entry point.
 * Handles messages from the main thread and executes indexing operations.
 */
class IndexWorker {
  private indexManager: IndexManager | null = null;
  private checkpointManager: CheckpointManager | null = null;
  private metadataStore: MetadataStore | null = null;
  private vectorStore: VectorStore | null = null;
  private graphStore: GraphStore | null = null;
  private projectRoot: string;
  private projectHash: string;
  private config: IndexConfig;
  private llmClient: EmbeddingLlmClient | null = null;
  private isInitialized = false;

  constructor(initData: WorkerInitData) {
    this.projectRoot = initData.projectRoot;
    this.projectHash = this.computeProjectHash(initData.projectRoot);
    this.config = { ...DEFAULT_INDEX_CONFIG, ...initData.config };

    if (initData.llmClientConfig) {
      this.llmClient = new EmbeddingLlmClient(initData.llmClientConfig);
    }
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
   * Initializes all stores and the index manager.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize stores
      this.metadataStore = new MetadataStore(this.projectHash);
      this.vectorStore = new VectorStore(this.projectHash);
      await this.vectorStore.initialize();

      if (this.config.enableGraph) {
        this.graphStore = new GraphStore(this.projectHash);
        await this.graphStore.initialize();
      }

      // Initialize checkpoint manager
      this.checkpointManager = new CheckpointManager(this.metadataStore);

      // Create a mock LLM client if none provided
      if (!this.llmClient) {
        // Use a mock that throws an error - real API key should be provided
        this.llmClient = {
          generateEmbedding: async (): Promise<number[][]> => {
            throw new Error('No LLM client configured for embeddings');
          },
        } as unknown as EmbeddingLlmClient;
      }

      // Initialize index manager
      this.indexManager = new IndexManager(
        this.projectRoot,
        this.metadataStore,
        this.vectorStore,
        this.llmClient,
        this.graphStore,
        this.config,
      );

      this.isInitialized = true;
    } catch (error) {
      this.sendError(`Failed to initialize worker: ${error}`);
      throw error;
    }
  }

  /**
   * Handles incoming messages from the main thread.
   */
  async handleMessage(message: WorkerMessage): Promise<void> {
    try {
      await this.initialize();

      switch (message.type) {
        case 'build':
          await this.handleBuild(
            message.payload?.resumeFromCheckpoint ?? false,
          );
          break;

        case 'incremental_update':
          await this.handleIncrementalUpdate(message.payload?.changes);
          break;

        case 'pause':
          this.handlePause();
          break;

        case 'resume':
          this.handleResume();
          break;

        case 'cancel':
          this.handleCancel();
          break;

        case 'get_status':
          this.handleGetStatus();
          break;

        default:
          this.sendError(
            `Unknown message type: ${(message as WorkerMessage).type}`,
          );
      }
    } catch (error) {
      this.sendError(`Error handling message: ${error}`);
    }
  }

  /**
   * Handles full build request.
   */
  private async handleBuild(resumeFromCheckpoint: boolean): Promise<void> {
    if (!this.indexManager || !this.checkpointManager) {
      this.sendError('Index manager not initialized');
      return;
    }

    try {
      // Start checkpoint manager (returns existing checkpoint if any)
      this.checkpointManager.start();

      // Check if we should resume from checkpoint
      if (resumeFromCheckpoint && this.checkpointManager.hasValidCheckpoint()) {
        this.sendProgress({
          status: 'scanning',
          phase: 1,
          phaseProgress: 0,
          overallProgress: 0,
          scannedFiles: 0,
          totalFiles: 0,
          chunkedFiles: 0,
          embeddedChunks: 0,
          totalChunks: 0,
          storedChunks: 0,
          startTime: Date.now(),
        });
        // Resume from checkpoint - the IndexManager will handle this internally
      }

      // Count files once to determine mode and pass to IndexManager
      const fileCount = await this.indexManager['fileScanner'].countFiles(
        this.projectRoot,
      );
      const useStreaming = fileCount > this.config.streamThreshold;

      const progressCallback = (progress: IndexingProgress) => {
        this.sendProgress(progress);
        this.checkpointManager?.update({
          phase: progress.status,
          lastProcessedPath: null,
        });
      };

      if (useStreaming) {
        await this.indexManager.buildStreaming(progressCallback, {
          preComputedFileCount: fileCount,
        });
      } else {
        await this.indexManager.build(progressCallback, {
          preComputedFileCount: fileCount,
        });
      }

      // Build completed successfully
      this.checkpointManager.clear();
      this.checkpointManager.stop();
      this.sendResponse({ type: 'build_complete' });
    } catch (error) {
      this.checkpointManager?.stop();
      this.sendError(`Build failed: ${error}`);
    }
  }

  /**
   * Handles incremental update request.
   */
  private async handleIncrementalUpdate(changes?: ChangeSet): Promise<void> {
    if (!this.indexManager) {
      this.sendError('Index manager not initialized');
      return;
    }

    try {
      if (!changes) {
        // If no changes provided, we need to detect them
        // This would require a ChangeDetector implementation (Step 7.4)
        this.sendError('No changes provided for incremental update');
        return;
      }

      await this.indexManager.incrementalUpdate(changes, (progress) => {
        this.sendProgress(progress);
      });

      this.sendResponse({ type: 'update_complete' });
    } catch (error) {
      this.sendError(`Incremental update failed: ${error}`);
    }
  }

  /**
   * Handles pause request.
   */
  private handlePause(): void {
    if (!this.indexManager) {
      this.sendError('Index manager not initialized');
      return;
    }

    this.indexManager.pause();
    this.checkpointManager?.save();
    this.sendResponse({ type: 'paused' });
  }

  /**
   * Handles resume request.
   */
  private handleResume(): void {
    if (!this.indexManager) {
      this.sendError('Index manager not initialized');
      return;
    }

    this.indexManager.resume();
    this.sendResponse({ type: 'resumed' });
  }

  /**
   * Handles cancel request.
   */
  private handleCancel(): void {
    if (!this.indexManager) {
      this.sendError('Index manager not initialized');
      return;
    }

    this.indexManager.cancel();
    this.checkpointManager?.save();
    this.sendResponse({ type: 'cancelled' });
  }

  /**
   * Handles status query.
   */
  private handleGetStatus(): void {
    if (!this.indexManager) {
      this.sendResponse({
        type: 'status',
        payload: {
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
        },
      });
      return;
    }

    this.sendResponse({
      type: 'status',
      payload: this.indexManager.getProgress(),
    });
  }

  /**
   * Sends a progress update to the main thread.
   */
  private sendProgress(progress: IndexingProgress): void {
    this.sendResponse({ type: 'progress', payload: progress });
  }

  /**
   * Sends an error to the main thread.
   */
  private sendError(message: string): void {
    this.sendResponse({ type: 'error', payload: { message } });
  }

  /**
   * Sends a response to the main thread.
   */
  private sendResponse(response: WorkerResponse): void {
    if (parentPort) {
      parentPort.postMessage(response);
    }
  }

  /**
   * Cleans up resources.
   */
  cleanup(): void {
    this.checkpointManager?.stop();
    this.metadataStore?.close();
    this.vectorStore?.destroy();
    if (this.graphStore) {
      this.graphStore.close();
    }
  }
}

// Worker entry point
if (parentPort) {
  const initData = workerData as WorkerInitData;
  const worker = new IndexWorker(initData);

  // Handle messages from main thread
  parentPort.on('message', async (message: WorkerMessage) => {
    await worker.handleMessage(message);
  });

  // Handle worker cleanup
  parentPort.on('close', () => {
    worker.cleanup();
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    parentPort?.postMessage({
      type: 'error',
      payload: { message: `Uncaught exception: ${error.message}` },
    } as WorkerResponse);
  });

  process.on('unhandledRejection', (reason) => {
    parentPort?.postMessage({
      type: 'error',
      payload: { message: `Unhandled rejection: ${reason}` },
    } as WorkerResponse);
  });
}

export { IndexWorker };
export type { WorkerInitData };
