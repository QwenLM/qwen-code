/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveCapabilityStatus } from './capability-status.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// The panel scripts below are executed through Function(script)(), which only
// accepts classic scripts: an import/export statement added to a public/*.js
// file surfaces here as a SyntaxError in a test, not as a build error.

describe('side panel capability status assets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('loads the generated capability model before the panel host', () => {
    const html = readFileSync(
      path.join(packageRoot, 'public/sidepanel.html'),
      'utf8',
    );

    expect(html).toContain('src="sidepanel/capability-status.js"');
    expect(html.indexOf('sidepanel/capability-status.js')).toBeLessThan(
      html.indexOf('src="sidepanel.js"'),
    );
  });

  it('provides a live region for browser automation warnings', () => {
    const html = readFileSync(
      path.join(packageRoot, 'public/sidepanel.html'),
      'utf8',
    );

    expect(html).toContain('id="capability-warning"');
    expect(html).toContain('role="status"');
  });

  it('requests only permissions used by the extension', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, 'public/manifest.json'), 'utf8'),
    ) as { permissions?: string[] };

    expect(manifest.permissions).toEqual([
      'tabs',
      'storage',
      'debugger',
      'alarms',
      'sidePanel',
    ]);
  });

  it('transitions between welcome, shell, and warning states', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    vi.stubGlobal('QwenCapabilityStatus', { deriveCapabilityStatus });

    let daemonState: 'down' | 'chat-only' = 'down';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (daemonState === 'down') throw new Error('daemon unavailable');
        const url = String(input);
        return {
          ok: true,
          json: async () =>
            url.endsWith('/capabilities')
              ? { features: ['allow_origin'] }
              : { status: 'ok' },
        };
      }),
    );
    let poll: (() => void | Promise<void>) | undefined;
    vi.stubGlobal('setInterval', (handler: () => void | Promise<void>) => {
      poll = handler;
      return 1;
    });

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    await vi.waitFor(() =>
      expect(document.getElementById('welcome-title')?.textContent).toBe(
        'Start qwen serve',
      ),
    );

    daemonState = 'chat-only';
    await poll?.();
    expect(document.getElementById('ui')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(document.getElementById('capability-warning')?.textContent).toBe(
      'Browser bridge is disabled for this daemon.',
    );

    daemonState = 'down';
    await poll?.();
    await poll?.();
    await poll?.();
    expect(
      document.getElementById('welcome')?.classList.contains('hidden'),
    ).toBe(false);
    expect(
      document
        .getElementById('capability-warning')
        ?.classList.contains('hidden'),
    ).toBe(true);
  });
  it('tolerates transient probe errors without tearing down the shell', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    const deriveSpy = vi.fn(deriveCapabilityStatus);
    vi.stubGlobal('QwenCapabilityStatus', {
      deriveCapabilityStatus: deriveSpy,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return {
          ok: true,
          json: async () =>
            url.endsWith('/capabilities')
              ? { features: ['allow_origin'] }
              : { status: 'ok' },
        };
      }),
    );
    let poll: (() => void | Promise<void>) | undefined;
    vi.stubGlobal('setInterval', (handler: () => void | Promise<void>) => {
      poll = handler;
      return 1;
    });

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    // Wait for the shell to frame.
    await vi.waitFor(() =>
      expect(document.getElementById('ui')?.classList.contains('hidden')).toBe(
        false,
      ),
    );

    // Make probeState throw on every tick (simulates a broken capability model).
    deriveSpy.mockImplementation(() => {
      throw new Error('capability model failed to load');
    });

    // The shell must survive FRAMED_MISS_LIMIT transient failures.
    await poll?.();
    expect(document.getElementById('ui')?.classList.contains('hidden')).toBe(
      false,
    );
    await poll?.();
    expect(document.getElementById('ui')?.classList.contains('hidden')).toBe(
      false,
    );

    // After exceeding the tolerance the welcome screen appears.
    await poll?.();
    expect(
      document.getElementById('welcome')?.classList.contains('hidden'),
    ).toBe(false);
  });

  it('renders runtime MCP diagnostics from the live status endpoint', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    vi.stubGlobal('QwenCapabilityStatus', { deriveCapabilityStatus });

    let mcpResponse:
      | { ok: false }
      | { ok: true; value: Record<string, unknown> } = { ok: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/capabilities')) {
          return {
            ok: true,
            json: async () => ({
              features: [
                'allow_origin',
                'cdp_tunnel_over_ws',
                'browser_automation_mcp',
              ],
            }),
          };
        }
        if (url.endsWith('/workspace/mcp')) {
          return {
            ok: mcpResponse.ok,
            json: async () =>
              mcpResponse.ok ? mcpResponse.value : { error: 'unavailable' },
          };
        }
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }),
    );
    let poll: (() => void | Promise<void>) | undefined;
    vi.stubGlobal('setInterval', (handler: () => void | Promise<void>) => {
      poll = handler;
      return 1;
    });

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    // `/workspace/mcp` is only re-probed every MCP_POLL_EVERY ticks, so drive
    // the poll until the banner reflects the freshly fetched snapshot.
    const pollUntil = (assertion: () => void) =>
      vi.waitFor(async () => {
        await poll?.();
        assertion();
      });

    await vi.waitFor(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools status could not be verified.',
      ),
    );

    mcpResponse = {
      ok: true,
      value: { initialized: false, discoveryState: 'not_started', servers: [] },
    };
    await pollUntil(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools status is unknown until a chat session starts.',
      ),
    );

    mcpResponse = { ok: true, value: { servers: [] } };
    await pollUntil(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools are configured but the adapter is not connected.',
      ),
    );

    mcpResponse = {
      ok: true,
      value: {
        servers: [
          {
            name: 'chrome-devtools',
            mcpStatus: 'connected',
            config: { args: ['--autoConnect'] },
          },
        ],
      },
    };
    await pollUntil(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
      ),
    );

    mcpResponse = {
      ok: true,
      value: {
        servers: [
          {
            name: 'chrome-devtools',
            mcpStatus: 'connected',
            config: { args: ['--wsEndpoint', 'ws://127.0.0.1:4170/cdp'] },
          },
        ],
      },
    };
    await pollUntil(() =>
      expect(
        document
          .getElementById('capability-warning')
          ?.classList.contains('hidden'),
      ).toBe(true),
    );
  });

  it('treats a non-JSON 200 health response as unreachable', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    vi.stubGlobal('QwenCapabilityStatus', { deriveCapabilityStatus });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      })),
    );
    vi.stubGlobal('setInterval', () => 1);

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    await vi.waitFor(() =>
      expect(document.getElementById('welcome-title')?.textContent).toBe(
        'Start qwen serve',
      ),
    );
  });

  it('retains the previous MCP snapshot across a transient probe failure', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    vi.stubGlobal('QwenCapabilityStatus', { deriveCapabilityStatus });

    let mcpOk = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/capabilities')) {
          return {
            ok: true,
            json: async () => ({
              features: [
                'allow_origin',
                'cdp_tunnel_over_ws',
                'browser_automation_mcp',
              ],
            }),
          };
        }
        if (url.endsWith('/workspace/mcp')) {
          return {
            ok: mcpOk,
            json: async () => (mcpOk ? { servers: [] } : { error: 'down' }),
          };
        }
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }),
    );
    let poll: (() => void | Promise<void>) | undefined;
    vi.stubGlobal('setInterval', (handler: () => void | Promise<void>) => {
      poll = handler;
      return 1;
    });

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    await vi.waitFor(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools are configured but the adapter is not connected.',
      ),
    );

    mcpOk = false;
    // Drive past the next MCP re-probe tick (MCP_POLL_EVERY = 5).
    for (let i = 0; i < 6; i++) await poll?.();
    expect(document.getElementById('capability-warning')?.textContent).toBe(
      'Browser tools are configured but the adapter is not connected.',
    );
  });

  it('resets the MCP cache when the daemon URL changes', async () => {
    document.body.innerHTML = `
      <iframe id="ui" class="hidden"></iframe>
      <main id="welcome"><h1 id="welcome-title"></h1><p id="welcome-desc"></p></main>
      <code id="cmd"></code><button id="cmd-row"></button>
      <button id="copy"></button><span id="copy-label"></span>
      <div id="capability-warning" class="hidden"></div>
    `;
    let storedBaseUrl = 'http://127.0.0.1:4170';
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      storage: {
        local: {
          get: vi.fn().mockImplementation(async () => ({
            'qwen.daemon': { baseUrl: storedBaseUrl },
          })),
        },
      },
    });
    vi.stubGlobal('QwenCapabilityStatus', { deriveCapabilityStatus });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/capabilities')) {
          return {
            ok: true,
            json: async () => ({
              features: [
                'allow_origin',
                'cdp_tunnel_over_ws',
                'browser_automation_mcp',
              ],
            }),
          };
        }
        if (url.endsWith('/workspace/mcp')) {
          // The first URL returns a valid snapshot; the second fails.
          const ok = url.startsWith('http://127.0.0.1:4170');
          return {
            ok,
            json: async () => (ok ? { servers: [] } : { error: 'down' }),
          };
        }
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }),
    );
    let poll: (() => void | Promise<void>) | undefined;
    vi.stubGlobal('setInterval', (handler: () => void | Promise<void>) => {
      poll = handler;
      return 1;
    });

    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );
    Function(script)();

    await vi.waitFor(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools are configured but the adapter is not connected.',
      ),
    );

    storedBaseUrl = 'http://127.0.0.1:5999';
    // The URL change resets the cache; the new URL's MCP probe fails, so the
    // banner must flip to automation-unavailable rather than reuse the stale
    // snapshot from the old URL.
    await vi.waitFor(async () => {
      await poll?.();
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools status could not be verified.',
      );
    });
  });
});
