/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTools } from './browser-tools.js';
import type {
  DebuggerEventListener,
  DebuggerSession,
} from './debugger-session.js';

class FakeSession implements DebuggerSession {
  listener: DebuggerEventListener = () => {};
  changed = true;
  tabId = 1;
  autoNavigate = true;
  readonly send = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              role: { value: 'button' },
              name: { value: 'Submit' },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'input-1' } };
      }
      if (method === 'Network.getResponseBody') {
        return { body: '{"ok":true}', base64Encoded: false };
      }
      if (
        method === 'Runtime.evaluate' &&
        String(params?.['expression']).includes('document.readyState')
      ) {
        return { result: { value: true } };
      }
      if (
        this.autoNavigate &&
        (method === 'Page.navigate' ||
          method === 'Page.reload' ||
          method === 'Page.navigateToHistoryEntry')
      ) {
        queueMicrotask(() =>
          this.emit('Page.frameNavigated', { frame: { id: 'main' } }),
        );
      }
      return {};
    },
  );

  async ensureAttached(): Promise<{ tabId: number; changed: boolean }> {
    const changed = this.changed;
    this.changed = false;
    return { tabId: this.tabId, changed };
  }

  async withAttached<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  onEvent(listener: DebuggerEventListener): () => void {
    this.listener = listener;
    return () => {};
  }

  async getTab(): Promise<chrome.tabs.Tab> {
    return {
      id: this.tabId,
      index: 0,
      pinned: false,
      highlighted: true,
      active: true,
      frozen: false,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      windowId: 1,
      title: 'Fixture',
      url: 'https://example.test',
    };
  }

  async detach(): Promise<void> {}

  emit(method: string, params: Record<string, unknown>): void {
    this.listener(method, params);
  }
}

function resultText(
  result: Awaited<ReturnType<BrowserTools['callTool']>>,
): string {
  const content = result.content[0];
  if (!content || content.type !== 'text')
    throw new Error('Expected text result');
  return content.text;
}

describe('BrowserTools', () => {
  let session: FakeSession;
  let tools: BrowserTools;

  beforeEach(() => {
    session = new FakeSession();
    tools = new BrowserTools(session);
  });

  it('offers the complete first-release debugging catalog', () => {
    expect(tools.tools.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'take_snapshot',
        'take_screenshot',
        'click',
        'fill',
        'evaluate_script',
        'list_console_messages',
        'list_network_requests',
        'get_network_request',
      ]),
    );
  });

  it('creates element refs and clicks the referenced box', async () => {
    const snapshot = await tools.callTool('take_snapshot', {});
    expect(resultText(snapshot)).toContain('[ref=e1] button "Submit"');

    const click = await tools.callTool('click', { ref: 'e1' });
    expect(click.isError).not.toBe(true);
    expect(session.send).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', {
      backendNodeId: 42,
    });
    expect(session.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 10, y: 5 }),
    );
  });

  it('captures screenshots and drives navigation history', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({ data: 'png-data' });
    const screenshot = await tools.callTool('take_screenshot', {});
    expect(screenshot.content).toEqual([
      { type: 'image', data: 'png-data', mimeType: 'image/png' },
    ]);

    await tools.callTool('navigate_page', { url: 'example.test' });
    expect(session.send).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://example.test',
    });
    await tools.callTool('reload_page', {});
    expect(session.send).toHaveBeenCalledWith('Page.reload');

    session.send.mockResolvedValueOnce({
      currentIndex: 1,
      entries: [
        { id: 10, url: 'https://example.test/previous' },
        { id: 11, url: 'https://example.test/current' },
      ],
    });
    await tools.callTool('go_back', {});
    expect(session.send).toHaveBeenCalledWith('Page.navigateToHistoryEntry', {
      entryId: 10,
    });
  });

  it('rejects restricted navigation history entries', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({
      currentIndex: 1,
      entries: [
        { id: 10, url: 'file:///tmp/secret.txt' },
        { id: 11, url: 'https://example.test/current' },
      ],
    });

    const result = await tools.callTool('go_back', {});

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('does not allow debugging');
    expect(session.send).not.toHaveBeenCalledWith(
      'Page.navigateToHistoryEntry',
      expect.anything(),
    );
  });

  it('rejects screenshots that would exceed the WebSocket frame budget', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({
      data: 'a'.repeat(8 * 1_048_576 + 1),
    });

    const screenshot = await tools.callTool('take_screenshot', {});

    expect(screenshot.isError).toBe(true);
    expect(resultText(screenshot)).toContain('Screenshot is too large');
  });

  it('caps evaluated text results to the reverse WebSocket frame budget', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({
      result: {
        value: {
          text: 'a'.repeat(1_048_576 - '... [truncated]'.length),
          truncated: true,
        },
      },
    });

    const result = await tools.callTool('evaluate_script', {
      expression: 'window.largeValue',
    });
    const output = resultText(result);

    expect(output.length).toBeLessThanOrEqual(1_048_576);
    expect(output.endsWith('... [truncated]')).toBe(true);
    expect(session.send).toHaveBeenLastCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('serialized.slice(0,'),
      }),
    );
  });

  it('caps snapshot text and redacts secrets from the page URL', async () => {
    session.send.mockImplementation(async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: Array.from({ length: 500 }, (_, index) => ({
            role: { value: 'text' },
            name: { value: `${index}-${'a'.repeat(65_536)}` },
          })),
        };
      }
      return {};
    });
    const tab = await session.getTab();
    vi.spyOn(session, 'getTab').mockResolvedValue({
      ...tab,
      url: 'https://user:password@example.test/?access_token=secret&name=qwen#access_token=fragment-secret&route=home',
    });

    const output = resultText(await tools.callTool('take_snapshot', {}));

    expect(output.length).toBeLessThanOrEqual(1_048_576);
    expect(output.endsWith('... [truncated]')).toBe(true);
    expect(output).not.toContain('password');
    expect(output).not.toContain('secret');
    expect(output).toContain('name=qwen');
    expect(output).toContain('route=home');
  });

  it('preserves non-secret URL fragments', async () => {
    session.send.mockImplementation(async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return {};
    });
    const tab = await session.getTab();
    vi.spyOn(session, 'getTab').mockResolvedValue({
      ...tab,
      url: 'https://example.test/#/settings',
    });

    const output = resultText(await tools.callTool('take_snapshot', {}));

    expect(output).toContain('https://example.test/#/settings');
  });

  it('fills snapshot controls and rejects stale refs', async () => {
    await tools.callTool('take_snapshot', {});
    const result = await tools.callTool('fill', {
      ref: 'e1',
      value: 'qwen',
    });
    expect(result.isError).not.toBe(true);
    expect(session.send).toHaveBeenCalledWith('Runtime.callFunctionOn', {
      objectId: 'input-1',
      functionDeclaration: expect.stringContaining("new Event('input'"),
      arguments: [{ value: 'qwen' }],
      returnByValue: true,
    });
    expect(session.send).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'input-1',
    });

    const stale = await tools.callTool('fill', {
      ref: 'missing',
      value: 'qwen',
    });
    expect(stale.isError).toBe(true);
    expect(resultText(stale)).toContain('Unknown or stale element ref');
  });

  it('rejects navigation to non-web URL schemes', async () => {
    const result = await tools.callTool('navigate_page', {
      url: 'javascript:document.body.textContent',
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(
      'Navigation only supports http: and https: URLs',
    );
    expect(session.send).not.toHaveBeenCalledWith(
      'Page.navigate',
      expect.anything(),
    );
  });

  it('reports navigation failures returned by Chrome', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({
      errorText: 'net::ERR_NAME_NOT_RESOLVED',
    });

    const result = await tools.callTool('navigate_page', {
      url: 'https://missing.invalid',
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('net::ERR_NAME_NOT_RESOLVED');
  });

  it('limits bulk form operations', async () => {
    const result = await tools.callTool('fill_form', {
      fields: Array.from({ length: 51 }, () => ({ ref: 'e1', value: 'x' })),
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('more than 50 entries');
  });

  it('reports page-side fill failures', async () => {
    await tools.callTool('take_snapshot', {});
    session.send.mockImplementation(async (method: string) => {
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'input-1' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return {
          exceptionDetails: {
            exception: { description: 'TypeError: value setter failed' },
          },
        };
      }
      return {};
    });

    const result = await tools.callTool('fill', {
      ref: 'e1',
      value: 'qwen',
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('TypeError: value setter failed');
    expect(session.send).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'input-1',
    });
  });

  it('waits for the new document before accepting readyState', async () => {
    await tools.callTool('list_console_messages', {});
    session.autoNavigate = false;
    vi.useFakeTimers();
    try {
      let settled = false;
      const navigation = tools
        .callTool('navigate_page', { url: 'https://example.test/next' })
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      session.emit('Page.frameNavigated', { frame: { id: 'main' } });
      await vi.advanceTimersByTimeAsync(200);

      expect((await navigation).isError).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries CDP domain setup after initialization fails', async () => {
    session.send.mockRejectedValueOnce(new Error('Network.enable failed'));

    const failed = await tools.callTool('list_network_requests', {});
    const retried = await tools.callTool('list_network_requests', {});

    expect(failed.isError).toBe(true);
    expect(retried.isError).not.toBe(true);
    expect(session.send).toHaveBeenCalledTimes(12);
  });

  it('drives keyboard, scroll, wait, and page-context fetch commands', async () => {
    await tools.callTool('list_console_messages', {});
    await tools.callTool('press_key', { key: 'Enter' });
    expect(session.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'keyDown',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
      }),
    );

    await tools.callTool('press_key', { key: 'a' });
    expect(session.send).toHaveBeenCalledWith('Input.insertText', {
      text: 'a',
    });

    const unsupportedKey = await tools.callTool('press_key', {
      key: 'NotAKey',
    });
    expect(unsupportedKey.isError).toBe(true);
    expect(resultText(unsupportedKey)).toContain('Unsupported key');

    await tools.callTool('scroll_page', { x: 2, y: 300 });
    expect(session.send).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'window.scrollBy(2, 300)',
    });

    session.send.mockResolvedValueOnce({ result: { value: true } });
    const waited = await tools.callTool('wait_for', {
      text: 'Ready',
      timeoutMs: 10,
    });
    expect(resultText(waited)).toBe('Found text: Ready');

    session.send.mockResolvedValueOnce({
      result: { value: { status: 200, body: 'ok' } },
    });
    const request = await tools.callTool('send_request', {
      url: '/api',
      method: 'POST',
      body: '{}',
    });
    expect(resultText(request)).toContain('"status": 200');
    expect(session.send).toHaveBeenLastCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('fetch(\\"/api\\"'),
        timeout: 20_000,
      }),
    );
    const expression = String(
      session.send.mock.calls.at(-1)?.[1]?.['expression'] ?? '',
    );
    expect(expression).toContain('response.body?.getReader()');
    expect(expression).toContain('await reader.cancel()');
    expect(expression).not.toContain('response.text()');
  });

  it('captures console output', async () => {
    await tools.callTool('list_console_messages', {});
    session.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'boom' }, { value: 42 }],
      timestamp: 10,
    });
    const result = await tools.callTool('list_console_messages', {});
    expect(JSON.parse(resultText(result))).toMatchObject([
      { id: 1, type: 'error', text: 'boom 42' },
    ]);
  });

  it('keeps the useful exception description', async () => {
    await tools.callTool('list_console_messages', {});
    session.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: useful failure\n at app.js:1' },
      },
    });

    const result = await tools.callTool('list_console_messages', {});

    expect(resultText(result)).toContain('TypeError: useful failure');
  });

  it('limits console listings while keeping full entries addressable', async () => {
    await tools.callTool('list_console_messages', {});
    for (let index = 1; index <= 60; index++) {
      session.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: `message-${index}` }],
        stackTrace: { callFrames: [{ functionName: `fn-${index}` }] },
      });
    }

    const listed = JSON.parse(
      resultText(await tools.callTool('list_console_messages', {})),
    );
    expect(listed).toHaveLength(50);
    expect(listed[0]).toMatchObject({ id: 11, text: 'message-11' });
    expect(listed[0]).not.toHaveProperty('stack');

    const full = JSON.parse(
      resultText(await tools.callTool('get_console_message', { id: 1 })),
    );
    expect(full.stack).toBeDefined();
  });

  it('returns valid text when an evaluated expression is undefined', async () => {
    await tools.callTool('list_console_messages', {});
    session.send.mockResolvedValueOnce({ result: { type: 'undefined' } });

    const result = await tools.callTool('evaluate_script', {
      expression: 'console.log("done")',
    });

    expect(resultText(result)).toBe('undefined');
  });

  it('captures and redacts network request and response details', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'request-1',
      type: 'Fetch',
      request: {
        url: 'https://example.test/api',
        method: 'POST',
        headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
        postData: '{"token":"secret","name":"qwen"}',
      },
    });
    session.emit('Network.responseReceived', {
      requestId: 'request-1',
      type: 'Fetch',
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'Set-Cookie': 'session=secret' },
      },
    });
    session.emit('Network.loadingFinished', {
      requestId: 'request-1',
      encodedDataLength: 11,
    });

    const result = await tools.callTool('get_network_request', {
      requestId: 'request-1',
      includeResponseBody: true,
    });
    const request = JSON.parse(resultText(result));
    expect(request.requestHeaders.Authorization).toBe('[REDACTED]');
    expect(request.requestHeaders.Accept).toBe('application/json');
    expect(request.postData).toBe('{"token":"[REDACTED]","name":"qwen"}');
    expect(request.responseHeaders['Set-Cookie']).toBe('[REDACTED]');
    expect(request.responseBody).toBe('{"ok":true}');
  });

  it('redacts secrets from URLs, form bodies, and console text', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'request-3',
      request: {
        url: 'https://example.test/api?access_token=secret&name=qwen',
        method: 'POST',
        postData: 'token=secret&name=qwen',
      },
    });
    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'authorization=secret' }],
    });

    const network = await tools.callTool('get_network_request', {
      requestId: 'request-3',
    });
    const consoleMessages = await tools.callTool('list_console_messages', {});

    expect(resultText(network)).not.toContain('secret');
    expect(resultText(network)).toContain('name=qwen');
    expect(resultText(consoleMessages)).not.toContain('secret');
  });

  it('does not retain response bodies in the event buffer', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'request-2',
      request: { url: 'https://example.test/api', method: 'GET' },
    });
    session.emit('Network.loadingFinished', {
      requestId: 'request-2',
      encodedDataLength: 11,
    });

    await tools.callTool('get_network_request', {
      requestId: 'request-2',
      includeResponseBody: true,
    });
    await tools.callTool('get_network_request', {
      requestId: 'request-2',
      includeResponseBody: true,
    });

    expect(session.send).toHaveBeenCalledTimes(2 + 6);
    expect(session.send).toHaveBeenNthCalledWith(7, 'Network.getResponseBody', {
      requestId: 'request-2',
    });
    expect(session.send).toHaveBeenNthCalledWith(8, 'Network.getResponseBody', {
      requestId: 'request-2',
    });
  });

  it('omits response bodies unless explicitly requested', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'sensitive-request',
      request: { url: 'https://example.test/session', method: 'GET' },
    });
    session.emit('Network.loadingFinished', {
      requestId: 'sensitive-request',
    });

    const result = await tools.callTool('get_network_request', {
      requestId: 'sensitive-request',
    });

    expect(JSON.parse(resultText(result))).not.toHaveProperty('responseBody');
    expect(session.send).not.toHaveBeenCalledWith(
      'Network.getResponseBody',
      expect.anything(),
    );
  });

  it('keeps network metadata when a response body is unavailable', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'cached-request',
      request: { url: 'https://example.test/cached', method: 'GET' },
    });
    session.emit('Network.responseReceived', {
      requestId: 'cached-request',
      response: { status: 304, statusText: 'Not Modified' },
    });
    session.emit('Network.loadingFinished', { requestId: 'cached-request' });
    session.send.mockRejectedValueOnce(new Error('No resource with given id'));

    const result = await tools.callTool('get_network_request', {
      requestId: 'cached-request',
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      requestId: 'cached-request',
      status: 304,
      finished: true,
    });
  });

  it('clears page-scoped state when the active tab changes', async () => {
    await tools.callTool('take_snapshot', {});
    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'old tab' }],
    });
    session.emit('Network.requestWillBeSent', {
      requestId: 'old-request',
      request: { url: 'https://example.test/old', method: 'GET' },
    });

    session.tabId = 2;
    session.changed = true;
    const network = await tools.callTool('list_network_requests', {});
    const consoleMessages = await tools.callTool('list_console_messages', {});
    const staleClick = await tools.callTool('click', { ref: 'e1' });

    expect(JSON.parse(resultText(network))).toEqual([]);
    expect(JSON.parse(resultText(consoleMessages))).toEqual([]);
    expect(staleClick.isError).toBe(true);
    expect(resultText(staleClick)).toContain('Unknown or stale element ref');
  });

  it('keeps each redirect hop addressable', async () => {
    await tools.callTool('list_network_requests', {});
    session.emit('Network.requestWillBeSent', {
      requestId: 'redirect-1',
      request: { url: 'https://example.test/start', method: 'GET' },
    });
    session.emit('Network.requestWillBeSent', {
      requestId: 'redirect-1',
      request: { url: 'https://example.test/final', method: 'GET' },
      redirectResponse: {
        url: 'https://example.test/start',
        status: 302,
        statusText: 'Found',
        headers: { Location: '/final' },
      },
    });

    const listed = JSON.parse(
      resultText(await tools.callTool('list_network_requests', {})),
    );

    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'redirect-1:redirect:1',
          url: 'https://example.test/start',
          status: 302,
        }),
        expect.objectContaining({
          requestId: 'redirect-1',
          url: 'https://example.test/final',
        }),
      ]),
    );
  });
});
