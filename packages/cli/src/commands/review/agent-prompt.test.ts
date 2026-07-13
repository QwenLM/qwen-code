/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject is 23 review agents launched with no way to read the diff.
//
// Every test that matters here asserts a property that was MISSING from all 23
// real launch prompts, measured off the harness's own transcripts: the diff path
// is in the prompt, the read call is in the prompt, and the agent is not handed a
// sentence to recite when it finds nothing.

import { describe, it, expect } from 'vitest';
import { buildChunkAgentPrompt } from './agent-prompt.js';

const PLAN = {
  diffPathAbsolute: '/abs/.qwen/tmp/qwen-review-pr-6771-diff.txt',
  chunks: [
    {
      id: 13,
      startLine: 3808,
      endLine: 4024,
      lines: 217,
      chars: 9000,
      maxLineChars: 120,
      oversized: false,
      files: [
        {
          path: 'packages/cli/src/commands/review/x.test.ts',
          newStart: 1,
          newEnd: 211,
        },
      ],
    },
    {
      id: 14,
      startLine: 4025,
      endLine: 4200,
      lines: 176,
      chars: 40_000,
      maxLineChars: 90,
      oversized: true,
      files: [{ path: 'a.ts', newStart: 1, newEnd: 20 }],
    },
    {
      id: 15,
      startLine: 4201,
      endLine: 4202,
      lines: 2,
      chars: 60_000,
      maxLineChars: 59_000, // a minified bundle: one line no paging can reach
      oversized: true,
      files: [{ path: 'bundle.min.js', newStart: 1, newEnd: 1 }],
    },
  ],
};

describe('buildChunkAgentPrompt — what the real launches left out', () => {
  it('names the diff file — the agents could not open what they were never given', () => {
    // The bug, stated as an assertion. All 23 real prompts described the chunk
    // ("chunk 13 of 23, covering lines 3808-4024") and named no file at all.
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('/abs/.qwen/tmp/qwen-review-pr-6771-diff.txt');
  });

  it('spells out the read call, with a 0-based offset', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    // startLine 3808 (1-based) → offset 3807; limit = 4024 - 3808 + 1 = 217.
    expect(p).toContain('offset=3807');
    expect(p).toContain('limit=217');
    expect(p).toMatch(/read_file\(file_path="[^"]+", offset=3807, limit=217\)/);
  });

  it('does NOT hand the agent a sentence to recite when it finds nothing', () => {
    // Every real prompt ended with: `If you find no issues, say "No issues found
    // — reviewed chunk 13 (x.test.ts)"`. An agent that cannot open the diff will
    // still say it — and did, 23 times. A receipt the prompt wrote is not
    // evidence of work.
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).not.toMatch(/say ["“]No issues found/i);
    expect(p).not.toMatch(/If you find no issues, say/i);
    // It asks for evidence instead.
    expect(p).toContain('say what you examined');
  });

  it('tells the agent to page a truncated read', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('isTruncated');
    expect(p).toMatch(/larger `?offset`?/);
  });

  it('flags an oversized chunk as one that will need paging', () => {
    expect(buildChunkAgentPrompt(PLAN, 14)).toContain('oversized');
  });

  it('tells an unreachable chunk to return Uncoverable, not a receipt', () => {
    // A single line longer than one read: every page starts at a line boundary,
    // so its tail is unreachable by any offset. It must not be receipted.
    const p = buildChunkAgentPrompt(PLAN, 15);
    expect(p).toContain('Uncoverable: chunk 15');
    expect(p).toContain('exceeds the read limit');
  });

  it('scopes the agent to its own territory', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('lines 3808-4024');
    expect(p).toContain('belong to other agents');
    // And names the source files it covers.
    expect(p).toContain('packages/cli/src/commands/review/x.test.ts');
  });

  it('carries the severity definitions, so test-coverage is not filed as Critical', () => {
    const p = buildChunkAgentPrompt(PLAN, 13);
    expect(p).toContain('**Critical**');
    expect(p).toContain('**Suggestion**');
  });

  it('appends project rules when there are any', () => {
    const p = buildChunkAgentPrompt(PLAN, 13, 'No `any` in new code.');
    expect(p).toContain('Project rules');
    expect(p).toContain('No `any` in new code.');
    expect(buildChunkAgentPrompt(PLAN, 13)).not.toContain('Project rules');
  });
});

describe('buildChunkAgentPrompt — refuses a plan it cannot build from', () => {
  it('refuses a plan with no diff path — that is the bug, not a default', () => {
    // A prompt built without the diff path is exactly what shipped 23 times. It
    // must be an error, never a prompt that merely describes the chunk.
    expect(() => buildChunkAgentPrompt({ chunks: PLAN.chunks }, 13)).toThrow(
      /diffPathAbsolute/,
    );
  });

  it('refuses a plan with no chunks', () => {
    expect(() =>
      buildChunkAgentPrompt({ diffPathAbsolute: '/x/diff.txt' }, 1),
    ).toThrow(/chunks/);
  });

  it('refuses a chunk id the plan does not have', () => {
    expect(() => buildChunkAgentPrompt(PLAN, 99)).toThrow(/no chunk 99/);
  });

  it('refuses a chunk whose line range is unusable', () => {
    const bad = {
      diffPathAbsolute: '/x/diff.txt',
      chunks: [{ id: 1, startLine: 0, endLine: -5, files: [] }],
    };
    expect(() => buildChunkAgentPrompt(bad, 1)).toThrow(/line range/);
  });
});
