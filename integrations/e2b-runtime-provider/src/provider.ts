/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
const directory = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(value) &&
      value.split('/').every((part) => part !== '.' && part !== '..'),
  );
const storageSchema = z
  .object({
    kind: z.literal('external'),
    physicalKey: id,
    aliasPath: directory,
    mountRoot: directory,
    registrationRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const registrationSchema = storageSchema
  .omit({ kind: true })
  .extend({
    providerId: id,
    tenantId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    workspaceId: id,
    volumeId: id,
  })
  .strict();
export type Registration = z.infer<typeof registrationSchema>;
const bootSchema = z
  .object({
    type: z.literal('boot'),
    version: z.literal(2),
    managedContext: z.literal('managed-context/1'),
    externalFiles: z.literal('external-files/1'),
    externalShell: z.literal(true).optional(),
    tenantId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    workspaceId: id,
    workspaceGeneration: z.string().regex(/^[1-9][0-9]*$/u),
    storageId: id,
    mountRoot: directory,
    runtimeInstanceId: id,
    runtimeIncarnation: id,
    provisionRequestId: id,
    leaseId: id,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    token: z.string().min(16).max(4096),
    isolationClass: z.literal('session'),
    capabilityDigest: z.literal(
      'sha256:7df3981fa14b397fe09f6ba84ed0c096c71902394da667bf47f3b315866e7f91',
    ),
    storage: storageSchema,
  })
  .strict();
export type Boot = z.infer<typeof bootSchema>;
const common = z.object({
  protocolVersion: z.literal(1),
  provisionRequestId: id,
  identity: z.string().regex(/^[0-9a-f]{64}$/u),
  handle: z.object({ requestId: id }).strict(),
});
const provisionSchema = common
  .extend({
    boot: bootSchema,
    scope: z
      .object({
        tenantId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
        workspaceId: id,
        workspaceGeneration: z.string(),
        workspaceCwd: directory,
        isolationClass: z.literal('session'),
        isolationKey: id,
      })
      .strict(),
  })
  .strict();
const observeSchema = common.strict();
const proofSchema = z
  .object({
    protocolVersion: z.literal(2),
    state: z.literal('drained'),
    proof: z
      .object({
        resourceId: z.string().uuid(),
        kind: z.enum([
          'external-files-retirement',
          'external-tools-retirement',
        ]),
        schemaVersion: z.literal(1),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(16 * 1024),
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    proofBytes: z.string().max(24 * 1024),
  })
  .strict();
const retireSchema = common
  .extend({
    retirementKey: z.string().regex(/^[0-9a-f]{64}$/u),
    confirmOnly: z.boolean(),
    proof: proofSchema.optional(),
  })
  .strict();
type Retirement = {
  key: string;
  proof: z.infer<typeof proofSchema>;
  retiredAt?: string;
};

function verifyProof(
  value: z.infer<typeof proofSchema>,
  placement: Placement,
): void {
  const bytes = Buffer.from(value.proofBytes, 'base64');
  const boot = placement.boot;
  if (
    bytes.toString('base64') !== value.proofBytes ||
    bytes.length !== value.proof.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== value.proof.digest ||
    value.proof.kind !==
      (boot.externalShell
        ? 'external-tools-retirement'
        : 'external-files-retirement')
  )
    throw new ProviderError(409);
  const { retirementId, retiredAt, ...proof } = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  z.string().uuid().parse(retirementId);
  if (
    typeof retiredAt !== 'string' ||
    !Number.isFinite(Date.parse(retiredAt)) ||
    Date.parse(retiredAt) > Date.now() + 30_000
  )
    throw new ProviderError(409);
  const expected = {
    proofVersion: 1,
    type: boot.externalShell ? 'tools-stop-drained' : 'files-stop-drained',
    profile: boot.externalShell ? 'external-tools/1' : 'external-files/1',
    tenantId: boot.tenantId,
    workspaceId: boot.workspaceId,
    workspaceGeneration: boot.workspaceGeneration,
    storageId: boot.storageId,
    storage: boot.storage,
    runtimeInstanceId: boot.runtimeInstanceId,
    runtimeIncarnation: boot.runtimeIncarnation,
    provisionRequestId: boot.provisionRequestId,
    capabilityDigest: boot.capabilityDigest,
    leaseId: boot.leaseId,
    epoch: boot.epoch,
    filesOnly: !boot.externalShell,
    ...(boot.externalShell ? { foregroundShell: true } : {}),
    unreleasedSessions: 0,
    pendingInvocations: 0,
    channels: [],
  };
  if (digest(proof) !== digest(expected)) throw new ProviderError(409);
}

export function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function sameSecret(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface Connection {
  sandboxId: string;
  sandboxDomain: string;
  envdVersion: string;
  envdAccessToken?: string;
  trafficAccessToken: string;
}
export interface Placement {
  requestId: string;
  identity: string;
  requestDigest: string;
  routeId: string;
  createKey: string;
  boot: Boot;
  registration: Registration;
  connection?: Connection;
}
export interface Cloud {
  readonly credentialIdentity: string;
  create(placement: Placement): Promise<Connection>;
  find(placement: Placement): Promise<string[]>;
  launch(placement: Placement): Promise<void>;
  observe(
    placement: Placement,
  ): Promise<'RUNNING' | 'STARTING' | 'UNKNOWN' | 'GONE'>;
  stop(placement: Placement, confirmOnly: boolean): Promise<boolean>;
  forward(
    placement: Placement,
    port: number,
    route: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<Response>;
}

export class ProviderError extends Error {
  constructor(readonly status: number) {
    super('E2B provider request refused.');
  }
}

export class E2bProvider {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly cloud: Cloud,
    private readonly providerId: string,
    private readonly registrations: Registration[],
    readonly workerDomain: string,
  ) {}

  static async open(
    stateDirectory: string,
    cloud: Cloud,
    providerId: string,
    registrations: Registration[],
    workerDomain: string,
  ): Promise<E2bProvider> {
    id.parse(providerId);
    z.string()
      .regex(/^[0-9a-f]{64}$/u)
      .parse(cloud.credentialIdentity);
    if (!path.isAbsolute(stateDirectory))
      throw new Error('Provider directory must be absolute.');
    const aliases = new Set<string>();
    const volumes = new Set<string>();
    const paths = new Set<string>();
    for (const item of registrations.map((value) =>
      registrationSchema.parse(value),
    )) {
      const alias = item.tenantId + ':' + item.workspaceId;
      if (
        item.providerId !== providerId ||
        item.physicalKey !== item.volumeId ||
        aliases.has(alias) ||
        volumes.has(item.volumeId) ||
        paths.has(item.aliasPath)
      )
        throw new Error('Duplicate or inconsistent E2B Volume registration.');
      aliases.add(alias);
      volumes.add(item.volumeId);
      paths.add(item.aliasPath);
    }
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(stateDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      (await realpath(stateDirectory)) !== stateDirectory ||
      !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u.test(workerDomain)
    )
      throw new Error('Invalid private provider directory or worker domain.');
    const file = path.join(stateDirectory, 'placements.sqlite');
    await (await open(file, 'a', 0o600)).close();
    const fileStat = await lstat(file);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.nlink !== 1 ||
      fileStat.uid !== process.getuid?.() ||
      (fileStat.mode & 0o777) !== 0o600
    )
      throw new Error('Invalid private provider database.');
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS provider_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placements (request_id TEXT PRIMARY KEY, route_id TEXT UNIQUE NOT NULL,
        record TEXT NOT NULL, launch INTEGER NOT NULL DEFAULT 0, retirement TEXT);`);
      const identity = digest({
        providerId,
        credentialIdentity: cloud.credentialIdentity,
      });
      db.prepare('INSERT OR IGNORE INTO provider_identity VALUES (1, ?)').run(
        identity,
      );
      if (
        db
          .prepare('SELECT identity FROM provider_identity WHERE singleton = 1')
          .get()?.['identity'] !== identity
      )
        throw new Error(
          'Provider journal requires its original E2B credential.',
        );
    } catch (error) {
      db.close();
      throw error;
    }
    return new E2bProvider(
      db,
      cloud,
      providerId,
      registrations.map((item) => registrationSchema.parse(item)),
      workerDomain,
    );
  }

  private read(requestId: string): Placement | undefined {
    const row = this.db
      .prepare('SELECT record FROM placements WHERE request_id = ?')
      .get(requestId);
    return row ? (JSON.parse(String(row['record'])) as Placement) : undefined;
  }
  private save(placement: Placement): void {
    this.db
      .prepare('UPDATE placements SET record = ? WHERE request_id = ?')
      .run(JSON.stringify(placement), placement.requestId);
  }
  route(host: string): Placement | undefined {
    const row = this.db
      .prepare('SELECT record FROM placements WHERE route_id = ?')
      .get(host.replace('.' + this.workerDomain, ''));
    return host.endsWith('.' + this.workerDomain) && row
      ? (JSON.parse(String(row['record'])) as Placement)
      : undefined;
  }

  async provision(value: unknown): Promise<object> {
    const input = provisionSchema.parse(value);
    const boot = input.boot;
    const { token: _token, ...identityBoot } = boot;
    if (
      input.handle.requestId !== input.provisionRequestId ||
      boot.provisionRequestId !== input.provisionRequestId ||
      boot.storageId !== boot.workspaceId ||
      boot.mountRoot !== boot.storage.mountRoot ||
      digest({
        version: 1,
        providerId: this.providerId,
        isolationKey: input.scope.isolationKey,
        boot: identityBoot,
      }) !== input.identity ||
      input.scope.tenantId !== boot.tenantId ||
      input.scope.workspaceId !== boot.workspaceId ||
      input.scope.workspaceGeneration !== boot.workspaceGeneration ||
      input.scope.workspaceCwd !== boot.mountRoot
    )
      throw new ProviderError(409);
    const registration = this.registrations.find(
      (item) =>
        item.tenantId === boot.tenantId &&
        item.workspaceId === boot.workspaceId,
    );
    if (
      !registration ||
      registration.providerId !== this.providerId ||
      digest({
        kind: 'external',
        physicalKey: registration.physicalKey,
        aliasPath: registration.aliasPath,
        mountRoot: registration.mountRoot,
        registrationRevision: registration.registrationRevision,
      }) !== digest(boot.storage)
    )
      throw new ProviderError(409);
    let placement: Placement = {
      requestId: input.provisionRequestId,
      identity: input.identity,
      requestDigest: digest(input),
      routeId: randomUUID().replaceAll('-', ''),
      createKey: randomUUID(),
      boot,
      registration,
    };
    const created =
      this.db
        .prepare(
          'INSERT OR IGNORE INTO placements(request_id, route_id, record) VALUES (?, ?, ?)',
        )
        .run(placement.requestId, placement.routeId, JSON.stringify(placement))
        .changes === 1;
    const saved = this.read(placement.requestId)!;
    if (saved.requestDigest !== placement.requestDigest)
      throw new ProviderError(409);
    placement = saved;
    if (created) {
      placement.connection = await this.cloud.create(placement);
      this.save(placement);
    }
    if (
      placement.connection &&
      this.db
        .prepare(
          'UPDATE placements SET launch = 1 WHERE request_id = ? AND launch = 0',
        )
        .run(placement.requestId).changes === 1
    ) {
      await this.cloud.launch(placement);
      this.db
        .prepare('UPDATE placements SET launch = 2 WHERE request_id = ?')
        .run(placement.requestId);
    }
    return { protocolVersion: 1, handle: input.handle };
  }

  async observe(value: unknown): Promise<object> {
    const input = observeSchema.parse(value);
    const placement = this.read(input.provisionRequestId);
    if (
      input.handle.requestId !== input.provisionRequestId ||
      (placement && placement.identity !== input.identity)
    )
      throw new ProviderError(409);
    if (!placement) return { protocolVersion: 1, state: 'UNKNOWN' };
    // A lost create response cannot authorize another create or a resume. The
    // SDK cannot recover traffic credentials through a read-only lookup.
    if (!placement.connection) {
      const found = await this.cloud.find(placement);
      if (found.length > 1) throw new ProviderError(409);
      return { protocolVersion: 1, state: 'UNKNOWN' };
    }
    const state = await this.cloud.observe(placement);
    const storage = placement.registration;
    return {
      protocolVersion: 1,
      state,
      ...(state === 'RUNNING'
        ? {
            endpoint: `https://${placement.routeId}.${this.workerDomain}`,
            storage: {
              storageRef: digest({
                providerId: storage.providerId,
                physicalKey: storage.physicalKey,
                registrationRevision: storage.registrationRevision,
              }),
              mountRoot: storage.mountRoot,
              continuity: 'confirms',
            },
          }
        : {}),
    };
  }

  async retire(value: unknown): Promise<object> {
    const input = retireSchema.parse(value);
    const placement = this.read(input.provisionRequestId);
    if (
      !placement ||
      input.handle.requestId !== input.provisionRequestId ||
      input.identity !== placement.identity
    )
      throw new ProviderError(409);
    const readRetirement = (): Retirement | undefined => {
      const row = this.db
        .prepare('SELECT retirement FROM placements WHERE request_id = ?')
        .get(placement.requestId);
      return row?.['retirement']
        ? (JSON.parse(String(row['retirement'])) as Retirement)
        : undefined;
    };
    let retirement = readRetirement();
    if (!retirement && input.confirmOnly)
      return { protocolVersion: 1, state: 'UNKNOWN' };
    if (!retirement) {
      if (!placement.connection || !input.proof) throw new ProviderError(409);
      verifyProof(input.proof, placement);
      this.db
        .prepare(
          'UPDATE placements SET retirement = ? WHERE request_id = ? AND retirement IS NULL',
        )
        .run(
          JSON.stringify({ key: input.retirementKey, proof: input.proof }),
          placement.requestId,
        );
      retirement = readRetirement()!;
    }
    if (
      retirement.key !== input.retirementKey ||
      (input.proof && digest(input.proof) !== digest(retirement.proof))
    )
      throw new ProviderError(409);
    verifyProof(retirement.proof, placement);
    if (!retirement.retiredAt) {
      if (await this.cloud.stop(placement, input.confirmOnly)) {
        const previous = JSON.stringify(retirement);
        const stopped = { ...retirement, retiredAt: new Date().toISOString() };
        this.db
          .prepare(
            'UPDATE placements SET retirement = ? WHERE request_id = ? AND retirement = ?',
          )
          .run(JSON.stringify(stopped), placement.requestId, previous);
        retirement = readRetirement()!;
      }
    }
    return {
      protocolVersion: 1,
      state: retirement.retiredAt ? 'STOPPED' : 'RETIRING',
      identity: placement.identity,
      handle: input.handle,
      retirementKey: retirement.key,
      proof: retirement.proof,
      ...(retirement.retiredAt ? { retiredAt: retirement.retiredAt } : {}),
    };
  }

  close(): void {
    this.db.close();
  }
}
