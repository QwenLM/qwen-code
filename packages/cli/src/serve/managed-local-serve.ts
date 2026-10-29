/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import {
  resolveManagedLocalRuntime,
  type ManagedLocalRuntime,
} from './managed-local-runtime.js';
import {
  openManagedLocalState,
  type ManagedLocalState,
} from './managed-local-state.js';
import { signedManagedHeaders } from './managed-local-web.js';
import { runQwenServe, type RunHandle } from './run-qwen-serve.js';
import { resolveWebShellDir } from './web-shell-resolver.js';
import {
  loadManagedLocalModels,
  type ManagedLocalModel,
} from './managed-local-models.js';
import { createHostedHarnessContract } from './hosted-harness-contract.js';

export interface ManagedLocalServeOptions {
  port: number;
  dataDirectory?: string;
}

export function managedLocalJavaEnvironment(
  state: ManagedLocalState,
  directory: string,
  runtime: ManagedLocalRuntime,
  models: readonly ManagedLocalModel[] = [],
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('SPRING_') &&
        !name.startsWith('QWEN_MANAGED_AGENT_') &&
        !name.startsWith('QWEN_HOSTED_') &&
        name !== 'QWEN_SERVER_TOKEN',
    ),
  );
  return {
    ...environment,
    SPRING_APPLICATION_JSON: JSON.stringify({
      'qwen.managed-agent.runtime-broker.session-worktrees-enabled':
        process.platform !== 'win32',
      'qwen.managed-agent.model-catalog': models,
      'qwen.managed-agent.definition-models': models.map(
        (model) => model.modelId,
      ),
      'qwen.managed-agent.definition-tool-profiles': [
        'hosted-workspace-shell/1',
      ],
    }),
    SPRING_PROFILES_ACTIVE: 'managed-local',
    SERVER_PORT: String(state.javaPort),
    QWEN_MANAGED_AGENT_LOCAL_DATA_DIRECTORY: directory,
    QWEN_MANAGED_AGENT_AUTH_MODE: 'signed',
    QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY: state.signingKey,
    QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER: '',
    QWEN_MANAGED_AGENT_LOCAL_DIRECTORY_IMPORT_ENABLED: 'true',
    QWEN_MANAGED_AGENT_SERVER_ADDRESS: '127.0.0.1',
    QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED: 'true',
    QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL: `http://127.0.0.1:${state.javaPort}`,
    QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY: state.writerBindingKey,
    QWEN_MANAGED_AGENT_WORKSPACE_ID: createHash('sha256')
      .update(path.join(directory, 'legacy'))
      .digest('hex')
      .slice(0, 16),
    QWEN_MANAGED_AGENT_WORKSPACE_CWD: path.join(directory, 'legacy'),
    QWEN_MANAGED_AGENT_WORKSPACE_CREATION_ROOT: path.join(
      directory,
      'workspaces',
    ),
    QWEN_MANAGED_AGENT_HARNESS_ENABLED: 'true',
    QWEN_MANAGED_AGENT_HARNESS_BASE_URL: `http://127.0.0.1:${state.harnessPort}`,
    QWEN_MANAGED_AGENT_HARNESS_TOKEN: state.harnessToken,
    QWEN_MANAGED_AGENT_CAPABILITY_DIGEST: state.capabilityDigest,
    QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED: 'true',
    QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED: 'true',
    QWEN_MANAGED_AGENT_APPROVAL_MODE: 'default',
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true',
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_HOST: '127.0.0.1',
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_PORT: String(state.brokerPort),
    QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN: state.brokerToken,
    QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER: 'local-process',
    QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS: 'true',
    QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY: 'false',
    QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED: 'true',
    QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'managed-local-v1',
    QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: state.runtimeCredentialKey,
    QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: path.join(directory, 'runtime'),
    QWEN_MANAGED_AGENT_NODE_EXECUTABLE: process.execPath,
    QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: runtime.cliEntry,
    QWEN_HOME: path.join(directory, 'worker-home'),
  };
}

async function stopChild(
  child: ChildProcess,
  processGroup: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(35_000, false, { ref: false }),
  ]);
  if (!stopped) {
    // The Harness owns its ACP children. Java workers retain SQL ownership
    // across a control-plane exit and must not be killed as a process group.
    try {
      if (processGroup) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await exited;
  }
}

export async function runManagedLocalServe(
  options: ManagedLocalServeOptions,
): Promise<{
  url: string;
  resolvedToken: string;
  webShellMounted: true;
  finished: Promise<number>;
  close(): Promise<void>;
}> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  const runtime = await resolveManagedLocalRuntime();
  const webShellDir = resolveWebShellDir();
  if (!webShellDir)
    throw new Error('The Managed distribution requires built WebShell assets.');
  const local = await openManagedLocalState(options.dataDirectory);
  const { state, directory } = local;
  const children: Array<{
    process: ChildProcess;
    group: boolean;
  }> = [];
  let frontDoor: RunHandle | undefined;
  let ready = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const shutdown = (code: number): Promise<void> => {
    closing ??= (async () => {
      let exitCode = code;
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          exitCode = 1;
          writeStderrLine(
            `Managed shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      await cleanup(async () => frontDoor?.close());
      for (const child of [...children].reverse()) {
        await cleanup(() => stopChild(child.process, child.group));
      }
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      await cleanup(local.release);
      finish(exitCode);
    })();
    return closing;
  };
  const onSignal = () => {
    void shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const start = (
    name: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    group: boolean,
  ) => {
    if (closing) throw new Error('Managed startup interrupted.');
    const logPath = path.join(directory, 'logs', `${name}.log`);
    const fd = openSync(logPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: directory,
        env,
        stdio: ['ignore', fd, fd],
        // Terminal SIGINT belongs to the launcher. Durable workers must not
        // receive it through Java's inherited foreground process group.
        detached: true,
      });
    } finally {
      closeSync(fd);
    }
    children.push({ process: child, group });
    const failed = (reason: string) => {
      failure ??= new Error(`${name} ${reason}. See ${logPath}`);
      if (ready && !closing) {
        writeStderrLine(`qwen serve --managed: ${failure.message}`);
        void shutdown(1);
      }
    };
    child.once('error', (error) => failed(error.message));
    child.once('exit', (code, signal) => failed(`exited (${signal ?? code})`));
  };
  const waitFor = async (name: string, probe: () => Promise<boolean>) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (closing) throw new Error('Managed startup interrupted.');
      try {
        if (await probe()) return;
      } catch {
        /* process is still starting */
      }
      await delay(200);
    }
    throw new Error(
      `${name} did not become ready. See ${path.join(directory, 'logs')}`,
    );
  };

  try {
    const { models, defaultModelId } = loadManagedLocalModels();
    if (
      [state.javaPort, state.harnessPort, state.brokerPort].includes(
        options.port,
      )
    ) {
      throw new Error(
        'Public --port conflicts with a persisted private service port. Choose another public port.',
      );
    }
    writeStdoutLine(`Starting Managed local services. Data: ${directory}`);
    const javaUrl = `http://127.0.0.1:${state.javaPort}`;
    const harnessUrl = `http://127.0.0.1:${state.harnessPort}`;
    const lifecycleV2Profiles = createHostedHarnessContract(
      state.capabilityDigest,
    ).lifecycleV2Profiles;
    start(
      'harness',
      process.execPath,
      [
        runtime.cliEntry,
        'serve',
        '--profile',
        'hosted-harness',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(state.harnessPort),
        '--require-auth',
        '--no-web',
        '--workspace',
        path.join(directory, 'harness'),
      ],
      {
        ...process.env,
        QWEN_SERVER_TOKEN: state.harnessToken,
        QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: state.capabilityDigest,
        QWEN_MANAGED_RUNTIME_BROKER_URL: `http://127.0.0.1:${state.brokerPort}`,
        QWEN_MANAGED_RUNTIME_BROKER_TOKEN: state.brokerToken,
        QWEN_RUNTIME_DIR: path.join(directory, 'harness'),
      },
      true,
    );
    start(
      'server',
      runtime.java,
      ['-jar', runtime.serverJar],
      managedLocalJavaEnvironment(state, directory, runtime, models),
      false,
    );
    await waitFor('Hosted Harness', async () => {
      const response = await fetch(`${harnessUrl}/capabilities`, {
        headers: { Authorization: `Bearer ${state.harnessToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const body: unknown = await response.json();
      return Boolean(
        body &&
          typeof body === 'object' &&
          'hostedHarness' in body &&
          body.hostedHarness &&
          typeof body.hostedHarness === 'object' &&
          'capabilityDigest' in body.hostedHarness &&
          body.hostedHarness.capabilityDigest === state.capabilityDigest &&
          'lifecycleV2Profiles' in body.hostedHarness &&
          Array.isArray(body.hostedHarness.lifecycleV2Profiles) &&
          JSON.stringify(body.hostedHarness.lifecycleV2Profiles) ===
            JSON.stringify(lifecycleV2Profiles),
      );
    });
    await waitFor('Java control plane', async () => {
      const response = await fetch(`${javaUrl}/actuator/health/readiness`, {
        signal: AbortSignal.timeout(3000),
      });
      const ok = response.ok;
      await response.body?.cancel();
      return ok;
    });
    const tenantId = `local-${state.installationId}`;
    const actorId = 'local-user';
    const modelPresets: Array<{
      agentId: string;
      label: string;
      modelId?: string;
    }> = models.map(({ modelId, label }) => ({
      agentId: 'qwen-code',
      modelId,
      label,
    }));
    if (models.length && !defaultModelId) {
      modelPresets.unshift({
        agentId: 'qwen-code',
        label: 'Server default model',
      });
    }
    const route = '/api/agent/web-shell/v1/workspaces/create';
    const body = Buffer.from(
      JSON.stringify({
        displayName: 'Local workspace',
        idempotencyKey: 'managed-local-default-workspace-v1',
      }),
    );
    const bootstrap = await fetch(`${javaUrl}${route}`, {
      method: 'POST',
      headers: {
        ...signedManagedHeaders({
          method: 'POST',
          path: route,
          body,
          signingKey: state.signingKey,
          tenantId,
          actorId,
        }),
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!bootstrap.ok) {
      const message = (await bootstrap.text()).slice(0, 2000);
      throw new Error(
        `Local Workspace admission failed (${bootstrap.status}): ${message}`,
      );
    }
    await bootstrap.body?.cancel();
    if (failure) throw failure;
    if (closing) throw new Error('Managed startup interrupted.');
    frontDoor = await runQwenServe(
      {
        port: options.port,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        token: state.publicToken,
        requireAuth: true,
        workspace: process.cwd(),
        serveWebShell: true,
        requireWebShell: true,
      },
      {
        installSignalHandlers: false,
        preheatBridge: false,
        managedLocalWeb: {
          javaUrl,
          signingKey: state.signingKey,
          tenantId,
          actorId,
          productScope: `local:${state.installationId}`,
          agentId: 'qwen-code',
          modelPresets,
        },
      },
    );
    frontDoor.server.once('close', () => {
      if (!closing) {
        writeStderrLine('qwen serve --managed: daemon listener closed.');
        void shutdown(1);
      }
    });
    ready = true;
    if (failure || closing) {
      await frontDoor.close();
      throw failure ?? new Error('Managed startup interrupted.');
    }
    writeStdoutLine(
      `Managed workspaces: ${path.join(directory, 'workspaces')}`,
    );
    writeStdoutLine(
      `WebShell: ${frontDoor.url}/#token=${encodeURIComponent(state.publicToken)}`,
    );
    return {
      url: frontDoor.url,
      resolvedToken: state.publicToken,
      webShellMounted: true,
      finished,
      close: () => shutdown(0),
    };
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}
