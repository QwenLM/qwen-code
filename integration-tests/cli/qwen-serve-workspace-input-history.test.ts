/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';
import { spawnDaemon, type SpawnedDaemon } from './_daemon-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CHILD = path.resolve(
  __dirname,
  '../fixtures/mock-acp-child/agent.mjs',
);
const SHELL_HISTORY_SOURCE = path.resolve(
  __dirname,
  '../../packages/cli/src/utils/shell-history-file.ts',
);
const execFileAsync = promisify(execFile);

// An external ACP child replaces only the model capability. Everything from
// the real daemon and HTTP/SSE socket to the project-history files is real.
const SKIP =
  process.platform === 'win32' ||
  Boolean(process.env['QWEN_SANDBOX'] === 'docker');

describe('daemon workspace input history (real HTTP/stdio/filesystem)', () => {
  if (SKIP) return;
  let root: string;
  let workspace: string;
  let missing: string;
  let daemon: SpawnedDaemon;
  let shellFile: string;
  let promptFile: string;

  async function request(
    route: string,
    init: RequestInit = {},
    workspaceId?: string,
  ): Promise<Response> {
    const prefix = workspaceId
      ? `/workspaces/${encodeURIComponent(workspaceId)}/input-history`
      : '/workspace/input-history';
    return fetch(`${daemon!.base}${prefix}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${daemon!.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }

  async function append(entry: string, kind = 'prompt', workspaceId?: string) {
    const response = await request(
      '',
      { method: 'POST', body: JSON.stringify({ kind, entry }) },
      workspaceId,
    );
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 200 });
    return body as { kind: string; entries: string[]; revision: string };
  }

  async function get(kind = 'prompt', workspaceId?: string) {
    const response = await request(`?kind=${kind}`, {}, workspaceId);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      kind: string;
      entries: string[];
      revision: string;
    };
  }

  /**
   * A real SSE reader. Parsing starts before the desktop prompt is admitted,
   * so a successful assertion cannot be satisfied by an offline file write.
   */
  async function subscribe(
    sessionId: string,
    clientId: string,
  ): Promise<{
    events: unknown[];
    close: () => void;
    done: Promise<void>;
  }> {
    const abort = new AbortController();
    const response = await fetch(
      `${daemon.base}/session/${encodeURIComponent(sessionId)}/events`,
      {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${daemon.token}`,
          'X-Qwen-Client-Id': clientId,
        },
        signal: abort.signal,
      },
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error('Missing real SSE response body');
    const events: unknown[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const done = (async () => {
      let pending = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let boundary = pending.match(/\r?\n\r?\n/);
          while (boundary?.index !== undefined) {
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const payload = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (payload) {
              try {
                events.push(JSON.parse(payload));
              } catch {
                // Keep unconditional event and heartbeat frames non-fatal.
              }
            }
            boundary = pending.match(/\r?\n\r?\n/);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();
    return { events, done, close: () => abort.abort() };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-input-history-real-'));
    workspace = path.join(root, 'primary');
    missing = path.join(root, 'missing');
    const home = path.join(root, 'home');
    const runtime = path.join(root, 'runtime');
    await Promise.all(
      [workspace, home, runtime].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.mkdir(path.join(workspace, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    await fs.writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    daemon = await spawnDaemon({
      workspaceCwd: workspace,
      cliBin: path.resolve(__dirname, '../../packages/cli/dist/index.js'),
      token: 'input-history-real-test-token',
      bootTimeoutMs: 30_000,
      extraArgs: ['--enable-session-shell'],
      envDrop: [/^QWEN_/, /^OPENAI_/, /^ANTHROPIC_/, /^AWS_/],
      env: {
        HOME: home,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtime,
        QWEN_CLI_ENTRY: MOCK_CHILD,
        MOCK_AGENT_TYPE: 'plain',
        MOCK_AGENT_DELAY_MS: '800',
        MOCK_AGENT_LOG_FILE: path.join(root, 'mock-agent.jsonl'),
        MOCK_AGENT_STDERR_FILE: path.join(root, 'mock-agent-stderr.txt'),
      },
    });
    const caps = await daemon.client.capabilities();
    expect(caps.features).toContain('workspace_input_history');
    expect(caps.workspaceCwd).toBe(workspace);
    await daemon.client.grantWorkspaceTrust();
    const productionHistoryModule = pathToFileURL(
      path.resolve(
        __dirname,
        '../../packages/cli/dist/src/serve/workspace-input-history.js',
      ),
    ).href;
    const resolved = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { getWorkspaceInputHistoryFilePath } = await import(${JSON.stringify(productionHistoryModule)}); console.log(getWorkspaceInputHistoryFilePath(process.cwd(), 'shell')); console.log(getWorkspaceInputHistoryFilePath(process.cwd(), 'prompt'));`,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtime,
        },
      },
    );
    [shellFile, promptFile] = resolved.stdout.trim().split('\n');
  }, 60_000);

  afterAll(async () => {
    if (daemon) await daemon.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('records real prompt, mid-turn and shell input for another client without overwriting shell history', async () => {
    const created = await DaemonSessionClient.createOrAttach(
      new DaemonClient({ baseUrl: daemon.base, token: daemon.token }),
      { workspaceCwd: workspace },
      'desktop-client',
    ).catch(async (error) => {
      console.error('daemon stdout:', daemon.stdoutBuf.value);
      console.error('daemon stderr:', daemon.stderrBuf.value);
      for (const logPath of ['mock-agent.jsonl', 'mock-agent-stderr.txt']) {
        console.error(
          `${logPath}:`,
          await fs.readFile(path.join(root, logPath), 'utf8').catch(() => ''),
        );
      }
      throw error;
    });
    const desktop = await DaemonSessionClient.load(
      new DaemonClient({ baseUrl: daemon.base, token: daemon.token }),
      created.sessionId,
      { workspaceCwd: workspace },
      'desktop-client',
    );
    const desktopClientId = desktop.clientId;
    if (!desktopClientId) throw new Error('Daemon did not bind desktop client');
    const mobile = await subscribe(desktop.sessionId, 'mobile-client');

    try {
      await desktop.prompt({
        prompt: [{ type: 'text', text: 'desktop original @src/main.ts' }],
        _meta: { 'qwen.submittedPrompt': 'explain @src/main.ts' },
      });
      const active = await fetch(
        `${daemon.base}/session/${encodeURIComponent(desktop.sessionId)}/mid-turn-message`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            'Content-Type': 'application/json',
            'X-Qwen-Client-Id': desktopClientId,
          },
          body: JSON.stringify({ message: 'mid-turn follow-up' }),
        },
      );
      expect(active.status).toBe(200);
      await vi
        .waitFor(() => {
          expect(
            JSON.stringify(mobile.events).includes(
              'desktop original @src/main.ts',
            ),
          ).toBe(true);
        })
        .catch((error) => {
          console.error(
            'actual mobile SSE events:',
            JSON.stringify(mobile.events).slice(0, 12_000),
          );
          throw error;
        });
    } finally {
      mobile.close();
      await mobile.done;
    }

    await vi.waitFor(async () => {
      await expect(get()).resolves.toMatchObject({
        entries: ['explain @src/main.ts', 'mid-turn follow-up'],
      });
    });

    // The TUI producer has the real format and execution path, not a mock
    // write in this test, while daemon-controlled commands append in parallel.
    const childScript = `
      const { appendShellHistoryFile } = await import(${JSON.stringify(pathToFileURL(SHELL_HISTORY_SOURCE).href)});
      appendShellHistoryFile(process.argv[1], process.argv[2]);
    `;
    await Promise.all(
      ['tui-git-status', 'tui-ls-la'].map((entry) =>
        execFileAsync(process.execPath, [
          '--no-warnings',
          '--input-type=module',
          '-e',
          childScript,
          shellFile,
          entry,
        ]),
      ),
    );
    const shellResult = await desktop.shellCommand('printf desktop-shell');
    expect(shellResult.exitCode).toBe(0);

    await vi.waitFor(async () => {
      const entries = (await get('shell')).entries;
      expect(entries.slice(-1)).toEqual(['printf desktop-shell']);
      expect(entries.slice(0, -1).toSorted()).toEqual([
        'tui-git-status',
        'tui-ls-la',
      ]);
    });
    const diskHistory = JSON.parse(
      await fs.readFile(shellFile, 'utf8'),
    ) as string[];
    expect(diskHistory.slice(-1)).toEqual(['printf desktop-shell']);
    expect(diskHistory.slice(0, -1).toSorted()).toEqual([
      'tui-git-status',
      'tui-ls-la',
    ]);

    // A second session in the same workspace preserves the shared history.
    const second = await DaemonSessionClient.createOrAttach(
      new DaemonClient({ baseUrl: daemon.base, token: daemon.token }),
      { workspaceCwd: workspace },
      'second-session-client',
    );
    await second.prompt({
      prompt: [{ type: 'text', text: 'from another session' }],
    });
    await vi.waitFor(async () => {
      await expect(get()).resolves.toMatchObject({
        entries: [
          'explain @src/main.ts',
          'mid-turn follow-up',
          'from another session',
        ],
      });
    });
  }, 90_000);

  it('enforces auth, workspace ownership and trust, bounded validation, and cache contracts', async () => {
    const unauthenticated = await fetch(
      `${daemon.base}/workspace/input-history?kind=prompt`,
    );
    expect(unauthenticated.status).toBe(401);

    const before = await append('local slash /clear');
    const duplicate = await append('local slash /clear');
    expect(duplicate.entries).toEqual(before.entries);
    expect(duplicate.revision).toBe(before.revision);

    const cached = await request(`?kind=prompt`, {
      headers: { 'If-None-Match': `"v1:${before.revision}"` },
    });
    expect(cached.status).toBe(304);

    const altered = await append('local slash /recap');
    const changed = await request(`?kind=prompt`, {
      headers: { 'If-None-Match': `"v1:${before.revision}"` },
    });
    expect(changed.status).toBe(200);
    expect(altered.revision).not.toBe(before.revision);

    const badKind = await request('?kind=invalid');
    expect(badKind.status).toBe(400);
    const badLimit = await request('?limit=1000');
    expect(badLimit.status).toBe(400);
    const badEntry = await request('', {
      method: 'POST',
      body: JSON.stringify({ kind: 'prompt', entry: '  ' }),
    });
    expect(badEntry.status).toBe(400);

    const unknown = await request('', {}, 'ffffffffffffffff');
    expect(unknown.status).toBe(400);
    const secondaryRegistration = await daemon.client.addWorkspace(
      await fs.mkdtemp(path.join(root, 'secondary-')),
    );
    const untrusted = await request('', {}, secondaryRegistration.id);
    expect(untrusted.status).toBe(403);
    expect((await get()).entries).not.toContain('secondary secret prompt');

    const trustResponse = await fetch(
      `${daemon.base}/workspaces/${encodeURIComponent(secondaryRegistration.id)}/trust/grant`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(trustResponse.status).toBe(200);
    await vi.waitFor(async () => {
      await expect(
        append('secondary secret prompt', 'prompt', secondaryRegistration.id),
      ).resolves.toMatchObject({
        entries: ['secondary secret prompt'],
      });
    });
    await vi.waitFor(async () => {
      await expect(
        get('prompt', secondaryRegistration.id),
      ).resolves.toMatchObject({
        entries: ['secondary secret prompt'],
      });
    });
    expect((await get()).entries).not.toContain('secondary secret prompt');

    const promptBeforeCorruption = await fs.readFile(promptFile, 'utf8');
    await fs.writeFile(promptFile, '{broken prompt file', 'utf8');
    try {
      const corrupt = await request('', {
        method: 'POST',
        body: JSON.stringify({ kind: 'prompt', entry: 'must not replace' }),
      });
      expect(corrupt.status).toBe(500);
      await expect(fs.readFile(promptFile, 'utf8')).resolves.toBe(
        '{broken prompt file',
      );
    } finally {
      await fs.writeFile(promptFile, promptBeforeCorruption, 'utf8');
    }

    // Explicit negative control proves the workspace used by the test was the
    // intended real isolated directory, never a shared primary history file.
    expect((await get()).entries).toContain('local slash /recap');
    await expect(
      fs.access(path.join(missing, 'input_history.json')),
    ).rejects.toThrow();
  }, 60_000);
});
