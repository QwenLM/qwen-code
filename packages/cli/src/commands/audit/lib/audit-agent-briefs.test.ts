/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildAuditPrompt,
  buildChunkPrompt,
  buildInvariantPrompt,
} from './audit-agent-briefs.js';
import { buildFilesPlan, type AuditFile } from './files-plan.js';

const files: AuditFile[] = [
  { path: 'a.ts', kind: 'source', lines: 300, chars: 3000, heavy: false },
  { path: 'b.ts', kind: 'source', lines: 200, chars: 2000, heavy: false },
  { path: 'a.test.ts', kind: 'test', lines: 50, chars: 500, heavy: false },
];

const plan = {
  ...buildFilesPlan(files, 'medium'),
  targetPathAbsolute: '/repo/mod',
};

describe('buildAuditPrompt', () => {
  it('assembles context, role brief, and the shared disciplines', () => {
    const prompt = buildAuditPrompt('1a', plan);
    expect(prompt).toContain('/repo/mod');
    expect(prompt).toContain('a.ts (300 lines)');
    expect(prompt).toContain('a.test.ts');
    expect(prompt).toContain('Agent 1a');
    expect(prompt).toContain('Failure scenario');
    expect(prompt).toContain('Silence is better than noise');
  });

  it('marks a whole-module role on a chunked plan as whole-module', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}.ts`,
      kind: 'source' as const,
      lines: 400,
      chars: 4000,
      heavy: false,
    }));
    const chunkedPlan = {
      ...buildFilesPlan(big, 'medium', 400),
      targetPathAbsolute: '/repo/big',
    };
    const prompt = buildAuditPrompt('1c', chunkedPlan);
    expect(prompt).toContain('whole-module by nature');
  });
});

describe('buildInvariantPrompt', () => {
  const heavyPlan = {
    ...buildFilesPlan(
      [
        {
          path: 'heavy.ts',
          kind: 'source' as const,
          lines: 1200,
          chars: 12000,
          heavy: false,
        },
      ],
      'medium',
    ),
    targetPathAbsolute: '/repo/big',
  };

  it('builds three independent whole-file invariant slices', () => {
    expect(
      buildInvariantPrompt('invariant-a', heavyPlan, 'heavy.ts'),
    ).toContain('Mutable fields');
    expect(
      buildInvariantPrompt('invariant-b', heavyPlan, 'heavy.ts'),
    ).toContain('Retry counters');
    expect(
      buildInvariantPrompt('invariant-c', heavyPlan, 'heavy.ts'),
    ).toContain('Early returns');
  });

  it('refuses a file that the plan did not mark heavy', () => {
    expect(() => buildInvariantPrompt('invariant-a', plan, 'a.ts')).toThrow(
      /requires a heavy file/,
    );
  });
});

describe('buildChunkPrompt', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({
    path: `f${i}.ts`,
    kind: 'source' as const,
    lines: 400,
    chars: 4000,
    heavy: false,
  }));
  const chunkedPlan = {
    ...buildFilesPlan(big, 'medium', 400),
    targetPathAbsolute: '/repo/big',
  };

  it('folds the six lenses and scopes to the territory', () => {
    const chunk = chunkedPlan.chunks[0]!;
    const prompt = buildChunkPrompt(chunkedPlan, chunk);
    expect(prompt).toContain(`chunk ${chunk.id} of`);
    for (const f of chunk.files) {
      expect(prompt).toContain(f);
    }
    expect(prompt).toContain('Line-by-line correctness');
    expect(prompt).toContain('Security');
    expect(prompt).toContain('Altitude & abstraction');
    expect(prompt).toContain('Consistency & clarity');
    expect(prompt).toContain('Performance & efficiency');
    expect(prompt).toContain('Attacker');
    expect(prompt).toContain('Silence is better than noise');
    expect(prompt).not.toContain('HEAVY file');
  });

  it('adds the heavy-file paging note when the territory has one', () => {
    const withHeavy = [
      ...big,
      {
        path: 'heavy.ts',
        kind: 'source' as const,
        lines: 1200,
        chars: 12000,
        heavy: false,
      },
    ];
    const heavyPlan = {
      ...buildFilesPlan(withHeavy, 'medium', 400),
      targetPathAbsolute: '/repo/big',
    };
    const heavyChunk = heavyPlan.chunks.find((c) =>
      c.files.includes('heavy.ts'),
    )!;
    const prompt = buildChunkPrompt(heavyPlan, heavyChunk);
    expect(prompt).toContain('HEAVY file');
  });
});
