/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildFilesPlan,
  collectAuditFiles,
  resolveAuditRoot,
  rosterForEffort,
  tileFiles,
  WHOLE_READ_SRC_LINES,
  HEAVY_FILE_LINES,
  type AuditFile,
} from './files-plan.js';

function makeFile(path: string, lines: number): AuditFile {
  return {
    path,
    kind: 'source',
    lines,
    chars: lines * 10,
    heavy: false,
  };
}

describe('tileFiles', () => {
  it('packs files greedily up to the chunk limit in path order', () => {
    const files = [
      makeFile('a.ts', 200),
      makeFile('b.ts', 150),
      makeFile('c.ts', 100),
      makeFile('d.ts', 300),
    ];
    const chunks = tileFiles(files, 400);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      id: 1,
      files: ['a.ts', 'b.ts'],
      lines: 350,
      oversized: false,
    });
    expect(chunks[1]).toMatchObject({
      id: 2,
      files: ['c.ts', 'd.ts'],
      lines: 400,
      oversized: false,
    });
  });

  it('gives an oversized file its own chunk and keeps packing after it', () => {
    const files = [
      makeFile('a.ts', 100),
      makeFile('big.ts', 900),
      makeFile('b.ts', 100),
    ];
    const chunks = tileFiles(files, 400);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ files: ['a.ts'], oversized: false });
    expect(chunks[1]).toMatchObject({ files: ['big.ts'], oversized: true });
    expect(chunks[2]).toMatchObject({ files: ['b.ts'], oversized: false });
  });

  it('produces no chunks for an empty file set', () => {
    expect(tileFiles([], 400)).toEqual([]);
  });

  it('rejects a non-positive or fractional chunk limit', () => {
    expect(() => tileFiles([makeFile('a.ts', 1)], 0)).toThrow(
      /positive integer/,
    );
    expect(() => tileFiles([makeFile('a.ts', 1)], 1.5)).toThrow(
      /positive integer/,
    );
  });
});

describe('rosterForEffort', () => {
  it('low effort means an inline audit with no agents', () => {
    expect(rosterForEffort('low')).toEqual([]);
  });

  it('medium is the replicated roster including one undirected seat', () => {
    expect(rosterForEffort('medium')).toEqual([
      '1a',
      '1c',
      '2',
      '3a',
      '3b',
      '3c',
      '4',
      '5',
      '6a',
    ]);
  });

  it('high adds the remaining personas', () => {
    expect(rosterForEffort('high')).toEqual([
      '1a',
      '1c',
      '2',
      '3a',
      '3b',
      '3c',
      '4',
      '5',
      '6a',
      '6b',
      '6c',
    ]);
  });
});

describe('buildFilesPlan', () => {
  it('chooses whole-read topology below the threshold and marks no chunks', () => {
    const files = [makeFile('a.ts', 300), makeFile('b.ts', 200)];
    const plan = buildFilesPlan(files, 'medium');
    expect(plan.topology).toBe('whole');
    expect(plan.chunks).toEqual([]);
    expect(plan.srcLines).toBe(500);
  });

  it('flips to chunked topology above the threshold', () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      makeFile(`f${i}.ts`, 400),
    );
    const plan = buildFilesPlan(files, 'medium', 400);
    expect(plan.srcLines).toBeGreaterThan(WHOLE_READ_SRC_LINES);
    expect(plan.topology).toBe('chunked');
    expect(plan.chunks.length).toBeGreaterThan(1);
    const chunkLines = plan.chunks.reduce((n, c) => n + c.lines, 0);
    expect(chunkLines).toBe(plan.srcLines);
  });

  it('writes chunk-scoped and whole-module role subsets of the roster', () => {
    const plan = buildFilesPlan([makeFile('a.ts', 100)], 'medium');
    expect(plan.chunkScopedRoles).toEqual(['1a', '2', '3b', '3c', '4', '6a']);
    expect(plan.wholeModuleRoles).toEqual(['1c', '3a', '5']);
    expect([...plan.chunkScopedRoles, ...plan.wholeModuleRoles].sort()).toEqual(
      [...plan.roster].sort(),
    );
  });

  it('separates test files as evidence and docs/generated as excluded', () => {
    const files: AuditFile[] = [
      makeFile('src/a.ts', 100),
      { ...makeFile('src/a.test.ts', 50), kind: 'test' },
      { ...makeFile('docs/guide.md', 40), kind: 'docs' },
      { ...makeFile('out/schema.generated.ts', 60), kind: 'generated' },
    ];
    const plan = buildFilesPlan(files, 'medium');
    expect(plan.totalFiles).toBe(1);
    expect(plan.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(plan.evidenceFiles).toEqual([{ path: 'src/a.test.ts', lines: 50 }]);
    expect(plan.docsFiles).toEqual(['docs/guide.md']);
    expect(plan.generatedFiles).toEqual(['out/schema.generated.ts']);
  });

  it('marks files at or above the heavy threshold', () => {
    const files = [
      makeFile('small.ts', HEAVY_FILE_LINES - 1),
      makeFile('heavy.ts', HEAVY_FILE_LINES),
    ];
    const plan = buildFilesPlan(files, 'medium');
    expect(plan.heavyFiles).toEqual(['heavy.ts']);
  });
});

describe('filesystem integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `audit-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n'.repeat(10));
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'x'.repeat(100));
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    writeFileSync(join(dir, 'logo.png'), 'not-really-a-png');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collectAuditFiles enumerates, classifies, and skips binary extensions', () => {
    const files = collectAuditFiles(dir);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')?.kind).toBe('source');
    expect(byPath.get('src/a.ts')?.lines).toBe(11); // 10 lines + trailing newline
    expect(byPath.get('src/a.test.ts')?.kind).toBe('test');
    expect(byPath.get('README.md')?.kind).toBe('docs');
    expect(byPath.has('logo.png')).toBe(false);
  });

  it('resolveAuditRoot rejects files with a /review delegation message', () => {
    expect(() => resolveAuditRoot(join(dir, 'src', 'a.ts'))).toThrow(
      /\/review <file-path>/,
    );
  });

  it('resolveAuditRoot rejects missing paths', () => {
    expect(() => resolveAuditRoot(join(dir, 'nope'))).toThrow(/does not exist/);
  });

  it('end to end: collect then plan', () => {
    const plan = buildFilesPlan(collectAuditFiles(dir), 'medium');
    expect(plan.totalFiles).toBe(1);
    expect(plan.topology).toBe('whole');
    expect(plan.evidenceFiles).toHaveLength(1);
    expect(plan.docsFiles).toEqual(['README.md']);
  });

  it('inside a git repo: ls-files enumeration is root-relative and honors .gitignore', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build', 'generated-out.ts'), 'const x = 1;\n');
    writeFileSync(join(dir, 'untracked.ts'), 'const y = 2;\n');

    const files = collectAuditFiles(dir).map((f) => f.path);
    // Paths are relative to the audited root, not the repo root.
    expect(files).toContain('src/a.ts');
    expect(files).not.toContain('packages/core/src/hooks/a.ts');
    // Untracked-but-not-ignored files are included.
    expect(files).toContain('untracked.ts');
    // Ignored directories are excluded.
    expect(files).not.toContain('build/generated-out.ts');
  });

  it('classifies from the repository-relative path while reporting audit-relative paths', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const skillDir = join(dir, 'packages', 'core', 'src', 'skills', 'demo');
    const testsDir = join(dir, 'packages', 'demo', 'tests');
    const distDir = join(dir, 'packages', 'demo', 'dist');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# executable prompt\n');
    writeFileSync(join(testsDir, 'fixture.ts'), 'export const fixture = 1;\n');
    writeFileSync(join(distDir, 'output.ts'), 'export const output = 1;\n');
    execFileSync('git', ['add', '-f', '.'], { cwd: dir });

    expect(collectAuditFiles(skillDir)).toEqual([
      expect.objectContaining({ path: 'SKILL.md', kind: 'source' }),
    ]);
    expect(collectAuditFiles(testsDir)).toEqual([
      expect.objectContaining({ path: 'fixture.ts', kind: 'test' }),
    ]);
    expect(collectAuditFiles(distDir)).toEqual([
      expect.objectContaining({ path: 'output.ts', kind: 'generated' }),
    ]);
  });

  it('does not follow a tracked symbolic link outside the audited root', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const outside = join(tmpdir(), `audit-outside-${Date.now()}.txt`);
    writeFileSync(outside, 'secret outside content\n');
    symlinkSync(outside, join(dir, 'outside.ts'));
    execFileSync('git', ['add', '.'], { cwd: dir });

    try {
      expect(collectAuditFiles(dir).map((f) => f.path)).not.toContain(
        'outside.ts',
      );
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
