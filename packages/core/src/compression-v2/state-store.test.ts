/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../config/brand.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompressionStateStore,
  createEmptyCompressionPipelineState,
} from './state-store.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';

function createProvider(projectRoot: string, persist = true) {
  return {
    storage: {
      getProjectRoot: () => projectRoot,
    },
    getSessionPersistence: () => persist,
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-v2-'));
  tempDirs.push(tempDir);
  return tempDir;
}

beforeEach(() => {
  const configHome = makeTempDir();
  vi.stubEnv(ENV_CONFIG_DIR, configHome);
  _resetConfigHomeDirCache();
});

afterEach(() => {
  _resetConfigHomeDirCache();
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('CompressionStateStore', () => {
  it('persists session-scoped state to disk and reloads it', () => {
    const tempDir = makeTempDir();
    const provider = createProvider(tempDir);
    const store = new CompressionStateStore();

    const state = store.getState(provider, 'session/main');
    state.replacementDecisions['tool-call-1'] = 'placeholder';
    state.seenFunctionResponseIds.push('resp-1');
    store.saveState(provider, 'session/main');

    const reloadedStore = new CompressionStateStore();
    const reloadedState = reloadedStore.getState(provider, 'session/main');

    expect(reloadedState).toEqual(state);
    expect(
      fs.existsSync(reloadedStore.getStateFilePath(provider, 'session/main')),
    ).toBe(true);
  });

  it.each([1, 2])(
    'loads v%i retired strategy state while retaining tool replacement decisions',
    (version) => {
      const tempDir = makeTempDir();
      const provider = createProvider(tempDir);
      const store = new CompressionStateStore();
      const stateFilePath = store.getStateFilePath(provider, 'session-legacy');

      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify({
          version,
          state: {
            ...createEmptyCompressionPipelineState(),
            replacementDecisions: { 'tool-1': 'saved preview' },
            seenFunctionResponseIds: ['tool-1'],
            snippedMessageIds: ['old-id'],
            sessionMemoryState: { initialized: true, lastHistoryLength: 50 },
            autoCompactTracking: {
              consecutiveFailures: 3,
              lastCompressionStatus: 8,
            },
          },
        }),
        'utf8',
      );

      const loaded = store.getState(provider, 'session-legacy');

      expect(loaded).toEqual({
        replacementDecisions: { 'tool-1': 'saved preview' },
        seenFunctionResponseIds: ['tool-1'],
      });
      store.saveState(provider, 'session-legacy');
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).state).toEqual(
        loaded,
      );
      expect(
        new CompressionStateStore().getState(provider, 'session-legacy'),
      ).toEqual(loaded);
    },
  );

  it('isolates state across different session scopes', () => {
    const tempDir = makeTempDir();
    const provider = createProvider(tempDir);
    const store = new CompressionStateStore();

    store.getState(provider, 'session-a').replacementDecisions['a'] = '1';
    store.getState(provider, 'session-b').replacementDecisions['b'] = '2';
    store.saveState(provider, 'session-a');
    store.saveState(provider, 'session-b');

    const reloadedStore = new CompressionStateStore();
    expect(
      reloadedStore.getState(provider, 'session-a').replacementDecisions,
    ).toEqual({
      a: '1',
    });
    expect(
      reloadedStore.getState(provider, 'session-b').replacementDecisions,
    ).toEqual({
      b: '2',
    });
  });

  it('reset removes both cached and persisted session state', () => {
    const tempDir = makeTempDir();
    const provider = createProvider(tempDir);
    const store = new CompressionStateStore();

    store
      .getState(provider, 'session-reset')
      .seenFunctionResponseIds.push('resp');
    store.saveState(provider, 'session-reset');
    const stateFilePath = store.getStateFilePath(provider, 'session-reset');

    store.reset(provider, 'session-reset');

    expect(fs.existsSync(stateFilePath)).toBe(false);
    expect(store.getState(provider, 'session-reset')).toEqual(
      createEmptyCompressionPipelineState(),
    );
  });

  it('falls back to an empty state when the persisted file is malformed', () => {
    const tempDir = makeTempDir();
    const provider = createProvider(tempDir);
    const store = new CompressionStateStore();
    const stateFilePath = store.getStateFilePath(provider, 'session-bad');

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, '{not valid json', 'utf8');

    expect(store.getState(provider, 'session-bad')).toEqual(
      createEmptyCompressionPipelineState(),
    );
  });

  it('keeps new session state in memory when persistence is disabled', () => {
    const tempDir = makeTempDir();
    const provider = createProvider(tempDir, false);
    const store = new CompressionStateStore();

    const state = store.getState(provider, 'session-ephemeral');
    state.replacementDecisions['tool-call-1'] = 'placeholder';
    store.saveState(provider, 'session-ephemeral');

    expect(store.getState(provider, 'session-ephemeral')).toEqual(state);
    expect(
      fs.existsSync(store.getStateFilePath(provider, 'session-ephemeral')),
    ).toBe(false);
  });

  it('loads persisted state for an ephemeral resume without writing changes back', () => {
    const tempDir = makeTempDir();
    const persistentProvider = createProvider(tempDir);
    const store = new CompressionStateStore();
    store
      .getState(persistentProvider, 'session-resume')
      .seenFunctionResponseIds.push('persisted-response');
    store.saveState(persistentProvider, 'session-resume');

    const ephemeralProvider = createProvider(tempDir, false);
    const ephemeralState = store.getState(ephemeralProvider, 'session-resume');
    expect(ephemeralState.seenFunctionResponseIds).toEqual([
      'persisted-response',
    ]);

    ephemeralState.seenFunctionResponseIds.push('ephemeral-response');
    store.saveState(ephemeralProvider, 'session-resume');

    expect(
      store.getState(persistentProvider, 'session-resume')
        .seenFunctionResponseIds,
    ).toEqual(['persisted-response']);
    expect(
      new CompressionStateStore().getState(persistentProvider, 'session-resume')
        .seenFunctionResponseIds,
    ).toEqual(['persisted-response']);
  });

  it('resets only in-memory state when persistence is disabled', () => {
    const tempDir = makeTempDir();
    const persistentProvider = createProvider(tempDir);
    const persistentStore = new CompressionStateStore();
    persistentStore
      .getState(persistentProvider, 'session-reset-ephemeral')
      .seenFunctionResponseIds.push('persisted-response');
    persistentStore.saveState(persistentProvider, 'session-reset-ephemeral');

    const ephemeralProvider = createProvider(tempDir, false);
    const ephemeralStore = new CompressionStateStore();
    ephemeralStore.getState(ephemeralProvider, 'session-reset-ephemeral');
    ephemeralStore.reset(ephemeralProvider, 'session-reset-ephemeral');

    expect(
      ephemeralStore.getState(ephemeralProvider, 'session-reset-ephemeral'),
    ).toEqual(createEmptyCompressionPipelineState());
    expect(
      new CompressionStateStore().getState(
        persistentProvider,
        'session-reset-ephemeral',
      ).seenFunctionResponseIds,
    ).toEqual(['persisted-response']);
  });
});
