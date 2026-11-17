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
import type { Application, Request, Response, RequestHandler } from 'express';
import {
  prepareManagedExtensionPackage,
  ManagedPackageCompatibilityError,
} from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { parseInstallSource } from '@qwen-code/qwen-code-core/extension/marketplace.js';
import type { ExtensionsController } from './workspace-extensions-controller.js';

export function registerManagedPackagePreparation(
  app: Application,
  base: string,
  resolve: (
    req: Request,
    res: Response,
    trust: boolean,
  ) => ExtensionsController | null,
  mutate: (options: { strict: boolean }) => RequestHandler,
): void {
  let preparing = 0;
  const prepared = new Map<
    string,
    { directory: string; expiresAt: number; owner: ExtensionsController }
  >();
  const sweep = setInterval(() => {
    for (const [id, entry] of prepared) {
      if (entry.expiresAt <= Date.now()) {
        prepared.delete(id);
        void fs.rm(entry.directory, { recursive: true, force: true });
      }
    }
  }, 60_000);
  sweep.unref();

  app.post(
    `${base}/managed-packages/prepare`,
    mutate({ strict: true }),
    async (req, res) => {
      const controller = resolve(req, res, true);
      if (
        !controller ||
        !controller.validateExtensionMutationClient(req, res, {
          requireClientId: false,
        })
      )
        return;
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return res.status(400).json({ code: 'invalid_managed_package_source' });
      const input = body as Record<string, unknown>;
      const target = input['target'] as
        | { platform?: string; arch?: string }
        | undefined;
      if (
        typeof input['source'] !== 'string' ||
        input['source'].length > 4096 ||
        input['consent'] !== true ||
        !target ||
        !['linux', 'darwin'].includes(target.platform ?? '') ||
        !['arm64', 'x64', 'any'].includes(target.arch ?? '') ||
        (input['ref'] !== undefined &&
          (typeof input['ref'] !== 'string' ||
            input['ref'].startsWith('-') ||
            input['ref'].length > 256))
      ) {
        return res.status(400).json({ code: 'invalid_managed_package_source' });
      }
      if (prepared.size + preparing >= 16)
        return res
          .status(429)
          .json({ code: 'managed_package_preparation_capacity' });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10 * 60_000);
      timer.unref();
      res.once('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      let directory: string | undefined;
      preparing++;
      try {
        const source = await parseInstallSource(input['source']);
        if (
          (source.type === 'local' && !path.isAbsolute(source.source)) ||
          source.pluginName ||
          source.marketplaceConfig
        ) {
          return res
            .status(400)
            .json({ code: 'managed_package_original_source_required' });
        }
        source.ref = input['ref'] as string | undefined;
        directory = await fs.mkdtemp(
          path.join(os.tmpdir(), 'qwen-managed-publish-'),
        );
        const result = await prepareManagedExtensionPackage(source, {
          target: target as {
            platform: 'linux' | 'darwin';
            arch: 'arm64' | 'x64' | 'any';
          },
          destination: directory,
          signal: abort.signal,
        });
        if (resolve(req, res, true) !== controller) {
          if (!res.headersSent)
            res.status(409).json({ code: 'managed_package_target_changed' });
          return;
        }
        const id = randomUUID();
        prepared.set(id, {
          directory,
          expiresAt: Date.now() + 15 * 60_000,
          owner: controller,
        });
        directory = undefined;
        return res.status(201).json({
          packageDigest: result.packageDigest,
          manifest: result.manifest,
          sourceRevision: result.sourceRevision,
          archiveUrl: `${req.originalUrl.split('?')[0].replace(/\/managed-packages\/prepare$/, '')}/managed-packages/${id}/archive`,
        });
      } catch (error) {
        if (!res.headersSent)
          res.status(400).json({
            code: 'managed_package_preparation_failed',
            error:
              error instanceof ManagedPackageCompatibilityError
                ? error.message
                : 'The original package could not be prepared for the selected target.',
          });
      } finally {
        clearTimeout(timer);
        preparing--;
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      }
      return;
    },
  );

  app.get(
    `${base}/managed-packages/:preparationId/archive`,
    async (req, res) => {
      const owner = resolve(req, res, true);
      if (!owner) return;
      const entry = prepared.get(String(req.params['preparationId']));
      if (!entry || entry.expiresAt <= Date.now() || entry.owner !== owner)
        return res
          .status(404)
          .json({ code: 'managed_package_preparation_not_found' });
      const archive = path.join(entry.directory, 'package.tar.gz');
      const stat = await fs.stat(archive).catch(() => undefined);
      if (!stat)
        return res
          .status(404)
          .json({ code: 'managed_package_preparation_not_found' });
      res.setHeader('Cache-Control', 'no-store');
      res
        .type('application/octet-stream')
        .setHeader('Content-Length', stat.size);
      const stream = createReadStream(archive, { flags: 'r' });
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
      return;
    },
  );
}
