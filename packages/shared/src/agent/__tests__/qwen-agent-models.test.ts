import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelDefinition } from '../../config/models.ts';
import type { BackendConfig } from '../backend/types.ts';
import { QwenAgent } from '../qwen-agent.ts';

type QwenModelInternals = {
  recordSessionModels: (result: Record<string, unknown>) => void;
};

function createAgent(cwd: string, onAvailableModelsUpdate: BackendConfig['onAvailableModelsUpdate']): QwenAgent {
  return new QwenAgent({
    provider: 'qwen',
    workspace: {
      id: 'workspace-qwen',
      name: 'Qwen Workspace',
      slug: 'qwen-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'session-qwen',
      name: 'Qwen Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
    onAvailableModelsUpdate,
  } as BackendConfig);
}

describe('QwenAgent model metadata', () => {
  it('uses ACP-reported context and thinking metadata without a hardcoded context fallback', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-cwd-'));
    let capturedModels: ModelDefinition[] = [];
    let capturedCurrent: string | undefined;
    const agent = createAgent(cwd, (models, currentModelId) => {
      capturedModels = models;
      capturedCurrent = currentModelId;
    });

    (agent as unknown as QwenModelInternals).recordSessionModels({
      models: {
        currentModelId: 'glm-5.1(openai)',
        availableModels: [
          {
            modelId: 'glm-5.1(openai)',
            name: 'GLM 5.1',
            _meta: {
              contextLimit: 128_000,
              enable_thinking: false,
            },
          },
          {
            modelId: 'qwen3-coder-plus',
            name: 'Qwen3 Coder Plus',
          },
        ],
      },
    });

    expect(agent.getModel()).toBe('glm-5.1(openai)');
    expect(capturedCurrent).toBe('glm-5.1(openai)');
    expect(capturedModels[0]).toMatchObject({
      id: 'glm-5.1(openai)',
      contextWindow: 128_000,
      supportsThinking: false,
    });
    expect(capturedModels[1]?.id).toBe('qwen3-coder-plus');
    expect(capturedModels[1]).not.toHaveProperty('contextWindow');
  });
});
