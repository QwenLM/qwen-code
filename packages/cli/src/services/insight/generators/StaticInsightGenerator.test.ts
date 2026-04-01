/**
 * @license
 * Copyright 2025 proto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { Storage, type Config } from '@qwen-code/qwen-code-core';
import { StaticInsightGenerator } from './StaticInsightGenerator.js';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    access: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    symlink: vi.fn(),
    copyFile: vi.fn(),
  },
}));

describe('StaticInsightGenerator', () => {
  const mockedFs = vi.mocked(fs);
  const mockConfig = {} as Config;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:34:56.000Z'));
    Storage.setRuntimeBaseDir(path.resolve('runtime-output'));
    vi.clearAllMocks();

    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.access.mockRejectedValue(new Error('not found'));
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.unlink.mockRejectedValue(new Error('not found'));
    mockedFs.symlink.mockResolvedValue(undefined);
    mockedFs.copyFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes insights under runtime output directory', async () => {
    const generator = new StaticInsightGenerator(mockConfig);
    const generateInsights = vi.fn().mockResolvedValue({});
    const renderInsightHTML = vi.fn().mockResolvedValue('<html>ok</html>');

    (
      generator as unknown as {
        dataProcessor: { generateInsights: typeof generateInsights };
      }
    ).dataProcessor = { generateInsights };
    (
      generator as unknown as {
        templateRenderer: { renderInsightHTML: typeof renderInsightHTML };
      }
    ).templateRenderer = { renderInsightHTML };

    const projectsDir = path.resolve(
      'workspace',
      'project-a',
      '.qwen',
      'projects',
    );
    const outputDir = path.join(Storage.getRuntimeBaseDir(), 'insights');
    const facetsDir = path.join(outputDir, 'facets');
    const expectedOutputPath = path.join(outputDir, 'insight-2026-03-05.html');

    const outputPath = await generator.generateStaticInsight(projectsDir);

    expect(mockedFs.mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
    expect(mockedFs.mkdir).toHaveBeenCalledWith(facetsDir, { recursive: true });
    expect(generateInsights).toHaveBeenCalledWith(
      projectsDir,
      facetsDir,
      undefined,
    );
    expect(renderInsightHTML).toHaveBeenCalledWith({});
    expect(mockedFs.writeFile).toHaveBeenCalledWith(
      expectedOutputPath,
      '<html>ok</html>',
      'utf-8',
    );
    expect(outputPath).toBe(expectedOutputPath);
  });
});
