/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ScannedAutoMemoryDocument } from './scan.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';

function doc(
  scope: ScannedAutoMemoryDocument['scope'],
  relativePath: string,
  keywords: string[],
  mtimeMs: number,
): ScannedAutoMemoryDocument {
  return {
    scope,
    type: 'project',
    filePath: `/tmp/${scope}/${relativePath}`,
    relativePath,
    filename: relativePath.split('/').at(-1) ?? relativePath,
    title: relativePath,
    description: '',
    category: 'uncategorized',
    keywords,
    usageScenarios: [],
    body: '',
    mtimeMs,
  };
}

describe('writer keyword vocabulary snapshot', () => {
  it('renders scope-isolated stable and recent keyword sections', () => {
    const snapshot = renderWriterKeywordVocabularySnapshot([
      doc('project', 'a.md', ['memory retrieval', 'testing policy'], 10),
      doc('project', 'b.md', ['Memory Retrieval', 'tree overview'], 20),
      doc('user', 'c.md', ['communication preference'], 30),
    ]);

    expect(snapshot).toContain('canonical retrieval terms or short phrases');
    expect(snapshot).toContain('project scope:');
    expect(snapshot).toContain('stable: memory retrieval (2)');
    expect(snapshot).toContain('recent: tree overview (1)');
    expect(snapshot).toContain('user scope:');
    expect(snapshot).toContain('communication preference (1)');
  });

  it('filters identifiers that should not become reusable vocabulary', () => {
    const snapshot = renderWriterKeywordVocabularySnapshot([
      doc(
        'project',
        'a.md',
        [
          'memory retrieval',
          'src/memory/scan.ts',
          'issue #4025',
          'QWEN_API_KEY',
          'parseAutoMemoryTopicDocument()',
          'https://example.com/docs',
        ],
        10,
      ),
    ]);

    expect(snapshot).toContain('memory retrieval (1)');
    expect(snapshot).not.toContain('src/memory/scan.ts');
    expect(snapshot).not.toContain('issue #4025');
    expect(snapshot).not.toContain('QWEN_API_KEY');
    expect(snapshot).not.toContain('parseAutoMemoryTopicDocument');
    expect(snapshot).not.toContain('https://example.com/docs');
  });

  it('uses document mtime recency for low-frequency ordering', () => {
    const snapshot = renderWriterKeywordVocabularySnapshot([
      doc('project', 'old.md', ['old topic'], 10),
      doc('project', 'new.md', ['new topic'], 50),
    ]);

    expect(snapshot.indexOf('new topic (1)')).toBeLessThan(
      snapshot.indexOf('old topic (1)'),
    );
  });

  it('does not render unrequested scopes', () => {
    const snapshot = renderWriterKeywordVocabularySnapshot(
      [
        doc('project', 'a.md', ['project topic'], 10),
        doc('user', 'b.md', ['user topic'], 20),
      ],
      { scopes: ['user'] },
    );

    expect(snapshot).not.toContain('project scope:');
    expect(snapshot).not.toContain('project topic');
    expect(snapshot).toContain('user scope:');
    expect(snapshot).toContain('user topic');
  });
});
