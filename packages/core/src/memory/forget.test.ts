/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { selectManagedAutoMemoryForgetCandidates } from './forget.js';

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: vi.fn(),
}));

vi.mock('./scan.js', () => ({
  scanAutoMemoryTopicDocuments: vi.fn(),
}));

describe('selectManagedAutoMemoryForgetCandidates', () => {
  const mockConfig = {
    getModel: vi.fn().mockReturnValue('main-model'),
    getFastModel: vi.fn().mockReturnValue('fast-model'),
  } as unknown as Config;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(mockConfig.getModel).mockReturnValue('main-model');
    vi.mocked(mockConfig.getFastModel).mockReturnValue('fast-model');
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue([
      {
        type: 'user',
        filePath: '/tmp/auto/user/note.md',
        relativePath: 'user/note.md',
        filename: 'note.md',
        title: 'Note',
        description: 'A note',
        body: '- summary: prefers tabs over spaces\n  why: legacy code uses tabs\n  howToApply: respect tabs in this repo',
        mtimeMs: 1,
      },
    ]);
  });

  it('pins the destructive selector to the main model, not the fast model', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selectedCandidateIds: [],
    });

    await selectManagedAutoMemoryForgetCandidates(
      '/tmp/project',
      'forget tabs preference',
      { config: mockConfig },
    );

    expect(runSideQuery).toHaveBeenCalledTimes(1);
    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        purpose: 'auto-memory-forget-selection',
        // /forget acts on the result without confirmation, so the selection
        // must run on the main model — never silently fall through to the
        // runSideQuery fast-model default.
        model: 'main-model',
      }),
    );
  });
});
