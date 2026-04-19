/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readNotebook } from './notebook.js';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

describe('notebook utilities', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeNotebook(
    name: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notebook-test-'));
    const filePath = path.join(tempDir, name);
    await fsp.writeFile(filePath, JSON.stringify(content), 'utf-8');
    return filePath;
  }

  it('should parse a simple notebook with code and markdown cells', async () => {
    const filePath = await writeNotebook('test.ipynb', {
      cells: [
        {
          cell_type: 'markdown',
          source: ['# Hello World'],
          metadata: {},
        },
        {
          cell_type: 'code',
          source: ['print("hello")'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'stream',
              text: ['hello\n'],
            },
          ],
          metadata: {},
        },
      ],
      metadata: {
        language_info: { name: 'python' },
      },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('Jupyter Notebook (python, 2 cells)');
    expect(result).toContain('# Hello World');
    expect(result).toContain('```python');
    expect(result).toContain('print("hello")');
    expect(result).toContain('Output:');
    expect(result).toContain('hello');
  });

  it('should handle empty notebook', async () => {
    const filePath = await writeNotebook('empty.ipynb', {
      cells: [],
      metadata: {},
    });

    const result = await readNotebook(filePath);
    expect(result).toBe('(empty notebook)');
  });

  it('should detect language from kernelspec', async () => {
    const filePath = await writeNotebook('r-notebook.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['print("R code")'],
          outputs: [],
          metadata: {},
        },
      ],
      metadata: {
        kernelspec: { language: 'R', display_name: 'R' },
      },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('Jupyter Notebook (R, 1 cells)');
    expect(result).toContain('```R');
  });

  it('should handle execute_result output', async () => {
    const filePath = await writeNotebook('result.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['1 + 1'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'execute_result',
              data: { 'text/plain': '2' },
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('Output:');
    expect(result).toContain('2');
  });

  it('should handle error output', async () => {
    const filePath = await writeNotebook('error.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['1 / 0'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'error',
              ename: 'ZeroDivisionError',
              evalue: 'division by zero',
              traceback: ['Traceback...', '  File "<stdin>"...'],
            },
          ],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('ZeroDivisionError');
    expect(result).toContain('division by zero');
  });

  it('should handle source as array', async () => {
    const filePath = await writeNotebook('array-source.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['import os\n', 'print(os.getcwd())'],
          outputs: [],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('import os\nprint(os.getcwd())');
  });

  it('should handle raw cells', async () => {
    const filePath = await writeNotebook('raw.ipynb', {
      cells: [
        {
          cell_type: 'raw',
          source: ['some raw text'],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('Raw Cell');
    expect(result).toContain('some raw text');
  });

  it('should truncate large outputs', async () => {
    const largeOutput = 'x'.repeat(15000);
    const filePath = await writeNotebook('large-output.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['print("big")'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'stream',
              text: [largeOutput],
            },
          ],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('output truncated');
    expect(result).toContain('jq');
  });

  it('should surface non-text outputs with a placeholder', async () => {
    const filePath = await writeNotebook('image-output.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['plt.plot([1,2,3])'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'image/png': 'iVBORw0KGgoAAAANSUhEUgAA...',
              },
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('plt.plot([1,2,3])');
    // We don't inline the base64 image data, but the model should know a
    // non-text output existed for this cell.
    expect(result).toContain('[non-text output: image/png]');
  });

  it('should strip ANSI colour codes from error tracebacks', async () => {
    // ipykernel emits CSI/SGR sequences like `\x1B[0;31m` in tracebacks by
    // default. They add noise and take up LLM tokens without conveying
    // useful information once we're rendering to plain text.
    const filePath = await writeNotebook('ansi-error.ipynb', {
      cells: [
        {
          cell_type: 'code',
          source: ['1/0'],
          execution_count: 1,
          outputs: [
            {
              output_type: 'error',
              ename: 'ZeroDivisionError',
              evalue: 'division by zero',
              traceback: [
                '\x1B[0;31m---------------------------------------------------------------------------\x1B[0m',
                '\x1B[0;31mZeroDivisionError\x1B[0m\x1B[0;31m: \x1B[0mdivision by zero',
              ],
            },
          ],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('ZeroDivisionError');
    expect(result).toContain('division by zero');
    expect(result).not.toContain('\x1B[');
    expect(result).not.toContain('[0;31m');
  });

  it('should show cell id when available', async () => {
    const filePath = await writeNotebook('cell-id.ipynb', {
      cells: [
        {
          cell_type: 'code',
          id: 'abc-123',
          source: ['x = 1'],
          outputs: [],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('abc-123');
  });

  it('should truncate notebook with too many cells', async () => {
    const cells = Array.from({ length: 200 }, (_, i) => ({
      cell_type: 'code' as const,
      source: ['x = ' + 'a'.repeat(600) + '\n'],
      execution_count: i + 1,
      outputs: [
        { output_type: 'stream' as const, text: ['result '.repeat(100)] },
      ],
      metadata: {},
    }));
    const filePath = await writeNotebook('big.ipynb', {
      cells,
      metadata: { language_info: { name: 'python' } },
    });

    const result = await readNotebook(filePath);
    expect(result).toContain('remaining cells truncated');
    // Should be within bounds
    expect(result.length).toBeLessThan(120000);
  });

  it('should throw on invalid JSON', async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notebook-test-'));
    const filePath = path.join(tempDir, 'bad.ipynb');
    await fsp.writeFile(filePath, 'not json', 'utf-8');

    await expect(readNotebook(filePath)).rejects.toThrow();
  });
});
