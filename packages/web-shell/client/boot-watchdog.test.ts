// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractInlineScript } from './test/indexHtmlTestUtils';

/**
 * Run the shipped watchdog exactly as the browser does: the inline script
 * executes while `#root` is still unparsed. Tests that need the element call
 * {@link parseRoot} afterwards — never before, or they would exercise a
 * document order this page does not have.
 */
function installBootWatchdog(): void {
  expect(document.getElementById('root')).toBeNull();
  new Function(extractInlineScript('data-boot-fallback'))();
}

/** Finish parsing the document: `#root` appears, then DOMContentLoaded. */
function parseRoot(): HTMLElement {
  document.body.insertAdjacentHTML('beforeend', '<div id="root"></div>');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return document.getElementById('root') as HTMLElement;
}

function mountApp(): HTMLElement {
  const app = document.createElement('div');
  app.setAttribute('data-app', '');
  document.getElementById('root')?.appendChild(app);
  return app;
}

function fallback(): Element | null {
  return document.querySelector('[data-boot-fallback]');
}

function resourceErrorEvent(url: string, message?: string): void {
  const script = document.createElement('script');
  script.src = url;
  document.body.appendChild(script);
  // Real resource-load failures fire a bare, non-bubbling Event; the
  // watchdog listens in the capture phase precisely so it still sees them.
  script.dispatchEvent(
    message ? new ErrorEvent('error', { message }) : new Event('error'),
  );
}

function stylesheetErrorEvent(url: string): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.body.appendChild(link);
  link.dispatchEvent(new Event('error'));
}

function inlineScriptErrorEvent(message: string): void {
  const script = document.createElement('script');
  script.textContent = 'void 0;';
  document.body.appendChild(script);
  script.dispatchEvent(new ErrorEvent('error', { message }));
}

function rejectionEvent(reason: unknown): void {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
}

/** Let jsdom deliver MutationObserver records (queued as microtasks). */
async function flushObservers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('boot watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.documentElement.className = 'theme-dark';
  });

  afterEach(() => {
    // Drive any watchdog left mid-flight to its terminal state, so a stale
    // capture-phase listener cannot render fallbacks in a later test.
    document.body.innerHTML = '<div id="root"><div data-app></div></div>';
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('immediate resource failures', () => {
    it('shows the fallback when a module script fails to load', () => {
      installBootWatchdog();
      parseRoot();

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

    it('shows the fallback for a message-less resource error', () => {
      installBootWatchdog();
      parseRoot();

      resourceErrorEvent('http://localhost:5173/main.tsx');

      expect(fallback()?.textContent).toContain(
        'http://localhost:5173/main.tsx',
      );
    });

    it('shows the fallback when a stylesheet fails to load', () => {
      installBootWatchdog();
      parseRoot();

      stylesheetErrorEvent('http://localhost:5173/assets/index.css');

      expect(fallback()?.textContent).toContain(
        'http://localhost:5173/assets/index.css',
      );
    });

    it('defers an inline-script runtime error to the grace timer', () => {
      installBootWatchdog();
      parseRoot();

      // An inline <script> that throws also targets a SCRIPT element. It is
      // a runtime error, not a failed fetch, so it must not short-circuit to
      // the fallback — boot may still succeed.
      inlineScriptErrorEvent('inline boom');
      expect(fallback()).toBeNull();

      vi.advanceTimersByTime(15_001);

      expect(fallback()?.textContent).toContain('did not start');
      expect(fallback()?.querySelector('pre')?.textContent).toContain(
        'inline boom',
      );
    });
  });

  describe('captured error panel', () => {
    it('captures pre-fallback errors and rejections', () => {
      installBootWatchdog();
      parseRoot();

      window.dispatchEvent(new ErrorEvent('error', { message: 'boot threw' }));
      rejectionEvent(new Error('rejection reason'));
      resourceErrorEvent('http://localhost:5173/main.tsx');

      const pre = fallback()?.querySelector('pre');
      expect(pre?.textContent).toContain('boot threw');
      expect(pre?.textContent).toContain('rejection reason');
    });

    it('captures rejection reasons that are not Errors', () => {
      installBootWatchdog();
      parseRoot();

      rejectionEvent('network timeout');
      rejectionEvent(undefined);
      resourceErrorEvent('http://localhost:5173/main.tsx');

      const pre = fallback()?.querySelector('pre');
      expect(pre?.textContent).toContain('network timeout');
      expect(pre?.textContent).toContain('unhandled rejection');
    });

    it('keeps at most five captured errors', () => {
      installBootWatchdog();
      parseRoot();

      for (let i = 1; i <= 6; i += 1) {
        window.dispatchEvent(new ErrorEvent('error', { message: `boom-${i}` }));
      }
      resourceErrorEvent('http://localhost:5173/main.tsx');

      // A dev-server restart can invalidate several chunks at once; the panel
      // keeps the first few and drops the rest rather than growing without
      // bound.
      const pre = fallback()?.querySelector('pre');
      expect(pre?.textContent).toContain('boom-1');
      expect(pre?.textContent).toContain('boom-5');
      expect(pre?.textContent).not.toContain('boom-6');
    });
  });

  describe('grace timer', () => {
    it('shows the fallback when the app never mounts in time', () => {
      installBootWatchdog();
      parseRoot();

      vi.advanceTimersByTime(14_999);
      expect(fallback()).toBeNull();

      vi.advanceTimersByTime(2);

      expect(fallback()?.textContent).toContain('did not start within 15s');
    });

    it('keeps the specific early reason when the timer later fires', () => {
      installBootWatchdog();
      parseRoot();

      resourceErrorEvent(
        'http://localhost:5173/main.tsx',
        'Failed to load resource: 504 (Outdated Optimize Dep)',
      );
      vi.advanceTimersByTime(15_001);

      // The generic timeout copy must not overwrite the actionable one.
      expect(fallback()?.textContent).toContain('504 (Outdated Optimize Dep)');
      expect(fallback()?.textContent).not.toContain('did not start');
    });

    it('stays silent once the app has mounted', async () => {
      installBootWatchdog();
      parseRoot();
      mountApp();
      await flushObservers();

      vi.advanceTimersByTime(60_000);

      expect(fallback()).toBeNull();
    });

    it('does not clobber the app when a resource fails after mount', async () => {
      installBootWatchdog();
      const root = parseRoot();
      const app = mountApp();
      await flushObservers();

      resourceErrorEvent('http://localhost:5173/lazy-chunk.js');

      expect(fallback()).toBeNull();
      expect(root.firstElementChild).toBe(app);
    });
  });

  describe('uninstall', () => {
    // The watchdog script runs before #root is parsed, so a MutationObserver
    // created at install time would be constructed against null and silently
    // dropped — the failure this suite exists to pin. Every test here runs in
    // that shipped order.
    it('observes #root even though it is parsed after the script', () => {
      const observed: Node[] = [];
      const Real = globalThis.MutationObserver;
      class Recording extends Real {
        override observe(target: Node, options?: MutationObserverInit): void {
          observed.push(target);
          super.observe(target, options);
        }
      }
      globalThis.MutationObserver = Recording;

      try {
        installBootWatchdog();
        expect(observed).toEqual([]);

        const root = parseRoot();

        expect(observed).toEqual([root]);
      } finally {
        globalThis.MutationObserver = Real;
      }
    });

    it('releases listeners, timer and observer once the app mounts', async () => {
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      const clear = vi.spyOn(globalThis, 'clearTimeout');

      installBootWatchdog();
      const root = parseRoot();
      mountApp();
      await flushObservers();

      expect(disconnect).toHaveBeenCalled();
      expect(clear).toHaveBeenCalled();

      // Behavioural oracle: with the capture-phase listeners gone, nothing
      // can render a fallback any more. Any silently-failed removal (a
      // dropped `true` capture flag, a deleted call site) resurrects one.
      root.textContent = '';
      resourceErrorEvent('http://localhost:5173/late-chunk.js');
      vi.advanceTimersByTime(60_000);

      expect(fallback()).toBeNull();
      disconnect.mockRestore();
      clear.mockRestore();
    });

    it('releases listeners once the fallback is rendered', () => {
      installBootWatchdog();
      const root = parseRoot();

      resourceErrorEvent('http://localhost:5173/main.tsx');
      expect(fallback()).not.toBeNull();

      // The box is terminal, so the watchdog is done: later failures must
      // find nothing listening.
      root.textContent = '';
      resourceErrorEvent('http://localhost:5173/other-chunk.js');
      vi.advanceTimersByTime(60_000);

      expect(fallback()).toBeNull();
    });

    it('uninstalls when the app mounted before the observer installed', async () => {
      installBootWatchdog();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="root"><div data-app></div></div>',
      );
      document.dispatchEvent(new Event('DOMContentLoaded'));

      const root = document.getElementById('root') as HTMLElement;
      root.textContent = '';
      resourceErrorEvent('http://localhost:5173/late-chunk.js');
      vi.advanceTimersByTime(60_000);

      expect(fallback()).toBeNull();
    });
  });
});
