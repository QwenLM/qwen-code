/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appendDegradedStepSummary,
  buildPullRequestQuery,
  classifyChange,
  createOpenAiCompleter,
  enrichEntries,
  escapeWorkflowCommand,
  generateAiContent,
  generateReleaseNotes,
  parseGeneratedEntries,
  renderReleaseNotes,
  tryAppendDegradedStepSummary,
} from '../generate-release-notes.js';

const PR = (number) => `https://github.com/QwenLM/qwen-code/pull/${number}`;

const entry = (number, title, labels = []) => ({
  number,
  title,
  url: PR(number),
  author: 'alice',
  labels,
  body: '',
});

describe('parseGeneratedEntries', () => {
  it('extracts the authoritative PR list from GitHub generated notes', () => {
    const body = [
      "## What's Changed",
      `* feat(cli): add session search by @alice in ${PR(12)}`,
      `* fix(core): preserve tool results by @bob in ${PR(8)}`,
      `* fix(ci): retry publishing by @carol with @Copilot in ${PR(6574)}`,
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
      {
        number: 6574,
        title: 'fix(ci): retry publishing',
        url: PR(6574),
        author: 'carol',
        coAuthors: ['Copilot'],
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

  it('does not drop a PR bullet when GitHub omits the author phrase', () => {
    const body = [
      "## What's Changed",
      `* feat(cli): parsed by @alice in ${PR(1)}`,
      `* fix(core): changed format in ${PR(2)}`,
      '',
      '## New Contributors',
      `* @newbie made their first contribution in ${PR(2)}`,
    ].join('\n');

    expect(parseGeneratedEntries(body)).toEqual([
      {
        number: 1,
        title: 'feat(cli): parsed',
        url: PR(1),
        author: 'alice',
      },
      {
        number: 2,
        title: 'fix(core): changed format',
        url: PR(2),
        author: null,
      },
    ]);
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
    ['category/performance', 'Performance'],
    ['type/documentation', 'Documentation'],
    ['scope/documentation', 'Documentation'],
  ])('uses an explicit %s label for prefixless titles', (label, expected) => {
    expect(classifyChange(entry(1, 'A clearer change title', [label]))).toBe(
      expected,
    );
  });
});

describe('renderReleaseNotes', () => {
  it('renders highlights and every PR exactly once in the complete list', () => {
    const entries = [
      {
        ...entry(1, 'feat(cli): add session search'),
        coAuthors: ['Copilot'],
      },
      entry(2, 'fix(core): preserve tool results'),
      entry(3, 'docs: explain session search'),
      entry(4, 'refactor(core): remove legacy path', ['breaking-change']),
    ];
    const summaries = new Map([
      [1, 'Adds session search to the CLI.'],
      [2, 'Preserves tool results when history is repaired.'],
      [3, 'Documents session search.'],
      [4, 'Removes a legacy compatibility path.'],
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
    expect(markdown).toContain(
      `Adds session search to the CLI. ([#1](${PR(1)})) by @alice with @Copilot`,
    );
    for (const number of [1, 2, 3, 4]) {
      expect(markdown.match(new RegExp(`\\[#${number}\\]`, 'g'))).toHaveLength(
        number < 3 ? 2 : 1,
      );
    }
    expect(markdown).toContain(
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1.0.0...v1.1.0',
    );
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
        return `\`\`\`json\n${JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: `User-facing summary for ${item.number}.`,
          })),
        })}\n\`\`\``;
      }
      return `\`\`\`json\n${JSON.stringify({
        highlights: [{ text: 'Session workflows are clearer.', prs: [1, 2] }],
      })}\n\`\`\``;
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

  it('sends only title, a bounded body excerpt, and category to the model', async () => {
    const long = { ...entry(1, 'feat: long body'), body: 'x'.repeat(5000) };
    const calls = [];
    const complete = async (request) => {
      calls.push(request);
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: 'Summary.',
          })),
        });
      }
      return JSON.stringify({ highlights: [] });
    };

    await generateAiContent([long], complete);

    const [payload] = calls[0].entries;
    expect(Object.keys(payload).sort()).toEqual([
      'body',
      'category',
      'number',
      'title',
    ]);
    expect(payload.body).toHaveLength(700);
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

  it('falls back to original titles when the model omits a PR summary', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) =>
      request.kind === 'summaries'
        ? JSON.stringify({ summaries: [{ pr: 1, summary: 'Only one.' }] })
        : JSON.stringify({ highlights: [] });

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings[0]).toMatch(/missing pull request summaries/);
  });

  it('falls back only the summary whose text is unsafe', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) =>
      request.kind === 'summaries'
        ? JSON.stringify({
            summaries: [
              { pr: 1, summary: 'A safe summary.' },
              { pr: 2, summary: '@QwenLM/security should review this.' },
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

  it('rejects GFM autolinks and encoded mentions from model text', async () => {
    const entries = [
      entry(1, 'feat: original one'),
      entry(2, 'fix: original two'),
      entry(3, 'docs: original three'),
    ];
    const complete = async (request) =>
      request.kind === 'summaries'
        ? JSON.stringify({
            summaries: [
              { pr: 1, summary: 'Visit www.example.com for details.' },
              { pr: 2, summary: 'Contact security@example.com.' },
              { pr: 3, summary: 'Ping &#x40;octocat for details.' },
            ],
          })
        : JSON.stringify({ highlights: [] });

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original one'],
        [2, 'fix: original two'],
        [3, 'docs: original three'],
      ]),
    );
    expect(result.warnings).toHaveLength(3);
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
      },
    ]);

    expect(enriched.map((item) => item.number)).toEqual([2, 1]);
    expect(enriched[0].body).toBe('');
    expect(enriched[1].body).toBe('Why it matters.');
    expect(enriched[1].labels).toEqual([{ name: 'type/bug' }]);
  });
});

describe('buildPullRequestQuery', () => {
  it('builds one aliased metadata lookup per authoritative PR number', () => {
    const query = buildPullRequestQuery([12, 8]);

    expect(query).toContain('pr0: pullRequest(number: 12)');
    expect(query).toContain('pr1: pullRequest(number: 8)');
    expect(query).toContain('labels(first: 20)');
    expect(query).not.toContain('files(first: 40)');
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

  it('renders the complete fallback list and new contributor credits', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
      '',
      '## New Contributors',
      `* @newbie made their first contribution in ${PR(1)}`,
    ].join('\n');

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete: null,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('### Features');
    expect(result.markdown).toContain(
      `feat(cli): add search ([#1](${PR(1)})) by @alice`,
    );
    expect(result.markdown).toContain('## New Contributors');
    expect(result.markdown).toContain(
      `- @newbie made their first contribution in [#1](${PR(1)})`,
    );
    expect(result.usedAi).toBe(false);
    expect(result.warnings).toEqual(['Model configuration is unavailable.']);
  });

  it.skipIf(process.platform === 'win32')(
    'runs the CLI path with fake gh data and writes fallback notes',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-notes-cli-'));
      try {
        const gh = join(dir, 'gh');
        const output = join(dir, 'notes.md');
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(
          gh,
          [
            '#!/usr/bin/env node',
            'const args = process.argv.slice(2);',
            "if (args[0] === 'api' && args.includes('repos/QwenLM/qwen-code/releases/generate-notes')) {",
            "  process.stdout.write([\"## What's Changed\", '* feat: add cli path by @alice in https://github.com/QwenLM/qwen-code/pull/1'].join('\\n'));",
            '  process.exit(0);',
            '}',
            "if (args[0] === 'api' && args[1] === 'graphql') {",
            "  process.stdout.write(JSON.stringify({ data: { repository: { pr0: { number: 1, body: 'Body.', labels: { nodes: [] } } } } }));",
            '  process.exit(0);',
            '}',
            'process.exit(1);',
          ].join('\n'),
        );
        chmodSync(gh, 0o755);

        const cli = spawnSync(
          process.execPath,
          [
            'scripts/generate-release-notes.js',
            '--tag=v1.0.1',
            '--previous-tag=v1.0.0',
            `--output=${output}`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              GITHUB_STEP_SUMMARY: summaryPath,
              GITHUB_REPOSITORY: 'QwenLM/qwen-code',
              OPENAI_API_KEY: '',
              OPENAI_BASE_URL: '',
              OPENAI_MODEL: '',
            },
          },
        );

        expect(cli.status).toBe(0);
        expect(cli.stderr).toContain(
          '::warning::Model configuration is unavailable.',
        );
        expect(readFileSync(summaryPath, 'utf8')).toContain(
          'Release notes: AI generation degraded',
        );
        const markdown = readFileSync(output, 'utf8');
        expect(markdown).toContain('### Features');
        expect(markdown).toContain(
          `feat: add cli path ([#1](${PR(1)})) by @alice`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not duplicate ERROR prefixes for argument failures', () => {
    try {
      execFileSync(
        process.execPath,
        [
          'scripts/generate-release-notes.js',
          '--repo=bad repo',
          '--tag=v1.0.1',
          '--previous-tag=v1.0.0',
          '--dry-run',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      throw new Error('expected command to fail');
    } catch (error) {
      expect(error.stderr).toContain(
        'ERROR: Invalid repository "bad repo"; expected "owner/name".',
      );
      expect(error.stderr).not.toContain('ERROR: ERROR:');
    }
  });
});

describe('createOpenAiCompleter retries', () => {
  const okResponse = {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"summaries":[]}' } }],
    }),
  };

  it('retries a 500 once and then succeeds', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, status: 500 } : okResponse;
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).resolves.toBe(
      '{"summaries":[]}',
    );
    expect(calls).toBe(2);
  });

  it('retries a timeout before giving up after maxRetries', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'timed out',
    );
    expect(calls).toBe(3);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'HTTP 400',
    );
    expect(calls).toBe(1);
  });

  it('retries HTTP 429 (rate limiting)', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, status: 429 } : okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(calls).toBe(2);
  });

  it('retries network errors without HTTP status', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('fetch failed: ECONNRESET');
        }
        return okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(calls).toBe(2);
  });

  it('does not retry content-validation errors', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        // Returns 200 OK but empty content — triggers content-validation error
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '' } }] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'Model response did not contain message content.',
    );
    expect(calls).toBe(1);
  });

  it('preserves original error in deadline-expired message', async () => {
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        return { ok: false, status: 503 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 503/,
    );
  });

  it('preserves the original error as the deadline error cause', async () => {
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        return { ok: false, status: 503 };
      },
    });

    const error = await complete({ kind: 'summaries', entries: [] }).catch(
      (err) => err,
    );
    expect(error.message).toMatch(/budget exhausted.*HTTP 503/);
    expect(error.cause?.message).toBe('Model request failed with HTTP 503.');
  });

  it('preserves original error when the deadline expires after backoff', async () => {
    let now = 0;
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const timeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback) => {
        now = 1001;
        callback();
        return 0;
      });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 500/,
    );
    expect(calls).toBe(1);
    clock.mockRestore();
    random.mockRestore();
    timeout.mockRestore();
    errSpy.mockRestore();
  });

  it('logs a retry line when backing off', async () => {
    let calls = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response('\n::error::forged', { status: 200 })
          : okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    const retryLine = errSpy.mock.calls
      .map((args) => args[0])
      .find((line) => String(line).startsWith('Model request retry '));
    expect(retryLine).toBeDefined();
    expect(retryLine).not.toContain('\n');
    expect(retryLine).toContain('%0A::error::forged');
    errSpy.mockRestore();
  });

  it('stops retrying before the shared time budget expires', async () => {
    let calls = 0;
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 500/,
    );
    expect(calls).toBe(1);
    expect(timeout).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it('caps each request at the remaining shared time budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      timeoutMs: 10_000,
      totalTimeoutMs: 1_000,
      fetchImpl: async () => okResponse,
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(1_000);
    timeout.mockRestore();
  });

  it('shares the time budget across calls', async () => {
    let now = 0;
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        calls += 1;
        return okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    now = 51;
    await expect(complete({ kind: 'highlights', entries: [] })).rejects.toThrow(
      'Model generation time budget exhausted: unknown error',
    );
    expect(calls).toBe(1);
    clock.mockRestore();
  });
});

describe('generateAiContent circuit breaker', () => {
  it('stops calling the model after consecutive batch failures', async () => {
    const calls = [];
    const failing = async (request) => {
      calls.push(request.kind);
      throw new Error('model down');
    };
    const entries = [
      entry(1, 'one'),
      entry(2, 'two'),
      entry(3, 'three'),
      entry(4, 'four'),
      entry(5, 'five'),
    ];

    const result = await generateAiContent(entries, failing, { batchSize: 1 });

    // 3 batch attempts, then the breaker opens: no more batch calls and no
    // highlights call at all.
    expect(calls).toEqual(['summaries', 'summaries', 'summaries']);
    expect([...result.summaries.values()]).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(
      result.warnings.some((warning) =>
        warning.includes('stopped after 3 consecutive failures'),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes('Highlights fallback: skipped'),
      ),
    ).toBe(true);
  });

  it('recovers without the breaker when a later batch succeeds', async () => {
    const calls = [];
    let summaryCalls = 0;
    const flaky = async (request) => {
      calls.push(request.kind);
      if (request.kind === 'summaries') {
        summaryCalls += 1;
        if (summaryCalls !== 3) throw new Error('transient');
        return JSON.stringify({
          summaries: request.entries.map((entry) => ({
            pr: entry.number,
            summary: `${entry.title} summary`,
          })),
        });
      }
      return JSON.stringify({ highlights: [] });
    };
    const entries = [1, 2, 3, 4, 5].map((number) =>
      entry(number, String(number)),
    );

    const result = await generateAiContent(entries, flaky, { batchSize: 1 });

    expect(calls).toEqual([
      'summaries',
      'summaries',
      'summaries',
      'summaries',
      'summaries',
      'highlights',
    ]);
    expect(
      result.warnings.some((warning) => warning.includes('stopped after')),
    ).toBe(false);
    expect(result.summaries.get(3)).toBe('3 summary');
  });
});

describe('appendDegradedStepSummary', () => {
  it('appends a degraded note when warnings exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    // test-setup mocks appendFileSync, so assert on the call instead of the file.
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary(
      { usedAi: false, warnings: ['Summary batch fallback: HTTP 500'] },
      summaryPath,
    );

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    const [writtenPath, written] = vi.mocked(appendFileSync).mock.calls[0];
    expect(writtenPath).toBe(summaryPath);
    expect(written).toContain('AI generation degraded');
    expect(written).toContain('Summary batch fallback: HTTP 500');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing without warnings', async () => {
    const fs = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary({ usedAi: true, warnings: [] }, summaryPath);
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();
    expect(fs.existsSync(summaryPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not propagate summary write failures (tryAppend)', () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      tryAppendDegradedStepSummary(
        { usedAi: false, warnings: ['Summary batch fallback: HTTP 500'] },
        join(tmpdir(), 'summary.md'),
      ),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to write the degraded step summary'),
    );
    errSpy.mockRestore();
  });
});

describe('escapeWorkflowCommand', () => {
  it('percent-encodes newlines so model text cannot forge a runner command', () => {
    const malicious = 'batch failed\n::error::forged annotation';
    const escaped = escapeWorkflowCommand(malicious);
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\r');
    expect(escaped).toBe('batch failed%0A::error::forged annotation');
  });

  it('encodes percent signs so encoded sequences are not double-decoded', () => {
    expect(escapeWorkflowCommand('100% done')).toBe('100%25 done');
  });

  it('encodes carriage returns', () => {
    expect(escapeWorkflowCommand('a\rb')).toBe('a%0Db');
  });
});

describe('appendDegradedStepSummary markdown hardening', () => {
  it('renders warnings as escaped single-line code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary(
      {
        usedAi: true,
        warnings: ['line1\n![x](https://evil.example/x.png) ```tick``` <b>&'],
      },
      summaryPath,
    );
    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    expect(written).toContain(
      'AI generation was partially degraded; see the warnings on this run.',
    );
    expect(written).toContain(
      '- ```` line1 ![x](https://evil.example/x.png) ```tick``` <b>& ````',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('escapes the failed-summary warning through tryAppend', () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tryAppendDegradedStepSummary(
      { usedAi: false, warnings: ['degraded'] },
      join(tmpdir(), 'summary.md'),
    );
    const emitted = errSpy.mock.calls[0][0];
    expect(emitted).toMatch(/^::warning::/);
    expect(emitted).not.toContain('\n');
    errSpy.mockRestore();
  });
});
