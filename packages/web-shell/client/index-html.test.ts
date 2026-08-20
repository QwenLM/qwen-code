import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function installMeasureGuard(
  measure: (...args: unknown[]) => unknown,
): Performance {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  const script = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  )
    .map((match) => match[1] ?? '')
    .find((source) => source.includes('performance.measure ='));

  if (!script) throw new Error('Performance measure guard not found');

  const performance = { measure };
  Function('performance', 'DOMException', script)(performance, DOMException);
  return performance as Performance;
}

describe('React performance measure guard', () => {
  it('removes React component detail before calling the native measure', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: {
        devtools: {
          track: 'Components ⚛',
          properties: [['transcript', new Array(50_000).fill('block')]],
        },
      },
    };

    const result = performance.measure('WebShell', options);
    const forwardedOptions = measure.mock.calls[0]?.[1] as
      | PerformanceMeasureOptions
      | undefined;

    expect(result).toBe('measure');
    expect(forwardedOptions?.start).toBe(1);
    expect(forwardedOptions?.end).toBe(2);
    expect(forwardedOptions?.detail === null).toBe(true);
    expect(options.detail.devtools.properties).toHaveLength(1);
  });

  it('preserves non-React performance measure detail', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: { source: 'web-shell' },
    };

    performance.measure('custom-measure', options);

    expect(measure).toHaveBeenCalledWith('custom-measure', options);
  });
});
