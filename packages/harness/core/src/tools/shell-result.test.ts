/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatCompletedShellModelContent,
  formatPersistedShellOutput,
  persistShellOutput,
  SHELL_PERSISTED_OUTPUT_MAX_BYTES,
  SHELL_PERSISTED_PREVIEW_CHARS,
} from './shell-result.js';

describe('shell result persistence', () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const dir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'shell-result-test-'),
    );
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fsPromises.rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    ['ASCII', 'a'.repeat(5000), 'a'.repeat(100)],
    ['Chinese', '汉'.repeat(5000), '汉'.repeat(100)],
    ['short header', 'HEADER\n' + 'a'.repeat(5000), 'a'.repeat(100)],
    ['multiline', 'a'.repeat(1001) + '\n' + 'b'.repeat(4000), 'b'.repeat(100)],
    ['exact fit', 'HEADER\n' + '汉'.repeat(1993), '汉'.repeat(100)],
    ['emoji', '😀'.repeat(5000), '😀'.repeat(100)],
    ['surrogate near the end', 'a'.repeat(1999) + '😀rest', '😀rest'],
    ['binary', 'HEADER\n\0��' + 'a'.repeat(5000) + '\nTAIL', '\nTAIL'],
  ])('retains both ends within the preview budget for %s', async (_name, content, tail) => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'preview.output');
    await fsPromises.writeFile(sourcePath, content);
    const artifact = await persistShellOutput({
      sourcePath,
      output: content,
      originalSizeBytes: Buffer.byteLength(content),
      projectTempDir: root,
      sessionId: 'session-id',
    });
    expect(artifact.preview.startsWith(content.slice(0, 8))).toBe(true);
    expect(artifact.preview.endsWith(tail)).toBe(true);
    expect(artifact.preview.length).toBeLessThanOrEqual(SHELL_PERSISTED_PREVIEW_CHARS);
    expect(Buffer.from(artifact.preview).toString('utf8')).toBe(artifact.preview);
    expect(artifact.preview.match(/middle omitted/g) ?? []).toHaveLength(
      content.length > SHELL_PERSISTED_PREVIEW_CHARS ? 1 : 0,
    );
    if (content.length <= SHELL_PERSISTED_PREVIEW_CHARS) expect(artifact.preview).toBe(content);
    expect(formatPersistedShellOutput(artifact)).toContain(
      `Preview (head and tail, up to 2000 characters):\n${artifact.preview}`,
    );
    expect(await fsPromises.readFile(artifact.path, 'utf8')).toBe(content);
  });

  it('keeps the whole 2000-unit budget including one middle marker', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'budget.output');
    const content = 'a'.repeat(3000) + 'z'.repeat(3000);
    await fsPromises.writeFile(sourcePath, content);
    const artifact = await persistShellOutput({ sourcePath, output: content, originalSizeBytes: content.length, projectTempDir: root, sessionId: 'budget' });
    expect(artifact.preview).toBe('a'.repeat(990) + '\n… middle omitted …\n' + 'z'.repeat(990));
    expect(artifact.preview.length).toBe(2000);
  });

  it('keeps both surrogate pairs intact at the head and tail cut points', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'unicode.output');
    const content = 'a'.repeat(989) + '😀' + 'x'.repeat(5000) + '😀' + 'z'.repeat(989);
    await fsPromises.writeFile(sourcePath, content);
    const artifact = await persistShellOutput({ sourcePath, output: content, originalSizeBytes: Buffer.byteLength(content), projectTempDir: root, sessionId: 'unicode' });
    expect(artifact.preview).toBe('a'.repeat(989) + '\n… middle omitted …\n' + 'z'.repeat(989));
    expect(Buffer.from(artifact.preview).toString('utf8')).toBe(artifact.preview);
  });

  it('keeps decoded headers and trailing JSON while preserving every raw binary byte', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'binary.output');
    const bytes = Buffer.concat([
      Buffer.from('HEADER\n'), Buffer.from([0, 255, 254]),
      Buffer.alloc(60_000, 0), Buffer.from('\n{"ok":true}\n'),
    ]);
    await fsPromises.writeFile(sourcePath, bytes);
    const artifact = await persistShellOutput({ sourcePath, output: bytes.subarray(0, 30_000).toString('utf8'), originalSizeBytes: bytes.length, projectTempDir: root, sessionId: 'binary' });
    expect(artifact.preview).toMatch(/^HEADER\n\0��/);
    expect(artifact.preview).toMatch(/\{"ok":true\}\n$/);
    expect(artifact.preview.length).toBeLessThanOrEqual(2000);
    expect(artifact.preview.match(/middle omitted/g)).toHaveLength(1);
    expect(await fsPromises.readFile(artifact.path)).toEqual(bytes);
  });

  it('reuses the independent desktop tail in the model preview', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'tail.output');
    const content = 'HEAD\n' + '中😀'.repeat(10000) + '\nTAIL';
    await fsPromises.writeFile(sourcePath, content);
    const artifact = await persistShellOutput({ sourcePath, output: content, originalSizeBytes: Buffer.byteLength(content), projectTempDir: root, sessionId: 'tail-session' });
    expect(artifact.preview).toMatch(/^HEAD/);
    expect(artifact.preview).toMatch(/TAIL$/);
    expect(artifact.tailPreview).toMatch(/TAIL$/);
    expect(artifact.tailPreview).not.toContain('HEAD');
    expect(artifact.tailPreview).not.toContain('\uFFFD');
    expect(Buffer.byteLength(artifact.tailPreview as string)).toBeLessThanOrEqual(4096);
    expect(formatPersistedShellOutput(artifact)).toContain('TAIL');
  });

  it.each(['HEADER\0\n', '\n'])(
    'keeps trailing JSON when the initial read becomes short after trimming (%j)',
    async (prefix) => {
      const root = await createTempDir();
      const sourcePath = path.join(root, 'blank-middle.output');
      const bytes = Buffer.from(prefix + '\n'.repeat(40_000) + '{"ok":true}\n');
      await fsPromises.writeFile(sourcePath, bytes);
      const output = bytes.subarray(0, 30_000).toString('utf8').trimEnd();
      const artifact = await persistShellOutput({ sourcePath, output, originalSizeBytes: bytes.length, projectTempDir: root, sessionId: 'blank-middle' });
      expect(artifact.preview).toContain('{"ok":true}');
      expect(artifact.preview.length).toBeLessThanOrEqual(2000);
      expect(artifact.preview.match(/middle omitted/g)).toHaveLength(1);
      expect(formatPersistedShellOutput(artifact)).toContain('{"ok":true}');
      expect(await fsPromises.readFile(artifact.path)).toEqual(bytes);
    },
  );

  it('keeps the tail when the supplied initial read is shorter than the preview budget', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'bounded.output');
    const bytes = Buffer.concat([Buffer.from('HEADER\0'), Buffer.alloc(40_000, 255), Buffer.from('TAIL')]);
    await fsPromises.writeFile(sourcePath, bytes);
    const output = bytes.subarray(0, 1000).toString('utf8');
    const artifact = await persistShellOutput({ sourcePath, output, originalSizeBytes: bytes.length, projectTempDir: root, sessionId: 'bounded' });
    expect(artifact.preview).toContain('HEADER\0');
    expect(artifact.preview).toContain('TAIL');
    expect(artifact.preview.length).toBeLessThanOrEqual(2000);
    expect(await fsPromises.readFile(artifact.path)).toEqual(bytes);
  });

  it('atomically promotes output with private permissions and a UTF-8 safe preview', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'task.output');
    const prefix = Buffer.alloc(SHELL_PERSISTED_PREVIEW_CHARS - 1, 'a');
    const content = Buffer.concat([prefix, Buffer.from('😀\nrest')]);
    await fsPromises.writeFile(sourcePath, content);

    const artifact = await persistShellOutput({
      sourcePath,
      output: content.toString('utf8'),
      originalSizeBytes: content.length,
      projectTempDir: root,
      sessionId: 'session/with traversal',
    });

    expect(artifact.originalSizeBytes).toBe(content.length);
    expect(artifact.savedSizeBytes).toBe(content.length);
    expect(artifact.truncated).toBe(false);
    expect(artifact.preview).not.toContain('\uFFFD');
    expect(await fsPromises.readFile(artifact.path)).toEqual(content);
    await expect(fsPromises.stat(sourcePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    if (process.platform !== 'win32') {
      const fileMode = (await fsPromises.stat(artifact.path)).mode & 0o777;
      const directoryMode =
        (await fsPromises.stat(path.dirname(artifact.path))).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(directoryMode).toBe(0o700);
    }
  });

  it('retains only the first 64 MiB and labels the artifact as truncated', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'oversized.output');
    const handle = await fsPromises.open(sourcePath, 'w');
    try {
      await handle.write('preview line\n');
      await handle.truncate(SHELL_PERSISTED_OUTPUT_MAX_BYTES + 1024);
    } finally {
      await handle.close();
    }

    const artifact = await persistShellOutput({
      sourcePath,
      output: 'preview line\n',
      originalSizeBytes: SHELL_PERSISTED_OUTPUT_MAX_BYTES + 1024,
      projectTempDir: root,
      sessionId: 'session-id',
    });

    expect(artifact.truncated).toBe(true);
    expect(artifact.savedSizeBytes).toBe(SHELL_PERSISTED_OUTPUT_MAX_BYTES);
    expect((await fsPromises.stat(artifact.path)).size).toBe(
      SHELL_PERSISTED_OUTPUT_MAX_BYTES,
    );
    expect(formatPersistedShellOutput(artifact)).toContain(
      'only the first 64 MB were saved to:',
    );
    expect(formatPersistedShellOutput(artifact)).not.toContain(
      'Full output saved to:',
    );
  });

  it('preserves every raw byte when cross-device copying encounters short writes', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'binary.output');
    const content = Buffer.concat([
      Buffer.from('HEADER\0中😀'),
      Buffer.alloc(150_000, 255),
      Buffer.from('\nTAIL'),
    ]);
    await fsPromises.writeFile(sourcePath, content);
    vi.spyOn(fsPromises, 'link').mockRejectedValueOnce(
      Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
    );
    const open = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        const write = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) =>
          write(buffer, offset, Math.min(length, 7), position)) as typeof handle.write;
      }
      return handle;
    });

    const artifact = await persistShellOutput({
      sourcePath,
      output: content.subarray(0, 30_000).toString('utf8'),
      originalSizeBytes: content.length,
      projectTempDir: root,
      sessionId: 'short-write',
    });
    expect((await fsPromises.readFile(artifact.path)).equals(content)).toBe(true);
  });

  it('keeps the existing artifact and new source when publication collides', async () => {
    const root = await createTempDir();
    const sourcePath = path.join(root, 'task.output');
    const options = {
      sourcePath,
      output: 'old',
      originalSizeBytes: 3,
      projectTempDir: root,
      sessionId: 'collision',
    };
    await fsPromises.writeFile(sourcePath, 'old');
    const artifact = await persistShellOutput(options);
    await fsPromises.writeFile(sourcePath, 'new');

    await expect(persistShellOutput({ ...options, output: 'new' })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await fsPromises.readFile(artifact.path, 'utf8')).toBe('old');
    expect(await fsPromises.readFile(sourcePath, 'utf8')).toBe('new');
  });

  it('keeps a failed exit status before a persisted output preview', () => {
    const content = formatCompletedShellModelContent({
      kind: 'completed',
      stdout: '',
      stderr: '',
      exitCode: 7,
      signal: null,
      isError: true,
      persistedOutput: {
        path: '/tmp/shell-output.txt',
        originalSizeBytes: 40_000,
        savedSizeBytes: 40_000,
        truncated: false,
        preview: 'large output preview',
      },
    });

    expect(content).toMatch(/^Exit code 7\n/);
    expect(content).toContain('/tmp/shell-output.txt');
  });
});
