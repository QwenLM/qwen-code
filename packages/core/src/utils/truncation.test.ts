/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { truncateAndSaveToFile } from './truncation.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('node:fs/promises');

describe('truncateAndSaveToFile', () => {
  const mockWriteFile = vi.mocked(fs.writeFile);
  const THRESHOLD = 40_000;
  const TRUNCATE_LINES = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return content unchanged if below both threshold and line limit', async () => {
    const content = 'Short content';
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result).toEqual({ content });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should truncate when line limit exceeded even if under character threshold', async () => {
    // 2000 short lines, well under the 40,000 char threshold
    const lines = Array(2000).fill('short');
    const content = lines.join('\n'); // ~12,000 chars, under THRESHOLD
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    expect(content.length).toBeLessThan(THRESHOLD);

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.outputFile).toBe(
      path.join(projectTempDir, `${fileName}.output`),
    );

    const head = Math.floor(TRUNCATE_LINES / 5);
    const beginning = lines.slice(0, head);
    const end = lines.slice(-(TRUNCATE_LINES - head));
    const expectedTruncated =
      beginning.join('\n') +
      '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n' +
      end.join('\n');

    expect(result.content).toContain(
      'Tool output was too large and has been truncated',
    );
    expect(result.content).toContain(expectedTruncated);
  });

  it('should reduce effective lines when line content would exceed character threshold', async () => {
    // 2000 lines of 100 chars each = 200,000 chars, well over THRESHOLD (40,000)
    // Even after truncating to TRUNCATE_LINES (1000), that's 100,000 chars — still over.
    // The effective line count should be reduced to fit within the threshold.
    const lines = Array(2000).fill('x'.repeat(100));
    const content = lines.join('\n');
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.outputFile).toBeDefined();
    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');

    // Extract just the truncated part (after the instructions)
    const truncatedPart = result.content.split(
      'Truncated part of the output:\n',
    )[1];
    // The truncated content (excluding the instructions header) should
    // be roughly within the character threshold.
    expect(truncatedPart.length).toBeLessThan(THRESHOLD * 1.5);

    // With 100 chars/line and 40,000 threshold, effective lines ≈ 400.
    // Verify we have fewer lines than the default TRUNCATE_LINES.
    const truncatedLines = truncatedPart.split('\n');
    expect(truncatedLines.length).toBeLessThan(TRUNCATE_LINES);
  });

  it('should truncate content by lines when line limit is the binding constraint', async () => {
    // 2000 lines of 5 chars each = ~12,000 chars, well under THRESHOLD (40,000)
    // so the line limit (1000) is the binding constraint, not the char threshold.
    const lines = Array(2000).fill('hello');
    const content = lines.join('\n');
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    expect(content.length).toBeLessThan(THRESHOLD);

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.outputFile).toBe(
      path.join(projectTempDir, `${fileName}.output`),
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(projectTempDir, `${fileName}.output`),
      content,
    );

    // Effective lines = min(1000, 40000/5) = 1000 (line limit is binding)
    const head = Math.floor(TRUNCATE_LINES / 5);
    const beginning = lines.slice(0, head);
    const end = lines.slice(-(TRUNCATE_LINES - head));
    const expectedTruncated =
      beginning.join('\n') +
      '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n' +
      end.join('\n');

    expect(result.content).toContain(
      'Tool output was too large and has been truncated',
    );
    expect(result.content).toContain('Truncated part of the output:');
    expect(result.content).toContain(expectedTruncated);
  });

  it('should truncate content with few but very long lines', async () => {
    const content = 'a'.repeat(200_000); // A single very long line
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.outputFile).toBe(
      path.join(projectTempDir, `${fileName}.output`),
    );
    // Full original content is saved to file (no wrapping)
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(projectTempDir, `${fileName}.output`),
      content,
    );

    expect(result.content).toContain(
      'Tool output was too large and has been truncated',
    );
    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');

    // The truncated content should stay near the character threshold
    const truncatedPart = result.content.split(
      'Truncated part of the output:\n',
    )[1];
    expect(truncatedPart.length).toBeLessThan(THRESHOLD * 1.5);
  });

  it('should stay near char threshold even when line lengths vary widely', async () => {
    // Mix of short and very long lines — the old average-based approach
    // would undercount because long lines in the tail blow past the budget.
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(i % 10 === 0 ? 'x'.repeat(5000) : 'short');
    }
    const content = lines.join('\n');
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');

    const truncatedPart = result.content.split(
      'Truncated part of the output:\n',
    )[1];
    // Should stay within ~1.5x the threshold even with variable line lengths
    expect(truncatedPart.length).toBeLessThan(THRESHOLD * 1.5);
  });

  it('should handle file write errors gracefully', async () => {
    const content = 'a'.repeat(2_000_000);
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    mockWriteFile.mockRejectedValue(new Error('File write failed'));

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.outputFile).toBeUndefined();
    expect(result.content).toContain(
      '[Note: Could not save full output to file]',
    );
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('should save to correct file path with file name', async () => {
    const content = 'a'.repeat(200_000);
    const fileName = 'unique-file-123';
    const projectTempDir = '/custom/temp/dir';

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    const expectedPath = path.join(projectTempDir, `${fileName}.output`);
    expect(result.outputFile).toBe(expectedPath);
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content);
  });

  it('should include helpful instructions in truncated message', async () => {
    const content = 'a'.repeat(2_000_000);
    const fileName = 'test-file';
    const projectTempDir = '/tmp';

    mockWriteFile.mockResolvedValue(undefined);

    const result = await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    expect(result.content).toContain(
      'Tool output was too large and has been truncated',
    );
    expect(result.content).toContain('The full output has been saved to:');
    expect(result.content).toContain(
      'To read the complete output, use the read_file tool with the absolute file path above',
    );
    expect(result.content).toContain(
      'The truncated output below shows the beginning and end of the content',
    );
  });

  it('should sanitize fileName to prevent path traversal', async () => {
    const content = 'a'.repeat(200_000);
    const fileName = '../../../../../etc/passwd';
    const projectTempDir = '/tmp/safe_dir';

    mockWriteFile.mockResolvedValue(undefined);

    await truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
    );

    const expectedPath = path.join(projectTempDir, 'passwd.output');
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content);
  });
});
