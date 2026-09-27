/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ShellTool } from '@qwen-code/qwen-code-core/tools/shell.js';
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

/**
 * A shell command that writes the session and project directory its shell
 * sees to `file`, in any shell the Shell tool picks.
 */
function writeShellEnvironment(file: string): string {
  const script =
    "process.stdout.write([process.env.QWEN_CODE_SESSION_ID, process.env.QWEN_CODE_PROJECT_DIR].join('|'))";
  return `"${process.execPath}" -e "${script}" > ${file}`;
}

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

  it('returns file contents for separate calls across sessions', async () => {
    const origin = await start();
    for (const [index, sessionId] of [
      'session-a',
      'session-b',
      'session-a',
    ].entries()) {
      const body = executeBody({
        file_path: path.join(workspace, 'README.md'),
      });
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({
            ...body,
            reference: {
              ...body.reference,
              sessionId,
              callId: `read-${index}`,
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const settled = await response.json();
      expect(settled).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'success' },
      });
      expect(JSON.stringify(settled)).toContain('file contents');
    }
  });

  it('takes the workspace at startup, as it always has', async () => {
    // The workspace is missing at startup, so it never covers a directory
    // created later, whatever the first call finds.
    const late = path.join(workspace, 'late');
    worker = await startManagedRuntimeAttestationWorker({
      ...BOOT,
      workspaceCwd: late,
    });
    fs.mkdirSync(path.join(late, 'sub'), { recursive: true });

    const response = await fetch(
      `${worker.ready.url}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          ...executeBody({
            command: 'echo probe > probe.txt',
            directory: path.join(late, 'sub'),
          }),
          toolName: 'run_shell_command',
        }),
      },
    );

    expect(await response.json()).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'error' },
    });
    expect(fs.existsSync(path.join(late, 'sub', 'probe.txt'))).toBe(false);
  });

  it("gives shells the Runtime's session and project directory, as before", async () => {
    const origin = await start();

    const response = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          ...executeBody({
            command: writeShellEnvironment('env.txt'),
          }),
          toolName: 'run_shell_command',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(fs.readFileSync(path.join(workspace, 'env.txt'), 'utf8')).toBe(
      `${BOOT.runtimeInstanceId}|${new Storage(workspace).getProjectDir()}`,
    );
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

  it('accepts a 256 KiB execute body and rejects one byte more', async () => {
    const origin = await start();
    const body = JSON.stringify(
      executeBody({ file_path: path.join(workspace, 'README.md') }),
    ).padEnd(256 * 1024, ' ');
    const accepted = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      { method: 'POST', headers: HEADERS, body },
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      result: { executionStatus: 'success' },
    });

    const rejected = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      { method: 'POST', headers: HEADERS, body: `${body} ` },
    );
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({
      code: 'managed_runtime_attestation_too_large',
      error: 'Managed Runtime request exceeds its body size limit.',
    });
  });

  it.each(['read_file', 'run_shell_command'])(
    'rejects %s input too deeply nested for identity comparison',
    async (toolName) => {
      const origin = await start();
      const { reference } = executeBody({});
      const nested = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
      const body = `{"protocolVersion":2,"reference":${JSON.stringify(reference)},"toolName":${JSON.stringify(toolName)},"input":{"extra":${nested}}}`;
      expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);

      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(
          `${origin}/internal/managed-runtime/v2/execute`,
          { method: 'POST', headers: HEADERS, body },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          code: 'managed_runtime_attestation_invalid',
          error: 'Managed Runtime tool request is invalid.',
        });
      }
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
    },
  );

  it('journals a bounded error when JSON encoding exceeds the result limit', async () => {
    const origin = await start();
    const filePath = path.join(workspace, 'large.svg');
    fs.writeFileSync(
      filePath,
      `<svg xmlns="http://www.w3.org/2000/svg"><!--${'"'.repeat(600_000)}--></svg>`,
    );
    const body = executeBody({ file_path: filePath });
    let settled: unknown;
    for (const operation of ['execute', 'status', 'cancel', 'execute']) {
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/${operation}`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(
            operation === 'execute'
              ? body
              : { protocolVersion: 2, reference: body.reference },
          ),
        },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
      const result = JSON.parse(text).result as unknown;
      expect(result).toEqual({
        executionStatus: 'error',
        responseParts: [],
        error: { message: 'Managed Runtime tool result exceeds 1 MiB.' },
      });
      settled ??= result;
      expect(result).toEqual(settled);
    }
  });

  it('executes concurrent and settled retries only once', async () => {
    const origin = await start();
    const body = {
      protocolVersion: 2,
      reference: {
        sessionId: 'runtime-session-01',
        promptId: 'prompt-01',
        callId: 'call-join',
        argsDigest: 'digest-join',
      },
      toolName: 'run_shell_command',
      input: { command: 'echo invocation >> calls.txt' },
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
    const settled = await first.json();
    expect(settled).toMatchObject({
      result: { executionStatus: 'success' },
    });
    expect(settled).toEqual(await second.json());
    const replay = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(settled);
    expect(
      fs.readFileSync(path.join(workspace, 'calls.txt'), 'utf8').trim(),
    ).toBe('invocation');
  });

  it('replays identical input after the tool normalizes its parameters', async () => {
    const origin = await start();
    const body = JSON.stringify(
      executeBody({
        file_path: ` ${path.join(workspace, 'README.md')} `,
        offset: null,
        limit: null,
        pages: null,
      }),
    );
    const first = await fetch(`${origin}/internal/managed-runtime/v2/execute`, {
      method: 'POST',
      headers: HEADERS,
      body,
    });
    expect(first.status).toBe(200);
    const settled = await first.json();
    expect(settled).toMatchObject({
      result: { executionStatus: 'success' },
    });

    const replay = await fetch(
      `${origin}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body,
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(settled);
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
      error: 'Managed Runtime invocation identity conflicts.',
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

  it.each([true, 'true', 'TRUE', 'TrUe'])(
    'rejects background shell execution with is_background=%j without recording an invocation',
    async (isBackground) => {
      const origin = await start();
      const body = {
        ...executeBody({
          command: 'echo background > rejected-background.txt',
          is_background: isBackground,
        }),
        toolName: 'run_shell_command',
      };
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'managed_runtime_identity_conflict',
        error: 'Managed Runtime does not admit background shell execution.',
      });
      expect(
        fs.existsSync(path.join(workspace, 'rejected-background.txt')),
      ).toBe(false);

      for (const operation of ['status', 'cancel']) {
        const lookup = await fetch(
          `${origin}/internal/managed-runtime/v2/${operation}`,
          {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
              protocolVersion: 2,
              reference: body.reference,
            }),
          },
        );
        expect(lookup.status).toBe(200);
        expect(await lookup.json()).toEqual({
          protocolVersion: 2,
          state: 'unknown',
        });
      }
    },
  );

  it.each([false, undefined, 'false', 'FALSE', 'FaLsE'])(
    'executes foreground shell commands with is_background=%s',
    async (isBackground) => {
      const origin = await start();
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({
            ...executeBody({
              command: 'echo foreground',
              is_background: isBackground,
            }),
            toolName: 'run_shell_command',
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'success' },
      });
    },
  );

  it.each([1, 'yes', null, {}, [true]])(
    'settles invalid is_background=%j without starting a command',
    async (isBackground) => {
      const origin = await start();
      const body = {
        ...executeBody({
          command: 'echo started > invalid-background.txt',
          is_background: isBackground,
        }),
        toolName: 'run_shell_command',
      };
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(200);
      const settled = await response.json();
      expect(settled).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'error' },
      });
      expect(
        fs.existsSync(path.join(workspace, 'invalid-background.txt')),
      ).toBe(false);

      const replay = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
        },
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(settled);
    },
  );

  it('journals parameter validation exceptions without executing a command', async () => {
    const origin = await start();
    const validation = vi
      .spyOn(ShellTool.prototype, 'validateToolParams')
      .mockImplementation(() => {
        throw new Error('Invalid shell parameters');
      });
    try {
      const body = {
        ...executeBody({ command: 'echo started > validation-started.txt' }),
        toolName: 'run_shell_command',
      };
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/execute`,
        { method: 'POST', headers: HEADERS, body: JSON.stringify(body) },
      );
      expect(response.status).toBe(200);
      const settled = await response.json();
      expect(settled).toMatchObject({
        state: 'settled',
        result: {
          executionStatus: 'error',
          error: { message: 'Invalid shell parameters' },
        },
      });
      const status = await fetch(
        `${origin}/internal/managed-runtime/v2/status`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({
            protocolVersion: 2,
            reference: body.reference,
          }),
        },
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject(settled);
      expect(
        fs.existsSync(path.join(workspace, 'validation-started.txt')),
      ).toBe(false);
    } finally {
      validation.mockRestore();
    }
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
    await vi.waitFor(async () => {
      const response = await fetch(
        `${origin}/internal/managed-runtime/v2/status`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ protocolVersion: 2, reference }),
        },
      );
      expect(await response.json()).toMatchObject({ state: 'executing' });
    });

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
    expect(settled.result.executionStatus).toBe('cancelled');
  }, 15_000);
});
