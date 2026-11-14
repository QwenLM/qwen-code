/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadUndici } from '../utils/runtimeFetchOptions.js';
import {
  DEFAULT_GATE_SETTINGS,
  classifyTurn,
  probeBackend,
  querySystemOne,
  resolveGateSettings,
  type DecisionGateSettings,
} from './decision-gate.js';

function settingsWith(
  overrides: Partial<DecisionGateSettings> = {},
): DecisionGateSettings {
  return { ...DEFAULT_GATE_SETTINGS, enabled: true, ...overrides };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// The default gate endpoint is a loopback URL. When the test machine exports a
// proxy, the gate switches from the global fetch to a real undici fetch for
// loopback endpoints, which bypasses the fetch stub. These helpers clear the
// proxy environment around the stubbed describes so the stub is always used,
// and restore it afterwards.
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

function clearProxyEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreProxyEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('resolveGateSettings', () => {
  it('returns defaults when no input is given', () => {
    expect(resolveGateSettings()).toEqual(DEFAULT_GATE_SETTINGS);
  });

  it('is disabled by default', () => {
    expect(resolveGateSettings({}).enabled).toBe(false);
  });

  it('applies overrides', () => {
    const s = resolveGateSettings({
      enabled: true,
      endpoint: 'http://x:9/v1/systemone',
      model: 'von-9',
      timeoutMs: 50,
    });
    expect(s).toEqual({
      enabled: true,
      endpoint: 'http://x:9/v1/systemone',
      model: 'von-9',
      timeoutMs: 50,
    });
  });

  it('falls back to the default timeout for non-positive or non-numeric values', () => {
    expect(resolveGateSettings({ timeoutMs: 0 }).timeoutMs).toBe(
      DEFAULT_GATE_SETTINGS.timeoutMs,
    );
    expect(resolveGateSettings({ timeoutMs: -5 }).timeoutMs).toBe(
      DEFAULT_GATE_SETTINGS.timeoutMs,
    );
  });

  it('ignores empty-string endpoint/model and keeps defaults', () => {
    const s = resolveGateSettings({ endpoint: '', model: '' });
    expect(s.endpoint).toBe(DEFAULT_GATE_SETTINGS.endpoint);
    expect(s.model).toBe(DEFAULT_GATE_SETTINGS.model);
  });
});

describe('querySystemOne', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedProxy: Record<string, string | undefined>;

  beforeEach(() => {
    savedProxy = clearProxyEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreProxyEnv(savedProxy);
  });

  it('returns parsed answers on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ answers: { needs_tool: { noul: 0.9 } } }),
    );
    const answers = await querySystemOne(
      'hi',
      { needs_tool: { type: 'noul', instructions: 'need a tool?' } },
      settingsWith(),
    );
    expect(answers).toEqual({ needs_tool: { noul: 0.9 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DEFAULT_GATE_SETTINGS.endpoint);
    expect(JSON.parse(init.body).model).toBe(DEFAULT_GATE_SETTINGS.model);
  });

  it('fails open (null) on a non-2xx response even with a valid envelope', async () => {
    // A valid envelope on a 503: only the status guard can reject it, so this
    // pins the `!res.ok` check rather than the malformed-body guard.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { answers: { ok: { type: 'noul', noul: 0.9 } } },
        false,
        503,
      ),
    );
    const answers = await querySystemOne(
      'hi',
      { a: { type: 'noul', instructions: 'x' } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it('sends an Authorization header when apiKeyEnv names a set variable', async () => {
    process.env['VON_TEST_KEY'] = 'secret123';
    try {
      fetchMock.mockResolvedValue(
        jsonResponse({ answers: { a: { noul: 0.5 } } }),
      );
      await querySystemOne(
        'hi',
        { a: { type: 'noul', instructions: 'x' } },
        settingsWith({
          apiKeyEnv: 'VON_TEST_KEY',
          endpoint: 'http://example.invalid/v1/systemone',
        }),
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer secret123');
    } finally {
      delete process.env['VON_TEST_KEY'];
    }
  });

  it('sends no Authorization header when apiKeyEnv is unset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ answers: { a: { noul: 0.5 } } }),
    );
    await querySystemOne(
      'hi',
      { a: { type: 'noul', instructions: 'x' } },
      settingsWith({ endpoint: 'http://example.invalid/v1/systemone' }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('fails open (null) on a malformed response body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));
    const answers = await querySystemOne(
      'hi',
      { a: { type: 'noul', instructions: 'x' } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it('fails open (null) on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const answers = await querySystemOne(
      'hi',
      { a: { type: 'noul', instructions: 'x' } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it('propagates the caller abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new Error('aborted'));
    await expect(
      querySystemOne(
        'hi',
        { a: { type: 'noul', instructions: 'x' } },
        settingsWith(),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});

describe('classifyTurn', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedProxy: Record<string, string | undefined>;

  beforeEach(() => {
    savedProxy = clearProxyEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreProxyEnv(savedProxy);
  });

  it('returns null when disabled (no network call)', async () => {
    const decision = await classifyTurn('hi', {
      ...DEFAULT_GATE_SETTINGS,
      enabled: false,
    });
    expect(decision).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes needs_tool when the tool probability is decisive', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.95 },
          answerable_from_context: { noul: 0.1 },
          intent: { choice: 'code_change', confidence: 0.9 },
        },
      }),
    );
    const decision = await classifyTurn('delete the tmp dir', settingsWith());
    expect(decision?.route).toBe('needs_tool');
  });

  it('routes answer_from_context when strongly answerable and low tool need', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.1 },
          answerable_from_context: { noul: 0.92 },
          intent: { choice: 'code_question', confidence: 0.8 },
        },
      }),
    );
    const decision = await classifyTurn(
      'what did we just change?',
      settingsWith(),
    );
    expect(decision?.route).toBe('answer_from_context');
  });

  it('routes plain_chat for obvious chat with no tool need', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.05 },
          answerable_from_context: { noul: 0.4 },
          intent: { choice: 'chat', confidence: 0.95 },
        },
      }),
    );
    const decision = await classifyTurn('thanks!', settingsWith());
    expect(decision?.route).toBe('plain_chat');
  });

  it('routes unknown when signals are not decisive', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.5 },
          answerable_from_context: { noul: 0.5 },
          intent: { choice: 'other', confidence: 0.4 },
        },
      }),
    );
    const decision = await classifyTurn('hmm', settingsWith());
    expect(decision?.route).toBe('unknown');
  });

  it('returns null when the backend is unavailable (fail-open)', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const decision = await classifyTurn('hi', settingsWith());
    expect(decision).toBeNull();
  });
});

describe('probeBackend', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedProxy: Record<string, string | undefined>;

  beforeEach(() => {
    savedProxy = clearProxyEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreProxyEnv(savedProxy);
  });

  it('returns healthy when the endpoint answers a noul', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ answers: { ok: { noul: 0.7 } } }),
    );
    await expect(probeBackend(settingsWith())).resolves.toBe('healthy');
  });

  it('returns unreachable when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(probeBackend(settingsWith())).resolves.toBe('unreachable');
  });

  it('returns auth_failed on a 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 401));
    await expect(probeBackend(settingsWith())).resolves.toBe('auth_failed');
  });

  it('returns auth_failed on a 403', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 403));
    await expect(probeBackend(settingsWith())).resolves.toBe('auth_failed');
  });

  it('returns unhealthy on a 200 that carries no numeric ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ answers: { other: {} } }));
    await expect(probeBackend(settingsWith())).resolves.toBe('unhealthy');
  });
});

describe('querySystemOne proxy bypass (real network, no fetch stub)', () => {
  const PROXY_ENV = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let server: http.Server | undefined;
  let endpoint = '';

  beforeEach(async () => {
    for (const key of PROXY_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // A real loopback backend that answers the health probe.
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answers: { ok: { noul: 0.9 } } }));
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server!.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}/v1/systemone`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    for (const key of PROXY_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    const { setGlobalDispatcher } = await loadUndici();
    setGlobalDispatcher(new (await loadUndici()).Agent());
  });

  it('reaches a loopback backend even when a system proxy is installed', async () => {
    // Simulate a machine that exports a proxy and has NO_PROXY unset: the
    // process-wide proxy dispatcher would tunnel the loopback request through the
    // proxy (which is not running here) and the gate would never reach the local
    // backend. The gate must bypass the proxy for loopback.
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:1';
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:1';
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: 'http://127.0.0.1:1',
        httpsProxy: 'http://127.0.0.1:1',
      }),
    );

    await expect(probeBackend(settingsWith({ endpoint }))).resolves.toBe(
      'healthy',
    );
  });

  it('a raw global fetch through the same proxy would NOT reach loopback (control)', async () => {
    // Control arm proving the bug is real: without the gate's bypass, the global
    // proxy dispatcher cannot reach the loopback backend.
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:1';
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: 'http://127.0.0.1:1',
        httpsProxy: 'http://127.0.0.1:1',
      }),
    );

    await expect(
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', state: 'health', questions: {} }),
      }),
    ).rejects.toBeTruthy();
  });
});
