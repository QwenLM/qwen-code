/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexImport = vi.hoisted(() => vi.fn());
const showMemoryImportPreview = vi.hoisted(() => vi.fn());
vi.mock('./memory/codex-import.js', () => ({ runCodexImport }));
vi.mock('../ui/components/StandaloneMemoryImportPreview.js', () => ({
  showMemoryImportPreview,
}));

import { runMemoryCommand } from './memory.js';

function makePreview() {
  return {
    dryRun: true,
    sourceDigest: 'synthetic-source-digest',
    entries: [
      {
        id: 'synthetic-entry',
        name: 'Use concise replies',
        type: 'feedback',
        content: 'Prefer concise replies.\nPreserve important caveats.',
        sourceFile: 'memory_summary.md',
        sourceLine: 5,
        updatedAt: '2026-01-02T03:04:05.000Z',
        targetRoot: '/synthetic/runtime/memories',
        status: 'ready',
        scope: 'user',
      },
    ],
    reviewNotes: [
      {
        path: 'extensions/notes/amendment.md',
        content: 'Review this amendment before importing.',
      },
    ],
    warnings: ['Synthetic review warning'],
  };
}

describe('offline memory command', () => {
  let temporaryDirectory: string;
  let stdout: string[];
  let stderr: string[];
  let originalExitCode: typeof process.exitCode;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function tty(stdin: boolean, stdout: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: stdin,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: stdout,
      configurable: true,
    });
  }

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-memory-cli-'),
    );
    stdout = [];
    stderr = [];
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    runCodexImport.mockReset();
    runCodexImport.mockResolvedValue(makePreview());
    showMemoryImportPreview.mockReset().mockResolvedValue(undefined);
    tty(false, false);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  it('prints the resolved main project while preserving the original worktree path', async () => {
    const preview = makePreview();
    runCodexImport.mockResolvedValue({
      ...preview,
      entries: [
        {
          ...preview.entries[0],
          sourceFile: 'MEMORY.md',
          scope: 'project',
          sourceProject: '/work/atlas-one',
          resolvedProject: '/main/atlas',
        },
      ],
    });
    await runMemoryCommand(['memory', 'import', 'codex', '--dry-run']);
    const text = stdout.join('');
    expect(text).toContain('Scope: project (/main/atlas)');
    expect(text).toContain('Source project: /work/atlas-one');
    expect(text).toContain('Resolved project: /main/atlas');
  });

  it.each([false, true])(
    'preserves effective global scope and its reason in JSON=%s previews',
    async (json) => {
      const preview = makePreview();
      const candidate = {
        ...preview.entries[0],
        sourceFile: 'MEMORY.md',
        sourceProject: '/missing/atlas',
        scope: 'user',
        scopeReason: 'Original project directory is missing.',
        status: 'conflict',
        reason: 'Existing native title has different content.',
      };
      runCodexImport.mockResolvedValue({ ...preview, entries: [candidate] });
      await runMemoryCommand([
        'memory',
        'import',
        'codex',
        '--dry-run',
        ...(json ? ['--json'] : []),
      ]);
      const output = stdout.join('');
      if (json) {
        expect(JSON.parse(output).entries).toEqual([candidate]);
      } else {
        expect(output).toContain('Scope: user (global fallback)');
        expect(output).toContain(
          'Global fallback: Original project directory is missing.',
        );
        expect(output).toContain(
          'Reason: Existing native title has different content.',
        );
        expect(output).toContain('Source project: /missing/atlas');
        expect(output).not.toContain('Scope: project');
      }
      expect(showMemoryImportPreview).not.toHaveBeenCalled();
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [stream, descriptor] of [
      [process.stdin, stdinTTY],
      [process.stdout, stdoutTTY],
    ] as const) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    }
    process.exitCode = originalExitCode;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('prints complete review material without selecting an import', async () => {
    await runMemoryCommand(['memory', 'import', 'codex']);

    expect(runCodexImport).toHaveBeenCalledWith({
      source: undefined,
      projectMap: undefined,
      selectedIds: undefined,
      dryRun: false,
      reviewedSource: undefined,
    });
    const text = stdout.join('');
    expect(text).toContain('preview (no writes)');
    expect(text).toContain('synthetic-source-digest');
    expect(text).toContain('[ready] synthetic-entry');
    expect(text).toContain('Scope: user');
    expect(text).toContain('Source date: 2026-01-02T03:04:05.000Z');
    expect(text).toContain(
      'Prefer concise replies.\nPreserve important caveats.',
    );
    expect(text).toContain('Review this amendment before importing.');
    expect(text).toContain('--review-source synthetic-source-digest');
    expect(stderr).toEqual([]);
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });

  it('passes explicit selections, dry-run, mapping, and review digest', async () => {
    const sourceProject = path.join(temporaryDirectory, 'old-project');
    const targetProject = path.join(temporaryDirectory, 'new-project');
    const mapping = { [sourceProject]: targetProject };
    const mapPath = path.join(temporaryDirectory, 'map.json');
    await fs.writeFile(mapPath, JSON.stringify(mapping));

    await runMemoryCommand([
      'memory',
      'import',
      'codex',
      '--source',
      temporaryDirectory,
      '--project-map',
      mapPath,
      '--select',
      'first',
      '--select',
      'second',
      '--dry-run',
      '--review-source',
      'reviewed-digest',
      '--json',
    ]);

    expect(runCodexImport).toHaveBeenCalledWith({
      source: temporaryDirectory,
      projectMap: mapping,
      selectedIds: ['first', 'second'],
      dryRun: true,
      reviewedSource: 'reviewed-digest',
    });
    expect(JSON.parse(stdout.join(''))).toEqual(makePreview());
    expect(stderr).toEqual([]);
  });

  it.each([
    null,
    [],
    'project',
    { relative: '/target' },
    { '/source': 'relative' },
    { '/source': 1 },
  ])(
    'rejects invalid project mapping %j before invoking the importer',
    async (mapping) => {
      const mapPath = path.join(temporaryDirectory, 'map.json');
      await fs.writeFile(mapPath, JSON.stringify(mapping));
      await runMemoryCommand([
        'memory',
        'import',
        'codex',
        '--project-map',
        mapPath,
      ]);
      expect(runCodexImport).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toContain('--project-map must contain');
      expect(stdout).toEqual([]);
    },
  );

  it.each([
    ['memory', 'import', 'other'],
    ['memory', 'import', 'codex', '--unexpected'],
    ['--debug', 'memory', 'import', 'codex'],
    ['memory', 'import', 'codex', '--source'],
  ])('rejects invalid arguments without importing: %j', async (...argv) => {
    await runMemoryCommand(argv);
    expect(runCodexImport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects malformed mapping JSON without echoing its content', async () => {
    const mapPath = path.join(temporaryDirectory, 'map.json');
    await fs.writeFile(mapPath, 'private-synthetic-fragment: invalid');
    await runMemoryCommand([
      'memory',
      'import',
      'codex',
      '--project-map',
      mapPath,
    ]);
    expect(runCodexImport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('--project-map must contain valid JSON.');
    expect(stderr.join('')).not.toContain('private-synthetic-fragment');
  });

  it('does not load the importer for help', async () => {
    await runMemoryCommand(['memory', 'import', 'codex', '--help']);
    expect(runCodexImport).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('escapes display controls without losing review text', async () => {
    const preview = makePreview();
    preview.entries[0].content = 'before\x1b[2Jafter\u202etext\u009b';
    preview.reviewNotes[0].content = 'note\rreplacement';
    runCodexImport.mockResolvedValue(preview);
    await runMemoryCommand(['memory', 'import', 'codex']);
    expect(stdout.join('')).toContain(
      'before\\u001b[2Jafter\\u202etext\\u009b',
    );
    expect(stdout.join('')).toContain('note\\u000dreplacement');

    stdout.length = 0;
    await runMemoryCommand(['memory', 'import', 'codex', '--json']);
    expect(JSON.parse(stdout.join(''))).toEqual(preview);
    expect(stdout.join('')).not.toContain('\u202e');
  });

  it('reports import failures without terminal control execution', async () => {
    runCodexImport.mockRejectedValue(new Error('Invalid ledger\x1b[2J'));
    await runMemoryCommand(['memory', 'import', 'codex']);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Invalid ledger\\u001b[2J');
    expect(stdout).toEqual([]);
  });

  it('applies only a confirmed interactive action using the displayed source digest', async () => {
    tty(true, true);
    const preview = makePreview();
    runCodexImport.mockResolvedValueOnce(preview).mockResolvedValueOnce({
      ...preview,
      dryRun: false,
      entries: [{ ...preview.entries[0], status: 'imported' }],
    });
    showMemoryImportPreview.mockResolvedValue({
      action: 'import',
      selectedIds: ['synthetic-entry'],
    });
    await runMemoryCommand(['memory', 'import', 'codex']);
    expect(showMemoryImportPreview).toHaveBeenCalledWith(
      preview,
      undefined,
      undefined,
      true,
    );
    expect(runCodexImport).toHaveBeenCalledTimes(2);
    expect(runCodexImport).toHaveBeenLastCalledWith({
      source: undefined,
      projectMap: undefined,
      selectedIds: ['synthetic-entry'],
      dryRun: false,
      reviewedSource: preview.sourceDigest,
    });
    expect(stdout.join('')).toContain(
      'Import complete: 1 new memories; 0 already handled.',
    );
    expect(stdout.join('')).not.toContain('Prefer concise replies');
  });

  it.each([undefined, { action: 'preview', selectedIds: ['synthetic-entry'] }])(
    'does not apply cancelled or preview-only interactive results: %j',
    async (result) => {
      tty(true, true);
      showMemoryImportPreview.mockResolvedValue(result);
      await runMemoryCommand(['memory', 'import', 'codex']);
      expect(runCodexImport).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('No memories written');
    },
  );

  it('never applies from an explicit dry-run, even if the UI returns an import action', async () => {
    tty(true, true);
    showMemoryImportPreview.mockResolvedValue({
      action: 'import',
      selectedIds: ['synthetic-entry'],
    });
    await runMemoryCommand(['memory', 'import', 'codex', '--dry-run']);
    expect(showMemoryImportPreview).toHaveBeenCalledWith(
      makePreview(),
      undefined,
      undefined,
      false,
    );
    expect(runCodexImport).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('without --dry-run');
    expect(stdout.join('')).toContain('press i to confirm');
    expect(stdout.join('')).not.toContain('--select synthetic-entry');
  });

  it('initializes the TTY selection from explicit dry-run IDs', async () => {
    tty(true, true);
    await runMemoryCommand([
      'memory',
      'import',
      'codex',
      '--source',
      temporaryDirectory,
      '--select',
      'synthetic-entry',
      '--dry-run',
    ]);
    expect(showMemoryImportPreview).toHaveBeenCalledWith(
      makePreview(),
      ['synthetic-entry'],
      temporaryDirectory,
      false,
    );
    expect(runCodexImport).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('without --dry-run and any --select');
    expect(stdout.join('')).not.toContain('--select synthetic-entry');
  });

  it.each([
    [true, false],
    [false, true],
    [false, false],
  ])(
    'keeps plaintext output for stdin TTY=%s and stdout TTY=%s',
    async (stdin, out) => {
      tty(stdin, out);
      await runMemoryCommand(['memory', 'import', 'codex', '--dry-run']);
      expect(showMemoryImportPreview).not.toHaveBeenCalled();
      expect(stdout.join('')).toContain('Prefer concise replies');
    },
  );

  it('keeps full JSON output even in a TTY', async () => {
    tty(true, true);
    await runMemoryCommand(['memory', 'import', 'codex', '--json']);
    expect(showMemoryImportPreview).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toEqual(makePreview());
  });

  it('does not open the preview UI for an explicit apply', async () => {
    tty(true, true);
    const result = { ...makePreview(), dryRun: false };
    runCodexImport.mockResolvedValue(result);
    await runMemoryCommand([
      'memory',
      'import',
      'codex',
      '--select',
      'synthetic-entry',
    ]);
    expect(showMemoryImportPreview).not.toHaveBeenCalled();
    expect(runCodexImport).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('Codex memory import result');
  });
});
