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
  useInlineAgentClaim,
  useClaimedAgentIds,
} from './InlineAgentClaimContext.js';

function wrapper({ children }: { children: React.ReactNode }) {
  return <InlineAgentClaimProvider>{children}</InlineAgentClaimProvider>;
}

describe('InlineAgentClaimContext', () => {
  it('defaults to noop when no provider is mounted', () => {
    const { result } = renderHook(() => useInlineAgentClaim());
    expect(result.current.isClaimed('anything')).toBe(false);
    // Should not throw even with no provider.
    expect(() => {
      result.current.claim('x');
      result.current.release('x');
    }).not.toThrow();
  });

  it('claim and release track membership', () => {
    const { result } = renderHook(() => useInlineAgentClaim(), { wrapper });
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
    const { result } = renderHook(() => useInlineAgentClaim(), { wrapper });
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

  it('useClaimedAgentIds auto-claims on mount and releases on unmount', () => {
    const { result, unmount } = renderHook(
      ({ ids }: { ids: string[] }) => {
        useClaimedAgentIds(ids);
        return useInlineAgentClaim();
      },
      { wrapper, initialProps: { ids: ['a', 'b'] } },
    );
    expect(result.current.isClaimed('a')).toBe(true);
    expect(result.current.isClaimed('b')).toBe(true);
    expect(result.current.isClaimed('c')).toBe(false);
    act(() => unmount());
    expect(result.current.isClaimed('a')).toBe(false);
    expect(result.current.isClaimed('b')).toBe(false);
  });

  it('useClaimedAgentIds re-claims when the id set changes', () => {
    const { result, rerender, unmount } = renderHook(
      ({ ids }: { ids: string[] }) => {
        useClaimedAgentIds(ids);
        return useInlineAgentClaim();
      },
      { wrapper, initialProps: { ids: ['a'] } },
    );
    expect(result.current.isClaimed('a')).toBe(true);
    expect(result.current.isClaimed('b')).toBe(false);
    act(() => rerender({ ids: ['b'] }));
    expect(result.current.isClaimed('a')).toBe(false);
    expect(result.current.isClaimed('b')).toBe(true);
    act(() => unmount());
    expect(result.current.isClaimed('b')).toBe(false);
  });
});
