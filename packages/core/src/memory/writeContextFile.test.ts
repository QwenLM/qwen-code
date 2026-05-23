/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import { QWEN_DIR } from '../utils/paths.js';
import {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  getLocalContextFilePath,
  LOCAL_CONTEXT_FILENAME,
  MEMORY_SECTION_HEADER,
  setGeminiMdFilename,
} from './const.js';
import { writeWorkspaceContextFile } from './writeContextFile.js';

describe('writeWorkspaceContextFile', () => {
  let tmpRoot: string;
  let workspace: string;
  let globalDir: string;
  let getGlobalQwenDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-write-context-'));
    workspace = path.join(tmpRoot, 'workspace');
    globalDir = path.join(tmpRoot, 'global');
    await fs.mkdir(workspace, { recursive: true });
    getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(globalDir);
  });

  afterEach(async () => {
    getGlobalQwenDirSpy.mockRestore();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates QWEN.md with a fresh section header on first append', async () => {
    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- first entry',
      projectRoot: workspace,
    });

    expect(result.filePath).toBe(
      path.join(workspace, DEFAULT_CONTEXT_FILENAME),
    );
    const written = await fs.readFile(result.filePath, 'utf8');
    expect(written).toBe(`${MEMORY_SECTION_HEADER}\n- first entry\n`);
    expect(result.bytesWritten).toBe(Buffer.byteLength(written, 'utf8'));
  });

  it('appends under existing section header', async () => {
    const initial = `# project notes\n\n${MEMORY_SECTION_HEADER}\n- first entry\n`;
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    await fs.writeFile(filePath, initial, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- second entry',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe(
      `# project notes\n\n${MEMORY_SECTION_HEADER}\n- first entry\n- second entry\n`,
    );
  });

  it('inserts a section header when file lacks one', async () => {
    const initial = '# project notes\n';
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    await fs.writeFile(filePath, initial, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- entry',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe(
      `# project notes\n\n${MEMORY_SECTION_HEADER}\n- entry\n`,
    );
  });

  it('replaces file contents in replace mode', async () => {
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    await fs.writeFile(filePath, 'old contents\n', 'utf8');

    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'replace',
      content: 'replacement\n',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe('replacement\n');
    expect(result.bytesWritten).toBe(
      Buffer.byteLength('replacement\n', 'utf8'),
    );
  });

  it('writes to the global ~/.qwen directory when scope=global', async () => {
    const result = await writeWorkspaceContextFile({
      scope: 'global',
      mode: 'append',
      content: '- global entry',
      projectRoot: workspace,
    });

    expect(result.filePath).toBe(
      path.join(globalDir, DEFAULT_CONTEXT_FILENAME),
    );
    expect(getGlobalQwenDirSpy).toHaveBeenCalled();
    const written = await fs.readFile(result.filePath, 'utf8');
    expect(written).toBe(`${MEMORY_SECTION_HEADER}\n- global entry\n`);
  });

  it('creates the parent directory when missing', async () => {
    const nested = path.join(workspace, 'nested', 'deep');
    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- entry',
      projectRoot: nested,
    });

    const created = await fs.readFile(
      path.join(nested, DEFAULT_CONTEXT_FILENAME),
      'utf8',
    );
    expect(created).toContain('- entry');
  });

  it('rejects non-absolute projectRoot', async () => {
    await expect(
      writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'append',
        content: 'x',
        projectRoot: 'relative/path',
      }),
    ).rejects.toThrow(/projectRoot must be absolute/);
  });

  it('skips the write entirely when append content is whitespace only', async () => {
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    await fs.writeFile(filePath, 'preserved\n', 'utf8');

    // Spy on `fs.writeFile` rather than relying on filesystem mtime
    // resolution. macOS HFS+ has 1-second mtime resolution; a quick
    // re-write inside the same second would leave `mtimeMs` unchanged
    // and let a regression slip through. The spy makes the
    // "writeFile was never called" invariant explicit and platform-
    // independent.
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    try {
      const result = await writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'append',
        content: '\n\n',
        projectRoot: workspace,
      });

      const written = await fs.readFile(filePath, 'utf8');
      expect(written).toBe('preserved\n');
      // `bytesWritten: 0` because the no-op short-circuit wrote zero
      // bytes — NOT the existing file size. Earlier revisions returned
      // `stat.size` here, which conflated two semantics and let
      // clients accumulating `sum(bytesWritten)` count the existing
      // file every whitespace POST.
      expect(result.bytesWritten).toBe(0);
      expect(result.changed).toBe(false);
      // The no-op short-circuit must not call writeFile at all.
      expect(writeFileSpy).not.toHaveBeenCalled();
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('serializes concurrent appends so no entry is lost', async () => {
    // Spawn 10 parallel appends with unique content. Without the
    // per-file mutex, the read-compose-write race in
    // `composeAppendedContent` lets later writes overwrite earlier
    // ones — at least one entry would be missing from the final file.
    const PARALLEL = 10;
    const writes = Array.from({ length: PARALLEL }, (_, i) =>
      writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'append',
        content: `- entry ${i}`,
        projectRoot: workspace,
      }),
    );
    const results = await Promise.all(writes);

    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    const written = await fs.readFile(filePath, 'utf8');
    for (let i = 0; i < PARALLEL; i++) {
      expect(written).toContain(`- entry ${i}`);
    }
    // All N writes report changed; none short-circuited.
    expect(results.every((r) => r.changed)).toBe(true);
    // Exactly one section header — the lock keeps the
    // "is-section-present" check consistent across the group, so we
    // never insert duplicate headers.
    const headerCount = written.split(MEMORY_SECTION_HEADER).length - 1;
    expect(headerCount).toBe(1);
  });

  it('marks `changed: false` for a no-op append against a missing file', async () => {
    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '   ',
      projectRoot: workspace,
    });
    expect(result.changed).toBe(false);
    expect(result.bytesWritten).toBe(0);
    await expect(
      fs.access(path.join(workspace, DEFAULT_CONTEXT_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inserts new entries inside the MEMORY section, not past a later heading', async () => {
    // File where the MEMORY section is followed by other prose.
    // Without the section-boundary fix the new entry would be
    // appended to EOF, landing it inside the `## post` section.
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    const initial = `# pre\n\n${MEMORY_SECTION_HEADER}\n- first\n\n## post\nstuff\n`;
    await fs.writeFile(filePath, initial, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- second',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe(
      `# pre\n\n${MEMORY_SECTION_HEADER}\n- first\n- second\n\n## post\nstuff\n`,
    );
    // `- second` must be inside the memory block, not after `stuff`.
    const memorySection = written.indexOf(MEMORY_SECTION_HEADER);
    const postSection = written.indexOf('## post');
    const secondIdx = written.indexOf('- second');
    expect(secondIdx).toBeGreaterThan(memorySection);
    expect(secondIdx).toBeLessThan(postSection);
  });

  it('does not split a memory entry that contains `## ` inside a fenced code block', async () => {
    // Round-7 [Critical] glm-5.1: the `\n## ` boundary heuristic was
    // matching `## ` lines INSIDE user-authored fenced code blocks
    // (common in QWEN.md memory entries that quote API docs with
    // markdown headings). The old impl would insert the new entry
    // mid-fence, splitting the existing entry. Code-fence-aware
    // detection skips matches inside ``` ``` `` ` blocks.
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    const fencedEntry = [
      `${MEMORY_SECTION_HEADER}`,
      '- API example:',
      '```markdown',
      '## Request Body',
      'POST /api/thing',
      '```',
      '',
    ].join('\n');
    await fs.writeFile(filePath, fencedEntry, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- next entry',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    // The new entry must land AFTER the fence, not inside it.
    const fenceClose = written.lastIndexOf('```');
    const newEntry = written.indexOf('- next entry');
    expect(newEntry).toBeGreaterThan(fenceClose);
    // The fenced `## Request Body` must still be intact (no insert
    // before / inside the code block).
    expect(written).toContain(
      '```markdown\n## Request Body\nPOST /api/thing\n```',
    );
  });

  it('still respects real `## ` headings outside code fences', async () => {
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    // Memory section, then a fenced `## ` (must be skipped), then a
    // real `## post` heading (must be honored as the boundary).
    const initial = [
      `${MEMORY_SECTION_HEADER}`,
      '- existing',
      '```',
      '## fake heading inside fence',
      '```',
      '',
      '## post',
      'tail',
      '',
    ].join('\n');
    await fs.writeFile(filePath, initial, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- new',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    const realPost = written.indexOf('## post');
    const newEntry = written.indexOf('- new');
    expect(newEntry).toBeLessThan(realPost);
    expect(newEntry).toBeGreaterThan(written.indexOf('- existing'));
  });

  it('appends to EOF when the MEMORY section is the last block', async () => {
    // Sanity: when no later heading follows, behavior is the
    // pre-fix append-to-end path (still inside the section because
    // the section IS the tail).
    const filePath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
    const initial = `# pre\n\n${MEMORY_SECTION_HEADER}\n- a\n`;
    await fs.writeFile(filePath, initial, 'utf8');

    await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '- b',
      projectRoot: workspace,
    });

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe(`# pre\n\n${MEMORY_SECTION_HEADER}\n- a\n- b\n`);
  });

  it('does not create the parent directory on a no-op append', async () => {
    // Whitespace-only append targeting a non-existent nested path
    // must NOT call fs.mkdir — the no-op detection short-circuits
    // BEFORE acquiring the lock or touching the filesystem. Without
    // this, an empty POST would still bump the parent directory's
    // mtime even though the helper reports `changed: false`.
    const nested = path.join(workspace, 'never-exists');
    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '\n\n',
      projectRoot: nested,
    });
    expect(result.changed).toBe(false);
    await expect(fs.access(nested)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors setGeminiMdFilename overrides so POST targets the same file GET surfaces', async () => {
    // Round-trip the `setGeminiMdFilename` override: with the prior
    // `DEFAULT_CONTEXT_FILENAME` hard-code, a deployment that switched
    // the context filename to `AGENTS.md` saw GET list the new file
    // but POST keep writing to `QWEN.md`. The fix routes
    // `resolveContextFilePath` through `getCurrentGeminiMdFilename()`
    // so both surfaces agree.
    try {
      setGeminiMdFilename(AGENT_CONTEXT_FILENAME);
      const result = await writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'append',
        content: '- entry',
        projectRoot: workspace,
      });
      expect(result.filePath).toBe(
        path.join(workspace, AGENT_CONTEXT_FILENAME),
      );
      const written = await fs.readFile(result.filePath, 'utf8');
      expect(written).toContain('- entry');
      // The legacy QWEN.md must NOT have been written — the prior
      // hard-coded behavior would have created it here.
      await expect(
        fs.access(path.join(workspace, DEFAULT_CONTEXT_FILENAME)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      setGeminiMdFilename(DEFAULT_CONTEXT_FILENAME);
    }
  });

  describe('auto scope', () => {
    let savedFilenames: string | string[];

    beforeEach(() => {
      // Capture whatever the filename list is before we touch it.
      savedFilenames = [DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME];
      setGeminiMdFilename(savedFilenames);
    });

    afterEach(() => {
      setGeminiMdFilename(savedFilenames);
    });

    it('writes to project QWEN.md when one exists at the project root', async () => {
      const projectQwenPath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
      await fs.writeFile(projectQwenPath, '# project\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- memory entry',
        projectRoot: workspace,
      });

      expect(result.filePath).toBe(projectQwenPath);
      const written = await fs.readFile(projectQwenPath, 'utf8');
      expect(written).toContain('- memory entry');
      // Global dir must not have been touched.
      const globalPath = path.join(globalDir, DEFAULT_CONTEXT_FILENAME);
      await expect(fs.access(globalPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('writes to project AGENTS.md when that exists instead of QWEN.md', async () => {
      const agentsPath = path.join(workspace, AGENT_CONTEXT_FILENAME);
      await fs.writeFile(agentsPath, '# agents\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- agents memory',
        projectRoot: workspace,
      });

      expect(result.filePath).toBe(agentsPath);
      const written = await fs.readFile(agentsPath, 'utf8');
      expect(written).toContain('- agents memory');
      // QWEN.md must not be created.
      await expect(
        fs.access(path.join(workspace, DEFAULT_CONTEXT_FILENAME)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to fall back to global when no project context file exists', async () => {
      await expect(
        writeWorkspaceContextFile({
          scope: 'auto',
          mode: 'append',
          content: '- fallback entry',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(
        "scope='auto' is not allowed when auto resolves to the global directory",
      );
      expect(getGlobalQwenDirSpy).toHaveBeenCalled();
    });

    it('prefers QWEN.md over AGENTS.md when both exist (QWEN.md first in filenames list)', async () => {
      const qwenPath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
      const agentsPath = path.join(workspace, AGENT_CONTEXT_FILENAME);
      await fs.writeFile(qwenPath, '# qwen\n', 'utf8');
      await fs.writeFile(agentsPath, '# agents\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- which one?',
        projectRoot: workspace,
      });

      // Should prefer QWEN.md since getAllGeminiMdFilenames returns it first.
      expect(result.filePath).toBe(qwenPath);
      const qwenContent = await fs.readFile(qwenPath, 'utf8');
      expect(qwenContent).toContain('- which one?');
    });

    it('falls back to local file when no committed context exists', async () => {
      const localPath = path.join(workspace, QWEN_DIR, LOCAL_CONTEXT_FILENAME);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '# local\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- auto local entry',
        projectRoot: workspace,
      });

      expect(result.filePath).toBe(localPath);
      const written = await fs.readFile(localPath, 'utf8');
      expect(written).toContain('- auto local entry');

      // The path-based guard must also gitignore the auto-resolved local
      // file, mirroring explicit scope='local' behavior.
      const gitignore = await fs.readFile(
        path.join(workspace, '.gitignore'),
        'utf8',
      );
      expect(gitignore).toContain(`${QWEN_DIR}/${LOCAL_CONTEXT_FILENAME}`);
    });

    it('prefers committed QWEN.md over local file in auto scope', async () => {
      const qwenPath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
      const localPath = path.join(workspace, QWEN_DIR, LOCAL_CONTEXT_FILENAME);
      await fs.writeFile(qwenPath, '# qwen\n', 'utf8');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '# local\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- which scope?',
        projectRoot: workspace,
      });

      expect(result.filePath).toBe(qwenPath);
    });
  });

  describe('local scope', () => {
    it('writes to .qwen/QWEN.local.md', async () => {
      const result = await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- local entry',
        projectRoot: workspace,
      });

      const expectedPath = path.join(
        workspace,
        QWEN_DIR,
        LOCAL_CONTEXT_FILENAME,
      );
      expect(result.filePath).toBe(expectedPath);
      const written = await fs.readFile(expectedPath, 'utf8');
      expect(written).toBe(`${MEMORY_SECTION_HEADER}\n- local entry\n`);
    });

    it('creates the .qwen directory if missing', async () => {
      const qwenDir = path.join(workspace, QWEN_DIR);
      await expect(fs.access(qwenDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- created',
        projectRoot: workspace,
      });

      const stat = await fs.stat(qwenDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('adds .qwen/QWEN.local.md to .gitignore on first write', async () => {
      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- local entry',
        projectRoot: workspace,
      });

      const gitignore = await fs.readFile(
        path.join(workspace, '.gitignore'),
        'utf8',
      );
      expect(gitignore).toContain(`${QWEN_DIR}/${LOCAL_CONTEXT_FILENAME}`);
    });

    it('does not duplicate the gitignore entry on subsequent writes', async () => {
      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- first',
        projectRoot: workspace,
      });
      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- second',
        projectRoot: workspace,
      });

      const gitignore = await fs.readFile(
        path.join(workspace, '.gitignore'),
        'utf8',
      );
      const count = gitignore
        .split('\n')
        .filter(
          (l) => l.trim() === `${QWEN_DIR}/${LOCAL_CONTEXT_FILENAME}`,
        ).length;
      expect(count).toBe(1);
    });
  });

  describe('monorepo path resolution', () => {
    it('resolves local scope to git root when projectRoot is a subdirectory', async () => {
      const gitRoot = path.join(tmpRoot, 'repo');
      const subWorkspace = path.join(gitRoot, 'packages', 'cli');
      await fs.mkdir(subWorkspace, { recursive: true });
      await fs.mkdir(path.join(gitRoot, '.git'), { recursive: true });
      await fs.writeFile(path.join(gitRoot, '.git', 'HEAD'), 'ref: main\n');

      const result = await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- monorepo local entry',
        projectRoot: subWorkspace,
      });

      expect(result.filePath).toBe(
        path.join(gitRoot, QWEN_DIR, LOCAL_CONTEXT_FILENAME),
      );
      expect(result.resolvedScope).toBe('local');

      const written = await fs.readFile(result.filePath, 'utf8');
      expect(written).toContain('- monorepo local entry');

      // .gitignore should be at git root, not the subdirectory
      const gitignore = await fs.readFile(
        path.join(gitRoot, '.gitignore'),
        'utf8',
      );
      expect(gitignore).toContain(`${QWEN_DIR}/${LOCAL_CONTEXT_FILENAME}`);
    });

    it('resolves auto to local file at git root when no committed file exists', async () => {
      const gitRoot = path.join(tmpRoot, 'repo');
      const subWorkspace = path.join(gitRoot, 'packages', 'cli');
      await fs.mkdir(subWorkspace, { recursive: true });
      await fs.mkdir(path.join(gitRoot, '.git'), { recursive: true });
      await fs.writeFile(path.join(gitRoot, '.git', 'HEAD'), 'ref: main\n');

      const localPath = path.join(gitRoot, QWEN_DIR, LOCAL_CONTEXT_FILENAME);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '# local\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- auto local entry',
        projectRoot: subWorkspace,
      });

      expect(result.filePath).toBe(localPath);
      expect(result.resolvedScope).toBe('local');
    });

    it('falls back to projectRoot when no git repo exists', async () => {
      // workspace is already a tmpdir with no .git parent
      const result = await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- no git entry',
        projectRoot: workspace,
      });

      expect(result.filePath).toBe(
        path.join(workspace, QWEN_DIR, LOCAL_CONTEXT_FILENAME),
      );
      expect(result.resolvedScope).toBe('local');
    });
  });

  describe('resolvedScope', () => {
    it('returns resolvedScope matching the requested scope for workspace', async () => {
      const result = await writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'append',
        content: '- workspace entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('workspace');
    });

    it('returns resolvedScope matching the requested scope for global', async () => {
      const result = await writeWorkspaceContextFile({
        scope: 'global',
        mode: 'append',
        content: '- global entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('global');
    });

    it('returns resolvedScope matching the requested scope for local', async () => {
      const result = await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- local entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('local');
    });

    it('resolves auto to workspace when project QWEN.md exists', async () => {
      await fs.writeFile(
        path.join(workspace, DEFAULT_CONTEXT_FILENAME),
        '# project\n',
        'utf8',
      );

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- auto workspace entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('workspace');
      expect(result.filePath).toBe(
        path.join(workspace, DEFAULT_CONTEXT_FILENAME),
      );
    });

    it('resolves auto to local when only local file exists', async () => {
      const localPath = getLocalContextFilePath(workspace);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '# local\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'append',
        content: '- auto local entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('local');
      expect(result.filePath).toBe(localPath);
    });

    it('returns resolvedScope matching explicit global writes', async () => {
      const result = await writeWorkspaceContextFile({
        scope: 'global',
        mode: 'append',
        content: '- explicit global entry',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('global');
      expect(result.filePath).toBe(
        path.join(globalDir, DEFAULT_CONTEXT_FILENAME),
      );
    });
  });

  describe('auto scope safety', () => {
    it('refuses mode=replace when auto resolves to global', async () => {
      await expect(
        writeWorkspaceContextFile({
          scope: 'auto',
          mode: 'replace',
          content: '- dangerous replace',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(
        "scope='auto' is not allowed when auto resolves to the global directory",
      );
    });

    it('refuses mode=append when auto resolves to global', async () => {
      await expect(
        writeWorkspaceContextFile({
          scope: 'auto',
          mode: 'append',
          content: '- dangerous append',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(
        "scope='auto' is not allowed when auto resolves to the global directory",
      );
    });

    it('allows mode=replace when auto resolves to workspace', async () => {
      await fs.writeFile(
        path.join(workspace, DEFAULT_CONTEXT_FILENAME),
        '# project\n',
        'utf8',
      );

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'replace',
        content: '- replaced',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('workspace');
      const written = await fs.readFile(result.filePath, 'utf8');
      expect(written).toBe('- replaced');
    });

    it('allows mode=replace when auto resolves to local', async () => {
      const localPath = getLocalContextFilePath(workspace);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, '# local\n', 'utf8');

      const result = await writeWorkspaceContextFile({
        scope: 'auto',
        mode: 'replace',
        content: '- replaced local',
        projectRoot: workspace,
      });

      expect(result.resolvedScope).toBe('local');
      const written = await fs.readFile(result.filePath, 'utf8');
      expect(written).toBe('- replaced local');
    });
  });

  describe('symlink safety', () => {
    it('skips gitignore update when .gitignore is a symlink', async () => {
      // Create a target file for the symlink
      const targetFile = path.join(workspace, 'gitignore-target');
      await fs.writeFile(targetFile, 'original\n', 'utf8');

      // Create .gitignore as a symlink to the target
      const gitignorePath = path.join(workspace, '.gitignore');
      fsSync.symlinkSync(targetFile, gitignorePath);

      // Write with local scope — should NOT follow the symlink
      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- local entry',
        projectRoot: workspace,
      });

      // The target file should be unchanged
      const targetContent = await fs.readFile(targetFile, 'utf8');
      expect(targetContent).toBe('original\n');

      // The local file should still be written
      const localPath = getLocalContextFilePath(workspace);
      await expect(fs.access(localPath)).resolves.toBeUndefined();
    });

    it('updates .gitignore normally when it is a regular file', async () => {
      // Create a regular .gitignore
      await fs.writeFile(
        path.join(workspace, '.gitignore'),
        '# ignore\n',
        'utf8',
      );

      await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- local entry',
        projectRoot: workspace,
      });

      const gitignore = await fs.readFile(
        path.join(workspace, '.gitignore'),
        'utf8',
      );
      expect(gitignore).toContain(`${QWEN_DIR}/${LOCAL_CONTEXT_FILENAME}`);
    });

    it('refuses to write when the target file is a symlink', async () => {
      const targetFile = path.join(tmpRoot, 'symlink-target');
      await fs.writeFile(targetFile, 'original\n', 'utf8');

      const localPath = getLocalContextFilePath(workspace);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      fsSync.symlinkSync(targetFile, localPath);

      await expect(
        writeWorkspaceContextFile({
          scope: 'local',
          mode: 'append',
          content: '- entry',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(/is a symbolic link/);

      // The symlink target must be untouched
      const targetContent = await fs.readFile(targetFile, 'utf8');
      expect(targetContent).toBe('original\n');
    });

    it('refuses to write local memory when .qwen is a symlink', async () => {
      const targetDir = path.join(tmpRoot, 'symlink-target-dir');
      await fs.mkdir(targetDir, { recursive: true });
      fsSync.symlinkSync(targetDir, path.join(workspace, QWEN_DIR), 'dir');

      await expect(
        writeWorkspaceContextFile({
          scope: 'local',
          mode: 'append',
          content: '- entry',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(/is a symlink/);

      await expect(
        fs.access(path.join(targetDir, LOCAL_CONTEXT_FILENAME)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to write in replace mode when target is a symlink', async () => {
      const targetFile = path.join(tmpRoot, 'symlink-target');
      await fs.writeFile(targetFile, 'original\n', 'utf8');

      const qwenPath = path.join(workspace, DEFAULT_CONTEXT_FILENAME);
      fsSync.symlinkSync(targetFile, qwenPath);

      await expect(
        writeWorkspaceContextFile({
          scope: 'workspace',
          mode: 'replace',
          content: 'replacement',
          projectRoot: workspace,
        }),
      ).rejects.toThrow(/is a symbolic link/);
    });

    it('allows write when target does not exist (no symlink)', async () => {
      const localPath = getLocalContextFilePath(workspace);
      // No pre-existing file, no symlink — should succeed
      const result = await writeWorkspaceContextFile({
        scope: 'local',
        mode: 'append',
        content: '- fresh entry',
        projectRoot: workspace,
      });

      expect(result.changed).toBe(true);
      const written = await fs.readFile(localPath, 'utf8');
      expect(written).toContain('- fresh entry');
    });
  });
});
