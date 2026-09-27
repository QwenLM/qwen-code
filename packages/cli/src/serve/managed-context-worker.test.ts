/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
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
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';

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
});

describe('Managed Workspace execution activation', () => {
  function fixedInstallation(sessionId: string, cwd = '.') {
    const request = installation(sessionId, cwd);
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

  function activation(
    request: ReturnType<typeof fixedInstallation>,
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

  it('refuses release while an invocation is active, and retains status/cancel after directory loss', async () => {
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
    const call = shell(
      request.sessionId,
      'slow',
      'sleep 30 # intentional-sleep: in-flight release test',
    );
    const running = post(origin, EXECUTE, call);
    const lookup = {
      protocolVersion: 2,
      reference: call.reference,
      afterSequence: 0,
    };
    await vi.waitFor(async () => {
      expect((await (await post(origin, STATUS, lookup)).json()).state).toBe(
        'executing',
      );
    });
    expect(
      (await post(origin, ACTIVATION, activation(request, 'release'))).status,
    ).toBe(409);
    fs.renameSync(path.join(root, 'child'), path.join(root, 'moved'));
    expect(
      (
        await post(origin, CANCEL, {
          protocolVersion: 2,
          reference: call.reference,
        })
      ).status,
    ).toBe(200);
    expect((await (await running).json()).result.executionStatus).toBe(
      'cancelled',
    );
    expect((await (await post(origin, STATUS, lookup)).json()).state).toBe(
      'settled',
    );
    expect(
      (await post(origin, ACTIVATION, activation(request, 'release'))).status,
    ).toBe(200);
  });

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
