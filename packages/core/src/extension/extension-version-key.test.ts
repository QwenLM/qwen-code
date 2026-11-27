/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeDirectoryContentHash,
  computeVersionKey,
  formatVersionSlot,
  getVersionedExtensionId,
} from './extension-version-key.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-ext-ver-key-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('extension-version-key', () => {
  it('hashes identical extension trees deterministically while ignoring managed sidecars', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();

    await fs.writeFile(
      path.join(dirA, 'qwen-extension.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(dirA, '.env'), 'FOO=workspace-a\n');
    await fs.writeFile(
      path.join(dirA, '.qwen-extension-install.json'),
      JSON.stringify({ type: 'local', source: '/a' }),
    );

    await fs.writeFile(
      path.join(dirB, 'qwen-extension.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(dirB, '.env'), 'FOO=workspace-b\n');

    const hashA = await computeDirectoryContentHash(dirA);
    const hashB = await computeDirectoryContentHash(dirB);
    expect(hashA).toBe(hashB);

    await fs.writeFile(path.join(dirB, 'extra.txt'), 'changed');
    const hashBChanged = await computeDirectoryContentHash(dirB);
    expect(hashBChanged).not.toBe(hashA);
  });

  it('produces deterministic version keys for npm, git, link, and local sources and omits credentialed sources', () => {
    const config = { name: 'Demo', version: '2.0.0' };
    expect(
      computeVersionKey(config, {
        type: 'npm',
        source: '@acme/demo',
        releaseTag: '2.0.0',
      }),
    ).toBe('npm:default:demo@2.0.0');

    expect(
      computeVersionKey(config, {
        type: 'git',
        source: 'https://github.com/acme/demo',
        gitCommit: 'abcdef1234567',
      }),
    ).toBe('git:https://github.com/acme/demo:abcdef1234567');

    expect(
      computeVersionKey(config, {
        type: 'local',
        source: '/tmp/demo.zip',
      }, 'deadbeef'),
    ).toBe('content:demo:deadbeef');

    expect(
      computeVersionKey(config, {
        type: 'snapshot',
        source: 'snapshot',
      }),
    ).toBeUndefined();

    expect(
      computeVersionKey(config, {
        type: 'git',
        source: 'https://github.com/acme/private',
        credentialPersistence: 'stored',
      }),
    ).toBeUndefined();
  });

  it('derives 64-char hex ids and readable collision-free version slots', () => {
    const baseId = 'a'.repeat(64);
    const id1 = getVersionedExtensionId(baseId, 'npm:default:demo@1.0.0');
    const id2 = getVersionedExtensionId(baseId, 'npm:default:demo@2.0.0');
    expect(id1).toMatch(/^[a-f0-9]{64}$/);
    expect(id1).not.toBe(id2);

    const npmSlot = formatVersionSlot(
      { version: '2.0.0' },
      { type: 'npm', source: '@acme/demo', releaseTag: '2.0.0' },
      id2,
    );
    expect(npmSlot).toBe('2.0.0');

    const collidingSlot = formatVersionSlot(
      { version: '2.0.0' },
      { type: 'npm', source: '@acme/demo', releaseTag: '2.0.0' },
      id2,
      new Set(['2.0.0']),
    );
    expect(collidingSlot).toBe(`2.0.0-${id2.slice(0, 8)}`);

    const linkSlot = formatVersionSlot(
      { version: '1.0.0' },
      { type: 'link', source: '/tmp/feature-branch' },
      id1,
    );
    expect(linkSlot).toBe(`link-feature-branch-${id1.slice(0, 8)}`);
  });
});
