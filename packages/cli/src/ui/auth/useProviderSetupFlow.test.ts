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
