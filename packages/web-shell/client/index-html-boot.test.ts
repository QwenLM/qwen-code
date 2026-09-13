/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { readIndexHtml } from './test/indexHtmlTestUtils';

/**
 * Parse the real index.html the way a browser does — inline scripts execute
 * during parsing, in document order — instead of hand-placing #root around a
 * hand-installed watchdog. The bug this file guards against was invisible to
 * a simulated order: a MutationObserver built at install time is constructed
 * against a #root that has not been parsed yet.
 */
function bootDocument(userAgent?: string): JSDOM {
  // Drop only the module script's src: jsdom would try to fetch /main.tsx,
  // and the app never mounting is precisely the state under test.
  const html = readIndexHtml().replace(' src="/main.tsx"', '');

  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:5173/',
    beforeParse(window) {
      if (userAgent)
        Object.defineProperty(window.navigator, 'userAgent', {
          value: userAgent,
        });
    },
  });
}

function failResource(dom: JSDOM, url: string, message?: string): void {
  const { document, ErrorEvent, Event } = dom.window;
  const script = document.createElement('script');
  script.src = url;
  document.body.appendChild(script);
  script.dispatchEvent(
    message ? new ErrorEvent('error', { message }) : new Event('error'),
  );
}

function root(dom: JSDOM): HTMLElement {
  return dom.window.document.getElementById('root') as HTMLElement;
}

function fallback(dom: JSDOM): Element | null {
  return dom.window.document.querySelector('[data-boot-fallback]');
}

describe('boot watchdog in a really parsed document', () => {
  it.each([
    'Mozilla/5.0 Chrome/110.0.0.0 Safari/537.36',
    'Mozilla/5.0 Firefox/127.0',
    'Mozilla/5.0 Version/16.3 Mobile/15E148 Safari/604.1',
  ])(
    'shows one update screen inside the real root for %s',
    async (userAgent) => {
      const dom = bootDocument(userAgent);
      await new Promise((resolve) => dom.window.queueMicrotask(resolve));
      expect(
        root(dom).querySelector('[data-boot-fallback]')?.textContent,
      ).toContain('Browser update required');
      expect(
        root(dom).querySelector('[data-boot-fallback]')?.textContent,
      ).toContain('111+');
      expect(
        dom.window.document.querySelectorAll('[data-boot-fallback]'),
      ).toHaveLength(1);
      dom.window.close();
    },
  );

  it.each([
    'Mozilla/5.0 Chrome/111.0.0.0 Safari/537.36',
    'Mozilla/5.0 Firefox/128.0',
    'Mozilla/5.0 Version/16.4 Mobile/15E148 Safari/604.1',
  ])('permits the declared browser floor for %s', async (userAgent) => {
    const dom = bootDocument(userAgent);
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));
    expect(
      dom.window.document.documentElement.hasAttribute(
        'data-web-shell-unsupported-browser',
      ),
    ).toBe(false);
    expect(fallback(dom)).toBeNull();
    dom.window.close();
  });

  it('renders the fallback when a module fails to load', () => {
    const dom = bootDocument();

    failResource(
      dom,
      'http://localhost:5173/main.tsx',
      'Failed to load resource: 504 (Outdated Optimize Dep)',
    );

    expect(fallback(dom)?.textContent).toContain('504 (Outdated Optimize Dep)');
    dom.window.close();
  });

  it('uninstalls on mount even though #root is parsed after the script', async () => {
    const dom = bootDocument();

    const app = dom.window.document.createElement('div');
    app.setAttribute('data-app', '');
    root(dom).appendChild(app);
    // The mount observer only exists if installation was deferred past
    // parsing; without it nothing ever releases the capture-phase listeners.
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));

    root(dom).textContent = '';
    failResource(dom, 'http://localhost:5173/late-chunk.js');

    expect(fallback(dom)).toBeNull();
    dom.window.close();
  });
});
