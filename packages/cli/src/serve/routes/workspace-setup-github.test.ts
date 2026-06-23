/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServeApp } from '../server.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { BridgeEvent } from '../event-bus.js';
import type { ServeOptions } from '../types.js';
import {
  resetHomeEnvBootstrapForTesting,
  SETTINGS_DIRECTORY_NAME,
} from '../../config/settings.js';
import {
  resetTrustedFoldersForTesting,
  TRUSTED_FOLDERS_FILENAME,
  TrustLevel,
} from '../../config/trustedFolders.js';

const setupGithubMocks = vi.hoisted(() => {
  class MockSetupGithubError extends Error {
    readonly code: string;
    readonly status: number;
    readonly partial: boolean;
    readonly partialResult?: unknown;

    constructor(
      code: string,
      message: string,
      status: number,
      partialResult?: unknown,
    ) {
      super(message);
      this.name = 'SetupGithubError';
      this.code = code;
      this.status = status;
      this.partial = partialResult !== undefined;
      this.partialResult = partialResult;
    }
  }

  return {
    setupGithub: vi.fn(),
    SetupGithubError: MockSetupGithubError,
  };
});

vi.mock('../../services/setup-github.js', () => ({
  setupGithub: setupGithubMocks.setupGithub,
  SetupGithubError: setupGithubMocks.SetupGithubError,
}));

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4180,
  mode: 'http-bridge',
};

const originalQwenHome = process.env['QWEN_HOME'];
const originalTrustedFoldersPath =
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];

interface Harness {
  workspace: string;
  scratch: string;
  bridgeEvents: BridgeEvent[];
  app: ReturnType<typeof createServeApp>;
}

function loopbackHost(): string {
  return `127.0.0.1:${baseOpts.port}`;
}

async function makeHarness(
  opts: { token?: string; trusted?: boolean } = {},
): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(
      os.tmpdir(),
      `qwen-setup-github-route-${randomBytes(4).toString('hex')}-`,
    ),
  );
  const wsDir = path.join(scratch, 'ws');
  const home = path.join(scratch, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(wsDir);
  process.env['QWEN_HOME'] = home;
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
    home,
    TRUSTED_FOLDERS_FILENAME,
  );
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
  const workspace = canonicalizeWorkspace(wsDir);
  const events: BridgeEvent[] = [];
  const bridgeEvents: BridgeEvent[] = [];
  const fsFactory = createWorkspaceFileSystemFactory({
    boundWorkspace: workspace,
    trusted: opts.trusted ?? true,
    emit: (event) => events.push(event),
  });
  const bridge = {
    knownClientIds: () => new Set(['client-1']),
    publishWorkspaceEvent: (event: BridgeEvent) => {
      bridgeEvents.push(event);
    },
  } as unknown as AcpSessionBridge;
  const app = createServeApp(
    { ...baseOpts, workspace, token: opts.token },
    undefined,
    { bridge, fsFactory },
  );
  return { workspace, scratch, bridgeEvents, app };
}

async function teardown(h: Harness): Promise<void> {
  await fsp.rm(h.scratch, { recursive: true, force: true });
  if (originalQwenHome === undefined) {
    delete process.env['QWEN_HOME'];
  } else {
    process.env['QWEN_HOME'] = originalQwenHome;
  }
  if (originalTrustedFoldersPath === undefined) {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  } else {
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = originalTrustedFoldersPath;
  }
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function setupResult() {
  return {
    kind: 'github_setup',
    workspaceCwd: '/work',
    gitRepoRoot: '/work',
    releaseTag: 'v1.2.3',
    readmeUrl:
      'https://github.com/QwenLM/qwen-code-action/blob/v1.2.3/README.md#quick-start',
    secretsUrl: 'https://github.com/owner/repo/settings/secrets/actions',
    workflows: [
      {
        sourcePath: 'qwen-dispatch/qwen-dispatch.yml',
        path: '.github/workflows/qwen-dispatch.yml',
        status: 'written',
        sizeBytes: 12,
      },
    ],
    gitignore: { path: '.gitignore', status: 'updated' },
    warnings: [],
  };
}

describe('POST /workspace/setup-github', () => {
  let h: Harness;

  beforeEach(async () => {
    setupGithubMocks.setupGithub.mockReset();
    h = await makeHarness({ token: 'secret' });
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('requires strict mutation auth', async () => {
    await teardown(h);
    h = await makeHarness();
    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .send({ consent: true });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
    expect(setupGithubMocks.setupGithub).not.toHaveBeenCalled();
  });

  it('requires consent', async () => {
    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('github_setup_consent_required');
    expect(setupGithubMocks.setupGithub).not.toHaveBeenCalled();
  });

  it('returns workflow summary and publishes github_setup_completed', async () => {
    setupGithubMocks.setupGithub.mockResolvedValueOnce(setupResult());

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ consent: true });

    expect(res.status).toBe(200);
    expect(res.body.releaseTag).toBe('v1.2.3');
    expect(setupGithubMocks.setupGithub).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: h.workspace,
        workspaceRoot: h.workspace,
      }),
    );
    expect(h.bridgeEvents).toEqual([
      expect.objectContaining({
        type: 'github_setup_completed',
        originatorClientId: 'client-1',
        data: expect.objectContaining({ releaseTag: 'v1.2.3' }),
      }),
    ]);
  });

  it('rejects untrusted workspace before creating workflow directory', async () => {
    await teardown(h);
    h = await makeHarness({ token: 'secret', trusted: false });
    setupGithubMocks.setupGithub.mockImplementationOnce(
      async (opts: {
        fileOps: {
          ensureWorkflowDirectory(gitRepoRoot: string): Promise<void>;
        };
      }) => {
        await opts.fileOps.ensureWorkflowDirectory(h.workspace);
        return setupResult();
      },
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('github_setup_untrusted_workspace');
    await expect(
      fsp.access(path.join(h.workspace, '.github')),
    ).rejects.toBeDefined();
  });

  it('rejects a directory that becomes a symlink before mkdir completes', async () => {
    const realMkdir = fsp.mkdir;
    const target = path.join(h.scratch, 'symlink-target');
    const githubDir = path.join(h.workspace, '.github');
    const mkdirSpy = vi
      .spyOn(fsp, 'mkdir')
      .mockImplementation(
        async (
          input: Parameters<typeof fsp.mkdir>[0],
          options?: Parameters<typeof fsp.mkdir>[1],
        ) => {
          if (String(input) === githubDir) {
            await realMkdir(target, { recursive: true });
            await fsp.symlink(target, githubDir);
            throw Object.assign(new Error('already exists'), {
              code: 'EEXIST',
            });
          }
          return realMkdir(input, options);
        },
      );
    setupGithubMocks.setupGithub.mockImplementationOnce(
      async (opts: {
        fileOps: {
          ensureWorkflowDirectory(gitRepoRoot: string): Promise<void>;
        };
      }) => {
        await opts.fileOps.ensureWorkflowDirectory(h.workspace);
        return setupResult();
      },
    );

    try {
      const res = await request(h.app)
        .post('/workspace/setup-github')
        .set('Host', loopbackHost())
        .set('Authorization', 'Bearer secret')
        .send({ consent: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('github_setup_invalid_workspace');
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('rejects a symlinked repository root before creating workflow directories', async () => {
    const realRoot = path.join(h.scratch, 'real-root');
    const linkRoot = path.join(h.scratch, 'link-root');
    await fsp.mkdir(realRoot, { recursive: true });
    await fsp.symlink(realRoot, linkRoot, 'dir');
    setupGithubMocks.setupGithub.mockImplementationOnce(
      async (opts: {
        fileOps: {
          ensureWorkflowDirectory(gitRepoRoot: string): Promise<void>;
        };
      }) => {
        await opts.fileOps.ensureWorkflowDirectory(linkRoot);
        return setupResult();
      },
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('github_setup_invalid_workspace');
    expect(JSON.stringify(res.body)).not.toContain(linkRoot);
    expect(JSON.stringify(res.body)).not.toContain(realRoot);
    await expect(
      fsp.access(path.join(realRoot, '.github')),
    ).rejects.toBeDefined();
  });

  it('does not use workspace proxy settings before trust is established', async () => {
    await writeJson(path.join(h.scratch, 'home', 'settings.json'), {
      proxy: 'http://user-proxy.example:8080',
      security: { folderTrust: { enabled: true } },
    });
    await writeJson(
      path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
      {
        proxy: 'http://workspace-proxy.example:8080',
      },
    );
    setupGithubMocks.setupGithub.mockResolvedValueOnce(setupResult());

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(200);
    expect(setupGithubMocks.setupGithub).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: 'http://user-proxy.example:8080',
      }),
    );
  });

  it('uses workspace proxy settings after trust is established', async () => {
    await writeJson(path.join(h.scratch, 'home', 'settings.json'), {
      proxy: 'http://user-proxy.example:8080',
      security: { folderTrust: { enabled: true } },
    });
    await writeJson(path.join(h.scratch, 'home', TRUSTED_FOLDERS_FILENAME), {
      [h.workspace]: TrustLevel.TRUST_FOLDER,
    });
    resetTrustedFoldersForTesting();
    await writeJson(
      path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
      {
        proxy: 'http://workspace-proxy.example:8080',
      },
    );
    setupGithubMocks.setupGithub.mockResolvedValueOnce(setupResult());

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(200);
    expect(setupGithubMocks.setupGithub).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: 'http://workspace-proxy.example:8080',
      }),
    );
  });

  it('redacts setup-github filesystem paths from client errors', async () => {
    setupGithubMocks.setupGithub.mockRejectedValueOnce(
      new setupGithubMocks.SetupGithubError(
        'github_setup_invalid_workspace',
        `${h.workspace}/.github must not be a symlink.`,
        400,
      ),
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('github_setup_invalid_workspace');
    expect(JSON.stringify(res.body)).not.toContain(h.workspace);
  });

  it('uses a generic setup-github message for unexpected errors', async () => {
    setupGithubMocks.setupGithub.mockRejectedValueOnce(
      new Error(`${h.workspace}/internal dependency failed`),
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'An internal error occurred during GitHub setup.',
      code: 'github_setup_failed',
      status: 500,
    });
  });

  it('maps release lookup failure to 502', async () => {
    setupGithubMocks.setupGithub.mockRejectedValueOnce(
      new setupGithubMocks.SetupGithubError(
        'github_release_lookup_failed',
        'Unable to look up release',
        502,
      ),
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('github_release_lookup_failed');
  });

  it('surfaces workflow write failure as partial', async () => {
    const partial = {
      ...setupResult(),
      partial: true,
      workflows: [
        {
          sourcePath: 'qwen-dispatch/qwen-dispatch.yml',
          path: '.github/workflows/qwen-dispatch.yml',
          status: 'written',
          sizeBytes: 12,
        },
        {
          sourcePath: 'qwen-assistant/qwen-invoke.yml',
          path: '.github/workflows/qwen-invoke.yml',
          status: 'failed',
          error: 'disk full',
        },
      ],
    };
    setupGithubMocks.setupGithub.mockRejectedValueOnce(
      new setupGithubMocks.SetupGithubError(
        'github_workflow_write_failed',
        'Unable to write workflow',
        500,
        partial,
      ),
    );

    const res = await request(h.app)
      .post('/workspace/setup-github')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ consent: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('github_workflow_write_failed');
    expect(res.body.partial).toBe(true);
    expect(res.body.result.workflows[1]).toMatchObject({
      path: '.github/workflows/qwen-invoke.yml',
      status: 'failed',
    });
  });
});
