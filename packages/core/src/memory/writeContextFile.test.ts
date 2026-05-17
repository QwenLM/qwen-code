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
import { DEFAULT_CONTEXT_FILENAME, MEMORY_SECTION_HEADER } from './const.js';
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
    const before = await fs.stat(filePath);
    // Pause one tick beyond filesystem mtime resolution so a no-op
    // write would be detectable. macOS HFS+ has 1s mtime resolution;
    // ext4 / APFS / NTFS are sub-ms. 30ms is fine for sub-ms FS and
    // the test still asserts equality on HFS+ where the original
    // mtime is at the second boundary.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await writeWorkspaceContextFile({
      scope: 'workspace',
      mode: 'append',
      content: '\n\n',
      projectRoot: workspace,
    });

    const after = await fs.stat(filePath);
    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe('preserved\n');
    expect(result.bytesWritten).toBe(Buffer.byteLength('preserved\n', 'utf8'));
    expect(result.changed).toBe(false);
    // mtime must be unchanged — the helper short-circuited before
    // calling fs.writeFile, so re-write didn't happen.
    expect(after.mtimeMs).toBe(before.mtimeMs);
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
});
