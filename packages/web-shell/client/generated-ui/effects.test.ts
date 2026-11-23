/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyRequestText,
  downloadRequestFile,
  sanitizeFilename,
  startDownload,
  writeClipboard,
} from './effects';

const resource = (fields: Record<string, unknown>) => ({
  contents: [
    {
      type: 'resource',
      resource: {
        uri: 'file:///plans',
        mimeType: 'text/csv',
        text: 'plan,payment\n',
        ...fields,
      },
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('generated UI copy requests', () => {
  it('accepts non-empty text up to 16 KiB of UTF-8', () => {
    expect(copyRequestText({ text: 'Total: 12.30' })).toBe('Total: 12.30');
    expect(copyRequestText({ text: '界'.repeat(5461) })).toBe(
      '界'.repeat(5461),
    );
    for (const params of [
      undefined,
      {},
      { text: '' },
      { text: 1 },
      { text: '界'.repeat(5462) },
    ]) {
      expect(copyRequestText(params)).toBeUndefined();
    }
  });
});

describe('generated UI download requests', () => {
  it('accepts one embedded text resource and forces its extension', () => {
    expect(downloadRequestFile(resource({}))).toEqual({
      filename: 'plans.csv',
      mimeType: 'text/csv',
      text: 'plan,payment\n',
    });
    expect(
      downloadRequestFile(
        resource({
          uri: `file:///${encodeURIComponent('Q4 report.md')}`,
          mimeType: 'text/markdown',
        }),
      ),
    ).toMatchObject({ filename: 'Q4 report.md' });
  });

  it.each([
    ['a link', { contents: [{ type: 'resource_link', uri: 'https://x' }] }],
    [
      'two files',
      { contents: [...resource({}).contents, ...resource({}).contents] },
    ],
    ['binary content', resource({ blob: 'AAAA', text: undefined })],
    ['binary next to text', resource({ blob: 'AAAA' })],
    ['an HTML file', resource({ mimeType: 'text/html' })],
    ['an empty file', resource({ text: '' })],
    ['more than 64 KiB', resource({ text: 'x'.repeat(64 * 1024 + 1) })],
    ['a remote URI', resource({ uri: 'https://example.com/plans.csv' })],
    ['a malformed name', resource({ uri: 'file:///%E0%A4%A' })],
    ['a long name', resource({ uri: `file:///${'x'.repeat(101)}` })],
  ])('refuses %s', (_name, params) => {
    expect(downloadRequestFile(params)).toBeUndefined();
  });

  it.each([
    ['../../etc/passwd', 'text/plain', 'passwd.txt'],
    ['C:\\Users\\me\\run.exe', 'text/csv', 'run.exe.csv'],
    ['  .hidden', 'application/json', 'hidden.json'],
    ['a<b>:c?.CSV', 'text/csv', 'a-b-c-.CSV'],
    ['...', 'text/csv', 'download.csv'],
    ['账单', 'text/csv', '账单.csv'],
  ])('sanitizes %j as %j', (name, mimeType, expected) => {
    expect(sanitizeFilename(name, mimeType)).toBe(expected);
  });
});

describe('performing effects', () => {
  it('reports whether the browser accepted the clipboard write', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('', 'NotAllowedError'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(writeClipboard('a')).resolves.toBe(true);
    await expect(writeClipboard('b')).resolves.toBe(false);
    vi.stubGlobal('navigator', {});
    await expect(writeClipboard('c')).resolves.toBe(false);
  });

  it('clicks a temporary link with the file name and revokes its URL', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL, revokeObjectURL }),
    );
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    startDownload({ filename: 'plans.csv', mimeType: 'text/csv', text: 'a' });
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatchObject({ download: 'plans.csv' });
    expect(clicked[0].getAttribute('href')).toBe('blob:download');
    expect(clicked[0].isConnected).toBe(false);
    const blob = (createObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe('text/csv');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
    vi.useRealTimers();
  });
});
