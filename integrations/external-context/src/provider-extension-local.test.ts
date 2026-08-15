/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeQuery,
  outputSchema,
  renderResult,
} from '../examples/provider-extension-local/src/profile.js';
import { searchProvider } from '../examples/provider-extension-local/src/provider.js';

const execFileAsync = promisify(execFile);
const packageRoot = new URL('..', import.meta.url);
const exampleRoot = new URL(
  '../examples/provider-extension-local/',
  import.meta.url,
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local provider extension example', () => {
  it('normalizes and bounds provider-independent queries', () => {
    expect(normalizeQuery('  deployment\npolicy  ')).toBe('deployment policy');
    expect(() => normalizeQuery('   ')).toThrow(
      'Search query must not be empty.',
    );
    expect(() => normalizeQuery('x'.repeat(2001))).toThrow(
      'Search query is too long.',
    );
  });

  it('renders bounded contract-valid output with matching representations', () => {
    const result = renderResult([
      { id: '', content: 'missing id' },
      { id: 'missing-content', content: '' },
      {
        id: '<valid>',
        content: '<untrusted>'.repeat(500),
        score: Number.POSITIVE_INFINITY,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `item-${index}`,
        content: 'x'.repeat(1500),
      })),
    ]);

    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(result.text).not.toContain('<');
    expect(result.text).not.toContain('>');
    expect(JSON.parse(result.text)).toEqual(result.structuredContent);
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
    const envelope = result.structuredContent['untrusted_external_context'] as {
      items: Array<{ id: string; score?: number }>;
    };
    expect(envelope.items[0]).toEqual(
      expect.objectContaining({ id: '<valid>' }),
    );
    expect(envelope.items[0]).not.toHaveProperty('score');

    const capped = renderResult(
      Array.from({ length: 8 }, (_, index) => ({
        id: `item-${index}`,
        content: 'content',
      })),
    );
    const cappedEnvelope = capped.structuredContent[
      'untrusted_external_context'
    ] as { items: unknown[] };
    expect(cappedEnvelope.items).toHaveLength(5);
  });

  it('uses one guarded request and accepts only valid provider items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { id: 'one', content: 'context', score: 0.9 },
            { id: 'blank', content: '' },
            { id: 'non-finite', content: 'context', score: 'Infinity' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    await expect(
      searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
    ).resolves.toEqual([
      { id: 'one', content: 'context', score: 0.9 },
      { id: 'non-finite', content: 'context' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/v1/context/search'),
      expect.objectContaining({
        body: JSON.stringify({ query: 'policy', limit: 5 }),
        redirect: 'manual',
      }),
    );
  });

  it('rejects redirects without exposing provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/collect' },
        }),
      ),
    );
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', 'https://provider.example');
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    await expect(
      searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow('Provider request failed.');
  });

  it('packs the executable referenced by the example manifest', async () => {
    const npmCli = process.env['npm_execpath'];
    if (!npmCli) throw new Error('npm executable is unavailable.');
    await execFileAsync(process.execPath, [npmCli, 'run', 'build'], {
      cwd: exampleRoot,
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: packageRoot },
    );
    const packs = JSON.parse(stdout) as Array<{
      files: Array<{ path: string }>;
    }>;

    expect(packs).toHaveLength(1);
    expect(packs[0]?.files.map((file) => file.path)).toContain(
      'examples/provider-extension-local/dist/main.js',
    );

    const manifest = JSON.parse(
      await readFile(new URL('qwen-extension.json', exampleRoot), 'utf8'),
    ) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(manifest.mcpServers['provider-context-local-example']?.args).toEqual(
      ['${extensionPath}${/}dist${/}main.js'],
    );
  }, 30_000);
});
