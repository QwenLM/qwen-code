/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Part } from '@google/genai';
import {
  truncateAndSaveToFile,
  truncateToolOutput,
  truncateLlmContent,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
} from './truncation.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { logToolOutputTruncated } from '../telemetry/loggers.js';

vi.mock('node:fs/promises');
vi.mock('../telemetry/loggers.js', () => ({
  logToolOutputTruncated: vi.fn(),
}));

describe('truncateAndSaveToFile', () => {
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockMkdir = vi.mocked(fs.mkdir);
  const THRESHOLD = 40_000;
  const TRUNCATE_LINES = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
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
    expect(mockMkdir).not.toHaveBeenCalled();
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
    expect(mockMkdir).toHaveBeenCalledWith(projectTempDir, {
      recursive: true,
    });

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
    expect(mockMkdir).toHaveBeenCalledWith(projectTempDir, {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(projectTempDir, `${fileName}.output`),
      content,
      { mode: 0o600 },
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
      { mode: 0o600 },
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
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content, {
      mode: 0o600,
    });
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
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content, {
      mode: 0o600,
    });
  });

  describe('keep direction', () => {
    // 2000 lines, line-limit (1000) is the binding constraint so truncation
    // fires. Unique markers at both ends let us assert which side is kept.
    const makeContent = () =>
      [
        'FIRST_UNIQUE_LINE',
        ...Array(1998).fill('filler'),
        'LAST_UNIQUE_LINE',
      ].join('\n');

    beforeEach(() => {
      mockWriteFile.mockResolvedValue(undefined);
    });

    it("keep='head' retains only the beginning", async () => {
      const result = await truncateAndSaveToFile(
        makeContent(),
        'f',
        '/tmp',
        THRESHOLD,
        TRUNCATE_LINES,
        'head',
      );
      expect(result.content).toContain('FIRST_UNIQUE_LINE');
      expect(result.content).not.toContain('LAST_UNIQUE_LINE');
    });

    it("keep='tail' retains only the end", async () => {
      const result = await truncateAndSaveToFile(
        makeContent(),
        'f',
        '/tmp',
        THRESHOLD,
        TRUNCATE_LINES,
        'tail',
      );
      expect(result.content).toContain('LAST_UNIQUE_LINE');
      expect(result.content).not.toContain('FIRST_UNIQUE_LINE');
    });

    it("keep='both' (default) retains both ends", async () => {
      const result = await truncateAndSaveToFile(
        makeContent(),
        'f',
        '/tmp',
        THRESHOLD,
        TRUNCATE_LINES,
      );
      expect(result.content).toContain('FIRST_UNIQUE_LINE');
      expect(result.content).toContain('LAST_UNIQUE_LINE');
    });

    it("keep='tail' does not leak a whole line when the per-line tail budget rounds to zero", async () => {
      // Regression: slice(-0) === slice(0) returned the ENTIRE line when the
      // remaining tail budget for the triggering line was <= ellipsis length.
      // The 58-char C line consumes the tiny budget down to 2, so the 60k B
      // line hits sliceLen=0 and (pre-fix) leaked whole into the preview.
      const content =
        'H'.repeat(50_000) + '\n' + 'B'.repeat(60_000) + '\n' + 'C'.repeat(58);
      const result = await truncateAndSaveToFile(
        content,
        'f',
        '/tmp',
        100,
        TRUNCATE_LINES,
        'tail',
      );
      expect(result.outputFile).toBeDefined();
      // The bound must hold: the 60k line must NOT appear whole in the preview.
      expect(result.content.length).toBeLessThan(2_000);
    });
  });

  describe('token-aware fallback', () => {
    beforeEach(() => {
      mockWriteFile.mockResolvedValue(undefined);
    });

    it('returns original content when truncation would not save space', async () => {
      // Content barely over a tiny threshold: the wrapper (instructions +
      // file pointer) is longer than the original, so truncating wastes
      // effort and loses recoverability for no benefit.
      const content = 'x'.repeat(60);
      const result = await truncateAndSaveToFile(
        content,
        'f',
        '/tmp',
        50,
        1000,
      );

      expect(result).toEqual({ content });
      expect(result.outputFile).toBeUndefined();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('still truncates when the wrapped output is genuinely smaller', async () => {
      // Large content: wrapper is far smaller than the original, so the
      // fallback must NOT trigger.
      const content = 'a'.repeat(2_000_000);
      const result = await truncateAndSaveToFile(
        content,
        'f',
        '/tmp',
        THRESHOLD,
        TRUNCATE_LINES,
      );

      expect(result.outputFile).toBeDefined();
      expect(result.content.length).toBeLessThan(content.length);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe('truncateToolOutput', () => {
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockConfig = {
    getTruncateToolOutputThreshold: () => 25_000,
    getTruncateToolOutputLines: () => 1000,
    storage: { getProjectTempDir: () => '/tmp' },
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('skips storage for a char-only no-op (no temp dir resolution needed)', async () => {
    // Fast path: a char-only budget (lines:Infinity) with content within the
    // char threshold must return without resolving the temp dir, so a
    // storage-less config (e.g. some MCP tests) doesn't blow up.
    const getProjectTempDir = vi.fn(() => '/tmp');
    const cfg = {
      getTruncateToolOutputThreshold: () => 25_000,
      getTruncateToolOutputLines: () => 1000,
      storage: { getProjectTempDir },
    } as unknown as Config;
    const result = await truncateToolOutput(cfg, 'mcp', 'small output', {
      threshold: 500_000,
      lines: Number.POSITIVE_INFINITY,
    });
    expect(result.content).toBe('small output');
    expect(result.outputFile).toBeUndefined();
    expect(getProjectTempDir).not.toHaveBeenCalled();
  });

  it('uses limits.threshold to override the config threshold', async () => {
    // The config threshold (25k) would NOT truncate this ~1k content, but the
    // per-call limits override forces a small threshold that does.
    const content = 'x'.repeat(500) + '\n' + 'y'.repeat(500);
    const result = await truncateToolOutput(mockConfig, 'shell', content, {
      threshold: 100,
      lines: 1000,
    });
    expect(result.outputFile).toBeDefined();
  });

  it('passes promptId into the telemetry event', async () => {
    const content = 'a'.repeat(200_000);
    await truncateToolOutput(
      mockConfig,
      'shell',
      content,
      undefined,
      'prompt-123',
    );
    expect(logToolOutputTruncated).toHaveBeenCalled();
    const event = vi.mocked(logToolOutputTruncated).mock.calls[0][1];
    expect(event.prompt_id).toBe('prompt-123');
  });
});

describe('truncateLlmContent', () => {
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockConfig = {
    getTruncateToolOutputThreshold: () => 25_000,
    getTruncateToolOutputLines: () => 1000,
    storage: { getProjectTempDir: () => '/tmp' },
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('truncates a large string and returns an outputFile', async () => {
    const result = await truncateLlmContent(
      mockConfig,
      'shell',
      'a'.repeat(200_000),
    );
    expect(typeof result.content).toBe('string');
    expect(result.outputFile).toBeDefined();
    expect(result.content as string).toContain(
      'Tool output was too large and has been truncated',
    );
  });

  it('replaces empty output with a no-output marker', async () => {
    const result = await truncateLlmContent(mockConfig, 'shell', '   ');
    expect(result.content).toBe('(shell completed with no output)');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('is idempotent when content is already truncated', async () => {
    const already =
      'Tool output was too large and has been truncated\nThe full output...';
    const result = await truncateLlmContent(mockConfig, 'shell', already);
    expect(result.content).toBe(already);
    expect(result.outputFile).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('truncates text parts but preserves media parts in Part[]', async () => {
    const content: Part[] = [
      { text: 'a'.repeat(200_000) },
      { inlineData: { mimeType: 'image/png', data: 'BASE64DATA' } },
    ];
    const result = await truncateLlmContent(mockConfig, 'shell', content);

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Part[];
    // Media part is preserved verbatim.
    expect(parts.some((p) => p.inlineData?.data === 'BASE64DATA')).toBe(true);
    // Text part is truncated.
    const textPart = parts.find((p) => p.text !== undefined);
    expect(textPart?.text).toContain(
      'Tool output was too large and has been truncated',
    );
    expect(result.outputFile).toBeDefined();
  });

  it('leaves small Part[] text untouched', async () => {
    const content: Part[] = [
      { text: 'small output' },
      { inlineData: { mimeType: 'image/png', data: 'BASE64DATA' } },
    ];
    const result = await truncateLlmContent(mockConfig, 'shell', content);
    expect(result.outputFile).toBeUndefined();
    expect(result.content).toEqual(content);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('bounds Part[] text even when the disk write fails', async () => {
    // On a disk-write failure the Part[] path must still return a bounded
    // preview (matching the string path) rather than leaking the original
    // oversized content back into history.
    mockWriteFile.mockRejectedValue(new Error('ENOSPC'));
    const content: Part[] = [
      { text: 'a'.repeat(200_000) },
      { inlineData: { mimeType: 'image/png', data: 'BASE64DATA' } },
    ];
    const result = await truncateLlmContent(mockConfig, 'shell', content);

    const parts = result.content as Part[];
    const textPart = parts.find((p) => p.text !== undefined);
    // Bounded: far smaller than the 200k original, carrying the failure note.
    expect(textPart?.text?.length ?? 0).toBeLessThan(50_000);
    expect(textPart?.text).toContain('Could not save full output to file');
    // Media part is still preserved.
    expect(parts.some((p) => p.inlineData?.data === 'BASE64DATA')).toBe(true);
  });

  it('still truncates a string when the sentinel appears mid-output, not as a prefix', async () => {
    // Only a genuine truncation prefix (at position 0) should short-circuit.
    // A tool whose own output merely contains the phrase somewhere in the
    // middle must still be truncated — otherwise attacker-controlled output
    // could embed the phrase to bypass the budget.
    const body =
      'normal output line\n'.repeat(100) +
      `${TOOL_OUTPUT_TRUNCATED_PREFIX}\n` +
      'b'.repeat(200_000);
    const result = await truncateLlmContent(mockConfig, 'shell', body);
    expect(result.outputFile).toBeDefined();
    expect(typeof result.content).toBe('string');
  });

  it('truncates a Part[] when the sentinel appears mid-stream, not as a part prefix', async () => {
    // Part[] idempotency must mirror the string path: only a part that STARTS
    // with the sentinel counts as already-truncated. A hostile or echoed part
    // that merely contains the phrase mid-stream must not bypass the budget.
    const content: Part[] = [
      {
        text:
          'normal intro line\n' +
          `${TOOL_OUTPUT_TRUNCATED_PREFIX}\n` +
          'b'.repeat(200_000),
      },
    ];
    const result = await truncateLlmContent(mockConfig, 'mcp_tool', content);
    expect(result.outputFile).toBeDefined();
  });

  it('leaves a Part[] untouched when any part already starts with the sentinel', async () => {
    // A genuinely pre-truncated part (e.g. MCP truncateTextParts output, which
    // starts with the sentinel) must still short-circuit re-truncation even
    // when it is not the first part and the combined content is over budget.
    const content: Part[] = [
      { text: 'small intro' },
      { text: `${TOOL_OUTPUT_TRUNCATED_PREFIX}\n` + 'x'.repeat(200_000) },
    ];
    const result = await truncateLlmContent(mockConfig, 'mcp_tool', content);
    expect(result.outputFile).toBeUndefined();
    expect(result.content).toEqual(content);
  });
});
