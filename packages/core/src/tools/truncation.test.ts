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
  persistAndTruncateToolResult,
} from './truncation.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { logToolOutputTruncated } from '../telemetry/loggers.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

vi.mock('node:fs/promises');
vi.mock('../utils/atomicFileWrite.js');
vi.mock('../telemetry/loggers.js', () => ({
  logToolOutputTruncated: vi.fn(),
}));

const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const TRUNCATED_HEADER = 'Tool output was too large and has been truncated';
const PREVIEW_MARKER = 'Truncated part of the output:\n';
const tmpConfig = {
  getTruncateToolOutputThreshold: () => 25_000,
  getTruncateToolOutputLines: () => 1000,
  storage: { getProjectTempDir: () => '/tmp' },
} as unknown as Config;

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

describe('truncateAndSaveToFile', () => {
  const THRESHOLD = 40_000;
  const TRUNCATE_LINES = 1000;
  const OUT_FILE = path.join('/tmp', 'test-file.output');

  /** Truncates at THRESHOLD / TRUNCATE_LINES. */
  const save = (
    content: string,
    fileName = 'test-file',
    projectTempDir = '/tmp',
    keep?: 'head' | 'tail' | 'both',
  ) =>
    truncateAndSaveToFile(
      content,
      fileName,
      projectTempDir,
      THRESHOLD,
      TRUNCATE_LINES,
      keep,
    );
  const truncatedPartOf = (wrapped: string) => wrapped.split(PREVIEW_MARKER)[1];
  /** The 'both' preview of `lines` at TRUNCATE_LINES: a fifth head, the rest tail. */
  const bothEndsOf = (lines: string[]) => {
    const head = Math.floor(TRUNCATE_LINES / 5);
    return (
      lines.slice(0, head).join('\n') +
      '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n' +
      lines.slice(-(TRUNCATE_LINES - head)).join('\n')
    );
  };

  it('uses a preview budget independent from the persistence trigger', async () => {
    const result = await truncateAndSaveToFile(
      'a'.repeat(10_000),
      'separate-preview',
      '/tmp',
      5000,
      Number.POSITIVE_INFINITY,
      'both',
      500,
    );

    expect(result.outputFile).toBe(
      path.join('/tmp', 'separate-preview.output'),
    );
    expect(result.content.length).toBeLessThan(2000);
  });

  it('should return content unchanged if below both threshold and line limit', async () => {
    const content = 'Short content';

    expect(await save(content)).toEqual({ content });
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('should truncate when line limit exceeded even if under character threshold', async () => {
    // 2000 short lines, well under the 40,000 char threshold
    const lines = Array(2000).fill('short');
    const content = lines.join('\n'); // ~12,000 chars, under THRESHOLD

    expect(content.length).toBeLessThan(THRESHOLD);

    const result = await save(content);

    expect(result.outputFile).toBe(OUT_FILE);
    expect(mockMkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(result.content).toContain(TRUNCATED_HEADER);
    expect(result.content).toContain(bothEndsOf(lines));
  });

  it('should reduce effective lines when line content would exceed character threshold', async () => {
    // 2000 lines of 100 chars = 200,000 chars; even cut to TRUNCATE_LINES
    // (1000) that is 100,000, still over THRESHOLD (40,000), so the
    // effective line count must shrink to fit the threshold.
    const result = await save(Array(2000).fill('x'.repeat(100)).join('\n'));

    expect(result.outputFile).toBeDefined();
    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');

    // The truncated part (after the instructions header) should be roughly
    // within the character threshold.
    const truncatedPart = truncatedPartOf(result.content);
    expect(truncatedPart.length).toBeLessThan(THRESHOLD * 1.5);

    // With 100 chars/line and 40,000 threshold, effective lines ≈ 400:
    // fewer than the default TRUNCATE_LINES.
    expect(truncatedPart.split('\n').length).toBeLessThan(TRUNCATE_LINES);
  });

  it('should truncate content by lines when line limit is the binding constraint', async () => {
    // 2000 lines of 5 chars = ~12,000 chars, well under THRESHOLD (40,000),
    // so the line limit (1000) is the binding constraint, not the char threshold.
    const lines = Array(2000).fill('hello');
    const content = lines.join('\n');

    expect(content.length).toBeLessThan(THRESHOLD);

    const result = await save(content);

    expect(result.outputFile).toBe(OUT_FILE);
    expect(mockMkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(OUT_FILE, content, {
      mode: 0o600,
    });

    // Effective lines = min(1000, 40000/5) = 1000 (line limit is binding)
    expect(result.content).toContain(TRUNCATED_HEADER);
    expect(result.content).toContain('Truncated part of the output:');
    expect(result.content).toContain(bothEndsOf(lines));
  });

  it('should truncate content with few but very long lines', async () => {
    const content = 'a'.repeat(200_000); // A single very long line

    const result = await save(content);

    expect(result.outputFile).toBe(OUT_FILE);
    // Full original content is saved to file (no wrapping)
    expect(mockWriteFile).toHaveBeenCalledWith(OUT_FILE, content, {
      mode: 0o600,
    });

    expect(result.content).toContain(TRUNCATED_HEADER);
    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');

    // The truncated content should stay near the character threshold
    expect(truncatedPartOf(result.content).length).toBeLessThan(
      THRESHOLD * 1.5,
    );
  });

  it('should stay near char threshold even when line lengths vary widely', async () => {
    // Mix of short and very long lines — the old average-based approach
    // would undercount because long lines in the tail blow past the budget.
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(i % 10 === 0 ? 'x'.repeat(5000) : 'short');
    }

    const result = await save(lines.join('\n'));

    expect(result.content).toContain('... [CONTENT TRUNCATED] ...');
    // Should stay within ~1.5x the threshold even with variable line lengths
    expect(truncatedPartOf(result.content).length).toBeLessThan(
      THRESHOLD * 1.5,
    );
  });

  it('should handle file write errors gracefully', async () => {
    mockWriteFile.mockRejectedValue(new Error('File write failed'));

    const result = await save('a'.repeat(2_000_000));

    expect(result.outputFile).toBeUndefined();
    expect(result.content).toContain(
      '[Note: Could not save full output to file]',
    );
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('should save to correct file path with file name', async () => {
    const content = 'a'.repeat(200_000);

    const result = await save(content, 'unique-file-123', '/custom/temp/dir');

    const expectedPath = path.join(
      '/custom/temp/dir',
      'unique-file-123.output',
    );
    expect(result.outputFile).toBe(expectedPath);
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content, {
      mode: 0o600,
    });
  });

  it('should include helpful instructions in truncated message', async () => {
    const result = await save('a'.repeat(2_000_000));

    expect(result.content).toContain(TRUNCATED_HEADER);
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

    await save(content, '../../../../../etc/passwd', '/tmp/safe_dir');

    const expectedPath = path.join('/tmp/safe_dir', 'passwd.output');
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, content, {
      mode: 0o600,
    });
  });

  describe('keep direction', () => {
    // 2000 lines, line-limit (1000) is the binding constraint so truncation
    // fires. Unique markers at both ends let us assert which side is kept.
    const content = [
      'FIRST_UNIQUE_LINE',
      ...Array(1998).fill('filler'),
      'LAST_UNIQUE_LINE',
    ].join('\n');

    it.each([
      [
        "keep='head' retains only the beginning",
        'head' as const,
        ['FIRST_UNIQUE_LINE'],
        ['LAST_UNIQUE_LINE'],
      ],
      [
        "keep='tail' retains only the end",
        'tail' as const,
        ['LAST_UNIQUE_LINE'],
        ['FIRST_UNIQUE_LINE'],
      ],
      [
        "keep='both' (default) retains both ends",
        undefined,
        ['FIRST_UNIQUE_LINE', 'LAST_UNIQUE_LINE'],
        [],
      ],
    ])('%s', async (_title, keep, kept, dropped) => {
      const result = await save(content, 'f', '/tmp', keep);
      for (const marker of kept) expect(result.content).toContain(marker);
      for (const marker of dropped) {
        expect(result.content).not.toContain(marker);
      }
    });

    it("keep='tail' does not leak a whole line when the per-line tail budget rounds to zero", async () => {
      // Regression: slice(-0) === slice(0) returned the ENTIRE line when the
      // remaining tail budget for the triggering line was <= ellipsis length.
      // The 58-char C line consumes the tiny budget down to 2, so the 60k B
      // line hits sliceLen=0 and (pre-fix) leaked whole into the preview.
      const result = await truncateAndSaveToFile(
        'H'.repeat(50_000) + '\n' + 'B'.repeat(60_000) + '\n' + 'C'.repeat(58),
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
      const result = await save(content, 'f');

      expect(result.outputFile).toBeDefined();
      expect(result.content.length).toBeLessThan(content.length);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe('persistAndTruncateToolResult', () => {
  it.each([false, true])(
    'keeps container output in its shared store (fallback=%s)',
    async (fallback) => {
      if (fallback) mockWriteFile.mockRejectedValueOnce(new Error('primary'));
      const config = {
        getExecutionEnvironment: () => ({ outputDirectory: '/shared-output' }),
        getToolResultBytesWritten: () => 0,
        trackToolResultBytes: vi.fn(),
        getTruncateToolOutputThreshold: () => 100,
        getTruncateToolOutputLines: () => 100,
        storage: {
          getToolResultsDir: () => '/host-private',
          getProjectTempDir: () => '/host-fallback',
        },
      } as unknown as Config;
      const result = await persistAndTruncateToolResult(
        'container-output',
        'glob',
        'x'.repeat(10_000),
        config,
      );
      expect(path.dirname(result.outputFile!)).toBe(
        path.normalize('/shared-output'),
      );
      expect(result.content).not.toContain('/host-');
    },
  );

  it('returns and accounts for the fallback file after the primary write fails', async () => {
    const trackToolResultBytes = vi.fn();
    vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('primary'));
    const config = {
      getToolResultBytesWritten: () => 0,
      trackToolResultBytes,
      getTruncateToolOutputThreshold: () => 100,
      getTruncateToolOutputLines: () => 100,
      storage: {
        getToolResultsDir: () => '/primary',
        getProjectTempDir: () => '/fallback',
      },
    } as unknown as Config;
    const content = 'x'.repeat(10_000);

    const result = await persistAndTruncateToolResult(
      'call-1',
      'shell',
      content,
      config,
    );

    expect(path.dirname(result.outputFile!)).toBe(path.normalize('/fallback'));
    expect(path.basename(result.outputFile!)).toMatch(
      /^shell_[a-f0-9]+\.output$/,
    );
    expect(result.bytesWritten).toBe(Buffer.byteLength(content));
    expect(trackToolResultBytes).toHaveBeenCalledTimes(1);
    expect(trackToolResultBytes).toHaveBeenCalledWith(
      Buffer.byteLength(content),
    );
  });
});

describe('truncateToolOutput', () => {
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
    const result = await truncateToolOutput(tmpConfig, 'shell', content, {
      threshold: 100,
      lines: 1000,
    });
    expect(result.outputFile).toBeDefined();
  });

  it('passes promptId into the telemetry event', async () => {
    const content = 'a'.repeat(200_000);
    await truncateToolOutput(
      tmpConfig,
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
  const run = (content: string | Part[], toolName = 'shell') =>
    truncateLlmContent(tmpConfig, toolName, content);
  const image = (): Part => ({
    inlineData: { mimeType: 'image/png', data: 'BASE64DATA' },
  });
  const hasImage = (parts: Part[]) =>
    parts.some((p) => p.inlineData?.data === 'BASE64DATA');

  it('truncates a large string and returns an outputFile', async () => {
    const result = await run('a'.repeat(200_000));
    expect(typeof result.content).toBe('string');
    expect(result.outputFile).toBeDefined();
    expect(result.content as string).toContain(TRUNCATED_HEADER);
  });

  it('replaces empty output with a no-output marker', async () => {
    const result = await run('   ');
    expect(result.content).toBe('(shell completed with no output)');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('is idempotent when content is already truncated', async () => {
    const already = `${TRUNCATED_HEADER}\nThe full output...`;
    const result = await run(already);
    expect(result.content).toBe(already);
    expect(result.outputFile).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('truncates text parts but preserves media parts in Part[]', async () => {
    const result = await run([{ text: 'a'.repeat(200_000) }, image()]);

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Part[];
    // Media part is preserved verbatim.
    expect(hasImage(parts)).toBe(true);
    // Text part is truncated.
    const textPart = parts.find((p) => p.text !== undefined);
    expect(textPart?.text).toContain(TRUNCATED_HEADER);
    expect(result.outputFile).toBeDefined();
  });

  it('leaves small Part[] text untouched', async () => {
    const content: Part[] = [{ text: 'small output' }, image()];
    const result = await run(content);
    expect(result.outputFile).toBeUndefined();
    expect(result.content).toEqual(content);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('bounds Part[] text even when the disk write fails', async () => {
    // On a disk-write failure the Part[] path must still return a bounded
    // preview (matching the string path) rather than leaking the original
    // oversized content back into history.
    mockWriteFile.mockRejectedValue(new Error('ENOSPC'));
    const result = await run([{ text: 'a'.repeat(200_000) }, image()]);

    const parts = result.content as Part[];
    const textPart = parts.find((p) => p.text !== undefined);
    // Bounded: far smaller than the 200k original, carrying the failure note.
    expect(textPart?.text?.length ?? 0).toBeLessThan(50_000);
    expect(textPart?.text).toContain('Could not save full output to file');
    // Media part is still preserved.
    expect(hasImage(parts)).toBe(true);
  });

  it('still truncates a string when the sentinel appears mid-output, not as a prefix', async () => {
    // Only a genuine truncation prefix (at position 0) should short-circuit.
    // A tool whose own output merely contains the phrase somewhere in the
    // middle must still be truncated — otherwise attacker-controlled output
    // could embed the phrase to bypass the budget.
    const result = await run(
      'normal output line\n'.repeat(100) +
        `${TOOL_OUTPUT_TRUNCATED_PREFIX}\n` +
        'b'.repeat(200_000),
    );
    expect(result.outputFile).toBeDefined();
    expect(typeof result.content).toBe('string');
  });

  it('truncates a Part[] when the sentinel appears mid-stream, not as a part prefix', async () => {
    // Part[] idempotency must mirror the string path: only a part that STARTS
    // with the sentinel counts as already-truncated. A hostile or echoed part
    // that merely contains the phrase mid-stream must not bypass the budget.
    const text =
      'normal intro line\n' +
      `${TOOL_OUTPUT_TRUNCATED_PREFIX}\n` +
      'b'.repeat(200_000);
    const result = await run([{ text }], 'mcp_tool');
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
    const result = await run(content, 'mcp_tool');
    expect(result.outputFile).toBeUndefined();
    expect(result.content).toEqual(content);
  });
});

describe('truncateAndSaveToFile preview budget', () => {
  const content = Array.from(
    { length: 200 },
    (_, i) => `line ${i} ${'y'.repeat(40)}`,
  ).join('\n');

  /** The preview (text after the marker) at threshold 100 / 20 lines. */
  const previewFor = async (
    fileName: string,
    keep: 'both' | 'head' | 'tail',
    previewChars: number,
  ) => {
    const wrapped = (
      await truncateAndSaveToFile(
        content,
        fileName,
        '/tmp',
        100,
        20,
        keep,
        previewChars,
      )
    ).content;
    return wrapped.slice(
      wrapped.indexOf(PREVIEW_MARKER) + PREVIEW_MARKER.length,
    );
  };

  // The separator is 39 characters and the ellipsis 3, and both were emitted
  // without being charged to the budget, so a small previewChars came back
  // over it: 0 produced 39 characters, 10 produced 42, 40 produced 47.
  it.each([
    ['both' as const, 0],
    ['both' as const, 10],
    ['both' as const, 40],
    ['both' as const, 47],
    ['head' as const, 40],
    ['tail' as const, 40],
  ])(
    'keeps the %s preview within previewChars=%d',
    async (keep, previewChars) => {
      expect(
        (await previewFor('budget', keep, previewChars)).length,
      ).toBeLessThanOrEqual(previewChars);
    },
  );

  it('stays within budget for every previewChars from 0 to 120', async () => {
    for (const keep of ['both', 'head', 'tail'] as const) {
      for (let previewChars = 0; previewChars <= 120; previewChars++) {
        expect(
          (await previewFor('sweep', keep, previewChars)).length,
        ).toBeLessThanOrEqual(previewChars);
      }
    }
  });

  // Guards against over-correcting: where the budget has room, the separator
  // and real content must both survive. The two `toContain` assertions are the
  // guard proper and hold before and after; the length assertion alongside
  // them does not, since `keep: 'head'` overran even at 200.
  it.each([
    ['both' as const, 200],
    ['head' as const, 200],
    ['tail' as const, 200],
  ])(
    'still marks the cut for %s at previewChars=%d',
    async (keep, previewChars) => {
      const preview = await previewFor('roomy', keep, previewChars);

      expect(preview.length).toBeLessThanOrEqual(previewChars);
      expect(preview).toContain('[CONTENT TRUNCATED]');
      expect(preview).toContain('line ');
    },
  );
});
