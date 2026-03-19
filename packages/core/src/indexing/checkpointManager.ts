/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BuildCheckpoint, IMetadataStore, IndexStatus } from './types.js';

/**
 * Manages build checkpoints for resumable index building.
 * Enables crash recovery by persisting build progress to SQLite.
 */
export class CheckpointManager {
  private metadataStore: IMetadataStore;
  private currentCheckpoint: BuildCheckpoint | null = null;
  private autoSaveInterval: NodeJS.Timeout | null = null;
  private readonly autoSaveIntervalMs: number;

  /**
   * Creates a new CheckpointManager instance.
   * @param metadataStore The metadata store for persisting checkpoints.
   * @param autoSaveIntervalMs Interval for auto-saving checkpoints. Default: 5000ms.
   */
  constructor(
    metadataStore: IMetadataStore,
    autoSaveIntervalMs: number = 5000,
  ) {
    this.metadataStore = metadataStore;
    this.autoSaveIntervalMs = autoSaveIntervalMs;
  }

  /**
   * Starts the checkpoint manager and loads any existing checkpoint.
   * @returns The loaded checkpoint if one exists, null otherwise.
   */
  start(): BuildCheckpoint | null {
    this.currentCheckpoint = this.metadataStore.getCheckpoint();
    this.startAutoSave();
    return this.currentCheckpoint;
  }

  /**
   * Stops the checkpoint manager and saves the final checkpoint.
   */
  stop(): void {
    this.stopAutoSave();
    if (this.currentCheckpoint) {
      this.save();
    }
  }

  /**
   * Updates the current checkpoint.
   * @param update Partial checkpoint update.
   */
  update(update: Partial<BuildCheckpoint>): void {
    if (!this.currentCheckpoint) {
      this.currentCheckpoint = {
        phase: 'idle',
        lastProcessedPath: null,
        pendingChunkIds: [],
        updatedAt: Date.now(),
      };
    }

    this.currentCheckpoint = {
      ...this.currentCheckpoint,
      ...update,
      updatedAt: Date.now(),
    };
  }

  /**
   * Sets the current phase of the build.
   * @param phase The current build phase.
   */
  setPhase(phase: IndexStatus): void {
    this.update({ phase });
  }

  /**
   * Records the last successfully processed file path.
   * @param path File path that was successfully processed.
   */
  setLastProcessedPath(path: string): void {
    this.update({ lastProcessedPath: path });
  }

  /**
   * Sets the pending chunk IDs waiting for embedding.
   * @param chunkIds Array of chunk IDs pending embedding.
   */
  setPendingChunkIds(chunkIds: string[]): void {
    this.update({ pendingChunkIds: chunkIds });
  }

  /**
   * Adds chunk IDs to the pending list.
   * @param chunkIds Chunk IDs to add.
   */
  addPendingChunkIds(chunkIds: string[]): void {
    const current = this.currentCheckpoint?.pendingChunkIds ?? [];
    this.update({ pendingChunkIds: [...current, ...chunkIds] });
  }

  /**
   * Removes chunk IDs from the pending list.
   * @param chunkIds Chunk IDs to remove.
   */
  removePendingChunkIds(chunkIds: string[]): void {
    const current = this.currentCheckpoint?.pendingChunkIds ?? [];
    const chunkIdSet = new Set(chunkIds);
    this.update({
      pendingChunkIds: current.filter((id) => !chunkIdSet.has(id)),
    });
  }

  /**
   * Gets the current checkpoint.
   * @returns Current checkpoint or null.
   */
  get(): BuildCheckpoint | null {
    return this.currentCheckpoint;
  }

  /**
   * Checks if there is a valid checkpoint to resume from.
   * @returns True if a valid checkpoint exists.
   */
  hasValidCheckpoint(): boolean {
    return (
      this.currentCheckpoint !== null &&
      this.currentCheckpoint.phase !== 'idle' &&
      this.currentCheckpoint.phase !== 'done' &&
      this.currentCheckpoint.phase !== 'error'
    );
  }

  /**
   * Gets the phase to resume from.
   * @returns The phase to resume from, or null if no valid checkpoint.
   */
  getResumePhase(): IndexStatus | null {
    if (!this.hasValidCheckpoint()) {
      return null;
    }
    return this.currentCheckpoint!.phase;
  }

  /**
   * Saves the current checkpoint to persistent storage.
   */
  save(): void {
    if (this.currentCheckpoint) {
      this.metadataStore.saveCheckpoint(this.currentCheckpoint);
    }
  }

  /**
   * Clears the checkpoint (called when build completes successfully).
   */
  clear(): void {
    this.currentCheckpoint = null;
    this.metadataStore.clearCheckpoint();
  }

  /**
   * Starts auto-save timer.
   */
  private startAutoSave(): void {
    if (this.autoSaveInterval) {
      return;
    }

    this.autoSaveInterval = setInterval(() => {
      if (this.currentCheckpoint) {
        this.save();
      }
    }, this.autoSaveIntervalMs);
  }

  /**
   * Stops auto-save timer.
   */
  private stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }
}
