/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShowResult, parseToolResult } from '../contracts.js';
import type { GeneratedDocument } from '../contracts.js';
import type { CaptureResult, ViewState } from './controller.js';

const presentation = vi.hoisted(() => ({
  onStatus: undefined as ((state: ViewState) => void) | undefined,
  onDocument: undefined as ((document: GeneratedDocument) => void) | undefined,
  capture: vi.fn<() => CaptureResult>(),
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
        presentation.onDocument = args[2];
      }
      override captureSnapshot() {
        return presentation.capture();
      }
    },
  };
});

const bridge = vi.hoisted(() => ({
  events: new Map<string, (value?: unknown) => void>(),
  connect: vi.fn(),
  getHostContext: vi.fn(),
  getHostVersion: vi.fn(),
  getHostCapabilities: vi.fn(),
  sendMessage: vi.fn(),
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
  applyHostStyleVariables: vi.fn(),
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
  bridge.getHostVersion.mockReturnValue({ name: 'qwen-code-web-shell' });
  bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
  bridge.sendMessage.mockResolvedValue({});
  presentation.capture.mockReturnValue({ ok: false, reason: 'not-ready' });
  vi.stubGlobal('Worker', undefined);
  document.body.innerHTML = readFileSync('src/app/index.html', 'utf8');
  await import('./main.js');
});

const continuation = () =>
  document.getElementById('continue-analysis') as HTMLButtonElement;
const capture = (value = '8'): Extract<CaptureResult, { ok: true }> => ({
  ok: true,
  snapshot: {
    schemaVersion: 1,
    documentId: 'g1-example',
    activationId: 'one',
    appliedSequence: 2,
    baseInputRevision: 1,
    inputRevision: 1,
    inputs: { workers: { value, checked: false } },
  },
  rejectedEvents: 0,
});
function ready() {
  presentation.onDocument!(parseToolResult(createShowResult(input)));
  presentation.capture.mockImplementation(() => {
    present({});
    return capture();
  });
  present({});
}
function deferred() {
  let resolve!: (result: { isError?: boolean }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ isError?: boolean }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function reconnect(context: Record<string, unknown>) {
  await bridge.onteardown!();
  vi.resetModules();
  bridge.getHostContext.mockReturnValue(context);
  await import('./main.js');
  await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalled());
  await Promise.resolve();
}

describe('card frame', () => {
  it('uses the host locale for its own text', async () => {
    await reconnect({ locale: 'zh-CN' });
    expect(text('title')).toBe('交互视图');
    expect(frame().title).toBe('生成的交互内容');
    ready();
    expect(text('stop')).toBe('停止');
    expect(text('continue-analysis')).toBe('用当前参数继续分析');
    expect(text('status')).toBe('已应用最新更新');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('switches language when the host context changes', async () => {
    ready();
    expect(text('stop')).toBe('Stop');
    bridge.getHostContext.mockReturnValue({ locale: 'zh-CN' });
    bridge.events.get('hostcontextchanged')!();
    expect(text('stop')).toBe('停止');
    expect(text('status')).toBe('已应用最新更新');
  });

  it('localizes the frame’s own failures but not the document’s', async () => {
    await reconnect({ locale: 'zh-CN' });
    ready();
    present({
      phase: 'error',
      viewAvailable: false,
      error: 'The view exceeded its execution time limit.',
    });
    expect(text('status')).toBe('视图超出了执行时间限制。');
    await reconnect({ locale: 'zh-CN' });
    ready();
    present({
      phase: 'error',
      viewAvailable: false,
      error: "Script error: ReferenceError: 'total' is not defined",
    });
    expect(text('status')).toBe(
      "Script error: ReferenceError: 'total' is not defined",
    );
  });

  it('says how to start again when stopped before the view appeared', () => {
    present({ phase: 'stopped', viewAvailable: false });
    expect(document.getElementById('stopped')!.hidden).toBe(true);
    expect(document.getElementById('notice')!.hidden).toBe(false);
    expect(text('notice')).toBe(
      'Reopen the view to start again from its initial values.',
    );
  });

  it('overlays a stopped view instead of leaving its controls looking live', () => {
    ready();
    present({ phase: 'stopped', viewAvailable: true });
    expect(document.getElementById('stopped')!.hidden).toBe(false);
    expect(text('stopped-title')).toBe('This view is stopped.');
  });

  it('toggles the collapsed summary', () => {
    ready();
    const toggle = document.getElementById(
      'summary-toggle',
    ) as HTMLButtonElement;
    const summary = document.getElementById('summary')!;
    expect(summary.dataset['collapsed']).toBe('true');
    toggle.click();
    expect(summary.dataset['collapsed']).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Show less');
    // Widened while expanded: the collapsed summary now fits.
    Object.defineProperty(summary, 'scrollHeight', { value: 39 });
    Object.defineProperty(summary, 'clientHeight', { value: 39 });
    toggle.click();
    expect(summary.dataset['collapsed']).toBe('true');
    expect(toggle.hidden).toBe(true);
  });
});

describe('review outcomes reported by the host', () => {
  it.each([
    ['cancelled', 'Not sent.'],
    ['expired', 'The review timed out. Nothing was sent.'],
    ['failed', 'Not sent.'],
  ])(
    'returns to the original action after a %s review',
    async (outcome, message) => {
      bridge.sendMessage.mockResolvedValue({
        isError: true,
        _meta: { 'qwen-code/message-review': outcome },
      });
      ready();
      continuation().click();
      await vi.waitFor(() => expect(text('continuation-status')).toBe(message));
      expect(text('continue-analysis')).toBe(
        'Continue analysis with current parameters',
      );
      expect(continuation().disabled).toBe(false);
    },
  );

  it('keeps an earlier attempt’s warning when a retry is not sent', async () => {
    bridge.sendMessage.mockResolvedValueOnce({ isError: true });
    ready();
    continuation().click();
    await vi.waitFor(() =>
      expect(text('continue-analysis')).toBe(
        'Review again after checking the session',
      ),
    );
    bridge.sendMessage.mockResolvedValueOnce({
      isError: true,
      _meta: { 'qwen-code/message-review': 'cancelled' },
    });
    continuation().click();
    await vi.waitFor(() =>
      expect(text('continuation-status')).toContain(
        'An earlier request may still be in flight',
      ),
    );
    expect(text('continue-analysis')).toBe(
      'Review again after checking the session',
    );
  });

  it('keeps the unconfirmed warning for outcomes after dispatch', async () => {
    bridge.sendMessage.mockResolvedValue({
      isError: true,
      _meta: { 'qwen-code/message-review': 'unknown' },
    });
    ready();
    continuation().click();
    await vi.waitFor(() =>
      expect(text('continuation-status')).toContain('could not be confirmed'),
    );
    expect(text('continue-analysis')).toBe(
      'Review again after checking the session',
    );
  });
});

describe('ask the session to fix a failed view', () => {
  const error =
    "Script error: ReferenceError: 'total' is not defined (line 3, column 7).";

  it('offers the error for review and sends it only on explicit activation', async () => {
    const pending = deferred();
    bridge.sendMessage.mockReturnValue(pending.promise);
    ready();
    present({ phase: 'error', viewAvailable: false, error });
    expect(continuation().disabled).toBe(false);
    expect(continuation().textContent).toBe(
      'Ask the assistant to fix this view',
    );
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    continuation().click();
    continuation().click();
    expect(presentation.capture).not.toHaveBeenCalled();
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = bridge.sendMessage.mock.calls[0];
    expect(message.content[0].text).toContain('"Verified capacity"');
    expect(message.content[0].text).toContain(error);
    expect(message.content[0].text).toContain('generated_ui_show');
    expect(continuation().disabled).toBe(true);
    pending.resolve({});
    await vi.waitFor(() =>
      expect(text('continuation-status')).toContain('session accepted'),
    );
    expect(continuation().disabled).toBe(true);
  });

  it('lets the user review again after an unconfirmed request', async () => {
    bridge.sendMessage.mockResolvedValue({ isError: true });
    ready();
    present({ phase: 'error', viewAvailable: false, error });
    continuation().click();
    await vi.waitFor(() =>
      expect(continuation().textContent).toBe(
        'Review again after checking the session',
      ),
    );
    expect(continuation().disabled).toBe(false);
  });

  it.each([
    'The interactive host is unavailable. Use the summary.',
    'This browser cannot run the view. Use the summary.',
  ])('does not offer host failures: %s', (hostError) => {
    ready();
    present({ phase: 'error', viewAvailable: false, error: hostError });
    expect(continuation().disabled).toBe(true);
    continuation().click();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it('does not offer a fix without message review', async () => {
    await bridge.onteardown!();
    vi.resetModules();
    bridge.getHostVersion.mockReturnValue({ name: 'other' });
    await import('./main.js');
    ready();
    present({ phase: 'error', viewAvailable: false, error });
    expect(continuation().disabled).toBe(true);
  });
});

describe('continue analysis from the trusted App', () => {
  it('captures only on explicit activation, freezes text and locks repeated activation', async () => {
    const pending = deferred();
    bridge.sendMessage.mockReturnValue(pending.promise);
    ready();
    present({});
    expect(presentation.capture).not.toHaveBeenCalled();
    continuation().click();
    continuation().click();
    continuation().dispatchEvent(new MouseEvent('click'));
    expect(presentation.capture).toHaveBeenCalledTimes(1);
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = bridge.sendMessage.mock.calls[0];
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(1);
    expect(message.content[0].type).toBe('text');
    expect(message.content[0].text).toContain('"value": "8"');
    expect(message.content[0].text).toContain('"title": "Verified capacity"');
    expect(message.content[0].text).not.toContain(input.summary);
    expect(options.timeout).toBe(210_000);
    expect(options.signal.aborted).toBe(false);
    const frozen = message.content[0].text;
    presentation.capture.mockReturnValue(capture('12'));
    present({ phase: 'dirty', rejectedEvents: 3 });
    present({});
    expect(continuation().disabled).toBe(true);
    expect(message.content[0].text).toBe(frozen);
    pending.resolve({});
    await vi.waitFor(() =>
      expect(text('continuation-status')).toContain('session accepted'),
    );
    expect(text('continuation-status')).toContain('may still be running');
    expect(continuation().disabled).toBe(false);
    continuation().click();
    expect(bridge.sendMessage).toHaveBeenCalledTimes(2);
    expect(bridge.sendMessage.mock.calls[1][0].content[0].text).toContain(
      '"value": "12"',
    );
  });

  it.each([
    'waiting',
    'starting',
    'running',
    'dirty',
    'stopped',
    'error',
  ] as const)('does not capture or send in %s', (phase) => {
    present({ phase });
    continuation().click();
    expect(continuation().disabled).toBe(true);
    expect(presentation.capture).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['dirty', 'busy', 'not-ready'] as const)(
    'rechecks %s when a ready button is stale',
    (reason) => {
      ready();
      presentation.capture.mockReturnValue({ ok: false, reason });
      continuation().click();
      expect(bridge.sendMessage).not.toHaveBeenCalled();
      expect(text('continuation-status')).toContain('Parameters are not ready');
    },
  );

  it('rejects an oversized complete message before RPC', () => {
    ready();
    const large = {
      ...capture(),
      snapshot: {
        ...capture().snapshot,
        inputs: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [
            `value${i}`,
            { value: 'a'.repeat(1950), checked: false },
          ]),
        ),
      },
    };
    presentation.capture.mockReturnValue(large);
    continuation().click();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(text('continuation-status')).toContain('exceeds 16 KiB');
    expect(continuation().disabled).toBe(false);
  });

  it.each(['result', 'rejection'] as const)(
    'requires an explicit fresh review after an unconfirmed %s',
    async (kind) => {
      ready();
      if (kind === 'result')
        bridge.sendMessage.mockResolvedValue({ isError: true });
      else bridge.sendMessage.mockRejectedValue(new Error('connection lost'));
      continuation().click();
      await vi.waitFor(() =>
        expect(text('continuation-status')).toContain(
          'Acceptance could not be confirmed',
        ),
      );
      expect(text('continuation-status')).toContain('could duplicate');
      expect(text('continuation-status')).toContain('may still be in flight');
      expect(text('continue-analysis')).toContain('checking the session');
      present({});
      expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
      presentation.capture.mockReturnValue(capture('new'));
      continuation().click();
      expect(bridge.sendMessage).toHaveBeenCalledTimes(2);
      expect(bridge.sendMessage.mock.calls[1][0].content[0].text).toContain(
        '"value": "new"',
      );
    },
  );

  it.each(['stop', 'error', 'toolcancelled', 'pagehide', 'teardown'])(
    'aborts waiting and ignores late success after %s',
    async (reason) => {
      const pending = deferred();
      bridge.sendMessage.mockReturnValue(pending.promise);
      ready();
      continuation().click();
      const signal = bridge.sendMessage.mock.calls[0][1].signal;
      if (reason === 'stop') stop().click();
      else if (reason === 'error') present({ phase: 'error' });
      else if (reason === 'toolcancelled')
        bridge.events.get('toolcancelled')!();
      else if (reason === 'pagehide')
        globalThis.dispatchEvent(new Event('pagehide'));
      else await bridge.onteardown!();
      expect(signal.aborted).toBe(true);
      expect(text('continuation-status')).toContain('does not withdraw');
      const terminalText = text('continuation-status');
      pending.resolve({});
      await pending.promise;
      expect(text('continuation-status')).toBe(terminalText);
      expect(continuation().disabled).toBe(true);
      expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('handles a terminal status published synchronously during capture', () => {
    ready();
    presentation.capture.mockImplementation(() => {
      present({ phase: 'error' });
      return { ok: false, reason: 'error' };
    });
    continuation().click();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(continuation().disabled).toBe(true);
    expect(
      document.getElementById('continuation-status')!.dataset['state'],
    ).toBe('terminal');
    expect(text('continuation-status')).not.toContain('already sent');
  });

  it('preserves accepted semantics when the card subsequently stops', async () => {
    ready();
    continuation().click();
    await vi.waitFor(() =>
      expect(text('continuation-status')).toContain('session accepted'),
    );
    stop().click();
    expect(text('continuation-status')).toContain('session accepted');
    expect(continuation().disabled).toBe(true);
  });

  it.each(['connecting', 'other-host', 'no-text'])(
    'keeps local interaction available but does not send with %s',
    async (mode) => {
      await bridge.onteardown!();
      vi.resetModules();
      if (mode === 'connecting')
        bridge.connect.mockReturnValue(new Promise(() => {}));
      if (mode === 'other-host')
        bridge.getHostVersion.mockReturnValue({ name: 'other' });
      if (mode === 'no-text')
        bridge.getHostCapabilities.mockReturnValue({ message: {} });
      await import('./main.js');
      ready();
      expect(frame().hidden).toBe(false);
      expect(stop().disabled).toBe(false);
      continuation().click();
      expect(bridge.sendMessage).not.toHaveBeenCalled();
      expect(continuation().disabled).toBe(true);
    },
  );

  it('does not announce unchanged continuation status on every view update', () => {
    bridge.sendMessage.mockReturnValue(deferred().promise);
    ready();
    continuation().click();
    const observer = new MutationObserver(() => {});
    observer.observe(document.getElementById('continuation-status')!, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    present({});
    present({ phase: 'dirty' });
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });
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
    // The one-line status keeps its full text available as the title.
    expect(document.getElementById('status')!.title).toBe(text('status'));
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
          ? 'Stopped'
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
