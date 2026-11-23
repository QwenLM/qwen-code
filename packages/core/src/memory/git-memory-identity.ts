/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isNodeError } from '../utils/errors.js';
import { openSyncNoFollow } from '../utils/no-follow-open.js';

export interface GitMemoryIdentity {
  commonDir: string;
  checkout: string;
  kind: 'main' | 'linked' | 'bare';
}

interface GitMemoryLocation {
  identity: GitMemoryIdentity | null;
  // A non-bare separate Git directory has no reverse pointer to its checkout.
  separateCheckout?: string;
  separateCommonDir?: string;
}

function lstat(file: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return undefined;
    throw error;
  }
}

function stamp(stat: fs.BigIntStats | undefined): string {
  if (!stat) return '';
  const identity = `${stat.dev}:${stat.ino}:${stat.mode}`;
  return stat.isDirectory()
    ? identity
    : `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function readMemoryMetadata(file: string, maxBytes = 8192): string {
  const noFollow = fs.constants.O_NOFOLLOW as number | undefined;
  const fd =
    noFollow === undefined
      ? openSyncNoFollow(file)
      : fs.openSync(
          file,
          noFollow | fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
        );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Invalid memory metadata file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset !== stat.size)
      throw new Error('Memory metadata changed while reading.');
    return buffer.toString('utf8', 0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function metadataPath(raw: string): string {
  const target = raw.replace(/\r?\n$/, '');
  if (!target || target.includes('\0')) throw new Error('Invalid Git path.');
  return target;
}

function gitfileTarget(raw: string): string {
  if (!raw.startsWith('gitdir: ')) throw new Error('Invalid Git pointer.');
  return metadataPath(raw.slice('gitdir: '.length));
}

function assertGitHead(head: string): void {
  if (!/^(?:ref: refs\/[\S]+|[\da-f]{40}|[\da-f]{64})\r?\n?$/i.test(head))
    throw new Error('Invalid Git HEAD.');
}

function parseCoreConfig(config: string): { bare: boolean; worktree?: string } {
  // Parse the bounded, no-follow snapshot using Git's own quoting rules and
  // ignore includes and all ambient Git settings.
  const entries = execFileSync(
    'git',
    ['config', '--no-includes', '--null', '--file', '-', '--list'],
    {
      input: config,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  ).split('\0');
  let bare = false;
  let worktree: string | undefined;
  for (const entry of entries) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? undefined : entry.slice(newline + 1);
    if (key === 'core.bare') {
      if (value === undefined || /^(true|yes|on|1)$/i.test(value)) bare = true;
      else if (/^(false|no|off|0)?$/i.test(value)) bare = false;
      else throw new Error('Invalid Git core.bare.');
    }
    if (key === 'core.worktree') {
      if (!value) throw new Error('Invalid Git core.worktree.');
      worktree = value;
    }
  }
  return { bare, worktree };
}

function probe(
  location: string,
  dependencies: Map<string, string>,
): GitMemoryLocation {
  const inspect = (file: string) => {
    const stat = lstat(file);
    dependencies.set(file, stamp(stat));
    return stat;
  };
  const trackParents = (file: string): void => {
    for (let current = file; ; current = path.dirname(current)) {
      if (!dependencies.has(current)) inspect(current);
      if (path.dirname(current) === current) break;
    }
  };
  const real = (file: string) => {
    trackParents(file);
    const resolved = fs.realpathSync.native(file);
    trackParents(resolved);
    return resolved;
  };
  const directory = (dir: string) => {
    if (!inspect(dir)?.isDirectory()) throw new Error('Invalid Git directory.');
    return real(dir);
  };
  const metadata = (file: string, maxBytes?: number) => {
    inspect(file);
    return readMemoryMetadata(file, maxBytes);
  };
  const repositoryConfig = (dir: string) => {
    if (inspect(path.join(dir, 'commondir')))
      throw new Error('Invalid common Git directory.');
    assertGitHead(metadata(path.join(dir, 'HEAD')));
    directory(path.join(dir, 'objects'));
    directory(path.join(dir, 'refs'));
    return parseCoreConfig(metadata(path.join(dir, 'config'), 1024 * 1024));
  };
  const checkout = real(location);
  for (let current = checkout; ; current = path.dirname(current)) {
    const gitfile = path.join(current, '.git');
    const git = inspect(gitfile);
    if (git?.isDirectory()) {
      const commonDir = directory(gitfile);
      const config = repositoryConfig(commonDir);
      if (
        config.bare ||
        (config.worktree &&
          real(path.resolve(commonDir, config.worktree)) !== current)
      )
        throw new Error('Git metadata does not describe this checkout.');
      return { identity: { commonDir, checkout: current, kind: 'main' } };
    }
    if (git) {
      const target = gitfileTarget(metadata(gitfile));
      const admin = directory(path.resolve(current, target));
      const commonPointer = path.join(admin, 'commondir');
      if (!inspect(commonPointer)) {
        const config = repositoryConfig(admin);
        if (!config.bare && !config.worktree)
          return {
            identity: null,
            separateCheckout: current,
            separateCommonDir: admin,
          };
        if (
          config.bare ||
          !config.worktree ||
          real(path.resolve(admin, config.worktree)) !== current
        )
          throw new Error('Git metadata does not point back to this checkout.');
        return {
          identity: { commonDir: admin, checkout: current, kind: 'main' },
        };
      }
      assertGitHead(metadata(path.join(admin, 'HEAD')));
      const commonDir = directory(
        path.resolve(admin, metadataPath(metadata(commonPointer))),
      );
      const registrations = directory(path.join(commonDir, 'worktrees'));
      const backlink = path.resolve(
        admin,
        metadataPath(metadata(path.join(admin, 'gitdir'))),
      );
      if (
        path.dirname(admin) !== registrations ||
        path.basename(backlink) !== '.git' ||
        !inspect(backlink)?.isFile() ||
        real(backlink) !== gitfile
      )
        throw new Error('Invalid linked worktree registration.');
      repositoryConfig(commonDir);
      return { identity: { commonDir, checkout: current, kind: 'linked' } };
    }
    if (
      inspect(path.join(current, 'HEAD'))?.isFile() &&
      inspect(path.join(current, 'objects'))?.isDirectory()
    ) {
      const config = repositoryConfig(current);
      if (config.bare && !config.worktree)
        return {
          identity: { commonDir: current, checkout: current, kind: 'bare' },
        };
    }
    if (path.dirname(current) === current) return { identity: null };
  }
}

const locations = new Map<
  string,
  { location: GitMemoryLocation; dependencies: Map<string, string> }
>();

function dependenciesMatch(dependencies: Map<string, string>): boolean {
  for (const [file, before] of dependencies) {
    if (stamp(lstat(file)) !== before) return false;
  }
  return true;
}

export function clearGitMemoryIdentityCache(): void {
  locations.clear();
}

export function resolveGitMemoryLocation(
  projectRoot: string,
): GitMemoryLocation {
  const key = path.resolve(projectRoot);
  try {
    const cached = locations.get(key);
    if (cached && dependenciesMatch(cached.dependencies))
      return cached.location;
    locations.delete(key);
    const dependencies = new Map<string, string>();
    let location: GitMemoryLocation;
    try {
      location = probe(key, dependencies);
    } catch {
      location = { identity: null };
    }
    if (!dependenciesMatch(dependencies)) return { identity: null };
    if (locations.size >= 256) {
      const first = locations.keys().next().value;
      if (first !== undefined) locations.delete(first);
    }
    locations.set(key, { location, dependencies });
    return location;
  } catch {
    return { identity: null };
  }
}

export function getGitMemoryIdentity(
  projectRoot: string,
): GitMemoryIdentity | null {
  return resolveGitMemoryLocation(projectRoot).identity;
}

export function listGitMemoryWorktrees(commonDir: string): string[] {
  const registrations = path.join(commonDir, 'worktrees');
  if (!lstat(registrations)?.isDirectory()) return [];
  const worktrees: string[] = [];
  for (const entry of fs.readdirSync(registrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const admin = path.join(registrations, entry.name);
    try {
      const gitfile = path.resolve(
        admin,
        metadataPath(readMemoryMetadata(path.join(admin, 'gitdir'))),
      );
      const identity = getGitMemoryIdentity(path.dirname(gitfile));
      if (identity?.kind === 'linked' && identity.commonDir === commonDir)
        worktrees.push(identity.checkout);
    } catch {
      // A bad registration cannot contribute a migration source.
    }
  }
  return [...new Set(worktrees)].sort();
}
