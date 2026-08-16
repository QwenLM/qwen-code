import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.mkdir.mockImplementation(actual.mkdir);
  fsMocks.writeFile.mockImplementation(actual.writeFile);
  fsMocks.rename.mockImplementation(actual.rename);
  return {
    ...actual,
    mkdir: fsMocks.mkdir,
    writeFile: fsMocks.writeFile,
    rename: fsMocks.rename,
  };
});

import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  parseProxyEp,
  discoverGithubToken,
  exchangeGhuForCapi,
  createCopilotTokenManager,
  runCopilotDeviceFlow,
  persistGithubToken,
} from './copilot-auth.js';

describe('parseProxyEp', () => {
  it('extracts and rewrites proxy-ep from ghu_-minted token', () => {
    const bearer =
      'tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com;extra=1';
    expect(parseProxyEp(bearer)).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });
  it('returns null when proxy-ep absent', () => {
    const bearer = 'tid=abc;exp=123';
    expect(parseProxyEp(bearer)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(parseProxyEp('')).toBeNull();
  });
  it('handles bearer without trailing semicolons', () => {
    const bearer = 'proxy-ep=proxy.enterprise.githubcopilot.com';
    expect(parseProxyEp(bearer)).toBe(
      'https://api.enterprise.githubcopilot.com',
    );
  });
});

describe('discoverGithubToken', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds ghu_ in hosts.json shape', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_TESTABCD1234' },
      }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: hostsFile });
    expect(result.token).toBe('ghu_TESTABCD1234');
    expect(result.token.startsWith('ghu_')).toBe(true);
  });

  it('finds gho_ in Copilot CLI config shape', async () => {
    const configFile = join(tempDir, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        copilotTokens: { 'https://github.com:login': 'gho_TESTEFGH5678' },
      }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: configFile });
    expect(result.token).toBe('gho_TESTEFGH5678');
    expect(result.token.startsWith('gho_')).toBe(true);
  });

  it('ignores ghp_ PAT tokens', async () => {
    const file = join(tempDir, 'hosts.json');
    writeFileSync(
      file,
      JSON.stringify({ 'github.com': { oauth_token: 'ghp_PATIGNORE' } }),
      {
        mode: 0o600,
      },
    );
    await expect(discoverGithubToken({ overridePath: file })).rejects.toThrow();
  });

  it('throws when no token found', async () => {
    await expect(
      discoverGithubToken({ overridePath: join(tempDir, 'nonexistent.json') }),
    ).rejects.toThrow();
  });

  it('parses VS Code accounts shape', async () => {
    const file = join(tempDir, 'vsc.json');
    writeFileSync(
      file,
      JSON.stringify({ accounts: [{ token: 'ghu_VSCODE1234' }] }),
      { mode: 0o600 },
    );
    const result = await discoverGithubToken({ overridePath: file });
    expect(result.token).toBe('ghu_VSCODE1234');
  });
});

describe('persistGithubToken', () => {
  let tempDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'copi-hosts-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes token to hosts.json under Copilot client ID key', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    await persistGithubToken('ghu_test123', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_test123',
    );
  });

  it('preserves existing entries when writing', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({ 'github.com:other-app': { oauth_token: 'existing' } }),
    );
    await persistGithubToken('ghu_test456', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:other-app'].oauth_token).toBe('existing');
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_test456',
    );
  });

  it('updates existing Copilot entry in place', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_old' },
      }),
    );
    await persistGithubToken('ghu_new', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_new',
    );
  });

  it('sets file permissions to 0o600', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    await persistGithubToken('ghu_perm', { hostsFilePath: hostsFile });
    const st = statSync(hostsFile);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('creates parent directory if missing', async () => {
    const hostsFile = join(tempDir, 'sub', 'dir', 'hosts.json');
    await persistGithubToken('ghu_mkdir', { hostsFilePath: hostsFile });
    const raw = readFileSync(hostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['github.com:Iv1.b507a08c87ecfe98'].oauth_token).toBe(
      'ghu_mkdir',
    );
  });

  it('persisted token is discoverable by discoverGithubToken', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    await persistGithubToken('ghu_roundtrip', { hostsFilePath: hostsFile });
    const result = await discoverGithubToken({ overridePath: hostsFile });
    expect(result.token).toBe('ghu_roundtrip');
  });

  it('does not replace hosts.json when cancellation is already observed', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
      }),
    );
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(JSON.parse(readFileSync(hostsFile, 'utf-8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
    });
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('does not start the non-abortable rename after cancellation follows its temp write', async () => {
    const hostsFile = join(tempDir, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
      }),
    );
    const ctrl = new AbortController();
    fsMocks.writeFile.mockImplementationOnce(async () => {
      ctrl.abort();
    });

    await expect(
      persistGithubToken('ghu_new', {
        hostsFilePath: hostsFile,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);

    expect(fsMocks.rename).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(hostsFile, 'utf-8'))).toEqual({
      'github.com:Iv1.b507a08c87ecfe98': { oauth_token: 'ghu_existing' },
    });
  });
});

function makeMockFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const mockFetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const res = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: mockFetch, calls };
}

describe('exchangeGhuForCapi', () => {
  it('exchanges ghu_ for CAPI bearer', async () => {
    const { fetch, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const result = await exchangeGhuForCapi('ghu_TEST1234', {
      fetchImpl: fetch,
    });
    expect(result.bearer).toContain('tid=');
    expect(result.endpointsApi).toBe(
      'https://api.individual.githubcopilot.com',
    );
    expect(result.expiresAtMs).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.github.com/copilot_internal/v2/token');
    expect(calls[0].headers['Authorization']).toBe('token ghu_TEST1234');
  });

  it('4xx short-circuits (no retry)', async () => {
    const { fetch, calls } = makeMockFetch([
      { status: 401, body: { error: 'bad token' } },
    ]);
    await expect(
      exchangeGhuForCapi('ghu_BAD', { fetchImpl: fetch }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('throws on non-ghu_ prefix', async () => {
    await expect(exchangeGhuForCapi('gho_NOTGHU')).rejects.toThrow();
  });

  it('uses parseProxyEp for endpointsApi when proxy-ep present', async () => {
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://fallback.example.com' },
        },
      },
    ]);
    const result = await exchangeGhuForCapi('ghu_TEST', { fetchImpl: fetch });
    // parseProxyEp wins over endpoints.api
    expect(result.endpointsApi).toBe(
      'https://api.enterprise.githubcopilot.com',
    );
  });
});

describe('CopilotTokenManager', () => {
  it('getSnapshot returns atomic bearer+endpointsApi pair', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    // bearer is a RedactedString (toString→[redacted]); use valueOf() for the
    // functional primitive value (Ruling 2: brief's bare toContain/toBe are
    // incompatible with the Global-Constraint RedactedString).
    expect(snap.bearer.valueOf()).toContain('tid=');
    expect(snap.endpointsApi).toBe('https://api.individual.githubcopilot.com');
    expect(snap.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('gho_ path skips fetch (no exchange HTTP)', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const hostsFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'hosts.json',
    );
    writeFileSync(
      hostsFile,
      JSON.stringify({ 'github.com': { oauth_token: 'gho_TEST1234' } }),
      {
        mode: 0o600,
      },
    );
    const { fetch, calls } = makeMockFetch([]);
    process.env['COPILOT_GITHUB_TOKEN_PATH'] = hostsFile;
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    expect(snap.bearer.valueOf()).toBe('gho_TEST1234');
    expect(calls).toHaveLength(0); // no exchange HTTP
    delete process.env['COPILOT_GITHUB_TOKEN_PATH'];
  });

  it('redacts bearer in inspect/toString/toJSON', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=SECRETBEARER;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    const snap = await mgr.getSnapshot();
    expect(String(snap.bearer)).not.toContain('SECRETBEARER');
    expect(JSON.stringify(snap)).not.toContain('SECRETBEARER');
    expect(inspect(snap)).not.toContain('SECRETBEARER');
  });

  it('concurrent getSnapshot calls share a single mint (mintInFlight dedup)', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-mgr-')),
      'copilot.json',
    );
    let fetchCallCount = 0;
    const countingFetch = (async (_url: URL | string, _init?: RequestInit) => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const mgr = createCopilotTokenManager({
      cacheFile,
      fetchImpl: countingFetch,
    });
    const [a, b, c] = await Promise.all([
      mgr.getSnapshot(),
      mgr.getSnapshot(),
      mgr.getSnapshot(),
    ]);
    expect(fetchCallCount).toBe(1);
    expect(a.bearer.valueOf()).toBe(b.bearer.valueOf());
    expect(b.bearer.valueOf()).toBe(c.bearer.valueOf());
  });

  it('cache dir created with 0o700 permissions', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'copi-perm-'));
    const cacheFile = join(tempRoot, 'subdir', 'copilot.json');
    const { fetch } = makeMockFetch([
      {
        status: 200,
        body: {
          token: 'tid=abc;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        },
      },
    ]);
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: fetch });
    await mgr.getSnapshot();
    const dirStat = statSync(join(tempRoot, 'subdir'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

describe('runCopilotDeviceFlow', () => {
  it('polls device flow and returns ghu_ token', async () => {
    let pollCount = 0;
    const mockFetch = (async (url: URL | string, _init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 0, // fast poll for test
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.endsWith('/login/oauth/access_token')) {
        pollCount++;
        if (pollCount < 2) {
          return new Response(
            JSON.stringify({ error: 'authorization_pending' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify({ access_token: 'ghu_DEVICEFLOW1234' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const events: string[] = [];
    const result = await runCopilotDeviceFlow({
      fetchImpl: mockFetch,
      notify: (e) => {
        if (e.type === 'device_code') events.push(`code:${e.userCode}`);
        if (e.type === 'progress') events.push('progress');
      },
    });
    expect(result.token).toBe('ghu_DEVICEFLOW1234');
    expect(events).toContain('code:ABCD-1234');
  });

  it('handles slow_down by increasing interval', async () => {
    let pollCount = 0;
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev456',
            user_code: 'WXYZ-9999',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCount++;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({ error: 'slow_down', interval: 1 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({ access_token: 'ghu_SLOWDOWN1234' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await runCopilotDeviceFlow({ fetchImpl: mockFetch });
    expect(result.token).toBe('ghu_SLOWDOWN1234');
  });

  it('throws on expired_token', async () => {
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev789',
            user_code: 'EXPI-RED0',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'expired_token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(
      runCopilotDeviceFlow({ fetchImpl: mockFetch }),
    ).rejects.toThrow(/expired/i);
  });

  it('cancel via AbortSignal rejects with "cancelled"', async () => {
    const ctrl = new AbortController();
    const mockFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev000',
            user_code: 'CANC-EL01',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    setTimeout(() => ctrl.abort(), 50);
    await expect(
      runCopilotDeviceFlow({ fetchImpl: mockFetch, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/i);
  });

  it('rejects when cancelled while a polling response resolves late', async () => {
    const ctrl = new AbortController();
    let deviceRequestSignal: AbortSignal | null | undefined;
    let pollRequestSignal: AbortSignal | null | undefined;
    let resolvePollResponse!: (response: Response) => void;
    let notifyPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      notifyPollStarted = resolve;
    });
    const latePollResponse = new Promise<Response>((resolve) => {
      resolvePollResponse = resolve;
    });
    const mockFetch = (async (url: URL | string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/login/device/code')) {
        deviceRequestSignal = init?.signal;
        return new Response(
          JSON.stringify({
            device_code: 'dev-late',
            user_code: 'LATE-0001',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      pollRequestSignal = init?.signal;
      notifyPollStarted();
      return latePollResponse;
    }) as typeof fetch;

    const flow = runCopilotDeviceFlow({
      fetchImpl: mockFetch,
      signal: ctrl.signal,
    });
    await pollStarted;
    ctrl.abort();
    resolvePollResponse(
      new Response(JSON.stringify({ access_token: 'ghu_LATE_TOKEN' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(flow).rejects.toThrow(/cancel/i);
    expect(deviceRequestSignal).toBe(ctrl.signal);
    expect(pollRequestSignal).toBe(ctrl.signal);
  });
});
