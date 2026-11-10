/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-pipeline harness for the Generated UI acceptance cases: a real
 * `qwen serve` daemon, the Web Shell it serves, the bundled Generated UI
 * provider, and Chromium. Only the model is swapped:
 *
 * - replay: the fake OpenAI server answers with hand-written documents;
 * - live: a recording proxy forwards to a real OpenAI-compatible endpoint.
 *
 * Every model request is recorded so checks can prove that local edits start
 * no turn and that one explicit submission starts exactly one.
 */

import * as fs from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from 'playwright';
import {
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from '../cli/_daemon-harness.js';

export const SHOW_TOOL = 'mcp__generated-ui__generated_ui_show';
const CLASSIFIER_MARKER = 'Pending tool call to classify';

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

export interface RecordedRequest {
  messages: ChatMessage[];
  tools: string[];
  /** A main-agent request: it offers the Generated UI tool. */
  main: boolean;
  /** Serialized text of the newest user message, for content checks. */
  lastUserText: string;
}

/** Replay handler for main-agent requests; side requests are answered here. */
export type ReplayScript = (request: RecordedRequest) => FakeOpenAIResponse;

export interface LiveModel {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ModelMode =
  | { kind: 'replay'; script: ReplayScript }
  | { kind: 'live'; model: LiveModel };

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return '';
}

function record(body: unknown): RecordedRequest {
  const request = (body ?? {}) as {
    messages?: ChatMessage[];
    tools?: Array<{ function?: { name?: string } }>;
  };
  const messages = request.messages ?? [];
  const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? '');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = messageText(lastUser?.content);
  return {
    messages,
    tools,
    main:
      tools.includes(SHOW_TOOL) && !lastUserText.includes(CLASSIFIER_MARKER),
    lastUserText,
  };
}

/** Number of completed `generated_ui_show` calls in a conversation. */
export function showCalls(request: RecordedRequest): number {
  return request.messages.filter((message) =>
    (message.tool_calls ?? []).some(
      (call) => call.function?.name === SHOW_TOOL,
    ),
  ).length;
}

/** Number of real user turns (excluding tool results) in a conversation. */
export function userTurns(request: RecordedRequest): number {
  return request.messages.filter((message) => message.role === 'user').length;
}

interface ModelBackend {
  baseUrl: string;
  apiKey: string;
  model: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startReplay(script: ReplayScript): Promise<ModelBackend> {
  const requests: RecordedRequest[] = [];
  const server: FakeOpenAIServer = await startFakeOpenAIServer(({ body }) => {
    const request = record(body);
    requests.push(request);
    if (request.lastUserText.includes(CLASSIFIER_MARKER)) {
      // No classifier verdict: the host falls back to asking the user.
      return { content: 'unavailable' };
    }
    if (!request.main) return { content: 'Generated UI acceptance' };
    return script(request);
  });
  return {
    baseUrl: server.baseUrl,
    apiKey: 'fake-key',
    model: 'fake-model',
    requests,
    close: () => server.close(),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Forwards to a real endpoint and records each request body. */
async function startRecordingProxy(model: LiveModel): Promise<ModelBackend> {
  const requests: RecordedRequest[] = [];
  const upstream = model.baseUrl.replace(/\/+$/, '');
  const server: Server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      try {
        const body = await readBody(request);
        if (body.length) {
          try {
            requests.push(record(JSON.parse(body.toString('utf8'))));
          } catch {
            // Non-JSON bodies are forwarded unrecorded.
          }
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (
            typeof value === 'string' &&
            !['host', 'content-length', 'connection'].includes(key)
          ) {
            headers.set(key, value);
          }
        }
        headers.set('authorization', `Bearer ${model.apiKey}`);
        const upstreamResponse = await fetch(`${upstream}${request.url}`, {
          method: request.method,
          headers,
          body: body.length ? body : undefined,
        });
        const responseHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, key) => {
          if (!['content-encoding', 'content-length'].includes(key)) {
            responseHeaders[key] = value;
          }
        });
        response.writeHead(upstreamResponse.status, responseHeaders);
        if (upstreamResponse.body) {
          const reader = upstreamResponse.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
        }
        response.end();
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'proxy-key',
    model: model.model,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Card {
  /** The generated document frame. */
  view: Frame;
  /** The fixed App frame around it (title, summary, host actions). */
  app: Frame;
}

export interface AcceptanceEnv {
  root: string;
  workspaces: string[];
  daemon: SpawnedDaemon;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  requests: RecordedRequest[];
  /** How long a card, a turn or a reply may take in this mode. */
  cardTimeoutMs: number;
  /** Main-agent requests recorded so far. */
  mainRequests(): RecordedRequest[];
  /** Opens a fresh session in a workspace and sends a prompt. */
  startSession(prompt: string, workspace?: string): Promise<void>;
  /** Sends a follow-up prompt in the current session. */
  send(prompt: string): Promise<void>;
  /** Milliseconds from the first prompt to the first rendered card. */
  firstCardMs?: number;
  /** Assistant reply texts (no thoughts) of the newest session, from its log. */
  assistantTexts(): Promise<string[]>;
  /** Waits for the nth card (0-based, creation order) to render. */
  waitForCard(index: number, timeoutMs?: number): Promise<Card>;
  /** Waits until the model is idle (no request for `quietMs`). */
  waitForIdle(quietMs?: number, timeoutMs?: number): Promise<void>;
  /** Approves a pending tool call when the host asks. */
  approvePending(): Promise<boolean>;
  /** Browser console output from the page and its frames. */
  logs: string[];
  /** Saves a full-page screenshot under the run's root, for diagnosis. */
  screenshot(name: string): Promise<string>;
  close(): Promise<void>;
}

const APPROVE_LABEL = 'Yes, allow once';

export async function startAcceptanceEnv(options: {
  mode: ModelMode;
  workspaces?: number;
  /** How long a card may take to appear; real models can take minutes. */
  cardTimeoutMs?: number;
}): Promise<AcceptanceEnv> {
  const cardTimeoutMs = options.cardTimeoutMs ?? 180_000;
  let sessionStartedAt = 0;
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'generated-ui-acceptance-')),
  );
  const home = path.join(root, 'home');
  const workspaces = Array.from({ length: options.workspaces ?? 1 }, (_, i) =>
    path.join(root, `ws-${i + 1}`),
  );
  await Promise.all([home, ...workspaces].map((d) => fs.mkdir(d)));
  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({
      security: {
        auth: { selectedType: 'openai' },
        folderTrust: { enabled: true },
      },
      general: { enableAutoUpdate: false },
      privacy: { usageStatisticsEnabled: false },
      telemetry: { enabled: false },
      model: { skipNextSpeakerCheck: true },
      ui: { enableFollowupSuggestions: false },
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
    }),
  );
  await fs.writeFile(
    path.join(home, 'trustedFolders.json'),
    JSON.stringify(
      Object.fromEntries(workspaces.map((ws) => [ws, 'TRUST_FOLDER'])),
    ),
  );
  await fs.writeFile(path.join(root, 'system.json'), '{}');

  const backend =
    options.mode.kind === 'replay'
      ? await startReplay(options.mode.script)
      : await startRecordingProxy(options.mode.model);

  let daemon: SpawnedDaemon;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const logs: string[] = [];
  const close = async () => {
    await browser?.close().catch(() => {});
    await daemon?.dispose().catch(() => {});
    await backend.close().catch(() => {});
  };
  try {
    daemon = await spawnDaemon({
      cliBin: process.env['TEST_CLI_PATH'] ?? DEFAULT_CLI_BIN,
      workspaceCwd: workspaces[0],
      extraArgs: workspaces.slice(1).flatMap((ws) => ['--workspace', ws]),
      bootTimeoutMs: 60_000,
      env: {
        HOME: home,
        USERPROFILE: home,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
        QWEN_CLI_ENTRY: process.env['TEST_CLI_PATH'] ?? DEFAULT_CLI_BIN,
        QWEN_SANDBOX: 'false',
        QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
        QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(home, 'trustedFolders.json'),
        QWEN_CODE_DISABLE_CRON: '1',
        OPENAI_API_KEY: backend.apiKey,
        OPENAI_BASE_URL: backend.baseUrl,
        OPENAI_MODEL: backend.model,
        QWEN_MODEL: backend.model,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
      },
    });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: daemon.base,
    });
    page = await context.newPage();
    page.on('console', (message) =>
      logs.push(`${message.type()}: ${message.text().slice(0, 300)}`),
    );
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`${daemon.base}/?language=en#token=${daemon.token}`);
  } catch (error) {
    await close();
    throw error;
  }

  const composer = () =>
    page.locator('[data-web-shell-composer-editor] .cm-content');

  async function submit(prompt: string): Promise<void> {
    await composer().waitFor({ timeout: 60_000 });
    await composer().click();
    await page.keyboard.insertText(prompt);
    await page.locator('[data-web-shell-composer-submit]').click();
  }

  const env: AcceptanceEnv = {
    root,
    workspaces,
    cardTimeoutMs,
    daemon,
    browser,
    context,
    page,
    requests: backend.requests,
    logs,
    mainRequests: () => backend.requests.filter((r) => r.main),
    async startSession(prompt, workspace = workspaces[0]) {
      sessionStartedAt = Date.now();
      await page.goto(`${daemon.base}/?language=en#token=${daemon.token}`);
      if (workspaces.length > 1) {
        // Select the workspace in the sidebar, then start a new session there.
        await page
          .getByText(path.basename(workspace), { exact: true })
          .first()
          .click();
        await page
          .getByRole('button', { name: /new session/i })
          .first()
          .click();
      }
      await submit(prompt);
    },
    send: submit,
    async approvePending() {
      const approve = page
        .locator('button', { hasText: APPROVE_LABEL })
        .first();
      if (await approve.isVisible().catch(() => false)) {
        await approve.click();
        return true;
      }
      return false;
    },
    async waitForCard(index, timeoutMs = cardTimeoutMs) {
      const card = await waitForCardOn(page, index, timeoutMs, () =>
        env.approvePending(),
      );
      if (index === 0 && env.firstCardMs === undefined) {
        env.firstCardMs = Date.now() - sessionStartedAt;
      }
      return card;
    },
    async waitForIdle(quietMs = 3_000, timeoutMs = cardTimeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let count = backend.requests.length;
      let since = Date.now();
      while (Date.now() < deadline) {
        await env.approvePending();
        await page.waitForTimeout(500);
        if (backend.requests.length !== count) {
          count = backend.requests.length;
          since = Date.now();
        } else if (Date.now() - since >= quietMs) {
          const busy = await page
            .locator('[data-web-shell-composer-stop]')
            .isVisible()
            .catch(() => false);
          if (!busy) return;
        }
      }
      throw new Error('the session did not become idle');
    },
    async assistantTexts() {
      const projects = path.join(root, 'runtime', 'projects');
      const files: Array<{ file: string; mtime: number }> = [];
      for (const project of await fs.readdir(projects).catch(() => [])) {
        const chats = path.join(projects, project, 'chats');
        for (const name of await fs.readdir(chats).catch(() => [])) {
          if (!/^[0-9a-f-]+\.jsonl$/.test(name)) continue;
          const file = path.join(chats, name);
          files.push({ file, mtime: (await fs.stat(file)).mtimeMs });
        }
      }
      const newest = files.sort((a, b) => b.mtime - a.mtime)[0];
      if (!newest) return [];
      const texts: string[] = [];
      for (const line of (await fs.readFile(newest.file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            message?: { parts?: Array<{ text?: string; thought?: boolean }> };
          };
          if (entry.type !== 'assistant') continue;
          const text = (entry.message?.parts ?? [])
            .filter((part) => part.text && !part.thought)
            .map((part) => part.text)
            .join('');
          if (text.trim()) texts.push(text);
        } catch {
          // Ignore partial lines.
        }
      }
      return texts;
    },
    async screenshot(name) {
      const file = path.join(root, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      return file;
    },
    close,
  };
  return env;
}

/** Waits for the nth card (creation order) on a page to render content. */
export async function waitForCardOn(
  page: Page,
  index: number,
  timeoutMs = 180_000,
  onPoll: () => Promise<unknown> = async () => {},
): Promise<Card> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await onPoll();
    const view = page.frames().filter((frame) => frame.name() === 'view')[
      index
    ];
    if (view && !view.isDetached()) {
      const ready = await view
        .locator('body *')
        .first()
        .isVisible()
        .catch(() => false);
      const app = view.parentFrame();
      if (ready && app) {
        // Let the initial round finish before callers read the view.
        await page.waitForTimeout(500);
        if (!view.isDetached()) return { view, app };
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`card ${index} did not render within ${timeoutMs} ms`);
}

/** Sets a control's value in the generated view and lets the round settle. */
export async function setValue(
  view: Frame,
  id: string,
  value: string,
): Promise<void> {
  const control = view.locator(`#${id}`);
  const tag = await control.evaluate((element) =>
    element.tagName.toLowerCase(),
  );
  if (tag === 'select') await control.selectOption(value);
  else await control.fill(value);
  await view.page().waitForTimeout(300);
}

export async function text(view: Frame, id: string): Promise<string> {
  return (
    (await view
      .locator(`#${id}`)
      .first()
      .textContent({ timeout: 2_000 })
      .catch(() => null)) ?? ''
  ).trim();
}

/** Polls until `read` returns a value accepted by `done`, or the timeout. */
export async function settle<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await read();
  }
  return value;
}
