/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedRuntimeSkillSources,
  parseManagedRuntimeSkillControl,
  type ManagedRuntimeSkillCandidate,
} from './managed-runtime-skill-source.js';

let temporary: string;
let root: string;
let sources: ManagedRuntimeSkillSources;
let active: boolean;
let denied: string | undefined;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
  root = path.join(temporary, 'workspace');
  await fs.mkdir(root);
  active = true;
  denied = undefined;
  sources = new ManagedRuntimeSkillSources(
    path.join(temporary, 'cache'),
    async () => ({
      directory: root,
      origin: {
        workspaceId: 'workspace',
        workspaceGeneration: '1',
        cwdRelative: '.',
      },
      admits: async (file) =>
        active && (denied === undefined || !file.startsWith(denied)),
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sources.close();
  await fs.rm(temporary, { recursive: true, force: true });
});
async function file(relative: string, body: string | Buffer, mode?: number) {
  const name = path.join(root, relative);
  await fs.mkdir(path.dirname(name), { recursive: true });
  await fs.writeFile(name, body, { mode });
}
async function skill(
  provider: string,
  directory: string,
  name = directory,
  extra = '',
) {
  await file(
    `${provider}/skills/${directory}/SKILL.md`,
    `---\nname: ${name}\ndescription: Inspect files\n${extra}---\nInspect resources.`,
  );
}
async function candidates() {
  return (
    await sources.control('session', {
      kind: 'extension-skill-candidates',
      operationId: randomUUID(),
    })
  )['candidates'] as ManagedRuntimeSkillCandidate[];
}
async function snapshot(
  candidate: ManagedRuntimeSkillCandidate,
  operationId = randomUUID(),
) {
  return {
    operationId,
    result: await sources.control('session', {
      kind: 'extension-skill-snapshot',
      operationId,
      path: candidate.path,
      digest: candidate.digest,
    }),
  };
}

describe('Runtime project Skill snapshots', () => {
  it('prepares nine consecutive snapshots and preserves downloaded chunk retries', async () => {
    for (let i = 0; i < 9; i++) await skill('.qwen', 'skill' + i);
    const listed = await candidates();
    expect(listed).toHaveLength(9);
    let first: Awaited<ReturnType<typeof snapshot>> | undefined;
    for (const candidate of listed) {
      const prepared = await snapshot(candidate);
      if (!first) first = prepared;
      const bytes = await sources.control('session', {
        kind: 'extension-skill-archive',
        operationId: prepared.operationId,
        preparationId: String(prepared.result['preparationId']),
        offset: 0,
      });
      expect(Buffer.from(String(bytes['base64']), 'base64').length).toBe(
        bytes['totalBytes'],
      );
      expect(
        await sources.control('session', {
          kind: 'extension-skill-archive',
          operationId: prepared.operationId,
          preparationId: String(prepared.result['preparationId']),
          offset: 0,
        }),
      ).toEqual(bytes);
    }
    expect((await snapshot(listed[0], first!.operationId)).result).toEqual(
      first!.result,
    );
  });

  it('does not publish a snapshot that finishes its ownership check after retirement', async () => {
    await skill('.qwen', 'review');
    const candidate = (await candidates())[0];
    await sources.close();
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atFinalCheck = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let rootChecks = 0;
    const real = await fs.realpath(root);
    sources = new ManagedRuntimeSkillSources(
      path.join(temporary, 'retiring-cache'),
      async () => ({
        directory: root,
        admits: async (file) => {
          if (file === real && ++rootChecks === 2) {
            reached();
            await blocked;
          }
          return true;
        },
      }),
    );
    const pending = snapshot(candidate);
    await atFinalCheck;
    await sources.close();
    release();
    await expect(pending).rejects.toThrow('unavailable');
    expect(await fs.readdir(path.join(temporary, 'retiring-cache'))).toEqual(
      [],
    );
  });
  it('uses project provider precedence and reports unsupported frontmatter', async () => {
    await skill('.qwen', 'review');
    await skill('.agents', 'other', 'review');
    await skill('.qwen', 'dynamic', 'dynamic', 'allowed-tools: Read\n');
    await file('user-skills/not-discovered/SKILL.md', 'outside project roots');
    const found = await candidates();
    expect(found).toHaveLength(3);
    expect(
      found.find((entry) => entry.path === '.qwen/skills/review'),
    ).toMatchObject({ compatible: true, shadowed: false });
    expect(
      found.find((entry) => entry.path === '.agents/skills/other'),
    ).toMatchObject({ compatible: true, shadowed: true });
    expect(found.find((entry) => entry.name === 'dynamic')).toMatchObject({
      compatible: false,
    });
    expect(found.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest))).toBe(
      true,
    );
  });

  it('serves immutable scope-bound chunks with matching digest and generated origin', async () => {
    await skill('.qwen', 'review');
    await file('.qwen/skills/review/assets/random.bin', randomBytes(600_000));
    await file(
      '.qwen/skills/review/scripts/check.sh',
      '#!/bin/sh\necho safe',
      0o755,
    );
    await file('.qwen/skills/review/.env', 'private=do-not-copy');
    const candidate = (await candidates())[0];
    const { operationId, result } = await snapshot(candidate);
    expect((await snapshot(candidate, operationId)).result).toEqual(result);
    await expect(
      sources.control('session', {
        kind: 'extension-skill-snapshot',
        operationId,
        path: candidate.path,
        digest: '0'.repeat(64),
      }),
    ).rejects.toThrow('conflict');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < Number(result['byteLength']); ) {
      const chunk = await sources.control('session', {
        kind: 'extension-skill-archive',
        operationId,
        preparationId: String(result['preparationId']),
        offset,
      });
      const bytes = Buffer.from(String(chunk['base64']), 'base64');
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
      chunks.push(bytes);
      offset += bytes.length;
    }
    expect(chunks.length).toBeGreaterThan(1);
    const bytes = Buffer.concat(chunks);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      result['sourceDigest'],
    );
    const archive = path.join(temporary, 'skill.tar.gz');
    await fs.writeFile(archive, bytes);
    const extracted = path.join(temporary, 'extracted');
    await fs.mkdir(extracted);
    await tar.x({ file: archive, cwd: extracted });
    expect(await fs.readdir(extracted)).not.toContain('.env');
    expect(
      (await fs.stat(path.join(extracted, 'scripts/check.sh'))).mode & 0o777,
    ).toBe(0o755);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(extracted, '.qwen-managed-skill-origin.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      workspaceId: 'workspace',
      path: candidate.path,
      digest: candidate.digest,
    });
    await expect(
      sources.control('other-session', {
        kind: 'extension-skill-archive',
        operationId,
        preparationId: String(result['preparationId']),
        offset: 0,
      }),
    ).rejects.toThrow('unavailable');
  });

  it('rejects source changes after discovery and unavailable owners', async () => {
    await skill('.qwen', 'review');
    const candidate = (await candidates())[0];
    await file('.qwen/skills/review/changed.txt', 'new resource');
    await expect(snapshot(candidate)).rejects.toThrow('source_changed');
    active = false;
    await expect(candidates()).rejects.toThrow('unavailable');
  });

  it('refuses links and another Session file ownership', async () => {
    await skill('.qwen', 'review');
    await fs.symlink(
      '/etc/passwd',
      path.join(root, '.qwen/skills/review/escape'),
    );
    await expect(candidates()).rejects.toThrow('unavailable');
    await fs.rm(path.join(root, '.qwen/skills/review/escape'));
    denied = await fs.realpath(path.join(root, '.qwen/skills/review'));
    await expect(candidates()).rejects.toThrow('unavailable');
  });

  it('expires chunks and rejects changed operation shapes', async () => {
    await skill('.qwen', 'review');
    const { operationId, result } = await snapshot((await candidates())[0]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    await expect(
      sources.control('session', {
        kind: 'extension-skill-archive',
        operationId,
        preparationId: String(result['preparationId']),
        offset: 0,
      }),
    ).rejects.toThrow('unavailable');
    expect(() =>
      parseManagedRuntimeSkillControl({
        kind: 'extension-skill-snapshot',
        operationId,
        path: '.qwen/skills/../escape',
        digest: 'a'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      parseManagedRuntimeSkillControl({
        kind: 'extension-skill-candidates',
        operationId,
        source: '/etc',
      }),
    ).toThrow();
  });
});
