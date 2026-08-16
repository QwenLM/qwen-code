// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractInlineScript } from './index-html-test-utils';

function installBootWatchdog(): void {
  new Function(extractInlineScript('data-boot-fallback'))();
}

function fallback(): Element | null {
  return document.querySelector('[data-boot-fallback]');
}

function resourceErrorEvent(src: string, message?: string): Event {
  const script = document.createElement('script');
  script.src = src;
  document.body.appendChild(script);
  // Real resource-load failures fire a bare, non-bubbling Event; the
  // watchdog listens in the capture phase precisely so it still sees them.
  const event = message
    ? new ErrorEvent('error', { message })
    : new Event('error');
  script.dispatchEvent(event);
  return event;
}

describe('boot watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('shows the fallback when a module script fails to load', () => {
    installBootWatchdog();
    resourceErrorEvent(
      'http://localhost:5173/main.tsx',
      'Failed to load resource: 504 (Outdated Optimize Dep)',
    );

    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('Web Shell 加载失败');
    expect(box?.textContent).toContain('504 (Outdated Optimize Dep)');
    expect(box?.textContent).toContain('http://localhost:5173/main.tsx');
    expect(box?.querySelector('button')?.textContent).toContain('Reload');
  });

  it('shows the fallback for a message-less resource error event', () => {
    installBootWatchdog();
    resourceErrorEvent('http://localhost:5173/main.tsx');

    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('http://localhost:5173/main.tsx');
  });

  it('captures pre-fallback errors and rejections in the panel', () => {
    installBootWatchdog();
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'second failure' }),
    );
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', {
      value: new Error('rejection reason'),
    });
    window.dispatchEvent(rejection);
    resourceErrorEvent('http://localhost:5173/main.tsx');

    const pre = fallback()?.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('second failure');
    expect(pre?.textContent).toContain('rejection reason');
  });

  it('keeps the specific early reason when the grace timer later fires', () => {
    installBootWatchdog();
    resourceErrorEvent(
      'http://localhost:5173/main.tsx',
      'Failed to load resource: 504 (Outdated Optimize Dep)',
    );
    expect(fallback()?.textContent).toContain('504 (Outdated Optimize Dep)');

    vi.advanceTimersByTime(15_001);

    // The specific resource reason must not be overwritten by the generic
    // timeout copy.
    expect(fallback()?.textContent).toContain('504 (Outdated Optimize Dep)');
    expect(fallback()?.textContent).not.toContain('did not start within');
  });

  it('shows the fallback when the app never mounts within the grace period', () => {
    installBootWatchdog();
    expect(fallback()).toBeNull();

    vi.advanceTimersByTime(15_001);

    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('did not start');
  });

  it('does not clobber the app when a resource fails after mount', () => {
    installBootWatchdog();
    const app = document.createElement('div');
    app.setAttribute('data-app', '');
    document.getElementById('root')?.appendChild(app);

    resourceErrorEvent('http://localhost:5173/lazy-chunk.tsx');

    expect(fallback()).toBeNull();
    expect(document.getElementById('root')?.firstElementChild).toBe(app);
  });

  it('stays silent once the app has mounted', () => {
    installBootWatchdog();
    const app = document.createElement('div');
    app.setAttribute('data-app', '');
    document.getElementById('root')?.appendChild(app);

    vi.advanceTimersByTime(60_000);

    expect(fallback()).toBeNull();
  });
});
