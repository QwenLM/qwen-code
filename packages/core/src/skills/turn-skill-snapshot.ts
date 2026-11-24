/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSkillContent } from './skill-load.js';
import { SkillActivationRegistry } from './skill-activation.js';
import type { SkillManager } from './skill-manager.js';
import type { SkillConfig } from './types.js';

const MAX_ENTRIES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;

export interface TurnSkillConfig extends SkillConfig {
  readonly sourceFilePath: string;
}

export interface TurnSkillSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly digest: string;
  readonly skills: readonly TurnSkillConfig[];
}

export interface TurnSkillSnapshotLease {
  readonly snapshot: TurnSkillSnapshot;
  dispose(): Promise<void>;
}

interface SnapshotView {
  snapshot: TurnSkillSnapshot;
  activations: Map<string, SkillActivationRegistry>;
}

const activeView = new AsyncLocalStorage<SnapshotView>();

export function runWithTurnSkillSnapshot<T>(
  snapshot: TurnSkillSnapshot,
  task: () => T,
): T {
  return activeView.run({ snapshot, activations: new Map() }, task);
}

export function getTurnSkillSnapshot(): TurnSkillSnapshot | undefined {
  return activeView.getStore()?.snapshot;
}

// A nonblocking hook can outlive the prompt promise and even its Session's
// notification registry. Keep the originating files until the actual task settles.
const backgroundWork = new WeakMap<TurnSkillSnapshot, number>();

export function holdTurnResourcesFor<T>(task: Promise<T>): Promise<T> {
  const snapshot = getTurnSkillSnapshot();
  if (!snapshot) return task;
  backgroundWork.set(snapshot, (backgroundWork.get(snapshot) ?? 0) + 1);
  return task.finally(() => {
    const remaining = (backgroundWork.get(snapshot) ?? 1) - 1;
    if (remaining) backgroundWork.set(snapshot, remaining);
    else backgroundWork.delete(snapshot);
  });
}

export function hasTurnResourceWork(snapshot: TurnSkillSnapshot): boolean {
  return backgroundWork.has(snapshot);
}

export function getSkillSource(skill: SkillConfig): SkillConfig {
  if ('sourceFilePath' in skill && typeof skill.sourceFilePath === 'string') {
    return { ...skill, filePath: skill.sourceFilePath };
  }
  return skill;
}

/** Treat a staged copy as an alias of its source in file permission rules. */
export function getTurnSkillSourcePath(filePath: string): string | undefined {
  const snapshot = getTurnSkillSnapshot();
  for (const skill of snapshot?.skills ?? []) {
    const relative = path.relative(path.dirname(skill.filePath), filePath);
    if (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return path.join(path.dirname(skill.sourceFilePath), relative);
    }
  }
  return undefined;
}

export function getTurnSkillActivation(
  projectRoot: string,
): SkillActivationRegistry | undefined {
  const view = activeView.getStore();
  if (!view) return undefined;
  let registry = view.activations.get(projectRoot);
  if (!registry) {
    registry = new SkillActivationRegistry(
      view.snapshot.skills.filter(
        (skill) => skill.paths?.length && !skill.disableModelInvocation,
      ),
      projectRoot,
    );
    view.activations.set(projectRoot, registry);
  }
  return registry;
}

function skillMetadata(skill: SkillConfig) {
  return {
    body: skill.body.trim(),
    description: skill.description,
    allowedTools: skill.allowedTools,
    hooks: skill.hooks,
    model: skill.model,
    argumentHint: skill.argumentHint,
    whenToUse: skill.whenToUse,
    disableModelInvocation: skill.disableModelInvocation === true,
    userInvocable: skill.userInvocable,
    paths: skill.paths,
    priority: skill.priority,
  };
}

type FileStamp = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function fileStamp(stat: FileStamp): FileStamp {
  const { dev, ino, mode, size, mtimeMs, ctimeMs } = stat;
  return { dev, ino, mode, size, mtimeMs, ctimeMs };
}

/**
 * Captures files outside the live discovery roots. Consumers must keep the
 * lease until native use has settled and must never create one from a public
 * request payload or a client-supplied file path.
 */
export async function prepareTurnSkillSnapshot(
  skills: readonly SkillConfig[],
  options?: {
    signal?: AbortSignal;
    expectedDigest?: string;
    baseDirectory?: string;
    skillManager?: Pick<SkillManager, 'parseSkillContent'>;
  },
): Promise<TurnSkillSnapshotLease> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const selected = structuredClone(skills);
  const base = options?.baseDirectory ?? tmpdir();
  if (options?.baseDirectory)
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(
    path.join(await fs.realpath(base), 'qwen-turn-skills-'),
  );
  const sourceStamps = new Map<string, FileStamp>();
  let entries = 0;
  let bytes = 0;

  async function copyTree(
    source: string,
    target: string,
    root: string,
    files: Map<string, string>,
    depth: number,
  ) {
    signal?.throwIfAborted();
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) {
      throw new Error('Turn skill snapshot exceeds its file limit');
    }
    if ((await fs.realpath(source)) !== source) {
      throw new Error(
        'Turn skill snapshots cannot follow links inside a skill',
      );
    }
    const info = await fs.lstat(source);
    sourceStamps.set(source, fileStamp(info));
    if (info.isDirectory()) {
      await fs.mkdir(target, { mode: 0o700 });
      const children = await fs.opendir(source);
      for await (const child of children) {
        await copyTree(
          path.join(source, child.name),
          path.join(target, child.name),
          root,
          files,
          depth + 1,
        );
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(
        'Turn skill snapshots require regular files and directories',
      );
    }
    if (info.size > MAX_BYTES - bytes) {
      throw new Error('Turn skill snapshot exceeds its byte limit');
    }
    const handle = await fs.open(
      source,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!isDeepStrictEqual(fileStamp(await handle.stat()), fileStamp(info))) {
        throw new Error(
          'Skill files changed while preparing the turn snapshot',
        );
      }
      // A bounded read also covers a file growing after its initial stat.
      const data = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < data.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(data, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) {
        throw new Error(
          'Skill files changed while preparing the turn snapshot',
        );
      }
      const contents = data.subarray(0, offset);
      bytes += offset;
      files.set(
        path.relative(root, source).split(path.sep).join('/'),
        createHash('sha256')
          .update(contents)
          .update(String(info.mode & 0o100))
          .digest('hex'),
      );
      await fs.writeFile(target, contents, {
        mode: 0o400 | (info.mode & 0o100),
        flag: 'wx',
      });
    } finally {
      await handle.close();
    }
  }

  try {
    const captured: TurnSkillConfig[] = [];
    const resourceDigests = [];
    for (const original of selected) {
      signal?.throwIfAborted();
      const originalDirectory = path.dirname(original.filePath);
      const parent = await fs.realpath(path.dirname(originalDirectory));
      const source = path.join(parent, path.basename(originalDirectory));
      const target = path.join(directory, String(captured.length));
      const files = new Map<string, string>();
      await copyTree(source, target, source, files, 0);

      const filePath = path.join(target, path.basename(original.filePath));
      const contents = await fs.readFile(filePath, 'utf8');
      let parsed: SkillConfig;
      if (original.level === 'extension') {
        parsed = parseSkillContent(contents, filePath);
      } else if (options?.skillManager) {
        parsed = options.skillManager.parseSkillContent(
          contents,
          original.filePath,
          original.level,
        );
      } else {
        throw new Error('Managed skill snapshot requires its discovery parser');
      }
      if (
        parsed.name !== (original.authoredName ?? original.name) ||
        !isDeepStrictEqual(skillMetadata(parsed), skillMetadata(original))
      ) {
        throw new Error(
          'Skill discovery changed while preparing the turn snapshot',
        );
      }
      resourceDigests.push(
        JSON.stringify([
          original.name,
          original.level,
          original.extensionName,
          original.authoredName,
          [...files].sort(([first], [second]) =>
            first < second ? -1 : first > second ? 1 : 0,
          ),
        ]),
      );
      captured.push({
        ...original,
        sourceFilePath: original.filePath,
        filePath,
        skillRoot: target,
      });
    }
    for (const [source, expected] of sourceStamps) {
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(fileStamp(await fs.lstat(source)), expected)) {
        throw new Error(
          'Skill files changed while preparing the turn snapshot',
        );
      }
    }
    const digest = createHash('sha256')
      .update(JSON.stringify(resourceDigests.sort()))
      .digest('hex');
    if (
      options?.expectedDigest !== undefined &&
      options.expectedDigest !== digest
    ) {
      throw new Error(
        'The active skill revision differs from the expected digest',
      );
    }
    return {
      snapshot: {
        version: 1,
        id: path.basename(directory),
        digest,
        skills: captured,
      },
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
