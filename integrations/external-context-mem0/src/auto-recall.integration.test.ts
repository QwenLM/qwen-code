/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const hookBundle = new URL('../dist/auto-recall.js', import.meta.url);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Mem0 Auto Recall local provider', () => {
  it('runs the real entry point and fails open without stderr', async () => {
    await expect(runAutoRecallProcess('{')).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
    });

    await expect(
      runAutoRecallProcess(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          submitted_prompt: 'question',
          cwd: process.cwd(),
        }),
        {
          QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG:
            '/missing/administrator/instance.json',
        },
      ),
    ).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
    });
  }, 20000);

  it('executes the v3 configuration, dialect, request engine, and Hook envelope', async () => {
    const requests: Array<{
      authorization: string | undefined;
      body: unknown;
      path: string | undefined;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        path: request.url,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [
            { id: 'memory-1', memory: 'Use the bounded request engine.' },
          ],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const { directory, env } = await makeRuntime(`http://127.0.0.1:${port}`);

    const result = await runAutoRecallProcess(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'expanded prompt must not leave the process',
        submitted_prompt: 'deployment policy API_KEY=remove-me',
        cwd: directory,
      }),
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(requests).toEqual([
      {
        authorization: 'Token runtime-token',
        path: '/v2/memories/search/',
        body: {
          query: 'deployment policy',
          filters: { user_id: 'repository-memory' },
          limit: 5,
        },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain(
      'expanded prompt must not leave the process',
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining(
          'Use the bounded request engine.',
        ),
      },
    });
  }, 10000);

  it('exits successfully after a provider timeout during a stalled TLS handshake', async () => {
    let connected = false;
    const server = createTcpServer((socket) => {
      connected = true;
      sockets.push(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const { directory, env } = await makeRuntime(`https://127.0.0.1:${port}`);

    const startedAt = performance.now();
    const result = await runAutoRecallProcess(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        submitted_prompt: 'deployment policy',
        cwd: directory,
      }),
      env,
    );

    expect(connected).toBe(true);
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
    });
    expect(performance.now() - startedAt).toBeLessThan(5000);
  }, 10000);

  it.each(['token', 'api_key', 'password', 'secret'])(
    'bounds repeated %s near misses in the bundle with a process deadline',
    (keyword) => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
        import { createAutoRecallQuery } from ${JSON.stringify(hookBundle.href)};
        const startedAt = performance.now();
        const query = createAutoRecallQuery(${JSON.stringify(keyword)}.repeat(Math.floor(4096 / ${keyword.length})), '');
        process.stdout.write(JSON.stringify({ query: query ?? null, elapsedMs: performance.now() - startedAt }));
      `,
        ],
        { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      const output = JSON.parse(result.stdout) as {
        query: string | null;
        elapsedMs: number;
      };
      expect(output.query).toBeNull();
      expect(output.elapsedMs).toBeLessThan(2000);
      expect(result.stderr).toBe('');
    },
    10000,
  );

  it.skipIf(process.platform === 'win32').each(['instance', 'dialect'])(
    'rejects a stalled %s FIFO and exits successfully',
    async (kind) => {
      const { directory, env } = await makeRuntime(
        'https://memory.example.com',
      );
      const fifo = join(directory, 'blocked.json');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      if (kind === 'instance') {
        env.QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG = fifo;
      } else {
        const configPath = env.QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG;
        const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
          string,
          unknown
        >;
        await writeFile(
          configPath,
          JSON.stringify({ ...config, dialectPath: fifo }),
        );
      }

      const startedAt = performance.now();
      const result = await runAutoRecallProcess(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          submitted_prompt: 'deployment policy',
          cwd: directory,
        }),
        env,
      );

      expect(result).toEqual({
        exitCode: 0,
        signal: null,
        stdout: '{}',
        stderr: '',
      });
      expect(performance.now() - startedAt).toBeLessThan(5000);
    },
    10000,
  );
});

async function runAutoRecallProcess(
  input: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const env = { ...process.env };
  delete env['QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG'];
  const child = spawn(process.execPath, [fileURLToPath(hookBundle)], {
    env: { ...env, ...envOverrides, NODE_NO_WARNINGS: '1' },
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

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-mem0-auto-e2e-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeRuntime(origin: string) {
  const directory = await makeTemporaryDirectory();
  const dialectPath = join(directory, 'dialect.json');
  const configPath = join(directory, 'instance.json');
  await writeFile(
    dialectPath,
    JSON.stringify({
      dialectVersion: 1,
      id: 'synthetic-auto-recall-v1',
      auth: 'authorization-token',
      search: {
        method: 'POST',
        path: '/v2/memories/search/',
        queryLocation: 'json',
        userIdLocation: 'json.filters',
        agentIdLocation: 'omit',
        appIdLocation: 'omit',
        limitField: 'limit',
      },
      response: {
        collection: 'results',
        idField: 'id',
        contentField: 'memory',
        titleField: 'omit',
        uriField: 'omit',
        scoreField: 'omit',
        updatedAtField: 'omit',
      },
    }),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 3,
      autoRecall: { repositoryRoot: directory },
      dialectPath,
      endpoint: {
        origin,
        basePath: '',
        allowInsecureHttp: origin.startsWith('http:'),
      },
      credentialEnv: 'SYNTHETIC_MEMORY_TOKEN',
      scope: { userId: 'repository-memory' },
      timeoutMs: 1500,
    }),
  );

  return {
    directory,
    env: {
      QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
      SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
    },
  };
}
