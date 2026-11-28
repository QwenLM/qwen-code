/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeFilenamePart } from '../utils/fileUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { getTranscriptProjectDir } from '../services/transcript-paths.js';
import type { CompressionPipelinePersistedState } from './types.js';

const COMPRESSION_V2_STATE_VERSION = 2;
const COMPRESSION_V2_STATE_FILENAME = 'state.json';
const COMPRESSION_V2_STATE_DIRNAME = 'compression-v2';

interface CompressionStateStoreProvider {
  storage: {
    getProjectRoot(): string;
  };
  getSessionPersistence(): boolean;
}

interface CompressionPipelinePersistedStateEnvelope {
  version: number;
  state: CompressionPipelinePersistedState;
}

function isStateEnvelope(
  value: unknown,
): value is Partial<CompressionPipelinePersistedStateEnvelope> {
  return typeof value === 'object' && value !== null;
}

export function createEmptyCompressionPipelineState(): CompressionPipelinePersistedState {
  return {
    replacementDecisions: {},
    seenFunctionResponseIds: [],
  };
}

function normalizeState(
  rawState: Partial<CompressionPipelinePersistedState> | undefined,
): CompressionPipelinePersistedState {
  return {
    replacementDecisions: rawState?.replacementDecisions ?? {},
    seenFunctionResponseIds: rawState?.seenFunctionResponseIds ?? [],
  };
}

export class CompressionStateStore {
  private readonly stateByKey = new Map<
    string,
    CompressionPipelinePersistedState
  >();

  getState(
    config: CompressionStateStoreProvider,
    sessionScopeId: string,
  ): CompressionPipelinePersistedState {
    const cacheKey = this.getCacheKey(config, sessionScopeId);
    const existingState = this.stateByKey.get(cacheKey);
    if (existingState) {
      return existingState;
    }

    const loadedState = this.loadStateFromDisk(config, sessionScopeId);
    this.stateByKey.set(cacheKey, loadedState);
    return loadedState;
  }

  saveState(
    config: CompressionStateStoreProvider,
    sessionScopeId: string,
  ): void {
    const state = this.getState(config, sessionScopeId);
    if (!config.getSessionPersistence()) {
      return;
    }
    const stateFilePath = this.getStateFilePath(config, sessionScopeId);

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify(
        {
          version: COMPRESSION_V2_STATE_VERSION,
          state,
        } satisfies CompressionPipelinePersistedStateEnvelope,
        null,
        2,
      ),
      'utf8',
    );
  }

  reset(config: CompressionStateStoreProvider, sessionScopeId: string): void {
    const cacheKey = this.getCacheKey(config, sessionScopeId);
    if (!config.getSessionPersistence()) {
      this.stateByKey.set(cacheKey, createEmptyCompressionPipelineState());
      return;
    }

    this.stateByKey.delete(cacheKey);
    const stateFilePath = this.getStateFilePath(config, sessionScopeId);
    fs.rmSync(stateFilePath, { force: true });
  }

  getStateFilePath(
    config: CompressionStateStoreProvider,
    sessionScopeId: string,
  ): string {
    const safeSessionScopeId =
      sanitizeFilenamePart(sessionScopeId) || 'default';
    return path.join(
      getTranscriptProjectDir(config.storage.getProjectRoot()),
      safeSessionScopeId,
      COMPRESSION_V2_STATE_DIRNAME,
      COMPRESSION_V2_STATE_FILENAME,
    );
  }

  private getCacheKey(
    config: CompressionStateStoreProvider,
    sessionScopeId: string,
  ): string {
    const persistenceScope = config.getSessionPersistence()
      ? 'persistent'
      : 'ephemeral';
    return `${config.storage.getProjectRoot()}::${sessionScopeId}::${persistenceScope}`;
  }

  private loadStateFromDisk(
    config: CompressionStateStoreProvider,
    sessionScopeId: string,
  ): CompressionPipelinePersistedState {
    const stateFilePath = this.getStateFilePath(config, sessionScopeId);
    if (!fs.existsSync(stateFilePath)) {
      return createEmptyCompressionPipelineState();
    }

    try {
      const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as unknown;
      if (!isStateEnvelope(raw)) {
        return createEmptyCompressionPipelineState();
      }
      return normalizeState(raw.state);
    } catch (error) {
      runLogger.warn(
        `Failed to load compression-v2 state from ${stateFilePath}: ${String(error)}`,
      );
      return createEmptyCompressionPipelineState();
    }
  }
}

export const compressionV2StateStore = new CompressionStateStore();
