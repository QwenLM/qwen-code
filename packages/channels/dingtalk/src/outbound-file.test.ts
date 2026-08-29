import { describe, expect, it } from 'vitest';
import {
  MAX_FILES_PER_RESPONSE,
  OutboundFileProjector,
  projectFileText,
} from './outbound-file.js';

describe('OutboundFileProjector', () => {
  it('keeps every split of the reserved opening path-free', () => {
    const input = 'before\n[FILE: /workspace/report.txt]\nafter';
    for (let split = 0; split <= '[FILE:'.length; split++) {
      const projector = new OutboundFileProjector();
      const opening = input.indexOf('[FILE:');
      const chunks = [
        input.slice(0, opening + split),
        input.slice(opening + split),
      ];
      const safeChunks = chunks.map((chunk) => projector.append(chunk));
      const safe = safeChunks.join('') + projector.complete();
      expect(safeChunks[0]).not.toContain('/workspace/report.txt');
      expect(safeChunks[1]).not.toContain('/workspace/report.txt');
      expect(projector.result(safe)).toMatchObject({
        text: 'before\n\nafter',
        paths: ['/workspace/report.txt'],
      });
    }
  });

  it.each([
    {
      input: '[FILE: /tmp/a.txt]',
      text: '',
      paths: ['/tmp/a.txt'],
      invalidMarkers: 0,
    },
    {
      input: 'prefix [FILE: /tmp/a.txt] suffix\nnext',
      text: 'prefix \nnext',
      paths: [],
      invalidMarkers: 1,
    },
    {
      input: '[FILE:/tmp/a.txt]\nnext',
      text: '\nnext',
      paths: [],
      invalidMarkers: 1,
    },
    {
      input: '[FILE: /tmp/a.txt',
      text: '',
      paths: [],
      invalidMarkers: 1,
    },
  ])('projects $input without repairing it', ({ input, ...expected }) => {
    expect(projectFileText(input)).toMatchObject(expected);
  });

  it('does not rescan text joined by a redaction', () => {
    expect(projectFileText('[FI[FILE: /tmp/inner]\nLE: /tmp/outer]\n')).toEqual(
      {
        text: '[FI\nLE: /tmp/outer]\n',
        paths: [],
        invalidMarkers: 1,
        excessMarkers: 0,
        markerCount: 1,
      },
    );
  });

  it('bounds accepted paths and rejects oversized reserved lines', () => {
    const markers = Array.from(
      { length: MAX_FILES_PER_RESPONSE + 2 },
      (_, index) => `[FILE: /tmp/${index}.txt]`,
    ).join('\n');
    const projected = projectFileText(
      `${markers}\n[FILE: /${'x'.repeat(5000)}]`,
    );
    expect(projected.paths).toHaveLength(MAX_FILES_PER_RESPONSE);
    expect(projected.excessMarkers).toBe(2);
    expect(projected.invalidMarkers).toBe(1);
    expect(projected.text).not.toContain('/tmp/');
    expect(projected.text).not.toContain('x'.repeat(100));
  });
});
