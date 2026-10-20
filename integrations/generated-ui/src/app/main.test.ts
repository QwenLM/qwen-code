/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShowResult } from '../contracts.js';

const bridge = vi.hoisted(() => ({
  events: new Map<string, (value?: unknown) => void>(),
  connect: vi.fn(),
  getHostContext: vi.fn(),
  onteardown: undefined as (() => Promise<object>) | undefined,
}));
vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    constructor() {
      return {
        ...bridge,
        addEventListener: (name: string, callback: (value?: unknown) => void) =>
          bridge.events.set(name, callback),
        set onteardown(callback: () => Promise<object>) {
          bridge.onteardown = callback;
        },
      };
    }
  },
  applyDocumentTheme: vi.fn(),
}));

const input = {
  title: 'Verified capacity',
  summary: 'Four workers provide 100 requests/s.',
  html: '<output id="answer">100</output>',
  css: '',
  javascript: '',
};
const text = (id: string) => document.getElementById(id)!.textContent;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  bridge.events.clear();
  bridge.connect.mockResolvedValue(undefined);
  bridge.getHostContext.mockReturnValue({});
  vi.stubGlobal('Worker', undefined);
  document.body.innerHTML = readFileSync('src/app/index.html', 'utf8');
  await import('./main.js');
});
afterEach(async () => {
  await bridge.onteardown?.();
  globalThis.dispatchEvent(new Event('pagehide'));
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('generated view result presentation', () => {
  it('does not present an identity-mismatched relay title or summary', () => {
    const result = createShowResult(input);
    result.structuredContent = {
      ...result.structuredContent,
      title: 'Unverified',
      summary: 'Unverified summary',
    };
    bridge.events.get('toolresult')!(result);
    expect(text('title')).toBe('Interactive view');
    expect(text('summary')).toBe('Waiting for the completed view…');
    expect(text('status')).toContain('does not match its identity');
  });

  it('does not present a raw summary when the snapshot is missing', () => {
    const result = createShowResult(input);
    delete result._meta;
    bridge.events.get('toolresult')!(result);
    expect(text('title')).toBe('Interactive view');
    expect(text('summary')).toBe('Waiting for the completed view…');
    expect(text('status')).toContain('Invalid or unsupported');
  });

  it.each(['stop', 'toolcancelled', 'pagehide', 'teardown'])(
    'ignores late presentation after %s',
    async (reason) => {
      if (reason === 'stop') document.getElementById('stop')!.click();
      else if (reason === 'toolcancelled')
        bridge.events.get('toolcancelled')!();
      else if (reason === 'teardown') await bridge.onteardown!();
      else globalThis.dispatchEvent(new Event('pagehide'));
      bridge.events.get('toolresult')!(createShowResult(input));
      expect(text('title')).toBe('Interactive view');
      expect(text('summary')).toBe('Waiting for the completed view…');
      expect(document.getElementById('status')!.dataset['state']).toBe(
        'stopped',
      );
    },
  );

  it('retains verified text when the browser cannot start the runtime', async () => {
    bridge.events.get('toolresult')!(createShowResult(input));
    expect(text('title')).toBe(input.title);
    expect(text('summary')).toBe(input.summary);
    await vi.waitFor(() =>
      expect(text('status')).toContain('cannot run the view'),
    );
  });
});
