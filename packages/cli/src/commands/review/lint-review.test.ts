/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Unit tests for the local lint that gates `gh api .../pulls/<n>/reviews`
// submissions. Each test exercises `lintReview` directly with a fixture
// payload — the integration of the CLI command (file read + throw on
// failure) is covered by a single smoke case below.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { lintReview, lintReviewCommand } from './lint-review.js';
import { _resetProjectRootCache } from './lib/paths.js';

const FOOTER = ' _— gpt-x via Qwen Code /review_';

function comment(
  overrides: Partial<{ path: string; line: number; body: string }> = {},
) {
  return {
    path: 'src/foo.ts',
    line: 42,
    body: `**[Critical]** real finding${FOOTER}`,
    ...overrides,
  };
}

describe('lintReview', () => {
  it('passes a well-formed APPROVE review with no findings', () => {
    expect(
      lintReview({
        commit_id: 'a'.repeat(40),
        event: 'APPROVE',
        body: `No issues found. LGTM!${FOOTER}`,
        comments: [],
      }),
    ).toEqual([]);
  });

  it('passes a well-formed REQUEST_CHANGES review with inline comments', () => {
    expect(
      lintReview({
        commit_id: 'a'.repeat(40),
        event: 'REQUEST_CHANGES',
        body: '',
        comments: [comment(), comment({ line: 99 })],
      }),
    ).toEqual([]);
  });

  it('rejects the observed "Test single comment submission" body pattern', () => {
    // This is the exact placeholder body deepseek-v4-flash POSTed on PR
    // #4438 (2026-05-23 07:17–07:18) as four separate Reviews while
    // dry-running the API shape. The lint must catch this so future
    // POSTs of the same shape never reach the network.
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'COMMENT',
      body: 'Test single comment submission',
      comments: [],
    });
    expect(problems.some((p) => p.includes('placeholder'))).toBe(true);
  });

  it('rejects body starting with "test" (case-insensitive)', () => {
    for (const b of ['test', 'Test', 'TESTING', 'test batch 1', '  test  ']) {
      const problems = lintReview({
        commit_id: 'a'.repeat(40),
        event: 'COMMENT',
        body: b,
        comments: [],
      });
      expect(problems.some((p) => p.includes('placeholder'))).toBe(true);
    }
  });

  it('rejects unknown event values', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'PENDING',
      body: 'Something',
      comments: [],
    });
    expect(problems.some((p) => p.includes('event must be one of'))).toBe(
      true,
    );
  });

  it('rejects missing / short commit_id', () => {
    expect(
      lintReview({
        event: 'APPROVE',
        body: `LGTM!${FOOTER}`,
        comments: [],
      }).some((p) => p.includes('commit_id')),
    ).toBe(true);
    expect(
      lintReview({
        commit_id: 'short',
        event: 'APPROVE',
        body: `LGTM!${FOOTER}`,
        comments: [],
      }).some((p) => p.includes('commit_id')),
    ).toBe(true);
  });

  it('rejects empty review (no body, no comments)', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'APPROVE',
      body: '',
      comments: [],
    });
    expect(problems.some((p) => p.includes('nothing to submit'))).toBe(true);
  });

  it('rejects suspiciously short body when there are no inline comments', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'APPROVE',
      body: 'LGTM',
      comments: [],
    });
    expect(problems.some((p) => p.includes('placeholder'))).toBe(true);
  });

  it('rejects inline comment missing the Qwen Code footer', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'COMMENT',
      body: '',
      comments: [
        {
          path: 'src/foo.ts',
          line: 1,
          body: '**[Suggestion]** plain text with no footer',
        },
      ],
    });
    expect(
      problems.some((p) => p.includes('missing required footer')),
    ).toBe(true);
  });

  it('rejects inline comment with placeholder body', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'COMMENT',
      body: '',
      comments: [comment({ body: `test 1${FOOTER}` })],
    });
    expect(problems.some((p) => p.includes('placeholder'))).toBe(true);
  });

  it('rejects malformed inline comment fields', () => {
    const problems = lintReview({
      commit_id: 'a'.repeat(40),
      event: 'COMMENT',
      body: '',
      comments: [
        {
          path: '',
          line: 'not-a-number',
          body: `**[Suggestion]** something${FOOTER}`,
        } as unknown as ReturnType<typeof comment>,
      ],
    });
    expect(problems.some((p) => p.includes('path'))).toBe(true);
    expect(problems.some((p) => p.includes('line'))).toBe(true);
  });
});

describe('lint-review CLI integration', () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'qwen-review-lint-'));
    process.chdir(cwd);
    _resetProjectRootCache();
    mkdirSync('.qwen/tmp', { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    _resetProjectRootCache();
  });

  async function runLint(reviewJsonPath: string): Promise<Error | null> {
    try {
      await yargs(['lint-review', reviewJsonPath])
        .command(lintReviewCommand)
        .demandCommand(1)
        .strict()
        .fail((_msg, err) => {
          throw err ?? new Error(_msg);
        })
        .exitProcess(false)
        .parseAsync();
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  it('succeeds on a clean review JSON', async () => {
    const path = '.qwen/tmp/qwen-review-pr-7-review.json';
    writeFileSync(
      path,
      JSON.stringify({
        commit_id: 'a'.repeat(40),
        event: 'APPROVE',
        body: `LGTM!${FOOTER}`,
        comments: [],
      }),
      'utf8',
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const err = await runLint(path);
      expect(err).toBeNull();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('throws non-zero on a placeholder body — the observed deepseek-v4-flash pattern', async () => {
    const path = '.qwen/tmp/qwen-review-pr-7-review.json';
    writeFileSync(
      path,
      JSON.stringify({
        commit_id: 'a'.repeat(40),
        event: 'COMMENT',
        body: 'Test batch 1',
        comments: [],
      }),
      'utf8',
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const err = await runLint(path);
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/Refusing to certify/);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('throws when the file does not exist', async () => {
    const err = await runLint('.qwen/tmp/does-not-exist.json');
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Failed to read/);
  });

  it('throws when the file is not JSON', async () => {
    const path = '.qwen/tmp/qwen-review-pr-7-review.json';
    writeFileSync(path, '{not json', 'utf8');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const err = await runLint(path);
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/Failed to parse/);
    } finally {
      stderr.mockRestore();
    }
  });
});
