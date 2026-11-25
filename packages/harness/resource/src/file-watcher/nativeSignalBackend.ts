/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  watch as nodeWatch,
  type FSWatcher as NodeFSWatcher,
} from 'node:fs';
import { basename } from 'node:path';
import {
  anchorKey,
  resolveSignalPath,
  type RegistrationAnchor,
} from './anchorPlanner.js';

export interface NativeSignalAnchor {
  anchor: string;
  flat: boolean;
  registrations: Set<number>;
  watcher: NodeFSWatcher;
}

export interface NativeSignalRetainResult {
  ok: boolean;
  error?: unknown;
}

/** Shared native fs.watch anchors used for coarse resource invalidation. */
export class NativeSignalBackend {
  private readonly anchors = new Map<string, NativeSignalAnchor>();

  constructor(
    private readonly onSignal: (
      signal: NativeSignalAnchor,
      eventPath: string,
    ) => void,
    private readonly onError: (
      registrationIds: readonly number[],
      error: unknown,
    ) => void,
  ) {}

  retain(
    registrationId: number,
    anchor: RegistrationAnchor,
  ): NativeSignalRetainResult {
    const key = anchorKey(anchor.anchor, anchor.flat);
    const existing = this.anchors.get(key);
    if (existing) {
      existing.registrations.add(registrationId);
      return { ok: true };
    }
    if (!existsSync(anchor.anchor)) return { ok: true };

    try {
      const watcher = nodeWatch(
        anchor.anchor,
        { persistent: false, recursive: !anchor.flat },
        (_eventType, filename) => {
          const signal = this.anchors.get(key);
          if (!signal || watcher !== signal.watcher) return;
          const rawName = filename?.toString() ?? '';
          const eventPath =
            rawName === '' || rawName === basename(signal.anchor)
              ? signal.anchor
              : resolveSignalPath(signal.anchor, rawName);
          this.onSignal(signal, eventPath);
        },
      );
      const signal: NativeSignalAnchor = {
        anchor: anchor.anchor,
        flat: anchor.flat,
        registrations: new Set([registrationId]),
        watcher,
      };
      watcher.on('error', (error) => {
        const current = this.anchors.get(key);
        if (!current || watcher !== current.watcher) return;
        this.onError([...current.registrations], error);
      });
      this.anchors.set(key, signal);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  release(registrationId: number, anchors: RegistrationAnchor[]): void {
    for (const anchor of anchors) {
      const key = anchorKey(anchor.anchor, anchor.flat);
      const signal = this.anchors.get(key);
      if (!signal) continue;
      signal.registrations.delete(registrationId);
      if (signal.registrations.size > 0) continue;
      signal.watcher.close();
      this.anchors.delete(key);
    }
  }

  stop(): void {
    for (const signal of this.anchors.values()) {
      signal.watcher.close();
    }
    this.anchors.clear();
  }
}
