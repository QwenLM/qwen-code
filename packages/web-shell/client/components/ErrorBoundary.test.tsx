// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function Boom({ explode }: { explode: boolean }): React.ReactElement {
  if (explode) throw new Error('kaboom');
  return <div data-testid="ok">healthy</div>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    const container = render(
      <ErrorBoundary fallback={<div data-testid="fallback" />}>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="ok"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
  });

  it('renders the fallback when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(
      <ErrorBoundary fallback={<div data-testid="fallback">down</div>}>
        <Boom explode={true} />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ok"]')).toBeNull();
  });

  it('passes the captured error to a render-prop fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(
      <ErrorBoundary
        fallback={(error) => <div data-testid="fallback">{error.message}</div>}
      >
        <Boom explode={true} />
      </ErrorBoundary>,
    );
    expect(
      container.querySelector('[data-testid="fallback"]')?.textContent,
    ).toBe('kaboom');
  });

  it('logs the error with the configured label prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="message:assistant" fallback={<div />}>
        <Boom explode={true} />
      </ErrorBoundary>,
    );
    expect(
      spy.mock.calls.some(
        ([first]) =>
          typeof first === 'string' &&
          first.includes('[web-shell] message:assistant failed:'),
      ),
    ).toBe(true);
  });

  it('recovers when resetKeys change after an error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <ErrorBoundary
          resetKeys={[1]}
          fallback={<div data-testid="fallback" />}
        >
          <Boom explode={true} />
        </ErrorBoundary>,
      ),
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();

    // Same key + now-healthy child: the boundary is still latched on the error,
    // so the fallback persists until a reset key actually changes.
    act(() =>
      root.render(
        <ErrorBoundary
          resetKeys={[1]}
          fallback={<div data-testid="fallback" />}
        >
          <Boom explode={false} />
        </ErrorBoundary>,
      ),
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ok"]')).toBeNull();

    // Changed key clears the error and re-mounts the (now healthy) child.
    act(() =>
      root.render(
        <ErrorBoundary
          resetKeys={[2]}
          fallback={<div data-testid="fallback" />}
        >
          <Boom explode={false} />
        </ErrorBoundary>,
      ),
    );
    expect(container.querySelector('[data-testid="ok"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
  });

  it('keeps showing the fallback when a stable broken child never changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const tree = (
      <ErrorBoundary resetKeys={[1]} fallback={<div data-testid="fallback" />}>
        <Boom explode={true} />
      </ErrorBoundary>
    );
    act(() => root.render(tree));
    act(() => root.render(tree));
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });
});
