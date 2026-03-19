/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CheckpointManager } from './checkpointManager.js';
import type { BuildCheckpoint, IMetadataStore } from './types.js';

/**
 * Mock MetadataStore for testing.
 */
class MockMetadataStore implements Partial<IMetadataStore> {
  private checkpoint: BuildCheckpoint | null = null;

  getCheckpoint(): BuildCheckpoint | null {
    return this.checkpoint;
  }

  saveCheckpoint(checkpoint: BuildCheckpoint): void {
    this.checkpoint = checkpoint;
  }

  clearCheckpoint(): void {
    this.checkpoint = null;
  }
}

describe('CheckpointManager', () => {
  let mockStore: MockMetadataStore;
  let manager: CheckpointManager;

  beforeEach(() => {
    mockStore = new MockMetadataStore();
    // Use short interval for tests
    manager = new CheckpointManager(
      mockStore as unknown as IMetadataStore,
      100,
    );
  });

  afterEach(() => {
    manager.stop();
  });

  describe('Initialization', () => {
    it('should start with no checkpoint', () => {
      const checkpoint = manager.start();
      expect(checkpoint).toBeNull();
    });

    it('should load existing checkpoint on start', () => {
      const existingCheckpoint: BuildCheckpoint = {
        phase: 'chunking',
        lastProcessedPath: 'src/index.ts',
        pendingChunkIds: ['chunk-1', 'chunk-2'],
        updatedAt: Date.now(),
      };
      mockStore.saveCheckpoint(existingCheckpoint);

      const checkpoint = manager.start();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.phase).toBe('chunking');
      expect(checkpoint?.lastProcessedPath).toBe('src/index.ts');
    });
  });

  describe('Update Operations', () => {
    it('should update phase', () => {
      manager.start();
      manager.setPhase('embedding');

      const checkpoint = manager.get();
      expect(checkpoint?.phase).toBe('embedding');
    });

    it('should update last processed path', () => {
      manager.start();
      manager.setLastProcessedPath('src/utils.ts');

      const checkpoint = manager.get();
      expect(checkpoint?.lastProcessedPath).toBe('src/utils.ts');
    });

    it('should set pending chunk IDs', () => {
      manager.start();
      manager.setPendingChunkIds(['chunk-1', 'chunk-2']);

      const checkpoint = manager.get();
      expect(checkpoint?.pendingChunkIds).toEqual(['chunk-1', 'chunk-2']);
    });

    it('should add pending chunk IDs', () => {
      manager.start();
      manager.setPendingChunkIds(['chunk-1']);
      manager.addPendingChunkIds(['chunk-2', 'chunk-3']);

      const checkpoint = manager.get();
      expect(checkpoint?.pendingChunkIds).toEqual([
        'chunk-1',
        'chunk-2',
        'chunk-3',
      ]);
    });

    it('should remove pending chunk IDs', () => {
      manager.start();
      manager.setPendingChunkIds(['chunk-1', 'chunk-2', 'chunk-3']);
      manager.removePendingChunkIds(['chunk-2']);

      const checkpoint = manager.get();
      expect(checkpoint?.pendingChunkIds).toEqual(['chunk-1', 'chunk-3']);
    });
  });

  describe('Checkpoint Validation', () => {
    it('should not have valid checkpoint initially', () => {
      manager.start();
      expect(manager.hasValidCheckpoint()).toBe(false);
    });

    it('should have valid checkpoint when in progress', () => {
      manager.start();
      manager.setPhase('embedding');

      expect(manager.hasValidCheckpoint()).toBe(true);
    });

    it('should not have valid checkpoint when idle', () => {
      manager.start();
      manager.setPhase('idle');

      expect(manager.hasValidCheckpoint()).toBe(false);
    });

    it('should not have valid checkpoint when done', () => {
      manager.start();
      manager.setPhase('done');

      expect(manager.hasValidCheckpoint()).toBe(false);
    });

    it('should not have valid checkpoint when error', () => {
      manager.start();
      manager.setPhase('error');

      expect(manager.hasValidCheckpoint()).toBe(false);
    });
  });

  describe('Resume Phase', () => {
    it('should return null when no valid checkpoint', () => {
      manager.start();
      expect(manager.getResumePhase()).toBeNull();
    });

    it('should return phase when valid checkpoint exists', () => {
      manager.start();
      manager.setPhase('chunking');

      expect(manager.getResumePhase()).toBe('chunking');
    });
  });

  describe('Persistence', () => {
    it('should save checkpoint to store', () => {
      manager.start();
      manager.setPhase('embedding');
      manager.save();

      const stored = mockStore.getCheckpoint();
      expect(stored?.phase).toBe('embedding');
    });

    it('should clear checkpoint from store', () => {
      manager.start();
      manager.setPhase('embedding');
      manager.save();
      manager.clear();

      expect(mockStore.getCheckpoint()).toBeNull();
      expect(manager.get()).toBeNull();
    });
  });

  describe('Auto-save', () => {
    it('should auto-save periodically', async () => {
      manager.start();
      manager.setPhase('scanning');

      // Wait for auto-save interval
      await new Promise((resolve) => setTimeout(resolve, 150));

      const stored = mockStore.getCheckpoint();
      expect(stored?.phase).toBe('scanning');
    });

    it('should stop auto-save on stop', async () => {
      manager.start();
      manager.setPhase('scanning');
      manager.stop();

      // Clear the stored checkpoint
      mockStore.clearCheckpoint();

      // Update phase after stop
      manager.setPhase('chunking');

      // Wait for would-be auto-save interval
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should not have auto-saved
      expect(mockStore.getCheckpoint()).toBeNull();
    });
  });
});
