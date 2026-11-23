/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

const { fetch, AbortSignal } = globalThis;
const origin = 'http://127.0.0.1:4170';
const prefix = '/internal/hosted-harness/v1';
const mode = process.argv[2];
const deadline = Date.now() + (mode === 'drain' ? 90_000 : 3_000);

try {
  const token = (
    await readFile('/etc/qwen/secrets/harness-token', 'utf8')
  ).trim();
  if (!token || /[\r\n\0]/u.test(token)) throw new Error('Invalid token.');
  const request = async (path, bootId, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(bootId
          ? {
              'X-Qwen-Harness-Protocol-Version': '1',
              'X-Qwen-Harness-Boot-Id': bootId,
            }
          : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(2500, deadline - Date.now())),
      ),
    });
    const value = await response.json();
    return { response, value };
  };
  if (mode === 'live') {
    const { response, value } = await request('/health');
    if (!response.ok || value.status !== 'ok')
      throw new Error('Health refused.');
  } else {
    if (!['startup', 'ready', 'drain'].includes(mode))
      throw new Error('Unknown probe.');
    const capabilities = await request('/capabilities');
    const contract = capabilities.value.hostedHarness;
    if (
      !capabilities.response.ok ||
      !contract ||
      contract.instanceId !== process.env.QWEN_HOSTED_HARNESS_INSTANCE_ID ||
      contract.capabilityDigest !==
        process.env.QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST ||
      contract.protocolVersions?.current !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        contract.bootId ?? '',
      ) ||
      !contract.features?.includes('harness-pool-owner/1') ||
      !contract.features?.includes('harness-instance-lifecycle/1')
    )
      throw new Error('Pool contract unavailable.');
    const readInstance = async () => {
      const result = await request(`${prefix}/instance`, contract.bootId);
      if (
        !result.response.ok ||
        result.value.format !== 'qwen-hosted-harness-instance/1' ||
        result.value.instanceId !== contract.instanceId ||
        result.value.bootId !== contract.bootId
      )
        throw new Error('Instance generation unavailable.');
      return result.value;
    };
    let instance = await readInstance();
    if (mode === 'ready' && instance.state !== 'ACCEPTING')
      throw new Error('Quiescing.');
    if (mode === 'drain') {
      if (instance.state === 'ACCEPTING') {
        const path = '/var/run/qwen/drain-operation.json';
        let body;
        try {
          const saved = JSON.parse(await readFile(path, 'utf8'));
          if (saved.expectedBootId === contract.bootId) body = saved;
        } catch {
          /* A new boot creates its own drain identity. */
        }
        body ??= { operationId: randomUUID(), expectedBootId: contract.bootId };
        await writeFile(path, JSON.stringify(body), { mode: 0o600 });
        const result = await request(
          `${prefix}/instance:drain`,
          contract.bootId,
          body,
        );
        // Another authenticated controller can already own this boot's drain.
        if (
          result.response.status !== 202 &&
          result.value.code !== 'hosted_harness_drain_conflict'
        )
          throw new Error('Drain refused.');
      }
      while (Date.now() < deadline) {
        instance = await readInstance();
        if (instance.state === 'DRAINED') break;
        await setTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
      }
      if (instance.state !== 'DRAINED')
        throw new Error('Drain deadline elapsed.');
    }
  }
} catch {
  console.error(`Hosted Harness ${mode ?? 'unknown'} probe did not pass.`);
  process.exitCode = 1;
}
