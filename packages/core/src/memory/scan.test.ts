/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryFilePath, getTeamAutoMemoryRoot } from './paths.js';
import {
  parseAutoMemoryTopicDocument,
  scanAutoMemoryTopicDocuments,
  scanTeamAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
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
      type: 'project',
      filePath: '/tmp/project.md',
      relativePath: 'project.md',
      filename: 'project.md',
      title: 'Project Memory',
      description: 'Project context',
      body: '# Project Memory\n\n- Release freeze starts Friday.',
      mtimeMs: 0,
    });
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
    expect(referenceDoc?.relativePath).toBe('reference/grafana.md');
    expect(referenceDoc?.body).toContain('grafana.internal/d/api-latency');
  });

  it('ignores directories whose names end in .md', async () => {
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
    // Only regular Markdown files belong in the scan; a directory with the
    // same suffix must not displace valid documents.
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

  it.skipIf(process.platform === 'win32')(
    'does not follow symlinks inside a memory root',
    async () => {
      const outsideFile = path.join(tempDir, 'outside.md');
      await fs.writeFile(
        outsideFile,
        '---\ntype: project\nname: Outside\ndescription: outside\n---\nsecret',
        'utf-8',
      );
      const linkedFile = getAutoMemoryFilePath(projectRoot, 'linked.md');
      await fs.symlink(outsideFile, linkedFile);

      const outsideDir = path.join(tempDir, 'outside-dir');
      await fs.mkdir(outsideDir);
      await fs.writeFile(
        path.join(outsideDir, 'nested.md'),
        '---\ntype: project\nname: Nested\ndescription: outside\n---\nsecret',
        'utf-8',
      );
      await fs.symlink(
        outsideDir,
        getAutoMemoryFilePath(projectRoot, 'linked-dir'),
      );

      const docs = await scanAutoMemoryTopicDocuments(projectRoot);

      expect(docs.some((doc) => doc.title === 'Outside')).toBe(false);
      expect(docs.some((doc) => doc.title === 'Nested')).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked team memory root',
    async () => {
      const outsideRoot = path.join(tempDir, 'outside-team-memory');
      await fs.mkdir(outsideRoot);
      const teamRoot = getTeamAutoMemoryRoot(projectRoot);
      await fs.mkdir(path.dirname(teamRoot), { recursive: true });
      await fs.symlink(outsideRoot, teamRoot);

      await expect(
        scanTeamAutoMemoryTopicDocuments(projectRoot),
      ).rejects.toThrow('Refusing symlinked memory root');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a team memory root redirected by an ancestor symlink',
    async () => {
      const linkedProject = path.join(tempDir, 'linked-project');
      const outsideQwen = path.join(tempDir, 'outside-qwen');
      await fs.mkdir(linkedProject);
      await fs.mkdir(path.join(outsideQwen, 'team-memory'), {
        recursive: true,
      });
      await fs.symlink(outsideQwen, path.join(linkedProject, '.qwen'));

      await expect(
        scanTeamAutoMemoryTopicDocuments(linkedProject),
      ).rejects.toThrow('Memory root is outside its trusted anchor');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'allows a user-owned memory root symlink',
    async () => {
      const previousBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      const memoryBase = path.join(tempDir, 'memory-base');
      const userTarget = path.join(tempDir, 'user-memory');
      await fs.mkdir(memoryBase);
      await fs.mkdir(userTarget);
      await fs.writeFile(
        path.join(userTarget, 'user.md'),
        '---\ntype: user\nname: User\ndescription: private\n---\nbody',
        'utf-8',
      );
      await fs.symlink(userTarget, path.join(memoryBase, 'memories'));
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = memoryBase;

      try {
        const docs = await scanUserAutoMemoryTopicDocuments();
        expect(docs.map((doc) => doc.title)).toContain('User');
      } finally {
        if (previousBaseDir === undefined) {
          delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
        } else {
          process.env['QWEN_CODE_MEMORY_BASE_DIR'] = previousBaseDir;
        }
      }
    },
  );
});
