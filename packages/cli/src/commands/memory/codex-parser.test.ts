/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseCodexMemories } from './codex-parser.js';

function parseHandbook(content: string) {
  return parseCodexMemories([{ path: 'MEMORY.md', content, mtimeMs: 1234 }]);
}

const GROUP = `# Task Group: Atlas delivery
scope: repository delivery practices
applies_to: cwd=/work/atlas; reuse_rule=verify current state

## Task 1: Release acceptance, success
### rollout_summary_files
- rollout_summaries/example.md (cwd=/work/atlas-worktree, updated_at=2026-09-01T10:00:00+00:00, thread_id=synthetic)

### keywords
- release, verify
`;

describe('parseCodexMemories', () => {
  it.each(['/work/atlas', '/work/borealis'])(
    'checks same-level explicit cwd %s together with applies_to',
    (cwd) => {
      const result = parseHandbook(
        '# Task Group: Atlas\napplies_to: cwd=/work/atlas\ncwd: ' +
          cwd +
          '\n## Reusable knowledge\n- Check provenance.\n',
      );
      if (cwd === '/work/atlas') {
        expect(result.candidates[0].sourceProject).toBe('/work/atlas');
        expect(result.warnings).toEqual([]);
      } else {
        expect(result.candidates[0].sourceProject).toBeUndefined();
        expect(result.warnings.join('\n')).toContain(
          'Multiple or alternative project scopes',
        );
      }
    },
  );

  it.each(['see also /work/borealis', 'plus /work/borealis'])(
    'keeps an additional path after prose ambiguous: %s',
    (suffix) => {
      const result = parseHandbook(
        '# Task Group: Atlas\napplies_to: cwd=/work/atlas, ' +
          suffix +
          '\n## Reusable knowledge\n- Check provenance.\n',
      );
      expect(result.candidates[0].sourceProject).toBeUndefined();
      expect(result.warnings.join('\n')).toContain(
        'Multiple or alternative project scopes',
      );
    },
  );

  it('separates ordered entries and excludes thematic separators', () => {
    const result = parseHandbook(
      '# Task Group: Atlas\ncwd: /work/atlas\n## Reusable knowledge\n' +
        '1. First fact.\n2) Second fact.\n\n---\n\n- Third fact.\n',
    );
    expect(result.candidates.map((entry) => entry.content)).toEqual([
      'First fact.',
      'Second fact.',
      'Third fact.',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('retains nested memory subsection entries', () => {
    const result = parseHandbook(
      '# Task Group: Atlas\ncwd: /work/atlas\n## Reusable knowledge\n' +
        '- Visible fact.\n### Detail\n- Nested fact.\n',
    );
    expect(result.candidates.map((entry) => entry.content)).toEqual([
      'Visible fact.',
      'Nested fact.',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it.each(['General Tips', 'rollout_summary_files'])(
    'excludes nested non-memory section %s from its parent',
    (section) => {
      const result = parseHandbook(
        '# Task Group: Atlas\ncwd: /work/atlas\n## Reusable knowledge\n' +
          `- Scoped fact.\n### ${section}\n- Not a memory.\n` +
          '#### User preferences\n- Not a nested memory.\n' +
          '### Release details\n- Next fact.\n',
      );
      expect(result.candidates.map((entry) => entry.content)).toEqual([
        'Scoped fact.',
        'Next fact.',
      ]);
      if (section === 'General Tips') {
        expect(result.warnings.join('\n')).toContain('General Tips skipped');
      }
    },
  );

  it('extracts supported group sections with canonical project and provenance', () => {
    const source = `${GROUP}
## User preferences
- Preserve unrelated workspace files. [Task 1]
## Reusable knowledge
- Verify deployment adoption. [Task 1]
## Failures and how to do differently
- An uploaded artifact does not prove adoption. [Task 1]
`;
    const result = parseHandbook(source);
    expect(result.warnings).toEqual([]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((candidate) => candidate.type)).toEqual([
      'feedback',
      'project',
      'feedback',
    ]);
    expect(result.candidates[0]).toMatchObject({
      name: 'Preserve unrelated workspace files.',
      content: 'Preserve unrelated workspace files.',
      sourceFile: 'MEMORY.md',
      sourceLine:
        source.split('\n').findIndex((line) => line.startsWith('- Preserve')) +
        1,
      sourceProject: '/work/atlas',
      updatedAt: '2026-09-01T10:00:00+00:00',
    });
    expect(
      result.candidates.every((item) => !item.content.includes('Task 1')),
    ).toBe(true);
  });

  it('imports only the global summary profile and preferences', () => {
    const result = parseCodexMemories([
      {
        path: 'memory_summary.md',
        mtimeMs: Date.now(),
        content: `# Summary
## User Profile
Maintains developer tools.
## User preferences
- Explain tradeoffs before implementation.
## General Tips
- Check the staging deployment.
## What's in Memory
### Atlas
- reference index entry
`,
      },
    ]);
    expect(result.candidates.map((candidate) => candidate.type)).toEqual([
      'user',
      'feedback',
    ]);
    for (const candidate of result.candidates) {
      expect(candidate.sourceProject).toBeUndefined();
      expect(candidate.updatedAt).toBeUndefined();
    }
    expect(result.warnings).toEqual([
      'memory_summary.md:6: General Tips skipped because its scope is ambiguous.',
    ]);
  });

  it('normalizes CRLF while preserving source line numbers and identities', () => {
    const source = `${GROUP}\n## Reusable knowledge\n- Confirm adoption.\n`;
    expect(parseHandbook(source.replace(/\n/g, '\r\n'))).toEqual(
      parseHandbook(source),
    );
  });

  it('accepts H1 summary sections and preserves a multiline profile paragraph', () => {
    const result = parseCodexMemories([
      {
        path: 'memory_summary.md',
        mtimeMs: 0,
        content: `# User Profile
Maintains a TypeScript SDK
and reviews release provenance.

# User preferences
- Use concise answers.
`,
      },
    ]);
    expect(result.candidates.map((candidate) => candidate.content)).toEqual([
      'Maintains a TypeScript SDK\nand reviews release provenance.',
      'Use concise answers.',
    ]);
    expect(
      result.candidates.every((candidate) =>
        /^[a-f0-9]{20}$/.test(candidate.id),
      ),
    ).toBe(true);
  });

  it('keeps identity stable when content changes or preceding blank lines move', () => {
    const before = parseHandbook(
      `${GROUP}\n## Reusable knowledge\n- Confirm adoption.\n`,
    ).candidates[0];
    const after = parseHandbook(
      `\n\n${GROUP}\n## Reusable knowledge\n- Confirm adoption and readiness.\n`,
    ).candidates[0];
    expect(after.id).toBe(before.id);
    expect(after.content).not.toBe(before.content);
    expect(after.sourceLine).toBe(before.sourceLine + 2);
  });

  it('distinguishes repeated headings and repeated group names', () => {
    const source = `${GROUP}
## User preferences
- First preference.
## User preferences
- Second preference.
${GROUP}
## User preferences
- Third preference.
`;
    const candidates = parseHandbook(source).candidates;
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(3);
  });

  it('retains project scope on preferences and separates multiple groups', () => {
    const result = parseHandbook(`${GROUP}
## User preferences
- Atlas-specific release practice.
# Task Group: Borealis operations
applies_to: cwd=/work/borealis
## User preferences
- Borealis-specific operating practice.
`);
    expect(
      result.candidates.map((candidate) => candidate.sourceProject),
    ).toEqual(['/work/atlas', '/work/borealis']);
  });

  it('uses distinct task metadata for nested sections', () => {
    const result = parseHandbook(`# Task Group: Multi-project research
## Task 1: Atlas
### rollout_summary_files
- rollout_summaries/atlas.md (cwd=/work/atlas, updated_at=2026-09-01T10:00:00Z)
### Reusable knowledge
- Atlas detail.
## Task 2: Borealis
### rollout_summary_files
- rollout_summaries/borealis.md (cwd=/work/borealis, updated_at=2026-09-02T10:00:00Z)
### Reusable knowledge
- Borealis detail.
## Reusable knowledge
- Shared observation requires an explicit project choice.
`);
    expect(
      result.candidates.map((candidate) => candidate.sourceProject),
    ).toEqual(['/work/atlas', '/work/borealis', undefined]);
    expect(result.candidates.map((candidate) => candidate.updatedAt)).toEqual([
      '2026-09-01T10:00:00Z',
      '2026-09-02T10:00:00Z',
      '2026-09-02T10:00:00Z',
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      'Multiple or alternative project scopes',
    );
  });

  it('accepts a unique rollout cwd when no canonical cwd exists', () => {
    const result = parseHandbook(`# Task Group: Atlas
## Task 1: First
### rollout_summary_files
- rollout_summaries/first.md (cwd=/work/atlas)
- rollout_summaries/second.md (cwd=/work/atlas)
## Reusable knowledge
- Useful detail.
`);
    expect(result.candidates[0].sourceProject).toBe('/work/atlas');
  });

  it.each([
    'and worktree=/work/atlas-feature',
    'and worktree=/work/atlas-feature; updated_at=2025-01-01T00:00:00Z',
    'with worktree=/work/atlas-feature',
    'with implementation worktree=/tmp/atlas-feature',
    'and isolated release worktrees',
    'and isolated worktrees',
    '(with engine source at /work/borealis)',
    '(source checkout /work/borealis)',
    '(source investigation in /work/borealis)',
    '(investigation began in /work/borealis)',
    'with engine implementation references in /work/borealis',
    'with related borealis, cygnus, and draco repositories',
    'with related /work/borealis runtime',
    'on `release/example`',
    'on release/example',
    'on branch release/example',
    'and context-menu worktrees',
    'and local macOS Agent installation',
    'or atlas worktree on release/example',
    '(rollout metadata cwd=/work/borealis)',
  ])(
    'keeps the explicit cwd before a supplemental annotation: %s',
    (annotation) => {
      const source = `${GROUP}\n## Reusable knowledge\n- Synthetic lesson.\n`;
      const plain = parseHandbook(source);
      const annotated = parseHandbook(
        source.replace('cwd=/work/atlas;', `cwd=/work/atlas ${annotation};`),
      );
      expect(annotated).toEqual(plain);
    },
  );

  it.each([
    ['/work/Atlas Project', '/work/Atlas Project'],
    [
      '`/work/Atlas (archive), and references`',
      '/work/Atlas (archive), and references',
    ],
    ['`/work/Atlas Project` with worktree=/tmp/atlas', '/work/Atlas Project'],
    [
      '`/work/Atlas (rollout metadata cwd=historical)`',
      '/work/Atlas (rollout metadata cwd=historical)',
    ],
  ])('preserves project path characters: %s', (scope, expected) => {
    const result = parseHandbook(`# Task Group: Atlas
applies_to: cwd=${scope}; reuse_rule=verify current state
## Reusable knowledge
- Synthetic lesson.
`);
    expect(result.candidates[0].sourceProject).toBe(expected);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['', 'Missing project metadata'],
    ['applies_to: all projects', 'Missing project metadata'],
    ['applies_to: cwd=/work/*', 'Wildcard project path'],
    ['applies_to: cwd=relative/project', 'Invalid project path'],
    [
      'applies_to: cwd=/work/atlas or borealis worktree',
      'Multiple or alternative project scopes',
    ],
    [
      'applies_to: cwd=/work/atlas (rollout metadata cwd=/work/borealis',
      'Multiple or alternative project scopes',
    ],
    [
      'applies_to: cwd=/work/atlas with unknown explanation',
      'Unsupported project scope annotation',
    ],
  ])('explains unresolved project scope: %s', (scope, reason) => {
    const result = parseHandbook(`# Task Group: Atlas
${scope}
## Reusable knowledge
- Synthetic lesson.
`);
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0]).toHaveProperty(
      'reason',
      expect.stringContaining(reason),
    );
    expect(result.warnings[0]).toContain(reason);
  });

  it('does not treat reuse instructions as ownership metadata', () => {
    const result = parseHandbook(
      `${GROUP.replace(
        'reuse_rule=verify current state',
        'reuse_rule=compare cwd=/work/borealis when verifying',
      )}\n## Reusable knowledge\n- Synthetic lesson.\n`,
    );
    expect(result.candidates[0].sourceProject).toBe('/work/atlas');
  });

  it.each([
    'applies_to: cwd=/work/*',
    'applies_to: cwd=/work/atlas cwd=/work/borealis',
    'applies_to: cwd=/work/atlas updated_at=2026-09-01T10:00:00Z',
    'applies_to: cwd=/work/atlas and worktrees=/work/borealis,/work/cygnus',
    'applies_to: cwd=/work/atlas and worktrees=/work/borealis,/work/cygnus;',
    'applies_to: cwd=/work/atlas on `/work/beta`',
    'applies_to: cwd=/work/atlas on `C:\\work\\beta`',
    'applies_to: cwd=/work/atlas; cwd=/work/borealis',
    'applies_to: cwd=/work/atlas and /work/borealis',
    'applies_to: cwd=/work/atlas,/work/borealis',
    'applies_to: cwd=/work/atlas; /work/borealis',
    'applies_to: cwd=/work/atlas /work/borealis',
    'applies_to: cwd=/work/atlas|/work/borealis',
    'applies_to: cwd=/work/atlas with worktree=/tmp/atlas; cwd=/work/borealis',
    'applies_to: cwd=/work/atlas with worktree=/tmp/atlas; /work/borealis',
    'applies_to: cwd=/work/atlas with worktree=/tmp/atlas OR /work/borealis',
    'applies_to: cwd=/work/atlas (source checkout /tmp/atlas), /work/borealis',
    'applies_to: cwd=/work/atlas on `release/example` | /work/borealis',
    'applies_to: cwd=/work/atlas on `release/example`, /work/borealis',
    'applies_to: cwd=/work/atlas with worktree=/tmp/atlas | /work/borealis',
    'applies_to: cwd=/work/atlas with worktree=/tmp/atlas, /work/borealis',
    'applies_to: cwd=/work/atlas on release/example, /work/borealis',
    'applies_to: cwd=/work/atlas on /work/borealis',
    'applies_to: cwd=/work/atlas or atlas worktree on release/example | /work/borealis',
    'applies_to: cwd=/work/atlas or borealis worktree',
    'applies_to: cwd=/work/atlas (rollout metadata cwd=/old/atlas); cwd=/work/borealis',
    'applies_to: cwd=/work/atlas (rollout metadata cwd=/old/atlas), /work/borealis',
    'applies_to: cwd=/work/atlas and context-menu worktrees; /work/borealis',
    'applies_to: cwd=/work/atlas and local Linux Agent installation, /work/borealis',
    'applies_to: all projects',
    'applies_to: cwd=relative/project',
    '',
  ])('leaves ambiguous ownership unresolved: %s', (scope) => {
    const result = parseHandbook(`# Task Group: Atlas
${scope}
## User preferences
- Keep the scope explicit.
`);
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0].reason).toBeTruthy();
    expect(result.warnings[0]).toContain(result.candidates[0].reason!);
  });

  it('does not use rollout cwd to override ambiguous canonical ownership', () => {
    const result = parseHandbook(
      `${GROUP.replace(
        'cwd=/work/atlas; reuse_rule=verify current state',
        'cwd=/work/*',
      )}\n## Reusable knowledge\n- Useful detail.\n`,
    );
    expect(result.candidates[0].sourceProject).toBeUndefined();
  });

  it('ignores metadata-like text outside source metadata sections', () => {
    const result = parseHandbook(`# Task Group: Atlas
## Task 1: Test
### rollout_summary_files
- rollout_summaries/example.md (cwd=/work/atlas)
### Tool transcript
\`\`\`text
applies_to: cwd=/work/wrong
\`\`\`
## Reusable knowledge
- Keep metadata distinct from content.
cwd: /work/also-wrong
`);
    expect(result.candidates[0].sourceProject).toBe('/work/atlas');
  });

  it('prefers canonical group metadata over task applies_to metadata', () => {
    const result = parseHandbook(`# Task Group: Atlas
applies_to: cwd=/work/atlas
## Task 1: Check worktree
applies_to: cwd=/work/worktree
### User preferences
- Keep project preferences scoped.
`);
    expect(result.candidates[0].sourceProject).toBe('/work/atlas');
  });

  it('keeps independently scoped task applies_to metadata separate', () => {
    const result = parseHandbook(`# Task Group: Research
## Task 1: Atlas
applies_to: cwd=/work/atlas
### Reusable knowledge
- Atlas detail.
## Task 2: Borealis
applies_to: cwd=/work/borealis
### Reusable knowledge
- Borealis detail.
`);
    expect(
      result.candidates.map((candidate) => candidate.sourceProject),
    ).toEqual(['/work/atlas', '/work/borealis']);
  });

  it('uses the latest valid source timestamp and ignores invalid dates', () => {
    const result = parseHandbook(`${GROUP}
## Task 2: Follow-up
### rollout_summary_files
- rollout_summaries/later.md (cwd=/work/atlas, updated_at=2026-09-02T11:00:00+08:00)
- rollout_summaries/invalid.md (cwd=/work/atlas, updated_at=2027-02-30T10:00:00Z)
## Reusable knowledge
- Useful detail.
`);
    expect(result.candidates[0].updatedAt).toBe('2026-09-02T11:00:00+08:00');
  });

  it('does not turn source file modification time into an observation date', () => {
    const result = parseHandbook(`# Task Group: Atlas
cwd: /work/atlas
## Reusable knowledge
- Useful detail.
`);
    expect(result.candidates[0].updatedAt).toBeUndefined();
  });

  it('reports unsupported layouts instead of importing arbitrary sections', () => {
    const result = parseHandbook(`# Unknown handbook
## User preferences
- Missing task-group ownership.
## Tool output
- Tool logs are not memory entries.
`);
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual([
      'MEMORY.md:2: recognized section has unsupported ownership; skipped.',
      'MEMORY.md: no supported memory sections found.',
    ]);
  });

  it('does not recognize headings inside a fenced transcript', () => {
    const result = parseHandbook(`\`\`\`markdown
${GROUP}
## Reusable knowledge
- Transcript detail.
\`\`\`
`);
    expect(result.candidates).toEqual([]);
  });

  it('skips fenced tool output within a recognized section with a warning', () => {
    const result = parseHandbook(`${GROUP}
## Reusable knowledge
\`\`\`text
- A tool log entry should not become a memory.
\`\`\`
- Review the actual result.
`);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].content).toBe('Review the actual result.');
    expect(result.warnings[0]).toContain(
      'fenced code, transcript, or HTML skipped',
    );
  });

  it('skips oversized entries without truncating or changing subsequent IDs', () => {
    const prefix = `${GROUP}\n## Reusable knowledge\n`;
    const oversized = parseHandbook(
      `${prefix}- ${'x'.repeat(4001)}\n- Keep me.`,
    );
    const small = parseHandbook(`${prefix}- Small entry.\n- Keep me.`);
    expect(oversized.candidates).toHaveLength(1);
    expect(oversized.candidates[0].content).toBe('Keep me.');
    expect(oversized.candidates[0].id).toBe(small.candidates[1].id);
    expect(oversized.warnings[0]).toContain('skipped without truncation');
  });

  it('preserves nested bullet context and removes only trailing task citations', () => {
    const result = parseHandbook(`${GROUP}
## Reusable knowledge
- Prefer source evidence [Task 1] over assumptions.
  - Verify the target version. [Task 1, Task 2]
`);
    expect(result.candidates[0].content).toBe(
      'Prefer source evidence [Task 1] over assumptions.\n  - Verify the target version.',
    );
  });

  it('does not import rollout summaries or unsupported source files', () => {
    const result = parseCodexMemories([
      {
        path: 'rollout_summaries/example.md',
        content: `${GROUP}\n## Reusable knowledge\n- Detail.`,
        mtimeMs: 0,
      },
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
  it('compares every canonical scope line before assigning a project', () => {
    const result = parseHandbook(`# Task Group: Scope
applies_to: cwd=/work/atlas
cwd: /work/beta
## Reusable knowledge
- Shared fact.
`);
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0].reason).toContain('Multiple');
  });

  it.each([
    'cwd=/work/atlas, also /work/beta',
    'cwd=/work/atlas, see(/work/beta)',
    'cwd=/work/atlas, related project [/work/beta]',
    'cwd=/work/atlas, unexpected prose',
    'cwd=/work/atlas; see `/work/beta`',
    'cwd=/work/atlas on release/example; reference C:\\work\\beta',
  ])('does not discard a second path in residual prose: %s', (scope) => {
    const result = parseHandbook(`# Task Group: Scope
applies_to: ${scope}
## Reusable knowledge
- Shared fact.
`);
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0].reason).toBeDefined();
  });

  it('compares trailing separators while retaining the first source spelling', () => {
    const result = parseHandbook(`# Task Group: Scope
applies_to: cwd=/work/atlas/
cwd: /work/atlas
## Reusable knowledge
- Atlas fact.
`);
    expect(result.candidates[0].sourceProject).toBe('/work/atlas/');
    expect(result.warnings).toEqual([]);
  });

  it('keeps nested section text and ordered entries without importing thematic breaks', () => {
    const result = parseHandbook(`${GROUP}
## Reusable knowledge
- First fact.

### Release details
1. Second fact.
2. Third fact.

---

### User preferences
- Ask before release.

### Deployment
- Fourth fact.
`);
    expect(
      result.candidates.map(({ content, type }) => [content, type]),
    ).toEqual([
      ['First fact.', 'project'],
      ['Second fact.', 'project'],
      ['Third fact.', 'project'],
      ['Fourth fact.', 'project'],
      ['Ask before release.', 'feedback'],
    ]);
  });

  it('does not let indented code fence text swallow the following project', () => {
    const source = `${GROUP}
## Reusable knowledge
- Atlas fact.

      \`\`\`
      transcript only

# Task Group: Beta
applies_to: cwd=/work/beta
## Reusable knowledge
- Beta fact.
`;
    const result = parseHandbook(source);
    expect(
      result.candidates.map(({ content, sourceProject }) => [
        content,
        sourceProject,
      ]),
    ).toEqual([
      ['Atlas fact.', '/work/atlas'],
      ['Beta fact.', '/work/beta'],
    ]);
    expect(result.warnings.join(' ')).toMatch(/MEMORY.md:\d+-\d+: fenced code/);
  });
  it('does not accept hidden HTML project metadata', () => {
    const result = parseHandbook(
      '# Task Group: Hidden\n<!--\ncwd: /work/beta\n-->\n\n## Reusable knowledge\n- Visible fact.\n',
    );
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0].reason).toContain('Missing project metadata');
  });
  it.each([
    'Use <project-root>/src before release.',
    'Prefer <strong>concise</strong> answers.',
    'Keep this <!-- hidden --> visible instruction.',
  ])('preserves prose surrounding inline HTML: %s', (content) => {
    const result = parseHandbook(
      `${GROUP}\n## Reusable knowledge\n- ${content}\n`,
    );
    expect(result.candidates.map((candidate) => candidate.content)).toEqual([
      content,
    ]);
    expect(result.warnings).toEqual([]);
  });
  it('does not treat a POSIX backslash filename as a trailing separator', () => {
    const result = parseHandbook(
      '# Task Group: Scope\napplies_to: cwd=/work/atlas\\\ncwd: /work/atlas\n## Reusable knowledge\n- Ambiguous fact.\n',
    );
    expect(result.candidates[0].sourceProject).toBeUndefined();
    expect(result.candidates[0].reason).toContain('Multiple');
  });
});
