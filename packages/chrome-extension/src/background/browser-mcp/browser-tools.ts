/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebuggerSession } from './debugger-session.js';
import type {
  BrowserToolDefinition,
  BrowserToolHandler,
  BrowserToolResult,
} from './server.js';

const MAX_EVENTS = 300;
const MAX_BODY_CHARS = 1_048_576;
const MAX_STORED_TEXT_CHARS = 65_536;
const MAX_CONSOLE_TEXT_CHARS = 16_384;
const MAX_URL_CHARS = 4_096;
const MAX_HEADER_COUNT = 50;
const MAX_HEADER_VALUE_CHARS = 1_024;
const MAX_STACK_FRAMES = 50;
const MAX_SCREENSHOT_BASE64_CHARS = 8 * 1_048_576;
const MAX_TEXT_RESULT_CHARS = 1_048_576;
const TRUNCATED_MARKER = '... [truncated]';
const EVALUATION_TIMEOUT_MS = 20_000;
const PAGE_FETCH_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 20_000;
const MAX_FORM_FIELDS = 50;
const SECRET = /authorization|cookie|token|secret|password|api[-_]?key/i;
const AUTHORIZATION_VALUE =
  /(authorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^&,;\s]+)/gi;
const SECRET_VALUE =
  /((?:cookie|token|secret|password|api[-_]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^&,;\s]+)/gi;

interface ConsoleEntry {
  id: number;
  type: string;
  text: string;
  timestamp?: number;
  url?: string;
  line?: number;
  column?: number;
  stack?: unknown;
}

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  requestHeaders?: Record<string, unknown>;
  postData?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, unknown>;
  mimeType?: string;
  encodedDataLength?: number;
  failed?: string;
  redirectFrom?: string;
  redirectTo?: string;
  timestamp?: number;
  finished?: boolean;
  postDataTruncated?: boolean;
}

interface AxValue {
  value?: unknown;
}

interface AxNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  optional = false,
): string | undefined {
  const value = args[name];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || (!optional && value.length === 0)) {
    throw new Error(`'${name}' must be a non-empty string`);
  }
  return value;
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`'${name}' must be a finite number`);
  }
  return value;
}

function booleanArg(
  args: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`'${name}' must be boolean`);
  return value;
}

function text(text: string): BrowserToolResult {
  return {
    content: [
      { type: 'text', text: truncateText(text, MAX_TEXT_RESULT_CHARS) },
    ],
  };
}

function sanitizeText(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(sanitizeValue(parsed));
    }
  } catch {
    // Non-JSON text is handled by the URL and assignment redactors below.
  }
  let value = input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username) url.username = '[REDACTED]';
      if (url.password) url.password = '[REDACTED]';
      for (const name of url.searchParams.keys()) {
        if (SECRET.test(name)) url.searchParams.set(name, '[REDACTED]');
      }
      if (url.hash.length > 1) {
        const fragment = new URLSearchParams(url.hash.slice(1));
        let redacted = false;
        for (const name of fragment.keys()) {
          if (SECRET.test(name)) {
            fragment.set(name, '[REDACTED]');
            redacted = true;
          }
        }
        if (redacted) url.hash = fragment.toString();
      }
      value = url.toString();
    } catch {
      // Keep malformed URLs available for the assignment redactors.
    }
  }
  return value
    .replace(AUTHORIZATION_VALUE, '$1[REDACTED]')
    .replace(SECRET_VALUE, '$1[REDACTED]');
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SECRET.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((child) => sanitizeValue(child));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [
      name,
      sanitizeValue(child, name),
    ]),
  );
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`;
}

function compactStack(value: unknown): unknown {
  const stack = object(value);
  const frames = Array.isArray(stack['callFrames'])
    ? stack['callFrames'].slice(0, MAX_STACK_FRAMES).map((frame) => {
        const source = object(frame);
        return {
          functionName: truncateText(String(source['functionName'] ?? ''), 512),
          url: sanitizeText(
            truncateText(String(source['url'] ?? ''), MAX_URL_CHARS),
          ),
          lineNumber: Number(source['lineNumber']) || 0,
          columnNumber: Number(source['columnNumber']) || 0,
        };
      })
    : [];
  return frames.length > 0 ? { callFrames: frames } : undefined;
}

function json(value: unknown): BrowserToolResult {
  return text(
    value === undefined
      ? 'undefined'
      : JSON.stringify(sanitizeValue(value), null, 2),
  );
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): BrowserToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: required.length ? required : undefined,
      additionalProperties: false,
    },
  };
}

const stringProperty = (description: string) => ({
  type: 'string',
  description,
});

export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  tool('take_snapshot', 'Read the current page accessibility tree.'),
  tool('take_screenshot', 'Capture the visible page as a PNG image.'),
  tool(
    'navigate_page',
    'Navigate the active tab to a URL.',
    { url: stringProperty('Destination URL.') },
    ['url'],
  ),
  tool('reload_page', 'Reload the active page.'),
  tool('go_back', 'Navigate to the previous history entry.'),
  tool('go_forward', 'Navigate to the next history entry.'),
  tool(
    'click',
    'Click an element returned by take_snapshot.',
    { ref: stringProperty('Element ref, for example e12.') },
    ['ref'],
  ),
  tool(
    'fill',
    'Set the value of an input, textarea, or select element.',
    {
      ref: stringProperty('Element ref.'),
      value: stringProperty('Value to enter or select.'),
    },
    ['ref', 'value'],
  ),
  tool(
    'fill_form',
    'Fill several controls returned by take_snapshot.',
    {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: stringProperty('Element ref.'),
            value: stringProperty('Value to enter or select.'),
          },
          required: ['ref', 'value'],
          additionalProperties: false,
        },
      },
    },
    ['fields'],
  ),
  tool(
    'press_key',
    'Press a keyboard key in the active page.',
    {
      key: stringProperty(
        'Special key such as Enter, Escape, or Tab, or one printable character.',
      ),
    },
    ['key'],
  ),
  tool('scroll_page', 'Scroll the page by a number of CSS pixels.', {
    x: { type: 'number', description: 'Horizontal delta. Defaults to 0.' },
    y: { type: 'number', description: 'Vertical delta. Defaults to 600.' },
  }),
  tool(
    'wait_for',
    'Wait until text appears in the page.',
    {
      text: stringProperty('Text to wait for.'),
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds. Defaults to 5000.',
      },
    },
    ['text'],
  ),
  tool(
    'evaluate_script',
    'Evaluate JavaScript in the active page and return its value.',
    { expression: stringProperty('JavaScript expression.') },
    ['expression'],
  ),
  tool(
    'list_console_messages',
    'List captured console messages and exceptions.',
    {
      limit: {
        type: 'number',
        description: 'Maximum recent messages to return. Defaults to 50.',
      },
    },
  ),
  tool(
    'get_console_message',
    'Get a captured console message by id.',
    { id: { type: 'number', description: 'Console message id.' } },
    ['id'],
  ),
  tool('clear_console_messages', 'Clear captured console messages.'),
  tool('list_network_requests', 'List captured page network requests.'),
  tool(
    'get_network_request',
    'Get request and response details. Response bodies are omitted unless explicitly requested.',
    {
      requestId: stringProperty('CDP network request id.'),
      includeResponseBody: {
        type: 'boolean',
        description:
          'Include the response body. It may contain sensitive application data.',
      },
    },
    ['requestId'],
  ),
  tool('clear_network_requests', 'Clear captured network requests.'),
  tool(
    'send_request',
    'Send a fetch request in the current page context.',
    {
      url: stringProperty('Request URL.'),
      method: stringProperty('HTTP method. Defaults to GET.'),
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: stringProperty('Optional request body.'),
    },
    ['url'],
  ),
];

export class BrowserTools implements BrowserToolHandler {
  readonly tools = BROWSER_TOOLS;
  private readonly elements = new Map<string, number>();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries = new Map<string, NetworkEntry>();
  private consoleId = 0;
  private readyTabId: number | null = null;
  private navigationGeneration = 0;

  constructor(private readonly session: DebuggerSession) {
    this.session.onEvent((method, params) => this.handleEvent(method, params));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    try {
      return await this.session.withAttached(async () => {
        await this.ensureReady();
        switch (name) {
          case 'take_snapshot':
            return await this.snapshot();
          case 'take_screenshot':
            return await this.screenshot();
          case 'navigate_page':
            return await this.navigate(stringArg(args, 'url')!);
          case 'reload_page':
            return await this.reload();
          case 'go_back':
            return await this.history(-1);
          case 'go_forward':
            return await this.history(1);
          case 'click':
            return await this.click(stringArg(args, 'ref')!);
          case 'fill':
            return await this.fill(
              stringArg(args, 'ref')!,
              stringArg(args, 'value')!,
            );
          case 'fill_form':
            return await this.fillForm(args['fields']);
          case 'press_key':
            return await this.pressKey(stringArg(args, 'key')!);
          case 'scroll_page':
            return await this.scroll(
              numberArg(args, 'x', 0),
              numberArg(args, 'y', 600),
            );
          case 'wait_for':
            return await this.waitFor(
              stringArg(args, 'text')!,
              numberArg(args, 'timeoutMs', 5_000),
            );
          case 'evaluate_script':
            return await this.evaluate(stringArg(args, 'expression')!);
          case 'list_console_messages':
            return json(this.listConsole(numberArg(args, 'limit', 50)));
          case 'get_console_message':
            return this.getConsole(numberArg(args, 'id', -1));
          case 'clear_console_messages':
            this.consoleEntries.length = 0;
            return text('Console messages cleared.');
          case 'list_network_requests':
            return json(this.listNetwork());
          case 'get_network_request':
            return await this.getNetwork(
              stringArg(args, 'requestId')!,
              booleanArg(args, 'includeResponseBody', false),
            );
          case 'clear_network_requests':
            this.networkEntries.clear();
            return text('Network requests cleared.');
          case 'send_request':
            return await this.sendRequest(args);
          default:
            return { ...text(`Unknown browser tool: ${name}`), isError: true };
        }
      });
    } catch (error) {
      return {
        ...text(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  }

  async shutdown(): Promise<void> {
    this.readyTabId = null;
    this.elements.clear();
    this.consoleEntries.length = 0;
    this.networkEntries.clear();
    await this.session.detach();
  }

  private async ensureReady(): Promise<void> {
    const { tabId, changed } = await this.session.ensureAttached();
    if (!changed && this.readyTabId === tabId) return;
    this.elements.clear();
    this.consoleEntries.length = 0;
    this.networkEntries.clear();
    await Promise.all([
      this.session.send('Page.enable'),
      this.session.send('DOM.enable'),
      this.session.send('Accessibility.enable'),
      this.session.send('Runtime.enable'),
      this.session.send('Log.enable'),
      this.session.send('Network.enable', {
        maxTotalBufferSize: MAX_BODY_CHARS * 4,
        maxResourceBufferSize: MAX_BODY_CHARS,
      }),
    ]);
    this.readyTabId = tabId;
  }

  private async snapshot(): Promise<BrowserToolResult> {
    const [tree, tab] = await Promise.all([
      this.session.send('Accessibility.getFullAXTree'),
      this.session.getTab(),
    ]);
    this.elements.clear();
    const lines = [
      `Page: ${truncateText(tab.title ?? '', 512)}`,
      `URL: ${sanitizeText(truncateText(tab.url ?? '', MAX_URL_CHARS))}`,
    ];
    const nodes = Array.isArray(tree['nodes'])
      ? (tree['nodes'] as AxNode[])
      : [];
    for (const node of nodes.slice(0, 500)) {
      if (node.ignored) continue;
      const role = truncateText(String(node.role?.value ?? '').trim(), 512);
      const name = truncateText(
        String(node.name?.value ?? '').trim(),
        MAX_STORED_TEXT_CHARS,
      );
      const value = truncateText(
        String(node.value?.value ?? '').trim(),
        MAX_STORED_TEXT_CHARS,
      );
      if (!role || (!name && !value && role !== 'RootWebArea')) continue;
      let ref = '';
      if (typeof node.backendDOMNodeId === 'number') {
        ref = `e${this.elements.size + 1}`;
        this.elements.set(ref, node.backendDOMNodeId);
      }
      const details = [
        name && JSON.stringify(name),
        value && `value=${JSON.stringify(value)}`,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `${ref ? `[ref=${ref}] ` : ''}${role}${details ? ` ${details}` : ''}`,
      );
    }
    return text(lines.join('\n'));
  }

  private async screenshot(): Promise<BrowserToolResult> {
    const result = await this.session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    if (typeof result['data'] !== 'string')
      throw new Error('Screenshot failed');
    if (result['data'].length > MAX_SCREENSHOT_BASE64_CHARS) {
      throw new Error(
        'Screenshot is too large to send. Reduce the page zoom or viewport and try again.',
      );
    }
    return {
      content: [{ type: 'image', data: result['data'], mimeType: 'image/png' }],
    };
  }

  private async navigate(url: string): Promise<BrowserToolResult> {
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url)
      ? url
      : `https://${url}`;
    const protocol = new URL(normalized).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('Navigation only supports http: and https: URLs');
    }
    const generation = this.navigationGeneration;
    const result = await this.session.send('Page.navigate', {
      url: normalized,
    });
    if (typeof result['errorText'] === 'string' && result['errorText']) {
      throw new Error(`Navigation failed: ${result['errorText']}`);
    }
    this.elements.clear();
    await this.waitForDocumentReady(generation);
    return json({ url: normalized, ...result });
  }

  private async reload(): Promise<BrowserToolResult> {
    const generation = this.navigationGeneration;
    await this.session.send('Page.reload');
    this.elements.clear();
    await this.waitForDocumentReady(generation);
    return text('Page reloaded.');
  }

  private async history(offset: number): Promise<BrowserToolResult> {
    const result = await this.session.send('Page.getNavigationHistory');
    const entries = Array.isArray(result['entries']) ? result['entries'] : [];
    const current = Number(result['currentIndex']);
    const entry = object(entries[current + offset]);
    if (typeof entry['id'] !== 'number')
      throw new Error('No history entry available');
    const url = typeof entry['url'] === 'string' ? entry['url'] : '';
    if (!/^https?:/i.test(url) && url !== 'about:blank') {
      throw new Error(`Chrome does not allow debugging this page: ${url}`);
    }
    const generation = this.navigationGeneration;
    await this.session.send('Page.navigateToHistoryEntry', {
      entryId: entry['id'],
    });
    this.elements.clear();
    await this.waitForDocumentReady(generation);
    return text(offset < 0 ? 'Navigated back.' : 'Navigated forward.');
  }

  private async waitForDocumentReady(generation: number): Promise<void> {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      if (this.navigationGeneration !== generation) {
        const result = await this.session.send('Runtime.evaluate', {
          expression:
            "document.readyState === 'interactive' || document.readyState === 'complete'",
          returnByValue: true,
        });
        if (object(result['result'])['value'] === true) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for page navigation');
  }

  private backendNode(ref: string): number {
    const id = this.elements.get(ref);
    if (id === undefined) {
      throw new Error(
        `Unknown or stale element ref '${ref}'. Run take_snapshot again.`,
      );
    }
    return id;
  }

  private async click(ref: string): Promise<BrowserToolResult> {
    const backendNodeId = this.backendNode(ref);
    await this.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const result = await this.session.send('DOM.getBoxModel', {
      backendNodeId,
    });
    const model = object(result['model']);
    const quad = Array.isArray(model['content'])
      ? (model['content'] as number[])
      : [];
    if (quad.length < 8)
      throw new Error(`Element '${ref}' has no clickable box`);
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    return text(`Clicked ${ref}.`);
  }

  private async fill(ref: string, value: string): Promise<BrowserToolResult> {
    const backendNodeId = this.backendNode(ref);
    const resolved = await this.session.send('DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = object(resolved['object'])['objectId'];
    if (typeof objectId !== 'string') throw new Error(`Cannot resolve ${ref}`);
    try {
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(value) {
          this.focus();
          if (this instanceof HTMLSelectElement) {
            this.value = value;
          } else if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
            const proto = this instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(this, value); else this.value = value;
          } else if (this.isContentEditable) {
            this.textContent = value;
          } else {
            throw new TypeError('Element is not fillable');
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
        returnByValue: true,
      });
      if (result['exceptionDetails']) {
        throw new Error(this.exceptionText(result['exceptionDetails']));
      }
    } finally {
      await this.session
        .send('Runtime.releaseObject', { objectId })
        .catch(() => undefined);
    }
    return text(`Filled ${ref}.`);
  }

  private async fillForm(rawFields: unknown): Promise<BrowserToolResult> {
    if (!Array.isArray(rawFields)) throw new Error("'fields' must be an array");
    if (rawFields.length > MAX_FORM_FIELDS) {
      throw new Error(
        `'fields' cannot contain more than ${MAX_FORM_FIELDS} entries`,
      );
    }
    for (const raw of rawFields) {
      const field = object(raw);
      await this.fill(stringArg(field, 'ref')!, stringArg(field, 'value')!);
    }
    return text(`Filled ${rawFields.length} field(s).`);
  }

  private async pressKey(key: string): Promise<BrowserToolResult> {
    const keys: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: 'Enter', keyCode: 13 },
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 },
      Backspace: { code: 'Backspace', keyCode: 8 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    };
    const mapped = keys[key];
    if (!mapped) {
      if ([...key].length !== 1) {
        throw new Error(`Unsupported key: ${key}`);
      }
      await this.session.send('Input.insertText', { text: key });
      return text(`Pressed ${key}.`);
    }
    const params = {
      key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
    };
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...params,
    });
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...params,
    });
    return text(`Pressed ${key}.`);
  }

  private async scroll(x: number, y: number): Promise<BrowserToolResult> {
    await this.session.send('Runtime.evaluate', {
      expression: `window.scrollBy(${JSON.stringify(x)}, ${JSON.stringify(y)})`,
    });
    return text(`Scrolled by (${x}, ${y}).`);
  }

  private async waitFor(
    value: string,
    timeoutMs: number,
  ): Promise<BrowserToolResult> {
    const deadline =
      Date.now() + Math.max(0, Math.min(timeoutMs, WAIT_TIMEOUT_MS));
    while (Date.now() <= deadline) {
      const result = await this.session.send('Runtime.evaluate', {
        expression: `document.body?.innerText.includes(${JSON.stringify(value)}) ?? false`,
        returnByValue: true,
      });
      if (object(result['result'])['value'] === true)
        return text(`Found text: ${value}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for text: ${value}`);
  }

  private async evaluate(expression: string): Promise<BrowserToolResult> {
    const maxChars = MAX_TEXT_RESULT_CHARS - TRUNCATED_MARKER.length;
    const result = await this.session.send('Runtime.evaluate', {
      expression: `(async () => {
        const value = await (0, eval)(${JSON.stringify(expression)});
        let serialized;
        try {
          serialized = JSON.stringify(value);
        } catch {
          serialized = String(value);
        }
        if (serialized === undefined) serialized = 'undefined';
        return {
          text: serialized.slice(0, ${maxChars}),
          truncated: serialized.length > ${maxChars},
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: EVALUATION_TIMEOUT_MS,
    });
    const exception = result['exceptionDetails'];
    if (exception) throw new Error(this.exceptionText(exception));
    const remote = object(result['result']);
    const value = object(remote['value']);
    if (typeof value['text'] !== 'string') {
      return json('value' in remote ? remote['value'] : remote['description']);
    }
    return text(
      `${sanitizeText(value['text'])}${value['truncated'] === true ? TRUNCATED_MARKER : ''}`,
    );
  }

  private getConsole(id: number): BrowserToolResult {
    const entry = this.consoleEntries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Console message ${id} not found`);
    return json(entry);
  }

  private listConsole(limit: number): Array<Omit<ConsoleEntry, 'stack'>> {
    const count = Math.max(1, Math.min(MAX_EVENTS, Math.floor(limit)));
    return this.consoleEntries
      .slice(-count)
      .map(({ stack: _stack, ...entry }) => entry);
  }

  private listNetwork(): unknown[] {
    return [...this.networkEntries.values()].map((entry) => ({
      requestId: entry.requestId,
      method: entry.method,
      url: entry.url,
      type: entry.type,
      status: entry.status,
      mimeType: entry.mimeType,
      failed: entry.failed,
    }));
  }

  private async getNetwork(
    requestId: string,
    includeResponseBody: boolean,
  ): Promise<BrowserToolResult> {
    const entry = this.networkEntries.get(requestId);
    if (!entry) throw new Error(`Network request '${requestId}' not found`);
    const detail: NetworkEntry & {
      responseBody?: string;
      base64Encoded?: boolean;
      bodyTruncated?: boolean;
    } = { ...entry };
    if (
      includeResponseBody &&
      entry.finished &&
      !entry.failed &&
      !entry.redirectTo
    ) {
      try {
        const body = await this.session.send('Network.getResponseBody', {
          requestId,
        });
        const raw = typeof body['body'] === 'string' ? body['body'] : '';
        detail.responseBody =
          body['base64Encoded'] === true
            ? '[BINARY BODY OMITTED]'
            : this.redactBody(raw).slice(0, MAX_BODY_CHARS);
        detail.bodyTruncated = raw.length > MAX_BODY_CHARS;
        detail.base64Encoded = body['base64Encoded'] === true;
      } catch {
        // Some cached, streaming, or evicted responses have no retrievable body.
      }
    }
    return json(detail);
  }

  private async sendRequest(
    args: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const url = stringArg(args, 'url')!;
    const method = stringArg(args, 'method', true) ?? 'GET';
    const headers = object(args['headers']);
    const body = stringArg(args, 'body', true);
    const init = { method, headers, ...(body === undefined ? {} : { body }) };
    const expression = `(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${PAGE_FETCH_TIMEOUT_MS});
      try {
        const response = await fetch(${JSON.stringify(url)}, { ...${JSON.stringify(init)}, signal: controller.signal });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let bodyTruncated = false;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const remaining = ${MAX_BODY_CHARS} - text.length;
            if (chunk.length > remaining) {
              text += chunk.slice(0, Math.max(0, remaining));
              bodyTruncated = true;
              await reader.cancel();
              break;
            }
            text += chunk;
          }
          if (!bodyTruncated) text += decoder.decode();
        }
        return { url: response.url, status: response.status, statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()), body: text,
          bodyTruncated };
      } finally {
        clearTimeout(timer);
      }
    })()`;
    return this.evaluate(expression);
  }

  private handleEvent(method: string, params: Record<string, unknown>): void {
    if (
      method === 'Page.frameNavigated' &&
      !object(params['frame'])['parentId']
    ) {
      this.navigationGeneration += 1;
      this.elements.clear();
      return;
    }
    if (method === 'Page.navigatedWithinDocument') {
      this.navigationGeneration += 1;
      this.elements.clear();
      return;
    }
    if (method === 'Qwen.detached') {
      this.readyTabId = null;
      this.elements.clear();
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params['args']) ? params['args'] : [];
      this.pushConsole({
        id: ++this.consoleId,
        type: String(params['type'] ?? 'log'),
        text: args.map((arg) => this.remoteObjectText(object(arg))).join(' '),
        timestamp: Number(params['timestamp']) || undefined,
        stack: compactStack(params['stackTrace']),
      });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = object(params['exceptionDetails']);
      this.pushConsole({
        id: ++this.consoleId,
        type: 'exception',
        text: this.exceptionText(details),
        timestamp: Number(params['timestamp']) || undefined,
        url: typeof details['url'] === 'string' ? details['url'] : undefined,
        line: Number(details['lineNumber']) || undefined,
        column: Number(details['columnNumber']) || undefined,
        stack: compactStack(details['stackTrace']),
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const entry = object(params['entry']);
      this.pushConsole({
        id: ++this.consoleId,
        type: String(entry['level'] ?? entry['source'] ?? 'log'),
        text: String(entry['text'] ?? ''),
        timestamp: Number(entry['timestamp']) || undefined,
        url: typeof entry['url'] === 'string' ? entry['url'] : undefined,
        line: Number(entry['lineNumber']) || undefined,
        stack: compactStack(entry['stackTrace']),
      });
      return;
    }
    this.handleNetworkEvent(method, params);
  }

  private handleNetworkEvent(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const requestId = params['requestId'];
    if (typeof requestId !== 'string') return;
    if (method === 'Network.requestWillBeSent') {
      const request = object(params['request']);
      const redirect = object(params['redirectResponse']);
      const previous = this.networkEntries.get(requestId);
      if (previous && Object.keys(redirect).length > 0) {
        const redirectId = this.nextRedirectId(requestId);
        this.networkEntries.delete(requestId);
        previous.requestId = redirectId;
        previous.status = Number(redirect['status']) || 0;
        previous.statusText = String(redirect['statusText'] ?? '');
        previous.responseHeaders = this.redactHeaders(
          object(redirect['headers']),
        );
        previous.mimeType = String(redirect['mimeType'] ?? '');
        previous.encodedDataLength = Number(redirect['encodedDataLength']) || 0;
        previous.finished = true;
        previous.redirectTo = sanitizeText(
          truncateText(String(request['url'] ?? ''), MAX_URL_CHARS),
        );
        this.networkEntries.set(redirectId, previous);
      }
      const postData =
        typeof request['postData'] === 'string'
          ? request['postData']
          : undefined;
      const rawPostData = postData
        ? this.redactBody(postData.slice(0, MAX_STORED_TEXT_CHARS))
        : undefined;
      this.networkEntries.set(requestId, {
        requestId,
        url: sanitizeText(
          truncateText(String(request['url'] ?? ''), MAX_URL_CHARS),
        ),
        method: String(request['method'] ?? 'GET'),
        type: typeof params['type'] === 'string' ? params['type'] : undefined,
        requestHeaders: this.redactHeaders(object(request['headers'])),
        postData: rawPostData?.slice(0, MAX_STORED_TEXT_CHARS),
        postDataTruncated:
          postData !== undefined && postData.length > MAX_STORED_TEXT_CHARS,
        redirectFrom:
          typeof redirect['url'] === 'string'
            ? sanitizeText(truncateText(redirect['url'], MAX_URL_CHARS))
            : undefined,
        timestamp: Number(params['timestamp']) || undefined,
      });
      this.trimNetwork();
    } else if (method === 'Network.responseReceived') {
      const entry = this.networkEntries.get(requestId);
      if (!entry) return;
      const response = object(params['response']);
      entry.status = Number(response['status']) || 0;
      entry.statusText = String(response['statusText'] ?? '');
      entry.responseHeaders = this.redactHeaders(object(response['headers']));
      entry.mimeType = String(response['mimeType'] ?? '');
      entry.type =
        typeof params['type'] === 'string' ? params['type'] : entry.type;
    } else if (method === 'Network.loadingFinished') {
      const entry = this.networkEntries.get(requestId);
      if (!entry) return;
      entry.finished = true;
      entry.encodedDataLength = Number(params['encodedDataLength']) || 0;
    } else if (method === 'Network.loadingFailed') {
      const entry = this.networkEntries.get(requestId);
      if (!entry) return;
      entry.failed = String(params['errorText'] ?? 'Request failed');
      entry.finished = true;
    }
  }

  private remoteObjectText(value: Record<string, unknown>): string {
    if ('value' in value) {
      try {
        return typeof value['value'] === 'string'
          ? value['value']
          : JSON.stringify(value['value']);
      } catch {
        return String(value['value']);
      }
    }
    return String(value['description'] ?? value['type'] ?? '');
  }

  private exceptionText(value: unknown): string {
    const details = object(value);
    const description = this.remoteObjectText(object(details['exception']));
    return (
      description || String(details['text'] ?? 'JavaScript execution failed')
    );
  }

  private nextRedirectId(requestId: string): string {
    let index = 1;
    while (this.networkEntries.has(`${requestId}:redirect:${index}`)) index++;
    return `${requestId}:redirect:${index}`;
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push({
      ...entry,
      text: sanitizeText(truncateText(entry.text, MAX_CONSOLE_TEXT_CHARS)),
      url: entry.url
        ? sanitizeText(truncateText(entry.url, MAX_URL_CHARS))
        : undefined,
    });
    if (this.consoleEntries.length > MAX_EVENTS) this.consoleEntries.shift();
  }

  private trimNetwork(): void {
    while (this.networkEntries.size > MAX_EVENTS) {
      const first = this.networkEntries.keys().next().value as
        | string
        | undefined;
      if (first === undefined) break;
      this.networkEntries.delete(first);
    }
  }

  private redactHeaders(
    headers: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(headers)
        .slice(0, MAX_HEADER_COUNT)
        .map(([name, value]) => [
          truncateText(name, 256),
          SECRET.test(name)
            ? '[REDACTED]'
            : truncateText(String(value), MAX_HEADER_VALUE_CHARS),
        ]),
    );
  }

  private redactBody(body: string): string {
    return sanitizeText(body);
  }
}
