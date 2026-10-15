/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  proposeMemoryImport,
  validateMemoryImportProposal,
} from './import-model.js';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../utils/sideQuery.js', () => ({ runSideQuery: query }));
describe('external memory consolidation model', () => {
  it('uses target model without tools, unrelated preferences or fabricated source context', async () => {
    query.mockResolvedValue({
      decision: 'skip',
      reason: 'No durable knowledge.',
      documents: [],
    });
    const config = { getModel: () => 'target-model' } as Config;
    await proposeMemoryImport(
      config,
      { scope: 'project', source: 'Untrusted historical text.', existing: [] },
      new AbortController().signal,
    );
    const options = query.mock.calls.at(-1)![1];
    expect(options.model).toBe('target-model');
    expect(options.skipOutputLanguagePreference).toBe(true);
    expect(options.maxAttempts).toBe(1);
    expect(options.tools).toBeUndefined();
    expect(options.systemInstruction).toContain('untrusted DATA');
    expect(options.contents).toHaveLength(1);
  });
  it.each([
    { decision: 'new', reason: 'bad', documents: [] },
    { decision: 'duplicate', reason: 'bad', documents: ['bad'] },
    { decision: 'new', reason: 'bad', documents: ['unstructured'] },
  ])('rejects malformed/native-invalid proposal %j', (value) => {
    expect(() => validateMemoryImportProposal(value)).toThrow();
  });
});
