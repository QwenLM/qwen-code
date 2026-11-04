/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { Sandbox, SandboxNotFoundError, Volume } from 'e2b';
import { digest } from './provider.js';
import type { Cloud, Connection, Placement } from './provider.js';

// Reconstruct only the original connection. Sandbox.connect() resumes paused
// VMs, which would make an observation mutate the resource it is inspecting.
class OriginalSandbox extends Sandbox {
  readonly savedConnection: Connection;
  constructor(options: ConstructorParameters<typeof Sandbox>[0]) {
    super(options);
    if (!options.trafficAccessToken)
      throw new Error('Private E2B traffic is required.');
    this.savedConnection = {
      sandboxId: this.sandboxId,
      sandboxDomain: this.sandboxDomain,
      envdVersion: options.envdVersion,
      envdAccessToken: options.envdAccessToken,
      trafficAccessToken: options.trafficAccessToken,
    };
  }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export class E2bCloud implements Cloud {
  readonly credentialIdentity: string;
  private readonly options;
  constructor(
    apiKey: string,
    private readonly templateId: string,
    private readonly workerEntry: string,
    private readonly timeoutMs: number,
  ) {
    if (
      !apiKey ||
      !templateId ||
      !/^\/[A-Za-z0-9/._-]+$/u.test(workerEntry) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 60_000
    )
      throw new Error('Invalid E2B Cloud configuration.');
    this.credentialIdentity = digest({ apiKey });
    this.options = { apiKey, retries: 0, requestTimeoutMs: 30_000 };
  }

  private original(placement: Placement): OriginalSandbox {
    if (!placement.connection)
      throw new Error('Original E2B connection is unknown.');
    return new OriginalSandbox({ ...placement.connection, ...this.options });
  }
  private metadata(placement: Placement) {
    return {
      qwenRequest: placement.requestId,
      qwenIdentity: placement.identity,
      qwenProvider: placement.registration.providerId,
    };
  }
  async create(placement: Placement): Promise<Connection> {
    const volume = await Volume.connect(
      placement.registration.volumeId,
      this.options,
    );
    const sandbox = await OriginalSandbox.create(this.templateId, {
      ...this.options,
      idempotencyKey: placement.createKey,
      timeoutMs: this.timeoutMs,
      metadata: this.metadata(placement),
      network: { allowPublicTraffic: false },
      volumeMounts: { [placement.registration.mountRoot]: volume },
      lifecycle: { onTimeout: 'kill', autoResume: false },
    });
    return sandbox.savedConnection;
  }
  async find(placement: Placement): Promise<string[]> {
    const pager = Sandbox.list({
      ...this.options,
      query: { metadata: this.metadata(placement) },
    });
    const matches: string[] = [];
    while (pager.hasNext) {
      for (const item of await pager.nextItems()) {
        if (
          Object.entries(this.metadata(placement)).every(
            ([key, value]) => item.metadata[key] === value,
          )
        )
          matches.push(item.sandboxId);
      }
      if (matches.length > 1) break;
    }
    return matches;
  }
  async launch(placement: Placement): Promise<void> {
    const sandbox = this.original(placement);
    const registration = placement.registration;
    const info = await Sandbox.getInfo(sandbox.sandboxId, this.options);
    if (
      info.state !== 'running' ||
      !Object.entries(this.metadata(placement)).every(
        ([key, value]) => info.metadata[key] === value,
      )
    )
      throw new Error('Original sandbox is unavailable.');
    const volume = await Volume.connect(registration.volumeId, this.options);
    if (
      info.volumeMounts?.length !== 1 ||
      info.volumeMounts[0]?.name !== volume.name ||
      info.volumeMounts[0]?.path !== registration.mountRoot
    )
      throw new Error('E2B Volume mount is unavailable.');
    const challenge = '/.qwen-e2b-' + randomUUID();
    const nonce = randomUUID();
    await volume.writeFile(challenge, nonce, { mode: 0o600, uid: 0, gid: 0 });
    try {
      if (
        (await sandbox.files.read(registration.mountRoot + challenge, {
          user: 'root',
        })) !== nonce
      )
        throw new Error('E2B Volume identity is unverified.');
    } finally {
      await volume.remove(challenge);
    }
    const directory = '/run/qwen-e2b/' + placement.routeId;
    const prepared = await sandbox.commands.run(
      `set -eu; umask 077; install -d -m 700 ${quote(directory)}; chown 0:0 ${quote(registration.mountRoot)}; chmod 700 ${quote(registration.mountRoot)}`,
      { user: 'root' },
    );
    if (prepared.exitCode !== 0)
      throw new Error('Worker directory is unavailable.');
    await sandbox.files.write(
      directory + '/boot.json',
      JSON.stringify(placement.boot),
      { user: 'root' },
    );
    await sandbox.files.write(
      directory + '/registration.json',
      JSON.stringify({
        providerId: registration.providerId,
        physicalKey: registration.physicalKey,
        aliasPath: registration.aliasPath,
        mountRoot: registration.mountRoot,
        registrationRevision: registration.registrationRevision,
      }),
      { user: 'root' },
    );
    const secured = await sandbox.commands.run(
      `chmod 600 ${quote(directory)}/boot.json ${quote(directory)}/registration.json`,
      { user: 'root' },
    );
    if (secured.exitCode !== 0) throw new Error('Worker boot is unavailable.');
    await sandbox.commands.run(
      `mkdir ${quote(directory)}/started && exec setsid --wait node ${quote(this.workerEntry)} managed-runtime-worker --container-boot ${quote(directory)}/boot.json`,
      {
        user: 'root',
        background: true,
        timeoutMs: 0,
      },
    );
  }
  async observe(
    placement: Placement,
  ): Promise<'RUNNING' | 'STARTING' | 'UNKNOWN' | 'GONE'> {
    try {
      const sandbox = this.original(placement);
      const info = await Sandbox.getInfo(sandbox.sandboxId, this.options);
      if (
        info.state !== 'running' ||
        info.network?.allowPublicTraffic !== false ||
        !Object.entries(this.metadata(placement)).every(
          ([key, value]) => info.metadata[key] === value,
        )
      )
        return 'UNKNOWN';
      const boot = placement.boot;
      const {
        type: _type,
        version: _version,
        token: _token,
        storage: _storage,
        externalFiles: _files,
        externalShell: _shell,
        runtimeInstanceId: _runtime,
        runtimeIncarnation: _incarnation,
        leaseId: _lease,
        epoch: _epoch,
        ...context
      } = boot;
      const response = await this.forward(
        placement,
        43190,
        '/internal/managed-runtime/v3/attest',
        {
          authorization: 'Bearer ' + boot.token,
          'cache-control': 'no-store',
          'content-type': 'application/json',
          'x-qwen-managed-lease-id': boot.leaseId,
          'x-qwen-managed-lease-epoch': String(boot.epoch),
        },
        Buffer.from(JSON.stringify({ ...context, protocolVersion: 3 })),
      );
      if (!response.ok) return 'STARTING';
      const {
        type: _t,
        version: _v,
        token: _k,
        storage: _s,
        externalFiles: _f,
        externalShell: _sh,
        ...expected
      } = boot;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (!reader) return 'UNKNOWN';
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.length;
          if (length > 16 * 1024) return 'UNKNOWN';
          chunks.push(item.value);
        }
        return digest(JSON.parse(Buffer.concat(chunks).toString('utf8'))) ===
          digest({ ...expected, protocolVersion: 3 })
          ? 'RUNNING'
          : 'UNKNOWN';
      } finally {
        await reader?.cancel();
      }
    } catch (error) {
      return error instanceof SandboxNotFoundError ? 'GONE' : 'UNKNOWN';
    }
  }
  async stop(placement: Placement, confirmOnly: boolean): Promise<boolean> {
    if (!placement.connection) return false;
    const sandboxId = placement.connection.sandboxId;
    if (!confirmOnly) {
      try {
        await Sandbox.kill(sandboxId, this.options);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }
    try {
      await Sandbox.getInfo(sandboxId, this.options);
      return false;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return true;
      throw error;
    }
  }

  async forward(
    placement: Placement,
    port: number,
    route: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<Response> {
    const sandbox = this.original(placement);
    return fetch(`https://${sandbox.getHost(port)}${route}`, {
      method: 'POST',
      headers: {
        ...headers,
        'e2b-traffic-access-token': placement.connection!.trafficAccessToken,
      },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  }
}
