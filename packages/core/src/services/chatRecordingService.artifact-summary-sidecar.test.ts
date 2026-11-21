/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { ChatRecordingService } from './chatRecordingService.js';
import type {
  PersistedSessionArtifact,
  SessionArtifactEventRecordPayload,
  SessionArtifactSnapshotRecordPayload,
} from './session-artifact-persistence.js';
import {
  readSessionArtifactSummarySidecar,
  sessionArtifactSummarySidecarPath,
  writeSessionArtifactSummarySidecar,
} from './session-artifact-summary-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function persistedArtifact(id: string): PersistedSessionArtifact {
  return {
    id,
    kind: 'link',
    storage: 'external_url',
    source: 'client',
    status: 'available',
    title: id,
    url: `https://example.com/${id}`,
    retention: 'restorable',
    clientRetained: true,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
  };
}

const eventPayload = (
  artifactCount?: number,
): SessionArtifactEventRecordPayload => ({
  v: 2,
  sessionId: SESSION_ID,
  sequence: 1,
  recordedAt: '2026-11-17T00:00:00.000Z',
  changes: [],
  ...(artifactCount !== undefined ? { artifactCount } : {}),
});

const snapshotPayload = (
  artifacts: PersistedSessionArtifact[],
): SessionArtifactSnapshotRecordPayload => ({
  v: 2,
  sessionId: SESSION_ID,
  sequence: 2,
  recordedAt: '2026-11-17T00:00:01.000Z',
  artifacts,
  tombstonedIds: [],
  stickyEphemeralIds: [],
});

describe('ChatRecordingService - artifact summary sidecar', () => {
  let root: string;
  let projectDir: string;
  let chatsDir: string;
  let sidecarPath: string;
  let service: ChatRecordingService;

  function makeConfig(): Config {
    return {
      getSessionId: () => SESSION_ID,
      getProjectRoot: () => root,
      getCliVersion: () => '1.0.0',
      getModel: () => 'test-model',
      getAuthType: () => undefined,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getFastModel: () => undefined,
      isInteractive: () => false,
      getDebugMode: () => false,
      getResumedSessionData: () => undefined,
      storage: {
        getProjectDir: () => projectDir,
        getProjectTempDir: () => path.join(root, '.qwen', 'tmp'),
      },
    } as unknown as Config;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-recording-artifacts-'));
    projectDir = path.join(root, '.qwen', 'projects', 'test-project');
    chatsDir = path.join(projectDir, 'chats');
    mkdirSync(chatsDir, { recursive: true });
    sidecarPath = sessionArtifactSummarySidecarPath(chatsDir, SESSION_ID);
    service = new ChatRecordingService(makeConfig(), undefined, false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refreshes the sidecar from the event payload count', async () => {
    await service.recordSessionArtifactEvent(eventPayload(3));
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      3,
    );
  });

  it('writes a zero count when the event reports all artifacts removed', async () => {
    await service.recordSessionArtifactEvent(eventPayload(0));
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('does not create a sidecar for legacy events without a count', async () => {
    await service.recordSessionArtifactEvent(eventPayload());
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('preserves an existing sidecar across legacy events without a count', async () => {
    // An older daemon (or a run of count-less events) continuing a session
    // must not erase the count the list already shows.
    writeSessionArtifactSummarySidecar(sidecarPath, 4);
    await service.recordSessionArtifactEvent(eventPayload());
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      4,
    );
  });

  it('refreshes the sidecar from the snapshot artifact list', async () => {
    await service.recordSessionArtifactSnapshot(
      snapshotPayload([persistedArtifact('a'), persistedArtifact('b')]),
    );
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('lets a later event update the snapshot-seeded count', async () => {
    await service.recordSessionArtifactSnapshot(
      snapshotPayload([persistedArtifact('a'), persistedArtifact('b')]),
    );
    await service.recordSessionArtifactEvent(eventPayload(1));
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('does not write the sidecar when the journal append fails', async () => {
    // Block the chats dir so the strict append rejects. No sidecar
    // assertion here: with the directory blocked the derived write can
    // never land under ANY order, so an absence check would be vacuous
    // (the order-discriminating fixtures below keep the sidecar path
    // writable).
    rmSync(chatsDir, { recursive: true, force: true });
    writeFileSync(chatsDir, 'not a directory');
    await expect(
      service.recordSessionArtifactEvent(eventPayload(3)),
    ).rejects.toThrow();
  });

  it('does not write the sidecar ahead of a failing journal append', async () => {
    // Occupy the journal path with a directory: the strict append rejects
    // while the sidecar path stays writable. A sidecar written BEFORE the
    // append would land here, so the absence assertion pins the order
    // (the blocked-dir fixture above cannot distinguish order).
    mkdirSync(path.join(chatsDir, `${SESSION_ID}.jsonl`));
    await expect(
      service.recordSessionArtifactEvent(eventPayload(3)),
    ).rejects.toThrow();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('does not write the snapshot sidecar ahead of a failing journal append', async () => {
    // Mirror of the event-path order witness for the snapshot write.
    mkdirSync(path.join(chatsDir, `${SESSION_ID}.jsonl`));
    await expect(
      service.recordSessionArtifactSnapshot(
        snapshotPayload([persistedArtifact('a'), persistedArtifact('b')]),
      ),
    ).rejects.toThrow();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });
});
