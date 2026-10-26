/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type { SessionArtifactsEnvelope } from '@qwen-code/acp-bridge/sessionArtifacts';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { readPersistedWorkspaceArtifactLibrary } from './session-artifact-library.js';

const SESSION_FILE = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DISCOVERY_REFRESH_INTERVAL_MS = 2_000;

interface CachedArtifacts {
  fingerprint: string;
  promise: Promise<SessionArtifactsEnvelope>;
  bytes: number;
}

async function fingerprint(
  paths: string[],
  followSymlinks = true,
): Promise<string> {
  return JSON.stringify(
    await Promise.all(
      paths.map(async (file) => {
        try {
          const stat = await fs.lstat(file);
          // Let storage readers validate links whose targets cannot be read.
          const target =
            followSymlinks && stat.isSymbolicLink()
              ? await fs.stat(file).catch(() => undefined)
              : undefined;
          return [
            stat.dev,
            stat.ino,
            stat.mode,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
            ...(target
              ? [
                  target.dev,
                  target.ino,
                  target.size,
                  target.mtimeMs,
                  target.ctimeMs,
                ]
              : []),
          ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }),
    ),
  );
}

export class WorkspaceArtifactCache {
  private readonly storage: Storage;
  private readonly directories: string[];
  private readonly entries = new Map<string, CachedArtifacts>();
  private bytes = 0;
  private discovery?: {
    fingerprint: string;
    promise: Promise<string[]>;
    expiresAt: number;
  };

  constructor(private readonly runtime: WorkspaceRuntime) {
    this.storage = new Storage(
      runtime.workspaceCwd,
      runtime.sessionRuntimeBaseDir,
    );
    const chats = path.join(this.storage.getProjectDir(), 'chats');
    this.directories = [chats, path.join(chats, 'archive')];
  }

  invalidate(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(sessionId);
  }

  async sessionIds(): Promise<string[]> {
    const version = await fingerprint(this.directories);
    if (
      this.discovery?.fingerprint !== version ||
      Date.now() >= this.discovery.expiresAt
    ) {
      const load = {
        fingerprint: version,
        expiresAt: Infinity,
        promise: Promise.resolve().then(async () => {
          const names = await Promise.all(
            this.directories.map(async (directory) => {
              try {
                return await fs.readdir(directory);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  return [];
                throw error;
              }
            }),
          );
          return [
            ...new Set(names.flat().filter((name) => SESSION_FILE.test(name))),
          ]
            .map((name) => name.slice(0, -6))
            .sort();
        }),
      };
      this.discovery = load;
      void load.promise.then(
        () => {
          load.expiresAt = Date.now() + DISCOVERY_REFRESH_INTERVAL_MS;
        },
        () => {
          if (this.discovery === load) this.discovery = undefined;
        },
      );
    }
    const persisted = await this.discovery!.promise;
    const persistedIds = new Set(persisted);
    for (const id of this.entries.keys()) {
      if (!persistedIds.has(id)) this.invalidate(id);
    }
    const live = this.runtime.bridge.listWorkspaceSessions(
      this.runtime.workspaceCwd,
    );
    return [...new Set([...persisted, ...live.map((item) => item.sessionId)])];
  }

  async read(sessionId: string): Promise<SessionArtifactsEnvelope> {
    try {
      this.runtime.bridge.getSessionSummary(sessionId);
      this.invalidate(sessionId);
      return this.runtime.bridge.getSessionArtifacts(sessionId);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
    }
    if (!SESSION_FILE.test(`${sessionId}.jsonl`))
      throw new SessionNotFoundError(sessionId);
    const files = this.directories.map((directory) =>
      path.join(directory, `${sessionId}.jsonl`),
    );
    const readFingerprint = async () =>
      JSON.stringify(
        await Promise.all([
          fingerprint(files, false),
          fingerprint([this.storage.getRuntimeStatusPath(sessionId)]),
        ]),
      );
    const version = await readFingerprint();
    const cached = this.entries.get(sessionId);
    if (cached?.fingerprint === version) {
      return cached.promise;
    }
    this.invalidate(sessionId);
    const entry: CachedArtifacts = {
      fingerprint: version,
      bytes: 0,
      promise: Promise.resolve().then(async () => {
        try {
          const result = await readPersistedWorkspaceArtifactLibrary(
            this.runtime,
            sessionId,
          );
          const unchanged = version === (await readFingerprint());
          if (this.entries.get(sessionId) === entry) {
            const bytes = Buffer.byteLength(JSON.stringify(result));
            if (!unchanged || this.bytes + bytes > MAX_CACHE_BYTES) {
              this.invalidate(sessionId);
            } else {
              entry.bytes = bytes;
              this.bytes += bytes;
            }
          }
          return result;
        } catch (error) {
          if (this.entries.get(sessionId) === entry) this.invalidate(sessionId);
          throw error;
        }
      }),
    };
    this.entries.set(sessionId, entry);
    return entry.promise;
  }
}
