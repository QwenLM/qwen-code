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

    expect(manifest.permissions).not.toContain('activeTab');
  });

  it('derives shell and warning state from the full capability response', () => {
    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );

    expect(script).toContain('deriveCapabilityStatus');
    expect(script).toContain('status.shellReady');
    expect(script).toContain('status.warning');
  });

  it('probes runtime MCP state when browser automation is configured', () => {
    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );

    expect(script).toContain("features.includes('browser_automation_mcp')");
    expect(script).toContain('probeJson(`${baseUrl}/workspace/mcp`, token)');
    expect(script).toContain(
      'deriveCapabilityStatus(true, features, mcpSnapshot, baseUrl)',
    );
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

    await vi.waitFor(() =>
      expect(document.getElementById('capability-warning')?.textContent).toBe(
        'Browser tools status could not be verified.',
      ),
    );

    mcpResponse = {
      ok: true,
      value: { initialized: false, discoveryState: 'not_started', servers: [] },
    };
    await poll?.();
    expect(
      document
        .getElementById('capability-warning')
        ?.classList.contains('hidden'),
    ).toBe(true);

    mcpResponse = { ok: true, value: { servers: [] } };
    await poll?.();
    expect(document.getElementById('capability-warning')?.textContent).toBe(
      'Browser tools are configured but the adapter is not connected.',
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
    await poll?.();
    expect(document.getElementById('capability-warning')?.textContent).toBe(
      'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
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
    await poll?.();
    expect(
      document
        .getElementById('capability-warning')
        ?.classList.contains('hidden'),
    ).toBe(true);
  });
});
