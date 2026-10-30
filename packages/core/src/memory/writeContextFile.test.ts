/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  MEMORY_SECTION_HEADER,
  setMemoryFilename,
} from '../utils/memory-constants.js';
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

  const append = (content: string, projectRoot = workspace) =>
    writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content,
      projectRoot,
    });
  const contextPath = () => path.join(workspace, DEFAULT_CONTEXT_FILENAME);
  const readContext = () => fs.readFile(contextPath(), 'utf8');
  /** Seeds the workspace context file with `initial`, appends, reads back. */
  const appendTo = async (initial: string, content: string) => {
    await fs.writeFile(contextPath(), initial, 'utf8');
    await append(content);
    return readContext();
  };

  it('creates QWEN.md with a fresh section header on first append', async () => {
    const result = await append('- first entry');

    expect(result.filePath).toBe(contextPath());
    const written = await fs.readFile(result.filePath, 'utf8');
    expect(written).toBe(`${MEMORY_SECTION_HEADER}\n- first entry\n`);
    expect(result.bytesWritten).toBe(Buffer.byteLength(written, 'utf8'));
  });

  it('appends under existing section header', async () => {
    const initial = `# project notes\n\n${MEMORY_SECTION_HEADER}\n- first entry\n`;
    const written = await appendTo(initial, '- second entry');
    expect(written).toBe(
      `# project notes\n\n${MEMORY_SECTION_HEADER}\n- first entry\n- second entry\n`,
    );
  });

  it('inserts a section header when file lacks one', async () => {
    const written = await appendTo('# project notes\n', '- entry');
    expect(written).toBe(
      `# project notes\n\n${MEMORY_SECTION_HEADER}\n- entry\n`,
    );
  });

  it('replaces file contents in replace mode', async () => {
    await fs.writeFile(contextPath(), 'old contents\n', 'utf8');

    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'replace',
      content: 'replacement\n',
      projectRoot: workspace,
    });

    expect(await readContext()).toBe('replacement\n');
    expect(result.bytesWritten).toBe(
      Buffer.byteLength('replacement\n', 'utf8'),
    );
  });

  it('rechecks the generation immediately before writing', async () => {
    const assertCanCommit = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('generation closed');
      });

    await expect(
      writeWorkspaceContextFile({
        scope: 'workspace',
        mode: 'replace',
        content: 'replacement\n',
        projectRoot: workspace,
        assertCanCommit,
      }),
    ).rejects.toThrow('generation closed');

    expect(assertCanCommit).toHaveBeenCalledTimes(2);
    await expect(fs.access(contextPath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
    await append('- entry', nested);

    const created = await fs.readFile(
      path.join(nested, DEFAULT_CONTEXT_FILENAME),
      'utf8',
    );
    expect(created).toContain('- entry');
  });

  it('rejects non-absolute projectRoot', async () => {
    await expect(append('x', 'relative/path')).rejects.toThrow(
      /projectRoot must be absolute/,
    );
  });

  it('skips the write entirely when append content is whitespace only', async () => {
    await fs.writeFile(contextPath(), 'preserved\n', 'utf8');

    // Spy on `fs.writeFile` rather than mtime: HFS+ has 1-second mtime
    // resolution, so a same-second re-write would slip through unnoticed.
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    try {
      const result = await append('\n\n');

      expect(await readContext()).toBe('preserved\n');
      // The no-op wrote zero bytes, NOT the existing file size: returning
      // `stat.size` (earlier revisions) made clients summing bytesWritten
      // count the existing file on every whitespace POST.
      expect(result.bytesWritten).toBe(0);
      expect(result.changed).toBe(false);
      // The no-op short-circuit must not call writeFile at all.
      expect(writeFileSpy).not.toHaveBeenCalled();
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('serializes concurrent appends so no entry is lost', async () => {
    // Without the per-file mutex, the read-compose-write race in
    // `composeAppendedContent` lets later writes overwrite earlier ones.
    const PARALLEL = 10;
    const writes = Array.from({ length: PARALLEL }, (_, i) =>
      append(`- entry ${i}`),
    );
    const results = await Promise.all(writes);

    const written = await readContext();
    for (let i = 0; i < PARALLEL; i++) {
      expect(written).toContain(`- entry ${i}`);
    }
    // All N writes report changed; none short-circuited.
    expect(results.every((r) => r.changed)).toBe(true);
    // Exactly one section header: the lock keeps the "is-section-present"
    // check consistent, so no duplicate headers.
    const headerCount = written.split(MEMORY_SECTION_HEADER).length - 1;
    expect(headerCount).toBe(1);
  });

  it('marks `changed: false` for a no-op append against a missing file', async () => {
    const result = await append('   ');
    expect(result.changed).toBe(false);
    expect(result.bytesWritten).toBe(0);
    await expect(fs.access(contextPath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('inserts new entries inside the MEMORY section, not past a later heading', async () => {
    // Without the section-boundary fix the new entry would be appended to
    // EOF, landing inside the `## post` section that follows MEMORY.
    const initial = `# pre\n\n${MEMORY_SECTION_HEADER}\n- first\n\n## post\nstuff\n`;
    const written = await appendTo(initial, '- second');
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
    // Round-7 [Critical] glm-5.1: the `\n## ` boundary heuristic matched
    // `## ` INSIDE fenced code blocks (memory entries quoting API docs) and
    // inserted the new entry mid-fence. Detection now skips fenced matches.
    const fencedEntry = [
      `${MEMORY_SECTION_HEADER}`,
      '- API example:',
      '```markdown',
      '## Request Body',
      'POST /api/thing',
      '```',
      '',
    ].join('\n');
    const written = await appendTo(fencedEntry, '- next entry');
    // The new entry must land AFTER the fence, not inside it.
    const fenceClose = written.lastIndexOf('```');
    const newEntry = written.indexOf('- next entry');
    expect(newEntry).toBeGreaterThan(fenceClose);
    // The fenced `## Request Body` must still be intact.
    expect(written).toContain(
      '```markdown\n## Request Body\nPOST /api/thing\n```',
    );
  });

  it('still respects real `## ` headings outside code fences', async () => {
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
    const written = await appendTo(initial, '- new');
    const realPost = written.indexOf('## post');
    const newEntry = written.indexOf('- new');
    expect(newEntry).toBeLessThan(realPost);
    expect(newEntry).toBeGreaterThan(written.indexOf('- existing'));
  });

  it('appends to EOF when the MEMORY section is the last block', async () => {
    // Sanity: with no later heading, the pre-fix append-to-end path still
    // lands inside the section, because the section IS the tail.
    const initial = `# pre\n\n${MEMORY_SECTION_HEADER}\n- a\n`;
    const written = await appendTo(initial, '- b');
    expect(written).toBe(`# pre\n\n${MEMORY_SECTION_HEADER}\n- a\n- b\n`);
  });

  it('does not create the parent directory on a no-op append', async () => {
    // The no-op short-circuit must run BEFORE the lock or fs.mkdir;
    // otherwise an empty POST bumps the parent dir's mtime while
    // reporting `changed: false`.
    const nested = path.join(workspace, 'never-exists');
    const result = await append('\n\n', nested);
    expect(result.changed).toBe(false);
    await expect(fs.access(nested)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors setMemoryFilename overrides so POST targets the same file GET surfaces', async () => {
    // With the prior `DEFAULT_CONTEXT_FILENAME` hard-code, switching to
    // `AGENTS.md` made GET list it while POST kept writing `QWEN.md`; the
    // fix routes `resolveContextFilePath` through getCurrentMemoryFilename().
    try {
      setMemoryFilename(AGENT_CONTEXT_FILENAME);
      const result = await append('- entry');
      expect(result.filePath).toBe(
        path.join(workspace, AGENT_CONTEXT_FILENAME),
      );
      const written = await fs.readFile(result.filePath, 'utf8');
      expect(written).toContain('- entry');
      // The legacy QWEN.md (the old hard-coded target) must NOT exist.
      await expect(fs.access(contextPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      setMemoryFilename(DEFAULT_CONTEXT_FILENAME);
    }
  });
});
