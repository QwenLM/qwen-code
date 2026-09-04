/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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
  });

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
          origin: `http://127.0.0.1:${port}`,
          basePath: '',
          allowInsecureHttp: true,
        },
        credentialEnv: 'SYNTHETIC_MEMORY_TOKEN',
        scope: { userId: 'repository-memory' },
        timeoutMs: 1500,
      }),
    );

    const result = await runAutoRecallProcess(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'expanded prompt must not leave the process',
        submitted_prompt: 'deployment policy API_KEY=remove-me',
        cwd: directory,
      }),
      {
        QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG: configPath,
        SYNTHETIC_MEMORY_TOKEN: 'runtime-token',
      },
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
  });
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
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      fileURLToPath(new URL('./auto-recall.ts', import.meta.url)),
    ],
    {
      env: { ...env, ...envOverrides, NODE_NO_WARNINGS: '1' },
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
    },
  );
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
