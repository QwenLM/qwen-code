/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { withTestSelection } from '../test-utils/request-model.js';
import {
  fixedSelection,
  policySelection,
} from '../test-utils/request-model.js';
import { testModelResolution } from '../test-utils/model-resolution.js';

import { describe, expect, it, vi } from 'vitest';
import { createCompactRequestResolver } from './compact-request-resolver.js';
import type { CompressionRequestModel } from '../compression-v2/types.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import { generationFromModelConfig } from '../config/generation-config.js';

vi.mock('../qoder/models/inference-guard.js', () => ({
  assertModelAllowedForRepository: vi.fn(async () => {}),
}));
import type { TestModelSelection as ModelRouter } from '../test-utils/request-model.js';
import { FatalRoutingError } from '../routing/errors.js';

const parent: CompressionRequestModel = {
  modelResolution: testModelResolution('parent-model', {
    reasoningEffort: 'low',
    contextWindow: 128_000,
  }),
  model: 'parent-model',
  reasoningEffort: 'low',
  contextWindow: 128_000,
};

function makeRouter(
  resolve: (input: ModelSelectContext) => Promise<ModelSelection>,
): ModelRouter & { resolve: ReturnType<typeof vi.fn> } {
  return {
    kind: 'fixed',
    resolve: vi.fn(resolve),
  };
}

function makeResolver(
  router: ModelRouter,
  overrides: Partial<Parameters<typeof createCompactRequestResolver>[0]> = {},
) {
  return createCompactRequestResolver(
    withTestSelection({
      selectModel: router.resolve,
      parent,
      signal: new AbortController().signal,
      sessionId: 'sid',
      turnIndex: 3,
      logLabel: 'test compact resolve',
      ...overrides,
    }),
  );
}

describe('createCompactRequestResolver', () => {
  it('keeps the parent selection for a parameter-only SDK policy and projects the new parameters consistently', async () => {
    const router = policySelection({
      baseRouter: fixedSelection(parent.modelResolution),
      getModelPolicy: async () => ({ parameters: { reasoningEffort: 'high' } }),
    });
    const request = await makeResolver(router)();
    expect(request.model).toBe(parent.model);
    expect(request.reasoningEffort).toBe('high');
    expect(request.modelResolution.config.reasoning?.effort).toBe(
      request.reasoningEffort,
    );
    expect(request.contextWindow).toBe(parent.contextWindow);
    expect(request.modelResolution.config.context?.contextWindow).toBe(
      request.contextWindow,
    );
  });

  it('maps the routed resolution', async () => {
    const router = makeRouter(async () =>
      testModelResolution('routed-model', {
        reasoningEffort: 'high',
        contextWindow: 256_000,
      }),
    );

    const request = await makeResolver(router)();

    expect(request).toEqual({
      modelResolution: testModelResolution('routed-model', {
        reasoningEffort: 'high',
        contextWindow: 256_000,
      }),
      model: 'routed-model',
      source: 'fixed',
      reasoningEffort: 'high',
      contextWindow: 256_000,
      generation: generationFromModelConfig(request.modelResolution.config),
      policyLabels: undefined,
    });
    expect(router.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'compact',
        parentSelection: parent.modelResolution,
        overrideSelection: undefined,
      }),
    );
  });

  it('forwards subagent identity to compact model policy resolution', async () => {
    const getModelPolicy = vi.fn(async () => undefined);
    const router = policySelection({
      baseRouter: fixedSelection(parent.modelResolution),
      getModelPolicy,
    });
    const signal = new AbortController().signal;

    await makeResolver(router, {
      signal,
      isSubagent: true,
      agentId: 'agent-run-1',
      agentType: 'bash-agent',
    })();

    expect(getModelPolicy).toHaveBeenCalledWith(
      'compact',
      'sid',
      3,
      'agent-run-1',
      signal,
      { resolvedModel: 'parent-model', agentType: 'bash-agent' },
    );
  });

  it('memoizes: repeated calls share one routing decision', async () => {
    const router = makeRouter(async () => testModelResolution('routed-model'));
    const resolve = makeResolver(router);

    const [a, b] = await Promise.all([resolve(), resolve()]);
    await resolve();

    expect(a).toBe(b);
    expect(router.resolve).toHaveBeenCalledTimes(1);
  });

  it('degrades to the parent request on non-cancellation failure', async () => {
    const failure = new Error('policy unavailable');
    const router = makeRouter(async () => {
      throw failure;
    });

    await expect(makeResolver(router, { isSubagent: true })()).resolves.toBe(
      parent,
    );
  });

  it('does not use the parent model when SDK compact policy fails', async () => {
    const failure = new Error('DIRECT_EXECUTION_UNSUPPORTED');
    const router = policySelection({
      baseRouter: fixedSelection('auto'),
      getModelPolicy: vi.fn().mockRejectedValue(failure),
    });
    const resolve = makeResolver(router, {
      parent: {
        modelResolution: testModelResolution('auto'),
        model: 'auto',
      },
    });

    await expect(resolve()).rejects.toBe(failure);
    await expect(resolve()).rejects.toBe(failure);
  });

  it('preserves fatal local routing failures instead of reverting to the parent', async () => {
    const cause = new Error('Custom Provider is unavailable');
    const fatal = new FatalRoutingError(cause.message, { cause });
    const router = makeRouter(async () => {
      throw fatal;
    });
    await expect(makeResolver(router)()).rejects.toBe(fatal);
    expect(fatal.cause).toBe(cause);
  });

  it('rethrows cancellation instead of degrading', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Operation cancelled');
    cancellation.name = 'AbortError';
    const router = makeRouter(async () => {
      controller.abort(cancellation);
      throw cancellation;
    });

    await expect(
      makeResolver(router, { signal: controller.signal })(),
    ).rejects.toBe(cancellation);
  });
});
