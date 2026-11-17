/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  inspectManagedPackageArchive,
  parseManagedPackageImportMetadata,
  prepareManagedPackageImport,
  type ManagedPackageImportMetadata,
} from '@qwen-code/qwen-code-core/extension/managed-package-import.js';
import {
  MANAGED_PACKAGE_MAX_ARCHIVE_BYTES,
  ManagedPackageCompatibilityError,
} from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { ManagedMcpRecipeError } from '@qwen-code/qwen-code-core/extension/managed-mcp-recipe.js';
import {
  hostedHarnessContractMiddleware,
  type HostedHarnessContract,
} from './hosted-harness-contract.js';

export const HOSTED_PACKAGE_PREPARATION_PREFIX =
  '/internal/hosted-harness/v1/managed-packages';
const TTL_MS = 15 * 60_000;
const DEADLINE_MS = 10 * 60_000;
const MAX_PREPARING = 2;
const MAX_PREPARED = 16;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
const INPUT_DISK_RESERVATION =
  2 * 1024 ** 3 + 2 * MANAGED_PACKAGE_MAX_ARCHIVE_BYTES;
const MAX_TEMPORARY_BYTES = 6 * 1024 ** 3;

interface Scope {
  tenantId: string;
  workspaceId: string;
  actorKey: string;
}
interface Envelope extends Scope {
  input: ManagedPackageImportMetadata;
}
interface Artifact {
  directory: string;
  scope: string;
  expiresAt: number;
  byteLength: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid preparation request.');
  return value as Record<string, unknown>;
}

function scope(value: unknown): Scope {
  const input = object(value);
  if (
    Object.keys(input).sort().join(',') !== 'actorKey,tenantId,workspaceId' ||
    ![input['tenantId'], input['workspaceId']].every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 512 &&
        ![...item].some((character) => character.charCodeAt(0) < 32),
    ) ||
    typeof input['actorKey'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input['actorKey'])
  )
    throw new Error('Invalid preparation scope.');
  return input as unknown as Scope;
}

function envelope(req: Request): Envelope {
  if (
    typeof req.query['metadata'] !== 'string' ||
    req.query['metadata'].length > 4096
  )
    throw new Error('Invalid preparation metadata.');
  const input = object(JSON.parse(req.query['metadata']));
  if (
    Object.keys(input).sort().join(',') !==
    'actorKey,input,tenantId,workspaceId'
  )
    throw new Error('Invalid preparation metadata.');
  return {
    ...scope({
      tenantId: input['tenantId'],
      workspaceId: input['workspaceId'],
      actorKey: input['actorKey'],
    }),
    input: parseManagedPackageImportMetadata(input['input']),
  };
}

function scopeKey(input: Scope): string {
  return JSON.stringify([input.tenantId, input.workspaceId, input.actorKey]);
}

async function receive(
  req: Request,
  file: string,
  limit: number,
  signal: AbortSignal,
): Promise<void> {
  if (!req.is('application/octet-stream'))
    throw new Error('Invalid content type.');
  const declared = req.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) > limit)
  )
    throw new Error('Input exceeds its limit.');
  let length = 0;
  async function* bounded() {
    for await (const chunk of req) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > limit) throw new Error('Input exceeds its limit.');
      yield bytes;
    }
  }
  await fs.writeFile(file, bounded(), { flag: 'wx', mode: 0o600, signal });
  signal.throwIfAborted();
}

export function registerHostedPackagePreparation(
  app: Application,
  contract: HostedHarnessContract,
  lifecycle: { accepting: () => boolean; beginOperation?: () => () => void },
): () => Promise<void> {
  const artifacts = new Map<string, Artifact>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let preparing = 0;
  let retained = 0;
  const expire = async () => {
    for (const [id, entry] of artifacts)
      if (entry.expiresAt <= Date.now() || closed) {
        artifacts.delete(id);
        retained -= entry.byteLength;
        await fs.rm(entry.directory, { recursive: true, force: true });
      }
  };
  const sweep = setInterval(() => {
    void expire().catch(() => undefined);
  }, 60_000);
  sweep.unref();
  app.use(
    HOSTED_PACKAGE_PREPARATION_PREFIX,
    hostedHarnessContractMiddleware(contract),
  );
  const handler =
    (mode: 'prepare' | 'preview' | 'inspect'): RequestHandler =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      let input: Envelope;
      try {
        input = envelope(req);
      } catch {
        res.status(400).json({ code: 'invalid_managed_package_input' });
        return;
      }
      await expire();
      if (closed || !lifecycle.accepting()) {
        res.status(409).json({ code: 'managed_package_preparation_draining' });
        return;
      }
      if (
        preparing >= MAX_PREPARING ||
        artifacts.size + preparing >= MAX_PREPARED ||
        retained + (preparing + 1) * INPUT_DISK_RESERVATION >
          MAX_TEMPORARY_BYTES
      ) {
        res.status(429).json({ code: 'managed_package_preparation_capacity' });
        return;
      }
      preparing++;
      const abort = new AbortController();
      controllers.add(abort);
      const timer = setTimeout(() => {
        abort.abort();
        req.destroy();
      }, DEADLINE_MS);
      timer.unref();
      res.once('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      const finish = lifecycle.beginOperation?.();
      let directory: string | undefined;
      try {
        directory = await fs.mkdtemp(
          path.join(os.tmpdir(), 'qwen-hosted-package-'),
        );
        const file = path.join(directory, 'input');
        await receive(
          req,
          file,
          input.input.sourceKind === 'mcp'
            ? 64 * 1024
            : MANAGED_PACKAGE_MAX_ARCHIVE_BYTES,
          abort.signal,
        );
        if (mode === 'inspect') {
          if (input.input.sourceKind !== 'extension')
            throw new Error('Inspection requires an extension archive.');
          res.json(
            await inspectManagedPackageArchive(file, input.input, abort.signal),
          );
        } else {
          const prepared = await prepareManagedPackageImport(
            file,
            input.input,
            { destination: directory, signal: abort.signal },
          );
          await fs.rm(file, { force: true });
          abort.signal.throwIfAborted();
          if (mode === 'preview') {
            res.json(prepared.inspection);
            return;
          }
          if (retained + prepared.byteLength > MAX_RETAINED_BYTES) {
            res
              .status(429)
              .json({ code: 'managed_package_preparation_capacity' });
            return;
          }
          const preparationId = randomUUID();
          artifacts.set(preparationId, {
            directory,
            scope: scopeKey(input),
            expiresAt: Date.now() + TTL_MS,
            byteLength: prepared.byteLength,
          });
          retained += prepared.byteLength;
          directory = undefined;
          res.status(201).json({
            preparationId,
            packageDigest: prepared.packageDigest,
            manifest: prepared.manifest,
            inspection: prepared.inspection,
            byteLength: prepared.byteLength,
          });
        }
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          res.status(400).json({
            code: abort.signal.aborted
              ? 'managed_package_preparation_aborted'
              : 'managed_package_preparation_failed',
            ...(error instanceof ManagedPackageCompatibilityError
              ? { reasons: error.reasons }
              : error instanceof ManagedMcpRecipeError
                ? { reasons: ['Invalid Managed MCP recipe.'] }
                : {}),
          });
      } finally {
        clearTimeout(timer);
        controllers.delete(abort);
        try {
          if (directory)
            await fs.rm(directory, { recursive: true, force: true });
        } finally {
          preparing--;
          finish?.();
        }
      }
    };
  app.post(`${HOSTED_PACKAGE_PREPARATION_PREFIX}/prepare`, handler('prepare'));
  app.post(`${HOSTED_PACKAGE_PREPARATION_PREFIX}/inspect`, handler('inspect'));
  app.post(`${HOSTED_PACKAGE_PREPARATION_PREFIX}/preview`, handler('preview'));
  app.get(
    `${HOSTED_PACKAGE_PREPARATION_PREFIX}/:preparationId/archive`,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      let key: string;
      try {
        if (
          typeof req.query['scope'] !== 'string' ||
          req.query['scope'].length > 2048
        )
          throw new Error('Invalid scope.');
        key = scopeKey(scope(JSON.parse(req.query['scope'])));
      } catch {
        res.status(400).json({ code: 'invalid_managed_package_scope' });
        return;
      }
      const entry = artifacts.get(String(req.params['preparationId']));
      if (
        !entry ||
        entry.scope !== key ||
        entry.expiresAt <= Date.now() ||
        closed
      ) {
        res.status(404).json({ code: 'managed_package_preparation_not_found' });
        return;
      }
      res
        .type('application/octet-stream')
        .setHeader('Content-Length', entry.byteLength);
      const stream = createReadStream(
        path.join(entry.directory, 'package.tar.gz'),
      );
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    },
  );
  return async () => {
    closed = true;
    clearInterval(sweep);
    controllers.forEach((controller) => controller.abort());
    await expire();
  };
}
