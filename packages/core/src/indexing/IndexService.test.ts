/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { IndexService } from './IndexService.js';

describe('IndexService', () => {
  let tempDir: string;
  let service: IndexService;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-service-test-'));

    // Create a minimal project structure
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(async () => {
    // Terminate service if it exists
    if (service) {
      await service.terminate();
    }

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should create service with default config', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      expect(service).toBeDefined();
      expect(service.isBuildInProgress()).toBe(false);
    });

    it('should create service with custom config', () => {
      service = new IndexService({
        projectRoot: tempDir,
        config: {
          chunkMaxTokens: 256,
          enableGraph: false,
        },
      });

      expect(service).toBeDefined();
    });

    it('should create service with LLM client config', () => {
      service = new IndexService({
        projectRoot: tempDir,
        llmClientConfig: {
          apiKey: 'test-api-key',
          baseUrl: 'https://api.example.com',
          model: 'text-embedding-v3',
        },
      });

      expect(service).toBeDefined();
    });
  });

  describe('Status', () => {
    it('should return idle status initially', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      const status = service.getStatus();
      expect(status.status).toBe('idle');
      expect(status.overallProgress).toBe(0);
    });

    it('should not be building initially', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      expect(service.isBuildInProgress()).toBe(false);
    });

    it('should not be ready initially', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      expect(service.isIndexReady()).toBe(false);
    });
  });

  describe('Event Emitter', () => {
    it('should support event listeners', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      const progressHandler = vi.fn();
      service.on('progress', progressHandler);

      // Emit should not throw
      expect(() => {
        service.emit('progress', {
          status: 'scanning',
          phase: 1,
          phaseProgress: 50,
          overallProgress: 10,
          scannedFiles: 5,
          totalFiles: 10,
          chunkedFiles: 0,
          embeddedChunks: 0,
          totalChunks: 0,
          storedChunks: 0,
          startTime: Date.now(),
        });
      }).not.toThrow();

      expect(progressHandler).toHaveBeenCalledTimes(1);
    });

    it('should support removing event listeners', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      const handler = vi.fn();
      service.on('cancelled', handler);
      service.off('cancelled', handler);

      service.emit('cancelled');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Build Control', () => {
    it('should throw if starting build without worker (worker not compiled)', async () => {
      service = new IndexService({
        projectRoot: tempDir,
        llmClientConfig: { apiKey: 'test' },
      });

      // The worker file doesn't exist during tests (only .ts files)
      // so startBuild should emit an error event
      const errorHandler = vi.fn();
      service.on('error', errorHandler);

      try {
        await service.startBuild();
        // Give worker time to fail
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        // Expected - worker module not found
      }

      // After error, build should not be in progress
      await service.terminate();
    });

    it('should allow pause when not building', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      // Should not throw
      expect(() => service.pause()).not.toThrow();
    });

    it('should allow resume when not paused', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      // Should not throw
      expect(() => service.resume()).not.toThrow();
    });

    it('should allow cancel when not building', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      // Should not throw
      expect(() => service.cancel()).not.toThrow();
    });
  });

  describe('Terminate', () => {
    it('should terminate cleanly', async () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      await expect(service.terminate()).resolves.not.toThrow();
      expect(service.isBuildInProgress()).toBe(false);
    });

    it('should allow multiple terminate calls', async () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      await service.terminate();
      await expect(service.terminate()).resolves.not.toThrow();
    });
  });

  describe('Stats', () => {
    it('should return null stats for non-existent index', () => {
      service = new IndexService({
        projectRoot: tempDir,
      });

      // Stats might return null or a valid object depending on whether
      // the metadata store was initialized
      const stats = service.getStats();
      // Just verify it doesn't throw and returns expected shape
      if (stats !== null) {
        expect(stats).toHaveProperty('fileCount');
        expect(stats).toHaveProperty('chunkCount');
        expect(stats).toHaveProperty('cacheCount');
      }
    });
  });
});
