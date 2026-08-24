/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  normalizeExplicitFileLink,
  resolveFileLinkFromAnchor,
} from './fileLinks.js';

function anchorWith(href: string | null, text = ''): HTMLAnchorElement {
  const anchor = document.createElement('a');
  if (href !== null) {
    anchor.setAttribute('href', href);
  }
  anchor.textContent = text;
  return anchor;
}

describe('normalizeExplicitFileLink', () => {
  it('strips the file:// scheme and restores the leading slash', () => {
    expect(normalizeExplicitFileLink('file:///tmp/report.md')).toBe(
      '/tmp/report.md',
    );
  });

  it('keeps Windows drive paths intact', () => {
    expect(normalizeExplicitFileLink('file:///C:/Users/me/notes.txt')).toBe(
      'C:/Users/me/notes.txt',
    );
  });

  it('converts a line-number fragment into a path:line suffix', () => {
    expect(normalizeExplicitFileLink('/src/app.ts#L42')).toBe('/src/app.ts:42');
  });

  it('treats an encoded %23 as a literal # in the filename, not a fragment', () => {
    expect(normalizeExplicitFileLink('/tmp/my%23file.md')).toBe(
      '/tmp/my#file.md',
    );
  });

  it('splits line fragments on the raw # before percent-decoding', () => {
    expect(normalizeExplicitFileLink('/src/app%20main.ts#L42')).toBe(
      '/src/app main.ts:42',
    );
  });

  it('decodes %23 inside file:// paths without applying fragment logic', () => {
    expect(
      normalizeExplicitFileLink('file:///workspace/export%20(%231).html'),
    ).toBe('/workspace/export (#1).html');
  });
});

describe('resolveFileLinkFromAnchor', () => {
  it('resolves file:// anchors', () => {
    expect(resolveFileLinkFromAnchor(anchorWith('file:///tmp/a.md'))).toBe(
      '/tmp/a.md',
    );
  });

  it('resolves absolute-path anchors', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith('/tmp/insight-report.md')),
    ).toBe('/tmp/insight-report.md');
  });

  it('resolves relative anchors with a known file extension', () => {
    expect(resolveFileLinkFromAnchor(anchorWith('src/index.ts'))).toBe(
      'src/index.ts',
    );
  });

  it('falls back to the anchor text when the href was sanitized away', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith(null, '/var/log/app.log')),
    ).toBe('/var/log/app.log');
  });

  it('resolves hrefs whose filename contains an encoded #', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith('/tmp/my%23file.md', 'r')),
    ).toBe('/tmp/my#file.md');
  });

  it('keeps a literal # in sanitized-away anchor text intact', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith(null, 'export (#1).html')),
    ).toBe('export (#1).html');
  });

  it('resolves file:// export links with an encoded # in the filename', () => {
    expect(
      resolveFileLinkFromAnchor(
        anchorWith(
          'file:///workspace/export%20(%231).html',
          'export (#1).html',
        ),
      ),
    ).toBe('/workspace/export (#1).html');
  });

  it('ignores external links', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith('https://example.com/')),
    ).toBeNull();
    expect(resolveFileLinkFromAnchor(anchorWith('mailto:a@b.c'))).toBeNull();
  });

  it('ignores fragment-only anchors', () => {
    expect(resolveFileLinkFromAnchor(anchorWith('#'))).toBeNull();
    expect(resolveFileLinkFromAnchor(anchorWith('#section'))).toBeNull();
  });

  it('ignores text without a file-like shape', () => {
    expect(
      resolveFileLinkFromAnchor(anchorWith(null, 'click here')),
    ).toBeNull();
  });
});
