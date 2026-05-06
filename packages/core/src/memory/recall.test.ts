/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRelevantAutoMemoryPrompt,
  resolveRelevantAutoMemoryPromptForQuery,
  selectRelevantAutoMemoryDocuments,
} from './recall.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import type { Config } from '../config/config.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

vi.mock('./relevanceSelector.js', () => ({
  selectRelevantAutoMemoryDocumentsByModel: vi.fn(),
}));

const docs: ScannedAutoMemoryDocument[] = [
  {
    type: 'reference',
    filePath: '/tmp/reference.md',
    relativePath: 'reference.md',
    filename: 'reference.md',
    title: 'Reference Memory',
    description: 'Dashboards and external docs',
    body: '# Reference Memory\n\n- Grafana dashboard: grafana.internal/d/api-latency',
    mtimeMs: 3,
  },
  {
    type: 'project',
    filePath: '/tmp/project.md',
    relativePath: 'project.md',
    filename: 'project.md',
    title: 'Project Memory',
    description: 'Project constraints and release context',
    body: '# Project Memory\n\n- Release freeze starts Friday.',
    mtimeMs: 2,
  },
  {
    type: 'user',
    filePath: '/tmp/user.md',
    relativePath: 'user.md',
    filename: 'user.md',
    title: 'User Memory',
    description: 'User preferences',
    body: '# User Memory\n\n- User prefers terse responses.',
    mtimeMs: 1,
  },
];

describe('auto-memory relevant recall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects the most relevant documents for a query', () => {
    const selected = selectRelevantAutoMemoryDocuments(
      'check the dashboard reference for latency',
      docs,
    );

    expect(selected[0]?.type).toBe('reference');
    expect(selected.map((doc) => doc.type)).toContain('reference');
  });

  it('returns an empty list for an empty query', () => {
    expect(selectRelevantAutoMemoryDocuments('   ', docs)).toEqual([]);
  });

  it('formats selected documents as a prompt block', () => {
    const prompt = buildRelevantAutoMemoryPrompt([docs[0], docs[2]]);

    expect(prompt).toContain('## Relevant memory');
    expect(prompt).toContain('Reference Memory (reference.md)');
    expect(prompt).toContain('User Memory (user.md)');
  });

  it('uses model-driven selection when config is provided', async () => {
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([
      docs[0],
    ]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the dashboard reference for latency',
      {
        config: {} as Config,
      },
    );

    expect(result.strategy).toBe('model');
    expect(result.selectedDocs).toEqual([docs[0]]);
    expect(result.prompt).toContain('Reference Memory (reference.md)');
  });

  it('falls back to heuristic selection when model-driven selection fails', async () => {
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockRejectedValue(
      new Error('selector failed'),
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the dashboard reference for latency',
      {
        config: {} as Config,
        excludedFilePaths: ['/tmp/user.md'],
      },
    );

    expect(result.strategy).toBe('heuristic');
    expect(result.selectedDocs.map((doc) => doc.filePath)).toContain(
      '/tmp/reference.md',
    );
    expect(result.selectedDocs.map((doc) => doc.filePath)).not.toContain(
      '/tmp/user.md',
    );
  });
});
