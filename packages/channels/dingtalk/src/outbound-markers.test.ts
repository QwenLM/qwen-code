import { describe, expect, it } from 'vitest';
import {
  findOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  truncateOutboundMediaText,
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
    ).toBe('see [Image pending]');
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
  });
});
