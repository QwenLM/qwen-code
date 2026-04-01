/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildRelevantAutoMemoryPrompt,
  selectRelevantAutoMemoryDocuments,
} from './recall.js';
import type { ScannedAutoMemoryDocument } from './scan.js';

const docs: ScannedAutoMemoryDocument[] = [
  {
    type: 'reference',
    filePath: '/tmp/reference.md',
    title: 'Reference Memory',
    description: 'Dashboards and external docs',
    body: '# Reference Memory\n\n- Grafana dashboard: grafana.internal/d/api-latency',
  },
  {
    type: 'project',
    filePath: '/tmp/project.md',
    title: 'Project Memory',
    description: 'Project constraints and release context',
    body: '# Project Memory\n\n- Release freeze starts Friday.',
  },
  {
    type: 'user',
    filePath: '/tmp/user.md',
    title: 'User Memory',
    description: 'User preferences',
    body: '# User Memory\n\n- User prefers terse responses.',
  },
];

describe('auto-memory relevant recall', () => {
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

    expect(prompt).toContain('## Relevant Managed Auto-Memory');
    expect(prompt).toContain('Reference Memory (reference.md)');
    expect(prompt).toContain('User Memory (user.md)');
  });
});