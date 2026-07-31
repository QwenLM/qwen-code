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
    // Explicit mock — recall now unions user-level docs into the pool, so
    // leaving this on the real implementation would silently fall through
    // to the filesystem (only "works" because the path doesn't exist and
    // listMarkdownFiles swallows ENOENT). Defaults to an empty pool.
    scanUserAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
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

const activeToolDocs: ScannedAutoMemoryDocument[] = [
  {
    type: 'reference',
    filePath: '/tmp/ata-tool.md',
    relativePath: 'ata-tool.md',
    filename: 'ata-tool.md',
    title: 'ATA tool schema notes',
    description:
      'article-list-query parameter schema and failed tool-call attempts',
    body: '# ATA tool schema notes\n\n- ata::article-list-query failed with guessed field mappings.',
    mtimeMs: 4,
  },
  {
    type: 'reference',
    filePath: '/tmp/ata-gotcha.md',
    relativePath: 'ata-gotcha.md',
    filename: 'ata-gotcha.md',
    title: 'ATA tool gotcha',
    description: 'article-list-query known workaround for transient failures',
    body: '# ATA tool gotcha\n\n- mcp__ata__article-list-query can return systemError during index rotation; retry after checking the ATA oncall note.',
    mtimeMs: 6,
  },
  {
    type: 'reference',
    filePath: '/tmp/ata-owner.md',
    relativePath: 'ata-owner.md',
    filename: 'ata-owner.md',
    title: 'ATA escalation',
    description: 'ATA service owner and escalation path',
    body: '# ATA escalation\n\n- Ask the ATA oncall when the service returns systemError.',
    mtimeMs: 5,
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

  it('keeps active tool schemas out of heuristic fallback', async () => {
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue(activeToolDocs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockRejectedValue(
      new Error('selector failed'),
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'read the ATA article with article-list-query',
      {
        config: {} as Config,
        recentTools: ['mcp__ata__article-list-query'],
      },
    );

    expect(result.strategy).toBe('heuristic');
    expect(result.selectedDocs.map((doc) => doc.filePath)).not.toContain(
      '/tmp/ata-tool.md',
    );
    expect(result.selectedDocs.map((doc) => doc.filePath)).toContain(
      '/tmp/ata-gotcha.md',
    );
    expect(result.selectedDocs.map((doc) => doc.filePath)).toContain(
      '/tmp/ata-owner.md',
    );
  });
});
