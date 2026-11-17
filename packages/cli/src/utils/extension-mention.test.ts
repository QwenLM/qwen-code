/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extension } from '@qwen-code/qwen-code-core';
import {
  buildExtensionContextText,
  buildExtensionMentionContext,
  EXTENSION_CONTEXT_FILE_CAP,
} from './extension-mention.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('buildExtensionContextText', () => {
  it('advertises extension skills under their registered name', () => {
    const extension = {
      name: 'rust',
      config: { name: 'rust' },
      skills: [{ name: 'pdf' }],
    } as unknown as Extension;

    const skillsLine = buildExtensionContextText(extension)
      .split('\n')
      .find((line) => line.startsWith('- Skills:'));

    expect(skillsLine).toBe('- Skills: rust:pdf (invoke via /<skill-name>)');
  });
});

describe('buildExtensionMentionContext', () => {
  let root: string;
  let extension: Extension;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-mention-'));
    const extensionPath = path.join(root, 'extension');
    await fs.mkdir(extensionPath);
    const contextFiles = ['first.md', 'second.md', 'third.md'].map((name) =>
      path.join(extensionPath, name),
    );
    await Promise.all(
      contextFiles.map((file, index) =>
        fs.writeFile(file, `file-${index}:` + 'x'.repeat(1000)),
      ),
    );
    extension = {
      name: 'sample',
      path: extensionPath,
      config: { name: 'sample' },
      contextFiles,
    } as Extension;
    vi.mocked(fs.readFile).mockClear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not read files when the shared budget is already exhausted', async () => {
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 0,
    });

    expect(result).toEqual({
      text: buildExtensionContextText(extension),
      remainingBudget: 0,
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('does not read later files after consuming the remaining budget', async () => {
    const onDebugMessage = vi.fn();
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 32,
      onDebugMessage,
    });

    expect(result.text).toContain('file-0:');
    expect(result.text).toContain('... (truncated)');
    expect(result.text).not.toContain('file-1:');
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(onDebugMessage).toHaveBeenCalledWith(
      'Extension context budget exhausted, skipping remaining files.',
    );
  });

  it('continues past missing and empty files without spending the budget', async () => {
    await fs.unlink(extension.contextFiles[0]);
    await fs.writeFile(extension.contextFiles[1], ' \n\t');
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 2000,
    });

    expect(result.text).toContain('file-2:');
    expect(result.remainingBudget).toBe(993);
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });

  it('continues after a read failure and forwards the abort signal', async () => {
    const signal = new AbortController().signal;
    const onDebugMessage = vi.fn();
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('read failed'));
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 100,
      signal,
      onDebugMessage,
    });

    expect(result.text).toContain('file-1:');
    expect(result.text).not.toContain('file-0:');
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(fs.readFile).toHaveBeenLastCalledWith(
      await fs.realpath(extension.contextFiles[1]),
      { encoding: 'utf-8', signal },
    );
    expect(onDebugMessage).toHaveBeenCalledWith(
      `Failed to read extension context file ${extension.contextFiles[0]}: read failed`,
    );
  });

  it('skips files outside the extension directory before reading their content', async () => {
    const outsideFile = path.join(root, 'outside.md');
    await fs.writeFile(outsideFile, 'outside content');
    extension.contextFiles.unshift(outsideFile);
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 100,
    });

    expect(result.text).toContain('file-0:');
    expect(result.text).not.toContain('outside content');
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('preserves per-file truncation and the order of usable context files', async () => {
    const firstContent = 'x'.repeat(EXTENSION_CONTEXT_FILE_CAP + 1);
    await fs.writeFile(extension.contextFiles[0], firstContent);
    await fs.writeFile(extension.contextFiles[1], 'second file');
    extension.contextFiles.pop();
    const cappedContent =
      firstContent.slice(0, EXTENSION_CONTEXT_FILE_CAP) + '\n... (truncated)';
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: 100_000,
    });

    expect(result.text).toBe(
      `${buildExtensionContextText(extension)}\n\n${cappedContent}\n\nsecond file`,
    );
    expect(result.remainingBudget).toBe(
      100_000 - cappedContent.length - 'second file'.length,
    );
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });
});
