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
      'deriveCapabilityStatus(true, features, mcpSnapshot)',
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
});
