// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installBootWatchdog(): void {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  const script = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  )
    .map((match) => match[1] ?? '')
    .find((source) => source.includes('data-boot-fallback'));

  if (!script) throw new Error('Boot watchdog script not found');
  new Function(script)();
}

function fallback(): Element | null {
  return document.querySelector('[data-boot-fallback]');
}

describe('boot watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('shows the fallback when a module script fails to load', () => {
    installBootWatchdog();
    const script = document.createElement('script');
    script.src = 'http://localhost:5173/main.tsx';
    document.body.appendChild(script);

    script.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Failed to load resource: 504 (Outdated Optimize Dep)',
        bubbles: true,
      }),
    );

    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('Web Shell 加载失败');
    expect(box?.textContent).toContain('504 (Outdated Optimize Dep)');
    expect(box?.querySelector('button')?.textContent).toContain('Reload');
  });

  it('shows the fallback when the app never mounts within the grace period', () => {
    installBootWatchdog();
    expect(fallback()).toBeNull();

    vi.advanceTimersByTime(15_001);

    const box = fallback();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('did not start');
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
