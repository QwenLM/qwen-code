/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as http from 'node:http';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Storage } from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { FsError } from '../fs/index.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  registerWorkspaceArtifactPublishRoutes,
  registerWorkspaceQualifiedArtifactPublishRoutes,
  resetArtifactNetlifySetupStateForTesting,
  type ArtifactRouteCommandRunner,
} from './workspace-artifact-publish.js';

type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;

const mocked = vi.hoisted(() => ({
  hostPublish: vi.fn(),
  hostConstructors: [] as Array<{ config: unknown; run: CommandRunner }>,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    HostPublisher: class {
      constructor(config: unknown, run: CommandRunner) {
        mocked.hostConstructors.push({ config, run });
      }
      publish = mocked.hostPublish;
    },
  };
});

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: vi.fn() };
});

const HTML = '<!doctype html><h1>report</h1>';
const NETLIFY_HOST = {
  uploadCommand:
    'netlify deploy --dir {dir} --json --no-build --prod --site site-id',
  urlFromCommandOutput: true,
};
const TEST_ARTIFACT_NPM_CACHE = path.join(
  Storage.getGlobalQwenDir(),
  'artifact-hosting',
  'npm-cache',
);
const TEST_ARTIFACT_TOOL_PREFIX = path.join(
  Storage.getGlobalQwenDir(),
  'artifact-hosting',
  'tools',
);
const TEST_GLOBAL_NODE_MODULES = path.join(
  ...(process.platform === 'win32'
    ? ['node_modules']
    : ['lib', 'node_modules']),
);
const TEST_NETLIFY_ENTRY = path.join(
  TEST_ARTIFACT_TOOL_PREFIX,
  TEST_GLOBAL_NODE_MODULES,
  'netlify-cli',
  'bin',
  'run.js',
);
const TEST_WRANGLER_ENTRY = path.join(
  TEST_ARTIFACT_TOOL_PREFIX,
  TEST_GLOBAL_NODE_MODULES,
  'wrangler',
  'bin',
  'wrangler.js',
);
const TEST_VERCEL_ENTRY = path.join(
  TEST_ARTIFACT_TOOL_PREFIX,
  TEST_GLOBAL_NODE_MODULES,
  'vercel',
  'dist',
  'vc.js',
);

const allowMutations = () =>
  ((_req, _res, next) => next()) as express.RequestHandler;

const readyNetlify: ArtifactRouteCommandRunner = vi.fn(
  async (_command, args, options) => {
    if (args[0] === '--version') return '27.1.2';
    if (args[0] === 'api' && args[1] === 'getCurrentUser') {
      return JSON.stringify({ id: 'user-id' });
    }
    if (args[0] === 'api' && args[1] === 'updateSite') return '{}';
    if (args[0] === 'api' && args[1] === 'getSite') {
      return JSON.stringify({
        id: 'site-id',
        name: 'Report site',
        sso_login: false,
        has_password: false,
      });
    }
    if (args[0] === 'status') {
      return JSON.stringify({
        siteData: { id: 'site-id', name: 'Report site' },
      });
    }
    if (args[0] === 'sites:list') return '[]';
    if (args[0] === 'deploy') {
      return `${options.cwd}|${options.env['WORKSPACE_SHARE_TOKEN'] ?? ''}`;
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  },
);

const readyCloudflare: ArtifactRouteCommandRunner = vi.fn(
  async (command, args) => {
    if (command !== 'wrangler') throw new Error('provider unavailable');
    if (args[0] === '--version') return '4.125.0';
    if (args[0] === 'pages' && args[2] === 'list') {
      return JSON.stringify([
        {
          'Project Name': 'artifact-pages',
          'Project Domains': 'artifact-pages.pages.dev',
        },
      ]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  },
);

function commandArgsAfter(
  args: string[],
  suffix: string,
): string[] | undefined {
  const index = args.findIndex((arg) =>
    arg.replaceAll('\\', '/').endsWith(suffix),
  );
  return index < 0 ? undefined : args.slice(index + 1);
}

function adaptTestRunner(
  run: ArtifactRouteCommandRunner,
): ArtifactRouteCommandRunner {
  return async (command, args, options) => {
    const npmArgs = commandArgsAfter(args, '/npm-cli.js');
    if (npmArgs) return run('/qwen-test/npm', npmArgs, options);
    const netlifyArgs = commandArgsAfter(
      args,
      '/node_modules/netlify-cli/bin/run.js',
    );
    if (netlifyArgs) return run('netlify', netlifyArgs, options);
    const wranglerArgs = commandArgsAfter(
      args,
      '/node_modules/wrangler/bin/wrangler.js',
    );
    if (wranglerArgs) return run('wrangler', wranglerArgs, options);
    const vercelArgs = commandArgsAfter(
      args,
      '/node_modules/vercel/dist/vc.js',
    );
    return vercelArgs
      ? run('vercel', vercelArgs, options)
      : run(command, args, options);
  };
}

function windowReader(html: string, sizeOverride?: number) {
  const buffer = Buffer.from(html, 'utf8');
  const sizeBytes = sizeOverride ?? buffer.length;
  return vi.fn(
    async (_path: unknown, opts: { offset: number; maxBytes: number }) => {
      const slice = buffer.subarray(opts.offset, opts.offset + opts.maxBytes);
      return {
        buffer: slice,
        sizeBytes,
        returnedBytes: slice.length,
        offset: opts.offset,
        truncated: false,
      };
    },
  );
}

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  options: {
    primary?: boolean;
    trusted?: boolean;
    env?: Readonly<NodeJS.ProcessEnv>;
    envMode?: 'parent-process' | 'runtime-overlay';
    readBytesWindow?: ReturnType<typeof windowReader>;
    generationGuard?: WorkspaceGenerationGuard;
  } = {},
): WorkspaceRuntime {
  const readBytesWindow = options.readBytesWindow ?? windowReader(HTML);
  return {
    workspaceId,
    workspaceCwd,
    primary: options.primary ?? false,
    trusted: options.trusted ?? true,
    env: {
      mode: options.envMode ?? 'runtime-overlay',
      overlayKeys: Object.keys(options.env ?? {}),
      effectiveEnv: options.env ?? {},
    },
    routeFileSystemFactory: {
      forRequest: vi.fn(() => ({
        resolve: vi.fn(
          async (filePath: string) => `${workspaceCwd}/${filePath}`,
        ),
        readBytesWindow,
      })),
    },
    generationGuard: options.generationGuard,
  } as unknown as WorkspaceRuntime;
}

function mockSettings(
  settingsByWorkspace: Record<string, Record<string, unknown>>,
): void {
  vi.mocked(loadSettings).mockImplementation(
    (workspaceCwd) =>
      ({
        merged: { artifact: settingsByWorkspace[workspaceCwd ?? ''] ?? {} },
        user: { settings: {} },
        workspace: { settings: {} },
        forScope: vi.fn().mockReturnValue({ settings: {} }),
      }) as never,
  );
}

function makePrimaryApp(
  primary: WorkspaceRuntime,
  runCommand: ArtifactRouteCommandRunner = readyNetlify,
  checkPublicUrl: (url: string) => Promise<boolean> = async () => true,
  waitForPublicUrlRetry?: (delayMs: number) => Promise<void>,
  persistSettings: (
    workspace: string,
    writes: Array<{
      scope: SettingScope;
      key: string;
      value: unknown;
    }>,
    assertGenerationOpen?: () => void,
  ) => Promise<void> = async () => undefined,
) {
  const app = express();
  app.use(express.json());
  registerWorkspaceArtifactPublishRoutes(app, {
    getPrimaryRuntime: () => primary,
    sendBridgeError: (res, err) => {
      res.status(500).json({ error: (err as Error).message });
    },
    mutate: allowMutations,
    runCommand: adaptTestRunner(runCommand),
    checkPublicUrl,
    waitForPublicUrlRetry,
    persistSettings,
  });
  return app;
}

function setArtifactSetting(
  artifact: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const segments = key.replace(/^artifact\./, '').split('.');
  let parent = artifact;
  for (const segment of segments.slice(0, -1)) {
    const current = parent[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      parent[segment] = {};
    }
    parent = parent[segment] as Record<string, unknown>;
  }
  parent[segments.at(-1)!] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.hostConstructors.length = 0;
  mocked.hostPublish.mockResolvedValue({
    id: 'host-id',
    url: 'https://preview.example.com/report',
  });
  mockSettings({});
  resetArtifactNetlifySetupStateForTesting();
});

describe('GET /workspace/artifact/publish-config', () => {
  it('reports Netlify availability without exposing its command', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        oss: {
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          bucket: 'my-bucket',
        },
      },
    });

    const response = await request(makePrimaryApp(primary, readyNetlify)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.providers).toEqual([
      {
        kind: 'cloudflare',
        configured: false,
        unavailableReason: 'cloudflare_auth_required',
      },
      {
        kind: 'vercel',
        configured: false,
        unavailableReason: 'vercel_auth_required',
      },
      { kind: 'netlify', configured: true },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('deploy --dir');
    expect(JSON.stringify(response.body)).not.toContain('my-bucket');
  });

  it('recognizes the command it wrote on a host whose node is not named "node"', async () => {
    // `netlifyUploadCommand` persists `<process.execPath> <entry> deploy ...`,
    // and execPath is whatever runs this daemon — `/usr/bin/node-22`, Debian's
    // `nodejs`, a volta shim. Requiring the basename to be exactly `node` left
    // the daemon unable to re-parse its own command on those hosts.
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: {
          uploadCommand:
            '/usr/bin/node-22 /opt/qwen/node_modules/netlify-cli/bin/run.js deploy --dir {dir} --json --no-build --prod --site site-id',
          urlFromCommandOutput: true,
        },
      },
    });

    const response = await request(makePrimaryApp(primary, readyNetlify)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.providers).toContainEqual({
      kind: 'netlify',
      configured: true,
    });
  });

  it('stays configured when the Netlify API cannot be reached', async () => {
    // `readSiteRecord` used to collapse a transient API failure into the same
    // `undefined` it returns for "no such site", so a ready workspace fell
    // back to the never-configured `connect` stage on every blip — and
    // `connectSite` then treated its configured site as non-dedicated.
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: { netlify: { siteId: 'site-id' } },
      },
    });
    const flakyNetlify: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          throw new Error('ETIMEDOUT');
        }
        if (args[0] === 'status') throw new Error('not linked');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, flakyNetlify)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.providers).toContainEqual({
      kind: 'netlify',
      configured: true,
    });
  });

  it('accepts a configured Netlify site named by a non-canonical identifier', async () => {
    // `getSite` was asked for exactly this identifier, so whatever record it
    // returns IS the configured site. Re-comparing ids rejected every form
    // the API resolves other than the canonical one — a site name or a
    // subdomain alias.
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: { netlify: { siteId: 'report-site' } },
      },
    });
    const aliasNetlify: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          // The API resolves the alias and answers with the canonical id.
          return JSON.stringify({ id: 'site-id', name: 'report-site' });
        }
        if (args[0] === 'status') throw new Error('not linked');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, aliasNetlify)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.providers).toContainEqual({
      kind: 'netlify',
      configured: true,
    });
  });

  it('accepts the --dir={dir} Netlify form', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: {
          uploadCommand:
            'netlify deploy --dir={dir} --json --prod --site site-id',
          urlFromCommandOutput: true,
        },
      },
    });

    const response = await request(makePrimaryApp(primary, readyNetlify)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.body.providers).toEqual([
      {
        kind: 'cloudflare',
        configured: false,
        unavailableReason: 'cloudflare_auth_required',
      },
      {
        kind: 'vercel',
        configured: false,
        unavailableReason: 'vercel_auth_required',
      },
      { kind: 'netlify', configured: true },
    ]);
  });

  it.each([
    { host: { uploadCommand: 'deploy {dir}', urlFromCommandOutput: true } },
    {
      host: {
        uploadCommand: 'netlify deploy --dir {dir}',
        urlFromCommandOutput: true,
      },
    },
    {
      host: {
        uploadCommand: 'netlify deploy --dir {dir} --json',
        urlFromCommandOutput: true,
      },
    },
    {
      host: {
        uploadCommand: 'netlify deploy --dir {dir} --json --prod',
        urlFromCommandOutput: true,
      },
    },
    {
      host: {
        uploadCommand: 'netlify deploy --message={dir} --json',
        urlFromCommandOutput: true,
      },
    },
    {
      host: {
        uploadCommand: 'netlify deploy {dir} --json',
        urlFromCommandOutput: true,
      },
    },
    {
      host: {
        uploadCommand:
          'netlify deploy --dir {dir} --dir other-directory --json',
        urlFromCommandOutput: true,
      },
    },
    {
      oss: {
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        bucket: 'my-bucket',
      },
    },
  ])(
    'does not mistake a non-Netlify setup for Netlify %#',
    async (artifact) => {
      const primary = runtime('primary', '/workspace', { primary: true });
      mockSettings({ '/workspace': artifact });

      const response = await request(makePrimaryApp(primary, readyNetlify)).get(
        '/workspace/artifact/publish-config',
      );

      expect(response.body.providers).toEqual([
        {
          kind: 'cloudflare',
          configured: false,
          unavailableReason: 'cloudflare_auth_required',
        },
        {
          kind: 'vercel',
          configured: false,
          unavailableReason: 'vercel_auth_required',
        },
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_not_configured',
        },
      ]);
    },
  );

  it('does not offer existing Netlify projects as artifact targets', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api') return JSON.stringify({ id: 'user-id' });
        if (args[0] === 'status') throw new Error('not linked');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, runCommand)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'connect',
      authenticated: true,
      linked: false,
      sites: [],
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) => args[0] === 'sites:list'),
    ).toBe(false);
  });

  it('returns a retryable JSON error while the primary runtime is transitioning', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const registry = createWorkspaceRegistry([primary]);
    registry.beginReplacement(registry.primaryEntry, 'next');
    const app = express();
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => registry.primary,
      sendBridgeError,
      mutate: allowMutations,
    });

    const response = await request(app).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).toEqual({
      error: 'Workspace runtime is not active.',
      code: 'workspace_runtime_unavailable',
    });
  });

  it('uses only the daemon-resolved Netlify entrypoint', async () => {
    const primary = runtime('primary', '/workspace', {
      primary: true,
      env: {
        PATH: '/workspace/bin',
        NODE_OPTIONS: '--import /workspace/evil.js',
        NETLIFY_AUTH_TOKEN: 'attacker-token',
        NETLIFY_API_URL: 'https://attacker.example',
        NETLIFY_SITE_ID: 'attacker-site',
        CLOUDFLARE_API_TOKEN: 'attacker-token',
        CLOUDFLARE_API_BASE_URL: 'https://attacker.example',
        CF_API_BASE_URL: 'https://attacker.example',
        VERCEL_TOKEN: 'attacker-token',
        XDG_DATA_HOME: '/workspace/.xdg',
      },
    });
    mockSettings({
      '/workspace': {
        host: {
          uploadCommand:
            '/workspace/netlify deploy --dir {dir} --json --no-build',
          urlFromCommandOutput: true,
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        expect(command).toBe(process.execPath);
        expect(args[0]).toBe(TEST_NETLIFY_ENTRY);
        if (args[1] === '--version') return '27.1.2';
        if (args[1] === 'api') throw new Error('not authenticated');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const app = express();
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand,
    });

    const response = await request(app).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.every(([command]) => command === process.execPath),
    ).toBe(true);
    const netlifyCalls = vi
      .mocked(runCommand)
      .mock.calls.filter(([, args]) => args[0] === TEST_NETLIFY_ENTRY);
    expect(netlifyCalls.length).toBeGreaterThan(0);
    for (const [, , options] of netlifyCalls) {
      expect(options.env['PATH']).toBe(process.env['PATH']);
      expect(options.env['NODE_OPTIONS']).toBeUndefined();
      expect(options.env['NETLIFY_AUTH_TOKEN']).toBeUndefined();
      expect(options.env['NETLIFY_API_URL']).toBeUndefined();
      expect(options.env['NETLIFY_SITE_ID']).toBeUndefined();
      expect(options.env['CLOUDFLARE_API_TOKEN']).toBeUndefined();
      expect(options.env['CLOUDFLARE_API_BASE_URL']).toBeUndefined();
      expect(options.env['CF_API_BASE_URL']).toBeUndefined();
      expect(options.env['VERCEL_TOKEN']).toBeUndefined();
      expect(options.env['XDG_DATA_HOME']).toBe(process.env['XDG_DATA_HOME']);
    }
  });

  it('runs the JavaScript CLI entrypoint on Windows instead of .cmd shims', async () => {
    const primary = runtime('primary', 'C:\\workspace', { primary: true });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (args.at(-1) === '--version') return '27.1.2';
        if (args.at(-2) === 'api') throw new Error('not authenticated');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const app = express();
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand,
      platform: 'win32',
    });

    const response = await request(app).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(response.body.setup.stage).toBe('authenticate');
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.every(
          ([command]) =>
            command === process.execPath && !command.endsWith('.cmd'),
        ),
    ).toBe(true);
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) =>
          args.some((arg) =>
            arg.endsWith('node_modules\\netlify-cli\\bin\\run.js'),
          ),
        ),
    ).toBe(true);
  });

  it('stops when the selected runtime generation closes mid-check', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    const primary = runtime('primary', '/workspace', {
      primary: true,
      generationGuard,
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') {
          generationGuard.close();
          return '27.1.2';
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const app = express();
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
    });

    const response = await request(app).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
  });
});

describe('artifact sharing setting', () => {
  it('blocks config, setup, and publishing without running provider or filesystem work', async () => {
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/sharing-disabled', {
      primary: true,
      readBytesWindow,
    });
    mockSettings({
      '/sharing-disabled': { share: { enabled: false } },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn();
    const app = makePrimaryApp(primary, runCommand);

    const responses = await Promise.all([
      request(app).get('/workspace/artifact/publish-config'),
      request(app)
        .post('/workspace/artifact/cloudflare/setup')
        .send({ action: 'prepare' }),
      request(app).post('/workspace/artifact/publish').send({
        path: 'report.html',
        provider: 'cloudflare',
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: 'Artifact sharing is disabled in Settings.',
        code: 'artifact_sharing_disabled',
      });
    }
    expect(runCommand).not.toHaveBeenCalled();
    expect(readBytesWindow).not.toHaveBeenCalled();
  });
});

describe('artifact mutation gates', () => {
  it('requires strict authorization for setup and publishing', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const mutate = vi.fn(
      () =>
        ((_req, res) => {
          res.status(401).json({ code: 'auth_required' });
        }) as express.RequestHandler,
    );
    const app = express();
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate,
    });

    const response = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'report.html', provider: 'netlify' });

    expect(response.status).toBe(401);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenNthCalledWith(1, { strict: true });
    expect(mutate).toHaveBeenNthCalledWith(2, { strict: true });
  });
});

describe('POST /workspace/artifact/netlify/setup', () => {
  it('installs Netlify and starts browser authorization without exposing credentials', async () => {
    const primary = runtime('primary', '/setup-install', { primary: true });
    let installed = false;
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (args[0] === '--version') {
          if (!installed) throw new Error('not installed');
          return '27.1.2';
        }
        if (command.endsWith('/npm') && args[0] === 'install') {
          installed = true;
          return '';
        }
        if (args[0] === 'api') throw new Error('not authenticated');
        if (args[0] === 'login' && args[1] === '--request') {
          return JSON.stringify({
            ticket_id: 'ticket-id',
            url: 'https://app.netlify.com/authorize?ticket=ticket-id',
            access_token: 'must-not-leak',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, runCommand))
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'authenticate',
      cliInstalled: true,
      authenticated: false,
      authorizationPending: true,
    });
    expect(response.body.authorizationUrl).toBe(
      'https://app.netlify.com/authorize?ticket=ticket-id',
    );
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
    expect(runCommand).toHaveBeenCalledWith(
      '/qwen-test/npm',
      [
        'install',
        '--global',
        '--prefix',
        TEST_ARTIFACT_TOOL_PREFIX,
        '--cache',
        TEST_ARTIFACT_NPM_CACHE,
        'netlify-cli',
      ],
      expect.objectContaining({ cwd: path.dirname(process.execPath) }),
    );
  });

  it('polls authorization and creates a dedicated project without exposing credentials', async () => {
    const workspaceCwd = '/setup-auth';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const settingsByWorkspace: Record<string, Record<string, unknown>> = {
      [workspaceCwd]: {},
    };
    mockSettings(settingsByWorkspace);
    let authenticated = false;
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          if (!authenticated) throw new Error('not authenticated');
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'login' && args[1] === '--request') {
          return JSON.stringify({
            ticket_id: 'ticket-id',
            url: 'https://app.netlify.com/authorize?ticket=ticket-id',
          });
        }
        if (args[0] === 'login' && args[1] === '--check') {
          authenticated = true;
          return JSON.stringify({ status: 'authorized', token: 'secret' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'created-site',
            name: 'Created site',
          });
        }
        if (args[0] === 'status') throw new Error('not linked');
        if (args[0] === 'sites:create') {
          return JSON.stringify({
            id: 'created-site',
            name: 'Created site',
            auth_token: 'must-not-leak',
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(async (_workspace, writes) => {
      const host: Record<string, unknown> = {};
      for (const write of writes) {
        if (write.key === 'artifact.host.uploadCommand') {
          host['uploadCommand'] = write.value;
        }
        if (write.key === 'artifact.host.urlFromCommandOutput') {
          host['urlFromCommandOutput'] = write.value;
        }
      }
      settingsByWorkspace[workspaceCwd] = { host };
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });
    await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'prepare' });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'poll' });

    expect(
      response.status,
      `setup returned ${JSON.stringify(response.body)}`,
    ).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      authenticated: true,
      linked: true,
      configured: true,
      linkedSite: { id: 'created-site', name: 'Created site' },
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) => args[0] === 'sites:list'),
    ).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('creates and connects a dedicated artifact project', async () => {
    const workspaceCwd = '/setup-create';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const settingsByWorkspace: Record<string, Record<string, unknown>> = {
      [workspaceCwd]: {},
    };
    mockSettings(settingsByWorkspace);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'created-site',
            name: 'Created site',
          });
        }
        if (args[0] === 'status') throw new Error('not linked');
        if (args[0] === 'sites:create') {
          return JSON.stringify({
            id: 'created-site',
            name: 'Created site',
            ssl_url: 'https://created-site.netlify.app',
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(async (_workspace, writes) => {
      const host: Record<string, unknown> = {};
      for (const write of writes) {
        if (write.key === 'artifact.host.uploadCommand') {
          host['uploadCommand'] = write.value;
        }
        if (write.key === 'artifact.host.urlFromCommandOutput') {
          host['urlFromCommandOutput'] = write.value;
        }
      }
      settingsByWorkspace[workspaceCwd] = { host };
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'prepare' });

    expect(
      response.status,
      `setup returned ${JSON.stringify(response.body)}`,
    ).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      authenticated: true,
      linked: true,
      configured: true,
      linkedSite: { id: 'created-site', name: 'Created site' },
    });
    expect(runCommand).toHaveBeenCalledWith(
      'netlify',
      ['sites:create', '--disable-linking', '--json'],
      expect.objectContaining({ cwd: workspaceCwd }),
    );
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === 'link'),
    ).toBe(false);
    expect(persistSettings.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.host.uploadCommand',
          value: expect.stringContaining('--site created-site'),
        }),
      ]),
    );
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });

  it('migrates an empty linked project and guards the settings commit', async () => {
    const workspaceCwd = '/setup-connect';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const settingsByWorkspace: Record<string, Record<string, unknown>> = {
      [workspaceCwd]: {
        host: {
          uploadCommand: 'netlify deploy --dir {dir} --json --no-build',
          urlFromCommandOutput: true,
        },
      },
    };
    mockSettings(settingsByWorkspace);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'site-id',
            name: 'Report site',
            published_deploy: null,
          });
        }
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'site-id', name: 'Report site' },
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(async (_workspace, writes) => {
      const host: Record<string, unknown> = {};
      for (const write of writes) {
        if (write.key === 'artifact.host.uploadCommand') {
          host['uploadCommand'] = write.value;
        }
        if (write.key === 'artifact.host.urlFromCommandOutput') {
          host['urlFromCommandOutput'] = write.value;
        }
      }
      settingsByWorkspace[workspaceCwd] = { host };
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect' });

    expect(
      response.status,
      `setup returned ${JSON.stringify(response.body)}`,
    ).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      linked: true,
      configured: true,
      linkedSite: { id: 'site-id', name: 'Report site' },
    });
    expect(persistSettings).toHaveBeenCalledWith(
      workspaceCwd,
      [
        {
          scope: expect.anything(),
          key: 'artifact.host.uploadCommand',
          value: expect.stringContaining(TEST_NETLIFY_ENTRY),
        },
        {
          scope: expect.anything(),
          key: 'artifact.host.urlFromCommandOutput',
          value: true,
        },
        {
          scope: expect.anything(),
          key: 'artifact.share.netlify.siteId',
          value: 'site-id',
        },
      ],
      expect.any(Function),
    );
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === 'link'),
    ).toBe(false);
  });

  it('stops a settings commit when the runtime generation closes', async () => {
    const workspaceCwd = '/setup-generation-race';
    const generationGuard = createWorkspaceGenerationGuard();
    const primary = runtime('primary', workspaceCwd, {
      primary: true,
      generationGuard,
    });
    mockSettings({
      [workspaceCwd]: {
        host: {
          uploadCommand: 'netlify deploy --dir {dir} --json --no-build',
          urlFromCommandOutput: true,
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'site-id',
            name: 'Report site',
            published_deploy: null,
          });
        }
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'site-id', name: 'Report site' },
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(
      async (_workspace, _writes, assertGenerationOpen) => {
        generationGuard.close();
        assertGenerationOpen?.();
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });

  it('does not connect an arbitrary existing project', async () => {
    const workspaceCwd = '/setup-existing';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api') return JSON.stringify({ id: 'user-id' });
        if (args[0] === 'status') throw new Error('not linked');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn();
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect', siteId: 'site-id' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('netlify_site_invalid');
    expect(persistSettings).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) =>
          ['link', 'sites:create'].includes(args[0] ?? ''),
        ),
    ).toBe(false);
  });

  it('creates a dedicated project instead of replacing a linked production project', async () => {
    const workspaceCwd = '/setup-existing-production';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const settingsByWorkspace: Record<string, Record<string, unknown>> = {
      [workspaceCwd]: {
        host: {
          uploadCommand: 'netlify deploy --dir {dir} --json --no-build',
          urlFromCommandOutput: true,
        },
      },
    };
    mockSettings(settingsByWorkspace);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          const data = JSON.parse(args[3] ?? '{}') as { site_id?: string };
          return data.site_id === 'dedicated-site'
            ? JSON.stringify({ id: 'dedicated-site', name: 'Artifact site' })
            : JSON.stringify({
                id: 'site-id',
                name: 'Existing site',
                published_deploy: { id: 'deploy-id' },
              });
        }
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'site-id', name: 'Existing site' },
          });
        }
        if (args[0] === 'sites:create') {
          return JSON.stringify({
            id: 'dedicated-site',
            name: 'Artifact site',
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(async (_workspace, writes) => {
      const host: Record<string, unknown> = {};
      for (const write of writes) {
        if (write.key === 'artifact.host.uploadCommand') {
          host['uploadCommand'] = write.value;
        }
        if (write.key === 'artifact.host.urlFromCommandOutput') {
          host['urlFromCommandOutput'] = write.value;
        }
      }
      settingsByWorkspace[workspaceCwd] = { host };
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect' });

    expect(
      response.status,
      `setup returned ${JSON.stringify(response.body)}`,
    ).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      configured: true,
      linkedSite: { id: 'dedicated-site', name: 'Artifact site' },
    });
    expect(persistSettings.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.host.uploadCommand',
          value: expect.stringContaining('--site dedicated-site'),
        }),
      ]),
    );
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === 'link'),
    ).toBe(false);
  });

  it('does not adopt a linked Netlify site for a nested workspace', async () => {
    // netlify-cli resolves the link by walking up from the workspace cwd
    // (findUpSync on `.netlify/state.json`), so `status` can report a site
    // linked by a repo-committable file ABOVE this workspace. Creation
    // already refused here; adoption walked straight past the same boundary
    // and would then publish into the parent repository's site.
    const workspaceCwd = `${process.cwd()}/src`;
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'parent-site', name: 'Parent site' },
          });
        }
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'parent-site',
            name: 'Parent site',
            published_deploy: null,
          });
        }
        if (args[0] === 'sites:create') throw new Error('must not run');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn();
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('netlify_link_outside_workspace');
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a user-authored artifact.host.uploadCommand', async () => {
    // `artifact.host.uploadCommand` predates this flow. Connecting used to
    // replace whatever was there with the managed Netlify command, silently
    // retargeting a user's own uploader.
    const workspaceCwd = '/setup-foreign-host';
    const primary = runtime('primary', workspaceCwd, { primary: true });
    mockSettings({
      [workspaceCwd]: {
        host: {
          uploadCommand: 'aws s3 cp {dir} s3://my-bucket/ --recursive',
          urlTemplate: 'https://cdn.example.com/{key}',
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'status') throw new Error('not linked');
        if (args[0] === 'sites:create') throw new Error('must not run');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn();
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'connect' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('netlify_upload_command_conflict');
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('does not create a Netlify project for a nested workspace', async () => {
    const workspaceCwd = `${process.cwd()}/src`;
    const primary = runtime('primary', workspaceCwd, { primary: true });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api') return JSON.stringify({ id: 'user-id' });
        if (args[0] === 'status') throw new Error('not linked');
        if (args[0] === 'sites:create') throw new Error('must not run');
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings: vi.fn(),
    });

    const response = await request(app)
      .post('/workspace/artifact/netlify/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('netlify_link_outside_workspace');
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) => args[0] === 'sites:create'),
    ).toBe(false);
  });

  // Self-referential symlink creation is not reliably permitted on Windows.
  it.skipIf(process.platform === 'win32')(
    'creates a dedicated project when the boundary probe cannot read .git',
    async () => {
      const workspaceCwd = await fsp.mkdtemp(
        path.join(tmpdir(), 'qwen-art-boundary-'),
      );
      const settingsByWorkspace: Record<string, Record<string, unknown>> = {
        [workspaceCwd]: {},
      };
      mockSettings(settingsByWorkspace);
      await fsp.symlink(
        path.join(workspaceCwd, '.git'),
        path.join(workspaceCwd, '.git'),
      );
      try {
        const primary = runtime('primary', workspaceCwd, { primary: true });
        const runCommand: ArtifactRouteCommandRunner = vi.fn(
          async (_command, args) => {
            if (args[0] === '--version') return '27.1.2';
            if (args[0] === 'api' && args[1] === 'getCurrentUser') {
              return JSON.stringify({ id: 'user-id' });
            }
            if (args[0] === 'api' && args[1] === 'getSite') {
              return JSON.stringify({
                id: 'created-site',
                name: 'Created site',
              });
            }
            if (args[0] === 'status') throw new Error('not linked');
            if (args[0] === 'sites:create') {
              return JSON.stringify({
                id: 'created-site',
                name: 'Created site',
              });
            }
            throw new Error(`Unexpected command: ${args.join(' ')}`);
          },
        );
        const persistSettings = vi.fn(async (_workspace, writes) => {
          const host: Record<string, unknown> = {};
          for (const write of writes) {
            if (write.key === 'artifact.host.uploadCommand') {
              host['uploadCommand'] = write.value;
            }
            if (write.key === 'artifact.host.urlFromCommandOutput') {
              host['urlFromCommandOutput'] = write.value;
            }
          }
          settingsByWorkspace[workspaceCwd] = { host };
        });
        const app = express();
        app.use(express.json());
        registerWorkspaceArtifactPublishRoutes(app, {
          getPrimaryRuntime: () => primary,
          sendBridgeError,
          mutate: allowMutations,
          runCommand: adaptTestRunner(runCommand),
          persistSettings,
        });

        const response = await request(app)
          .post('/workspace/artifact/netlify/setup')
          .send({ action: 'prepare' });

        expect(
          response.status,
          `setup returned ${JSON.stringify(response.body)}`,
        ).toBe(200);
        expect(response.body.setup).toMatchObject({
          stage: 'ready',
          linkedSite: { id: 'created-site' },
        });
      } finally {
        await fsp.rm(workspaceCwd, { recursive: true, force: true });
      }
    },
  );
});

describe('multi-provider artifact setup', () => {
  it('authorizes Cloudflare and creates a dedicated Pages project', async () => {
    const primary = runtime('primary', '/cloudflare-setup', {
      primary: true,
      env: { CLOUDFLARE_ACCOUNT_ID: 'unrelated-account' },
    });
    let installed = false;
    let authenticated = false;
    let projectName = '';
    const persistSettings = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args, options) => {
        if (command.endsWith('/npm') && args[0] === 'install') {
          installed = true;
          return '';
        }
        if (command !== 'wrangler') throw new Error('provider unavailable');
        if (args[0] === '--version') {
          if (!installed) throw new Error('not installed');
          return '4.125.0';
        }
        if (args[0] === 'whoami') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          expect(options.env['CLOUDFLARE_ACCOUNT_ID']).toBeUndefined();
          if (!authenticated) throw new Error('not authenticated');
          return JSON.stringify({
            loggedIn: true,
            accounts: [{ id: 'account-id', name: 'Personal' }],
          });
        }
        if (args[0] === 'login') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          authenticated = true;
          return 'authorized';
        }
        if (args[0] === 'pages' && args[2] === 'create') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          projectName = args[3] ?? '';
          expect(args).toContain('--force');
          expect(options.env['CLOUDFLARE_ACCOUNT_ID']).toBe('account-id');
          return 'created';
        }
        if (args[0] === 'pages' && args[2] === 'list') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          return JSON.stringify([
            {
              'Project Name': projectName,
              'Project Domains': `${projectName}.pages.dev`,
              'Git Provider': 'No',
              'Last Modified': 'now',
            },
          ]);
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/cloudflare/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      provider: 'cloudflare',
      stage: 'ready',
      project: { id: projectName, name: projectName },
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/qwen-test/npm',
      [
        'install',
        '--global',
        '--prefix',
        TEST_ARTIFACT_TOOL_PREFIX,
        '--cache',
        TEST_ARTIFACT_NPM_CACHE,
        'wrangler',
      ],
      expect.objectContaining({ cwd: path.dirname(process.execPath) }),
    );
    expect(persistSettings).toHaveBeenCalledWith(
      '/cloudflare-setup',
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.share.cloudflare.accountId',
          value: 'account-id',
        }),
        expect.objectContaining({
          key: 'artifact.share.cloudflare.projectName',
          value: projectName,
        }),
      ]),
      expect.any(Function),
    );
  });

  it.each([
    {
      name: 'retries Cloudflare project confirmation after creation',
      createThrows: false,
      emptyFirst: true,
    },
    {
      name: 'recovers when Cloudflare creation reports a late error',
      createThrows: true,
      emptyFirst: false,
    },
  ])('$name', async ({ createThrows, emptyFirst }) => {
    const primary = runtime('primary', '/cloudflare-create-recovery', {
      primary: true,
    });
    let projectName = '';
    let listCalls = 0;
    const persistSettings = vi.fn(async () => undefined);
    const waitForRetry = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'wrangler') throw new Error('provider unavailable');
        if (args[0] === '--version') return '4.125.0';
        if (args[0] === 'whoami') {
          return JSON.stringify({
            accounts: [{ id: 'account-id', name: 'Personal' }],
          });
        }
        if (args[0] === 'pages' && args[2] === 'create') {
          projectName = args[3] ?? '';
          if (createThrows) throw new Error('late command failure');
          return 'created';
        }
        if (args[0] === 'pages' && args[2] === 'list') {
          listCalls += 1;
          return JSON.stringify(
            emptyFirst && listCalls === 1
              ? []
              : [
                  {
                    'Project Name': projectName,
                    'Project Domains': `${projectName}.pages.dev`,
                  },
                ],
          );
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
      waitForPublicUrlRetry: waitForRetry,
    });

    const response = await request(app)
      .post('/workspace/artifact/cloudflare/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      project: { id: projectName, name: projectName },
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.filter(
          ([, args]) => args[0] === 'pages' && args[2] === 'create',
        ),
    ).toHaveLength(1);
    expect(persistSettings).toHaveBeenLastCalledWith(
      '/cloudflare-create-recovery',
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.share.cloudflare.projectName',
          value: projectName,
        }),
      ]),
      expect.any(Function),
    );
  });

  it('reuses a pending Cloudflare project instead of creating another', async () => {
    const primary = runtime('primary', '/cloudflare-pending-project', {
      primary: true,
    });
    const projectName = 'qwen-artifacts-pending';
    let listCalls = 0;
    mockSettings({
      '/cloudflare-pending-project': {
        share: {
          cloudflare: { accountId: 'account-id', projectName },
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'wrangler') throw new Error('provider unavailable');
        if (args[0] === '--version') return '4.125.0';
        if (args[0] === 'whoami') {
          return JSON.stringify({
            accounts: [{ id: 'account-id', name: 'Personal' }],
          });
        }
        if (args[0] === 'pages' && args[2] === 'list') {
          listCalls += 1;
          return JSON.stringify(
            listCalls === 1
              ? []
              : [
                  {
                    'Project Name': projectName,
                    'Project Domains': `${projectName}.pages.dev`,
                  },
                ],
          );
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post('/workspace/artifact/cloudflare/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      project: { id: projectName, name: projectName },
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(
          ([, args]) => args[0] === 'pages' && args[2] === 'create',
        ),
    ).toBe(false);
  });

  it('keeps the scheme the Vercel CLI already put on latestProductionUrl', async () => {
    // `project ls --json` returns a scheme-bearing `latestProductionUrl`
    // (the CLI computes `https://<alias>`), unlike Cloudflare's bare
    // `Project Domains` hostnames the prefix was written for. Prefixing
    // unconditionally emitted `https://https://acme.vercel.app`.
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          vercel: {
            projectId: 'prj_artifact',
            projectName: 'artifact-vercel',
            scope: 'personal-scope',
          },
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.9.1';
        if (args[0] === 'whoami') return 'tester';
        if (args[0] === 'project' && args[1] === 'ls') {
          return JSON.stringify({
            projects: [
              {
                id: 'prj_artifact',
                name: 'artifact-vercel',
                latestProductionUrl: 'https://acme.vercel.app',
              },
            ],
            contextName: 'personal-scope',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, runCommand)).get(
      '/workspace/artifact/publish-config',
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('https://https://');
    expect(JSON.stringify(response.body)).toContain('https://acme.vercel.app');
  });

  it('installs and authorizes Vercel before pinning its project', async () => {
    const primary = runtime('primary', '/vercel-setup', {
      primary: true,
      env: {
        VERCEL_ORG_ID: 'unrelated-org',
        VERCEL_PROJECT_ID: 'unrelated-project',
      },
    });
    let installed = false;
    let authenticated = false;
    let projectName = '';
    const persistSettings = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args, options) => {
        if (command.endsWith('/npm') && args[0] === 'install') {
          installed = true;
          return '';
        }
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') {
          if (!installed) throw new Error('not installed');
          return '59.5.0';
        }
        if (args[0] === 'whoami') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          expect(options.env['VERCEL_ORG_ID']).toBeUndefined();
          expect(options.env['VERCEL_PROJECT_ID']).toBeUndefined();
          if (!authenticated) throw new Error('not authenticated');
          return 'tester';
        }
        if (args[0] === 'login') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          authenticated = true;
          return 'authorized';
        }
        if (args[0] === 'project' && args[1] === 'add') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          projectName = args[2] ?? '';
          return 'created';
        }
        if (args[0] === 'project' && args[1] === 'ls') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          return JSON.stringify({
            projects: [{ id: 'prj_artifact', name: projectName }],
            contextName: 'personal-scope',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/vercel/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      provider: 'vercel',
      stage: 'ready',
      project: { id: 'prj_artifact', name: projectName },
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/qwen-test/npm',
      [
        'install',
        '--global',
        '--prefix',
        TEST_ARTIFACT_TOOL_PREFIX,
        '--cache',
        TEST_ARTIFACT_NPM_CACHE,
        'vercel',
      ],
      expect.objectContaining({ cwd: path.dirname(process.execPath) }),
    );
    expect(persistSettings).toHaveBeenCalledWith(
      '/vercel-setup',
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.share.vercel.projectId',
          value: 'prj_artifact',
        }),
        expect.objectContaining({
          key: 'artifact.share.vercel.scope',
          value: 'personal-scope',
        }),
      ]),
      expect.any(Function),
    );
  });

  it('continues Vercel setup when login times out after authorization', async () => {
    const primary = runtime('primary', '/vercel-login-timeout', {
      primary: true,
    });
    let authenticated = false;
    let projectName = '';
    const persistSettings = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.5.0';
        if (args[0] === 'whoami') {
          if (!authenticated) throw new Error('not authenticated');
          return 'tester';
        }
        if (args[0] === 'login') {
          authenticated = true;
          throw new Error('login command timed out');
        }
        if (args[0] === 'project' && args[1] === 'add') {
          projectName = args[2] ?? '';
          return 'created';
        }
        if (args[0] === 'project' && args[1] === 'ls') {
          return JSON.stringify({
            projects: [{ id: 'prj_artifact', name: projectName }],
            contextName: 'personal-scope',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/vercel/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      provider: 'vercel',
      stage: 'ready',
      project: { id: 'prj_artifact', name: projectName },
    });
    expect(runCommand).toHaveBeenCalledWith(
      'vercel',
      ['login'],
      expect.any(Object),
    );
    expect(persistSettings).toHaveBeenCalled();
  });

  it.each([
    {
      name: 'retries project confirmation after creation',
      addThrows: false,
      emptyFirst: true,
    },
    {
      name: 'recovers when project creation reports an error after succeeding',
      addThrows: true,
      emptyFirst: false,
    },
  ])('$name', async ({ addThrows, emptyFirst }) => {
    const primary = runtime('primary', '/vercel-create-recovery', {
      primary: true,
    });
    let projectName = '';
    let listCalls = 0;
    const persistSettings = vi.fn(async () => undefined);
    const waitForRetry = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.5.0';
        if (args[0] === 'whoami') return 'tester';
        if (args[0] === 'project' && args[1] === 'add') {
          projectName = args[2] ?? '';
          if (addThrows) throw new Error('late command failure');
          return 'created';
        }
        if (args[0] === 'project' && args[1] === 'ls') {
          listCalls += 1;
          return JSON.stringify({
            projects:
              emptyFirst && listCalls === 1
                ? []
                : [{ id: 'prj_recovered', name: projectName }],
            contextName: 'personal-scope',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
      waitForPublicUrlRetry: waitForRetry,
    });

    const response = await request(app)
      .post('/workspace/artifact/vercel/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      project: { id: 'prj_recovered', name: projectName },
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.filter(
          ([, args]) => args[0] === 'project' && args[1] === 'add',
        ),
    ).toHaveLength(1);
    expect(persistSettings).toHaveBeenLastCalledWith(
      '/vercel-create-recovery',
      expect.arrayContaining([
        expect.objectContaining({
          key: 'artifact.share.vercel.projectId',
          value: 'prj_recovered',
        }),
      ]),
      expect.any(Function),
    );
  });

  it('reuses a pending Vercel project instead of creating another', async () => {
    const primary = runtime('primary', '/vercel-pending-project', {
      primary: true,
    });
    const projectName = 'qwen-artifacts-pending';
    mockSettings({
      '/vercel-pending-project': {
        share: { vercel: { projectName } },
      },
    });
    const persistSettings = vi.fn(async () => undefined);
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.5.0';
        if (args[0] === 'whoami') return 'tester';
        if (args[0] === 'project' && args[1] === 'ls') {
          return JSON.stringify({
            projects: [{ id: 'prj_pending', name: projectName }],
            contextName: 'personal-scope',
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });

    const response = await request(app)
      .post('/workspace/artifact/vercel/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.setup).toMatchObject({
      stage: 'ready',
      project: { id: 'prj_pending', name: projectName },
    });
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(
          ([, args]) => args[0] === 'project' && args[1] === 'add',
        ),
    ).toBe(false);
  });

  it('aborts the provider CLI when the setup request is cancelled', async () => {
    const primary = runtime('primary', '/vercel-cancel', { primary: true });
    let resolveLoginStarted!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      resolveLoginStarted = resolve;
    });
    let resolveCommandAborted!: () => void;
    const commandAborted = new Promise<void>((resolve) => {
      resolveCommandAborted = resolve;
    });
    let loginSignal: AbortSignal | undefined;
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args, options) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.5.0';
        if (args[0] === 'whoami') throw new Error('not authenticated');
        if (args[0] === 'login') {
          loginSignal = options.signal;
          resolveLoginStarted();
          return await new Promise<string>((_resolve, reject) => {
            const abort = () => {
              resolveCommandAborted();
              reject(loginSignal?.reason);
            };
            if (loginSignal?.aborted) abort();
            else loginSignal?.addEventListener('abort', abort, { once: true });
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );
    const persistSettings = vi.fn(async () => undefined);
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
      persistSettings,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    try {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/workspace/artifact/vercel/setup',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ action: 'prepare' }));
      await loginStarted;

      req.destroy();

      await commandAborted;
      expect(loginSignal?.aborted).toBe(true);
      expect(persistSettings).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(runCommand)
          .mock.calls.some(([, args]) => args[0] === 'project'),
      ).toBe(false);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('POST /workspace/artifact/publish', () => {
  it('publishes the workspace file through Netlify', async () => {
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      env: { HOST_TOKEN: 'workspace-token' },
      readBytesWindow,
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
      },
    });

    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
    expect(mocked.hostPublish.mock.calls[0][0].html).toBe(HTML);
    expect(mocked.hostPublish.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(mocked.hostConstructors[0]?.config).toMatchObject({
      uploadCommand: expect.stringContaining(TEST_NETLIFY_ENTRY),
      urlFromCommandOutput: true,
    });
    expect(mocked.hostConstructors[0]?.config).toMatchObject({
      uploadCommand: expect.stringContaining('--prod --site site-id'),
    });
    expect(
      vi
        .mocked(readyNetlify)
        .mock.calls.some(([, args]) => args[0] === 'status'),
    ).toBe(false);
    expect(
      vi
        .mocked(readyNetlify)
        .mock.calls.some(
          ([, args]) => args[0] === 'api' && args[1] === 'updateSite',
        ),
    ).toBe(false);
    expect(response.body).toMatchObject({
      provider: 'netlify',
      url: 'https://preview.example.com/report',
    });
  });

  it('strips site protection only for the managed Netlify site', async () => {
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow,
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: {
          netlify: { siteId: 'site-id', dedicatedSiteId: 'site-id' },
        },
      },
    });

    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    const updateCall = vi
      .mocked(readyNetlify)
      .mock.calls.find(
        ([, args]) => args[0] === 'api' && args[1] === 'updateSite',
      );
    expect(updateCall).toBeDefined();
    expect(JSON.parse(updateCall![1][3]!)).toEqual({
      site_id: 'site-id',
      body: {
        password: '',
        password_context: 'all',
        sso_login: false,
        sso_login_context: 'all',
      },
    });
    const updateCallIndex = vi
      .mocked(readyNetlify)
      .mock.calls.indexOf(updateCall!);
    expect(mocked.hostPublish.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(readyNetlify).mock.invocationCallOrder[updateCallIndex]!,
    );
  });

  it('treats a site record without protection fields as public', async () => {
    // Netlify omits `sso_login`/`has_password` on sites that never had them,
    // and the shape varies across CLI versions. Requiring the literal `false`
    // made every such site read as protected, so a publish that had actually
    // succeeded on a fully public site failed with netlify_public_access_failed.
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow,
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: {
          netlify: { siteId: 'site-id', dedicatedSiteId: 'site-id' },
        },
      },
    });
    const sparseNetlify: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args, options) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api' && args[1] === 'getCurrentUser') {
          return JSON.stringify({ id: 'user-id' });
        }
        if (args[0] === 'api' && args[1] === 'updateSite') return '{}';
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({ id: 'site-id', name: 'Report site' });
        }
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'site-id', name: 'Report site' },
          });
        }
        if (args[0] === 'deploy') {
          return `${options.cwd}|${options.env['WORKSPACE_SHARE_TOKEN'] ?? ''}`;
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, sparseNetlify))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    expect(response.body.code).toBeUndefined();
  });

  it("leaves an adopted Netlify site's protection untouched", async () => {
    // `connectSite` persists `netlify.siteId` for a site the user had linked
    // themselves, not only for one this flow created, so keying the strip on
    // it removed that site's password and SSO settings on the first publish —
    // silently and without consent. Only `dedicatedSiteId` says "ours".
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow,
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: { netlify: { siteId: 'site-id' } },
      },
    });

    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    const updateCall = vi
      .mocked(readyNetlify)
      .mock.calls.find(
        ([, args]) => args[0] === 'api' && args[1] === 'updateSite',
      );
    expect(updateCall).toBeUndefined();
  });

  it('publishes through a pinned Cloudflare Pages project', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args, options) => {
        if (command !== 'wrangler') throw new Error('provider unavailable');
        if (args[0] === '--version') return '4.125.0';
        if (args[0] === 'pages' && args[2] === 'list') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          expect(options.env['CLOUDFLARE_ACCOUNT_ID']).toBe('account-id');
          return JSON.stringify([
            {
              'Project Name': 'artifact-pages',
              'Project Domains': 'artifact-pages.pages.dev',
            },
          ]);
        }
        if (args[0] === 'pages' && args[1] === 'deploy') {
          expect(options.cwd).toBe(path.join(tmpdir(), 'qwen-art-cloudflare'));
          return '✨ Deployment complete! Take a peek over at https://hash.artifact-pages.pages.dev';
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, runCommand))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(200);
    expect(mocked.hostConstructors[0]?.config).toMatchObject({
      uploadCommand: expect.stringContaining(
        'pages deploy {dir} --project-name artifact-pages',
      ),
    });
    expect(
      (mocked.hostConstructors[0]?.config as { uploadCommand: string })
        .uploadCommand,
    ).toContain('--force');
    const artifactSiteDir = path.join(tmpdir(), 'qwen-art-cloudflare');
    const stdout = await mocked.hostConstructors[0]!.run(process.execPath, [
      TEST_WRANGLER_ENTRY,
      'pages',
      'deploy',
      artifactSiteDir,
      '--project-name',
      'artifact-pages',
      '--force',
    ]);
    expect(stdout).toBe('https://hash.artifact-pages.pages.dev');
  });

  it('reuses unchanged content and only force-publishes a new deployment', async () => {
    const readBytesWindow = windowReader(HTML);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow,
    });
    const artifact: Record<string, unknown> = {
      share: {
        cloudflare: {
          accountId: 'account-id',
          projectName: 'artifact-pages',
        },
      },
    };
    mockSettings({ '/workspace': artifact });
    const persistSettings = vi.fn(
      async (
        _workspace: string,
        writes: Array<{
          scope: SettingScope;
          key: string;
          value: unknown;
        }>,
        assertGenerationOpen?: () => void,
      ) => {
        assertGenerationOpen?.();
        for (const write of writes) {
          expect(write.scope).toBe(SettingScope.Workspace);
          setArtifactSetting(artifact, write.key, write.value);
        }
      },
    );
    const app = makePrimaryApp(
      primary,
      readyCloudflare,
      async () => true,
      undefined,
      persistSettings,
    );

    const responses = await Promise.all([
      request(app)
        .post('/workspace/artifact/publish')
        .send({ path: 'out/report.html', provider: 'cloudflare' }),
      request(app)
        .post('/workspace/artifact/publish')
        .send({ path: 'out/report.html', provider: 'cloudflare' }),
    ]);
    const first = responses.find((response) => response.body.reused === false);
    const reused = responses.find((response) => response.body.reused === true);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(first?.body).toMatchObject({
      provider: 'cloudflare',
      reused: false,
      recorded: true,
    });
    expect(reused?.body).toMatchObject({
      provider: 'cloudflare',
      url: first?.body.url,
      publishedAt: first?.body.publishedAt,
      reused: true,
      recorded: true,
    });
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
    expect(persistSettings).toHaveBeenCalledTimes(1);

    const config = await request(app)
      .get('/workspace/artifact/publish-config')
      .query({ path: 'out/report.html' });
    expect(config.status).toBe(200);
    expect(config.body.publications.cloudflare).toMatchObject({
      provider: 'cloudflare',
      id: first?.body.id,
      url: first?.body.url,
      publishedAt: first?.body.publishedAt,
      upToDate: true,
    });

    readBytesWindow.mockImplementation(windowReader(`${HTML}<p>changed</p>`));
    const changedConfig = await request(app)
      .get('/workspace/artifact/publish-config')
      .query({ path: 'out/report.html' });
    expect(changedConfig.body.publications.cloudflare.upToDate).toBe(false);

    const forced = await request(app).post('/workspace/artifact/publish').send({
      path: 'out/report.html',
      provider: 'cloudflare',
      force: true,
    });
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ reused: false, recorded: true });
    expect(mocked.hostPublish).toHaveBeenCalledTimes(2);
    expect(persistSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps publication history when different artifacts publish concurrently', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const artifact: Record<string, unknown> = {
      share: {
        cloudflare: {
          accountId: 'account-id',
          projectName: 'artifact-pages',
        },
      },
    };
    mockSettings({ '/workspace': artifact });
    const persistSettings = vi.fn(
      async (
        _workspace: string,
        writes: Array<{
          scope: SettingScope;
          key: string;
          value: unknown;
        }>,
        assertGenerationOpen?: () => void,
      ) => {
        assertGenerationOpen?.();
        for (const write of writes) {
          setArtifactSetting(artifact, write.key, write.value);
        }
      },
    );
    const app = makePrimaryApp(
      primary,
      readyCloudflare,
      async () => true,
      undefined,
      persistSettings,
    );

    const [first, second] = await Promise.all([
      request(app)
        .post('/workspace/artifact/publish')
        .send({ path: 'out/first.html', provider: 'cloudflare' }),
      request(app)
        .post('/workspace/artifact/publish')
        .send({ path: 'out/second.html', provider: 'cloudflare' }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(mocked.hostPublish).toHaveBeenCalledTimes(2);
    expect(persistSettings).toHaveBeenCalledTimes(2);
    const [firstConfig, secondConfig] = await Promise.all([
      request(app)
        .get('/workspace/artifact/publish-config')
        .query({ path: 'out/first.html' }),
      request(app)
        .get('/workspace/artifact/publish-config')
        .query({ path: 'out/second.html' }),
    ]);
    expect(firstConfig.body.publications.cloudflare.upToDate).toBe(true);
    expect(secondConfig.body.publications.cloudflare.upToDate).toBe(true);
  });

  it('does not reuse a Cloudflare publication after changing accounts', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const artifact: Record<string, unknown> = {
      share: {
        cloudflare: {
          accountId: 'first-account',
          projectName: 'artifact-pages',
        },
      },
    };
    mockSettings({ '/workspace': artifact });
    const persistSettings = vi.fn(
      async (
        _workspace: string,
        writes: Array<{
          scope: SettingScope;
          key: string;
          value: unknown;
        }>,
        assertGenerationOpen?: () => void,
      ) => {
        assertGenerationOpen?.();
        for (const write of writes) {
          setArtifactSetting(artifact, write.key, write.value);
        }
      },
    );
    const app = makePrimaryApp(
      primary,
      readyCloudflare,
      async () => true,
      undefined,
      persistSettings,
    );

    const first = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });
    const share = artifact['share'] as {
      cloudflare: { accountId: string; projectName: string };
    };
    share.cloudflare.accountId = 'second-account';
    const second = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body.reused).toBe(false);
    expect(second.body.reused).toBe(false);
    expect(mocked.hostPublish).toHaveBeenCalledTimes(2);
  });

  it('retries Cloudflare reachability without publishing again', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    mocked.hostPublish.mockResolvedValue({
      id: 'host-id',
      url: 'https://hash.artifact-pages.pages.dev',
    });
    const checkPublicUrl = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const waitForRetry = vi.fn(async () => undefined);

    const response = await request(
      makePrimaryApp(primary, readyCloudflare, checkPublicUrl, waitForRetry),
    )
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(200);
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
    expect(checkPublicUrl).toHaveBeenCalledTimes(3);
    expect(checkPublicUrl).toHaveBeenNthCalledWith(
      1,
      'https://hash.artifact-pages.pages.dev',
    );
    expect(waitForRetry.mock.calls).toEqual([[1_000], [3_000]]);
  });

  it('stops Cloudflare reachability checks after the retry window', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    const checkPublicUrl = vi.fn(async () => false);
    const waitForRetry = vi.fn(async () => undefined);

    const response = await request(
      makePrimaryApp(primary, readyCloudflare, checkPublicUrl, waitForRetry),
    )
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('cloudflare_public_access_failed');
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
    expect(checkPublicUrl).toHaveBeenCalledTimes(5);
    expect(waitForRetry.mock.calls).toEqual([
      [1_000],
      [3_000],
      [6_000],
      [10_000],
    ]);
  });

  it('releases the publish lock when a reachability retry is cancelled', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    let resolveRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      resolveRetryStarted = resolve;
    });
    let checkCalls = 0;
    const checkPublicUrl = vi.fn(async () => {
      checkCalls += 1;
      return checkCalls > 1;
    });
    const waitForRetry = vi.fn(async () => {
      resolveRetryStarted();
      return await new Promise<void>(() => {});
    });
    let publishSignal: AbortSignal | undefined;
    mocked.hostPublish.mockImplementation(async (_input, signal) => {
      publishSignal = signal;
      return {
        id: 'host-id',
        url: 'https://hash.artifact-pages.pages.dev',
      };
    });
    const app = makePrimaryApp(
      primary,
      readyCloudflare,
      checkPublicUrl,
      waitForRetry,
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    try {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/workspace/artifact/publish',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      req.on('error', () => {});
      req.end(
        JSON.stringify({
          path: 'out/report.html',
          provider: 'cloudflare',
        }),
      );
      await retryStarted;

      req.destroy();
      await new Promise<void>((resolve) => {
        if (publishSignal?.aborted) resolve();
        else
          publishSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });

      const retry = await request(app)
        .post('/workspace/artifact/publish')
        .send({ path: 'out/report.html', provider: 'cloudflare' })
        .timeout({ response: 1_000, deadline: 1_500 });
      expect(retry.status).toBe(200);
      expect(mocked.hostPublish).toHaveBeenCalledTimes(2);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves workspace filesystem error status and retry hints', async () => {
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow: vi.fn().mockRejectedValue(
        new FsError('hash_mismatch', 'file changed during read', {
          hint: 'retry after reading the latest file',
        }),
      ),
    });

    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      errorKind: 'hash_mismatch',
      hint: 'retry after reading the latest file',
      status: 409,
    });
  });

  it('returns a structured upstream error when provider publishing fails', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    mocked.hostPublish.mockRejectedValue(new Error('provider secret output'));

    const response = await request(makePrimaryApp(primary, readyCloudflare))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'Could not publish the artifact through cloudflare. Try again.',
      code: 'cloudflare_publish_failed',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('stops when the runtime closes during the final reachability check', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    const primary = runtime('primary', '/workspace', {
      primary: true,
      generationGuard,
    });
    mockSettings({
      '/workspace': {
        share: {
          cloudflare: {
            accountId: 'account-id',
            projectName: 'artifact-pages',
          },
        },
      },
    });
    let checks = 0;
    const checkPublicUrl = vi.fn(async () => {
      checks += 1;
      if (checks === 5) generationGuard.close();
      return false;
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceArtifactPublishRoutes(app, {
      getPrimaryRuntime: () => primary,
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(readyCloudflare),
      checkPublicUrl,
      waitForPublicUrlRetry: async () => undefined,
    });

    const response = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'cloudflare' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(checkPublicUrl).toHaveBeenCalledTimes(5);
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
  });

  it('publishes through a pinned Vercel project and scope', async () => {
    const primary = runtime('primary', '/workspace', {
      primary: true,
      env: {
        VERCEL_ORG_ID: 'unrelated-org',
        VERCEL_PROJECT_ID: 'unrelated-project',
      },
    });
    mockSettings({
      '/workspace': {
        share: {
          vercel: {
            projectId: 'prj_artifact',
            projectName: 'artifact-vercel',
            scope: 'personal-scope',
          },
        },
      },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (command, args, options) => {
        if (command !== 'vercel') throw new Error('provider unavailable');
        if (args[0] === '--version') return '59.5.0';
        if (args[0] === 'project' && args[1] === 'ls') {
          expect(options.cwd).toBe(path.dirname(process.execPath));
          expect(options.env['VERCEL_ORG_ID']).toBeUndefined();
          expect(options.env['VERCEL_PROJECT_ID']).toBeUndefined();
          expect(args).toEqual(
            expect.arrayContaining([
              '--filter',
              'artifact-vercel',
              '--scope',
              'personal-scope',
            ]),
          );
          return JSON.stringify({
            projects: [{ id: 'prj_artifact', name: 'artifact-vercel' }],
            contextName: 'personal-scope',
          });
        }
        if (args[0] === 'deploy') {
          expect(options.cwd).toBe(path.join(tmpdir(), 'qwen-art-vercel'));
          expect(options.env['VERCEL_ORG_ID']).toBeUndefined();
          expect(options.env['VERCEL_PROJECT_ID']).toBeUndefined();
          return 'https://artifact.vercel.app';
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, runCommand))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'vercel' });

    expect(response.status).toBe(200);
    expect(mocked.hostConstructors[0]?.config).toMatchObject({
      uploadCommand: expect.stringContaining(
        'deploy {dir} --yes --prod --project prj_artifact --scope personal-scope',
      ),
    });
    const artifactSiteDir = path.join(tmpdir(), 'qwen-art-vercel');
    const stdout = await mocked.hostConstructors[0]!.run(process.execPath, [
      TEST_VERCEL_ENTRY,
      'deploy',
      artifactSiteDir,
      '--yes',
      '--prod',
      '--project',
      'prj_artifact',
      '--scope',
      'personal-scope',
    ]);
    expect(stdout).toBe('https://artifact.vercel.app');
  });

  it('does not return a share link until Netlify confirms public access', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
        share: {
          netlify: { siteId: 'site-id', dedicatedSiteId: 'site-id' },
        },
      },
    });
    const protectedNetlify: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args) => {
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'status') {
          return JSON.stringify({
            siteData: { id: 'site-id', name: 'Report site' },
          });
        }
        if (args[0] === 'api' && args[1] === 'updateSite') return '{}';
        if (args[0] === 'api' && args[1] === 'getSite') {
          return JSON.stringify({
            id: 'site-id',
            name: 'Report site',
            sso_login: true,
            has_password: false,
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );

    const response = await request(makePrimaryApp(primary, protectedNetlify))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('netlify_public_access_failed');
    expect(response.body).not.toHaveProperty('url');
    expect(mocked.hostPublish).toHaveBeenCalledTimes(1);
  });

  it('isolates Netlify deploys from workspace config and functions', async () => {
    const workspaceCwd = process.cwd();
    const artifactSiteDir = path.join(tmpdir(), 'qwen-art-test');
    const primary = runtime('primary', workspaceCwd, {
      primary: true,
      env: { WORKSPACE_SHARE_TOKEN: 'workspace-token' },
    });
    mockSettings({
      [workspaceCwd]: {
        host: NETLIFY_HOST,
      },
    });
    await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    const stdout = await mocked.hostConstructors[0]!.run(process.execPath, [
      TEST_NETLIFY_ENTRY,
      'deploy',
      '--dir',
      artifactSiteDir,
    ]);
    expect(stdout).toBe(`${artifactSiteDir}|workspace-token`);
  });

  it('does not accept command or credential overrides from the browser', async () => {
    const primary = runtime('primary', '/workspace', { primary: true });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
      },
    });

    await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({
        path: 'out/report.html',
        provider: 'netlify',
        config: {
          uploadCommand: 'attacker deploy {dir}',
          accessKeySecret: 'browser-secret',
        },
      });

    expect(mocked.hostConstructors[0]?.config).toMatchObject({
      uploadCommand: expect.stringContaining(TEST_NETLIFY_ENTRY),
    });
    expect(JSON.stringify(mocked.hostConstructors)).not.toContain(
      'browser-secret',
    );
  });

  it.each([
    [{ path: 'out/report.html' }, 'invalid_request'],
    [{ path: 'out/report.html', provider: 'host' }, 'invalid_request'],
    [
      { path: 'out/report.html', provider: 'netlify' },
      'netlify_not_configured',
    ],
  ])('rejects an unusable request %#', async (body, code) => {
    const primary = runtime('primary', '/workspace', { primary: true });
    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(code);
    expect(mocked.hostPublish).not.toHaveBeenCalled();
  });

  it('refuses a file past the publish limit', async () => {
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow: windowReader(HTML, 17 * 1024 * 1024),
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
      },
    });
    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('artifact_too_large');
    expect(mocked.hostPublish).not.toHaveBeenCalled();
  });

  it('walks a file larger than one read window', async () => {
    const big = 'x'.repeat(700 * 1024);
    const reader = windowReader(big);
    const primary = runtime('primary', '/workspace', {
      primary: true,
      readBytesWindow: reader,
    });
    mockSettings({
      '/workspace': {
        host: NETLIFY_HOST,
      },
    });
    const response = await request(makePrimaryApp(primary))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    expect(reader.mock.calls.length).toBeGreaterThan(1);
    expect(mocked.hostPublish.mock.calls[0][0].html).toBe(big);
  });
});

describe('workspace-qualified artifact publishing', () => {
  it('honors the selected workspace sharing setting', async () => {
    const primary = runtime('primary', '/primary', { primary: true });
    const secondary = runtime('secondary', '/secondary');
    mockSettings({
      '/primary': { share: { enabled: true } },
      '/secondary': { share: { enabled: false } },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn();
    const app = express();
    registerWorkspaceQualifiedArtifactPublishRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
    });

    const response = await request(app).get(
      '/workspaces/secondary/artifact/publish-config',
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('artifact_sharing_disabled');
    expect(vi.mocked(loadSettings)).toHaveBeenCalledWith('/secondary', {
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs Netlify setup only in the selected trusted runtime', async () => {
    const primary = runtime('primary', '/primary', { primary: true });
    const secondary = runtime('secondary', '/secondary', {
      env: { SECONDARY_ONLY: 'yes' },
    });
    const runCommand: ArtifactRouteCommandRunner = vi.fn(
      async (_command, args, options) => {
        expect(options.cwd).toBe('/secondary');
        expect(options.env['SECONDARY_ONLY']).toBe('yes');
        if (args[0] === '--version') return '27.1.2';
        if (args[0] === 'api') throw new Error('not authenticated');
        if (args[0] === 'login') {
          return JSON.stringify({
            ticket_id: 'secondary-ticket',
            url: 'https://app.netlify.com/authorize?ticket=secondary-ticket',
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedArtifactPublishRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
      sendBridgeError,
      mutate: allowMutations,
      runCommand: adaptTestRunner(runCommand),
    });

    const response = await request(app)
      .post('/workspaces/secondary/artifact/netlify/setup')
      .send({ action: 'prepare' });

    expect(response.status).toBe(200);
    expect(response.body.workspaceCwd).toBe('/secondary');
    expect(response.body.setup.stage).toBe('authenticate');
    expect(runCommand).toHaveBeenCalled();
  });

  it('uses only the selected runtime filesystem, settings, and environment', async () => {
    const primaryReader = windowReader('primary');
    const secondaryReader = windowReader('secondary');
    const secondaryCwd = process.cwd();
    const primary = runtime('primary', '/primary', {
      primary: true,
      readBytesWindow: primaryReader,
    });
    const secondary = runtime('secondary', secondaryCwd, {
      env: { WORKSPACE_SHARE_TOKEN: 'secondary-token' },
      readBytesWindow: secondaryReader,
    });
    mockSettings({
      '/primary': {},
      [secondaryCwd]: {
        host: NETLIFY_HOST,
      },
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedArtifactPublishRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
      sendBridgeError: (res, err) => {
        res.status(500).json({ error: (err as Error).message });
      },
      mutate: allowMutations,
      runCommand: adaptTestRunner(readyNetlify),
      checkPublicUrl: async () => true,
    });

    const response = await request(app)
      .post('/workspaces/secondary/artifact/publish')
      .send({ path: 'out/report.html', provider: 'netlify' });

    expect(response.status).toBe(200);
    expect(mocked.hostPublish.mock.calls[0][0].html).toBe('secondary');
    expect(primaryReader).not.toHaveBeenCalled();
    expect(vi.mocked(loadSettings)).toHaveBeenCalledWith(secondaryCwd, {
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    const artifactSiteDir = path.join(tmpdir(), 'qwen-art-secondary');
    const stdout = await mocked.hostConstructors[0]!.run(process.execPath, [
      TEST_NETLIFY_ENTRY,
      'deploy',
      '--dir',
      artifactSiteDir,
    ]);
    expect(stdout).toBe(`${artifactSiteDir}|secondary-token`);
  });

  it('rejects an untrusted selected runtime', async () => {
    const primary = runtime('primary', '/primary', { primary: true });
    const untrusted = runtime('untrusted', '/untrusted', { trusted: false });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedArtifactPublishRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([primary, untrusted]),
      sendBridgeError: vi.fn(),
      mutate: allowMutations,
    });

    const response = await request(app).get(
      '/workspaces/untrusted/artifact/publish-config',
    );

    expect(response.status).toBe(403);
    expect(loadSettings).not.toHaveBeenCalled();
  });
});
