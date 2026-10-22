/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShowResult } from '../contracts.js';
import type { ViewState } from './controller.js';

const presentation = vi.hoisted(() => ({
  onStatus: undefined as ((state: ViewState) => void) | undefined,
}));
vi.mock('./controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./controller.js')>();
  return {
    ...actual,
    ViewController: class extends actual.ViewController {
      constructor(
        ...args: ConstructorParameters<typeof actual.ViewController>
      ) {
        super(...args);
        presentation.onStatus = args[3];
      }
    },
  };
});

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
const frame = () => document.getElementById('view') as HTMLIFrameElement;
const stop = () => document.getElementById('stop') as HTMLButtonElement;
function present(state: Partial<ViewState>) {
  presentation.onStatus!({
    phase: 'ready',
    viewAvailable: true,
    rejectedEvents: 0,
    ...state,
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  presentation.onStatus = undefined;
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

describe('generated view interaction feedback', () => {
  it('shows an available view while its queued work is still running', () => {
    present({ phase: 'starting', viewAvailable: false });
    expect(frame().hidden).toBe(true);
    expect(frame().getAttribute('aria-busy')).toBe('true');
    expect(text('status')).toContain('Starting');
    expect(stop().disabled).toBe(false);

    present({ phase: 'running' });
    expect(frame().hidden).toBe(false);
    expect(frame().getAttribute('aria-busy')).toBe('true');
    expect(text('status')).toBe('Updating the view…');

    present({ phase: 'ready', lastUpdate: 'applied' });
    expect(frame().getAttribute('aria-busy')).toBe('false');
    expect(text('status')).toBe('Latest update applied');
  });

  it('explains unapplied parameters without presenting dirty as applied', () => {
    present({ phase: 'dirty' });
    expect(document.getElementById('status')!.dataset['state']).toBe('dirty');
    expect(text('status')).toContain('Parameters changed');
    expect(text('status')).not.toContain('applied');
    expect(frame().hidden).toBe(false);
    expect(frame().getAttribute('aria-busy')).toBe('false');
  });

  it.each([
    ['superseded', 'An older update was skipped. Your newer inputs were kept.'],
    ['outdated', 'The displayed update may still use earlier parameters.'],
  ] as const)('shows the %s update notice', (lastUpdate, message) => {
    present({ phase: 'dirty', lastUpdate });
    expect(text('notice')).toBe(message);
    expect(document.getElementById('notice')!.hidden).toBe(false);
    expect(text('status')).toContain('Parameters changed');
  });

  it('keeps rejected-interaction feedback when subsequent work becomes ready', () => {
    present({
      phase: 'running',
      lastUpdate: 'superseded',
      rejectedEvents: 3,
    });
    expect(text('notice')).toContain('An older update was skipped');
    expect(text('notice')).toContain('queue was full');

    present({ phase: 'ready', lastUpdate: 'applied', rejectedEvents: 3 });
    expect(text('status')).toBe('Latest update applied');
    expect(text('notice')).toContain('queue was full');
    expect(text('notice')).toContain('repeat the intended action');
    expect(text('notice')).not.toContain('An older update was skipped');
    expect(document.getElementById('notice')!.hidden).toBe(false);
  });

  it.each(['stopped', 'error'] as const)(
    'disables Stop and clears old interaction notices on %s',
    (phase) => {
      present({
        phase: 'running',
        lastUpdate: 'outdated',
        rejectedEvents: 2,
      });
      expect(text('notice')).not.toBe('');
      present({
        phase,
        lastUpdate: 'outdated',
        rejectedEvents: 2,
        error: 'The event timed out. Use the summary.',
      });
      expect(stop().disabled).toBe(true);
      expect(text('notice')).toBe('');
      expect(document.getElementById('notice')!.hidden).toBe(true);
      expect(frame().getAttribute('aria-busy')).toBe('false');
      expect(text('status')).toBe(
        phase === 'stopped'
          ? 'Stopped. Reopen the card to start a new view.'
          : 'The event timed out. Use the summary.',
      );
    },
  );

  it('does not rewrite live-region text when the rendered messages are unchanged', () => {
    const state = {
      phase: 'running',
      lastUpdate: 'superseded',
      rejectedEvents: 1,
    } as const;
    present(state);
    const observer = new MutationObserver(() => {});
    for (const id of ['status', 'notice']) {
      const region = document.getElementById(id)!;
      expect(region.getAttribute('aria-live')).toBe('polite');
      observer.observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    present(state);
    present({ ...state, rejectedEvents: 2 });
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });
});
