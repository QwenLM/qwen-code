/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';

const toolFixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-runtime-tool-v2.fixtures.json',
    ),
    'utf8',
  ),
) as {
  routes: Array<{ key: string; method: string; path: string }>;
  suites: ToolSuite[];
};

const BOOT: ManagedRuntimeWorkerBoot = {
  type: 'boot',
  version: 1,
  capabilityDigest: `sha256:${'a'.repeat(64)}`,
  epoch: 4,
  isolationClass: 'workspace',
  leaseId: 'lease-01',
  provisionRequestId: 'provision-01',
  runtimeIncarnation: 'incarnation-01',
  runtimeInstanceId: 'runtime-01',
  tenantId: 'tenant-a',
  token: 'fixture-token',
  workspaceCwd: '/tmp',
  workspaceGeneration: '7',
  workspaceId: 'workspace-a',
};

const HEADERS = {
  authorization: 'Bearer fixture-token',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': 'lease-01',
  'x-qwen-managed-lease-epoch': '4',
};

interface ToolSuite {
  readonly route: string;
  readonly canonicalRequest: {
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
  };
  readonly cases: ReadonlyArray<{
    readonly id: string;
    readonly request?: {
      readonly omitHeader?: string;
      readonly replaceHeader?: {
        readonly name: string;
        readonly value: string;
      };
      readonly replaceBody?: { readonly name: string; readonly value: unknown };
      readonly paddingBytes?: number;
      readonly rawBody?: string;
      readonly pathSuffix?: string;
      readonly pathOverride?: string;
      readonly method?: string;
    };
    readonly expected: {
      readonly status: number;
      readonly classification: string;
      readonly code?: string;
      readonly body?: Record<string, unknown>;
    };
  }>;
}

const suites = toolFixtures.suites as readonly ToolSuite[];

describe('Managed Runtime tool worker', () => {
  let workspace: string;
  let worker: ManagedRuntimeAttestationWorkerHandle | undefined;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-tool-'));
    fs.writeFileSync(path.join(workspace, 'README.md'), 'file contents');
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    worker = await startManagedRuntimeAttestationWorker({
      ...BOOT,
      workspaceCwd: workspace,
    });
    return worker.ready.url;
  }

  function executeBody(input: Record<string, unknown>) {
    return {
      protocolVersion: 2,
      reference: {
        sessionId: 'runtime-session-01',
        promptId: 'prompt-01',
        callId: 'call-01',
        argsDigest: 'digest-01',
      },
      toolName: 'read_file',
      input,
    };
  }

  describe('replays the shared negative fixtures against the real handlers', () => {
    for (const suite of suites) {
      for (const fixture of suite.cases) {
        if (fixture.expected.status === 200) continue;
        it(`${suite.route}/${fixture.id}`, async () => {
          const origin = await start();
          const route = toolFixtures.routes.find(
            (entry) => entry.key === suite.route,
          )!;
          const headers = { ...suite.canonicalRequest.headers };
          const body: Record<string, unknown> = {
            ...suite.canonicalRequest.body,
          };
          if (fixture.request?.omitHeader) {
            delete headers[fixture.request.omitHeader];
          }
          if (fixture.request?.replaceHeader) {
            headers[fixture.request.replaceHeader.name] =
              fixture.request.replaceHeader.value;
          }
          if (fixture.request?.replaceBody) {
            body[fixture.request.replaceBody.name] =
              fixture.request.replaceBody.value;
          }
          if (fixture.request?.paddingBytes) {
            body['padding'] = 'x'.repeat(fixture.request.paddingBytes);
          }
          const method = fixture.request?.method ?? route.method;
          const response = await fetch(
            `${origin}${fixture.request?.pathOverride ?? route.path}${fixture.request?.pathSuffix ?? ''}`,
            {
              method,
              headers,
              body:
                method === 'GET'
                  ? undefined
                  : (fixture.request?.rawBody ?? JSON.stringify(body)),
            },
          );

          expect(response.status).toBe(fixture.expected.status);
          if (fixture.expected.code) {
            expect(await response.json()).toMatchObject({
              code: fixture.expected.code,
            });
          }
          expect(response.headers.get('cache-control')).toBe('no-store');
        });
      }
    }
  });

  it('executes read_file in the bound workspace and reports status', async () => {
    const origin = await start();

    const executeResponse = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(
          executeBody({ file_path: path.join(workspace, 'README.md') }),
        ),
      },
    );
    expect(executeResponse.status).toBe(200);
    const settled = (await executeResponse.json()) as {
      state: string;
      result: { executionStatus: string; responseParts: unknown[] };
    };
    expect(settled.state).toBe('settled');
    expect(settled.result.executionStatus).toBe('success');
    expect(JSON.stringify(settled.result.responseParts)).toContain(
      'file contents',
    );

    const statusResponse = await fetch(
      `${origin}/internal/managed-runtime/v2/status`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          protocolVersion: 2,
          reference: executeBody({}).reference,
          afterSequence: 0,
        }),
      },
    );
    expect(statusResponse.status).toBe(200);
    const view = (await statusResponse.json()) as {
      state: string;
      lastSequence: number;
      result?: { executionStatus: string };
    };
    expect(view.state).toBe('settled');
    expect(view.result?.executionStatus).toBe('success');
    expect(view.lastSequence).toBeGreaterThan(0);
  });

  it('answers unknown for a reference the Runtime never saw', async () => {
    const origin = await start();
    const reference = {
      sessionId: 'runtime-session-01',
      promptId: 'prompt-99',
      callId: 'call-99',
      argsDigest: 'digest-99',
    };
    for (const operation of ['status', 'cancel']) {
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/${operation}`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ protocolVersion: 2, reference }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        protocolVersion: 2,
        state: 'unknown',
      });
    }
  });

  it('joins an in-flight execute for the same reference', async () => {
    const origin = await start();
    const body = {
      protocolVersion: 2,
      reference: {
        sessionId: 'runtime-session-01',
        promptId: 'prompt-01',
        callId: 'call-join',
        argsDigest: 'digest-join',
      },
      toolName: 'read_file',
      input: { file_path: path.join(workspace, 'README.md') },
    };
    const [first, second] = await Promise.all([
      fetch(`${origin}/internal/managed-runtime/v2/execute`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      }),
      fetch(`${origin}/internal/managed-runtime/v2/execute`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it('rejects a second call with the same callId but a different digest', async () => {
    const origin = await start();
    const body = executeBody({ file_path: path.join(workspace, 'README.md') });
    const first = await fetch(`${origin}/internal/managed-runtime/v2/execute`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    const conflict = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          ...body,
          reference: { ...body.reference, argsDigest: 'digest-other' },
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
  });

  it('rejects a tool the Runtime does not admit', async () => {
    const origin = await start();
    const response = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          ...executeBody({}),
          toolName: 'write_file_but_not_admitted',
        }),
      },
    );
    expect(response.status).toBe(409);
  });

  it('cancels an in-flight shell execution', async () => {
    const origin = await start();
    const reference = {
      sessionId: 'runtime-session-01',
      promptId: 'prompt-01',
      callId: 'call-cancel',
      argsDigest: 'digest-cancel',
    };
    const running = fetch(`${origin}/internal/managed-runtime/v2/execute`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        protocolVersion: 2,
        reference,
        toolName: 'run_shell_command',
        input: {
          command:
            'sleep 30 # intentional-sleep: probe for in-flight cancellation',
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cancelResponse = await fetch(
      `${origin}/internal/managed-runtime/v2/cancel`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ protocolVersion: 2, reference }),
      },
    );
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({
      state: 'cancel_requested',
    });

    const settled = (await (await running).json()) as {
      state: string;
      result: { executionStatus: string };
    };
    expect(settled.state).toBe('settled');
    expect(['cancelled', 'error']).toContain(settled.result.executionStatus);
  }, 15_000);
});
