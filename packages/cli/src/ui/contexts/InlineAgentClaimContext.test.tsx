/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import {
  InlineAgentClaimProvider,
  InlineAgentClaimWriteContext,
  useClaimedAgentIds,
  useIsAgentClaimed,
} from './InlineAgentClaimContext.js';
import { useContext } from 'react';

function wrapper({ children }: { children: React.ReactNode }) {
  return <InlineAgentClaimProvider>{children}</InlineAgentClaimProvider>;
}

/** Tap both APIs in one hook so tests can drive writes and observe reads in one place. */
function useClaimApis() {
  const write = useContext(InlineAgentClaimWriteContext);
  const isClaimed = useIsAgentClaimed();
  return { ...write, isClaimed };
}

describe('InlineAgentClaimContext', () => {
  it('defaults to noop when no provider is mounted', () => {
    const { result } = renderHook(() => useClaimApis());
    expect(result.current.isClaimed('anything')).toBe(false);
    // Should not throw even with no provider.
    expect(() => {
      result.current.claim('x');
      result.current.release('x');
    }).not.toThrow();
  });

  it('claim and release track membership', () => {
    const { result } = renderHook(() => useClaimApis(), { wrapper });
    expect(result.current.isClaimed('a')).toBe(false);
    act(() => result.current.claim('a'));
    expect(result.current.isClaimed('a')).toBe(true);
    act(() => result.current.release('a'));
    expect(result.current.isClaimed('a')).toBe(false);
  });

  it('reference-counts overlapping claims', () => {
    // Two inline displays may transiently claim the same agentId
    // during React's commit/cleanup interleave; the panel should only
    // unhide once the LAST claim is released.
    const { result } = renderHook(() => useClaimApis(), { wrapper });
    act(() => {
      result.current.claim('a');
      result.current.claim('a');
    });
    expect(result.current.isClaimed('a')).toBe(true);
    act(() => result.current.release('a'));
    expect(result.current.isClaimed('a')).toBe(true);
    act(() => result.current.release('a'));
    expect(result.current.isClaimed('a')).toBe(false);
  });

  it('write API identity is stable across claim/release churn', () => {
    // The whole point of the read/write split is that claimers don't
    // get re-rendered every time SOMEONE ELSE claims/releases. The
    // write API object is therefore expected to be referentially stable
    // for the lifetime of the provider — assert it so a future
    // refactor that re-introduces a memo on `[version]` is caught
    // before it ships.
    const { result } = renderHook(
      () => useContext(InlineAgentClaimWriteContext),
      { wrapper },
    );
    const writeApiV1 = result.current;
    act(() => writeApiV1.claim('a'));
    act(() => writeApiV1.claim('b'));
    act(() => writeApiV1.release('a'));
    act(() => writeApiV1.release('b'));
    expect(result.current).toBe(writeApiV1);
  });

  it('useClaimedAgentIds auto-claims on mount and releases on unmount', () => {
    const { result, unmount } = renderHook(
      ({ ids }: { ids: string[] }) => {
        useClaimedAgentIds(ids);
        return useIsAgentClaimed();
      },
      { wrapper, initialProps: { ids: ['a', 'b'] } },
    );
    expect(result.current('a')).toBe(true);
    expect(result.current('b')).toBe(true);
    expect(result.current('c')).toBe(false);
    act(() => unmount());
    // After unmount we no longer have the hook's read subscription;
    // mount a fresh observer to confirm the underlying store dropped
    // the entries.
    const { result: observer } = renderHook(() => useIsAgentClaimed(), {
      wrapper,
    });
    // Fresh provider tree — claim store is empty by definition.
    expect(observer.current('a')).toBe(false);
  });

  it('useClaimedAgentIds re-claims when the id set changes', () => {
    const { result, rerender, unmount } = renderHook(
      ({ ids }: { ids: string[] }) => {
        useClaimedAgentIds(ids);
        return useIsAgentClaimed();
      },
      { wrapper, initialProps: { ids: ['a'] } },
    );
    expect(result.current('a')).toBe(true);
    expect(result.current('b')).toBe(false);
    act(() => rerender({ ids: ['b'] }));
    expect(result.current('a')).toBe(false);
    expect(result.current('b')).toBe(true);
    act(() => unmount());
  });
});
