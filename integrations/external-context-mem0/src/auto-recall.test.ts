/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadAutoRecallRuntimeConfiguration = vi.hoisted(() => vi.fn());
const isWithinRepository = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
const createRequestEngine = vi.hoisted(() => vi.fn(() => search));

vi.mock('./config.js', () => ({
  loadAutoRecallRuntimeConfiguration,
  isWithinRepository,
}));
vi.mock('./request-engine.js', () => ({ createRequestEngine }));

beforeEach(() => {
  loadAutoRecallRuntimeConfiguration.mockReset().mockResolvedValue(runtime());
  isWithinRepository.mockReset().mockResolvedValue(true);
  search.mockReset();
  createRequestEngine.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAutoRecallQuery', () => {
  it('removes code and common credential shapes', async () => {
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

  it('keeps benign prose and limits output to 512 Unicode code points', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    expect(
      createAutoRecallQuery(
        'readme: token refresh flow, where is it documented?',
        '',
      ),
    ).toBe('readme: token refresh flow, where is it documented?');
    expect(createAutoRecallQuery('🙂'.repeat(513), '')).toBe('🙂'.repeat(512));
    expect(
      createAutoRecallQuery('```text\nonly code\n```', ''),
    ).toBeUndefined();
  });

  it.each([
    'my_api_key_suffix=remove-me',
    '"service.token": "remove me"',
    "'db.password' = 'remove me'",
    'client-secret: remove-me',
    'config: token=remove-me',
  ])('removes secret assignments in %s', async (assignment) => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');

    const query = createAutoRecallQuery(`deployment ${assignment}`, '');

    expect(query).not.toContain('remove');
    expect(query).toContain('deployment');
  });

  it('bounds sanitizer work before applying credential patterns', async () => {
    const { createAutoRecallQuery } = await import('./auto-recall.js');
    const startedAt = Date.now();
    const query = createAutoRecallQuery('a-'.repeat(25_000), 'secret');

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(query ?? '').not.toContain('a-a');
  });
});

describe('runAutoRecall', () => {
  it('retrieves once from submitted prompt provenance', async () => {
    search.mockResolvedValue([
      { id: '<one>', content: '<policy>repository</policy>' },
    ]);
    const { runAutoRecall } = await import('./auto-recall.js');

    const output = await runAutoRecall({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'expanded prompt that must be ignored',
      submitted_prompt: '  deployment\npolicy  ',
      cwd: '/repository/child',
    });

    expect(loadAutoRecallRuntimeConfiguration).toHaveBeenCalledOnce();
    expect(isWithinRepository).toHaveBeenCalledWith(
      '/repository',
      '/repository/child',
    );
    expect(createRequestEngine).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith({
      query: 'deployment policy',
      signal: expect.any(AbortSignal),
    });
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
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

  it('does not inspect the expanded prompt field', async () => {
    search.mockResolvedValue([]);
    const { runAutoRecall } = await import('./auto-recall.js');
    const input = {
      hook_event_name: 'UserPromptSubmit',
      submitted_prompt: 'question',
      cwd: '/repository',
    };
    Object.defineProperty(input, 'prompt', {
      get() {
        throw new Error('expanded prompt was read');
      },
    });

    await expect(runAutoRecall(input)).resolves.toEqual({});
    expect(search).toHaveBeenCalledWith({
      query: 'question',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    {},
    { hook_event_name: 'ToolResult', submitted_prompt: 'question', cwd: '/' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'expanded', cwd: '/' },
    {
      hook_event_name: 'UserPromptSubmit',
      submitted_prompt: '   ',
      cwd: '/',
    },
  ])('skips unsupported input before loading configuration', async (input) => {
    const { runAutoRecall } = await import('./auto-recall.js');

    await expect(runAutoRecall(input)).resolves.toEqual({});
    expect(loadAutoRecallRuntimeConfiguration).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('skips a working directory outside the configured repository', async () => {
    isWithinRepository.mockResolvedValue(false);
    const { runAutoRecall } = await import('./auto-recall.js');

    await expect(runAutoRecall(validInput())).resolves.toEqual({});
    expect(createRequestEngine).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('returns no context for an empty provider result', async () => {
    search.mockResolvedValue([]);
    const { runAutoRecall } = await import('./auto-recall.js');

    await expect(runAutoRecall(validInput())).resolves.toEqual({});
    expect(search).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight request at the configured provider timeout', async () => {
    loadAutoRecallRuntimeConfiguration.mockResolvedValue({
      ...runtime(),
      instance: { ...runtime().instance, timeoutMs: 100 },
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

    await expect(
      captureCli(runAutoRecallCli, JSON.stringify(validInput())),
    ).resolves.toBe('{}');
    expect(providerSignal?.aborted).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });
});

describe('runAutoRecallCli', () => {
  it('fails open for malformed input and configuration failures', async () => {
    const { runAutoRecallCli } = await import('./auto-recall.js');
    const malformed = await captureCli(runAutoRecallCli, '{');
    expect(malformed).toBe('{}');
    expect(loadAutoRecallRuntimeConfiguration).not.toHaveBeenCalled();

    loadAutoRecallRuntimeConfiguration.mockRejectedValue(
      new Error('/secret/path token=secret'),
    );
    const failed = await captureCli(
      runAutoRecallCli,
      JSON.stringify(validInput()),
    );
    expect(failed).toBe('{}');
  });

  it('accepts exactly 1 MiB and rejects one additional byte before configuration', async () => {
    const { runAutoRecallCli } = await import('./auto-recall.js');
    search.mockResolvedValue([]);
    const baseInput = JSON.stringify({ ...validInput(), padding: '' });
    const exactInput = JSON.stringify({
      ...validInput(),
      padding: 'x'.repeat(1024 * 1024 - Buffer.byteLength(baseInput)),
    });

    expect(Buffer.byteLength(exactInput)).toBe(1024 * 1024);
    await expect(captureCli(runAutoRecallCli, exactInput)).resolves.toBe('{}');
    expect(loadAutoRecallRuntimeConfiguration).toHaveBeenCalledOnce();
    loadAutoRecallRuntimeConfiguration.mockClear();

    const oversized = `${exactInput} `;
    expect(Buffer.byteLength(oversized)).toBe(1024 * 1024 + 1);
    await expect(captureCli(runAutoRecallCli, oversized)).resolves.toBe('{}');

    expect(loadAutoRecallRuntimeConfiguration).not.toHaveBeenCalled();
  });

  it('returns within the internal wall-clock budget', async () => {
    vi.useFakeTimers();
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
    const output = { value: '' };
    const work = runAutoRecallCli(
      Readable.from([JSON.stringify(validInput())]),
      { write: (value) => (output.value += value) },
      {},
    );
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(6500);
    await work;

    expect(output.value).toBe('{}');
    expect(providerSignal?.aborted).toBe(true);
  });

  it('closes stalled input at the internal wall-clock budget', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = { value: '' };
    const { runAutoRecallCli } = await import('./auto-recall.js');
    const work = runAutoRecallCli(input, {
      write: (value) => (output.value += value),
    });

    await vi.advanceTimersByTimeAsync(6500);
    await work;

    expect(input.destroyed).toBe(true);
    expect(output.value).toBe('{}');
    expect(loadAutoRecallRuntimeConfiguration).not.toHaveBeenCalled();
  });
});

function runtime() {
  return {
    instance: {
      schemaVersion: 3,
      autoRecall: { repositoryRoot: '/repository' },
      dialectPath: '/dialect.json',
      endpoint: {
        origin: 'https://memory.example.com',
        basePath: '',
        allowInsecureHttp: false,
      },
      credentialEnv: 'MEMORY_TOKEN',
      scope: { userId: 'repository-memory' },
      timeoutMs: 1500,
    },
    dialect: {},
    credential: 'provider-secret-value',
  };
}

function validInput() {
  return {
    hook_event_name: 'UserPromptSubmit',
    submitted_prompt: 'question',
    cwd: '/repository',
  };
}

async function captureCli(
  run: (
    input: Readable,
    output: { write(value: string): unknown },
    env: NodeJS.ProcessEnv,
  ) => Promise<void>,
  input: string,
): Promise<string> {
  let output = '';
  await run(
    Readable.from([input]),
    { write: (value) => (output += value) },
    {},
  );
  return output;
}
