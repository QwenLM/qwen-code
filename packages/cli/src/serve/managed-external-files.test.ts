/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ManagedToolRuntime } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import type { ManagedToolPrepareResponse } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ManagedExternalPublication } from './managed-external-publication.js';
import type { ManagedExternalContextBoot } from './managed-external-storage.js';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import { ManagedRuntimeProviderWorker } from './managed-runtime-provider-worker.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

const session = {
  harnessSessionId: '550e8400-e29b-41d4-a716-446655440001',
  runtimeSessionId: '550e8400-e29b-41d4-a716-446655440002',
  turnKind: 'bootstrap' as const,
};

describe.skipIf(process.platform === 'win32')(
  'external prepared files retirement',
  () => {
    let root: string;
    let workspace: string;
    let executor: ManagedToolExecutor;
    let provider: ManagedRuntimeProviderWorker;
    let publication: ManagedExternalPublication;
    let boot: ManagedExternalContextBoot;
    const releases: Array<() => void> = [];

    beforeEach(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-external-files-')),
      );
      workspace = path.join(root, 'workspace');
      await fs.mkdir(workspace, { mode: 0o700 });
      vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
        path.join(root, 'state'),
      );
      boot = {
        type: 'boot',
        version: 2,
        managedContext: 'managed-context/1',
        externalFiles: 'external-files/1',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        workspaceGeneration: '1',
        storageId: 'storage-a',
        mountRoot: workspace,
        runtimeInstanceId: 'runtime-a',
        runtimeIncarnation: 'incarnation-a',
        provisionRequestId: 'provision-a',
        leaseId: 'lease-a',
        epoch: 1,
        token: 'fixture-private-token',
        isolationClass: 'session',
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
        storage: {
          kind: 'external',
          physicalKey: 'physical-a',
          aliasPath: '/external/workspace-a',
          mountRoot: workspace,
          registrationRevision: 1,
        },
      };
      publication = new ManagedExternalPublication(root, boot);
      const ledger = ManagedRuntimeLedger.create({
        workFile: path.join(root, 'ledger.json'),
        worker: {
          pid: process.pid,
          pgid: process.pid,
          hostPid: process.ppid,
          incarnation: boot.runtimeIncarnation,
          startedAt: Date.now(),
        },
      });
      executor = new ManagedToolExecutor(
        async () => undefined,
        publication,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ledger, sshForegroundOnly: true, externalFilesOnly: true },
      );
      provider = new ManagedRuntimeProviderWorker(executor, async () => ({
        directory: workspace,
        workspaceRoot: workspace,
        preapproved: true,
        filesOnly: true,
      }));
      executor.attachProvider(provider);
    });

    afterEach(async () => {
      for (const release of releases.splice(0)) release();
      await executor.close();
      await publication.close();
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    });

    it('writes a real file, releases its prepared runtime and returns verified durable stop bytes', async () => {
      expect(await publication.stopDrained(executor)).toEqual({
        state: 'unknown',
      });
      await provider.control(session, { kind: 'acquire' });
      const manifest = (await provider.control(session, {
        kind: 'manifest',
      })) as {
        tools: Array<{ name: string }>;
        capabilityDigest: string;
        policyRevision: string;
      };
      expect(manifest.tools.map((tool) => tool.name)).toEqual([
        'read_file',
        'write_file',
        'edit',
      ]);
      await provider.control(session, {
        kind: 'bind-history',
        binding: {
          ownerSessionId: session.harnessSessionId,
          ownerRuntimeSessionId: session.runtimeSessionId,
          executionCwd: workspace,
          snapshots: [],
        },
      });
      const identity = {
        sessionId: session.runtimeSessionId,
        promptId: 'prompt-a',
        callId: 'call-a',
        capabilityDigest: manifest.capabilityDigest,
        policyRevision: manifest.policyRevision,
      };
      await provider.control(session, { kind: 'begin-turn', identity });
      await expect(
        provider.control(session, {
          kind: 'prepare',
          identity,
          toolName: 'run_shell_command',
          input: { command: 'touch should-not-exist' },
        }),
      ).rejects.toThrow();
      const prepared = (await provider.control(session, {
        kind: 'prepare',
        identity: { ...identity, callId: 'write-a' },
        toolName: 'write_file',
        input: {
          file_path: path.join(workspace, 'result.txt'),
          content: 'remote file witness\n',
        },
      })) as ManagedToolPrepareResponse;
      const {
        sessionId,
        promptId,
        callId,
        capabilityDigest,
        policyRevision,
        invocationId,
        argsDigest,
      } = prepared;
      const reference = {
        sessionId,
        promptId,
        callId,
        capabilityDigest,
        policyRevision,
        invocationId,
        argsDigest,
      };
      await provider.control(session, { kind: 'preflight', reference });
      expect(
        await provider.control(session, { kind: 'execute', reference }),
      ).toMatchObject({ executionStatus: 'success' });
      expect(
        await fs.readFile(path.join(workspace, 'result.txt'), 'utf8'),
      ).toBe('remote file witness\n');
      expect(await publication.stopFilesDrained(executor)).toEqual({
        state: 'unknown',
      });
      await provider.control(session, { kind: 'release' });
      const stopped = await publication.stopFilesDrained(executor);
      expect(stopped.state).toBe('drained');
      if (stopped.state !== 'drained')
        throw new Error('Missing file retirement proof');
      const bytes = Buffer.from(stopped.proofBytes, 'base64');
      expect(stopped.proof.byteLength).toBe(bytes.byteLength);
      expect(stopped.proof.digest).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(JSON.parse(bytes.toString())).toMatchObject({
        type: 'files-stop-drained',
        runtimeInstanceId: boot.runtimeInstanceId,
        runtimeIncarnation: boot.runtimeIncarnation,
        provisionRequestId: boot.provisionRequestId,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
        storage: boot.storage,
        filesOnly: true,
        unreleasedSessions: 0,
        pendingInvocations: 0,
        channels: [],
      });
      expect(await publication.stopFilesDrained(executor)).toEqual(stopped);
      await expect(
        provider.control(session, { kind: 'history' }),
      ).rejects.toThrow('has retired');
      expect(await provider.control(session, { kind: 'release' })).toBe(true);
      const stored = (await fs.readdir(root, { recursive: true })).find(
        (name) => name.endsWith(stopped.proof.resourceId),
      );
      expect(stored).toBeDefined();
      await fs.writeFile(path.join(root, stored!), 'tampered');
      expect(await publication.stopFilesDrained(executor)).toEqual({
        state: 'unknown',
      });
    });

    it('refuses private paths and symlinks retargeted after prepare', async () => {
      await provider.control(session, { kind: 'acquire' });
      const manifest = (await provider.control(session, {
        kind: 'manifest',
      })) as { capabilityDigest: string; policyRevision: string };
      await provider.control(session, {
        kind: 'bind-history',
        binding: {
          ownerSessionId: session.harnessSessionId,
          ownerRuntimeSessionId: session.runtimeSessionId,
          executionCwd: workspace,
          snapshots: [],
        },
      });
      const identity = {
        sessionId: session.runtimeSessionId,
        promptId: 'path-test',
        callId: 'private-read',
        capabilityDigest: manifest.capabilityDigest,
        policyRevision: manifest.policyRevision,
      };
      await provider.control(session, { kind: 'begin-turn', identity });
      const privateFile = path.join(root, 'private-secret.txt');
      await fs.writeFile(privateFile, 'private witness');
      for (const filePath of [privateFile, 'private-secret.txt']) {
        await expect(
          provider.control(session, {
            kind: 'prepare',
            identity,
            toolName: 'read_file',
            input: { file_path: filePath },
          }),
        ).rejects.toThrow('outside the Workspace');
      }
      await fs.mkdir(path.join(workspace, 'directory'));
      const prepared = (await provider.control(session, {
        kind: 'prepare',
        identity: { ...identity, callId: 'retarget' },
        toolName: 'write_file',
        input: {
          file_path: path.join(workspace, 'directory', 'private-secret.txt'),
          content: 'overwrite',
        },
      })) as ManagedToolPrepareResponse;
      const {
        sessionId,
        promptId,
        callId,
        capabilityDigest,
        policyRevision,
        invocationId,
        argsDigest,
      } = prepared;
      const reference = {
        sessionId,
        promptId,
        callId,
        capabilityDigest,
        policyRevision,
        invocationId,
        argsDigest,
      };
      await expect(
        provider.control(session, {
          kind: 'confirm',
          reference,
          outcome: ToolConfirmationOutcome.ProceedOnce,
          payload: {
            updatedInput: { file_path: privateFile, content: 'overwrite' },
          },
        }),
      ).rejects.toThrow('replacement is unsupported');
      await fs.rename(
        path.join(workspace, 'directory'),
        path.join(workspace, 'original-directory'),
      );
      await fs.symlink(root, path.join(workspace, 'directory'));
      for (const kind of ['confirmation', 'preflight', 'execute'] as const) {
        await expect(
          provider.control(session, { kind, reference }),
        ).rejects.toThrow('outside the Workspace');
      }
      expect(await fs.readFile(privateFile, 'utf8')).toBe('private witness');
    });

    it('keeps the legacy provider-used retirement refusal', async () => {
      await provider.control(session, { kind: 'acquire' });
      await provider.control(session, { kind: 'release' });
      await expect(
        executor.retireSsh('550e8400-e29b-41d4-a716-446655440003'),
      ).rejects.toThrow('not settled and acknowledged');
    });

    it('never qualifies a provider that used a non-file context', async () => {
      provider = new ManagedRuntimeProviderWorker(executor, async () => ({
        directory: workspace,
        workspaceRoot: workspace,
        preapproved: true,
      }));
      executor.attachProvider(provider);
      await provider.control(session, { kind: 'acquire' });
      await provider.control(session, { kind: 'release' });
      expect(await publication.stopFilesDrained(executor)).toEqual({
        state: 'unknown',
      });
      expect(await publication.stopFilesDrained(executor)).toEqual({
        state: 'unknown',
      });
    });

    it('does not forget an earlier retained-runtime cleanup failure', async () => {
      vi.spyOn(ManagedToolRuntime.prototype, 'dispose').mockRejectedValueOnce(
        new Error('cleanup failed'),
      );
      for (let index = 0; index < 9; index++) {
        const identity = {
          ...session,
          runtimeSessionId: `${session.runtimeSessionId}-${index}`,
        };
        await provider.control(identity, { kind: 'acquire' });
        await provider.control(identity, { kind: 'release' });
      }
      expect(await publication.stopFilesDrained(executor)).toEqual({
        state: 'unknown',
      });
    });

    it('closes observation admission while strict cleanup is in flight', async () => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      vi.spyOn(Config.prototype, 'shutdown').mockImplementationOnce(
        async () => {
          enter();
          await gate;
        },
      );
      await provider.control(session, { kind: 'acquire' });
      await provider.control(session, { kind: 'release' });
      const stopping = publication.stopFilesDrained(executor);
      await entered;
      await expect(
        provider.control(session, { kind: 'history' }),
      ).rejects.toThrow('has retired');
      release();
      expect((await stopping).state).toBe('drained');
    });
  },
);
