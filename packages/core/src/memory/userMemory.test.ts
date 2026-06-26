/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  USER_AUTO_MEMORY_DIRNAME,
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
  getUserAutoMemoryTopicPath,
  isAnyAutoMemPath,
  isAutoMemPath,
  isUserAutoMemPath,
} from './paths.js';
import {
  ensureUserAutoMemoryScaffold,
  readUserAutoMemoryIndex,
} from './store.js';
import { scanUserAutoMemoryTopicDocuments } from './scan.js';
import { rebuildUserAutoMemoryIndex } from './indexer.js';
import {
  appendManagedAutoMemoryToUserMemory,
  buildManagedAutoMemoryPrompt,
} from './prompt.js';

describe('user-level auto-memory', () => {
  let tempDir: string;
  let projectRoot: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'user-memory-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    previousBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = tempDir;
    // Defensive: paths.ts memoizes getAutoMemoryRoot by projectRoot.
    // Each test uses a fresh mkdtemp dir so collisions are impossible
    // today, but clearing keeps the suite robust if a future test reuses
    // a projectRoot string.
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = previousBaseDir;
    }
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  describe('paths', () => {
    it('places user memory at {QWEN_CODE_MEMORY_BASE_DIR}/memories', () => {
      expect(getUserAutoMemoryRoot()).toBe(
        path.join(tempDir, USER_AUTO_MEMORY_DIRNAME),
      );
      expect(getUserAutoMemoryIndexPath()).toBe(
        path.join(
          tempDir,
          USER_AUTO_MEMORY_DIRNAME,
          AUTO_MEMORY_INDEX_FILENAME,
        ),
      );
      expect(getUserAutoMemoryTopicPath('user')).toBe(
        path.join(tempDir, USER_AUTO_MEMORY_DIRNAME, 'user.md'),
      );
    });

    it('isUserAutoMemPath accepts paths under the user root, rejects others', () => {
      const userRoot = getUserAutoMemoryRoot();
      expect(isUserAutoMemPath(path.join(userRoot, 'user', 'role.md'))).toBe(
        true,
      );
      expect(isUserAutoMemPath(userRoot)).toBe(true);
      expect(isUserAutoMemPath(path.join(tempDir, 'unrelated.md'))).toBe(false);
      // Path-traversal — relative resolves to '..'
      expect(isUserAutoMemPath(path.join(userRoot, '..', 'escape.md'))).toBe(
        false,
      );
    });

    it('isAnyAutoMemPath accepts paths in either the project or the user root', () => {
      const projectMemoryRoot = getAutoMemoryRoot(projectRoot);
      const userRoot = getUserAutoMemoryRoot();

      expect(
        isAnyAutoMemPath(
          path.join(projectMemoryRoot, 'feedback', 'x.md'),
          projectRoot,
        ),
      ).toBe(true);
      expect(
        isAnyAutoMemPath(path.join(userRoot, 'user', 'y.md'), projectRoot),
      ).toBe(true);
      expect(
        isAnyAutoMemPath(path.join(tempDir, 'outside.md'), projectRoot),
      ).toBe(false);

      // Symmetric check: project-only helper should reject the user path
      expect(
        isAutoMemPath(path.join(userRoot, 'user', 'y.md'), projectRoot),
      ).toBe(false);
    });
  });

  describe('scaffold + index', () => {
    it('ensureUserAutoMemoryScaffold creates root dir + empty MEMORY.md, idempotent', async () => {
      await ensureUserAutoMemoryScaffold();

      await expect(fs.stat(getUserAutoMemoryRoot())).resolves.toBeDefined();
      await expect(
        fs.readFile(getUserAutoMemoryIndexPath(), 'utf-8'),
      ).resolves.toBe('');

      // Preserves custom content on second call
      const customIndex = '# Custom user index\n\n- preserve me\n';
      await fs.writeFile(getUserAutoMemoryIndexPath(), customIndex, 'utf-8');
      await ensureUserAutoMemoryScaffold();
      await expect(
        fs.readFile(getUserAutoMemoryIndexPath(), 'utf-8'),
      ).resolves.toBe(customIndex);

      // Unlike per-project scaffold, no meta.json / extract-cursor.json
      await expect(
        fs.access(path.join(getUserAutoMemoryRoot(), 'meta.json')),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(getUserAutoMemoryRoot(), 'extract-cursor.json')),
      ).rejects.toThrow();
    });

    it('readUserAutoMemoryIndex returns null when the index does not exist yet', async () => {
      await expect(readUserAutoMemoryIndex()).resolves.toBeNull();
    });

    it('readUserAutoMemoryIndex reads existing content', async () => {
      await ensureUserAutoMemoryScaffold();
      await fs.writeFile(
        getUserAutoMemoryIndexPath(),
        '- [Role](user/role.md) — User is a Go engineer.\n',
        'utf-8',
      );
      await expect(readUserAutoMemoryIndex()).resolves.toBe(
        '- [Role](user/role.md) — User is a Go engineer.\n',
      );
    });
  });

  describe('scan + rebuild', () => {
    async function writeUserMemoryDoc(
      type: 'user' | 'feedback' | 'project' | 'reference',
      name: string,
      description: string,
      body: string,
    ): Promise<string> {
      const docPath = path.join(getUserAutoMemoryRoot(), type, `${name}.md`);
      await fs.mkdir(path.dirname(docPath), { recursive: true });
      await fs.writeFile(
        docPath,
        [
          '---',
          `name: ${name}`,
          `description: ${description}`,
          `type: ${type}`,
          '---',
          '',
          body,
          '',
        ].join('\n'),
        'utf-8',
      );
      return docPath;
    }

    it('scanUserAutoMemoryTopicDocuments returns documents written under the user root', async () => {
      await ensureUserAutoMemoryScaffold();
      await writeUserMemoryDoc(
        'user',
        'role',
        'User is a Go engineer.',
        'User has been writing Go for 10 years.',
      );

      const docs = await scanUserAutoMemoryTopicDocuments();

      expect(docs).toHaveLength(1);
      expect(docs[0]?.type).toBe('user');
      expect(docs[0]?.title).toBe('role');
      expect(docs[0]?.description).toBe('User is a Go engineer.');
    });

    it('scanUserAutoMemoryTopicDocuments returns [] when the user root is missing', async () => {
      await expect(scanUserAutoMemoryTopicDocuments()).resolves.toEqual([]);
    });

    it('rebuildUserAutoMemoryIndex writes MEMORY.md from the user docs', async () => {
      await ensureUserAutoMemoryScaffold();
      await writeUserMemoryDoc(
        'user',
        'role',
        'User is a Go engineer.',
        'User has been writing Go for 10 years.',
      );
      await writeUserMemoryDoc(
        'feedback',
        'terse',
        'User prefers terse responses.',
        'Skip end-of-turn summaries.',
      );

      const index = await rebuildUserAutoMemoryIndex();

      expect(index).toContain('user/role.md');
      expect(index).toContain('feedback/terse.md');
      expect(index).toContain('User is a Go engineer.');
      expect(index).toContain('User prefers terse responses.');

      // Persists to disk at the expected path
      await expect(
        fs.readFile(getUserAutoMemoryIndexPath(), 'utf-8'),
      ).resolves.toBe(index);
    });
  });

  describe('system prompt rendering', () => {
    it('renders both index sections when a user section is provided', () => {
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/project/.qwen/memory',
        '- [Release](project/release.md) — Release Friday.',
        {
          memoryDir: '/tmp/global/memories',
          indexContent: '- [Role](user/role.md) — User is a Go engineer.',
        },
      );

      expect(prompt).toContain('USER memory');
      expect(prompt).toContain('PROJECT memory');
      expect(prompt).toContain('/tmp/global/memories');
      expect(prompt).toContain('/tmp/project/.qwen/memory');
      expect(prompt).toContain('## /tmp/global/memories/MEMORY.md');
      expect(prompt).toContain('## /tmp/project/.qwen/memory/MEMORY.md');
      expect(prompt).toContain(
        '- [Role](user/role.md) — User is a Go engineer.',
      );
      expect(prompt).toContain(
        '- [Release](project/release.md) — Release Friday.',
      );
      // Scope guidance is surfaced for every type
      expect(prompt).toContain('<scope>always user (cross-project)</scope>');
      expect(prompt).toContain(
        '<scope>always project (this-project-only)</scope>',
      );
      expect(prompt).toContain('default user');
      expect(prompt).toContain('default project');
    });

    it('renders user section FIRST (background) then project section (more specific)', () => {
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/project/.qwen/memory',
        '- [Release](project/release.md) — Release Friday.',
        {
          memoryDir: '/tmp/global/memories',
          indexContent: '- [Role](user/role.md) — User is a Go engineer.',
        },
      );

      const userIdx = prompt.indexOf('## /tmp/global/memories/MEMORY.md');
      const projectIdx = prompt.indexOf(
        '## /tmp/project/.qwen/memory/MEMORY.md',
      );
      expect(userIdx).toBeGreaterThan(-1);
      expect(projectIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeLessThan(projectIdx);
    });

    it('falls back to single-dir wording when no user section is provided', () => {
      const prompt = buildManagedAutoMemoryPrompt(
        '/tmp/project/.qwen/memory',
        '- [Release](project/release.md) — Release Friday.',
      );

      expect(prompt).toContain('persistent, file-based memory system');
      expect(prompt).not.toContain('USER memory');
      expect(prompt).not.toContain('PROJECT memory');
      expect(prompt).toContain('## /tmp/project/.qwen/memory/MEMORY.md');
    });

    it('appendManagedAutoMemoryToUserMemory passes the user section through', () => {
      const result = appendManagedAutoMemoryToUserMemory(
        'Project rules from QWEN.md',
        '/tmp/project/.qwen/memory',
        '- [Release](project/release.md) — Release Friday.',
        {
          memoryDir: '/tmp/global/memories',
          indexContent: '- [Role](user/role.md) — User is a Go engineer.',
        },
      );

      expect(result).toContain('Project rules from QWEN.md');
      expect(result).toContain('USER memory');
      expect(result).toContain('/tmp/global/memories');
    });
  });
});
