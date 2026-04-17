/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AgentStatus } from '../runtime/agent-types.js';
import {
  buildFallbackApproachSummary,
  summarizeUnifiedDiff,
} from './diff-summary.js';
import type { ArenaAgentResult } from './types.js';

describe('summarizeUnifiedDiff', () => {
  it('parses file and line counts from a unified diff', () => {
    const summary = summarizeUnifiedDiff(`diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
diff --git a/tests/auth.test.ts b/tests/auth.test.ts
index 333..444 100644
--- a/tests/auth.test.ts
+++ b/tests/auth.test.ts
@@ -10,2 +10,2 @@
-old
+new`);

    expect(summary).toEqual({
      files: [
        { path: 'src/auth.ts', additions: 2, deletions: 1 },
        { path: 'tests/auth.test.ts', additions: 1, deletions: 1 },
      ],
      additions: 3,
      deletions: 2,
    });
  });

  it('returns zero counts for an empty diff', () => {
    expect(summarizeUnifiedDiff('')).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
    });
  });

  it('parses repeated diff header text without relying on regex backtracking', () => {
    const repeated = Array.from({ length: 200 }, () => 'a b/a').join('');
    const path = `${repeated}.ts`;
    const summary = summarizeUnifiedDiff(`diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new`);

    expect(summary).toEqual({
      files: [{ path, additions: 1, deletions: 1 }],
      additions: 1,
      deletions: 1,
    });
  });
});

describe('buildFallbackApproachSummary', () => {
  it('summarizes changed files and tool usage', () => {
    const result = {
      status: AgentStatus.IDLE,
      stats: { toolCalls: 3 },
      diffSummary: {
        files: [{ path: 'src/auth.ts', additions: 2, deletions: 1 }],
        additions: 2,
        deletions: 1,
      },
    } as unknown as ArenaAgentResult;

    expect(buildFallbackApproachSummary(result)).toBe(
      'Changed 1 file with 3 tool calls (+2/-1).',
    );
  });

  it('reports no changes when the diff is empty', () => {
    const result = {
      status: AgentStatus.IDLE,
      stats: { toolCalls: 0 },
      diffSummary: { files: [], additions: 0, deletions: 0 },
    } as unknown as ArenaAgentResult;

    expect(buildFallbackApproachSummary(result)).toBe(
      'No code changes detected.',
    );
  });
});
