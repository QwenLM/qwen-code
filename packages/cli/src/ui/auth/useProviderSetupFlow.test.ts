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
import { normalizeModelIds } from './useAuth.js';

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
    // D4-1/D7-9: this used to read `loading`, carried over from the pair that
    // was just abandoned. Nothing is loading — the new pair's lookup does not
    // start until the user comes back to the step — so the notice said the
    // wizard was fetching a list it had stopped waiting for.
    expect(result.current.state.discoveryStatus).toBe('idle');
  });

  it("drops the previous pair's list and notice when it is released off-step", async () => {
    // D4-1/D7-9: the release above only gave up the key. The list, the
    // "success" notice and the pruned selection stayed, and `ModelIdsStep`
    // reads all three as it mounts — so re-entering the step after a base-url
    // change showed the OLD endpoint's catalog, under a notice claiming it
    // had been fetched, for the committed render before this effect replaced
    // it. Anything ticked in that render submitted an id the new endpoint was
    // never asked about.
    fetchProviderModelIdsMock.mockResolvedValue(
      discovered([...SERVED_IDS, 'china-only']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.recommendedModels.map((m) => m.id)).toContain(
      'china-only',
    );
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);

    // Esc off the step and point the wizard at the other region: a different
    // endpoint, whose catalog nobody has fetched yet.
    act(() => {
      result.current.goBack();
    });
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));

    // Nothing on screen may still describe the China endpoint.
    expect(result.current.state.discoveryStatus).toBe('idle');
    expect(
      result.current.state.recommendedModels.map((m) => m.id),
    ).not.toContain('china-only');
    // The prune went with the list: the retired built-in is the wizard's
    // default again until this pair says otherwise.
    expect(result.current.state.modelIds).toContain(RETIRED_ID);
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

  it('does not read a token still being typed as a user removal', async () => {
    // R11-1. The step syncs the WHOLE composed selection on every keystroke,
    // so while a longer custom id is typed the buffer passes through shorter
    // ids as exact prefixes. `RETIRED_ID` is one of them: this endpoint does
    // not serve it, so the prune took it off screen while the authored
    // baseline kept it. The keystroke right after the buffer read exactly
    // `RETIRED_ID` saw it leave the composed selection and deleted it from
    // that baseline — although the user never saw or unchecked it. The pair
    // change below restores FROM the baseline, so a default the SECOND
    // endpoint does serve came back silently unchecked.
    fetchProviderModelIdsMock.mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        discovered(
          baseUrl === CODING_PLAN_GLOBAL_BASE_URL ? BUILT_IN_IDS : SERVED_IDS,
        ),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(result.current.state.modelIds).not.toContain(RETIRED_ID);

    // Type `<RETIRED_ID>-latest` one character at a time, the way the custom
    // input syncs it. The buffer is exactly RETIRED_ID at one of these steps.
    const typed = `${RETIRED_ID}-latest`;
    const pruned = result.current.state.modelIds;
    for (let at = 1; at <= typed.length; at += 1) {
      const buffer = typed.slice(0, at);
      act(() => result.current.changeModelIds(`${pruned}, ${buffer}`));
    }
    expect(result.current.state.modelIds).toContain(typed);

    // Change region under the same key: the new endpoint serves every built-in.
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
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    const restored = result.current.state.modelIds
      .split(',')
      .map((id) => id.trim());
    // The default the user never touched comes back checked...
    expect(restored).toContain(RETIRED_ID);
    // ...the id they actually typed survives...
    expect(restored).toContain(typed);
    // ...and no intermediate keystroke prefix was banked as an id of its own.
    // RETIRED_ID is itself a prefix of what was typed and is asserted above —
    // it is a real built-in the user never edited, not a keystroke artefact.
    for (let at = 1; at < typed.length; at += 1) {
      const prefix = typed.slice(0, at);
      if (BUILT_IN_IDS.includes(prefix)) continue;
      expect(restored).not.toContain(prefix);
    }
  });

  it('does not overwrite a half-typed buffer when a lookup lands', async () => {
    // R12-1. The lookup stays pending while the user unchecks a served
    // built-in and types a LONGER custom id over it, so the buffer passes back
    // through the unchecked id as an exact prefix. Resolving at that keystroke
    // used to commit the transient token and then swap the display to the
    // BASELINE-derived selection: the half-typed text was replaced and the
    // checkbox the user had just cleared came back ticked, with no way back to
    // the edit. Prune what is on screen instead, so the keystrokes survive.
    const UNCHECKED_ID = BUILT_IN_IDS[0]!;
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      UNCHECKED_ID,
    );

    // Uncheck the first built-in, then type `<UNCHECKED_ID>-latest` into the
    // custom field. The step composes the still-checked recommendations with
    // that text, so the buffer reads exactly the unchecked id at one keystroke.
    const stillChecked = BUILT_IN_IDS.slice(1);
    const typed = `${UNCHECKED_ID}-latest`;
    let bufferAtResolve = '';
    for (let at = 1; at <= typed.length; at += 1) {
      const buffer = [...stillChecked, typed.slice(0, at)].join(', ');
      act(() => result.current.changeModelIds(buffer));
      if (typed.slice(0, at) === UNCHECKED_ID) {
        bufferAtResolve = buffer;
        // This endpoint serves every built-in, so the prune is a no-op and the
        // only thing that can move the buffer is the display swap itself.
        await act(async () => {
          resolveLookup(discovered(BUILT_IN_IDS));
        });
        await waitFor(() =>
          expect(result.current.state.discoveryStatus).toBe('success'),
        );
        break;
      }
    }
    expect(bufferAtResolve).not.toBe('');

    // The lookup landed, but it did not reach over the user's typing.
    expect(result.current.state.modelIds).toBe(bufferAtResolve);
  });

  it('keeps an unserved built-in token that is active in the custom input', async () => {
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
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
      result.current.changeModelIds(result.current.state.modelIds, {
        customModelIds: [RETIRED_ID],
        activeCustomModelId: RETIRED_ID,
      }),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );
  });

  it('still prunes an inactive unserved built-in while another token is edited', async () => {
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
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
      result.current.changeModelIds(
        `${result.current.state.modelIds}, my-dep`,
        {
          customModelIds: [RETIRED_ID, 'my-dep'],
          activeCustomModelId: 'my-dep',
        },
      ),
    );

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const ids = normalizeModelIds(result.current.state.modelIds);
    expect(ids).not.toContain(RETIRED_ID);
    expect(ids).toContain('my-dep');
  });

  it('uses the live caret when discovery resolves after a pure cursor move', async () => {
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
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
      result.current.changeModelIds(
        `${result.current.state.modelIds}, my-dep`,
        {
          customModelIds: [RETIRED_ID, 'my-dep'],
          activeCustomModelId: RETIRED_ID,
        },
      ),
    );
    act(() => result.current.changeActiveCustomModelId('my-dep'));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const ids = normalizeModelIds(result.current.state.modelIds);
    expect(ids).not.toContain(RETIRED_ID);
    expect(ids).toContain('my-dep');
  });

  it('prunes a comma-terminated token the caret only moved back into', async () => {
    // The keep clause protects the token the user is editing, but caret
    // position alone is not proof of editing: the user terminated
    // RETIRED_ID with a comma (the last edit), then arrowed back into it —
    // pure navigation. A lookup resolving in that window must prune the
    // unserved built-in instead of shielding it for Enter to install.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type `<RETIRED_ID>, priv`; the last edit lands in `priv`.
    act(() =>
      result.current.changeModelIds(`${result.current.state.modelIds}, priv`, {
        customModelIds: [RETIRED_ID, 'priv'],
        activeCustomModelId: 'priv',
      }),
    );
    // Arrow back into the terminated id — a caret move, not an edit.
    act(() => result.current.changeActiveCustomModelId(RETIRED_ID));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    const ids = normalizeModelIds(result.current.state.modelIds);
    expect(ids).not.toContain(RETIRED_ID);
    expect(ids).toContain('priv');
  });

  it('keeps a token being typed when the caret moves inside it', async () => {
    // R19-2. The user is typing a longer id that passes through RETIRED_ID
    // and presses an arrow key inside the SAME token to correct a character.
    // That caret report stays within the occurrence the last text edit
    // touched — the edit is still alive — so a lookup landing before the
    // next keystroke must keep shielding the token. Blanket-clearing the
    // latch on every caret report pruned it instead: the step's re-derive
    // then stripped it from the buffer under the caret, and Enter installed
    // the garble the remaining keystrokes produced.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // The buffer reads exactly RETIRED_ID; the step reports the segment
    // owning the caret alongside the edit...
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // ...and again on the caret move that stays inside the same segment.
    act(() => result.current.changeActiveCustomModelId(RETIRED_ID, 0));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );
  });

  it('stops shielding a duplicate id when the caret moves to the other copy', async () => {
    // R19-2 control. In a `B,B` buffer the two copies are the same id, so
    // the reset cannot key on the id alone: the last text edit landed in the
    // second occurrence, and the caret moving into the first is navigation
    // to a comma-terminated token, which must end the protection.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type RETIRED_ID twice; the last edit owns the second segment.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 1,
        },
      ),
    );
    // Caret moves to the first copy — same id, different occurrence.
    act(() => result.current.changeActiveCustomModelId(RETIRED_ID, 0));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      RETIRED_ID,
    );
  });

  it('keeps a default banked when its transient freeze only grew', async () => {
    // The lookup resolves on the exact keystroke where the buffer reads
    // exactly RETIRED_ID, so the keep clause freezes the transient token
    // into the authorship reference point. The user keeps typing and it
    // grows into `<RETIRED_ID>-latest`; the commit delta must not read that
    // growth as a removal of RETIRED_ID — it was checked by default and
    // never unchecked, yet the next pair change restores from the baseline,
    // so an endpoint that serves it showed it silently missing.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type one character at a time, the way the step syncs each keystroke,
    // and resolve on the keystroke where the buffer's token is exactly
    // RETIRED_ID. The re-derive then dedupes the token being typed against
    // its checkbox, so the later compositions carry only the still-checked
    // defaults plus the growing custom token.
    const typed = `${RETIRED_ID}-latest`;
    const defaults = normalizeModelIds(result.current.state.modelIds);
    for (let at = 1; at <= typed.length; at += 1) {
      const buffer = typed.slice(0, at);
      const composed =
        at <= RETIRED_ID.length
          ? [...defaults, buffer]
          : [...defaults.filter((id) => id !== RETIRED_ID), buffer];
      act(() =>
        result.current.changeModelIds(composed.join(', '), {
          customModelIds: [buffer],
          activeCustomModelId: buffer,
        }),
      );
      if (at !== RETIRED_ID.length) continue;
      await act(async () => {
        resolveLookup(discovered(SERVED_IDS));
      });
      await waitFor(() =>
        expect(result.current.state.discoveryStatus).toBe('success'),
      );
    }

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // The default the user never unchecked comes back checked on an
    // endpoint that serves it, beside the id they actually typed.
    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain(RETIRED_ID);
    expect(restored).toContain(typed);
  });

  it('banks a committed rename that grows a custom id', async () => {
    // R19-1, shape one. The user commits `my-model`, re-enters, and renames
    // by appending: `before` is [`my-model`], `after` is [`my-model-v2`].
    // That is a committed removal of the shorter id — but reading the
    // removed set from string shape exempted it (`my-model-v2` starts with
    // `my-model`), so the baseline kept both and the next pair change
    // restored the id the user had replaced. Custom ids have no checkbox;
    // the commit delta is their only removal channel.
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Commit 1: bank a custom id.
    const kept = result.current.state.modelIds;
    act(() => result.current.changeModelIds(`${kept}, my-model`));
    act(() => {
      result.current.goBack();
    });
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));

    // Commit 2: rename it by appending.
    act(() => result.current.changeModelIds(`${kept}, my-model-v2`));
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain('my-model-v2');
    expect(restored).not.toContain('my-model');
  });

  it('banks the deletion of a custom id that prefixes a surviving one', async () => {
    // R19-1, shape two. The baseline holds `my-deploy` and
    // `my-deploy-backup`; the user deletes the shorter twin and commits.
    // The surviving sibling starts with the removed id, so a shape-based
    // exemption emptied the removed set — the deletion never reached the
    // baseline and the next pair change resurrected it.
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Commit 1: bank two custom ids, one prefixing the other.
    const kept = result.current.state.modelIds;
    act(() =>
      result.current.changeModelIds(`${kept}, my-deploy, my-deploy-backup`),
    );
    act(() => {
      result.current.goBack();
    });
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));

    // Commit 2: delete the shorter twin.
    act(() => result.current.changeModelIds(`${kept}, my-deploy-backup`));
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain('my-deploy-backup');
    expect(restored).not.toContain('my-deploy');
  });

  it('banks an in-flight recommendation removal without banking typed prefixes', async () => {
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );
    const removed = BUILT_IN_IDS[0]!;
    const remaining = normalizeModelIds(result.current.state.modelIds).filter(
      (id) => id !== removed,
    );
    act(() =>
      result.current.changeModelIds(remaining.join(', '), {
        customModelIds: [],
        removedRecommendationId: removed,
      }),
    );

    await act(async () => {
      resolveLookup(discovered(BUILT_IN_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      removed,
    );
  });

  it('records the fallback pick once the user re-endorses it', async () => {
    // R12-2. Pair A's catalog is disjoint from the built-ins, so the prune
    // empties the selection and the wizard injects its own pick. Unchecking
    // and re-checking that id is an explicit endorsement — but the strip that
    // keeps a PASSIVELY retained fallback out of the baseline removed the id
    // from both halves of the delta, so the endorsement netted out to nothing
    // and the next pair change dropped the model the user had re-selected.
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(['x-preview']));
    // Pair B serves x-preview AND enough built-ins that the prune leaves a
    // non-empty selection — otherwise the empty-prune fallback would re-inject
    // x-preview and hide the drop.
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered([...SERVED_IDS, 'x-preview']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('x-preview'),
    );

    // Uncheck the injected fallback, then check it again.
    act(() => result.current.changeModelIds(''));
    act(() => result.current.changeModelIds('x-preview'));

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Pair B serves it and the user asked for it explicitly, so it survives.
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      'x-preview',
    );
  });

  it('records a fallback retyped into custom input before its checkbox is cleared', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(['x-preview']));
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered([...SERVED_IDS, 'x-preview']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('x-preview'),
    );

    act(() =>
      result.current.changeModelIds('x-preview', {
        customModelIds: ['x-preview'],
      }),
    );
    act(() =>
      result.current.changeModelIds('x-preview', {
        customModelIds: ['x-preview'],
        removedRecommendationId: 'x-preview',
      }),
    );

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      'x-preview',
    );
  });

  it('does not endorse an injected fallback passed through as a prefix', async () => {
    fetchProviderModelIdsMock.mockResolvedValueOnce(discovered(['x-preview']));
    fetchProviderModelIdsMock.mockResolvedValueOnce(
      discovered(['region-b-live']),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.modelIds).toBe('x-preview'),
    );

    const typed = 'x-preview-internal';
    for (let at = 1; at <= typed.length; at += 1) {
      const customModelId = typed.slice(0, at);
      act(() =>
        result.current.changeModelIds(
          [...new Set([customModelId, 'x-preview'])].join(', '),
          { customModelIds: [customModelId] },
        ),
      );
    }

    await reenterModelStep(result, 'sk-sp-second-key');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const ids = normalizeModelIds(result.current.state.modelIds);
    expect(ids).toContain(typed);
    expect(ids).not.toContain('x-preview');
  });

  it('still records an id the user removes before leaving the step', async () => {
    // The control for the test above: deferring authorship to the commit must
    // not make a real removal invisible. Unchecking a served built-in and
    // stepping off has to survive the pair change, or the prune would restore
    // an id the user deliberately took out.
    fetchProviderModelIdsMock.mockResolvedValue(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    const dropped = SERVED_IDS[0]!;
    expect(result.current.state.modelIds).toContain(dropped);

    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== dropped)
          .join(', '),
      ),
    );
    act(() => {
      result.current.goBack();
    });
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      dropped,
    );
  });

  it('lets a second commit remove what the first one banked', async () => {
    // The commit is the new authorship reference point. Leaving it on the
    // pre-edit display made a later removal invisible: `before` still lacked
    // the id the first commit had just banked, so it never landed in
    // `removed` and survived in the baseline — and the next pair change
    // restored an id the user had deleted. Re-entering the step under the
    // same pair is served from the cache and installs no selection of its
    // own, so nothing else moves the reference point here.
    fetchProviderModelIdsMock.mockResolvedValue(discovered(SERVED_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Commit 1: type a custom id and step off, banking it.
    const kept = result.current.state.modelIds;
    act(() => result.current.changeModelIds(`${kept}, my-private-deploy`));
    act(() => {
      result.current.goBack();
    });
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(1);

    // Commit 2: delete it again and step off.
    act(() => result.current.changeModelIds(kept));
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      'my-private-deploy',
    );
  });

  it('banks the committed deletion of a shielded token, not just its growth', async () => {
    // R20-1. The keep clause freezes the unserved built-in being typed into
    // the authorship reference point, and the exemption assumed its later
    // disappearance at commit is always the token growing. The user can
    // delete the shielded token instead: nothing cleared the freeze before
    // that commit, so the exemption kept the id out of `removed`, the
    // baseline retained it, and the next pair change restored a selection
    // the user had committed without it — silently undoing the deletion.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in into the custom input, then resolve on
    // that keystroke: the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // The user deletes the shielded token and commits with Esc.
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', '),
        { customModelIds: [] },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline. The second endpoint serves
    // the whole built-in list, so a baseline that kept the deleted id
    // would show it checked again.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      RETIRED_ID,
    );
  });

  it('does not re-arm the edit latch when focus returns without an edit', async () => {
    // R20-2. Focus leaving the custom input clears the latch, but the
    // marker of the occurrence the last edit touched survived the leave —
    // so the tab/up paths back into the input re-reported the id at the
    // unchanged caret offset and re-armed the latch with no edit in
    // between. A lookup resolving in that window shielded and froze a
    // token nobody was typing anymore, and Enter installed a model the
    // endpoint does not serve.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in; the edit owns its occurrence.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // Tab/down away: the undefined report clears the latch. Tab/up back:
    // the step re-reports the id at the unchanged caret offset — a pure
    // focus move, no edit.
    act(() => result.current.changeActiveCustomModelId(undefined));
    act(() => result.current.changeActiveCustomModelId(RETIRED_ID, 0));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      RETIRED_ID,
    );
  });

  it('banks a custom-token deletion made while a lookup is in flight', async () => {
    // R20-3, the deletion twin of R12-1. With an edit in flight the resolve
    // skips the commit and then installs the pruned selection as the new
    // reference point — moving it past whatever the user had already
    // deleted. A custom-token deletion carries no removedRecommendationId,
    // so the commit delta is its only removal channel, and at that commit
    // `before === after`: the deleted id stayed in the baseline and the
    // next pair change restored it.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    // `start()` banks a saved custom id alongside the defaults.
    act(() =>
      result.current.start(codingPlanProvider, undefined, undefined, [
        'my-deploy',
      ]),
    );
    const baseUrls = codingPlanProvider.baseUrl;
    if (Array.isArray(baseUrls)) {
      const firstUrl = baseUrls[0]!.url;
      act(() => result.current.selectBaseUrl(firstUrl));
    }
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    expect(result.current.state.step).toBe('models');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      'my-deploy',
    );

    // Mid-lookup the user deletes the saved custom id...
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== 'my-deploy')
          .join(', '),
        { customModelIds: [] },
      ),
    );

    // ...and the lookup resolves over the uncommitted edit.
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      'my-deploy',
    );

    // The commit folds what is on screen into the baseline...
    act(() => {
      result.current.goBack();
    });

    // ...and a pair change restores from it. The second endpoint serves
    // the whole built-in list, so only the baseline can resurrect the
    // deleted id.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      'my-deploy',
    );
  });

  it('banks the deletion of a shielded token whose prefix twin survives', async () => {
    // R22-1, entrance A. The growth exemption pinned the frozen occurrence
    // by its raw comma-segment index and read the NORMALIZED custom-ids
    // array with it, and the pin went stale the moment the buffer
    // re-indexed: deleting the shielded token slid the surviving prefix
    // twin into the pinned slot, the exemption read the twin as the frozen
    // token's growth, and the committed deletion never reached the
    // baseline — the next pair change restored it.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    // The prefix twin is a saved alias, so it sits in the custom buffer
    // beside the token being typed.
    act(() =>
      result.current.start(codingPlanProvider, undefined, undefined, [
        `${RETIRED_ID}-latest`,
      ]),
    );
    const baseUrls = codingPlanProvider.baseUrl;
    if (Array.isArray(baseUrls)) {
      const firstUrl = baseUrls[0]!.url;
      act(() => result.current.selectBaseUrl(firstUrl));
    }
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    expect(result.current.state.step).toBe('models');
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in into the custom input ahead of the twin;
    // the step reports the raw segment owning the caret...
    act(() =>
      result.current.changeModelIds(
        [...BUILT_IN_IDS, `${RETIRED_ID}-latest`].join(', '),
        {
          customModelIds: [RETIRED_ID, `${RETIRED_ID}-latest`],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // ...and the lookup resolves over the keystroke: shield and freeze.
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // The user deletes the shielded token; the twin slides into the first
    // custom segment and the caret report follows it there.
    act(() =>
      result.current.changeModelIds(
        [...SERVED_IDS, `${RETIRED_ID}-latest`].join(', '),
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline. The second endpoint serves
    // the whole built-in list, so only the baseline can resurrect the
    // deleted id.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).not.toContain(
      RETIRED_ID,
    );
  });

  it('keeps a default whose frozen token grew behind a leading empty segment', async () => {
    // R22-1, entrance A, other direction. The buffer led with an empty
    // comma segment, so the caret's raw segment index was 1 while the
    // normalized customs array held a single entry; the exemption read
    // customs[1] === undefined at commit and dropped a default the user
    // never unchecked from the baseline.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // The caret sits after a bare leading comma: the step reports the id
    // with its raw segment index 1, and the normalized customs with 0.
    act(() =>
      result.current.changeModelIds(BUILT_IN_IDS.join(', '), {
        customModelIds: [RETIRED_ID],
        activeCustomModelId: RETIRED_ID,
        activeCustomModelSegment: 1,
      }),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // The user keeps typing; the token grows past the default id.
    act(() =>
      result.current.changeModelIds(
        [...SERVED_IDS, `${RETIRED_ID}-latest`].join(', '),
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 1,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline; the second endpoint serves
    // the whole built-in list, so only the baseline can drop the default.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain(RETIRED_ID);
    expect(restored).toContain(`${RETIRED_ID}-latest`);
  });

  it('keeps shielding a token when the caret detours through an empty segment', async () => {
    // R22-1, entrance B. A pure caret move into an empty comma segment
    // reports an undefined id with a numeric segment; the focus-leave
    // clear keyed on the id alone dropped the edited-occurrence marker,
    // the latch could not re-arm when the caret came back, and a lookup
    // resolving in that window pruned the token being typed from under
    // the caret.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock.mockReturnValueOnce(
      new Promise<ModelDiscoveryResult>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in into the second raw segment — the buffer
    // leads with an empty one — and the edit owns that occurrence.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 1,
        },
      ),
    );
    // Arrow into the empty leading segment — a pure caret move: id
    // undefined, segment numeric...
    act(() => result.current.changeActiveCustomModelId(undefined, 0));
    // ...and back into the token being typed. The edit is still alive.
    act(() => result.current.changeActiveCustomModelId(RETIRED_ID, 1));

    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );
  });

  it('banks the deletion of a shielded token retyped as a fresh extension', async () => {
    // R22-1, round 24. The growth exemption inferred provenance from two set
    // snapshots — the customs at the freeze and the customs at the commit —
    // with no edit history in between. Deleting the shielded token and then
    // typing a fresh strict extension of it presents the same snapshot pair
    // as continuous growth, so the exemption fired and the committed
    // deletion never reached the baseline — the next pair change resurrected
    // the id the user had deleted.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in into the custom input; the lookup resolves
    // on that keystroke, and the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // The user deletes the shielded token entirely...
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', '),
        { customModelIds: [] },
      ),
    );
    // ...and types a fresh strict extension of it as a new token.
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds).join(', ')}, ${RETIRED_ID}-latest`,
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline. The second endpoint serves
    // the whole built-in list, so only the baseline can resurrect the
    // deleted id.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).not.toContain(RETIRED_ID);
    expect(restored).toContain(`${RETIRED_ID}-latest`);
  });

  it('banks the deletion of a shielded token retyped elsewhere before the delete', async () => {
    // R22-1, round 25 — the spatial mirror of round 24's temporal order
    // (delete first, retype after). The latch keyed growth evidence on
    // buffer membership: customs still holding a fresh strict extension of
    // the frozen id kept the freeze alive even when that extension was
    // typed into ANOTHER segment before the frozen token itself was
    // deleted. The deletion edit's customs still held the extension, the
    // freeze survived to commit, the exemption dropped the frozen id from
    // `removed`, and the next pair change resurrected the id the user had
    // deleted.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in; the lookup resolves on that keystroke,
    // and the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // The user retypes a fresh strict extension of it as a NEW segment —
    // the freeze must hold here, the frozen token itself is untouched...
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}-latest`,
        {
          customModelIds: [RETIRED_ID, `${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 1,
        },
      ),
    );
    // ...and THEN deletes the original shielded token. The surviving
    // segment slides into the first slot and the caret report follows it.
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', '),
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline. The second endpoint serves
    // the whole built-in list, so only the baseline can resurrect the
    // deleted id.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).not.toContain(RETIRED_ID);
    expect(restored).toContain(`${RETIRED_ID}-latest`);
  });

  it('keeps a frozen default banked when growth resumes after an unrelated edit', async () => {
    // The latch clears the freeze at the first edit whose customs hold
    // neither the frozen id nor a fresh extension of it — so an edit that
    // still holds the id itself must not clear it: unchecking a
    // recommendation between the freeze and the next keystroke syncs the
    // unchanged custom text, and dropping the freeze there would read the
    // resumed growth as a removal of a default the user never unchecked.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in; the lookup resolves on that keystroke,
    // and the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );
    expect(normalizeModelIds(result.current.state.modelIds)).toContain(
      RETIRED_ID,
    );

    // Before the token grows, the user unchecks a recommended model: the
    // step syncs the composed selection with the custom text unchanged.
    const unchecked = SERVED_IDS[0]!;
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== unchecked)
          .join(', '),
        {
          customModelIds: [RETIRED_ID],
          removedRecommendationId: unchecked,
        },
      ),
    );

    // Then the growth resumes: the token grows past the frozen id.
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', ')}, ${RETIRED_ID}-latest`,
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline; the second endpoint serves
    // the whole built-in list, so only the baseline can drop the default.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain(RETIRED_ID);
    expect(restored).toContain(`${RETIRED_ID}-latest`);
  });

  it('keeps a frozen default banked when an unrelated edit follows growth', async () => {
    // The mirror order of the test above: growth first, then an unrelated
    // sync. Once the occurrence has grown, the frozen id itself is no
    // longer in the buffer, so keying the occurrence's survival on the
    // frozen id would clear the freeze on the sync and read the resumed
    // growth as a removal of a default the user never unchecked.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in; the lookup resolves on that keystroke,
    // and the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // The token grows past the frozen id first...
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', ')}, ${RETIRED_ID}-latest`,
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          activeCustomModelId: `${RETIRED_ID}-latest`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // ...then the user unchecks a recommended model: the step syncs the
    // composed selection with the custom text unchanged.
    const unchecked = SERVED_IDS[0]!;
    act(() =>
      result.current.changeModelIds(
        normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== unchecked)
          .join(', '),
        {
          customModelIds: [`${RETIRED_ID}-latest`],
          removedRecommendationId: unchecked,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline; the second endpoint serves
    // the whole built-in list, so only the baseline can drop the default.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain(RETIRED_ID);
    expect(restored).toContain(`${RETIRED_ID}-latest`);
  });

  it('keeps a frozen default banked when a typo correction shrinks the token back to it', async () => {
    // Growth is not monotone: correcting a typo backspaces the grown token
    // to exactly the frozen id before typing on. The shrunk value is the
    // frozen occurrence itself, not a twin — treating the return to the
    // frozen id as no-growth cleared the freeze, and the resumed growth
    // then read as a removal of a default the user never unchecked.
    let resolveLookup!: (value: ModelDiscoveryResult) => void;
    fetchProviderModelIdsMock
      .mockReturnValueOnce(
        new Promise<ModelDiscoveryResult>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValueOnce(discovered(BUILT_IN_IDS));

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    await advanceToModelStep(result);
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('loading'),
    );

    // Type the unserved built-in; the lookup resolves on that keystroke,
    // and the keep clause shields and freezes the token.
    act(() =>
      result.current.changeModelIds(
        `${result.current.state.modelIds}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    await act(async () => {
      resolveLookup(discovered(SERVED_IDS));
    });
    await waitFor(() =>
      expect(result.current.state.discoveryStatus).toBe('success'),
    );

    // Grow the token one character too far...
    const typed = `${RETIRED_ID}-latest`;
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', ')}, ${typed}x`,
        {
          customModelIds: [`${typed}x`],
          activeCustomModelId: `${typed}x`,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // ...backspace it to exactly the frozen id...
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== `${typed}x`)
          .join(', ')}, ${RETIRED_ID}`,
        {
          customModelIds: [RETIRED_ID],
          activeCustomModelId: RETIRED_ID,
          activeCustomModelSegment: 0,
        },
      ),
    );
    // ...and type on to the intended id.
    act(() =>
      result.current.changeModelIds(
        `${normalizeModelIds(result.current.state.modelIds)
          .filter((id) => id !== RETIRED_ID)
          .join(', ')}, ${typed}`,
        {
          customModelIds: [typed],
          activeCustomModelId: typed,
          activeCustomModelSegment: 0,
        },
      ),
    );
    act(() => {
      result.current.goBack();
    });

    // A pair change restores from the baseline; the second endpoint serves
    // the whole built-in list, so only the baseline can drop the default.
    act(() => {
      result.current.goBack();
    });
    act(() => result.current.selectBaseUrl(CODING_PLAN_GLOBAL_BASE_URL));
    await act(async () => {
      result.current.submitApiKey('sk-sp-test-key');
    });
    await waitFor(() => expect(result.current.state.step).toBe('models'));
    await waitFor(() =>
      expect(fetchProviderModelIdsMock).toHaveBeenCalledTimes(2),
    );

    const restored = normalizeModelIds(result.current.state.modelIds);
    expect(restored).toContain(RETIRED_ID);
    expect(restored).toContain(typed);
  });
});
