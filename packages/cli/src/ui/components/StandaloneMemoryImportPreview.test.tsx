/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreview } from '../../commands/memory/codex-import.js';
import type {
  MemoryImportPreviewProps,
  MemoryImportResult,
} from './MemoryImportPreview.js';

const harness = vi.hoisted(() => ({
  props: undefined as MemoryImportPreviewProps | undefined,
  launchEditor: vi.fn<(file: string) => Promise<void>>(),
  stdin: undefined as unknown as NodeJS.ReadStream,
  stdout: undefined as unknown as NodeJS.WriteStream,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: (tree: ReactNode) =>
      actual.render(tree, {
        stdin: harness.stdin,
        stdout: harness.stdout,
        stderr: harness.stdout,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      }),
  };
});
vi.mock('../contexts/KeypressContext.js', () => ({
  KeypressProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../hooks/useLaunchEditor.js', () => ({
  useLaunchEditor: () => harness.launchEditor,
}));
vi.mock('./MemoryImportPreview.js', () => ({
  MemoryImportPreview: (props: MemoryImportPreviewProps) => {
    harness.props = props;
    return null;
  },
}));

import { showMemoryImportPreview } from './StandaloneMemoryImportPreview.js';

let temporary: string;
let source: string;
let reviewRoot: string;
let preview: ImportPreview;
let result: Promise<MemoryImportResult | undefined> | undefined;

beforeEach(async () => {
  temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-preview-host-test-'),
  );
  source = path.join(temporary, 'source');
  reviewRoot = path.join(temporary, 'temporary');
  await fs.mkdir(source);
  await fs.mkdir(reviewRoot);
  await fs.writeFile(
    path.join(source, 'MEMORY.md'),
    'Synthetic source unchanged',
  );
  vi.mocked(os.tmpdir).mockReturnValue(reviewRoot);
  harness.props = undefined;
  harness.launchEditor.mockReset().mockResolvedValue(undefined);
  harness.stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  }) as unknown as NodeJS.ReadStream;
  harness.stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;
  preview = {
    dryRun: true,
    sourceDigest: 'synthetic-digest',
    entries: [],
    reviewNotes: [],
    warnings: [],
  };
});

afterEach(async () => {
  harness.props?.onFinish(undefined);
  await result?.catch(() => {});
  result = undefined;
  vi.restoreAllMocks();
  vi.mocked(os.tmpdir).mockReset();
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
  vi.mocked(os.tmpdir).mockImplementation(actualOs.tmpdir);
  await fs.rm(temporary, { recursive: true, force: true });
  harness.stdin.destroy();
  harness.stdout.destroy();
});

async function start() {
  result = showMemoryImportPreview(preview, ['synthetic-entry'], source);
  await vi.waitFor(() => expect(harness.props).toBeDefined());
  return harness.props!;
}

describe('standalone memory preview', () => {
  it('passes import capability and returns the confirmed action without writing', async () => {
    result = showMemoryImportPreview(preview, undefined, source, true);
    await vi.waitFor(() => expect(harness.props).toBeDefined());
    expect(harness.props?.canImport).toBe(true);
    expect(harness.props?.initialSelectedIds).toBeUndefined();
    const action = {
      action: 'import' as const,
      selectedIds: ['synthetic-entry'],
    };
    harness.props?.onFinish(action);
    expect(await result).toEqual(action);
    expect(await fs.readdir(reviewRoot)).toEqual([]);
  });

  it('creates no review file or source changes until full text is requested', async () => {
    const props = await start();
    expect(props.initialSelectedIds).toEqual(['synthetic-entry']);
    expect(await fs.readdir(reviewRoot)).toEqual([]);
    expect(harness.launchEditor).not.toHaveBeenCalled();
    props.onFinish({ action: 'preview', selectedIds: ['synthetic-entry'] });
    expect(await result).toEqual({
      action: 'preview',
      selectedIds: ['synthetic-entry'],
    });
    expect(await fs.readdir(reviewRoot)).toEqual([]);
    expect(await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8')).toBe(
      'Synthetic source unchanged',
    );
  });

  it.each([false, true])(
    'opens a private full-text copy and cleans it on cancel=%s',
    async (cancel) => {
      const props = await start();
      const content = 'Synthetic review\n' + 'long content\n'.repeat(200);
      await props.onOpen(content);
      const file = harness.launchEditor.mock.calls[0][0];
      expect(path.dirname(path.dirname(file))).toBe(
        await fs.realpath(reviewRoot),
      );
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(file, 'utf8')).toBe(content);
      await fs.appendFile(file, 'Synthetic editor modification');
      expect(await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8')).toBe(
        'Synthetic source unchanged',
      );
      props.onFinish(
        cancel
          ? undefined
          : { action: 'preview', selectedIds: ['synthetic-entry'] },
      );
      expect(await result).toEqual(
        cancel
          ? undefined
          : { action: 'preview', selectedIds: ['synthetic-entry'] },
      );
      expect(await fs.readdir(reviewRoot)).toEqual([]);
    },
  );

  it('cleans review copies after editor errors', async () => {
    harness.launchEditor.mockRejectedValue(
      new Error('Synthetic editor failed'),
    );
    const props = await start();
    await expect(props.onOpen('Synthetic body')).rejects.toThrow(
      'Synthetic editor failed',
    );
    expect(await fs.readdir(reviewRoot)).toHaveLength(1);
    props.onFinish(undefined);
    await result;
    expect(await fs.readdir(reviewRoot)).toEqual([]);
  });

  it.each(['source', 'memory', 'git'])(
    'rejects a temporary directory inside %s before creating files',
    async (kind) => {
      if (kind === 'source') {
        vi.mocked(os.tmpdir).mockReturnValue(source);
      } else if (kind === 'git') {
        await fs.mkdir(path.join(reviewRoot, '.git'));
      } else {
        preview.entries = [
          {
            id: 'synthetic-entry',
            name: 'Synthetic memory',
            type: 'project',
            content: 'Synthetic body',
            sourceFile: 'MEMORY.md',
            sourceLine: 1,
            status: 'ready',
            scope: 'project',
            targetRoot: await fs.realpath(reviewRoot),
          },
        ];
      }
      const before = await fs.readdir(temporary, { recursive: true });
      const props = await start();
      await expect(props.onOpen('Synthetic body')).rejects.toThrow(
        'outside Git, source, and native memory',
      );
      expect(harness.launchEditor).not.toHaveBeenCalled();
      expect(await fs.readdir(temporary, { recursive: true })).toEqual(before);
    },
  );
});
