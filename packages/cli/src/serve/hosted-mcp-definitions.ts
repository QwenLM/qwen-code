/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface HostedMcpServerPin {
  readonly serverId: string;
  readonly serverRevision: number;
  readonly definitionDigest: string;
}

export const HOSTED_COUNTER_CEILING = Number.MAX_SAFE_INTEGER - 1;

// `stored` reads a pin this build already persisted. The ceiling is an
// admission bound: applying it to the stored readers would refuse Sessions
// that were admitted under the wider bound they were created with, and a
// refused load cannot be deleted because attach is the delete precondition.
export function parseHostedMcpServers(
  value: unknown,
  stored = false,
): readonly HostedMcpServerPin[] {
  // Saved Sessions retain the original pin format so they can load and detach.
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('MCP profile requires 1–32 server definitions.');
  }
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid MCP definition pin.');
    const pin = entry as Record<string, unknown>;
    if (
      Object.keys(pin).sort().join(',') !==
        'definitionDigest,serverId,serverRevision' ||
      typeof pin['serverId'] !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(pin['serverId']) ||
      !Number.isSafeInteger(pin['serverRevision']) ||
      Number(pin['serverRevision']) < 1 ||
      (!stored && Number(pin['serverRevision']) > HOSTED_COUNTER_CEILING) ||
      typeof pin['definitionDigest'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(pin['definitionDigest']) ||
      ids.has(pin['serverId'])
    )
      throw new Error('Invalid MCP definition pin.');
    ids.add(pin['serverId']);
    return Object.freeze({
      serverId: pin['serverId'],
      serverRevision: Number(pin['serverRevision']),
      definitionDigest: pin['definitionDigest'],
    });
  });
}
