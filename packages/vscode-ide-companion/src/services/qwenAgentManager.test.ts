/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  extractSessionListItems,
  QwenAgentManager,
} from './qwenAgentManager.js';
import type { ModelInfo } from '@agentclientprotocol/sdk';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

describe('extractSessionListItems', () => {
  it('returns sessions array from the "sessions" field', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'session-1' }],
    });
    expect(items).toEqual([{ sessionId: 'session-1' }]);
  });

  it('returns items array from the legacy "items" field', () => {
    const items = extractSessionListItems({
      items: [{ sessionId: 'session-2' }],
    });
    expect(items).toEqual([{ sessionId: 'session-2' }]);
  });

  it('prefers "sessions" over "items" when both are present', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'from-sessions' }],
      items: [{ sessionId: 'from-items' }],
    });
    expect(items).toEqual([{ sessionId: 'from-sessions' }]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(extractSessionListItems(null)).toEqual([]);
    expect(extractSessionListItems(undefined)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(extractSessionListItems('string')).toEqual([]);
    expect(extractSessionListItems(42)).toEqual([]);
  });

  it('returns empty array when neither field is an array', () => {
    expect(extractSessionListItems({ sessions: 'not-array' })).toEqual([]);
    expect(extractSessionListItems({ items: 123 })).toEqual([]);
    expect(extractSessionListItems({})).toEqual([]);
  });
});

describe('QwenAgentManager.setModelFromUi', () => {
  it('emits the selected model metadata from the available models list', async () => {
    const manager = new QwenAgentManager();
    const onModelChanged = vi.fn();
    manager.onModelChanged(onModelChanged);

    const selectedModel: ModelInfo = {
      modelId: 'qwen3-coder-plus',
      name: 'Qwen3 Coder Plus',
      _meta: {
        contextLimit: 262144,
      },
    };

    (
      manager as unknown as {
        baselineAvailableModels: ModelInfo[];
      }
    ).baselineAvailableModels = [
      {
        modelId: 'qwen3-coder-base',
        name: 'Qwen3 Coder Base',
        _meta: {
          contextLimit: 131072,
        },
      },
      selectedModel,
    ];

    (
      manager as unknown as {
        connection: {
          setModel: (modelId: string) => Promise<{ modelId: string }>;
        };
      }
    ).connection = {
      setModel: vi.fn().mockResolvedValue({ modelId: selectedModel.modelId }),
    };

    await manager.setModelFromUi(selectedModel.modelId);

    expect(onModelChanged).toHaveBeenCalledWith(selectedModel);
  });
});

describe('QwenAgentManager.createNewSession', () => {
  it('creates a fresh ACP session when explicitly requested even if one is already active', async () => {
    const manager = new QwenAgentManager();
    const connection = {
      currentSessionId: 'session-1',
      newSession: vi.fn().mockImplementation(async () => {
        connection.currentSessionId = 'session-2';
        return { sessionId: 'session-2' };
      }),
      authenticate: vi.fn(),
    };

    (
      manager as unknown as {
        connection: typeof connection;
      }
    ).connection = connection;

    const newSessionId = await manager.createNewSession('/workspace', {
      forceNew: true,
    } as never);

    expect(connection.newSession).toHaveBeenCalledWith('/workspace');
    expect(newSessionId).toBe('session-2');
  });
});
