import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import { extractRecentFilePaths } from './postCompactAttachments.js';

function fileReadCall(path: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'read_file',
          args: { file_path: path },
        },
      },
    ],
  };
}

function fileWriteCall(path: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'write_file',
          args: { file_path: path, content: '...' },
        },
      },
    ],
  };
}

describe('extractRecentFilePaths', () => {
  it('returns the most recently-touched file paths first', () => {
    const history: Content[] = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/c.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual([
      '/c.ts',
      '/b.ts',
      '/a.ts',
    ]);
  });

  it('deduplicates by file path, keeping the most recent touch', () => {
    const history: Content[] = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/a.ts'), // a.ts is now most recent
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/a.ts', '/b.ts']);
  });

  it('respects the maxFiles cap', () => {
    const history: Content[] = Array.from({ length: 10 }, (_, i) =>
      fileReadCall(`/file${i}.ts`),
    );
    expect(extractRecentFilePaths(history, 3)).toHaveLength(3);
  });

  it('returns an empty array when no file-touching tool calls exist', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual([]);
  });

  it('ignores tool calls without a file_path argument', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'web_fetch', args: { url: 'https://x.com' } },
          },
        ],
      },
      fileReadCall('/real.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/real.ts']);
  });

  it('recognizes edit and replace tools too', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'edit',
              args: { file_path: '/e.ts', old_string: 'x', new_string: 'y' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'replace', args: { file_path: '/r.ts' } } },
        ],
      },
    ];
    const paths = extractRecentFilePaths(history, 5);
    expect(paths).toContain('/e.ts');
    expect(paths).toContain('/r.ts');
  });
});
