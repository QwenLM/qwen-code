/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildPullRequestQuery,
  classifyChange,
  createOpenAiCompleter,
  enrichEntries,
  generateAiContent,
  generateReleaseNotes,
  parseGeneratedEntries,
  renderReleaseNotes,
  validateHighlights,
  validateSummaryBatch,
} from '../generate-release-notes.js';

const PR = (number) => `https://github.com/QwenLM/qwen-code/pull/${number}`;

const entry = (number, title, labels = []) => ({
  number,
  title,
  url: PR(number),
  author: 'alice',
  labels,
  body: '',
  files: [],
  additions: 1,
  deletions: 0,
  changedFiles: 1,
});

describe('parseGeneratedEntries', () => {
  it('extracts the authoritative PR list from GitHub generated notes', () => {
    const body = [
      "## What's Changed",
      `* feat(cli): add session search by @alice in ${PR(12)}`,
      `* fix(core): preserve tool results by @bob in ${PR(8)}`,
      '',
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1...v2',
    ].join('\n');

    expect(parseGeneratedEntries(body)).toEqual([
      {
        number: 12,
        title: 'feat(cli): add session search',
        url: PR(12),
        author: 'alice',
      },
      {
        number: 8,
        title: 'fix(core): preserve tool results',
        url: PR(8),
        author: 'bob',
      },
    ]);
  });

  it('keeps entries that credit an additional collaborator', () => {
    const body = `* fix(ci): retry publishing by @alice with @Copilot in ${PR(6574)}`;

    expect(parseGeneratedEntries(body)).toEqual([
      {
        number: 6574,
        title: 'fix(ci): retry publishing',
        url: PR(6574),
        author: 'alice',
      },
    ]);
  });

  it('rejects a partially parsed GitHub PR list', () => {
    const body = [
      `* feat(cli): parsed by @alice in ${PR(1)}`,
      `* fix(core): changed format by @bob and @carol in ${PR(2)}`,
    ].join('\n');

    expect(() => parseGeneratedEntries(body)).toThrow(
      /Could not parse every pull request entry/,
    );
  });

  it('does not treat New Contributors bullets as change entries', () => {
    const body = [
      `* feat(cli): parsed by @alice in ${PR(1)}`,
      '',
      '## New Contributors',
      `* @alice made their first contribution in ${PR(1)}`,
    ].join('\n');

    expect(parseGeneratedEntries(body)).toHaveLength(1);
  });
});

describe('classifyChange', () => {
  it.each([
    ['feat(cli): add x', [], 'Features'],
    ['fix(core): repair x', [], 'Bug Fixes'],
    ['perf: speed up x', [], 'Performance'],
    ['docs: explain x', [], 'Documentation'],
    ['test(core): cover x', [], 'Internal Changes'],
  ])('classifies %s deterministically', (title, labels, expected) => {
    expect(classifyChange(entry(1, title, labels))).toBe(expected);
  });

  it('lets an explicit breaking-change label override the title category', () => {
    expect(
      classifyChange(
        entry(1, 'refactor(core): replace x', ['breaking-change']),
      ),
    ).toBe('Breaking Changes');
  });

  it.each([
    ['type/feature-request', 'Features'],
    ['type/bug', 'Bug Fixes'],
    ['performance', 'Performance'],
    ['documentation', 'Documentation'],
  ])('uses an explicit %s label for prefixless titles', (label, expected) => {
    expect(classifyChange(entry(1, 'A clearer change title', [label]))).toBe(
      expected,
    );
  });
});

describe('validateSummaryBatch', () => {
  it('returns summaries only when every requested PR appears exactly once', () => {
    const summaries = validateSummaryBatch(
      [entry(1, 'feat: a'), entry(2, 'fix: b')],
      {
        summaries: [
          { pr: 1, summary: 'Adds a user-visible capability.' },
          { pr: 2, summary: 'Prevents an existing failure.' },
        ],
      },
    );

    expect(summaries.get(1)).toBe('Adds a user-visible capability.');
    expect(summaries.get(2)).toBe('Prevents an existing failure.');
  });

  it.each([
    ['missing', { summaries: [{ pr: 1, summary: 'Only one.' }] }],
    [
      'unknown',
      {
        summaries: [
          { pr: 1, summary: 'Known.' },
          { pr: 3, summary: 'Unknown.' },
        ],
      },
    ],
    [
      'duplicate',
      {
        summaries: [
          { pr: 1, summary: 'First.' },
          { pr: 1, summary: 'Again.' },
        ],
      },
    ],
  ])('rejects a %s PR set', (_name, response) => {
    expect(() =>
      validateSummaryBatch([entry(1, 'feat: a'), entry(2, 'fix: b')], response),
    ).toThrow();
  });

  it('rejects multiline model text that could escape its Markdown list item', () => {
    expect(() =>
      validateSummaryBatch([entry(1, 'feat: a')], {
        summaries: [{ pr: 1, summary: 'Readable.\n## Injected heading' }],
      }),
    ).toThrow(/single line/);
  });

  it.each([
    '<details>hidden content</details>',
    '[misleading link](https://example.com)',
    'Visit https://example.com for details.',
  ])('rejects non-plain-text model output: %s', (summary) => {
    expect(() =>
      validateSummaryBatch([entry(1, 'feat: a')], {
        summaries: [{ pr: 1, summary }],
      }),
    ).toThrow(/plain text/);
  });

  it('enforces the prompted 180-character summary limit', () => {
    expect(() =>
      validateSummaryBatch([entry(1, 'feat: a')], {
        summaries: [{ pr: 1, summary: 'x'.repeat(181) }],
      }),
    ).toThrow(/180 characters/);
  });
});

describe('renderReleaseNotes', () => {
  it('renders highlights and every PR exactly once in the complete list', () => {
    const entries = [
      entry(1, 'feat(cli): add session search'),
      entry(2, 'fix(core): preserve tool results'),
      entry(3, 'docs: explain session search'),
    ];
    const summaries = new Map([
      [1, 'Adds session search to the CLI.'],
      [2, 'Preserves tool results when history is repaired.'],
      [3, 'Documents session search.'],
    ]);

    const markdown = renderReleaseNotes({
      entries,
      summaries,
      highlights: [
        {
          text: 'Session workflows are easier to find and recover.',
          prs: [1, 2],
        },
      ],
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(markdown).toContain('<!-- qwen-release-notes:v1 -->');
    expect(markdown).toContain('## Highlights');
    expect(markdown).toContain(
      'Session workflows are easier to find and recover. ([#1]',
    );
    expect(markdown).toContain('## Complete Change List');
    expect(markdown).toContain('### Features');
    expect(markdown).toContain('### Bug Fixes');
    expect(markdown).toContain('### Documentation');
    for (const number of [1, 2, 3]) {
      expect(markdown.match(new RegExp(`\\[#${number}\\]`, 'g'))).toHaveLength(
        number < 3 ? 2 : 1,
      );
    }
    expect(markdown).toContain(
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1.0.0...v1.1.0',
    );
  });
});

describe('validateHighlights', () => {
  it('accepts concise highlights that only reference known PRs', () => {
    expect(
      validateHighlights([entry(1, 'feat: a'), entry(2, 'fix: b')], {
        highlights: [{ text: 'A clearer workflow.', prs: [1, 2] }],
      }),
    ).toEqual([{ text: 'A clearer workflow.', prs: [1, 2] }]);
  });

  it('rejects references outside the authoritative PR set', () => {
    expect(() =>
      validateHighlights([entry(1, 'feat: a')], {
        highlights: [{ text: 'Invented change.', prs: [99] }],
      }),
    ).toThrow(/Unknown pull request/);
  });

  it('rejects overlong highlight text', () => {
    expect(() =>
      validateHighlights([entry(1, 'feat: a')], {
        highlights: [{ text: 'x'.repeat(181), prs: [1] }],
      }),
    ).toThrow(/180 characters/);
  });
});

describe('generateAiContent', () => {
  it('summarizes bounded batches and then generates highlights', async () => {
    const entries = [
      entry(1, 'feat(cli): add session search'),
      entry(2, 'fix(core): preserve tool results'),
      entry(3, 'docs: explain session search'),
    ];
    const calls = [];
    const complete = async (request) => {
      calls.push(request);
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: `User-facing summary for ${item.number}.`,
          })),
        });
      }
      return JSON.stringify({
        highlights: [{ text: 'Session workflows are clearer.', prs: [1, 2] }],
      });
    };

    const result = await generateAiContent(entries, complete, { batchSize: 2 });

    expect(calls.map((call) => call.kind)).toEqual([
      'summaries',
      'summaries',
      'highlights',
    ]);
    expect(result.summaries.get(3)).toBe('User-facing summary for 3.');
    expect(result.highlights).toEqual([
      { text: 'Session workflows are clearer.', prs: [1, 2] },
    ]);
  });

  it('falls back to original titles for an invalid summary batch', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return '{not-json';
      }
      return JSON.stringify({ highlights: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings).toHaveLength(1);
  });

  it('falls back only the summary whose text is unsafe', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) =>
      request.kind === 'summaries'
        ? JSON.stringify({
            summaries: [
              { pr: 1, summary: 'A safe summary.' },
              { pr: 2, summary: '<unsafe>summary</unsafe>' },
            ],
          })
        : JSON.stringify({ highlights: [] });

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'A safe summary.'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings).toEqual([
      'Summary fallback for #2: Summary for pull request 2 must be plain text without links or HTML.',
    ]);
  });

  it('drops invalid highlights without losing the complete list', async () => {
    const entries = [entry(1, 'feat: original')];
    const complete = async (request) =>
      request.kind === 'summaries'
        ? JSON.stringify({ summaries: [{ pr: 1, summary: 'Readable.' }] })
        : JSON.stringify({
            highlights: [{ text: 'Invented.', prs: [99] }],
          });

    const result = await generateAiContent(entries, complete);

    expect(result.summaries.get(1)).toBe('Readable.');
    expect(result.highlights).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('enrichEntries', () => {
  it('keeps authoritative order and fills metadata returned by GitHub', () => {
    const base = parseGeneratedEntries(
      `* feat: a by @alice in ${PR(2)}\n* fix: b by @bob in ${PR(1)}`,
    );
    const enriched = enrichEntries(base, [
      {
        number: 1,
        body: 'Why it matters.',
        labels: [{ name: 'type/bug' }],
        files: [{ path: 'packages/core/a.ts' }],
        additions: 3,
        deletions: 2,
        changedFiles: 1,
      },
    ]);

    expect(enriched.map((item) => item.number)).toEqual([2, 1]);
    expect(enriched[0].body).toBe('');
    expect(enriched[1].body).toBe('Why it matters.');
    expect(enriched[1].files).toEqual(['packages/core/a.ts']);
  });
});

describe('buildPullRequestQuery', () => {
  it('builds one aliased metadata lookup per authoritative PR number', () => {
    const query = buildPullRequestQuery([12, 8]);

    expect(query).toContain('pr0: pullRequest(number: 12)');
    expect(query).toContain('pr1: pullRequest(number: 8)');
    expect(query).toContain('files(first: 40)');
    expect(query).not.toContain('pullRequest(number: undefined)');
  });
});

describe('createOpenAiCompleter', () => {
  it('uses a tool-free JSON completion request', async () => {
    const requests = [];
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"summaries":[]}' } }],
          }),
        };
      },
    });

    await complete({ kind: 'summaries', entries: [] });

    expect(requests[0].url).toBe('https://model.example/v1/chat/completions');
    expect(requests[0].init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(requests[0].init.body);
    expect(body.model).toBe('qwen-test');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(4096);
    expect(body.tools).toBeUndefined();
    expect(requests[0].init.signal).toBeDefined();
  });
});

describe('generateReleaseNotes', () => {
  it('returns GitHub notes unchanged when there are no PR entries', async () => {
    const generatedBody =
      '**Full Changelog**: https://example.com/compare/a...b';
    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete: async () => {
        throw new Error('must not be called');
      },
      previousTag: 'v1.0.0',
      tag: 'v1.0.1',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toBe(generatedBody);
    expect(result.usedAi).toBe(false);
  });

  it('renders a complete categorized list without model configuration', async () => {
    const generatedBody = `* feat(cli): add search by @alice in ${PR(1)}`;
    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete: null,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('### Features');
    expect(result.markdown).toContain('feat(cli): add search');
    expect(result.usedAi).toBe(false);
    expect(result.warnings).toEqual(['Model configuration is unavailable.']);
  });
});
