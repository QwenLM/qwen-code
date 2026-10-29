/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { E2bCloud } from './e2b.js';
import { E2bProvider, registrationSchema } from './provider.js';
import { providerServer } from './server.js';

const config = z
  .object({
    providerId: z.string(),
    templateId: z.string(),
    workerEntry: z.string(),
    workerDomain: z.string(),
    stateDirectory: z.string(),
    sandboxTimeoutMs: z.number().int().min(60_000),
    port: z.number().int().min(1).max(65535),
    registrations: z.array(registrationSchema).min(1),
  })
  .strict()
  .parse(JSON.parse(await readFile(process.env['QWEN_E2B_CONFIG']!, 'utf8')));
process.umask(0o077);
const cloud = new E2bCloud(
  process.env['E2B_API_KEY'] ?? '',
  config.templateId,
  config.workerEntry,
  config.sandboxTimeoutMs,
);
const provider = await E2bProvider.open(
  config.stateDirectory,
  cloud,
  config.providerId,
  config.registrations,
  config.workerDomain,
);
const server = providerServer(
  provider,
  cloud,
  process.env['QWEN_E2B_PROVIDER_TOKEN'] ?? '',
);
server.requestTimeout = 35_000;
server.headersTimeout = 10_000;
server.listen(config.port, '127.0.0.1');
const close = () =>
  server.close(() => {
    provider.close();
  });
process.once('SIGTERM', close);
process.once('SIGINT', close);
