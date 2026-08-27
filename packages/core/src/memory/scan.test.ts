/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryFilePath,
  getAutoMemoryRoot,
} from './paths.js';
import {
  parseAutoMemoryTopicDocument,
  scanAutoMemorySnapshot,
  scanAutoMemoryTopicDocuments,
  validateStructuredAutoMemoryDocument,
} from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('auto-memory topic scanning', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-scan-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('parses a CRLF (Windows checkout) topic document', () => {
    // Team files are read raw (utf-8); a Windows checkout yields `---\r\n`,
    // which the `^---\n` delimiter would reject — dropping the file from the
    // shared index. The parser must normalize CRLF first.
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/crlf.md',
      [
        '---',
        'type: project',
        'name: CRLF Memory',
        'description: Windows line endings',
        '---',
        '',
        'Body line one.',
      ].join('\r\n'),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.scope).toBe('project');
    expect(parsed?.type).toBe('project');
    expect(parsed?.title).toBe('CRLF Memory');
    expect(parsed?.description).toBe('Windows line endings');
    // The body is normalized to LF, not left with stray carriage returns.
    expect(parsed?.body).toBe('Body line one.');
  });

  it('parses a managed auto-memory topic document', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/project.md',
      [
        '---',
        'type: project',
        'title: Project Memory',
        'description: Project context',
        '---',
        '',
        '# Project Memory',
        '',
        '- Release freeze starts Friday.',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      scope: 'project',
      type: 'project',
      filePath: '/tmp/project.md',
      relativePath: 'project.md',
      filename: 'project.md',
      title: 'Project Memory',
      description: 'Project context',
      category: 'uncategorized',
      keywords: [],
      usageScenarios: ['Project context'],
      body: '# Project Memory\n\n- Release freeze starts Friday.',
      mtimeMs: 0,
    });
  });

  it('validates the complete structured-memory frontmatter contract', () => {
    const content = [
      '---',
      'name: Recall design',
      'description: How memory recall is organized',
      'type: project',
      'category: project_introduction',
      'keywords:',
      '  - memory recall',
      '  - focused subtree',
      'usage_scenarios:',
      '  - Reviewing memory architecture',
      '---',
      'Body remains unchanged.',
    ].join('\n');

    expect(validateStructuredAutoMemoryDocument(content)).toEqual({
      valid: true,
      missingOrInvalidFields: [],
    });
  });

  it('keeps legacy parsing permissive while strict validation reports fields', () => {
    const content = [
      '---',
      'title: Legacy memory',
      'description: Legacy body description',
      'type: project',
      'category: invented_category',
      'keywords:',
      '  - only-one',
      'usage_scenarios: invalid',
      '---',
      'Legacy body.',
    ].join('\n');

    expect(
      parseAutoMemoryTopicDocument('/tmp/legacy.md', content),
    ).not.toBeNull();
    expect(validateStructuredAutoMemoryDocument(content)).toEqual({
      valid: false,
      missingOrInvalidFields: [
        'name',
        'category',
        'keywords',
        'usage_scenarios',
      ],
    });
  });

  it('rejects duplicate or malformed structured keyword arrays', () => {
    const content = [
      '---',
      'name: Duplicate terms',
      'description: Invalid keyword metadata',
      'type: reference',
      'category: tool_experience',
      'keywords:',
      '  - memory search',
      '  - Memory Search',
      'usage_scenarios:',
      '  - Debugging recall',
      '---',
      'Body.',
    ].join('\n');

    expect(validateStructuredAutoMemoryDocument(content)).toMatchObject({
      valid: false,
      missingOrInvalidFields: ['keywords'],
    });
  });

  it('parses and sanitizes keyword arrays without dropping the document', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/keywords.md',
      [
        '---',
        'type: feedback',
        'name: Testing preference',
        'description: User prefers integration tests.',
        'keywords:',
        '  - Integration Testing',
        '  - integration testing',
        '  - "database\\u200b mocking"',
        '  - 42',
        '---',
        'Use real databases.',
      ].join('\n'),
      0,
      'feedback/testing.md',
      'user',
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.scope).toBe('user');
    expect(parsed?.category).toBe('uncategorized');
    expect(parsed?.keywords).toEqual([
      'Integration Testing',
      'database mocking',
    ]);
    expect(parsed?.usageScenarios).toEqual(['User prefers integration tests.']);
  });

  it('ignores invalid keyword fields while preserving semantic recall data', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/invalid-keywords.md',
      [
        '---',
        'type: project',
        'name: Release plan',
        'description: Release context',
        'keywords: deployment',
        '---',
        'Freeze starts Friday.',
      ].join('\n'),
    );

    expect(parsed?.title).toBe('Release plan');
    expect(parsed?.keywords).toEqual([]);
  });

  it('parses category and usage scenarios with safe fallbacks', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/tree.md',
      [
        '---',
        'type: project',
        'name: Pull memory tree',
        'description: Use when designing active memory recall.',
        'category: project_introduction',
        'usage_scenarios:',
        '  - Designing memory navigation',
        '  - "designing memory navigation"',
        '  - "Reviewing\\u200b active pull behavior"',
        '  - ignored overflow',
        '---',
        'Tree body.',
      ].join('\n'),
    );

    expect(parsed?.category).toBe('project_introduction');
    expect(parsed?.usageScenarios).toEqual([
      'Designing memory navigation',
      'Reviewing active pull behavior',
      'ignored overflow',
    ]);
  });

  it('falls back invalid categories to uncategorized', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/category.md',
      [
        '---',
        'type: reference',
        'name: Category fallback',
        'description: Missing category handling',
        'category: invented_nested_category',
        'usage_scenarios: invalid',
        '---',
        'Body.',
      ].join('\n'),
    );

    expect(parsed?.category).toBe('uncategorized');
    expect(parsed?.usageScenarios).toEqual(['Missing category handling']);
  });

  it('scans existing auto-memory files from nested topic folders', async () => {
    const referencePath = getAutoMemoryFilePath(
      projectRoot,
      path.join('reference', 'grafana.md'),
    );
    await fs.mkdir(path.dirname(referencePath), { recursive: true });
    await fs.writeFile(
      referencePath,
      [
        '---',
        'type: reference',
        'name: Reference Memory',
        'description: External references',
        '---',
        '',
        'Oncall dashboard: grafana.internal/d/api-latency',
      ].join('\n'),
      'utf-8',
    );

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const referenceDoc = docs.find((doc) => doc.type === 'reference');

    expect(referenceDoc?.description).toBe('External references');
    expect(referenceDoc?.scope).toBe('project');
    expect(referenceDoc?.relativePath).toBe('reference/grafana.md');
    expect(referenceDoc?.body).toContain('grafana.internal/d/api-latency');
  });

  it('survives an unreadable file instead of dropping the whole index', async () => {
    const goodPath = getAutoMemoryFilePath(
      projectRoot,
      path.join('feedback', 'good.md'),
    );
    await fs.mkdir(path.dirname(goodPath), { recursive: true });
    await fs.writeFile(
      goodPath,
      '---\ntype: feedback\nname: Good\ndescription: kept\n---\nbody',
      'utf-8',
    );
    // A directory named like a `.md` file forces an EISDIR on readFile — a
    // deterministic stand-in for a permission error or a TOCTOU delete during
    // `git pull`. The good file must still be scanned.
    await fs.mkdir(
      getAutoMemoryFilePath(projectRoot, path.join('feedback', 'broken.md')),
      { recursive: true },
    );

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);

    expect(
      docs.find((d) => d.relativePath === 'feedback/good.md'),
    ).toBeTruthy();
    expect(docs.some((d) => d.relativePath === 'feedback/broken.md')).toBe(
      false,
    );
  });

  it('returns sourceStatus for a complete project and user snapshot', async () => {
    const projectPath = getAutoMemoryFilePath(
      projectRoot,
      path.join('project', 'context.md'),
    );
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(
      projectPath,
      '---\ntype: project\nname: Context\ndescription: Project context\n---\nbody',
      'utf-8',
    );

    const snapshot = await scanAutoMemorySnapshot(projectRoot, {
      scopes: ['project', 'user'],
    });

    expect(
      snapshot.docs.some((doc) => doc.relativePath === 'project/context.md'),
    ).toBe(true);
    expect(snapshot.sourceStatus).toEqual({
      requestedScopes: ['project', 'user'],
      searchedScopes: ['project', 'user'],
      unavailableScopes: [],
      complete: true,
      incompleteScopes: [],
    });
  });

  it('also scans project-local memory files when project memory uses runtime storage', async () => {
    const previousLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    try {
      const localPath = path.join(
        projectRoot,
        '.qwen',
        'memory',
        'feedback',
        'local.md',
      );
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(
        localPath,
        '---\ntype: feedback\nname: Local memory\ndescription: Project-local fixture\nkeywords:\n  - local fixture\n---\nbody',
        'utf-8',
      );

      const snapshot = await scanAutoMemorySnapshot(projectRoot, {
        scopes: ['project'],
      });

      expect(
        snapshot.docs.some((doc) => doc.relativePath === 'feedback/local.md'),
      ).toBe(true);
      expect(snapshot.sourceStatus.complete).toBe(true);
    } finally {
      if (previousLocal === undefined) {
        delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      } else {
        process.env['QWEN_CODE_MEMORY_LOCAL'] = previousLocal;
      }
    }
  });

  it('applies one project file cap after merging runtime and local roots', async () => {
    const previousLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
    const previousBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'global');
    clearAutoMemoryRootCache();
    try {
      const runtimeRoot = getAutoMemoryRoot(projectRoot);
      const localRoot = path.join(projectRoot, '.qwen', 'memory');
      const writeDocs = async (
        root: string,
        prefix: string,
        count: number,
        timestamp: Date,
      ) => {
        await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            const filePath = path.join(
              root,
              prefix,
              `${index.toString().padStart(3, '0')}.md`,
            );
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(
              filePath,
              `---\ntype: project\nname: ${prefix}-${index}\ndescription: cap fixture\n---\nbody`,
            );
            await fs.utimes(filePath, timestamp, timestamp);
          }),
        );
      };
      await writeDocs(
        runtimeRoot,
        'runtime',
        105,
        new Date('2026-08-26T00:00:00.000Z'),
      );
      await writeDocs(
        localRoot,
        'local',
        100,
        new Date('2026-08-27T00:00:00.000Z'),
      );

      const snapshot = await scanAutoMemorySnapshot(projectRoot, {
        scopes: ['project'],
      });

      expect(snapshot.docs).toHaveLength(200);
      expect(snapshot.sourceStatus.incompleteScopes).toContainEqual({
        scope: 'project',
        reason: 'file_limit',
        discovered: 205,
        returned: 200,
      });
      expect(
        snapshot.docs.some((doc) => doc.relativePath === 'local/099.md'),
      ).toBe(true);
      expect(
        snapshot.docs.some((doc) => doc.relativePath === 'runtime/104.md'),
      ).toBe(false);
    } finally {
      if (previousLocal === undefined) {
        delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      } else {
        process.env['QWEN_CODE_MEMORY_LOCAL'] = previousLocal;
      }
      if (previousBase === undefined) {
        delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      } else {
        process.env['QWEN_CODE_MEMORY_BASE_DIR'] = previousBase;
      }
      clearAutoMemoryRootCache();
    }
  });

  it('uses relative paths to stabilize equal-mtime filename ties', async () => {
    const first = getAutoMemoryFilePath(projectRoot, 'a/same.md');
    const second = getAutoMemoryFilePath(projectRoot, 'z/same.md');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.mkdir(path.dirname(second), { recursive: true });
    const content =
      '---\ntype: project\nname: Same\ndescription: tie fixture\n---\nbody';
    await fs.writeFile(first, content);
    await fs.writeFile(second, content);
    const timestamp = new Date('2026-08-27T00:00:00.000Z');
    await fs.utimes(first, timestamp, timestamp);
    await fs.utimes(second, timestamp, timestamp);

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);

    expect(
      docs
        .filter((doc) => doc.filename === 'same.md')
        .map((doc) => doc.relativePath),
    ).toEqual(['a/same.md', 'z/same.md']);
  });

  it('reports requested but disabled team memory as unavailable', async () => {
    const snapshot = await scanAutoMemorySnapshot(projectRoot, {
      scopes: ['team'],
      teamMemoryEnabled: false,
      trustedProject: true,
    });

    expect(snapshot.docs).toEqual([]);
    expect(snapshot.sourceStatus).toEqual({
      requestedScopes: ['team'],
      searchedScopes: [],
      unavailableScopes: [{ scope: 'team', reason: 'disabled' }],
      complete: true,
      incompleteScopes: [],
    });
  });

  it('reports requested but untrusted team memory as unavailable', async () => {
    const snapshot = await scanAutoMemorySnapshot(projectRoot, {
      scopes: ['team'],
      teamMemoryEnabled: true,
      trustedProject: false,
    });

    expect(snapshot.sourceStatus.unavailableScopes).toEqual([
      { scope: 'team', reason: 'untrusted' },
    ]);
    expect(snapshot.sourceStatus.searchedScopes).toEqual([]);
  });
});
