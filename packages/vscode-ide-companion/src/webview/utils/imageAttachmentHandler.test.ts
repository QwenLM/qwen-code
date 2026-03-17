/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetGlobalTempDir } = vi.hoisted(() => ({
  mockGetGlobalTempDir: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalTempDir: mockGetGlobalTempDir,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
  },
}));

import { saveImageToFile } from './imageAttachmentHandler.js';

describe('imageAttachmentHandler', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-image-'));
    mockGetGlobalTempDir.mockReturnValue(tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('stores clipboard images under the global temp clipboard directory', async () => {
    const filePath = await saveImageToFile(
      'data:image/png;base64,YWJj',
      'pasted.png',
    );

    expect(filePath).toBeTruthy();
    expect(filePath).toMatch(
      new RegExp(
        `${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep}clipboard${path.sep}clipboard-\\d+-[a-f0-9-]+\\.png$`,
      ),
    );
    expect(fs.existsSync(filePath as string)).toBe(true);
  });

  it('prunes old clipboard images after saving a new one', async () => {
    const clipboardDir = path.join(tempRoot, 'clipboard');
    fs.mkdirSync(clipboardDir, { recursive: true });

    for (let i = 0; i < 101; i += 1) {
      const filePath = path.join(clipboardDir, `clipboard-${i}.png`);
      fs.writeFileSync(filePath, `image-${i}`);
      const time = new Date(Date.now() - (101 - i) * 1000);
      fs.utimesSync(filePath, time, time);
    }

    await saveImageToFile('data:image/png;base64,YWJj', 'latest.png');

    const clipboardFiles = fs
      .readdirSync(clipboardDir)
      .filter((file) => file.startsWith('clipboard-') && file.endsWith('.png'));

    expect(clipboardFiles.length).toBeLessThanOrEqual(100);
  });

  it('generates unique clipboard file paths for multiple images saved in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);

    const [firstPath, secondPath] = await Promise.all([
      saveImageToFile('data:image/png;base64,YWJj', 'first.png'),
      saveImageToFile('data:image/png;base64,ZGVm', 'second.png'),
    ]);

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(firstPath).not.toBe(secondPath);
  });
});
