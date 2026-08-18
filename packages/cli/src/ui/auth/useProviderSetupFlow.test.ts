/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  CODING_PLAN_CHINA_BASE_URL,
  codingPlanProvider,
  openRouterProvider,
} from '@qwen-code/qwen-code-core';
import type { ModelDiscoveryResult } from '@qwen-code/qwen-code-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';

const fetchProviderModelIdsMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, fetchProviderModelIds: fetchProviderModelIdsMock };
});

const BUILT_IN_IDS = codingPlanProvider.models!.map((model) => model.id);
const RETIRED_ID = BUILT_IN_IDS[0]!;
const SERVED_IDS = BUILT_IN_IDS.slice(1);

function discovered(ids: string[]): ModelDiscoveryResult {
  return { ok: true, ids, totalCount: ids.length };
}

/** Drives the wizard from its first step to the model step. */
async function advanceToModelStep(
  result: { current: ReturnType<typeof useProviderSetupFlow> },
  provider = codingPlanProvider,
) {
  act(() => result.current.start(provider));
  const baseUrls = provider.baseUrl;
  if (Array.isArray(baseUrls)) {
    const firstUrl = baseUrls[0]!.url;
    act(() => result.current.selectBaseUrl(firstUrl));
  }
  await act(async () => {
    result.current.submitApiKey('sk-sp-test-key');
  });
  expect(result.current.state.step).toBe('models');
}

describe('useProviderSetupFlow model discovery', () => {
  beforeEach(() => {
    fetchProviderModelIdsMock.mockReset();
  });

  it('recommends the live list and prunes retired built-ins', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(
      discovered([...SERVED_IDS, 'qwen4-preview']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);

    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(fetchProviderModelIdsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        apiKey: 'sk-sp-test-key',
      }),
    );
    expect(result.current.state.recommendedModels.map((m) => m.id)).toEqual([
      ...SERVED_IDS,
      'qwen4-preview',
    ]);
    // The retired id was checked by default; it must not survive into the
    // selection that gets installed.
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);
    expect(result.current.state.modelIds).toContain(SERVED_IDS[0]);
    // A newly served model is offered, not silently selected.
    expect(result.current.state.modelIds).not.toContain('qwen4-preview');
    expect(result.current.state.recommendedModelsRevision).toBe(1);
  });

  it('keeps user-typed ids that the endpoint does not list', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    act(() => result.current.changeModelIds('my-private-deployment'));

    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(result.current.state.modelIds).toContain('my-private-deployment');
  });

  it('selects a live model when discovery retires the whole selection', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(['only-survivor']));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);

    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(result.current.state.modelIds).toBe('only-survivor');
  });

  it('falls back to the built-in list when discovery fails', async () => {
    fetchProviderModelIdsMock.mockResolvedValue({
      ok: false,
      reason: 'unauthorized',
      message: '401 Unauthorized',
    });

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);

    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('failed'),
    );

    expect(result.current.state.recommendedModels.map((m) => m.id)).toEqual(
      BUILT_IN_IDS,
    );
    expect(result.current.state.modelIds).toContain(RETIRED_ID);
  });

  it('does not call the endpoint for providers that have not opted in', async () => {
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result, openRouterProvider);

    await waitFor(() => expect(result.current.state.step).toBe('models'));

    expect(fetchProviderModelIdsMock).not.toHaveBeenCalled();
    expect(result.current.state.discoveryStatus).toBe('idle');
    expect(result.current.state.recommendedModels).toEqual(
      openRouterProvider.models,
    );
  });

  /** Re-enters the model step with a (possibly different) api key. */
  async function reenterModelStep(
    result: { current: ReturnType<typeof useProviderSetupFlow> },
    apiKey: string,
  ) {
    act(() => {
      result.current.goBack();
    });
    await act(async () => {
      result.current.submitApiKey(apiKey);
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
  }

  it('abandons an in-flight lookup when a cached pair is restored', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered([...SERVED_IDS, 'k1-only']),
    );
    let resolveSecond!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Second key: its lookup is still in flight when the user goes back.
    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Restoring the first key is a cache hit, which used to return without
    // aborting the second lookup.
    await reenterModelStep(result, 'sk-sp-test-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const secondSignal = fetchProviderModelIdsMock.mock.calls[1]![0]
      .signal as AbortSignal;
    expect(secondSignal.aborted).toBe(true);

    // The abandoned lookup answers late; it must not land on the restored pair.
    await act(async () => {
      resolveSecond(discovered(['second-key-only']));
    });

    const ids = result.current.state.recommendedModels.map((m) => m.id);
    expect(ids).toContain('k1-only');
    expect(ids).not.toContain('second-key-only');
    expect(result.current.state.discoveryStatus).toBe('success');
  });

  it('shows the built-ins, not the previous pair, while a new pair loads', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered([...SERVED_IDS, 'k1-only']),
    );
    let resolveSecond!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const revisionAfterSuccess = result.current.state.recommendedModelsRevision;

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // The "fetching…" notice must not sit above the first key's catalog.
    expect(
      result.current.state.recommendedModels.map((m) => m.id),
    ).not.toContain('k1-only');
    // And the mounted step must re-derive its checkbox state against it.
    expect(result.current.state.recommendedModelsRevision).toBeGreaterThan(
      revisionAfterSuccess,
    );

    await act(async () => {
      resolveSecond({
        ok: false,
        reason: 'unauthorized',
        message: '401 Unauthorized',
      });
    });

    expect(result.current.state.discoveryStatus).toBe('failed');
    expect(result.current.state.recommendedModels.map((m) => m.id)).toEqual(
      BUILT_IN_IDS,
    );
  });

  it('does not remount the model step when the list is unchanged', async () => {
    fetchProviderModelIdsMock.mockResolvedValue({
      ok: false,
      reason: 'network',
      message: 'ETIMEDOUT',
    });

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('failed'),
    );

    // Nothing ever replaced the built-in list, so remounting the step would
    // wipe an in-progress search and focus for no visible change.
    expect(result.current.state.recommendedModelsRevision).toBe(0);
  });

  it('retries a failed lookup when the model step is re-entered', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce({
      ok: false,
      reason: 'network',
      message: 'ETIMEDOUT',
    });
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('failed'),
    );

    // A failure caches nothing, so the transient blip must not freeze the
    // pair into "built-ins only" for the rest of the wizard session.
    await reenterModelStep(result, 'sk-sp-test-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-request when the model step is re-entered', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    act(() => {
      result.current.goBack();
    });
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));

    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(1);
  });
});
