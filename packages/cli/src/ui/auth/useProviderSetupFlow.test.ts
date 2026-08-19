/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_GLOBAL_BASE_URL,
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
  return { ok: true, ids };
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
    // The lookup must still be pending while the id is typed: a mock that
    // resolves during `advanceToModelStep` prunes first, and the later
    // `changeModelIds` would simply overwrite the result — the keep-user-ids
    // clause would never run.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValue(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );
    act(() =>
      result.current.changeModelIds(`my-private-deployment, ${RETIRED_ID}`),
    );

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(result.current.state.modelIds).toContain('my-private-deployment');
    // The typed built-in is still an id the endpoint stopped serving.
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);
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

  it('re-derives the selection for a new pair instead of narrowing further', async () => {
    // Region A retires one built-in; region B serves the whole list. The
    // prune can only remove ids, so a selection derived from A's result would
    // keep the id unchecked on an endpoint that does serve it.
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(SERVED_IDS));
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.modelIds).toContain(RETIRED_ID),
    );
    expect(result.current.state.discoveryStatus).toBe('success');
  });

  it('restores the selection when a new pair falls back to the built-ins', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(SERVED_IDS));
    fetchProviderModelIdsMock.mockResolvedValueOnce({
      ok: false,
      reason: 'unauthorized',
      message: '401 Unauthorized',
    });

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);

    // The second pair never answers, so nothing re-derives the selection
    // after the fact — the step shows the whole built-in list and the
    // selection has to match it.
    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('failed'),
    );
    expect(result.current.state.recommendedModels.map((m) => m.id)).toEqual(
      BUILT_IN_IDS,
    );
    expect(result.current.state.modelIds).toContain(RETIRED_ID);
  });

  it('does not carry the fallback pick into the next pair', async () => {
    // Both catalogs are disjoint from the built-in list, so each pair prunes
    // the selection empty and falls back to its own first live model.
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered(['region-a-preview']),
    );
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered(['region-b-live']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('region-a-preview'),
    );

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('region-b-live'),
    );
  });

  it('does not record the fallback pick as authored when the step syncs an edit', async () => {
    // Both catalogs are disjoint from the built-ins, so each pair prunes the
    // selection empty and falls back to its own first live model.
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered(['region-a-preview']),
    );
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered(['region-b-live']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('region-a-preview'),
    );

    // The step composes the custom input with every checked recommendation and
    // syncs the whole selection back, so the wizard's fallback rides along on
    // an edit that only typed `my-id`.
    act(() => result.current.changeModelIds('my-id, region-a-preview'));

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    // Recorded as authored, the fallback would survive pair B's prune (it is
    // not a built-in) and suppress pair B's own fallback.
    expect(result.current.state.modelIds).toBe('my-id');
  });

  it('does not bake a pruned built-in out of the baseline on an edit', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(SERVED_IDS));
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);

    // One ordinary keystroke in the custom-ids input. The step syncs the whole
    // composed selection, which by now is missing the id pair A retired.
    const displayed = result.current.state.modelIds;
    act(() => result.current.changeModelIds(`${displayed}, my-id`));

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    // Pair B serves the whole built-in list, and a prune can only remove ids —
    // so the baseline is the only thing that can bring the retired id back.
    expect(result.current.state.modelIds).toContain(RETIRED_ID);
    expect(result.current.state.modelIds).toContain('my-id');
  });

  it('remounts the model step when a cache hit prunes the selection', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.recommendedModelsRevision).toBe(1);

    // The user types an id this endpoint no longer serves into the custom
    // input, then leaves the step without submitting.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
      ),
    );
    act(() => {
      result.current.goBack();
    });
    // Editing the key off-step releases the pair without replacing the list,
    // so returning to it is served from the cache with the very same array.
    act(() => result.current.changeApiKey('sk-sp-other-key'));
    act(() => result.current.changeApiKey('sk-sp-test-key'));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));

    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);
    // Without the bump the mounted step keeps showing the retired id in its
    // custom input, and submitting re-merges it back in.
    await waitFor(() =>
      expect(result.current.state.recommendedModelsRevision).toBe(2),
    );
  });

  it('re-requests when the region changes under the same key', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.goBack();
    });
    act(() => {
      result.current.goBack();
    });
    expect(result.current.state.step).toBe('baseUrl');
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));

    // The other region is a different endpoint: its catalog is not the one the
    // China entry answered with, so the pair key must not collapse to the key.
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );
    expect(fetchProviderModelIdsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: CODING_PLAN_GLOBAL_BASE_URL }),
    );
  });

  it('abandons an in-flight lookup when the pair changes off the model step', async () => {
    let resolveFirst!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveFirst = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Esc back to the key step and retype: every effect run from here on is
    // off the model step, which is where the pair change has to be noticed.
    act(() => {
      result.current.goBack();
    });
    act(() => {
      result.current.changeApiKey('sk-sp-second-key');
    });

    const firstSignal = fetchProviderModelIdsMock.mock.calls[0]![0]
      .signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);

    // The abandoned pair answers late; it must not prune the selection the
    // user is now assembling for a different key.
    await act(async () => {
      resolveFirst(discovered(['first-key-only']));
    });

    expect(result.current.state.modelIds).toContain(RETIRED_ID);
    expect(result.current.state.modelIds).not.toContain('first-key-only');
    expect(result.current.state.discoveryStatus).toBe('loading');
  });

  it('reuses the cached answer across a restart of the same provider', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // `AuthDialog` reuses one hook instance across provider selections, so a
    // second `start()` re-enters through the cache rather than the network.
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);
  });

  it('aborts the lookup when the dialog goes away', async () => {
    fetchProviderModelIdsMock.mockReturnValue(
      new Promise<ModelDiscoveryResult>(() => {}),
    );

    const { result, unmount } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    unmount();

    const signal = fetchProviderModelIdsMock.mock.calls[0]![0]
      .signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('does not serve one provider the list merged for another', async () => {
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Same endpoint and key, a different provider: the cached list was merged
    // against the first provider's built-in specs, so it is not an answer for
    // the second one.
    await advanceToModelStep(result, {
      ...codingPlanProvider,
      id: 'other-provider',
    });
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
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
