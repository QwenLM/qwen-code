/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type { SessionListItem } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  SessionNotFoundError,
  type BridgeSessionSummary,
} from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  readPersistedWorkspaceArtifactLibrary,
  readPersistedWorkspaceSessionMetadata,
  type WorkspaceSessionArtifactsEnvelope,
} from './session-artifact-library.js';

const SESSION_FILE = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DISCOVERY_REFRESH_INTERVAL_MS = 2_000;

type CachedArtifacts = {
  fingerprint: string;
  bytes: number;
} & (
  | { kind: 'cold'; promise: Promise<WorkspaceSessionArtifactsEnvelope> }
  | { kind: 'live'; promise: Promise<SessionListItem | undefined> }
);

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
    const live = this.runtime.bridge.listWorkspaceSessions(
      this.runtime.workspaceCwd,
    );
    const ids = new Set([...persisted, ...live.map((item) => item.sessionId)]);
    for (const id of this.entries.keys()) {
      if (!ids.has(id)) this.invalidate(id);
    }
    return [...ids];
  }

  async read(sessionId: string): Promise<WorkspaceSessionArtifactsEnvelope> {
    let live: BridgeSessionSummary | undefined;
    try {
      live = this.runtime.bridge.getSessionSummary(sessionId);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
    }
    if (!SESSION_FILE.test(`${sessionId}.jsonl`)) {
      if (live) return this.readLive(live);
      throw new SessionNotFoundError(sessionId);
    }
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
    let cached = this.entries.get(sessionId);
    if (
      cached?.fingerprint !== version ||
      cached.kind !== (live ? 'live' : 'cold')
    ) {
      this.invalidate(sessionId);
      const entry: CachedArtifacts = live
        ? {
            kind: 'live',
            fingerprint: version,
            bytes: 0,
            promise: Promise.resolve().then(() =>
              this.load(
                sessionId,
                entry,
                () =>
                  readPersistedWorkspaceSessionMetadata(
                    this.runtime,
                    sessionId,
                  ),
                readFingerprint,
              ),
            ),
          }
        : {
            kind: 'cold',
            fingerprint: version,
            bytes: 0,
            promise: Promise.resolve().then(() =>
              this.load(
                sessionId,
                entry,
                () =>
                  readPersistedWorkspaceArtifactLibrary(
                    this.runtime,
                    sessionId,
                  ),
                readFingerprint,
              ),
            ),
          };
      this.entries.set(sessionId, entry);
      cached = entry;
    }
    return cached.kind === 'cold'
      ? cached.promise
      : this.readLive(live!, await cached.promise);
  }

  private async readLive(
    live: BridgeSessionSummary,
    persisted?: SessionListItem,
  ): Promise<WorkspaceSessionArtifactsEnvelope> {
    const source = persisted?.sourceType !== undefined ? persisted : live;
    const displayName =
      live.displayName ?? (persisted?.customTitle || persisted?.prompt);
    return {
      ...(await this.runtime.bridge.getSessionArtifacts(live.sessionId)),
      session: {
        ...(displayName ? { displayName } : {}),
        createdAt: persisted?.startTime ?? live.createdAt,
        archiveState: 'active',
        sourceType: source.sourceType ?? 'default',
        ...(source.sourceId !== undefined ? { sourceId: source.sourceId } : {}),
      },
    };
  }

  private async load<T>(
    sessionId: string,
    entry: CachedArtifacts,
    read: () => Promise<T>,
    readFingerprint: () => Promise<string>,
  ): Promise<T> {
    try {
      const result = await read();
      const unchanged = entry.fingerprint === (await readFingerprint());
      if (this.entries.get(sessionId) === entry) {
        const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
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
  }
}
