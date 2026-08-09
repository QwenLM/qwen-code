/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { getDemoHtml } from './demo.js';

const SESSION_ID = 'sess-1';
const DEMO_PORT = 4321;

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  };
}

function sseStream(...updates: Array<Record<string, unknown>>): string {
  return updates
    .map((update) => {
      const event = { type: 'session_update', data: { update } };
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
}

function createDemoPage(sseStreams: string[]): JSDOM {
  let sseConnection = 0;
  const fetchMock = async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === '/session') {
      return jsonResponse({ sessionId: SESSION_ID });
    }
    if (url === '/health') {
      return jsonResponse({ status: 'ok' });
    }
    if (url.endsWith('/events')) {
      const chunk = new TextEncoder().encode(sseStreams[sseConnection] ?? '');
      sseConnection += 1;
      let delivered = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (delivered) {
                return { done: true, value: undefined };
              }
              delivered = true;
              return { done: false, value: chunk };
            },
          }),
        },
      };
    }
    return jsonResponse({});
  };

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    console.error(error);
  });

  return new JSDOM(getDemoHtml(DEMO_PORT), {
    runScripts: 'dangerously',
    url: `http://localhost:${DEMO_PORT}/`,
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetchMock as unknown as typeof window.fetch;
      // jsdom does not ship these globals; browsers always have them.
      const win = window as unknown as Record<string, unknown>;
      win['TextEncoder'] = TextEncoder;
      win['TextDecoder'] = TextDecoder;
    },
  });
}

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function ctxEntries(doc: Document): Element[] {
  return [...doc.querySelectorAll('#eventLog .log-entry')].filter(
    (entry) => entry.querySelector('.tag')?.textContent === 'CTX',
  );
}

async function attachSession(doc: Document) {
  (doc.querySelector('#cwdInput') as HTMLInputElement).value = '/tmp/demo';
  (doc.querySelector('#btnCreateSession') as HTMLButtonElement).click();
  await waitFor(
    () => doc.querySelector('#sessionIdDisplay')?.textContent === SESSION_ID,
    'session creation',
  );
}

describe('demo page usage_update handling', () => {
  let dom: JSDOM;

  afterEach(() => {
    if (dom) {
      dom.window.close();
    }
  });

  it('logs one CTX entry per integer percentage and updates the meter in place', async () => {
    dom = createDemoPage([
      sseStream(
        { sessionUpdate: 'usage_update', used: 50, size: 200 },
        { sessionUpdate: 'usage_update', used: 51, size: 204 },
        { sessionUpdate: 'usage_update', used: 51, size: 200 },
        { sessionUpdate: 'usage_update', used: 100000, size: 131072 },
        { sessionUpdate: 'usage_update', used: 30, size: 200 },
      ),
    ]);
    const doc = dom.window.document;
    await attachSession(doc);

    const contextUsage = doc.querySelector('#contextUsage') as HTMLElement;
    await waitFor(
      () => contextUsage.textContent === 'Context: 30 / 200 (15%)',
      'meter to reach the final frame',
    );

    expect(contextUsage.style.display).toBe('block');
    const entries = ctxEntries(doc);
    expect(entries).toHaveLength(4);
    expect(entries[0].textContent).toContain('50 / 200 (25%)');
    expect(entries[1].textContent).toContain('51 / 200 (26%)');
    expect(entries[2].textContent).toContain('100000 / 131072 (76%)');
    expect(entries[3].textContent).toContain('30 / 200 (15%)');
    // Pins the script-scoped let: without the declaration the dedup state
    // degrades to an implicit window global and nothing else in the suite fails.
    expect('lastLoggedContextPct' in dom.window).toBe(false);
  });

  it('ignores malformed usage_update frames', async () => {
    dom = createDemoPage([
      sseStream(
        { sessionUpdate: 'usage_update', used: 50, size: 200 },
        { sessionUpdate: 'usage_update', used: 70, size: 0 },
        { sessionUpdate: 'usage_update', size: 200 },
        { sessionUpdate: 'usage_update', used: 52, size: 208 },
        { sessionUpdate: 'usage_update', used: 40, size: '100' },
      ),
    ]);
    const doc = dom.window.document;
    await attachSession(doc);

    const contextUsage = doc.querySelector('#contextUsage') as HTMLElement;
    await waitFor(
      () => contextUsage.textContent === 'Context: 52 / 208 (25%)',
      'meter to reach the final valid frame',
    );

    expect(ctxEntries(doc)).toHaveLength(1);
    expect(contextUsage.style.display).toBe('block');
  });

  it('re-arms CTX logging when a new session is created', async () => {
    dom = createDemoPage([
      sseStream({ sessionUpdate: 'usage_update', used: 50, size: 200 }),
      sseStream({ sessionUpdate: 'usage_update', used: 50, size: 200 }),
    ]);
    const doc = dom.window.document;
    await attachSession(doc);

    const contextUsage = doc.querySelector('#contextUsage') as HTMLElement;
    await waitFor(
      () => contextUsage.textContent === 'Context: 50 / 200 (25%)',
      'meter for the first session',
    );
    expect(ctxEntries(doc)).toHaveLength(1);

    (doc.querySelector('#btnCreateSession') as HTMLButtonElement).click();
    await waitFor(
      () => ctxEntries(doc).length === 2,
      're-armed CTX entry after session reset',
    );

    const entries = ctxEntries(doc);
    expect(entries[1].textContent).toContain('50 / 200 (25%)');
    expect(contextUsage.style.display).toBe('block');
  });

  it('hides the context meter when a new session is created', async () => {
    dom = createDemoPage([
      sseStream({ sessionUpdate: 'usage_update', used: 50, size: 200 }),
      sseStream(),
    ]);
    const doc = dom.window.document;
    await attachSession(doc);

    const contextUsage = doc.querySelector('#contextUsage') as HTMLElement;
    await waitFor(
      () => contextUsage.textContent === 'Context: 50 / 200 (25%)',
      'meter for the first session',
    );
    expect(contextUsage.style.display).toBe('block');

    (doc.querySelector('#btnCreateSession') as HTMLButtonElement).click();
    await waitFor(
      () =>
        [...doc.querySelectorAll('#eventLog .log-entry')].filter((entry) =>
          entry.textContent?.includes('Stream ended by server'),
        ).length === 2,
      'second session stream to end',
    );

    expect(contextUsage.style.display).toBe('none');
    expect(ctxEntries(doc)).toHaveLength(1);
  });
});
