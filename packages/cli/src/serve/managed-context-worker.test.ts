/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import {
  isManagedContextReady,
  MANAGED_CONTEXT_PROTOCOL,
  type ManagedContextBoot,
} from './managed-context-envelope.js';
import {
  readManagedRuntimeWorkerBoot,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
  type ManagedToolReference,
} from './managed-runtime-tool-executor.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  registerManagedContextRoutes,
  selectShellCapturePublisher,
} from './managed-context-worker.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  ManagedShellPublisherRegistry,
  MANAGED_SHELL_PUBLISHER_ROUTE,
} from './managed-shell-publisher.js';
import { PUBLICATION_INSTALL_ROUTE } from './remote-shell-result-publication.js';
import {
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';

const globWorkerAssets = vi.hoisted(() => ({ directory: '' }));
vi.mock(
  '@qwen-code/qwen-code-core/utils/bundlePaths.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/utils/bundlePaths.js')
    >()),
    resolveBundleDir: () => globWorkerAssets.directory,
  }),
);

// CLI tests alias Core to source; give each suite its own real JS worker asset.
beforeAll(async () => {
  globWorkerAssets.directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'managed-glob-asset-'),
  );
  const { build } = await import('esbuild');
  await build({
    entryPoints: [
      path.resolve(
        import.meta.dirname,
        '../../../core/src/tools/glob-search-worker.ts',
      ),
    ],
    outfile: path.join(globWorkerAssets.directory, 'glob-search-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
}, 30_000);

afterAll(() => {
  if (globWorkerAssets.directory)
    fs.rmSync(globWorkerAssets.directory, { recursive: true, force: true });
});

interface Expected {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
}

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-context-v1.fixtures.json',
    ),
    'utf8',
  ),
) as {
  boot: ManagedContextBoot;
  bootCases: Array<{ id: string; boot: unknown; valid: boolean }>;
  attestationCases: Array<{ id: string; body: unknown; expected: Expected }>;
  installationSequences: Array<{
    id: string;
    steps: Array<{
      request: { binding: Record<string, string> } & Record<string, unknown>;
      expected: Expected;
    }>;
  }>;
};

const BOOT = fixtures.boot;
const HEADERS = Object.freeze({
  authorization: `Bearer ${BOOT.token}`,
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': BOOT.leaseId,
  'x-qwen-managed-lease-epoch': String(BOOT.epoch),
});
const ATTEST = '/internal/managed-runtime/v3/attest';
const CONTEXT = '/internal/managed-runtime/v3/context';
const EXECUTE = '/internal/managed-runtime/v2/execute';
const STATUS = '/internal/managed-runtime/v2/status';
const CANCEL = '/internal/managed-runtime/v2/cancel';
const ACTIVATION = WORKSPACE_ACTIVATION_ROUTE.path;
const UNAVAILABLE = {
  code: 'managed_context_unavailable',
  error: 'Managed context directory is unavailable.',
};
const CANONICAL_ATTESTATION = fixtures.attestationCases.find(
  (fixture) => fixture.id === 'canonical',
)!.body;
/** Every directory that an installation fixture installs. */
const FIXTURE_DIRECTORIES = new Set(
  fixtures.installationSequences.flatMap((sequence) =>
    sequence.steps
      .filter((step) => step.expected.status === 200)
      .map((step) => step.request.binding['cwdRelative']),
  ),
);

const openWorkers = new Set<ManagedRuntimeAttestationWorkerHandle>();

afterEach(async () => {
  await Promise.all([...openWorkers].map((worker) => worker.close()));
  openWorkers.clear();
});

async function startWorker(
  boot: ManagedContextBoot | ManagedRuntimeWorkerBoot,
): Promise<string> {
  const worker = await startManagedRuntimeAttestationWorker(boot);
  openWorkers.add(worker);
  return worker.ready.url;
}

function post(
  origin: string,
  route: string,
  body: unknown,
  headers: Record<string, string> = HEADERS,
): Promise<Response> {
  return fetch(`${origin}${route}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expectAnswer(response: Response, expected: Expected) {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  if (expected.status === 200) {
    expect(body).toStrictEqual(expected.body);
  } else {
    expect(body).toStrictEqual({
      code: expected.code,
      error: expect.any(String),
    });
  }
}

async function emptyAnswer(route: string, response: Response) {
  return {
    route,
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get('cache-control'),
  };
}

/** Installs each directory for its own Session; returns the 409 bodies. */
async function refusals(origin: string, directories: readonly string[]) {
  const bodies = [];
  for (const [index, cwdRelative] of directories.entries()) {
    const response = await post(
      origin,
      CONTEXT,
      installation(`session-${index}`, cwdRelative),
    );
    bodies.push(
      response.status === 409 ? await response.json() : response.status,
    );
  }
  return bodies;
}

/** A Workspace mount with the given directories, removed after the test. */
function workspace(directories: readonly string[] = ['services/api']): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-context-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of directories) {
    fs.mkdirSync(path.join(root, ...directory.split('/')), { recursive: true });
  }
  return root;
}

function realDirectory(root: string, cwdRelative: string): string {
  return path.join(fs.realpathSync.native(root), ...cwdRelative.split('/'));
}

function installation(
  sessionId: string,
  cwdRelative: string,
  operationId = `op-${sessionId}`,
) {
  const binding = {
    tenantId: BOOT.tenantId,
    workspaceId: BOOT.workspaceId,
    workspaceGeneration: BOOT.workspaceGeneration,
    storageId: BOOT.storageId,
    cwdRelative,
    contextConfigRef: 'config:bundle-3@r12',
    contextRevision: '1',
  };
  return {
    protocolVersion: 3,
    managedContext: MANAGED_CONTEXT_PROTOCOL,
    operationId,
    sessionId,
    binding,
    contextDigest: computeManagedContextDigest(binding),
  };
}

/** `installation` carrying the workspace contextConfigRef, for the digest-gated boot. */
function workspaceInstallation(
  sessionId: string,
  cwdRelative: string,
  operationId = `op-${sessionId}`,
) {
  const request = installation(sessionId, cwdRelative, operationId);
  const binding = {
    ...request.binding,
    contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
  };
  return {
    ...request,
    binding,
    contextDigest: computeManagedContextDigest(binding),
  };
}

/** Activation request for a workspaceInstallation-installed Session. */
function workspaceActivation(
  request: ReturnType<typeof workspaceInstallation>,
  operation = 'activate',
) {
  return {
    protocolVersion: 1,
    operation,
    sessionId: request.sessionId,
    contextDigest: request.contextDigest,
    contextConfigRef: request.binding.contextConfigRef,
    profile: WORKSPACE_EXECUTION_PROFILE,
  };
}

function shell(sessionId: string, callId: string, command: string) {
  return {
    protocolVersion: 2,
    reference: {
      sessionId,
      promptId: 'prompt-1',
      callId,
      argsDigest: `digest-${callId}`,
    },
    toolName: 'run_shell_command',
    input: { command },
  };
}

/**
 * A shell command that writes the session and project directory its shell
 * sees to `file`, in any shell the Shell tool picks.
 */
function writeShellEnvironment(file: string): string {
  const script =
    "process.stdout.write([process.env.QWEN_CODE_SESSION_ID, process.env.QWEN_CODE_PROJECT_DIR].join('|'))";
  return `"${process.execPath}" -e "${script}" > ${file}`;
}

/** The session a Runtime Session's calls run as. */
function sessionKey(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `${BOOT.runtimeInstanceId}.${digest.slice(0, 32)}`;
}

function tools(directory: string) {
  return createManagedToolSet(directory, 'runtime-01');
}

function symlinkDirectory(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

describe('Managed context worker boot', () => {
  it.each(fixtures.bootCases)(
    'reads the $id boot case from standard input',
    async (fixture) => {
      const read = readManagedRuntimeWorkerBoot(
        Readable.from([JSON.stringify(fixture.boot)]),
      );
      if (fixture.valid) {
        await expect(read).resolves.toStrictEqual(fixture.boot);
      } else {
        await expect(read).rejects.toThrow(
          'Managed Runtime worker boot payload is invalid.',
        );
      }
    },
  );

  it.each([
    ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
    ['a byte that is never UTF-8', Buffer.from([0xff])],
  ])('refuses a boot v2 document with %s', async (_label, bytes) => {
    const [before, after] = JSON.stringify({
      ...BOOT,
      mountRoot: '/mnt/X',
    }).split('X');
    const document = Buffer.concat([
      Buffer.from(before!),
      bytes,
      Buffer.from(after!),
    ]);

    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([document])),
    ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
  });

  it('answers ready v2 and serves exactly the boot v2 routes', async () => {
    const worker = await startManagedRuntimeAttestationWorker(BOOT);
    openWorkers.add(worker);
    const origin = worker.ready.url;

    expect(isManagedContextReady(worker.ready, BOOT)).toBe(true);
    expect(Object.keys(worker.ready)).toEqual([
      'type',
      'version',
      'managedContext',
      'runtimeInstanceId',
      'runtimeIncarnation',
      'leaseId',
      'epoch',
      'url',
    ]);
    expect(await post(origin, ATTEST, CANONICAL_ATTESTATION)).toHaveProperty(
      'status',
      200,
    );
    const undeclared = [
      '/internal/managed-runtime/v2/attest',
      `${ATTEST}/`,
      `${ATTEST}?check=1`,
      `${CONTEXT}/`,
      '/internal/managed-runtime/v3/execute',
      '/health',
    ];
    const answers = [];
    for (const route of undeclared) {
      answers.push(
        await emptyAnswer(
          route,
          await post(origin, route, CANONICAL_ATTESTATION),
        ),
      );
    }
    answers.push(
      await emptyAnswer(
        'GET',
        await fetch(`${origin}${ATTEST}`, { headers: HEADERS }),
      ),
    );
    const toolStatuses = [];
    for (const route of [EXECUTE, STATUS, CANCEL]) {
      toolStatuses.push((await post(origin, route, {})).status);
    }

    expect(answers).toStrictEqual(
      [...undeclared, 'GET'].map((route) => ({
        route,
        status: 404,
        body: '',
        cacheControl: 'no-store',
      })),
    );
    expect(toolStatuses).toEqual([400, 400, 400]);
  });

  it('mounts Tool v3 when a local publisher is injected', async () => {
    const worker = await startManagedRuntimeAttestationWorker(BOOT, {
      prepare: async () => {
        throw new Error('unexpected capture');
      },
      accept: async () => {
        throw new Error('unexpected receipt');
      },
    });
    openWorkers.add(worker);
    const response = await post(
      worker.ready.url,
      '/internal/managed-runtime/v3/status',
      {
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        reference: {
          sessionId: 'runtime-session-a',
          promptId: 'turn-a',
          callId: 'call-a',
          argsDigest:
            '424b16b9aa8d9f0648c8b2e91ecd9fb09faba205685214a7ccb01702b3dd0ce8',
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      protocolVersion: 3,
      toolResult: 'managed-tool-result/1',
      state: 'unknown',
    });
  });

  it('keeps both publication install routes on the standalone worker', async () => {
    const worker = await startManagedRuntimeAttestationWorker(
      { ...BOOT, capabilityDigest: WORKSPACE_CAPABILITY_DIGEST },
      undefined,
      new ManagedShellPublisherRegistry(),
    );
    openWorkers.add(worker);
    for (const route of [
      MANAGED_SHELL_PUBLISHER_ROUTE,
      PUBLICATION_INSTALL_ROUTE,
    ]) {
      const response = await post(worker.ready.url, route.path, {});
      expect([400, 409]).toContain(response.status);
    }
  });

  it('answers 404 to the v3 routes under boot v1', async () => {
    const origin = await startWorker({
      type: 'boot',
      version: 1,
      token: BOOT.token,
      runtimeInstanceId: BOOT.runtimeInstanceId,
      runtimeIncarnation: BOOT.runtimeIncarnation,
      leaseId: BOOT.leaseId,
      epoch: BOOT.epoch,
      provisionRequestId: BOOT.provisionRequestId,
      tenantId: BOOT.tenantId,
      workspaceId: BOOT.workspaceId,
      workspaceGeneration: BOOT.workspaceGeneration,
      workspaceCwd: BOOT.mountRoot,
      capabilityDigest: BOOT.capabilityDigest,
      isolationClass: BOOT.isolationClass,
    });

    const answers = [];
    for (const route of [ATTEST, CONTEXT]) {
      answers.push(
        await emptyAnswer(
          route,
          await post(origin, route, CANONICAL_ATTESTATION),
        ),
      );
    }

    expect(answers).toStrictEqual(
      [ATTEST, CONTEXT].map((route) => ({
        route,
        status: 404,
        body: '',
        cacheControl: 'no-store',
      })),
    );
  });

  it('refuses an invalid boot v2 document before opening a listener', async () => {
    const listeners = () =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === 'TCPServerWrap').length;
    const before = listeners();

    await expect(
      startManagedRuntimeAttestationWorker({ ...BOOT, token: 'a b' }),
    ).rejects.toThrow('Managed context boot document is invalid.');
    expect(listeners()).toBe(before);
  });
});

describe('Managed context worker routes', () => {
  let origin: string;
  let worker: ManagedRuntimeAttestationWorkerHandle;

  beforeAll(async () => {
    worker = await startManagedRuntimeAttestationWorker(BOOT);
    origin = worker.ready.url;
  });

  afterAll(async () => {
    await worker.close();
  });

  it.each(fixtures.attestationCases)(
    'answers the $id attestation case over HTTP',
    async (fixture) => {
      await expectAnswer(
        await post(origin, ATTEST, fixture.body),
        fixture.expected,
      );
    },
  );

  it.each([ATTEST, CONTEXT])(
    'applies the request discipline of the owned routes to %s',
    async (route) => {
      const { authorization: _, ...unsigned } = HEADERS;
      const { 'cache-control': __, ...cacheable } = HEADERS;
      const cases: Array<[Record<string, string>, string, number, string]> = [
        [unsigned, '{}', 401, 'managed_runtime_unauthorized'],
        [
          { ...HEADERS, authorization: 'Bearer other-token' },
          '{}',
          401,
          'managed_runtime_unauthorized',
        ],
        [cacheable, '{}', 400, 'managed_runtime_attestation_invalid'],
        [
          { ...HEADERS, 'x-qwen-managed-lease-id': 'lease-02' },
          '{}',
          409,
          'managed_runtime_identity_conflict',
        ],
        [
          { ...HEADERS, 'x-qwen-managed-lease-epoch': '04' },
          '{}',
          409,
          'managed_runtime_identity_conflict',
        ],
        [HEADERS, '{', 400, 'managed_runtime_attestation_invalid'],
        [HEADERS, '"text"', 400, 'managed_runtime_attestation_invalid'],
        [
          { ...HEADERS, 'content-type': 'text/plain' },
          '{}',
          400,
          'managed_runtime_attestation_invalid',
        ],
        [
          { ...HEADERS, 'content-encoding': 'gzip' },
          '{}',
          400,
          'managed_runtime_attestation_invalid',
        ],
        [
          HEADERS,
          '{}'.padEnd(16 * 1024 + 1, ' '),
          413,
          'managed_runtime_attestation_too_large',
        ],
      ];
      const answers = [];
      for (const [headers, body] of cases) {
        const response = await post(origin, route, body, headers);
        answers.push({
          status: response.status,
          code: ((await response.json()) as { code: string }).code,
          cacheControl: response.headers.get('cache-control'),
        });
      }

      expect(answers).toStrictEqual(
        cases.map(([, , status, code]) => ({
          status,
          code,
          cacheControl: 'no-store',
        })),
      );
    },
  );

  it('accepts a request body of exactly 16 KiB', async () => {
    const body = JSON.stringify(CANONICAL_ATTESTATION).padEnd(16 * 1024, ' ');

    expect((await post(origin, ATTEST, body)).status).toBe(200);
  });
});

describe('Managed context installation', () => {
  let mountRoot: string;

  beforeAll(() => {
    mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-context-'));
    expect(FIXTURE_DIRECTORIES.size).toBeGreaterThan(1);
    for (const directory of FIXTURE_DIRECTORIES) {
      fs.mkdirSync(path.join(mountRoot, ...directory.split('/')), {
        recursive: true,
      });
    }
  });

  afterAll(() => {
    fs.rmSync(mountRoot, { recursive: true, force: true });
  });

  it.each(fixtures.installationSequences)(
    'replays the $id installation sequence over HTTP',
    async (sequence) => {
      const origin = await startWorker({ ...BOOT, mountRoot });
      for (const step of sequence.steps) {
        await expectAnswer(
          await post(origin, CONTEXT, step.request),
          step.expected,
        );
      }
    },
  );

  it('refuses a directory that does not exist, and the same request succeeds after a repair', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const request = installation('session-1', 'services/missing');

    const refused = await post(origin, CONTEXT, request);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toStrictEqual(UNAVAILABLE);

    fs.mkdirSync(path.join(root, 'services', 'missing'));
    const installed = await post(origin, CONTEXT, request);
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({
      operationId: request.operationId,
      sessionId: 'session-1',
      contextDigest: request.contextDigest,
    });
  });

  it.each([
    [
      'a file, even an executable one',
      (root: string) =>
        fs.writeFileSync(path.join(root, 'file'), '', { mode: 0o755 }),
    ],
    [
      'a link to a directory inside the Workspace',
      (root: string) =>
        symlinkDirectory(path.join(root, 'services'), path.join(root, 'file')),
    ],
    [
      'a link that leaves the Workspace',
      (root: string) =>
        symlinkDirectory(workspace(['api']), path.join(root, 'file')),
    ],
  ])('refuses %s', async (_label, create) => {
    const root = workspace();
    create(root);
    const origin = await startWorker({ ...BOOT, mountRoot: root });

    expect(await refusals(origin, ['file', 'file/api'])).toStrictEqual([
      UNAVAILABLE,
      UNAVAILABLE,
    ]);
  });

  it('refuses a directory whose name differs from the binding', async () => {
    const root = workspace(['Services/Api']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const exact = await post(
      origin,
      CONTEXT,
      installation('session-1', 'Services/Api'),
    );
    const other = await post(
      origin,
      CONTEXT,
      installation('session-2', 'services/api'),
    );

    // A case-sensitive file system has no services/api. On macOS and Windows
    // the real path reports Services/Api, which differs from the binding.
    // A case-folding volume on Linux echoes the name it is given; there
    // services/api is the same directory, and the worker accepts it.
    let reported: string | undefined;
    try {
      reported = fs.realpathSync.native(path.join(root, 'services', 'api'));
    } catch {
      reported = undefined;
    }
    const echoed = reported === realDirectory(root, 'services/api');

    expect(exact.status).toBe(200);
    expect(other.status).toBe(echoed ? 200 : 409);
  });

  it.skipIf(process.platform === 'win32')(
    "refuses a mount root in the other platform's form without resolving it",
    async () => {
      // As a relative path, the root would resolve against the working
      // directory.
      const realpath = vi.spyOn(fs.promises, 'realpath');
      onTestFinished(() => realpath.mockRestore());
      const origin = await startWorker({ ...BOOT, mountRoot: 'C:\\ws' });

      expect(await refusals(origin, ['services/api'])).toStrictEqual([
        UNAVAILABLE,
      ]);
      expect(realpath).not.toHaveBeenCalled();
    },
  );

  it('follows a link at the mount root itself', async () => {
    const target = workspace();
    const link = path.join(workspace([]), 'mount');
    symlinkDirectory(target, link);
    const origin = await startWorker({ ...BOOT, mountRoot: link });

    const response = await post(
      origin,
      CONTEXT,
      installation('session-1', 'services/api'),
    );
    expect(response.status).toBe(200);
    const executed = await post(
      origin,
      EXECUTE,
      shell('session-1', 'call-1', 'echo probe > probe.txt'),
    );
    expect(executed.status).toBe(200);
    expect(
      fs.existsSync(
        path.join(realDirectory(target, 'services/api'), 'probe.txt'),
      ),
    ).toBe(true);
  });

  it.each([
    ['missing', (root: string) => path.join(root, 'missing')],
    [
      'a file',
      (root: string) => {
        fs.writeFileSync(path.join(root, 'file'), '');
        return path.join(root, 'file');
      },
    ],
  ])('refuses a mount root that is %s', async (_label, mount) => {
    const origin = await startWorker({
      ...BOOT,
      mountRoot: mount(workspace()),
    });

    expect(await refusals(origin, ['.', 'services/api'])).toStrictEqual([
      UNAVAILABLE,
      UNAVAILABLE,
    ]);
  });

  it('pins the mount root at its first verification', async () => {
    const parent = workspace([]);
    const root = path.join(parent, 'mount');
    fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    expect(
      (await post(origin, CONTEXT, installation('session-1', 'services/api')))
        .status,
    ).toBe(200);

    fs.renameSync(root, path.join(parent, 'previous'));
    fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
    const replaced = await post(
      origin,
      CONTEXT,
      installation('session-2', 'services/api'),
    );
    const tool = await post(
      origin,
      EXECUTE,
      shell('session-1', 'call-1', 'echo probe > probe.txt'),
    );

    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toStrictEqual(UNAVAILABLE);
    expect(tool.status).toBe(409);
    expect(await tool.json()).toStrictEqual(UNAVAILABLE);
    expect(fs.existsSync(path.join(root, 'services', 'api', 'probe.txt'))).toBe(
      false,
    );
  });

  it('records neither the operation nor the Session of a refused installation', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });

    const refused = await post(
      origin,
      CONTEXT,
      installation('session-1', 'services/missing', 'op-1'),
    );
    // Had either been recorded, another context under the same operation and
    // Session would conflict.
    const other = await post(
      origin,
      CONTEXT,
      installation('session-1', 'services/api', 'op-1'),
    );

    expect(await refused.json()).toStrictEqual(UNAVAILABLE);
    expect(other.status).toBe(200);
  });

  it('refuses a directory whose access check fails', async () => {
    const root = workspace();
    const access = vi
      .spyOn(fs.promises, 'access')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    onTestFinished(() => access.mockRestore());
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const request = installation('session-1', 'services/api');

    const refused = await post(origin, CONTEXT, request);
    const repaired = await post(origin, CONTEXT, request);

    expect(access).toHaveBeenCalledWith(
      realDirectory(root, 'services/api'),
      fs.constants.R_OK | fs.constants.X_OK,
    );
    expect(await refused.json()).toStrictEqual(UNAVAILABLE);
    expect(repaired.status).toBe(200);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a directory the worker cannot read',
    async () => {
      const root = workspace();
      const directory = path.join(root, 'services', 'api');
      fs.chmodSync(directory, 0o300);
      onTestFinished(() => fs.chmodSync(directory, 0o700));
      const origin = await startWorker({ ...BOOT, mountRoot: root });

      const response = await post(
        origin,
        CONTEXT,
        installation('session-1', 'services/api'),
      );
      expect(response.status).toBe(409);
    },
  );
});

describe('Managed context tool gate', () => {
  it('refuses a tool call for a Session without a context', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const call = shell('session-1', 'call-1', 'echo probe > probe.txt');

    const refused = await post(origin, EXECUTE, call);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toStrictEqual(UNAVAILABLE);
    const status = await post(origin, STATUS, {
      protocolVersion: 2,
      reference: call.reference,
    });
    expect(await status.json()).toStrictEqual({
      protocolVersion: 2,
      state: 'unknown',
    });
    expect(fs.readdirSync(root)).toEqual(['services']);
  });

  it("runs each Session's tools in its own effective directory", async () => {
    const root = workspace(['services/api', 'services/web']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    for (const [sessionId, cwdRelative] of [
      ['session-api', 'services/api'],
      ['session-web', 'services/web'],
      ['session-root', '.'],
    ]) {
      expect(
        (await post(origin, CONTEXT, installation(sessionId, cwdRelative)))
          .status,
      ).toBe(200);
    }

    for (const sessionId of ['session-api', 'session-web', 'session-root']) {
      const response = await post(
        origin,
        EXECUTE,
        shell(sessionId, `call-${sessionId}`, `echo ${sessionId} > probe.txt`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { executionStatus: 'success' },
      });
    }
    for (const [sessionId, cwdRelative] of [
      ['session-api', 'services/api'],
      ['session-web', 'services/web'],
      ['session-root', '.'],
    ]) {
      expect(
        fs
          .readFileSync(
            path.join(realDirectory(root, cwdRelative), 'probe.txt'),
            'utf8',
          )
          .trim(),
      ).toBe(sessionId);
    }
  });

  it("gives each Session's shells its own session and project directory", async () => {
    const root = workspace(['services/api', 'services/web']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const sessions = [
      ['session-api', 'services/api'],
      ['tenant/../session-web', 'services/web'],
    ] as const;
    for (const [index, [sessionId, cwdRelative]] of sessions.entries()) {
      await post(
        origin,
        CONTEXT,
        installation(sessionId, cwdRelative, `op-${index}`),
      );
    }
    const environment = async (index: number, callId: string) => {
      const [sessionId, cwdRelative] = sessions[index]!;
      await post(
        origin,
        EXECUTE,
        shell(sessionId, callId, writeShellEnvironment('env.txt')),
      );
      const directory = realDirectory(root, cwdRelative);
      const [session, projectDirectory] = fs
        .readFileSync(path.join(directory, 'env.txt'), 'utf8')
        .split('|');
      expect(projectDirectory).toBe(new Storage(directory).getProjectDir());
      return session;
    };

    const api = await environment(0, 'call-1');
    const web = await environment(1, 'call-2');
    const apiAgain = await environment(0, 'call-3');

    expect([api, web, apiAgain]).toEqual([
      sessionKey('session-api'),
      sessionKey('tenant/../session-web'),
      sessionKey('session-api'),
    ]);
  });

  it("keeps each Session's shell environment under concurrent calls", async () => {
    const directories = ['services/a', 'services/b', 'services/c'];
    const sessions = ['séance', 'сессия', '会话'];
    const root = workspace(directories);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    for (const [index, cwdRelative] of directories.entries()) {
      await post(
        origin,
        CONTEXT,
        installation(sessions[index]!, cwdRelative, `op-${index}`),
      );
    }
    const calls = [0, 1, 2, 0, 1, 2].map((index, call) => ({ index, call }));

    await Promise.all(
      calls.map(({ index, call }) =>
        post(
          origin,
          EXECUTE,
          shell(
            sessions[index]!,
            `call-${call}`,
            writeShellEnvironment(`env-${call}.txt`),
          ),
        ),
      ),
    );

    for (const { index, call } of calls) {
      const directory = realDirectory(root, directories[index]!);
      expect(
        fs.readFileSync(path.join(directory, `env-${call}.txt`), 'utf8'),
      ).toBe(
        `${sessionKey(sessions[index]!)}|${new Storage(directory).getProjectDir()}`,
      );
    }
  });

  it('writes, edits and reads a file in the Session directory', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const file = path.join(realDirectory(root, 'services/api'), 'notes.txt');
    const results = [];
    for (const [callId, toolName, input] of [
      ['call-1', 'write_file', { file_path: file, content: 'first draft' }],
      [
        'call-2',
        'edit',
        { file_path: file, old_string: 'first', new_string: 'final' },
      ],
      ['call-3', 'read_file', { file_path: file }],
    ] as const) {
      const response = await post(origin, EXECUTE, {
        ...shell('session-1', callId, ''),
        toolName,
        input,
      });
      results.push(await response.json());
    }

    expect(results).toMatchObject([
      { state: 'settled', result: { executionStatus: 'success' } },
      { state: 'settled', result: { executionStatus: 'success' } },
      { state: 'settled', result: { executionStatus: 'success' } },
    ]);
    expect(JSON.stringify(results[2])).toContain('final draft');
    expect(fs.readFileSync(file, 'utf8')).toBe('final draft');
  });

  it('globs inside the Session directory and answers Workspace-relative paths', async () => {
    const root = workspace(['services/api/src', 'services/web']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), '');
    fs.writeFileSync(path.join(root, 'services/api/package.json'), '{}');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    // Boot with the workspace capability so includeDirectories spans the
    // whole mount: the executor's Session pinning is load-bearing in this
    // configuration (legacy boots root the tool set at the Session itself,
    // where the sibling-isolation assertions cannot fail).
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install1 = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install1);
    await post(origin, ACTIVATION, workspaceActivation(install1));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const glob = (callId: string, input: Record<string, unknown>) => ({
      ...shell('session-1', callId, ''),
      toolName: 'glob',
      input,
    });

    const all = await (
      await post(origin, EXECUTE, glob('call-1', { pattern: '**/*' }))
    ).json();
    const sub = await (
      await post(
        origin,
        EXECUTE,
        glob('call-2', { pattern: '*.ts', path: 'src' }),
      )
    ).json();
    const outside = await (
      await post(
        origin,
        EXECUTE,
        glob('call-3', { pattern: '**/*', path: '..' }),
      )
    ).json();
    // Glob declares no `file_path`, so a stray one — ordinary schema confusion
    // with the file tools that share the turn — must not be read as a
    // traversal attempt that refuses the whole search.
    const strayFilePath = await (
      await post(
        origin,
        EXECUTE,
        glob('call-4', {
          pattern: '**/*.ts',
          file_path: '../web/secret.txt',
        }),
      )
    ).json();

    expect(all.result.executionStatus).toBe('success');
    const text = JSON.stringify(all);
    expect(text).toContain('src/index.ts');
    expect(text).not.toContain('secret.txt');
    expect(text).not.toContain(realDirectory(root, 'services/api'));
    expect(sub.result.executionStatus).toBe('success');
    expect(JSON.stringify(sub)).toContain('index.ts');
    expect(outside.result.executionStatus).toBe('error');
    expect(JSON.stringify(outside)).toContain(
      'not within the Session working directory',
    );
    expect(strayFilePath.result.executionStatus).toBe('success');
    expect(JSON.stringify(strayFilePath)).toContain('index.ts');
    expect(JSON.stringify(strayFilePath)).not.toContain('secret.txt');
  });

  it('refuses a read whose file is a symlink escaping the Workspace', async () => {
    const root = workspace(['services/api']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const read = (callId: string, filePath: string) => ({
      ...shell('session-1', callId, ''),
      toolName: 'read_file',
      input: { file_path: filePath },
    });

    // A planted symlink targeting a file outside the mount must not be
    // followed.
    const outside = workspace(['staged']);
    fs.writeFileSync(
      path.join(outside, 'staged/host-secret.txt'),
      'host-secret',
    );
    fs.symlinkSync(
      path.join(outside, 'staged/host-secret.txt'),
      path.join(root, 'services/api/AGENTS.md'),
    );
    const escaped = await (
      await post(origin, EXECUTE, read('call-1', 'AGENTS.md'))
    ).json();
    expect(escaped.result.executionStatus).toBe('error');
    expect(JSON.stringify(escaped)).not.toContain('host-secret');

    // Positive control: a regular file inside the Session still reads.
    fs.rmSync(path.join(root, 'services/api/AGENTS.md'));
    fs.writeFileSync(
      path.join(root, 'services/api/AGENTS.md'),
      'in-bounds-rules',
    );
    const plain = await (
      await post(origin, EXECUTE, read('call-2', 'AGENTS.md'))
    ).json();
    expect(plain.result.executionStatus).toBe('success');
    expect(JSON.stringify(plain)).toContain('in-bounds-rules');
  });
  it('allows a pattern segment that merely starts with `..`', async () => {
    // The containment guard matches `..` by segment equality, so `a/..b/*.ts`
    // is legitimate; nothing else pinned that before a hardening edit could
    // broaden the check to a substring match and silently refuse it.
    const root = workspace(['services/api/src']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), '');
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));

    const allowed = await (
      await post(origin, EXECUTE, {
        ...shell('session-1', 'call-allow', ''),
        toolName: 'glob',
        input: { pattern: 'a/..b/*.ts' },
      })
    ).json();

    expect(JSON.stringify(allowed)).not.toContain(
      'must stay within the Session working directory',
    );
    expect(allowed.result.executionStatus).not.toBe('error');
  });

  it('refuses a glob that would search or report outside the Session directory', async () => {
    const root = workspace(['services/api/src', 'services/web']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), '');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    // Same workspace-capability boot as the sibling test: the refusal cases
    // must hold when the registered directories span the whole mount.
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install1 = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install1);
    await post(origin, ACTIVATION, workspaceActivation(install1));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const glob = async (callId: string, input: Record<string, unknown>) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName: 'glob',
          input,
        })
      ).json();

    // `pattern` is a search root of its own: glob resolves `..` against the
    // filesystem and treats an absolute pattern as absolute.
    const dotdot = await glob('call-1', { pattern: '../**/*' });
    const absolute = await glob('call-2', { pattern: '/etc/host*' });
    // A failed search still reaches the model and the durable record.
    const missing = await glob('call-3', { pattern: '**/*', path: 'nope' });
    // A link inside the Session context that points at a sibling Session.
    const linked = await glob('call-4', { pattern: '*', path: 'peek' });
    // The `..` alternative of a brace pair is refused at the input gate.
    const braced = await glob('call-5', { pattern: '{.,..}/**/*' });
    // A symlink named as a literal pattern segment is resolved by the
    // filesystem (`follow: false` governs links met during a globstar walk,
    // not this one), so the walk prunes it: nothing beyond it is searched.
    const literalLink = await glob('call-6', { pattern: 'peek/**/*' });
    // An outward link is reported under its own in-Session name, disclosing
    // nothing: merely listing it must not fail the whole glob.
    const listed = await glob('call-7', { pattern: '**/*' });
    // A brace pair composes an absolute search root the literal segment
    // check cannot see: it must be refused at the input gate (the pattern
    // message), never reach the search, and never become a host-filesystem
    // existence oracle through the output guard.
    const bracedAbsolute = await glob('call-8', {
      pattern: '{/etc,/zz-nonexistent}/host*',
    });
    // Character-class spellings of `..` pass the segment gate;
    // the contained walk answers an existing and a missing outside file
    // identically, so neither is an existence oracle.
    const classExisting = await glob('call-9', {
      pattern: '[.][.]/web/secret.txt',
    });
    const classMissing = await glob('call-10', {
      pattern: '[.][.]/web/nope.txt',
    });
    const escapedWalk = await glob('call-11', {
      pattern: '\\.\\./web/secret.txt',
    });
    const escapedMissing = await glob('call-13', {
      pattern: '\\.\\./web/nope.txt',
    });
    // Range expansion is bounded before anything searches it.
    const rangeBomb = await glob('call-12', { pattern: '{1..100000}/passwd' });

    expect(dotdot.result.executionStatus).toBe('error');
    expect(absolute.result.executionStatus).toBe('error');
    expect(missing.result.executionStatus).toBe('error');
    expect(linked.result.executionStatus).toBe('error');
    expect(braced.result.executionStatus).toBe('error');
    expect(literalLink.result.executionStatus).toBe('success');
    expect(JSON.stringify(literalLink)).toContain('No files found');
    // The two answers differ only by the pattern each one echoes back.
    expect(classExisting.result.executionStatus).toBe('success');
    expect(JSON.stringify(classExisting)).toContain('No files found');
    expect(
      JSON.stringify(classExisting.result).replaceAll('secret.txt', 'nope.txt'),
    ).toBe(JSON.stringify(classMissing.result));
    for (const response of [escapedWalk, escapedMissing]) {
      expect(response.result.executionStatus).toBe('error');
      expect(JSON.stringify(response)).toContain(
        'Glob pattern must stay within the Session working directory.',
      );
    }
    expect(rangeBomb.result.executionStatus).toBe('error');
    expect(JSON.stringify(rangeBomb)).toContain('64 brace alternatives');
    for (const response of [
      dotdot,
      absolute,
      missing,
      linked,
      braced,
      literalLink,
      classMissing,
      escapedWalk,
      escapedMissing,
      rangeBomb,
    ]) {
      const text = JSON.stringify(response);
      expect(text).not.toContain('secret.txt');
      expect(text).not.toContain(realDirectory(root, 'services/api'));
      expect(text).not.toContain('/etc/');
    }
    expect(listed.result.executionStatus).toBe('success');
    expect(JSON.stringify(listed)).toContain('src/index.ts');
    expect(bracedAbsolute.result.executionStatus).toBe('error');
    expect(JSON.stringify(bracedAbsolute)).toContain(
      'Glob pattern must stay within the Session working directory.',
    );
    expect(JSON.stringify(bracedAbsolute)).not.toContain('host');
  });

  it('never counts an outside match the display sample would not show', async () => {
    // glob judges up to 1000 collected entries but displays only the newest
    // 100; an outside match must not reach the count either.
    const root = workspace(['services/api/src', 'services/web']);
    for (let index = 0; index < 137; index++)
      fs.writeFileSync(path.join(root, `services/api/src/f${index}.ts`), '');
    const sibling = path.join(root, 'services/web/old.ts');
    fs.writeFileSync(sibling, 'sibling');
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(sibling, past, past);
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    await post(origin, CONTEXT, installation('session-2', 'services/web'));

    const response = await (
      await post(origin, EXECUTE, {
        ...shell('session-1', 'call-1', ''),
        toolName: 'glob',
        input: { pattern: '{**/*.ts,peek/**/*}' },
      })
    ).json();

    expect(response.result.executionStatus).toBe('success');
    const text = JSON.stringify(response);
    expect(text).toContain('Found 137 file(s)');
    expect(text).not.toContain('old.ts');
  });

  it.each([
    ['read_file', {}],
    ['write_file', { content: 'x' }],
    ['edit', { old_string: 'x', new_string: 'y' }],
  ] as const)(
    'does not expose Runtime paths in %s resolution errors',
    async (toolName, args) => {
      const root = workspace();
      fs.writeFileSync(path.join(root, 'services/api/package.json'), '{}');
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      const answer = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName,
          input: { file_path: 'package.json/main', ...args },
        })
      ).json();
      expect(answer.result.executionStatus).toBe('error');
      expect(answer.result.error.message).toContain('ENOTDIR');
      expect(JSON.stringify(answer)).not.toContain(realDirectory(root, '.'));
    },
  );

  it('refuses read_file through a link to another Session installed in the same worker', async () => {
    // The glob admission makes the link enumerable; reading through it must
    // not hand a sibling Session's content to a files-only Session.
    const root = workspace(['services/api/src', 'services/web']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install1 = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install1);
    await post(origin, ACTIVATION, workspaceActivation(install1));
    // The sibling directory is protected because it is another installed
    // Session's directory in this worker, not merely part of the mount.
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const read = async (callId: string, filePath: string) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName: 'read_file',
          input: { file_path: filePath },
        })
      ).json();

    const through = await read('call-1', 'peek/secret.txt');
    expect(through.result.executionStatus).toBe('error');
    expect(JSON.stringify(through)).not.toContain('sibling');
    expect(JSON.stringify(through)).not.toContain(
      realDirectory(root, 'services/api'),
    );
    expect(JSON.stringify(through)).toContain(
      "Path 'peek/secret.txt' is not within the Session working directory.",
    );
    // A nonexistent path keeps the tool's own not-found answer, not a
    // traversal accusation (realpathIfPresent's ENOENT fallback).
    const missing = await read('call-2', 'src/nope.txt');
    expect(JSON.stringify(missing)).not.toContain(
      'not within the Session working directory',
    );
    // Control: an ordinary in-Session read still works.
    const own = await read('call-3', 'src/index.ts');
    expect(own.result.executionStatus).toBe('success');
    expect(JSON.stringify(own)).toContain('mine');
  });

  it('refuses write_file through a link to another Session installed in the same worker', async () => {
    // A create's leaf does not exist yet, so containment must resolve the
    // deepest existing ancestor: `peek/pwned.txt` is lexically inside the
    // Session but lands in the sibling through the link.
    const root = workspace(['services/api/src', 'services/web']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install1 = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install1);
    await post(origin, ACTIVATION, workspaceActivation(install1));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );

    const created = await (
      await post(origin, EXECUTE, {
        ...shell('session-1', 'call-1', ''),
        toolName: 'write_file',
        input: {
          file_path: 'peek/pwned.txt',
          content: 'written by session-1',
        },
      })
    ).json();
    expect(created.result.executionStatus).toBe('error');
    expect(JSON.stringify(created)).toContain(
      "Path 'peek/pwned.txt' is not within the Session working directory.",
    );
    expect(fs.existsSync(path.join(root, 'services/web/pwned.txt'))).toBe(
      false,
    );

    // Control: an ordinary in-Session create still works.
    const own = await (
      await post(origin, EXECUTE, {
        ...shell('session-1', 'call-2', ''),
        toolName: 'write_file',
        input: { file_path: 'src/new.txt', content: 'mine too' },
      })
    ).json();
    expect(own.result.executionStatus).toBe('success');
    expect(
      fs.readFileSync(path.join(root, 'services/api/src/new.txt'), 'utf8'),
    ).toBe('mine too');
  });

  it.skipIf(process.platform === 'win32').each([
    ['read_file', {}],
    ['write_file', { content: 'new fixture' }],
    ['edit', { old_string: 'original fixture', new_string: 'updated fixture' }],
  ] as const)(
    'refuses %s when the normalized path belongs to another Session',
    async (toolName, args) => {
      const root = workspace(['services/api', 'services/web']);
      const original = path.join(root, 'services/web/note.txt');
      const created = path.join(root, 'services/web/new.txt');
      fs.writeFileSync(original, 'original fixture');
      fs.symlinkSync('../web', path.join(root, 'services/api/shared notes'));
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      const filePath = String.raw`shared\ notes/${toolName === 'write_file' ? 'new' : 'note'}.txt`;
      const answer = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName,
          input: { file_path: filePath, ...args },
        })
      ).json();

      expect(answer.result.executionStatus).toBe('error');
      expect(answer.result.error.message).toBe(
        `Path '${filePath}' is not within the Session working directory.`,
      );
      expect(JSON.stringify(answer)).not.toContain('original fixture');
      expect(fs.readFileSync(original, 'utf8')).toBe('original fixture');
      expect(fs.existsSync(created)).toBe(false);
    },
  );

  it('refuses an absolute file_path the same way it refuses a relative one', async () => {
    // The containment is a security decision, so it judges every spelling a
    // producer can send. The shipped Harness normalizes to relative paths,
    // but the worker contract does not require it: the Java IT drives the
    // Broker's provider API with an absolute `file_path`.
    const root = workspace(['services/api', 'services/web']);
    const outside = workspace(['host']);
    fs.writeFileSync(path.join(root, 'services/web/note.txt'), 'sibling text');
    fs.writeFileSync(path.join(outside, 'host/secret.txt'), 'host text');
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install);
    await post(origin, ACTIVATION, workspaceActivation(install));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const execute = async (
      callId: string,
      toolName: string,
      input: Record<string, unknown>,
    ) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName,
          input,
        })
      ).json();

    const sibling = await execute('call-1', 'read_file', {
      file_path: realDirectory(root, 'services/web/note.txt'),
    });
    expect(sibling.result.executionStatus).toBe('error');
    expect(sibling.result.error.message).toBe(
      `Path '${realDirectory(root, 'services/web/note.txt')}' is not within the Session working directory.`,
    );
    expect(JSON.stringify(sibling)).not.toContain('sibling text');

    const created = path.join(root, 'services/web/pwned.txt');
    const write = await execute('call-2', 'write_file', {
      file_path: created,
      content: 'dummy',
    });
    expect(write.result.executionStatus).toBe('error');
    expect(fs.existsSync(created)).toBe(false);

    const escaped = await execute('call-3', 'read_file', {
      file_path: realDirectory(outside, 'host/secret.txt'),
    });
    expect(escaped.result.executionStatus).toBe('error');
    expect(JSON.stringify(escaped)).not.toContain('host text');

    // The in-mount escape valve survives: a linked dependency's real
    // location is still readable by absolute path.
    fs.mkdirSync(path.join(root, 'packages/ui/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/ui/src/index.ts'), 'ui-source');
    const shared = await execute('call-4', 'read_file', {
      file_path: realDirectory(root, 'packages/ui/src/index.ts'),
    });
    expect(shared.result.executionStatus).toBe('success');
    expect(JSON.stringify(shared)).toContain('ui-source');
  });

  it('answers an out-of-boundary file_path with the refusal, not the tool diagnosis', async () => {
    // `write_file` rejects a directory at build time and its own message
    // quotes the resolved host path. The boundary must be decided first, or
    // the model and the durable v3 record learn the mount root and a sibling
    // Session's real directory name.
    const root = workspace(['services/api', 'services/web']);
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install);
    await post(origin, ACTIVATION, workspaceActivation(install));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );

    const answer = await (
      await post(origin, EXECUTE, {
        ...shell('session-1', 'call-1', ''),
        toolName: 'write_file',
        input: { file_path: '../web', content: 'pwned' },
      })
    ).json();

    expect(answer.result.executionStatus).toBe('error');
    expect(answer.result.error.message).toBe(
      "Path '../web' is not within the Session working directory.",
    );
    expect(JSON.stringify(answer)).not.toContain(realDirectory(root, '.'));
    expect(JSON.stringify(answer)).not.toContain('is a directory, not a file');
  });

  it.skipIf(process.platform === 'win32')(
    'retains a literal backslash left by file-tool path normalization',
    async () => {
      const root = workspace(['services/api', 'services/web']);
      fs.mkdirSync(path.join(root, String.raw`services/api/shared\ notes`));
      fs.symlinkSync('../web', path.join(root, 'services/api/shared notes'));
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      const answer = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName: 'write_file',
          input: {
            file_path: String.raw`shared\\ notes/new.txt`,
            content: 'owned fixture',
          },
        })
      ).json();

      expect(answer.result.executionStatus).toBe('success');
      expect(
        fs.readFileSync(
          path.join(root, String.raw`services/api/shared\ notes/new.txt`),
          'utf8',
        ),
      ).toBe('owned fixture');
      expect(fs.existsSync(path.join(root, 'services/web/new.txt'))).toBe(
        false,
      );
    },
  );

  it.each(['own', 'sibling'])(
    'resolves a dangling leaf before writing to the %s directory',
    async (owner) => {
      const root = workspace(['services/api/src', 'services/web']);
      const target = owner === 'own' ? 'src/new.txt' : '../web/new.txt';
      fs.symlinkSync(target, path.join(root, 'services/api/dangling'));
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      const answer = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName: 'write_file',
          input: { file_path: 'dangling', content: 'dummy' },
        })
      ).json();
      const actual = path.resolve(root, 'services/api', target);
      if (owner === 'own') {
        expect(answer.result.executionStatus).toBe('success');
        expect(fs.readFileSync(actual, 'utf8')).toBe('dummy');
      } else {
        expect(answer.result.executionStatus).toBe('error');
        expect(JSON.stringify(answer)).toContain(
          'not within the Session working directory',
        );
        expect(fs.existsSync(actual)).toBe(false);
      }
    },
  );

  it.each(['missing', 'linked', 'dangling'])(
    'contains a %s sibling without refusing shared dependencies',
    async (state) => {
      const root = workspace([
        'services/api/src',
        'services/web',
        'packages/ui/src',
      ]);
      fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
      fs.writeFileSync(path.join(root, 'services/web/notes.txt'), 'peer-data');
      fs.writeFileSync(
        path.join(root, 'packages/ui/src/index.ts'),
        'ui-source',
      );
      fs.symlinkSync('../web', path.join(root, 'services/api/peek'));
      fs.mkdirSync(path.join(root, 'services/api/node_modules/@acme'), {
        recursive: true,
      });
      symlinkDirectory(
        path.join(root, 'packages/ui'),
        path.join(root, 'services/api/node_modules/@acme/ui'),
      );
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      if (state === 'missing') {
        fs.rmSync(path.join(root, 'services/web'), { recursive: true });
      } else {
        fs.renameSync(
          path.join(root, 'services/web'),
          path.join(root, 'services/retired-web'),
        );
        fs.symlinkSync('retired-web', path.join(root, 'services/web'));
        if (state === 'dangling')
          fs.rmSync(path.join(root, 'services/retired-web'), {
            recursive: true,
          });
      }
      const answer = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName: state === 'linked' ? 'read_file' : 'write_file',
          input:
            state === 'linked'
              ? { file_path: 'peek/notes.txt' }
              : { file_path: 'peek/new.txt', content: 'dummy' },
        })
      ).json();
      expect(answer.result.executionStatus).toBe('error');
      expect(JSON.stringify(answer)).not.toContain('peer-data');
      expect(fs.existsSync(path.join(root, 'services/web/new.txt'))).toBe(
        false,
      );
      if (state === 'missing')
        expect(fs.existsSync(path.join(root, 'services/web'))).toBe(false);
      if (state === 'dangling')
        expect(fs.existsSync(path.join(root, 'services/retired-web'))).toBe(
          false,
        );
      const own = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-2', ''),
          toolName: 'read_file',
          input: { file_path: 'src/index.ts' },
        })
      ).json();
      expect(own.result.executionStatus).toBe('success');
      expect(JSON.stringify(own)).toContain('mine');
      const linkedDep = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-3', ''),
          toolName: 'read_file',
          input: { file_path: 'node_modules/@acme/ui/src/index.ts' },
        })
      ).json();
      expect(linkedDep.result.executionStatus).toBe('success');
      expect(JSON.stringify(linkedDep)).toContain('ui-source');
    },
  );

  it('reads through a symlink to a shared directory that is no Session', async () => {
    // The Session boundary protects sibling SESSIONS. A linked dependency
    // inside the same mount (`node_modules/@acme/ui -> ../../packages/ui`)
    // is no Session: refusing it narrows every /1 workspace that reads
    // through linked dependencies — the pre-containment behavior.
    const root = workspace([
      'services/api/src',
      'services/web',
      'packages/ui/src',
    ]);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    fs.writeFileSync(path.join(root, 'packages/ui/src/index.ts'), 'ui-source');
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    fs.mkdirSync(path.join(root, 'services/api/node_modules/@acme'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join('..', '..', '..', '..', 'packages', 'ui'),
      path.join(root, 'services/api/node_modules/@acme/ui'),
    );
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install1 = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install1);
    await post(origin, ACTIVATION, workspaceActivation(install1));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const read = async (callId: string, filePath: string) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName: 'read_file',
          input: { file_path: filePath },
        })
      ).json();

    // The shared dependency reads through; the sibling Session still does
    // not — both halves of the boundary in one fixture.
    const linkedDep = await read(
      'call-1',
      'node_modules/@acme/ui/src/index.ts',
    );
    expect(linkedDep.result.executionStatus).toBe('success');
    expect(JSON.stringify(linkedDep)).toContain('ui-source');
    const sibling = await read('call-2', 'peek/secret.txt');
    expect(sibling.result.executionStatus).toBe('error');
    expect(JSON.stringify(sibling)).not.toContain('sibling');
  });

  /**
   * The linked-dependency fixture both sibling-boundary cases below share:
   * `session-1` in `services/api`, a dependency symlinked in from
   * `packages/ui`, and `peek` pointing at the sibling `services/web`.
   */
  function linkedDependencyWorkspace(): string {
    const root = workspace([
      'services/api/src',
      'services/web',
      'packages/ui/src',
    ]);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');

    fs.writeFileSync(path.join(root, 'packages/ui/src/index.ts'), 'ui-source');
    fs.symlinkSync(
      path.join('..', 'web'),
      path.join(root, 'services/api/peek'),
    );
    fs.mkdirSync(path.join(root, 'services/api/node_modules/@acme'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join('..', '..', '..', '..', 'packages', 'ui'),
      path.join(root, 'services/api/node_modules/@acme/ui'),
    );
    return root;
  }

  it('reads a linked dependency while a Session is bound at the Workspace root', async () => {
    // A selection without `cwd_relative` binds at `'.'`, so the Workspace
    // root itself can be an installed Session. That Session delimits no
    // private area — every path in the mount is inside it — so it must not
    // turn into a veto over the caller's own linked dependencies.
    const root = linkedDependencyWorkspace();
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install);
    await post(origin, ACTIVATION, workspaceActivation(install));
    await post(origin, CONTEXT, workspaceInstallation('session-root', '.'));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-2', 'services/web'),
    );
    const read = async (callId: string, filePath: string) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName: 'read_file',
          input: { file_path: filePath },
        })
      ).json();

    const linkedDep = await read(
      'call-1',
      'node_modules/@acme/ui/src/index.ts',
    );
    expect(linkedDep.result.executionStatus).toBe('success');
    expect(JSON.stringify(linkedDep)).toContain('ui-source');
    const sibling = await read('call-2', 'peek/secret.txt');
    expect(sibling.result.executionStatus).toBe('error');
    expect(JSON.stringify(sibling)).not.toContain('sibling');
  });

  it('keeps a non-root ancestor sibling owning its whole subtree', async () => {
    // The exemption covers only a binding AT the mount root: a Session
    // installed at `services` owns `services/**`, so a caller nested under
    // it cannot read or write outside its own directory within that tree.
    const root = workspace(['services/api/src', 'services/web']);
    fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'mine');
    fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const install = workspaceInstallation('session-1', 'services/api');
    await post(origin, CONTEXT, install);
    await post(origin, ACTIVATION, workspaceActivation(install));
    await post(origin, CONTEXT, workspaceInstallation('session-a', 'services'));
    const call = async (callId: string, toolName: string, input: unknown) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-1', callId, ''),
          toolName,
          input,
        })
      ).json();

    const read = await call('call-1', 'read_file', {
      file_path: '../web/secret.txt',
    });
    expect(read.result.executionStatus).toBe('error');
    expect(JSON.stringify(read)).toContain(
      "Path '../web/secret.txt' is not within the Session working directory.",
    );
    expect(JSON.stringify(read)).not.toContain('sibling');
    const write = await call('call-2', 'write_file', {
      file_path: '../web/pwned.txt',
      content: 'pwned',
    });
    expect(write.result.executionStatus).toBe('error');
    expect(JSON.stringify(write)).toContain(
      "Path '../web/pwned.txt' is not within the Session working directory.",
    );
    expect(fs.existsSync(path.join(root, 'services/web/pwned.txt'))).toBe(
      false,
    );
    const own = await call('call-3', 'read_file', {
      file_path: 'src/index.ts',
    });
    expect(own.result.executionStatus).toBe('success');
    expect(JSON.stringify(own)).toContain('mine');
  });

  it('judges every target of a Workspace-root Session against sibling estates', async () => {
    // A binding at `'.'` holds no private directory: its glob must not
    // enumerate a sibling's files, and its reads, writes and edits spelled
    // inside the mount still settle as the boundary refusal. Shared
    // locations no sibling owns remain available to it.
    const root = linkedDependencyWorkspace();
    fs.writeFileSync(path.join(root, 'services/api/probe.txt'), 'api-secret');
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const rootInstall = workspaceInstallation('session-root', '.');
    await post(origin, CONTEXT, rootInstall);
    await post(origin, ACTIVATION, workspaceActivation(rootInstall));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-1', 'services/api'),
    );
    const exec = async (callId: string, toolName: string, input: unknown) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-root', callId, ''),
          toolName,
          input,
        })
      ).json();

    const found = await exec('call-1', 'glob', { pattern: '**/probe.txt' });
    expect(found.result.executionStatus).toBe('error');
    expect(JSON.stringify(found)).not.toContain('services/api/probe.txt');
    expect(JSON.stringify(found)).not.toContain('api-secret');
    const read = await exec('call-2', 'read_file', {
      file_path: 'services/api/probe.txt',
    });
    expect(read.result.executionStatus).toBe('error');
    expect(JSON.stringify(read)).toContain(
      "Path 'services/api/probe.txt' is not within the Session working directory.",
    );
    expect(JSON.stringify(read)).not.toContain('api-secret');
    const write = await exec('call-3', 'write_file', {
      file_path: 'services/api/pwned.txt',
      content: 'pwned',
    });
    expect(write.result.executionStatus).toBe('error');
    expect(fs.existsSync(path.join(root, 'services/api/pwned.txt'))).toBe(
      false,
    );
    const shared = await exec('call-4', 'read_file', {
      file_path: 'services/web/secret.txt',
    });
    expect(shared.result.executionStatus).toBe('success');
    expect(JSON.stringify(shared)).toContain('sibling');
  });

  it('refuses a root-bound Session a glob aimed at a sibling estate, matched or not', async () => {
    // A Session bound at `'.'` holds the whole mount as its containment root,
    // so the escape test prunes nothing: without the ownership arm on glob's
    // *input* the walk stats the sibling's files, and the caller learns per
    // pattern whether that sibling holds a match — an empty answer certifying
    // a directory its own boundary excludes.
    const root = workspace(['services/api/src', 'shared']);
    fs.writeFileSync(
      path.join(root, 'services/api/src/index.ts'),
      'api-secret',
    );
    fs.writeFileSync(path.join(root, 'shared/note.txt'), 'shared text');
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const rootInstall = workspaceInstallation('session-root', '.');
    await post(origin, CONTEXT, rootInstall);
    await post(origin, ACTIVATION, workspaceActivation(rootInstall));
    await post(
      origin,
      CONTEXT,
      workspaceInstallation('session-1', 'services/api'),
    );
    const search = async (
      callId: string,
      pattern: string,
      searchPath: string,
    ) =>
      (
        await post(origin, EXECUTE, {
          ...shell('session-root', callId, ''),
          toolName: 'glob',
          input: { pattern, path: searchPath },
        })
      ).json();

    const matched = await search('call-1', '**/*.ts', 'services/api');
    expect(matched.result.executionStatus).toBe('error');
    expect(matched.result.error.message).toBe(
      "Path 'services/api' is not within the Session working directory.",
    );
    expect(JSON.stringify(matched)).not.toContain('api-secret');

    const unmatched = await search('call-2', '**/*.md', 'services/api');
    expect(unmatched.result.executionStatus).toBe('error');
    expect(unmatched.result.error.message).toBe(matched.result.error.message);
    expect(JSON.stringify(unmatched)).not.toContain('api-secret');

    // Control: a shared directory no Session owns stays searchable.
    const unowned = await search('call-3', '**/*.txt', 'shared');
    expect(unowned.result.executionStatus).not.toBe('error');
    expect(JSON.stringify(unowned)).toContain('note.txt');
  });

  it.skipIf(process.platform === 'win32')(
    'certifies the glob path spelling the walk consumes, escaped or not',
    async () => {
      // `unescapePath` is not idempotent for a real name containing a
      // backslash, so the arm must build first and judge the value glob
      // actually searches. Judging the producer's raw spelling instead admits
      // `shared\ notes` while refusing `shared notes` — one real target, two
      // answers, and the admitted search root realpaths into the sibling.
      const root = workspace(['services/api', 'services/web']);
      fs.writeFileSync(path.join(root, 'services/web/secret.txt'), 'sibling');
      fs.symlinkSync('../web', path.join(root, 'services/api/shared notes'));
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      const search = async (callId: string, searchPath: string) =>
        (
          await post(origin, EXECUTE, {
            ...shell('session-1', callId, ''),
            toolName: 'glob',
            input: { pattern: '*', path: searchPath },
          })
        ).json();

      const unescaped = await search('call-1', 'shared notes');
      const escaped = await search('call-2', String.raw`shared\ notes`);

      expect(unescaped.result.executionStatus).toBe('error');
      expect(escaped.result.executionStatus).toBe('error');
      expect(escaped.result.error.message).toBe(unescaped.result.error.message);
      expect(escaped.result.error.message).toBe(
        "Path 'shared notes' is not within the Session working directory.",
      );
      expect(JSON.stringify(escaped)).not.toContain('sibling');
      expect(JSON.stringify(escaped)).not.toContain(
        realDirectory(root, 'services/web'),
      );
    },
  );

  it('refuses an ancestor Session the nested Session estate, in both directions', async () => {
    // Ownership is not one-directional. A Session bound above another cannot
    // read, write or glob the nested Session's private estate; the nested
    // Session keeps its own files, and both keep the shared directory that no
    // Session owns.
    const root = workspace(['services/api/src', 'shared']);
    fs.writeFileSync(
      path.join(root, 'services/api/src/index.ts'),
      'nested-private-content',
    );
    fs.writeFileSync(path.join(root, 'shared/note.txt'), 'shared text');
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const installA = workspaceInstallation('session-a', 'services');
    await post(origin, CONTEXT, installA);
    await post(origin, ACTIVATION, workspaceActivation(installA));
    const installB = workspaceInstallation('session-b', 'services/api');
    await post(origin, CONTEXT, installB);
    await post(origin, ACTIVATION, workspaceActivation(installB));
    const call = async (
      sessionId: string,
      callId: string,
      toolName: string,
      input: unknown,
    ) =>
      (
        await post(origin, EXECUTE, {
          ...shell(sessionId, callId, ''),
          toolName,
          input,
        })
      ).json();

    const read = await call('session-a', 'call-1', 'read_file', {
      file_path: 'api/src/index.ts',
    });
    expect(read.result.executionStatus).toBe('error');
    expect(read.result.error.message).toBe(
      "Path 'api/src/index.ts' is not within the Session working directory.",
    );
    expect(JSON.stringify(read)).not.toContain('nested-private-content');

    const write = await call('session-a', 'call-2', 'write_file', {
      file_path: 'api/src/pwned.txt',
      content: 'pwned',
    });
    expect(write.result.executionStatus).toBe('error');
    expect(fs.existsSync(path.join(root, 'services/api/src/pwned.txt'))).toBe(
      false,
    );

    const search = await call('session-a', 'call-3', 'glob', {
      pattern: '**/*.ts',
    });
    expect(search.result.executionStatus).toBe('error');
    expect(JSON.stringify(search)).not.toContain('nested-private-content');

    // Controls.
    const own = await call('session-b', 'call-4', 'read_file', {
      file_path: 'src/index.ts',
    });
    expect(own.result.executionStatus).toBe('success');
    expect(JSON.stringify(own)).toContain('nested-private-content');
    const sharedA = await call('session-a', 'call-5', 'read_file', {
      file_path: '../shared/note.txt',
    });
    expect(sharedA.result.executionStatus).toBe('success');
    expect(JSON.stringify(sharedA)).toContain('shared text');
    const sharedB = await call('session-b', 'call-6', 'read_file', {
      file_path: '../../shared/note.txt',
    });
    expect(sharedB.result.executionStatus).toBe('success');
    expect(JSON.stringify(sharedB)).toContain('shared text');
  });

  it.each([
    'removed',
    'replaced by a file',
    'replaced by a symlink loop',
    'redirected to a shared directory',
  ])(
    'keeps stale sibling ownership scoped when its directory is %s',
    async (state) => {
      // `mount.resolve` answers undefined for a sibling whose directory was
      // removed or stopped being a directory — reachable from inside that
      // sibling's own boundary by its own admitted `run_shell_command`. The
      // installation set is add-only, so judging the whole scan by that one
      // binding would veto every Session's linked dependencies permanently.
      const root = linkedDependencyWorkspace();
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install);
      await post(origin, ACTIVATION, workspaceActivation(install));
      await post(
        origin,
        CONTEXT,
        workspaceInstallation('session-2', 'services/web'),
      );
      const read = async (callId: string, filePath: string) =>
        (
          await post(origin, EXECUTE, {
            ...shell('session-1', callId, ''),
            toolName: 'read_file',
            input: { file_path: filePath },
          })
        ).json();

      const before = await read('call-1', 'node_modules/@acme/ui/src/index.ts');
      expect(before.result.executionStatus).toBe('success');

      const stale = path.join(root, 'services/web');
      fs.rmSync(stale, { recursive: true });
      if (state === 'replaced by a file')
        fs.writeFileSync(stale, 'not a directory');
      if (state === 'replaced by a symlink loop')
        fs.symlinkSync(
          stale,
          stale,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      if (state === 'redirected to a shared directory')
        symlinkDirectory(path.join(root, 'packages/ui'), stale);

      const after = await read('call-2', 'node_modules/@acme/ui/src/index.ts');
      if (state === 'redirected to a shared directory') {
        expect(after.result.executionStatus).toBe('error');
        expect(JSON.stringify(after)).not.toContain('ui-source');
      } else {
        expect(after.result.executionStatus).toBe('success');
        expect(JSON.stringify(after)).toContain('ui-source');
      }
      const sibling = await read('call-3', 'peek/secret.txt');
      expect(sibling.result.executionStatus).toBe('error');
      const own = await read('call-4', 'src/index.ts');
      expect(own.result.executionStatus).toBe('success');
      expect(JSON.stringify(own)).toContain('mine');
    },
  );

  it.each([
    '{a,b}'.repeat(13) + '/*',
    '{9007199254740992..9007199254740992}/*',
  ])(
    'refuses a costly brace pattern before expanding it: %s',
    async (pattern) => {
      const root = workspace(['services/api']);
      const origin = await startWorker({
        ...BOOT,
        mountRoot: root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      });
      const install1 = workspaceInstallation('session-1', 'services/api');
      await post(origin, CONTEXT, install1);
      await post(origin, ACTIVATION, workspaceActivation(install1));

      const costly = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-1', ''),
          toolName: 'glob',
          input: { pattern },
        })
      ).json();
      expect(costly.result.executionStatus).toBe('error');
      expect(JSON.stringify(costly)).toContain('64 brace alternatives');
      // An ordinary brace pattern stays admitted.
      const fine = await (
        await post(origin, EXECUTE, {
          ...shell('session-1', 'call-2', ''),
          toolName: 'glob',
          input: { pattern: '*.{ts,tsx}' },
        })
      ).json();
      expect(fine.result.executionStatus).not.toBe('error');
    },
  );

  it('keeps the echoed pattern verbatim for a Session at the filesystem root', async () => {
    // Degenerate root: '/' is both the boundary and every path's prefix, so
    // the rewrite must stand down rather than eat the pattern's separators.
    const origin = await startWorker({
      ...BOOT,
      mountRoot: path.parse(process.cwd()).root,
    });
    await post(origin, CONTEXT, installation('session-root', '.'));
    const answer = await (
      await post(origin, EXECUTE, {
        ...shell('session-root', 'call-1', ''),
        toolName: 'glob',
        input: { pattern: 'etc*/host*' },
      })
    ).json();
    expect(answer.result.executionStatus).toBe('success');
    expect(JSON.stringify(answer)).toContain('etc*/host*');
  });

  it('refuses new calls once the directory is gone, and still answers settled ones', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const first = shell('session-1', 'call-1', 'echo first > probe.txt');
    expect((await post(origin, EXECUTE, first)).status).toBe(200);

    fs.rmSync(path.join(root, 'services', 'api'), { recursive: true });
    const second = shell('session-1', 'call-2', 'echo second > probe.txt');
    const refused = await post(origin, EXECUTE, second);
    const replayed = await post(origin, EXECUTE, first);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toStrictEqual(UNAVAILABLE);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'success' },
    });
    expect(fs.readdirSync(path.join(root, 'services'))).toEqual([]);
  });

  it('refuses a call once the directory has become a link', async () => {
    const root = workspace();
    const outside = workspace(['api']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));

    fs.rmSync(path.join(root, 'services', 'api'), { recursive: true });
    symlinkDirectory(
      path.join(outside, 'api'),
      path.join(root, 'services', 'api'),
    );
    const refused = await post(
      origin,
      EXECUTE,
      shell('session-1', 'call-1', 'echo probe > probe.txt'),
    );

    expect(refused.status).toBe(409);
    expect(fs.readdirSync(path.join(outside, 'api'))).toEqual([]);
  });

  it("keeps a call's shell directory inside the Session's directory", async () => {
    const root = workspace(['services/api/sub']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const run = (callId: string, directory: string) =>
      post(origin, EXECUTE, {
        ...shell('session-1', callId, 'echo probe > probe.txt'),
        input: { command: 'echo probe > probe.txt', directory },
      });

    const outside = await run('call-1', fs.realpathSync.native(root));
    const inside = await run('call-2', realDirectory(root, 'services/api/sub'));

    expect(await outside.json()).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'error' },
    });
    expect(fs.existsSync(path.join(root, 'probe.txt'))).toBe(false);
    expect(await inside.json()).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'success' },
    });
    expect(
      fs.existsSync(path.join(root, 'services', 'api', 'sub', 'probe.txt')),
    ).toBe(true);
  });

  it('checks a shell directory afresh on each call', async () => {
    const root = workspace(['services/api/sub']);
    const outside = workspace(['elsewhere']);
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const sub = realDirectory(root, 'services/api/sub');
    const run = (callId: string) =>
      post(origin, EXECUTE, {
        ...shell('session-1', callId, ''),
        input: { command: `echo ${callId} > probe.txt`, directory: sub },
      });

    const before = await (await run('call-1')).json();
    fs.rmSync(sub, { recursive: true });
    symlinkDirectory(path.join(outside, 'elsewhere'), sub);
    const after = await (await run('call-2')).json();

    expect(before).toMatchObject({ result: { executionStatus: 'success' } });
    expect(after).toMatchObject({ result: { executionStatus: 'error' } });
    expect(fs.readdirSync(path.join(outside, 'elsewhere'))).toEqual([]);
  });

  it('cancels an in-flight call of an installed Session', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    await post(origin, CONTEXT, installation('session-1', 'services/api'));
    const call = shell(
      'session-1',
      'call-cancel',
      'sleep 30 # intentional-sleep: probe for in-flight cancellation',
    );
    const running = post(origin, EXECUTE, call);
    const reference = { protocolVersion: 2, reference: call.reference };
    await vi.waitFor(async () => {
      expect(
        await (await post(origin, STATUS, reference)).json(),
      ).toMatchObject({ state: 'executing' });
    });

    const cancelled = await post(origin, CANCEL, reference);

    expect(await cancelled.json()).toMatchObject({ state: 'cancel_requested' });
    expect(await (await running).json()).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'cancelled' },
    });
  }, 15_000);

  it('answers a journaled call again without asking the gate', async () => {
    const root = workspace();
    let resolved = 0;
    const executor = new ManagedToolExecutor(async () => {
      resolved += 1;
      return resolved === 1 ? tools(root) : undefined;
    });
    const reference: ManagedToolReference = {
      sessionId: 'session-1',
      promptId: 'prompt-1',
      callId: 'call-1',
      argsDigest: 'digest-1',
    };
    const input = { command: 'echo run >> calls.txt' };

    const first = await executor.execute(reference, 'run_shell_command', input);
    const again = await executor.execute(reference, 'run_shell_command', input);
    await executor.close();

    expect(again).toBe(first);
    expect(resolved).toBe(1);
  });

  it('joins a call that another execute journaled while its gate refused', async () => {
    const root = workspace();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    let resolved = 0;
    const executor = new ManagedToolExecutor(async () => {
      resolved += 1;
      if (resolved === 1) {
        await first;
        return tools(root);
      }
      await second;
      return undefined;
    });
    const reference: ManagedToolReference = {
      sessionId: 'session-1',
      promptId: 'prompt-1',
      callId: 'call-1',
      argsDigest: 'digest-1',
    };
    const input = { command: 'echo run >> calls.txt' };

    const original = executor.execute(reference, 'run_shell_command', input);
    const repeated = executor.execute(reference, 'run_shell_command', input);
    releaseFirst();
    const result = await original;
    releaseSecond();

    expect(await repeated).toBe(result);
    expect(result.executionStatus).toBe('success');
    await executor.close();
  });

  it('journals a call once when two executes race through the gate', async () => {
    const root = workspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resolved = 0;
    const executor = new ManagedToolExecutor(async () => {
      resolved += 1;
      await gate;
      return tools(root);
    });
    const reference: ManagedToolReference = {
      sessionId: 'session-1',
      promptId: 'prompt-1',
      callId: 'call-1',
      argsDigest: 'digest-1',
    };
    const input = { command: 'echo run >> calls.txt' };

    const first = executor.execute(reference, 'run_shell_command', input);
    const second = executor.execute(reference, 'run_shell_command', input);
    release();
    const results = await Promise.all([first, second]);
    await executor.close();

    expect(resolved).toBe(2);
    expect(results[1]).toBe(results[0]);
    expect(results[0].executionStatus).toBe('success');
    expect(
      fs
        .readFileSync(path.join(root, 'calls.txt'), 'utf8')
        .trim()
        .split(/\r?\n/),
    ).toHaveLength(1);
  });

  it.each(['v2 tools', 'v3 tools', 'v3 capture'] as const)(
    'refuses a legacy call whose Session the provider claimed while it awaited %s',
    async (point) => {
      // The entry checks pass before the claim; only the re-check after each
      // await stands between the raw call and a provider-owned Session.
      const root = workspace();
      const input = { command: 'echo run > ran.txt' };
      const reference: ManagedToolReference = {
        sessionId: 'session-1',
        promptId: 'prompt-1',
        callId: 'call-1',
        argsDigest: managedToolDigest(input),
      };
      const capture = {
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        turnId: 'turn-a',
        executionCallId: 'execution-a',
        bindingGeneration: '1',
        capturePolicy: 'complete_required' as const,
      };
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const suspend = async () => {
        enter();
        await gate;
      };
      const accept = vi.fn();
      const prepare = vi.fn(async () => {
        if (point === 'v3 capture') await suspend();
        return { identity: {} as never, sink: {} as never };
      });
      const executor = new ManagedToolExecutor(
        async () => {
          if (point !== 'v3 capture') await suspend();
          return tools(root);
        },
        { prepare, accept },
      );
      const legacy =
        point === 'v2 tools'
          ? executor.execute(reference, 'run_shell_command', input)
          : executor.executeV3({
              reference,
              capture,
              toolName: 'run_shell_command',
              input,
            });
      await entered;
      executor.claimProviderSession(reference.sessionId);
      release();

      await expect(legacy).rejects.toThrow(
        'Managed Runtime protocol conflicts.',
      );
      expect(executor.hasActiveSession(reference.sessionId)).toBe(false);
      if (point === 'v2 tools') expect(executor.status(reference)).toBeNull();
      else expect(executor.statusV3(reference)).toEqual({ state: 'unknown' });
      expect(prepare).toHaveBeenCalledTimes(point === 'v3 capture' ? 1 : 0);
      expect(accept).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, 'ran.txt'))).toBe(false);
      await executor.close();
    },
  );
});

describe('Managed Workspace execution activation', () => {
  // The workspace activation envelope is built once, at module scope; these
  // aliases only carry this block's shorter names and its `cwd` default, so a
  // change to the request shape cannot leave half the suite posting a stale
  // envelope.
  const fixedInstallation = (sessionId: string, cwd = '.') =>
    workspaceInstallation(sessionId, cwd);
  const activation = workspaceActivation;

  it('pins the explicit frozen configuration and capability digests', () => {
    const refs = 'managed-runtime-tools/1\0preapproved-workspace-tools/1';
    const digest = (text: string) =>
      `sha256:${createHash('sha256').update(text).digest('hex')}`;
    expect(digest(refs)).toBe(WORKSPACE_CONTEXT_CONFIG_REF);
    expect(digest(`${WORKSPACE_EXECUTION_PROFILE}\0${refs}`)).toBe(
      WORKSPACE_CAPABILITY_DIGEST,
    );
  });

  it('refuses activation for an unsupported frozen configuration', async () => {
    const root = workspace();
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const request = installation('unsupported-profile', '.');
    expect(request.binding.contextConfigRef).not.toBe(
      WORKSPACE_CONTEXT_CONFIG_REF,
    );
    expect((await post(origin, CONTEXT, request)).status).toBe(200);
    expect((await post(origin, ACTIVATION, activation(request))).status).toBe(
      409,
    );
    expect(
      (
        await post(
          origin,
          EXECUTE,
          shell(request.sessionId, 'unsupported', 'touch unsupported.txt'),
        )
      ).status,
    ).toBe(409);
    expect(fs.existsSync(path.join(root, 'unsupported.txt'))).toBe(false);
  });

  it('refuses workspace activation on a worker with a legacy capability', async () => {
    const root = workspace();
    const origin = await startWorker({ ...BOOT, mountRoot: root });
    const request = fixedInstallation('legacy-capability');
    expect((await post(origin, CONTEXT, request)).status).toBe(200);
    expect((await post(origin, ACTIVATION, activation(request))).status).toBe(
      409,
    );
  });

  it('requires activation, writes from a subdirectory, and permanently closes on release', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, 'child'));
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const request = fixedInstallation('active-session', 'child');
    expect((await post(origin, CONTEXT, request)).status).toBe(200);
    const call = shell(
      request.sessionId,
      'write',
      'echo activated > proof.txt',
    );
    expect((await post(origin, EXECUTE, call)).status).toBe(409);
    expect(fs.existsSync(path.join(root, 'child/proof.txt'))).toBe(false);
    const activate = activation(request);
    for (const invalid of [
      { ...activate, extra: true },
      { ...activate, contextDigest: BOOT.capabilityDigest },
      { ...activate, profile: 'unknown' },
      { ...activate, operation: ['activate'] },
    ]) {
      expect(
        (await post(origin, ACTIVATION, invalid)).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await post(origin, ACTIVATION, activate, {
          ...HEADERS,
          authorization: 'Bearer invalid',
        })
      ).status,
    ).toBe(401);
    const receipt = {
      ...activate,
      runtimeInstanceId: BOOT.runtimeInstanceId,
      runtimeIncarnation: BOOT.runtimeIncarnation,
      epoch: BOOT.epoch,
      active: true,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await (await post(origin, ACTIVATION, activate)).json()).toEqual(
        receipt,
      );
    }
    expect(
      (await (await post(origin, EXECUTE, call)).json()).result.executionStatus,
    ).toBe('success');
    expect(
      fs.readFileSync(path.join(root, 'child/proof.txt'), 'utf8').trim(),
    ).toBe('activated');
    // An absolute path inside the Session directory is admitted.
    const readOwn = {
      ...shell(request.sessionId, 'read-own', ''),
      toolName: 'read_file',
      input: {
        file_path: path.join(realDirectory(root, 'child'), 'proof.txt'),
      },
    };
    expect(
      (await (await post(origin, EXECUTE, readOwn)).json()).result
        .executionStatus,
    ).toBe('success');
    // So is one outside it but inside the mount: the file-tool boundary is
    // the mount, vetoed only for another installed Session's directory.
    const readRoot = {
      ...shell(request.sessionId, 'read-root', ''),
      toolName: 'read_file',
      input: { file_path: path.join(realDirectory(root, '.'), 'root.txt') },
    };
    fs.writeFileSync(path.join(root, 'root.txt'), 'root-readable');
    expect(
      (await (await post(origin, EXECUTE, readRoot)).json()).result
        .executionStatus,
    ).toBe('success');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await post(origin, ACTIVATION, activation(request, 'release'))).status,
      ).toBe(200);
    }
    expect((await post(origin, ACTIVATION, activate)).status).toBe(409);
    expect(
      (
        await post(
          origin,
          EXECUTE,
          shell(request.sessionId, 'late', 'touch late.txt'),
        )
      ).status,
    ).toBe(409);
    expect(fs.existsSync(path.join(root, 'child/late.txt'))).toBe(false);
    // An original settled call remains observable and idempotent after gate closure.
    expect(
      (await (await post(origin, EXECUTE, call)).json()).result.executionStatus,
    ).toBe('success');
  });

  // Runs for 30 seconds unless it is cancelled, under bash and cmd.exe alike.
  // cmd.exe has no `#` comments, so `sleep 30 # …` fails at once there.
  const WAIT_30_SECONDS = `"${process.execPath}" -e "setTimeout(String, 30000)"`;

  // Starts `command` as a shell call in the Session's `child` directory. The
  // call reports `executing` before its shell starts.
  async function startSlowCall(command: string) {
    const root = workspace();
    fs.mkdirSync(path.join(root, 'child'));
    const origin = await startWorker({
      ...BOOT,
      mountRoot: root,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const request = fixedInstallation('running-session', 'child');
    expect((await post(origin, CONTEXT, request)).status).toBe(200);
    expect((await post(origin, ACTIVATION, activation(request))).status).toBe(
      200,
    );
    const call = shell(request.sessionId, 'slow', command);
    const running = post(origin, EXECUTE, call);
    // A test that fails before cancel() must not leave this unobserved.
    running.catch(() => undefined);
    const lookup = {
      protocolVersion: 2,
      reference: call.reference,
      afterSequence: 0,
    };
    const status = async () =>
      (await (await post(origin, STATUS, lookup)).json()).state;
    await vi.waitFor(async () => {
      expect(await status()).toBe('executing');
    });
    const cancel = async () => {
      const cancelled = await post(origin, CANCEL, {
        protocolVersion: 2,
        reference: call.reference,
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({
        state: 'cancel_requested',
      });
      // A cancel that does not stop the command would still settle as
      // cancelled once the command ends by itself, 30 seconds in, so the call
      // must settle well before that.
      await vi.waitFor(
        async () => {
          expect(await status()).toBe('settled');
        },
        { timeout: 10_000 },
      );
      expect((await (await running).json()).result.executionStatus).toBe(
        'cancelled',
      );
    };
    const release = async () =>
      (await post(origin, ACTIVATION, activation(request, 'release'))).status;
    return { root, status, cancel, release };
  }

  it('refuses release while an invocation is active, and allows it once the invocation settles', async () => {
    const { cancel, release } = await startSlowCall(WAIT_30_SECONDS);

    expect(await release()).toBe(409);
    await cancel();
    expect(await release()).toBe(200);
  });

  // Windows refuses to rename a directory that a native process, such as
  // cmd.exe or node, uses as its working directory. Under Git Bash, which CI
  // uses, the rename succeeds once the shell has written `started.txt`. So on
  // Windows the test runs only when the Shell tool runs bash.
  it.skipIf(
    process.platform === 'win32' && getShellConfiguration().shell !== 'bash',
  )(
    'retains status and cancel for an active invocation after its directory is lost',
    async () => {
      const { root, status, cancel, release } = await startSlowCall(
        'echo started > started.txt && sleep 30',
      );
      await vi.waitFor(
        () => {
          expect(fs.existsSync(path.join(root, 'child', 'started.txt'))).toBe(
            true,
          );
        },
        { timeout: 10_000 },
      );

      // A scanner or a process starting in the directory can make Windows
      // refuse the rename for a moment, so it is retried.
      await vi.waitFor(
        () => {
          fs.renameSync(path.join(root, 'child'), path.join(root, 'moved'));
        },
        { timeout: 3_000 },
      );
      expect(await status()).toBe('executing');
      await cancel();
      expect(await release()).toBe(200);
    },
  );

  it('rechecks a closed gate after an asynchronous tool resolver returns', async () => {
    const root = workspace();
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let active = true;
    const executor = new ManagedToolExecutor(async () => {
      await waiting;
      return { ...tools(root), isActive: () => active };
    });
    const reference = {
      sessionId: 'session',
      promptId: 'prompt',
      callId: 'call',
      argsDigest: 'digest',
    };
    const pending = executor.execute(reference, 'run_shell_command', {
      command: 'touch late.txt',
    });
    expect(executor.hasActiveSession(reference.sessionId)).toBe(false);
    active = false;
    resume();
    await expect(pending).rejects.toThrow('unavailable');
    expect(executor.status(reference)).toBeNull();
    expect(fs.existsSync(path.join(root, 'late.txt'))).toBe(false);
  });
});

describe('background Shell supervisor injection', () => {
  const saved = process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
    } else {
      process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'] = saved;
    }
  });

  it('injects a supervisor only when the delegated cgroup root is set', () => {
    delete process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
    const withoutRoot = registerManagedContextRoutes(express(), BOOT);
    expect(
      (withoutRoot as unknown as { backgroundSupervisor?: unknown })
        .backgroundSupervisor,
    ).toBeUndefined();

    process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'] = path.join(
      os.tmpdir(),
      'no-such-cgroup-root',
    );
    const withRoot = registerManagedContextRoutes(express(), BOOT);
    expect(
      (withRoot as unknown as { backgroundSupervisor?: unknown })
        .backgroundSupervisor,
    ).toBeDefined();
  });
});

describe('selectShellCapturePublisher', () => {
  const request = (background: boolean) => ({
    reference: { sessionId: 's', promptId: 'p', callId: 'c' },
    capture: { executionCallId: 'e', background },
  });
  const doubles = (local: boolean, remote: boolean) => ({
    remotePublishers: {
      hasSession: vi.fn(() => local),
      prepare: vi.fn(async () => ({ identity: { lane: 'local' } })),
    },
    remotePublisher: {
      hasExecution: vi.fn(() => remote),
      prepare: vi.fn(async () => ({ identity: { lane: 'remote' } })),
    },
  });

  it('hands a background capture to its Session publisher', async () => {
    const { remotePublishers, remotePublisher } = doubles(true, true);
    const publisher = selectShellCapturePublisher(
      remotePublishers as never,
      remotePublisher as never,
    );
    const prepared = await publisher.prepare(request(true) as never);
    expect(remotePublishers.prepare).toHaveBeenCalledOnce();
    expect(remotePublisher.prepare).not.toHaveBeenCalled();
    expect(prepared.identity).toEqual({ lane: 'local' });
    expect(prepared.publisher).toBe(remotePublishers);
  });

  it('refuses a background capture whose Session never registered a publisher', async () => {
    const { remotePublishers, remotePublisher } = doubles(false, true);
    const publisher = selectShellCapturePublisher(
      remotePublishers as never,
      remotePublisher as never,
    );
    await expect(publisher.prepare(request(true) as never)).rejects.toThrow(
      'Background captures require their Session publisher.',
    );
    expect(remotePublisher.prepare).not.toHaveBeenCalled();
  });

  it('hands a foreground execution its own publication while the Session lane is registered', async () => {
    const { remotePublishers, remotePublisher } = doubles(true, true);
    const publisher = selectShellCapturePublisher(
      remotePublishers as never,
      remotePublisher as never,
    );
    // The mixed topology is ordinary now: the execution belongs to its
    // publication grant, the background lane to the Session — sharing them
    // is never a conflict.
    const prepared = await publisher.prepare(request(false) as never);
    expect(remotePublisher.prepare).toHaveBeenCalledOnce();
    expect(remotePublishers.prepare).not.toHaveBeenCalled();
    expect(prepared.identity).toEqual({ lane: 'remote' });
    expect(prepared.publisher).toBe(remotePublisher);
  });

  it('keeps the Session publisher for a foreground capture when it is the only owner', async () => {
    const { remotePublishers, remotePublisher } = doubles(true, false);
    const publisher = selectShellCapturePublisher(
      remotePublishers as never,
      remotePublisher as never,
    );
    const prepared = await publisher.prepare(request(false) as never);
    expect(prepared.identity).toEqual({ lane: 'local' });
    expect(prepared.publisher).toBe(remotePublishers);
  });
});
