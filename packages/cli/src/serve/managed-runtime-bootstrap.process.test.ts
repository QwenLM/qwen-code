/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import { PUBLICATION_INSTALL_ROUTE } from './remote-shell-result-publication.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { MANAGED_MCP_WORKER_ROUTE } from './managed-mcp-routes.js';
import { MANAGED_HOOK_WORKER_ROUTE } from './managed-hook-routes.js';
import { MANAGED_SHELL_WORKER_ROUTE } from './managed-shell-routes.js';
import { MANAGED_MONITOR_WORKER_ROUTE } from './managed-monitor-routes.js';
import {
  MANAGED_RUNTIME_PROVIDER_PROTOCOL,
  MANAGED_RUNTIME_PROVIDER_ROUTE,
} from './managed-runtime-provider-protocol.js';
import {
  executeSshBootstrap,
  readSshPrivateJson,
  writeSshPrivateJson,
  type SshStorageIdentity,
  type SshStorageMarker,
} from './managed-runtime-bootstrap.js';

const api = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx/esm/api'),
).href;
const source = new URL('./managed-runtime-bootstrap.ts', import.meta.url).href;
const workerSource = new URL('./managed-runtime-ssh-worker.ts', import.meta.url)
  .href;
const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

describe.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'SSH bootstrap real processes',
  () => {
    let root: string;
    let workspace: string;
    let stateDirectory: string;
    let entry: string;
    let identity: SshStorageIdentity;
    let marker: SshStorageMarker;
    let expectedQwenVersion: string;
    const pids = new Set<number>();

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'qwen-ssh-bootstrap-'));
      // macOS's temporary directory may itself be a symlink.
      root = await (await import('node:fs/promises')).realpath(root);
      workspace = path.join(root, 'workspace');
      stateDirectory = path.join(root, 'private');
      await mkdir(workspace);
      await mkdir(stateDirectory, { mode: 0o700 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(path.join(workspace, 'existing.txt'), 'original\n');
      entry = path.join(root, 'entry.mjs');
      await writeFile(
        entry,
        `import {register} from ${JSON.stringify(api)};\nregister({tsconfig:${JSON.stringify(tsconfig)}});\nif(process.argv[2]==='managed-runtime-bootstrap-worker'){await (await import(${JSON.stringify(workerSource)})).runManagedRuntimeBootstrapWorker(process.argv[3]);}else{await (await import(${JSON.stringify(source)})).runManagedRuntimeBootstrap();}\n`,
      );
      const probed = await executeSshBootstrap({
        protocolVersion: 1,
        operation: 'probe',
        nodeId: 'node-a',
        stateDirectory,
        root: workspace,
        allowedRoots: [root],
      });
      identity = probed['identity'] as SshStorageIdentity;
      expectedQwenVersion = probed['qwenVersion'] as string;
      marker = {
        ...identity,
        version: 2,
        tenantId: 'tenant-a',
        storageId: 'storage-a',
        registrationId: randomUUID(),
      };
      await executeSshBootstrap({
        protocolVersion: 1,
        operation: 'register-storage',
        nodeId: 'node-a',
        stateDirectory,
        identity,
        marker,
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      pids.clear();
      await rm(root, { recursive: true, force: true });
    });

    function ensureRequest() {
      return {
        protocolVersion: 1,
        operation: 'ensure',
        nodeId: 'node-a',
        stateDirectory,
        resourceId: randomUUID(),
        bindingId: 'binding-a',
        bindingGeneration: 1,
        identity,
        marker,
        workerEntry: entry,
        expectedQwenVersion,
        launch: true,
        boot: {
          type: 'boot',
          version: 2,
          managedContext: 'managed-context/1',
          runtimeInstanceId: randomUUID(),
          runtimeIncarnation: randomUUID(),
          leaseId: randomUUID(),
          provisionRequestId: randomUUID(),
          token: randomUUID(),
          epoch: 1,
          capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
          isolationClass: 'session',
          tenantId: marker.tenantId,
          workspaceId: 'workspace-a',
          workspaceGeneration: '1',
          storageId: marker.storageId,
          mountRoot: workspace,
        },
      };
    }

    async function bootstrap(
      request: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const child = spawn(
        process.execPath,
        [entry, 'managed-runtime-bootstrap'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            QWEN_MANAGED_SECRET_TEST: 'must-not-reach-worker',
          },
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
      child.stdin.end(JSON.stringify(request));
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
      });
      if (exit !== 0) throw new Error(`Bootstrap exited ${exit}: ${stderr}`);
      expect(stdout.trim().split('\n')).toHaveLength(1);
      const response = JSON.parse(stdout) as Record<string, unknown>;
      const result = response['result'] as Record<string, unknown> | undefined;
      if (result && typeof result['pid'] === 'number') pids.add(result['pid']);
      return response;
    }

    async function ready(request: ReturnType<typeof ensureRequest>) {
      let response = await bootstrap(request);
      for (
        let attempt = 0;
        attempt < 40 &&
        (response['result'] as Record<string, unknown>)?.['state'] ===
          'STARTING';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        response = await bootstrap({
          protocolVersion: 1,
          operation: 'observe',
          nodeId: 'node-a',
          stateDirectory,
          resourceId: request.resourceId,
        });
      }
      if (
        (response['result'] as Record<string, unknown>)?.['state'] !== 'READY'
      ) {
        const stderr = await readFile(
          path.join(
            stateDirectory,
            'resources',
            request.resourceId,
            'stderr.log',
          ),
          'utf8',
        ).catch(() => 'no worker log');
        throw new Error(`${JSON.stringify(response)}\n${stderr}`);
      }
      return response['result'] as Record<string, unknown>;
    }

    function workerRequest(
      request: ReturnType<typeof ensureRequest>,
      observed: Record<string, unknown>,
    ) {
      const url = (observed['ready'] as { url: string }).url;
      return (route: string, body: unknown) =>
        fetch(`${url}${route}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${request.boot.token}`,
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
            'X-Qwen-Managed-Lease-Id': request.boot.leaseId,
            'X-Qwen-Managed-Lease-Epoch': String(request.boot.epoch),
          },
          body: JSON.stringify(body),
        });
    }

    function contextRequest(request: ReturnType<typeof ensureRequest>) {
      const binding = {
        tenantId: request.boot.tenantId,
        workspaceId: request.boot.workspaceId,
        workspaceGeneration: request.boot.workspaceGeneration,
        storageId: request.boot.storageId,
        cwdRelative: '.',
        contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
        contextRevision: '1',
      };
      return {
        protocolVersion: 3,
        managedContext: 'managed-context/1',
        operationId: randomUUID(),
        sessionId: 'runtime-session-a',
        contextDigest: computeManagedContextDigest(binding),
        binding,
      };
    }

    it('launches once under concurrent requests, survives its launcher, and cleanly retires', async () => {
      const request = ensureRequest();
      const responses = await Promise.all([
        bootstrap(request),
        bootstrap(request),
      ]);
      const original = await ready(request);
      const launched = responses
        .filter((item) => item['ok'])
        .map((item) => (item['result'] as Record<string, unknown>)['pid'])
        .filter((pid) => pid !== null);
      expect(new Set(launched).size).toBeLessThanOrEqual(1);
      const adopted = await bootstrap({
        protocolVersion: 1,
        operation: 'observe',
        nodeId: 'node-a',
        stateDirectory,
        resourceId: request.resourceId,
      });
      expect(adopted['result']).toEqual(original);
      const post = workerRequest(request, original);
      const context = contextRequest(request);
      expect(
        (await post('/internal/managed-runtime/v3/context', context)).status,
      ).toBe(200);
      expect(
        (
          await post('/internal/managed-runtime/v3/activation', {
            protocolVersion: 1,
            profile: WORKSPACE_EXECUTION_PROFILE,
            operation: 'activate',
            sessionId: context.sessionId,
            contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
            contextDigest: context.contextDigest,
          })
        ).status,
      ).toBe(200);
      const input = { file_path: 'existing.txt' };
      for (const route of [
        MANAGED_MCP_WORKER_ROUTE,
        MANAGED_HOOK_WORKER_ROUTE,
        MANAGED_SHELL_WORKER_ROUTE,
        MANAGED_MONITOR_WORKER_ROUTE,
      ]) {
        const refused = await post(route.path, {});
        expect(refused.status).toBe(501);
        expect(await refused.json()).toEqual({
          code: 'managed_runtime_profile_unsupported',
        });
      }
      const provider = (kind: string) =>
        post(MANAGED_RUNTIME_PROVIDER_ROUTE.path, {
          protocolVersion: 1,
          providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
          session: {
            harnessSessionId: 'harness-a',
            runtimeSessionId: context.sessionId,
            turnKind: 'bootstrap',
          },
          operation: { kind },
        });
      expect((await provider('acquire')).status).toBe(501);
      expect((await provider('workspace-context')).status).toBe(200);
      const reference = {
        sessionId: context.sessionId,
        promptId: 'prompt-a',
        callId: 'read-a',
        argsDigest: `sha256:${managedToolDigest(input)}`,
      };
      const read = await post('/internal/managed-runtime/v2/execute', {
        protocolVersion: 2,
        reference,
        toolName: 'read_file',
        input,
      });
      expect(await read.json()).toMatchObject({
        result: { executionStatus: 'success' },
      });
      const shellInput = {
        command: 'env',
        description: 'verify the Shell environment',
      };
      const shellReference = {
        ...reference,
        callId: 'environment-a',
        argsDigest: `sha256:${managedToolDigest(shellInput)}`,
      };
      const shell = await post('/internal/managed-runtime/v2/execute', {
        protocolVersion: 2,
        reference: shellReference,
        toolName: 'run_shell_command',
        input: shellInput,
      });
      const shellResult: unknown = await shell.json();
      expect(shellResult).toMatchObject({
        result: { executionStatus: 'success' },
      });
      expect(JSON.stringify(shellResult)).toContain('PATH=');
      expect(JSON.stringify(shellResult)).not.toContain(
        'must-not-reach-worker',
      );
      expect(JSON.stringify(shellResult)).not.toContain(request.boot.token);
      expect(
        (
          await post('/internal/managed-runtime/v2/acknowledge', {
            protocolVersion: 2,
            reference: shellReference,
          })
        ).status,
      ).toBe(200);
      const retirementId = randomUUID();
      expect(
        await bootstrap({
          protocolVersion: 1,
          operation: 'stop',
          nodeId: 'node-a',
          stateDirectory,
          resourceId: request.resourceId,
          retirementId,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_retirement_pending' },
      });
      expect(
        (
          await post('/internal/managed-runtime/v2/acknowledge', {
            protocolVersion: 2,
            reference,
          })
        ).status,
      ).toBe(200);
      const stopped = await bootstrap({
        protocolVersion: 1,
        operation: 'stop',
        nodeId: 'node-a',
        stateDirectory,
        resourceId: request.resourceId,
        retirementId,
      });
      expect(stopped).toMatchObject({
        ok: true,
        result: {
          state: 'RETIRED',
          cleanProof: {
            resourceId: request.resourceId,
            runtimeIncarnation: request.boot.runtimeIncarnation,
          },
        },
      });
      expect(() => process.kill(Number(original['pid']), 0)).toThrow();
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'RETIRED' },
      });
    }, 60_000);

    it('never replaces a killed generation or mistakes it for a clean stop', async () => {
      const request = ensureRequest();
      const original = await ready(request);
      process.kill(Number(original['pid']), 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'BLOCKED', pid: original['pid'] },
      });
      expect(
        await bootstrap({
          protocolVersion: 1,
          operation: 'stop',
          nodeId: 'node-a',
          stateDirectory,
          resourceId: request.resourceId,
          retirementId: randomUUID(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_stop_unverified', retryable: false },
      });
    }, 60_000);

    it('requires the exact original no-start v3 ACK before clean retirement', async () => {
      const request = ensureRequest();
      const observed = await ready(request);
      const post = workerRequest(request, observed);
      const context = contextRequest(request);
      expect(
        (await post('/internal/managed-runtime/v3/context', context)).status,
      ).toBe(200);
      expect(
        (
          await post('/internal/managed-runtime/v3/activation', {
            protocolVersion: 1,
            profile: WORKSPACE_EXECUTION_PROFILE,
            operation: 'activate',
            sessionId: context.sessionId,
            contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
            contextDigest: context.contextDigest,
          })
        ).status,
      ).toBe(200);
      const fixtures = JSON.parse(
        await readFile(
          new URL(
            '../../../core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        cases: Array<{ id: string; value: Record<string, unknown> }>;
      };
      const input = {
        command: 'printf should-not-run',
        directory: path.join(root, 'outside'),
      };
      const reference = {
        sessionId: context.sessionId,
        promptId: 'prompt-no-start',
        callId: 'call-no-start',
        argsDigest: `sha256:${managedToolDigest(input)}`,
      };
      const binding: Record<string, unknown> = {
        ...fixtures.cases.find(
          (item) => item.id === 'distinct-model-runtime-ids',
        )!.value,
        sessionKey: {
          tenantId: request.boot.tenantId,
          workspaceId: request.boot.workspaceId,
          sessionId: 'harness-no-start',
        },
        turnId: reference.promptId,
        reference,
        runtimeBindingId: request.bindingId,
      };
      expect(
        (
          await post(PUBLICATION_INSTALL_ROUTE.path, {
            protocolVersion: 3,
            publication: 'managed-tool-publication/1',
            publicationId: binding['publicationId'],
            publicationToken: 'A'.repeat(43),
            serviceBaseUrl: 'http://127.0.0.1:1/',
            binding,
          })
        ).status,
      ).toBe(200);
      const envelope = {
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        reference,
      };
      let result = (await (
        await post('/internal/managed-runtime/v3/execute', {
          ...envelope,
          toolName: 'run_shell_command',
          input,
          capture: {
            tenantId: request.boot.tenantId,
            sessionId: 'harness-no-start',
            turnId: reference.promptId,
            executionCallId: binding['executionCallId'],
            bindingGeneration: '1',
            capturePolicy: 'complete_required',
          },
        })
      ).json()) as Record<string, unknown>;
      for (
        let attempt = 0;
        result['state'] !== 'settled' && attempt < 40;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        result = (await (
          await post('/internal/managed-runtime/v3/status', envelope)
        ).json()) as Record<string, unknown>;
      }
      expect(result).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'not_started', capture: null },
      });
      const stop = {
        protocolVersion: 1,
        operation: 'stop',
        nodeId: 'node-a',
        stateDirectory,
        resourceId: request.resourceId,
        retirementId: randomUUID(),
      };
      expect(await bootstrap(stop)).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_retirement_pending' },
      });
      const acknowledgement = {
        ...envelope,
        receipt: {
          executionCallId: binding['executionCallId'],
          manifest: null,
          deliveryStatus: 'committed',
          historyRevision: null,
        },
      };
      expect(
        (
          await post(
            '/internal/managed-runtime/v3/acknowledge',
            acknowledgement,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await post('/internal/managed-runtime/v3/acknowledge', {
            ...acknowledgement,
            reference: { ...reference, argsDigest: `sha256:${'f'.repeat(64)}` },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(
            '/internal/managed-runtime/v3/acknowledge',
            acknowledgement,
          )
        ).status,
      ).toBe(200);
      expect(await bootstrap(stop)).toMatchObject({
        ok: true,
        result: { state: 'RETIRED' },
      });
    }, 60_000);

    it('rejects changed markers and permits multiple independent workers', async () => {
      const first = ensureRequest();
      const second = ensureRequest();
      const a = await ready(first);
      const b = await ready(second);
      expect(a['pid']).not.toBe(b['pid']);
      await writeFile(
        path.join(workspace, '.qwen-managed-storage.json'),
        JSON.stringify({ ...marker, registrationId: randomUUID() }),
        { mode: 0o600 },
      );
      expect(
        (
          await workerRequest(first, a)(
            '/internal/managed-runtime/v3/context',
            contextRequest(first),
          )
        ).status,
      ).toBe(409);
      expect(await bootstrap(first)).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_identity_conflict' },
      });
      expect(
        await bootstrap({
          protocolVersion: 1,
          operation: 'stop',
          nodeId: 'node-a',
          stateDirectory,
          resourceId: first.resourceId,
          retirementId: randomUUID(),
        }),
      ).toMatchObject({ ok: false });
    }, 60_000);

    it('retires an unlaunched intent atomically and fences every late ensure', async () => {
      const request = ensureRequest();
      expect(await bootstrap({ ...request, launch: false })).toMatchObject({
        ok: true,
        result: { state: 'INTENT', pid: null },
      });
      expect(
        await bootstrap({
          protocolVersion: 1,
          operation: 'stop',
          nodeId: 'node-a',
          stateDirectory,
          resourceId: request.resourceId,
          retirementId: randomUUID(),
        }),
      ).toMatchObject({
        ok: true,
        result: {
          state: 'RETIRED',
          pid: null,
          cleanProof: { resourceId: request.resourceId },
        },
      });
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'RETIRED', pid: null },
      });
    });

    it.each(['stdout.log', 'stderr.log'])(
      'retires a proven failed %s open without retrying the launch',
      async (log) => {
        const request = ensureRequest();
        const open = fs.open;
        const failure = vi
          .spyOn(fs, 'open')
          .mockImplementation(async (...args) => {
            if (String(args[0]).endsWith(`/${log}`))
              throw Object.assign(new Error('Descriptor limit'), {
                code: 'EMFILE',
              });
            return open(...args);
          });
        try {
          expect(await executeSshBootstrap(request)).toMatchObject({
            state: 'FAILED',
            pid: null,
          });
        } finally {
          failure.mockRestore();
        }
        expect(await bootstrap(request)).toMatchObject({
          ok: true,
          result: { state: 'FAILED', pid: null },
        });
        expect(
          await bootstrap({
            ...request,
            operation: 'stop',
            retirementId: randomUUID(),
          }),
        ).toMatchObject({ ok: true, result: { state: 'RETIRED', pid: null } });
        expect(await bootstrap(request)).toMatchObject({
          ok: true,
          result: { state: 'RETIRED', pid: null },
        });
      },
    );

    it('retires a failed spawn without deleting its unique launch claim', async () => {
      const request = {
        ...ensureRequest(),
        workerEntry: path.join(root, 'missing', 'entry.mjs'),
      };
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'FAILED', pid: null },
      });
      const claim = path.join(
        stateDirectory,
        'resources',
        request.resourceId,
        'launch.claim',
      );
      const original = await readFile(claim, 'utf8');
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'FAILED', pid: null },
      });
      expect(
        await bootstrap({
          ...request,
          operation: 'stop',
          retirementId: randomUUID(),
        }),
      ).toMatchObject({ ok: true, result: { state: 'RETIRED', pid: null } });
      expect(await readFile(claim, 'utf8')).toBe(original);
      expect(await bootstrap(request)).toMatchObject({
        ok: true,
        result: { state: 'RETIRED', pid: null },
      });
    });

    it('recovers the same worker when the launcher cannot publish its PID', async () => {
      const request = ensureRequest();
      const link = fs.link;
      const failure = vi
        .spyOn(fs, 'link')
        .mockImplementation(async (...args) => {
          if (String(args[1]).endsWith('/pid.json'))
            throw Object.assign(new Error('PID write failed'), { code: 'EIO' });
          return link(...args);
        });
      try {
        const observed = await executeSshBootstrap(request);
        if (typeof observed['pid'] === 'number') pids.add(observed['pid']);
      } finally {
        failure.mockRestore();
      }
      const original = await ready(request);
      expect((await ready(request))['pid']).toBe(original['pid']);
      expect(
        await bootstrap({
          ...request,
          operation: 'stop',
          retirementId: randomUUID(),
        }),
      ).toMatchObject({
        ok: true,
        result: { state: 'RETIRED', pid: original['pid'] },
      });
      expect(() => process.kill(Number(original['pid']), 0)).toThrow();
    }, 60_000);

    it('waits for the original starting worker before writing its retirement fence', async () => {
      const request = ensureRequest();
      const entered = path.join(root, 'entered');
      const gate = path.join(root, 'continue');
      await writeFile(
        entry,
        `import {register} from ${JSON.stringify(api)};\nimport {access,writeFile} from 'node:fs/promises';\nregister({tsconfig:${JSON.stringify(tsconfig)}});\nif(process.argv[2]==='managed-runtime-bootstrap-worker'){await writeFile(${JSON.stringify(entered)},String(process.pid));while(!(await access(${JSON.stringify(gate)}).then(()=>true,()=>false))){await new Promise(r=>setTimeout(r,10));}await (await import(${JSON.stringify(workerSource)})).runManagedRuntimeBootstrapWorker(process.argv[3]);}else{await (await import(${JSON.stringify(source)})).runManagedRuntimeBootstrap();}\n`,
      );
      const launching = bootstrap(request);
      const retirementId = randomUUID();
      try {
        await expect
          .poll(async () => readFile(entered, 'utf8'), { timeout: 10_000 })
          .toMatch(/^\d+$/);
        const pid = Number(await readFile(entered, 'utf8'));
        pids.add(pid);
        expect(
          await bootstrap({ ...request, operation: 'stop', retirementId }),
        ).toMatchObject({
          ok: false,
          error: { code: 'ssh_runtime_retirement_pending', retryable: true },
        });
        await expect(
          readFile(
            path.join(
              stateDirectory,
              'resources',
              request.resourceId,
              'stop.json',
            ),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await writeFile(gate, 'continue');
        await launching;
      }
      const original = await ready(request);
      expect(original['pid']).toBe(Number(await readFile(entered, 'utf8')));
      expect(
        await bootstrap({ ...request, operation: 'stop', retirementId }),
      ).toMatchObject({
        ok: true,
        result: {
          state: 'RETIRED',
          pid: original['pid'],
          cleanProof: { retirementId },
        },
      });
      expect(() => process.kill(Number(original['pid']), 0)).toThrow();
    }, 60_000);

    it('refuses a changed pinned Qwen version before claiming a launch', async () => {
      const request = ensureRequest();
      const response = await bootstrap({
        ...request,
        expectedQwenVersion: `${expectedQwenVersion}-different`,
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_version_conflict', retryable: false },
      });
      await expect(
        readFile(
          path.join(
            stateDirectory,
            'resources',
            request.resourceId,
            'launch.claim',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('can register an existing empty directory without synthesizing its birth identity', async () => {
      const empty = path.join(root, 'empty');
      await mkdir(empty);
      const probe = await executeSshBootstrap({
        protocolVersion: 1,
        operation: 'probe',
        nodeId: 'node-a',
        stateDirectory,
        root: empty,
        allowedRoots: [root],
      });
      const original = probe['identity'] as SshStorageIdentity;
      const registered = {
        ...original,
        version: 2,
        tenantId: 'tenant-a',
        storageId: 'empty-storage',
        registrationId: randomUUID(),
      };
      expect(
        await executeSshBootstrap({
          protocolVersion: 1,
          operation: 'register-storage',
          nodeId: 'node-a',
          stateDirectory,
          identity: original,
          marker: registered,
        }),
      ).toEqual({ identity: original, marker: registered });
    });

    it.skipIf(process.getuid?.() === 0).each(['root', 'cwd'])(
      'refuses a read-only %s during directory preview',
      async (selection) => {
        const target =
          selection === 'root' ? workspace : path.join(workspace, 'read-only');
        if (selection !== 'root') await mkdir(target);
        await chmod(target, 0o500);
        try {
          expect(
            await bootstrap({
              protocolVersion: 1,
              operation: 'probe',
              nodeId: 'node-a',
              stateDirectory,
              root: workspace,
              allowedRoots: [root],
              cwdRelative: selection === 'root' ? '.' : 'read-only',
            }),
          ).toMatchObject({ ok: false });
        } finally {
          await chmod(target, 0o700);
        }
      },
    );

    it('publishes only complete immutable JSON records under concurrent readers and writers', async () => {
      const file = path.join(stateDirectory, 'atomic.json');
      const value = { record: 'x'.repeat(32 * 1024) };
      let completed = false;
      const writing = Promise.all(
        Array.from({ length: 12 }, () => writeSshPrivateJson(file, value)),
      ).finally(() => {
        completed = true;
      });
      try {
        while (!completed) {
          try {
            expect(await readSshPrivateJson(file)).toEqual(value);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      } finally {
        await writing;
      }
      expect(await readSshPrivateJson(file)).toEqual(value);
    });

    it('keeps an incomplete launch claim blocked without spawning', async () => {
      const request = ensureRequest();
      await bootstrap({ ...request, launch: false });
      await writeFile(
        path.join(
          stateDirectory,
          'resources',
          request.resourceId,
          'launch.claim',
        ),
        '{',
        { mode: 0o600 },
      );
      expect(await bootstrap(request)).toMatchObject({
        ok: false,
        error: { retryable: false },
      });
    });

    it('never relaunches when an existing worker loses its launch claim', async () => {
      const request = ensureRequest();
      const original = await ready(request);
      await rm(
        path.join(
          stateDirectory,
          'resources',
          request.resourceId,
          'launch.claim',
        ),
      );
      expect(await bootstrap(request)).toMatchObject({
        ok: false,
        error: { code: 'ssh_runtime_identity_conflict', retryable: false },
      });
      expect(() => process.kill(Number(original['pid']), 0)).not.toThrow();
    }, 60_000);
  },
);
