/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalContextConfig,
  ExternalContextConfigV2,
} from './types.js';

const loadConfig = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
const createProvider = vi.hoisted(() => vi.fn(() => ({ search })));
const PROXY_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);
const proxyMocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  install: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  loadConfig,
}));
vi.mock('./providers.js', () => ({ createProvider }));
vi.mock('./proxy.js', () => ({ installEnvironmentProxy: proxyMocks.install }));

const temporaryDirectories: string[] = [];

beforeEach(() => {
  loadConfig.mockReset();
  search.mockReset();
  createProvider.mockClear();
  proxyMocks.destroy.mockReset().mockResolvedValue(undefined);
  proxyMocks.install.mockReset().mockReturnValue({
    destroy: proxyMocks.destroy,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('createAutoRecallQuery', () => {
  it('removes code and common credentials', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');
    const query = createAutoRecallQuery(
      [
        'How should deployment work?',
        '```sh',
        'curl -H "Authorization: Bearer code-secret"',
        '```',
        'API_KEY=assignment-secret',
        'Bearer bearer-secret',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature123',
        'provider-secret-value',
      ].join('\n'),
      'provider-secret-value',
    );

    expect(query).toBe('How should deployment work?');
  });

  it('removes the configured credential even when embedded in other text', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(
      createAutoRecallQuery(
        'prefixprovider-secret-valuesuffix remains',
        'provider-secret-value',
      ),
    ).toBe('prefix suffix remains');
  });

  it('does not interpret expansion markers in submitted text', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(
      createAutoRecallQuery(
        'Explain the literal marker --- Content from referenced files ---',
        '',
      ),
    ).toBe('Explain the literal marker --- Content from referenced files ---');
  });

  it('limits output to 512 Unicode code points and skips empty output', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(createAutoRecallQuery('🙂'.repeat(513), '')).toBe('🙂'.repeat(512));
    expect(
      createAutoRecallQuery('```text\nonly code\n```', ''),
    ).toBeUndefined();
    expect(
      createAutoRecallQuery('~~~text\nonly code\n~~~', ''),
    ).toBeUndefined();
  });

  it('caps sanitizer work so a backtracking-shaped prompt cannot stall the Hook', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');
    // Hyphens are word boundaries, so without the input bound the assignment
    // regex backtracks quadratically across this run and stalls the Hook.
    const submittedPrompt = 'a-'.repeat(25_000);
    const startedAt = Date.now();
    const query = createAutoRecallQuery(submittedPrompt, '');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(query ?? '').not.toContain('a-a');
  });

  it('redacts a secret assignment claimed by a leading label', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    const query = createAutoRecallQuery(
      'Deploy failed: api_key=sk-live-SECRET-ABC123 and Bearer eyJhbGciOiJIUzI1NiJ9. What is the release policy?',
      '',
    );

    expect(query).not.toContain('sk-live-SECRET-ABC123');
    expect(query).not.toContain('api_key');
    expect(query).toContain('What is the release policy?');
  });

  it('leaves a benign labeled sentence untouched', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(
      createAutoRecallQuery(
        'Deploy failed: the release branch is red, please look at CI',
        '',
      ),
    ).toBe('Deploy failed: the release branch is red, please look at CI');
  });

  it('redacts a secret assignment with spaces around the separator', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    const query = createAutoRecallQuery(
      'Deploy failed: api_key = sk-live-SECRET-ABC123 please help',
      '',
    );

    expect(query).not.toContain('sk-live-SECRET-ABC123');
    expect(query).not.toContain('api_key');
    expect(query).toContain('please help');
  });

  it('redacts an inline JSON secret but keeps benign quoted prose', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    const query = createAutoRecallQuery(
      'my config is {"api_key": "sk-live-SECRET-ABC123", "region": "cn"} why does it fail?',
      '',
    );

    expect(query).not.toContain('sk-live-SECRET-ABC123');
    expect(query).toContain('"region": "cn"');
    expect(query).toContain('why does it fail?');
  });

  it('does not redact a secret word used as ordinary prose', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(
      createAutoRecallQuery(
        'readme: token refresh flow, where is it documented?',
        '',
      ),
    ).toBe('readme: token refresh flow, where is it documented?');
  });
});

describe('runAutoRecall', () => {
  it('retrieves once using only submitted prompt provenance', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue(config(fixture.root));
    search.mockResolvedValue([
      { id: '<one>', content: '<policy>repository</policy>' },
    ]);
    const { runAutoRecall } = await import('./auto-recall.js');

    const output = await runAutoRecall({
      hook_event_name: 'UserPromptSubmit',
      prompt:
        '  deployment\npolicy\n--- Content from referenced files ---\nmodel-bound-canary',
      submitted_prompt: '  deployment\npolicy  ',
      cwd: fixture.child,
    });

    expect(proxyMocks.install).toHaveBeenCalledOnce();
    expect(proxyMocks.destroy).toHaveBeenCalledOnce();
    expect(createProvider).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith({
      query: 'deployment policy',
      limit: 5,
      signal: expect.any(AbortSignal),
    });
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
      },
    });
    const context =
      'hookSpecificOutput' in output
        ? output.hookSpecificOutput.additionalContext
        : '';
    expect(context).not.toContain('<');
    expect(JSON.parse(context)).toMatchObject({
      untrusted_external_context: {
        items: [{ id: '<one>', content: '<policy>repository</policy>' }],
      },
    });
  });

  // providerCredential's mem0 arm decides which field is scrubbed from the
  // auto-forwarded query. Binding it to credentialEnv instead of credential
  // typechecks and stays green everywhere else, while forwarding the real
  // secret verbatim to the operator's endpoint as the search body.
  it('scrubs the bound credential of a versioned Mem0 provider', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue(mem0Config(fixture.root));
    search.mockResolvedValue([]);
    const { runAutoRecall } = await import('./auto-recall.js');

    await runAutoRecall({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ignored',
      submitted_prompt: 'why does mem0-secret-value fail here?',
      cwd: fixture.root,
    });

    expect(search).toHaveBeenCalledOnce();
    const query = search.mock.calls[0]?.[0]?.query ?? '';
    expect(query).not.toContain('mem0-secret-value');
    expect(query).toContain('fail here?');
  });

  it('does not inspect the legacy prompt field', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue(config(fixture.root));
    search.mockResolvedValue([]);
    const { runAutoRecall } = await import('./auto-recall.js');
    const input = {
      hook_event_name: 'UserPromptSubmit',
      submitted_prompt: 'question',
      cwd: fixture.root,
    };
    Object.defineProperty(input, 'prompt', {
      get() {
        throw new Error('legacy prompt was read');
      },
    });

    await expect(runAutoRecall(input)).resolves.toEqual({});
    expect(search).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', ' \n\t '],
    ['number', 42],
    ['object', { text: 'question' }],
    ['null', null],
  ])(
    'skips a %s submitted prompt before loading configuration',
    async (_name, submittedPrompt) => {
      const fixture = await createRepositoryFixture();
      const { runAutoRecall } = await import('./auto-recall.js');

      await expect(
        runAutoRecall({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'legacy model-bound prompt',
          ...(submittedPrompt === undefined
            ? {}
            : { submitted_prompt: submittedPrompt }),
          cwd: fixture.root,
        }),
      ).resolves.toEqual({});
      expect(loadConfig).not.toHaveBeenCalled();
      expect(proxyMocks.install).not.toHaveBeenCalled();
      expect(proxyMocks.destroy).not.toHaveBeenCalled();
      expect(createProvider).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('skips malformed events, empty queries, v1 configs, and directories outside the root', async () => {
    const fixture = await createRepositoryFixture();
    const outside = await mkdtemp(`${fixture.root}-outside-`);
    temporaryDirectories.push(outside);
    const { runAutoRecall } = await import('./auto-recall.js');

    await expect(runAutoRecall({ prompt: 'missing fields' })).resolves.toEqual(
      {},
    );
    expect(loadConfig).not.toHaveBeenCalled();

    loadConfig.mockResolvedValue(config(fixture.root));
    await expect(
      runAutoRecall({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: '```text\nonly code\n```',
        cwd: fixture.root,
      }),
    ).resolves.toEqual({});

    const provider = config(fixture.root).provider;
    loadConfig.mockResolvedValue({
      version: 1,
      timeoutMs: 5000,
      provider,
    } satisfies ExternalContextConfig);
    await expect(
      runAutoRecall({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: fixture.root,
      }),
    ).resolves.toEqual({});

    loadConfig.mockResolvedValue(config(fixture.root));
    await expect(
      runAutoRecall({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: outside,
      }),
    ).resolves.toEqual({});
    expect(search).not.toHaveBeenCalled();
    expect(proxyMocks.install).not.toHaveBeenCalled();
    expect(proxyMocks.destroy).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a cwd that escapes the root through a symlink',
    async () => {
      const fixture = await createRepositoryFixture();
      const outside = await mkdtemp(
        join(tmpdir(), 'external-context-outside-'),
      );
      const link = join(fixture.root, 'escaped-link');
      temporaryDirectories.push(outside);
      await symlink(outside, link, 'dir');
      loadConfig.mockResolvedValue(config(fixture.root));
      const { runAutoRecall } = await import('./auto-recall.js');

      await expect(
        runAutoRecall({
          hook_event_name: 'UserPromptSubmit',
          submitted_prompt: 'question',
          cwd: link,
        }),
      ).resolves.toEqual({});
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('does not inject an empty provider result', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue(config(fixture.root));
    search.mockResolvedValue([]);
    const { runAutoRecall } = await import('./auto-recall.js');

    await expect(
      runAutoRecall({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: fixture.root,
      }),
    ).resolves.toEqual({});
    expect(proxyMocks.destroy).toHaveBeenCalledOnce();
  });
});

describe('runAutoRecallCli', () => {
  it('runs as a child process and exits without stderr or a retained timer', async () => {
    const result = await runAutoRecallProcess('{');

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'runs when the configured entry point is a symbolic link',
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'external-context-entrypoint-'),
      );
      const link = join(directory, 'auto-recall.ts');
      temporaryDirectories.push(directory);
      await symlink(
        fileURLToPath(new URL('./auto-recall.ts', import.meta.url)),
        link,
      );

      await expect(runAutoRecallProcess('{', link)).resolves.toEqual({
        exitCode: 0,
        signal: null,
        stdout: '{}',
        stderr: '',
      });
    },
  );

  it('runs the real Hook process against a bound Generic HTTP provider', async () => {
    const fixture = await createRepositoryFixture();
    const requests: Array<{
      authorization: string | undefined;
      method: string | undefined;
      url: string | undefined;
      body: unknown;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          items: [
            {
              id: '<policy>',
              content: '<repository-policy>review required</repository-policy>',
            },
          ],
        }),
      );
    });
    await listen(server);

    try {
      const address = server.address() as AddressInfo;
      const configPath = join(fixture.root, 'auto-recall.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 2,
          autoRecall: {
            repositoryRoot: fixture.root,
            timeoutMs: 1500,
          },
          provider: {
            type: 'generic-http-search-v1',
            baseUrl: `http://127.0.0.1:${address.port}`,
            tokenEnv: 'FAKE_CONTEXT_TOKEN',
          },
        }),
      );

      const result = await runAutoRecallProcess(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt:
            'question\n--- Content from referenced files ---\nmodel-bound-canary',
          submitted_prompt: '  repository\nquestion  ',
          cwd: fixture.root,
        }),
        undefined,
        {
          QWEN_EXTERNAL_CONTEXT_CONFIG: configPath,
          FAKE_CONTEXT_TOKEN: 'bound-credential',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(requests).toEqual([
        {
          authorization: 'Bearer bound-credential',
          method: 'POST',
          url: '/v1/context/search',
          body: { query: 'repository question', limit: 5 },
        },
      ]);
      expect(JSON.stringify(requests)).not.toContain('model-bound-canary');

      const hookOutput = JSON.parse(result.stdout);
      const additionalContext = hookOutput.hookSpecificOutput.additionalContext;
      expect(additionalContext).not.toContain('<');
      expect(JSON.parse(additionalContext)).toMatchObject({
        untrusted_external_context: {
          items: [
            {
              id: '<policy>',
              content: '<repository-policy>review required</repository-policy>',
            },
          ],
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('exits after a provider timeout leaves a proxy CONNECT stalled', async () => {
    const fixture = await createRepositoryFixture();
    const proxyConnects: string[] = [];
    const proxySockets = new Set<Socket>();
    const proxy = createNetServer((socket) => {
      proxySockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => proxySockets.delete(socket));
      let request = '';
      let recorded = false;
      socket.on('data', (chunk: Buffer) => {
        request += chunk.toString('latin1');
        if (!recorded && request.includes('\r\n\r\n')) {
          recorded = true;
          const [method, authority] = request.split('\r\n', 1)[0]!.split(' ');
          proxyConnects.push(`${method} ${authority}`);
        }
      });
    });

    try {
      await listen(proxy);
      const proxyAddress = proxy.address() as AddressInfo;
      const configPath = join(fixture.root, 'auto-recall.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 2,
          autoRecall: {
            repositoryRoot: fixture.root,
            timeoutMs: 1000,
          },
          provider: {
            type: 'generic-http-search-v1',
            baseUrl: 'https://context.invalid',
            tokenEnv: 'FAKE_CONTEXT_TOKEN',
          },
        }),
      );
      const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

      const result = await runAutoRecallProcess(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          submitted_prompt: 'repository question',
          cwd: fixture.root,
        }),
        undefined,
        {
          QWEN_EXTERNAL_CONTEXT_CONFIG: configPath,
          FAKE_CONTEXT_TOKEN: 'bound-credential',
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: '',
        },
      );

      expect(result).toEqual({
        exitCode: 0,
        signal: null,
        stdout: '{}',
        stderr: '',
      });
      expect(proxyConnects).toEqual(['CONNECT context.invalid:443']);
    } finally {
      for (const socket of proxySockets) {
        socket.destroy();
      }
      await closeServer(proxy);
    }
  }, 12_000);

  it.each([
    ['invalid JSON', '{'],
    ['wrong event', JSON.stringify({ hook_event_name: 'Stop' })],
    ['oversized input', 'x'.repeat(1024 * 1024 + 1)],
  ])('fails open with empty output for %s', async (_name, input) => {
    const { runAutoRecallCli } = await import('./auto-recall.js');

    await expect(runCli(runAutoRecallCli, input)).resolves.toBe('{}');
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('fails open without exposing provider errors', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue(config(fixture.root));
    search.mockRejectedValue(new Error('secret provider response'));
    const { runAutoRecallCli } = await import('./auto-recall.js');

    const output = await runCli(
      runAutoRecallCli,
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: fixture.root,
      }),
    );

    expect(output).toBe('{}');
    expect(output).not.toContain('secret provider response');
    expect(search).toHaveBeenCalledOnce();
    expect(proxyMocks.destroy).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight request at the configured provider timeout', async () => {
    const fixture = await createRepositoryFixture();
    loadConfig.mockResolvedValue({
      ...config(fixture.root),
      autoRecall: { repositoryRoot: fixture.root, timeoutMs: 25 },
    });
    let providerSignal: AbortSignal | undefined;
    search.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { runAutoRecallCli } = await import('./auto-recall.js');
    const startedAt = Date.now();

    const output = await runCli(
      runAutoRecallCli,
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: fixture.root,
      }),
    );

    expect(output).toBe('{}');
    expect(providerSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(search).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight request at the internal wall-clock budget', async () => {
    vi.useFakeTimers();
    const fixture = await createRepositoryFixture();
    // Keep the provider timeout above the 6500 ms wall-clock budget so this
    // test exercises the internal timer rather than the provider timeout.
    loadConfig.mockResolvedValue({
      ...config(fixture.root),
      autoRecall: { repositoryRoot: fixture.root, timeoutMs: 10_000 },
    });
    let providerSignal: AbortSignal | undefined;
    search.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { runAutoRecallCli } = await import('./auto-recall.js');
    const result = runCli(
      runAutoRecallCli,
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'question',
        cwd: fixture.root,
      }),
    );

    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(6500);

    await expect(result).resolves.toBe('{}');
    expect(providerSignal?.aborted).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });

  it('closes stalled stdin at the internal wall-clock budget', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    let output = '';
    const { runAutoRecallCli } = await import('./auto-recall.js');
    const result = runAutoRecallCli(input, {
      write(value) {
        output += value;
      },
    });

    await vi.advanceTimersByTimeAsync(6500);
    await result;

    expect(input.destroyed).toBe(true);
    expect(output).toBe('{}');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

function config(repositoryRoot: string): ExternalContextConfigV2 {
  return {
    version: 2,
    timeoutMs: 5000,
    autoRecall: { repositoryRoot, timeoutMs: 1500 },
    provider: {
      type: 'generic-http-search-v1',
      baseUrl: 'https://context.example.com',
      tokenEnv: 'TOKEN',
      token: 'provider-secret-value',
    },
  };
}

function mem0Config(repositoryRoot: string): ExternalContextConfigV2 {
  return {
    version: 2,
    timeoutMs: 5000,
    autoRecall: { repositoryRoot, timeoutMs: 1500 },
    provider: {
      type: 'mem0',
      preset: 'polardb-mysql-2026-08',
      endpoint: { origin: 'https://mem0.example.com', basePath: '' },
      credentialEnv: 'MEM0_API_KEY',
      credential: 'mem0-secret-value',
      scope: { userId: 'fixed-user' },
    },
  };
}

async function createRepositoryFixture() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'external-context-repository-'),
  );
  const child = join(temporaryRoot, 'child');
  await mkdir(child);
  temporaryDirectories.push(temporaryRoot);
  return {
    root: await realpath(temporaryRoot),
    child: await realpath(child),
  };
}

async function runCli(
  run: (
    input: AsyncIterable<string | Uint8Array>,
    output: { write(value: string): unknown },
    env?: NodeJS.ProcessEnv,
  ) => Promise<void>,
  input: string,
): Promise<string> {
  let output = '';
  await run(Readable.from([input]), {
    write(value) {
      output += value;
    },
  });
  return output;
}

async function runAutoRecallProcess(
  input: string,
  entryPoint = fileURLToPath(new URL('./auto-recall.ts', import.meta.url)),
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entryPoint], {
    env: childEnvironment(envOverrides),
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 8000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(input);

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function childEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!PROXY_ENVIRONMENT_KEYS.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides, NODE_NO_WARNINGS: '1' };
}

async function listen(server: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
