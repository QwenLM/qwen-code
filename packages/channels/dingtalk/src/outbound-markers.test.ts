import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findTrailingPartialOutboundMediaMarker,
  findOutboundMediaMarkers,
  sanitizeOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  truncateOutboundMediaText,
  unwrapFileMarkersAroundImages,
} from './outbound-markers.js';

describe('outbound media markers', () => {
  it('parses bracketed paths without combining adjacent markers', () => {
    expect(
      findOutboundMediaMarkers(
        '[FILE: /workspace/report [final].pdf] [FILE: /workspace/next.txt]',
        'FILE',
      ).map(({ path }) => path),
    ).toEqual(['/workspace/report [final].pdf', '/workspace/next.txt']);
    expect(
      findOutboundMediaMarkers('[FILE: /workspace/report]final.csv]', 'FILE')[0]
        ?.path,
    ).toBe('/workspace/report]final.csv');
    expect(
      findOutboundMediaMarkers(
        '[FILE: /workspace/report.pdf][IMAGE: /workspace/chart.png]',
        'FILE',
      )[0]?.path,
    ).toBe('/workspace/report.pdf');
    expect(
      findOutboundMediaMarkers(
        'Chart [IMAGE: /tmp/chart.png] as shown [1].',
        'IMAGE',
      )[0]?.path,
    ).toBe('/tmp/chart.png');
    expect(
      findOutboundMediaMarkers(
        '好的 [FILE: /workspace/报告.pdf]，请查收 [1]',
        'FILE',
      )[0]?.path,
    ).toBe('/workspace/报告.pdf');
  });

  it('leaves partial marker syntax inside Markdown code untouched', () => {
    const fenced = 'Log:\n```\n[FILE: /workspace/report.csv\n```';
    const inline = 'Run `cat [FILE: /etc/hosts` to inspect';

    expect(stripPartialOutboundMediaMarker(fenced, 'FILE', '')).toBe(fenced);
    expect(stripPartialOutboundMediaMarker(inline, 'FILE', '')).toBe(inline);
    expect(
      findTrailingPartialOutboundMediaMarker('The format is `[IMAGE: '),
    ).toEqual({ start: 14 });
    expect(
      findTrailingPartialOutboundMediaMarker(
        'Use `first line\n[FILE: /tmp/report.txt]` here',
      ),
    ).toBeUndefined();
    expect(
      findTrailingPartialOutboundMediaMarker(
        'Use `first line\n[FILE: /tmp/report.txt]',
      ),
    ).toEqual({ start: 4, markerName: 'FILE', complete: true });
  });

  it('parks a trailing bare bracket without assigning a marker type', () => {
    expect(findTrailingPartialOutboundMediaMarker('行为字[')).toEqual({
      start: 3,
    });
  });

  it('walks past index zero and strips the earliest partial marker', () => {
    expect(
      stripPartialOutboundMediaMarker('[1] hello', 'FILE', '[File pending]'),
    ).toBe('[1] hello');
    expect(
      stripPartialOutboundMediaMarker(
        'see [FILE: /tmp/a [FILE: /tmp/b',
        'FILE',
        '[File pending]',
      ),
    ).toBe('see [File pending]');
    expect(
      stripPartialOutboundMediaMarker(
        'see [IMAGE: /Users/ben/private/a [FILE: /tmp/b]',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('see [Image pending][FILE: /tmp/b]');
  });

  it('does not mistake complete bracketed markers for partial markers', () => {
    expect(
      stripPartialOutboundMediaMarker(
        'done [IMAGE: /a/b[1].png] sent',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('done [IMAGE: /a/b[1].png] sent');
    expect(
      stripPartialOutboundMediaMarker(
        '[IMAGE: processing [1/2] done]',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('[IMAGE: processing [1/2] done]');
    expect(
      stripPartialOutboundMediaMarker(
        'before [IMAGE:\n/tmp/private.png] after',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('before [IMAGE:\n/tmp/private.png] after');
  });

  it('does not throw on Unicode lookalikes of marker names', () => {
    expect(
      stripPartialOutboundMediaMarker(
        'see [ımage: /tmp/a',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('see [ımage: /tmp/a');
    expect(
      stripPartialOutboundMediaMarker('see [fıle: /tmp/a', 'FILE', ''),
    ).toBe('see [fıle: /tmp/a');
    expect(
      stripPartialOutboundMediaMarker('see [ım', 'IMAGE', '[Image pending]'),
    ).toBe('see [ım');
    expect(
      stripPartialOutboundMediaMarker('a[ıma', 'IMAGE', '[Image pending]'),
    ).toBe('a[ıma');
  });

  it('uses an existing bracketed path as the marker close oracle', () => {
    const root = mkdtempSync(join(tmpdir(), 'qwen-marker-'));
    const directory = join(root, 'dir [1] copy');
    const file = join(directory, 'x.png');
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, 'image');
      expect(
        findOutboundMediaMarkers(`[IMAGE: ${file}]`, 'IMAGE')[0]?.candidates,
      ).toContainEqual({ end: `[IMAGE: ${file}]`.length, path: file });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an ambiguous bracketed path in streaming carry', () => {
    expect(findTrailingPartialOutboundMediaMarker('[IMAGE: /tmp/a[1]')).toEqual(
      { start: 0, markerName: 'IMAGE', complete: true },
    );
    expect(
      findTrailingPartialOutboundMediaMarker('[FILE: /tmp/a[1].tx'),
    ).toEqual({ start: 0, markerName: 'FILE' });
  });

  it('sanitizes the full authoritative marker span', () => {
    expect(
      sanitizeOutboundMediaMarkers(
        '[FILE: [v2] /Users/ben/private/leak.pdf]',
        'FILE',
        '',
      ),
    ).toBe('');
    expect(
      sanitizeOutboundMediaMarkers(
        'sending [FILE: /tmp/report[1].pdf',
        'FILE',
        '',
      ),
    ).toBe('sending ');
    expect(
      sanitizeOutboundMediaMarkers(
        '[FILE: /tmp/report.pdf] As shown in [1]',
        'FILE',
        '',
      ),
    ).toBe(' As shown in [1]');
  });

  it('unwraps nested image markers without consuming following brackets', () => {
    expect(
      unwrapFileMarkersAroundImages(
        '[FILE: [IMAGE: /tmp/a.png]] As shown in [1]',
      ),
    ).toBe('[IMAGE: /tmp/a.png] As shown in [1]');
    expect(
      unwrapFileMarkersAroundImages(
        '[FILE: [IMAGE: /tmp/a.png] As shown in [1]',
      ),
    ).toBe('[IMAGE: /tmp/a.png] As shown in [1]');
    expect(
      unwrapFileMarkersAroundImages('```\n[FILE: [IMAGE: /tmp/a.png]]\n```'),
    ).toBe('```\n[IMAGE: /tmp/a.png]\n```');
    expect(
      unwrapFileMarkersAroundImages(
        '[FILE: [IMAGE: /tmp/a.png] docs/report.pdf]',
      ),
    ).toBe('[IMAGE: /tmp/a.png]');
    expect(
      unwrapFileMarkersAroundImages(
        '[FILE: [IMAGE: /tmp/a.png] /Users/ben/private/report.pdf',
      ),
    ).toBe('[IMAGE: /tmp/a.png]');
  });

  it('treats escaped marker syntax as literal text', () => {
    const complete = String.raw`\[IMAGE: /tmp/private.png]`;
    const partial = String.raw`\[FILE: /tmp/private`;
    expect(findOutboundMediaMarkers(complete, 'IMAGE')).toEqual([]);
    expect(
      stripPartialOutboundMediaMarker(partial, 'FILE', '[File pending]'),
    ).toBe(partial);
    expect(findTrailingPartialOutboundMediaMarker(partial)).toBeUndefined();
    expect(sanitizeOutboundMediaMarkers(complete, 'IMAGE', '[pending]')).toBe(
      String.raw`\[pending]`,
    );
    expect(
      sanitizeOutboundMediaMarkers(
        String.raw`\[FILE: /Users/ben/private/report.pdf]`,
        'FILE',
        '',
      ),
    ).not.toContain('/Users/ben/private');
  });

  it('keeps truncation boundaries outside partial markers', () => {
    const marker = '[FILE: /Users/ben/private/report.pdf]';
    const truncationMarker = '[truncated]\n';
    const suffix = 'z'.repeat(80 - truncationMarker.length + 1 - marker.length);
    const result = truncateOutboundMediaText(
      `${'x'.repeat(20)}${marker}${suffix}`,
      80,
      truncationMarker,
    );
    expect(result).toBe(`${truncationMarker}${suffix}`);
    expect(
      truncateOutboundMediaText(`[${'a'.repeat(200)}`, 100, truncationMarker),
    ).toHaveLength(100);
    expect(
      truncateOutboundMediaText(
        `${'a'.repeat(114)}[${'b'.repeat(53)}`,
        80,
        truncationMarker,
      ),
    ).toHaveLength(80);
    expect(
      truncateOutboundMediaText(
        `${'A'.repeat(500)}[FILE: ${'B'.repeat(20_500)}`,
        20_000,
        '[Earlier output truncated]\n',
      ),
    ).not.toContain('B');
    expect(
      truncateOutboundMediaText(
        `${'A'.repeat(80)}[FILE: [IMAGE: /tmp/a.png] /Users/ben/private/report.pdf]`,
        40,
        truncationMarker,
      ),
    ).not.toContain('private');
  });

  it('parks the earliest pending marker across nested openings and brackets', () => {
    expect(
      findTrailingPartialOutboundMediaMarker(
        '[FILE: [IMAGE: /tmp/a.png] /tmp/report.pdf',
      ),
    ).toEqual({ start: 0, markerName: 'FILE' });
    expect(
      findTrailingPartialOutboundMediaMarker('[FILE: /tmp/report ['),
    ).toEqual({ start: 0, markerName: 'FILE' });
  });

  it('closes markers before prose and Markdown followers', () => {
    const cjk = '文件[FILE: /tmp/a.pdf]、[链接](https://example.com)已发出';
    expect(findOutboundMediaMarkers(cjk, 'FILE')[0]?.path).toBe('/tmp/a.pdf');
    expect(sanitizeOutboundMediaMarkers(cjk, 'FILE', '')).toBe(
      '文件、[链接](https://example.com)已发出',
    );
    expect(findOutboundMediaMarkers('[FILE: a]𠮷]', 'FILE')[0]?.path).toBe('a');
    expect(
      findOutboundMediaMarkers('[FILE: a.pdf][link](url)', 'FILE')[0]?.path,
    ).toBe('a.pdf');
  });

  it('preserves prose around nested image wrappers', () => {
    expect(
      unwrapFileMarkersAroundImages('[FILE: [IMAGE: a.png]] x [IMAGE: b.png]'),
    ).toBe('[IMAGE: a.png] x [IMAGE: b.png]');
    expect(
      unwrapFileMarkersAroundImages('[FILE: [IMAGE: a.png]，请查收]'),
    ).toBe('[IMAGE: a.png]，请查收');
    expect(unwrapFileMarkersAroundImages('[FILE: [IMAGE: a.png] thanks]')).toBe(
      '[IMAGE: a.png] thanks',
    );
    expect(unwrapFileMarkersAroundImages('[FILE: [IMAGE: a.png] summary')).toBe(
      '[IMAGE: a.png]',
    );
  });

  it('parks uncertain code and trailing escape state across chunks', () => {
    expect(
      findTrailingPartialOutboundMediaMarker(
        'see `x [IMAGE: /Users/ben/private/',
      ),
    ).toEqual({ start: 4 });
    expect(findTrailingPartialOutboundMediaMarker('see \\')).toEqual({
      start: 4,
    });
    expect(
      findTrailingPartialOutboundMediaMarker('\\``` [IMAGE: /tmp/a.png]'),
    ).toEqual({ start: 2, markerName: 'IMAGE', complete: true });
  });

  it('does not park malformed wrappers from earlier lines', () => {
    expect(
      findTrailingPartialOutboundMediaMarker(
        '[FILE: [IMAGE: a.png]\nmore text',
      ),
    ).toBeUndefined();
  });

  it('does not rewrite newline-terminated marker prefixes', () => {
    expect(
      stripPartialOutboundMediaMarker(
        'see [im\nmore',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('see [im\nmore');
    expect(stripPartialOutboundMediaMarker('A [f\nB', 'FILE', '')).toBe(
      'A [f\nB',
    );
  });

  it('keeps the next line after an unclosed marker opening', () => {
    expect(
      stripPartialOutboundMediaMarker(
        'You can use [file:\nto attach documents.',
        'FILE',
        '',
      ),
    ).toBe('You can use \nto attach documents.');
  });

  it('does not unwrap escaped file wrappers', () => {
    const text = String.raw`\[FILE: [IMAGE: /tmp/a.png]]`;
    expect(unwrapFileMarkersAroundImages(text)).toBe(text);
    expect(findOutboundMediaMarkers(text, 'IMAGE')).toHaveLength(1);
  });

  it('does not strip through protected marker openings', () => {
    const inCode = 'A [IMAGE: /tmp/x `[FILE: /workspace/secret.pdf]` B';
    const escaped = String.raw`A [IMAGE: /tmp/x \[FILE: /workspace/secret.pdf]`;
    expect(
      stripPartialOutboundMediaMarker(inCode, 'IMAGE', '[Image pending]'),
    ).toBe(inCode);
    expect(
      stripPartialOutboundMediaMarker(escaped, 'IMAGE', '[Image pending]'),
    ).toBe(escaped);
  });
});
