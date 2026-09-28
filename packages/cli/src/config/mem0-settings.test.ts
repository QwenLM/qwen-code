/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundledMem0Server, bundledMem0Hooks } from './mem0-settings.js';
import { resolveHookSettingsForConfig } from './hook-settings.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      path.replaceAll('\\', '/').endsWith('/mem0/main.js') ||
      actual.existsSync(path),
  };
});
vi.mock('@qwen-code/qwen-code-core/utils/bundlePaths.js', () => ({
  resolveBundleDir: () => process.cwd(),
}));

afterEach(() => vi.unstubAllEnvs());

describe('bundled Mem0 settings', () => {
  it('generates a read-only scoped MCP without serializing credentials', () => {
    vi.stubEnv('MEM0_API_KEY', 'must-not-be-serialized');
    const server = createBundledMem0Server(
      { baseUrl: 'https://mem0.example/proxy/' },
      process.cwd(),
    );
    const config = JSON.parse(server.env!['QWEN_BUNDLED_MEM0_CONFIG']);
    expect(server.args).toEqual([join(process.cwd(), 'mem0', 'main.js')]);
    expect(server.includeTools).toEqual(['context_search']);
    expect(server.trust).toBe(false);
    expect(config.provider).toEqual({
      type: 'mem0',
      preset: 'mem0-v2',
      credentialEnv: 'MEM0_API_KEY',
      endpoint: {
        origin: 'https://mem0.example',
        basePath: '/proxy',
        allowInsecureHttp: false,
      },
      scope: { userId: expect.stringMatching(/^qwen-[a-f0-9]{32}$/u) },
    });
    expect(config.write).toBeUndefined();
    expect(JSON.stringify(server)).not.toContain('must-not-be-serialized');
    expect(bundledMem0Hooks(server)).toBeUndefined();
    expect(
      createBundledMem0Server(
        { baseUrl: 'https://other.example' },
        process.cwd(),
      ).env,
    ).toEqual(
      expect.objectContaining({
        QWEN_BUNDLED_MEM0_CONFIG: expect.stringContaining(
          config.provider.scope.userId,
        ),
      }),
    );
  });

  it.each([
    { envKey: 'POLARDB_MEM0_TOKEN' },
    { credentialEnv: 'POLARDB_MEM0_TOKEN' },
    {
      envKey: 'POLARDB_MEM0_TOKEN',
      credentialEnv: 'POLARDB_MEM0_TOKEN',
    },
  ])(
    'uses the selected credential reference without serializing its value: %j',
    (credential) => {
      vi.stubEnv('POLARDB_MEM0_TOKEN', 'must-not-be-serialized');
      const server = createBundledMem0Server(
        { baseUrl: 'https://mem0.example', ...credential },
        process.cwd(),
      );
      expect(
        JSON.parse(server.env!['QWEN_BUNDLED_MEM0_CONFIG']).provider
          .credentialEnv,
      ).toBe('POLARDB_MEM0_TOKEN');
      expect(JSON.stringify(server)).not.toContain('must-not-be-serialized');
    },
  );

  it('rejects conflicting credential references instead of silently choosing a key', () => {
    expect(() =>
      createBundledMem0Server(
        {
          baseUrl: 'https://mem0.example',
          envKey: 'POLARDB_MEM0_TOKEN',
          credentialEnv: 'OTHER_MEM0_TOKEN',
        },
        process.cwd(),
      ),
    ).toThrow('memory.mem0.envKey and credentialEnv must match');
  });

  it('binds Platform V3 app scope and keeps exact-content confirmation on hook reload', () => {
    const server = createBundledMem0Server(
      {
        baseUrl: 'https://api.mem0.ai',
        protocol: 'mem0-v3',
        scope: { appId: 'chosen-app' },
        enableWrites: true,
      },
      process.cwd(),
    );
    expect(
      JSON.parse(server.env!['QWEN_BUNDLED_MEM0_CONFIG']).provider.scope,
    ).toEqual({ appId: 'chosen-app' });
    expect(server.includeTools).toEqual(['context_search', 'context_remember']);
    const existing = { PreToolUse: [{ matcher: 'other-tool', hooks: [] }] };
    const hooks = resolveHookSettingsForConfig(
      undefined,
      { systemHooks: existing },
      false,
      server,
    );
    expect(hooks.systemHooks?.['PreToolUse']).toEqual([
      ...existing.PreToolUse,
      expect.objectContaining({
        matcher: 'mcp__external-context__context_remember',
        hooks: [
          expect.objectContaining({
            name: 'bundled-mem0-write-confirmation',
            command: expect.stringContaining('write-confirmation.js'),
          }),
        ],
      }),
    ]);
    expect(
      resolveHookSettingsForConfig(undefined, undefined, true, server).hooks,
    ).toBeUndefined();
    const readOnly = createBundledMem0Server(
      { baseUrl: 'https://mem0.example', enableWrites: true },
      process.cwd(),
      false,
    );
    expect(readOnly.includeTools).toEqual(['context_search']);
    expect(
      JSON.parse(readOnly.env!['QWEN_BUNDLED_MEM0_CONFIG']).write,
    ).toBeUndefined();
    expect(bundledMem0Hooks(readOnly)).toBeUndefined();
  });

  it.each([
    { baseUrl: 'http://mem0.example' },
    { baseUrl: 'https://mem0.example/proxy%20prefix' },
    { baseUrl: 'https://mem0.example/proxy//prefix' },
    { baseUrl: 'https://secret@mem0.example' },
    { baseUrl: 'https://mem0.example?key=secret' },
    { baseUrl: 'https://mem0.example', protocol: 'mem0-v4' },
    { baseUrl: 'https://mem0.example', envKey: 'KEY=bad' },
    { baseUrl: 'https://mem0.example', envKey: 'QWEN_SERVER_TOKEN' },
    { baseUrl: 'https://mem0.example', credentialEnv: 'KEY=bad' },
    {
      baseUrl: 'https://mem0.example',
      credentialEnv: 'QWEN_BUNDLED_MEM0_CONFIG',
    },
    { baseUrl: 'https://mem0.example', credentialEnv: 'QWEN_SERVER_TOKEN' },
    {
      baseUrl: 'https://mem0.example',
      protocol: 'mem0-v3',
      scope: { userId: 'wrong-field' },
    },
    { baseUrl: 'https://mem0.example', scope: { appId: 'wrong-field' } },
  ])('rejects unsupported or unsafe configuration %j', (settings) => {
    expect(() => createBundledMem0Server(settings, process.cwd())).toThrow();
  });

  it('allows explicit plain HTTP for a trusted PolarDB endpoint', () => {
    const server = createBundledMem0Server(
      {
        baseUrl: 'http://polardb.example:8080',
        allowInsecureHttp: true,
        scope: { userId: 'chosen-user', agentId: 'chosen-agent' },
      },
      process.cwd(),
    );
    expect(
      JSON.parse(server.env!['QWEN_BUNDLED_MEM0_CONFIG']).provider.scope,
    ).toEqual({ userId: 'chosen-user', agentId: 'chosen-agent' });
  });

  it.each(['project', undefined] as const)(
    'does not turn a lookalike MCP server into a bundled system hook: %s',
    (scope) => {
      const server = createBundledMem0Server(
        { baseUrl: 'https://mem0.example', enableWrites: true },
        process.cwd(),
      );
      expect(
        bundledMem0Hooks({ ...server, args: ['/repo/shim/loader.js'], scope }),
      ).toBeUndefined();
    },
  );

  it('identifies the invalid settings field', () => {
    expect(() =>
      createBundledMem0Server(
        { baseUrl: 'https://mem0.example', timeoutMs: 30001 },
        process.cwd(),
      ),
    ).toThrow('memory.mem0 is invalid: timeoutMs:');
  });

  it('uses the same default scope from the repository root and its subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'qwen-mem0-scope-'));
    try {
      mkdirSync(join(root, '.git'));
      mkdirSync(join(root, 'subdir'));
      const scope = (cwd: string) =>
        JSON.parse(
          createBundledMem0Server(
            {
              baseUrl: 'https://mem0.example',
            },
            cwd,
          ).env!['QWEN_BUNDLED_MEM0_CONFIG'],
        ).provider.scope;
      expect(scope(root)).toEqual(scope(join(root, 'subdir')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
