// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SvgLineChart } from './SvgLineChart';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('SvgLineChart', () => {
  it('renders a polyline path, current value, peak, and end dot for a populated series', () => {
    const el = render(
      <SvgLineChart
        series={[
          { label: 'RSS', values: [10, 20, 15, 30], color: 'var(--primary)' },
        ]}
        format={(v) => `${v}mb`}
      />,
    );
    const paths = el.querySelectorAll('path');
    expect(paths.length).toBe(1);
    const d = paths[0].getAttribute('d') ?? '';
    expect(d.startsWith('M')).toBe(true); // moveto on the first point
    expect(d).toContain('L'); // lineto for the rest
    // legend shows the latest value and the peak
    expect(el.textContent).toContain('30mb');
    expect(el.textContent).toContain('peak 30mb');
    // one current-value dot on the last point
    expect(el.querySelectorAll('circle').length).toBe(1);
  });

  it('draws multiple series sharing one axis', () => {
    const el = render(
      <SvgLineChart
        series={[
          { label: 'in', values: [0, 100], color: 'var(--a)' },
          { label: 'out', values: [0, 20], color: 'var(--b)' },
        ]}
      />,
    );
    expect(el.querySelectorAll('path').length).toBe(2);
    expect(el.querySelectorAll('circle').length).toBe(2);
    expect(el.textContent).toContain('in');
    expect(el.textContent).toContain('out');
  });

  it('renders no line and no peak for an empty series', () => {
    const el = render(
      <SvgLineChart series={[{ label: 'x', values: [], color: 'var(--a)' }]} />,
    );
    expect(el.querySelector('path')?.getAttribute('d')).toBe('');
    expect(el.querySelectorAll('circle').length).toBe(0);
    expect(el.textContent).not.toContain('peak');
  });

  it('places a single-point series mid-width so its dot still renders', () => {
    const el = render(
      <SvgLineChart series={[{ label: 'x', values: [42], color: 'var(--a)' }]} />,
    );
    // one moveto point, no line segment, but a visible dot
    const d = el.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.startsWith('M')).toBe(true);
    expect(d).not.toContain('L');
    expect(el.querySelectorAll('circle').length).toBe(1);
  });
});
