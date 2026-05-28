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

  it('returns empty array when maxFiles is 0 or negative', () => {
    const history: Content[] = [fileReadCall('/a.ts'), fileReadCall('/b.ts')];
    expect(extractRecentFilePaths(history, 0)).toEqual([]);
    expect(extractRecentFilePaths(history, -1)).toEqual([]);
  });
});

import { extractRecentImages } from './postCompactAttachments.js';

function modelCallScreenshot(app: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'computer_use__get_app_state',
          args: { app },
        },
      },
    ],
  };
}

function userToolResultWithImage(mimeType: string, data: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'computer_use__get_app_state',
          response: { output: 'screenshot returned' },
        },
      },
      { inlineData: { mimeType, data } },
    ],
  };
}

describe('extractRecentImages', () => {
  it('returns the last N images in chronological order (oldest first)', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'aaaa'),
      modelCallScreenshot('Mail'),
      userToolResultWithImage('image/png', 'bbbb'),
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'cccc'),
    ];
    const result = extractRecentImages(history, 3);
    expect(result.map((r) => r.part.inlineData?.data)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
  });

  it('caps at maxImages by keeping the newest', () => {
    const history: Content[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(modelCallScreenshot(`App${i}`));
      history.push(userToolResultWithImage('image/png', `data${i}`));
    }
    const result = extractRecentImages(history, 3);
    expect(result.map((r) => r.part.inlineData?.data)).toEqual([
      'data2',
      'data3',
      'data4',
    ]);
  });

  it('captures the preceding model functionCall as metadata', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'aaaa'),
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBe('computer_use__get_app_state');
    expect(result[0].sourceToolArgs).toEqual({ app: 'Safari' });
    expect(result[0].turnIndex).toBe(1); // user+fr is at index 1
  });

  it('also picks up images from user-paste (no preceding model+fc)', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'check this' },
          { inlineData: { mimeType: 'image/png', data: 'pastedimage' } },
        ],
      },
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBeUndefined();
    expect(result[0].part.inlineData?.data).toBe('pastedimage');
  });

  it('ignores non-image inlineData', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: 'pdfdata' } },
        ],
      },
    ];
    expect(extractRecentImages(history, 3)).toEqual([]);
  });
});
