/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import * as tar from 'tar';
import { SKILL_PROVIDER_CONFIG_DIRS } from '@qwen-code/qwen-code-core/config/storage.js';
import { parseManagedSkillContent } from '@qwen-code/qwen-code-core/extension/managed-skill-content.js';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_PATH_BYTES,
} from '@qwen-code/qwen-code-core/extension/archive-safety.js';
import { MANAGED_PACKAGE_MAX_ARCHIVE_BYTES } from '@qwen-code/qwen-code-core/extension/managed-package.js';

export interface ManagedRuntimeSkillCandidate {
  name: string;
  description: string;
  path: string;
  digest: string;
  shadowed: boolean;
  compatible: boolean;
  error?: string;
}

export interface ManagedRuntimeSkillSource {
  directory: string;
  admits: (file: string) => Promise<boolean>;
  origin?: {
    workspaceId: string;
    workspaceGeneration: string;
    cwdRelative: string;
  };
}

export type ManagedRuntimeSkillControl =
  | { kind: 'extension-skill-candidates'; operationId: string }
  | {
      kind: 'extension-skill-snapshot';
      operationId: string;
      path: string;
      digest: string;
    }
  | {
      kind: 'extension-skill-archive';
      operationId: string;
      preparationId: string;
      offset: number;
    };

interface Snapshot {
  sessionId: string;
  operationId: string;
  identity: string;
  directory: string;
  sourceDigest: string;
  byteLength: number;
  expiresAt: number;
}

const privateNames = new Set([
  '.git',
  '.env',
  '.qwen-extension-settings.json',
  '.qwen-extension-git-credentials.json',
  '.qwen-extension-install.json',
  '.qwen-managed-skill-origin.json',
]);
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const CHUNK_BYTES = 256 * 1024;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;

function failed(code: string): never {
  throw new Error(code);
}
function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function boundedEntries(
  directory: string,
  limit: number,
  code: string,
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  for await (const entry of await fs.opendir(directory)) {
    if (entries.length >= limit) failed(code);
    entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseManagedRuntimeSkillControl(
  value: unknown,
): ManagedRuntimeSkillControl {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    failed('invalid_skill_control');
  const op = value as Record<string, unknown>;
  if (typeof op['operationId'] !== 'string' || !UUID.test(op['operationId']))
    failed('invalid_skill_control');
  if (op['kind'] === 'extension-skill-candidates') {
    if (Object.keys(op).sort().join(',') !== 'kind,operationId')
      failed('invalid_skill_control');
  } else if (op['kind'] === 'extension-skill-snapshot') {
    if (
      Object.keys(op).sort().join(',') !== 'digest,kind,operationId,path' ||
      typeof op['path'] !== 'string' ||
      !/^\.(?:qwen|agents)\/skills\/[^/\\]+$/u.test(op['path']) ||
      op['path'].includes('\0') ||
      op['path'].length > 4096 ||
      op['path'].split('/').some((part) => part === '..' || part === '.') ||
      typeof op['digest'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(op['digest'])
    )
      failed('invalid_skill_control');
  } else if (op['kind'] === 'extension-skill-archive') {
    if (
      Object.keys(op).sort().join(',') !==
        'kind,offset,operationId,preparationId' ||
      typeof op['preparationId'] !== 'string' ||
      !UUID.test(op['preparationId']) ||
      !Number.isSafeInteger(op['offset']) ||
      Number(op['offset']) < 0 ||
      Number(op['offset']) > MANAGED_PACKAGE_MAX_ARCHIVE_BYTES
    )
      failed('invalid_skill_control');
  } else failed('invalid_skill_control');
  return structuredClone(op) as ManagedRuntimeSkillControl;
}

export class ManagedRuntimeSkillSources {
  private readonly snapshots = new Map<string, Snapshot>();
  private retainedBytes = 0;
  private preparing = 0;
  private readonly pending = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly cacheDirectory: string,
    private readonly source: (
      sessionId: string,
    ) => Promise<ManagedRuntimeSkillSource>,
  ) {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, 60_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const snapshot of this.snapshots.values())
      await fs.rm(snapshot.directory, { recursive: true, force: true });
    this.snapshots.clear();
    this.retainedBytes = 0;
  }

  private async sweep(): Promise<void> {
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.expiresAt <= Date.now()) {
        this.snapshots.delete(id);
        this.retainedBytes -= snapshot.byteLength;
        await fs.rm(snapshot.directory, { recursive: true, force: true });
      }
    const known = new Set(
      [...this.snapshots.values()].map((snapshot) => snapshot.directory),
    );
    try {
      for await (const entry of await fs.opendir(this.cacheDirectory)) {
        if (!entry.isDirectory() || !entry.name.startsWith('skill-')) continue;
        const directory = path.join(this.cacheDirectory, entry.name);
        if (known.has(directory)) continue;
        const stat = await fs.lstat(directory).catch(() => undefined);
        if (stat && stat.mtimeMs + 15 * 60_000 <= Date.now())
          await fs.rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async manifest(
    root: string,
    file: string,
    source: ManagedRuntimeSkillSource,
  ): Promise<string> {
    await this.checked(root, file, source);
    const handle = await fs.open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1024 * 1024)
        failed('invalid_skill_manifest');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!result.bytesRead) failed('source_changed');
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        named.ino !== before.ino ||
        named.dev !== before.dev
      )
        failed('source_changed');
      await this.checked(root, file, source);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  }

  async control(
    sessionId: string,
    operation: ManagedRuntimeSkillControl,
  ): Promise<Record<string, unknown>> {
    if (this.closed) failed('skill_source_unavailable');
    const op = parseManagedRuntimeSkillControl(operation);
    const source = await this.source(sessionId);
    const root = await fs.realpath(source.directory);
    if (!(await source.admits(root))) failed('skill_source_unavailable');
    await this.sweep();
    if (op.kind === 'extension-skill-archive') {
      const snapshot = this.snapshots.get(op.preparationId);
      if (
        !snapshot ||
        snapshot.sessionId !== sessionId ||
        snapshot.operationId !== op.operationId ||
        snapshot.expiresAt <= Date.now() ||
        op.offset > snapshot.byteLength
      )
        failed('skill_snapshot_unavailable');
      const handle = await fs.open(
        path.join(snapshot.directory, 'skill.tar.gz'),
        'r',
      );
      try {
        const buffer = Buffer.alloc(
          Math.min(CHUNK_BYTES, snapshot.byteLength - op.offset),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          op.offset,
        );
        if (
          bytesRead !== buffer.length ||
          !(await source.admits(root)) ||
          this.closed
        )
          failed('skill_snapshot_unavailable');
        return {
          operationId: op.operationId,
          preparationId: op.preparationId,
          offset: op.offset,
          totalBytes: snapshot.byteLength,
          base64: buffer.toString('base64'),
        };
      } finally {
        await handle.close();
      }
    }
    if (op.kind === 'extension-skill-candidates') {
      const candidates: ManagedRuntimeSkillCandidate[] = [];
      const names = new Set<string>();
      const budget = { bytes: 0, entries: 0 };
      let candidateBytes = 0;
      for (const provider of SKILL_PROVIDER_CONFIG_DIRS) {
        const relative = `${provider}/skills`;
        const base = path.join(root, relative);
        try {
          await this.checked(root, base, source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const entries = await boundedEntries(
          base,
          1024,
          'skill_candidate_limit',
        );
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            if (entry.isSymbolicLink()) failed('skill_source_unavailable');
            continue;
          }
          if (candidates.length >= 256) failed('skill_candidate_limit');
          const relativePath = `${relative}/${entry.name}`;
          const directory = path.join(root, relativePath);
          let candidate: ManagedRuntimeSkillCandidate;
          try {
            const manifest = path.join(directory, 'SKILL.md');
            const content = await this.manifest(root, manifest, source);
            const skill = parseManagedSkillContent(content, manifest);
            const observed = await this.scan(root, directory, source, budget);
            if (
              observed.files.filter(
                (file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'),
              ).length !== 1
            )
              failed('invalid_skill_manifest');
            candidate = {
              name: skill.name,
              description: skill.description,
              path: relativePath,
              digest: observed.digest,
              shadowed: names.has(skill.name),
              compatible: true,
            };
            names.add(skill.name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            if (
              error instanceof Error &&
              [
                'skill_source_unavailable',
                'skill_source_limit',
                'source_changed',
              ].includes(error.message)
            )
              throw error;
            candidate = {
              name: entry.name,
              description: '',
              path: relativePath,
              digest: createHash('sha256').update(relativePath).digest('hex'),
              shadowed: false,
              compatible: false,
              error: 'Unsupported or invalid Skill content.',
            };
          }
          candidateBytes += Buffer.byteLength(JSON.stringify(candidate));
          if (candidateBytes > 2 * 1024 * 1024) failed('skill_candidate_limit');
          candidates.push(candidate);
        }
      }
      if (!(await source.admits(root)) || this.closed)
        failed('skill_source_unavailable');
      return { operationId: op.operationId, candidates };
    }
    const identity = JSON.stringify([op.path, op.digest]);
    const existing = [...this.snapshots.entries()].find(
      ([, value]) =>
        value.sessionId === sessionId && value.operationId === op.operationId,
    );
    if (existing) {
      if (existing[1].identity !== identity) failed('skill_snapshot_conflict');
      return this.descriptor(op.operationId, existing[0], existing[1]);
    }
    if (this.preparing >= 2 || this.snapshots.size + this.preparing >= 8)
      failed('skill_snapshot_capacity');
    const key = `${sessionId}\0${op.operationId}`;
    if (this.pending.has(key)) failed('skill_snapshot_pending');
    this.pending.add(key);
    this.preparing++;
    let temporary: string | undefined;
    try {
      await fs.mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      temporary = await fs.mkdtemp(path.join(this.cacheDirectory, 'skill-'));
      const copied = path.join(temporary, 'source');
      await fs.mkdir(copied);
      const directory = path.join(root, op.path);
      const first = await this.scan(
        root,
        directory,
        source,
        { bytes: 0, entries: 0 },
        copied,
      );
      const second = await this.scan(root, directory, source, {
        bytes: 0,
        entries: 0,
      });
      if (
        first.files.filter(
          (file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'),
        ).length !== 1
      )
        failed('invalid_skill_manifest');
      if (first.digest !== op.digest || second.digest !== first.digest)
        failed('source_changed');
      const manifest = path.join(copied, 'SKILL.md');
      if ((await fs.stat(manifest)).size > 1024 * 1024)
        failed('invalid_skill_manifest');
      parseManagedSkillContent(await fs.readFile(manifest, 'utf8'), manifest);
      if (source.origin) {
        const name = '.qwen-managed-skill-origin.json';
        await fs.writeFile(
          path.join(copied, name),
          JSON.stringify({
            version: 1,
            ...source.origin,
            path: op.path,
            digest: op.digest,
          }),
          { mode: 0o644 },
        );
        await fs.chmod(path.join(copied, name), 0o644);
        first.files.push(name);
        first.files.sort();
      }
      const archive = path.join(temporary, 'skill.tar.gz');
      await tar.create(
        {
          cwd: copied,
          file: archive,
          gzip: true,
          portable: true,
          noMtime: true,
        },
        first.files,
      );
      const byteLength = (await fs.stat(archive)).size;
      if (
        byteLength > MANAGED_PACKAGE_MAX_ARCHIVE_BYTES ||
        this.retainedBytes + byteLength > MAX_RETAINED_BYTES
      )
        failed('skill_snapshot_capacity');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      await fs.rm(copied, { recursive: true, force: true });
      await fs.utimes(temporary, new Date(), new Date());
      if (!(await source.admits(root)) || this.closed)
        failed('skill_source_unavailable');
      const snapshot: Snapshot = {
        sessionId,
        operationId: op.operationId,
        identity,
        directory: temporary,
        sourceDigest: hash.digest('hex'),
        byteLength,
        expiresAt: Date.now() + 15 * 60_000,
      };
      const preparationId = randomUUID();
      this.snapshots.set(preparationId, snapshot);
      this.retainedBytes += byteLength;
      temporary = undefined;
      return this.descriptor(op.operationId, preparationId, snapshot);
    } finally {
      this.preparing--;
      this.pending.delete(key);
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private descriptor(
    operationId: string,
    preparationId: string,
    snapshot: Snapshot,
  ) {
    return {
      operationId,
      preparationId,
      sourceDigest: snapshot.sourceDigest,
      byteLength: snapshot.byteLength,
    };
  }

  private async checked(
    root: string,
    file: string,
    source: ManagedRuntimeSkillSource,
  ): Promise<void> {
    const relative = path.relative(root, file);
    if (!contains(root, file)) failed('skill_source_unavailable');
    let cursor = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        failed('skill_source_unavailable');
    }
    const real = await fs.realpath(file);
    if (!contains(root, real) || !(await source.admits(real)))
      failed('skill_source_unavailable');
  }

  private async scan(
    root: string,
    directory: string,
    source: ManagedRuntimeSkillSource,
    budget: { bytes: number; entries: number; pathBytes?: number },
    destination?: string,
  ): Promise<{ digest: string; files: string[] }> {
    const hash = createHash('sha256');
    const files: string[] = [];
    await this.checked(root, directory, source);
    const visit = async (relative: string): Promise<void> => {
      const current = path.join(directory, relative);
      const before = await fs.lstat(current);
      const entries = await boundedEntries(
        current,
        MAX_ARCHIVE_ENTRIES - budget.entries,
        'skill_source_limit',
      );
      budget.entries += entries.length;
      for (const entry of entries) {
        if (privateNames.has(entry.name) || entry.name.startsWith('.env.'))
          continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (Buffer.byteLength(name) > 4096) failed('skill_source_limit');
        budget.pathBytes = (budget.pathBytes ?? 0) + Buffer.byteLength(name);
        if (budget.pathBytes > MAX_ARCHIVE_PATH_BYTES)
          failed('skill_source_limit');
        const file = path.join(directory, name);
        await this.checked(root, file, source);
        if (entry.isDirectory()) {
          await visit(name);
          continue;
        }
        const handle = await fs.open(
          file,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) failed('skill_source_unavailable');
          budget.bytes += stat.size;
          if (
            budget.bytes > MAX_ARCHIVE_EXPANDED_BYTES ||
            budget.entries > MAX_ARCHIVE_ENTRIES
          )
            failed('skill_source_limit');
          const mode = stat.mode & 0o111 ? 0o755 : 0o644;
          hash.update(JSON.stringify([name, stat.size, mode]));
          const sink = destination
            ? (() => {
                const target = path.join(destination, name);
                return fs
                  .mkdir(path.dirname(target), { recursive: true })
                  .then(() => createWriteStream(target, { mode, flags: 'wx' }));
              })()
            : Promise.resolve(
                new Writable({
                  write(_chunk, _encoding, done) {
                    done();
                  },
                }),
              );
          let read = 0;
          await pipeline(
            handle.createReadStream({ autoClose: false }),
            new Transform({
              transform(chunk, _encoding, done) {
                read += chunk.length;
                if (read > stat.size) {
                  done(new Error('source_changed'));
                  return;
                }
                hash.update(chunk);
                done(null, chunk);
              },
            }),
            await sink,
          );
          if (destination) await fs.chmod(path.join(destination, name), mode);
          const after = await handle.stat();
          const named = await fs.lstat(file);
          if (
            stat.ino !== after.ino ||
            stat.size !== after.size ||
            stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs ||
            named.ino !== stat.ino ||
            named.dev !== stat.dev
          )
            failed('source_changed');
          await this.checked(root, file, source);
          files.push(name);
        } finally {
          await handle.close();
        }
      }
      const after = await fs.lstat(current);
      if (
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        failed('source_changed');
    };
    await visit('');
    return { digest: hash.digest('hex'), files };
  }
}
