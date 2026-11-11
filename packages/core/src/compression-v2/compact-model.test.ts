/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { ensureCompactModelSelected } from './compact-model.js';
import type { CompressionPipelineInput } from './types.js';
import {
  testProviderModelResolution,
  testModelProviderManager,
} from './provider-test-helpers.js';

function createInput(): CompressionPipelineInput {
  const manager = testModelProviderManager();
  return {
    modelResolution: testProviderModelResolution('parent-model', {
      sampling: { temperature: 0.2 },
      reasoning: {
        thinking: { type: 'disabled' },
        effort: 'high',
        preserve: false,
      },
      context: { contextWindow: 128_000 },
    }),
    modelProviderManager: manager,
    history: [],
    requestPrefixMessages: [],
    promptTokenCount: 0,
    promptId: 'prompt-1',
    force: true,
    trigger: 'manual',
    autoCompactTracking: { consecutiveFailures: 0 },
    config: {
      getModel: () => 'parent-model',
      getModelRequestIdentity: () => 'account-1',
      getSessionId: () => 'root-session-1',
      getModelProviderManager: () => manager,
      getWorkspaceContext: () => ({ getDirectories: () => ['/workspace'] }),
    } as unknown as CompressionPipelineInput['config'],
    target: 'main',
    rootSessionId: 'root-session-1',
    sessionScopeId: 'session-1',
  };
}

describe('ensureCompactModelSelected', () => {
  it('uses the final same-model selection while preserving disabled thinking in the parent input', async () => {
    const input = createInput();
    const parent = input.modelResolution;
    const selected = testProviderModelResolution('parent-model', {
      sampling: { temperature: 0.8 },
      reasoning: { effort: 'low', thinking: { type: 'disabled' } },
      context: { contextWindow: 64_000 },
    });
    vi.mocked(input.modelProviderManager.select).mockResolvedValue(selected);
    expect(await ensureCompactModelSelected(input)).toBe(selected);
    expect(input.modelResolution).toBe(selected);
    expect(input.modelProviderManager.select).toHaveBeenCalledExactlyOnceWith({
      purpose: 'compact',
      parentSelection: parent,
      workdirs: ['/workspace'],
    });
    expect(parent.config.reasoning?.thinking).toEqual({ type: 'disabled' });
    expect(parent.config.sampling?.temperature).toBe(0.2);
    expect(input.modelProviderManager.getModelConfig).not.toHaveBeenCalled();
  });

  it('does not merge model defaults or preferences over the manager final selection', async () => {
    const input = createInput();
    const target = testProviderModelResolution('routed-model', {
      reasoning: { effort: 'low' },
      context: { contextWindow: 64_000 },
    });
    const selected = {
      ...target,
      model: {
        ...target.model,
        defaultModelConfig: { sampling: { temperature: 0.8 } },
      },
    };
    vi.mocked(input.modelProviderManager.select).mockResolvedValue(selected);
    vi.mocked(input.modelProviderManager.getModelConfig).mockReturnValue({
      context: { contextWindow: 96_000 },
    });
    expect(await ensureCompactModelSelected(input)).toBe(selected);
    expect(input.modelResolution.config).toBe(target.config);
    expect(input.modelResolution.config.sampling).toBeUndefined();
    expect(input.modelProviderManager.getModelConfig).not.toHaveBeenCalled();
  });

  it('does not reuse a parent snapshot solely because a different provider uses the same model key', async () => {
    const input = createInput();
    const target = testProviderModelResolution('parent-model', {
      context: { contextWindow: 64_000 },
    });
    const selected = {
      ...target,
      model: { ...target.model, source: 'another-provider' },
    };
    vi.mocked(input.modelProviderManager.select).mockResolvedValue(selected);
    expect(await ensureCompactModelSelected(input)).toBe(selected);
    expect(input.modelResolution.config).toBe(target.config);
  });

  it('shares one selection across concurrent callers and retries and observes it once', async () => {
    const input = createInput();
    input.onCompactModelSelected = vi.fn();
    const first = ensureCompactModelSelected(input);
    expect(ensureCompactModelSelected(input)).toBe(first);
    await first;
    await ensureCompactModelSelected(input);
    expect(input.modelProviderManager.select).toHaveBeenCalledTimes(1);
    expect(input.onCompactModelSelected).toHaveBeenCalledTimes(1);
  });

  it('uses the policy adapter final selection and preserves its labels and source', async () => {
    const input = createInput();
    const selected = testProviderModelResolution('sdk-model', {
      reasoning: { effort: 'none', thinking: { type: 'disabled' } },
      sampling: { temperature: 0.6 },
    });
    const labels = { taskId: 'sdk-task', subTask: 'sdk-compact' };
    input.resolveCompactSelection = vi.fn(async () => ({
      selection: selected,
      policyLabels: labels,
      source: 'sdk-policy' as const,
    }));
    input.onCompactModelSelected = vi.fn();
    expect(await ensureCompactModelSelected(input)).toBe(selected);
    expect(input.policyLabels).toBe(labels);
    expect(input.compactModelSource).toBe('sdk-policy');
    expect(input.onCompactModelSelected).toHaveBeenCalledExactlyOnceWith(
      selected,
      'sdk-policy',
    );
    expect(input.resolveCompactSelection).toHaveBeenCalledTimes(1);
    expect(input.modelProviderManager.select).not.toHaveBeenCalled();
  });

  it('preserves parent policy labels when the adapter supplies none', async () => {
    const input = createInput();
    const labels = { taskId: 'parent-task' };
    input.policyLabels = labels;
    input.resolveCompactSelection = async () => ({
      selection: input.modelResolution,
    });
    await ensureCompactModelSelected(input);
    expect(input.policyLabels).toBe(labels);
  });

  it('rejects cancellation while an adapter ignores its signal without adopting a late selection', async () => {
    const input = createInput();
    const parent = input.modelResolution;
    const controller = new AbortController();
    input.abortSignal = controller.signal;
    let complete!: (value: { selection: typeof parent }) => void;
    input.resolveCompactSelection = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = ensureCompactModelSelected(input);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    complete({ selection: testProviderModelResolution('late-model') });
    await Promise.resolve();
    expect(input.modelResolution).toBe(parent);
    expect(input.modelProviderManager.select).not.toHaveBeenCalled();
  });

  it('rejects a session identity change while selecting instead of adopting an obsolete selection', async () => {
    const input = createInput();
    const parent = input.modelResolution;
    let identity = 'account-1';
    input.config.getModelRequestIdentity = () => identity;
    vi.mocked(input.modelProviderManager.select).mockImplementation(
      async () => {
        identity = 'account-2';
        return testProviderModelResolution('obsolete-model');
      },
    );
    await expect(ensureCompactModelSelected(input)).rejects.toThrow(
      'Session model changed',
    );
    expect(input.modelResolution).toBe(parent);
  });
});
