/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { ConfigContext } from '../contexts/ConfigContext.js';
import {
  fetchGitDiff,
  fetchGitDiffHunks,
} from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import { useDiffData } from './useDiffData.js';

vi.mock('@qwen-code/qwen-code-core/utils/gitDiff.js', () => ({
  fetchGitDiff: vi.fn(),
  fetchGitDiffHunks: vi.fn(),
}));

describe('useDiffData sandbox', () => {
  it('does not spawn host Git when a diff dialog is mounted directly', async () => {
    const config = {
      getShellExecutionSandbox: () => ({ network: 'closed' }),
    } as unknown as Config;
    const wrapper = ({ children }: PropsWithChildren) => (
      <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
    );
    const { result } = renderHook(() => useDiffData('/workspace'), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchGitDiff).not.toHaveBeenCalled();
    expect(fetchGitDiffHunks).not.toHaveBeenCalled();
  });
});
