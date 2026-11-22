/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  appendWorkspaceInputHistory,
  extractPromptHistoryText,
  getWorkspaceInputHistoryFilePath,
  MAX_WORKSPACE_INPUT_HISTORY_ENTRIES,
  MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS,
  readWorkspaceInputHistory,
} from './workspace-input-history.js';

describe('workspace-input-history', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  let scratch: string;
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-workspace-input-history-'),
    );
    const home = path.join(scratch, 'home');
    workspaceA = path.join(scratch, 'workspace-a');
    workspaceB = path.join(scratch, 'workspace-b');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });
    process.env['QWEN_HOME'] = home;
  });

  afterEach(async () => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('returns empty snapshot when no history file exists', async () => {
    const snapshot = await readWorkspaceInputHistory(workspaceA, 'prompt');
    expect(snapshot.kind).toBe('prompt');
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it('appends, trims, deduplicates to newest, and isolates by workspace', async () => {
    await appendWorkspaceInputHistory(workspaceA, 'prompt', '  first  ');
    await appendWorkspaceInputHistory(workspaceA, 'prompt', 'second');
    await appendWorkspaceInputHistory(workspaceA, 'prompt', 'first');
    await appendWorkspaceInputHistory(workspaceB, 'prompt', 'other-workspace');

    const snapA = await readWorkspaceInputHistory(workspaceA, 'prompt');
    const snapB = await readWorkspaceInputHistory(workspaceB, 'prompt');
    expect(snapA.entries).toEqual(['second', 'first']);
    expect(snapB.entries).toEqual(['other-workspace']);
  });

  it('ignores blank and oversized entries without creating files', async () => {
    expect(
      await appendWorkspaceInputHistory(workspaceA, 'prompt', '   \n\t  '),
    ).toBeNull();
    expect(
      await appendWorkspaceInputHistory(
        workspaceA,
        'prompt',
        'x'.repeat(MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS + 1),
      ),
    ).toBeNull();

    const filePath = getWorkspaceInputHistoryFilePath(workspaceA, 'prompt');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('caps stored entries at MAX_WORKSPACE_INPUT_HISTORY_ENTRIES and honors limit', async () => {
    for (let i = 1; i <= MAX_WORKSPACE_INPUT_HISTORY_ENTRIES + 15; i++) {
      await appendWorkspaceInputHistory(workspaceA, 'prompt', `prompt-${i}`);
    }

    const full = await readWorkspaceInputHistory(workspaceA, 'prompt');
    expect(full.entries).toHaveLength(MAX_WORKSPACE_INPUT_HISTORY_ENTRIES);
    expect(full.entries[0]).toBe('prompt-16');
    expect(full.entries[full.entries.length - 1]).toBe(
      `prompt-${MAX_WORKSPACE_INPUT_HISTORY_ENTRIES + 15}`,
    );

    const limited = await readWorkspaceInputHistory(workspaceA, 'prompt', 3);
    expect(limited.entries).toEqual(['prompt-113', 'prompt-114', 'prompt-115']);
  });

  it('serializes concurrent appends without dropping entries', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendWorkspaceInputHistory(workspaceA, 'prompt', `concurrent-${i}`),
      ),
    );

    const snap = await readWorkspaceInputHistory(workspaceA, 'prompt');
    expect(snap.entries).toHaveLength(20);
    expect(new Set(snap.entries).size).toBe(20);
  });

  it('shares Storage.getHistoryFilePath() in newest-first format for shell history', async () => {
    const shellFile = new Storage(workspaceA).getHistoryFilePath();
    expect(getWorkspaceInputHistoryFilePath(workspaceA, 'shell')).toBe(
      shellFile,
    );

    // Pre-populate as TUI's useShellHistory does (newest-first on disk).
    await fs.mkdir(path.dirname(shellFile), { recursive: true });
    await fs.writeFile(
      shellFile,
      JSON.stringify(['git status', 'ls -la']),
      'utf8',
    );

    const before = await readWorkspaceInputHistory(workspaceA, 'shell');
    expect(before.entries).toEqual(['ls -la', 'git status']);

    await appendWorkspaceInputHistory(workspaceA, 'shell', 'npm test');
    const after = await readWorkspaceInputHistory(workspaceA, 'shell');
    expect(after.entries).toEqual(['ls -la', 'git status', 'npm test']);

    // Disk representation remains newest-first for TUI compatibility.
    const rawOnDisk = JSON.parse(await fs.readFile(shellFile, 'utf8'));
    expect(rawOnDisk).toEqual(['npm test', 'git status', 'ls -la']);
  });

  it('recovers gracefully from malformed history files', async () => {
    const filePath = getWorkspaceInputHistoryFilePath(workspaceA, 'prompt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{not valid json', 'utf8');

    const read = await readWorkspaceInputHistory(workspaceA, 'prompt');
    expect(read.entries).toEqual([]);

    await appendWorkspaceInputHistory(workspaceA, 'prompt', 'recovered');
    const after = await readWorkspaceInputHistory(workspaceA, 'prompt');
    expect(after.entries).toEqual(['recovered']);
  });

  it('extracts submittedPrompt first and falls back to text blocks', () => {
    expect(
      extractPromptHistoryText(
        [{ type: 'text', text: 'expanded file contents' }],
        '  check @src/app.ts  ',
      ),
    ).toBe('check @src/app.ts');

    expect(
      extractPromptHistoryText([
        { type: 'image', data: 'abc' },
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ]),
    ).toBe('line one\nline two');

    expect(extractPromptHistoryText([{ type: 'image', data: 'abc' }])).toBe(
      undefined,
    );
  });
});
