/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import {
  sanitizeLogText,
  type ChannelAuthDriver,
  type ChannelAuthDriverSession,
} from '@qwen-code/channel-base';
import type { ChannelManagementService } from './channel-management-service.js';
import { daemonChannelStateDir } from './channel-state-dir.js';

const DEFAULT_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_ERROR_LENGTH = 512;

export type ChannelAuthState =
  | 'requesting'
  | 'awaiting_scan'
  | 'scanned'
  | 'refreshing'
  | 'ready'
  | 'committed'
  | 'cancelled'
  | 'expired'
  | 'error';

export interface ChannelAuthSessionSnapshot {
  id: string;
  state: ChannelAuthState;
  expiresAt: string;
  qrRevision: number;
  error?: string;
}

export interface ChannelAuthSessionKey {
  workspaceCwd: string;
  runtimeId: string;
  instanceName: string;
  channelType: string;
  clientId: string;
}

export interface ChannelAuthQrPayload {
  payload: string;
  revision: number;
}

export interface ChannelAuthSessionResources {
  driver: ChannelAuthDriver;
  managementService: ChannelManagementService;
}

interface ChannelAuthClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface CreateChannelAuthSessionManagerOptions {
  resolve(
    key: ChannelAuthSessionKey,
  ): ChannelAuthSessionResources | Promise<ChannelAuthSessionResources>;
  ttlMs?: number;
  clock?: ChannelAuthClock;
  createSessionId?: () => string;
}

export class ChannelAuthSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelAuthSessionError';
  }
}

interface SessionRecord {
  readonly id: string;
  readonly key: ChannelAuthSessionKey;
  readonly keyId: string;
  readonly expiresAtMs: number;
  readonly controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  state: ChannelAuthState;
  qrRevision: number;
  error?: string;
  driverSession?: ChannelAuthDriverSession<unknown>;
  commitStarted: boolean;
}

const systemClock: ChannelAuthClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function keyId(key: ChannelAuthSessionKey): string {
  return JSON.stringify([
    key.workspaceCwd,
    key.runtimeId,
    key.instanceName,
    key.channelType,
    key.clientId,
  ]);
}

function sameKey(left: ChannelAuthSessionKey, right: ChannelAuthSessionKey) {
  return (
    left.workspaceCwd === right.workspaceCwd &&
    left.runtimeId === right.runtimeId &&
    left.instanceName === right.instanceName &&
    left.channelType === right.channelType &&
    left.clientId === right.clientId
  );
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    ...sanitizeLogText(redactLogCredentials(message), MAX_AUTH_ERROR_LENGTH),
  ]
    .slice(0, MAX_AUTH_ERROR_LENGTH)
    .join('');
}

function safeQrRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function mappedDriverState(state: string, hasQr: boolean): ChannelAuthState {
  switch (state) {
    case 'requesting':
      return 'requesting';
    case 'pending':
    case 'awaiting_scan':
      return hasQr ? 'awaiting_scan' : 'requesting';
    case 'scaned':
    case 'scanned':
      return 'scanned';
    case 'refreshing':
      return 'refreshing';
    case 'confirmed':
    case 'ready':
      return 'scanned';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'error';
  }
}

function terminal(state: ChannelAuthState): boolean {
  return (
    state === 'committed' ||
    state === 'cancelled' ||
    state === 'expired' ||
    state === 'error'
  );
}

function errorForState(state: ChannelAuthState): ChannelAuthSessionError {
  switch (state) {
    case 'cancelled':
      return new ChannelAuthSessionError(
        'channel_auth_cancelled',
        'Channel authentication was cancelled.',
      );
    case 'expired':
      return new ChannelAuthSessionError(
        'channel_auth_expired',
        'Channel authentication expired.',
      );
    case 'committed':
      return new ChannelAuthSessionError(
        'channel_auth_already_committed',
        'Channel authentication was already committed.',
      );
    case 'error':
      return new ChannelAuthSessionError(
        'channel_auth_failed',
        'Channel authentication failed.',
      );
    default:
      return new ChannelAuthSessionError(
        'channel_auth_not_ready',
        'Channel authentication is not ready to commit.',
      );
  }
}

export interface ChannelAuthSessionManager {
  begin(key: ChannelAuthSessionKey): Promise<ChannelAuthSessionSnapshot>;
  get(
    key: ChannelAuthSessionKey,
    sessionId: string,
  ): ChannelAuthSessionSnapshot;
  getQr(key: ChannelAuthSessionKey, sessionId: string): ChannelAuthQrPayload;
  cancel(
    key: ChannelAuthSessionKey,
    sessionId: string,
  ): ChannelAuthSessionSnapshot;
  commit(
    key: ChannelAuthSessionKey,
    sessionId: string,
  ): Promise<ChannelAuthSessionSnapshot>;
  removeWorkspace(workspaceCwd: string, runtimeId?: string): void;
  shutdown(): void;
}

export function createChannelAuthSessionManager(
  options: CreateChannelAuthSessionManagerOptions,
): ChannelAuthSessionManager {
  const ttlMs = options.ttlMs ?? DEFAULT_AUTH_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Channel auth session TTL must be a positive integer.');
  }
  const clock = options.clock ?? systemClock;
  const createSessionId = options.createSessionId ?? randomUUID;
  const sessions = new Map<string, SessionRecord>();
  const activeByKey = new Map<string, string>();
  const credentials = new Map<string, unknown>();
  let stopped = false;

  const releaseActive = (record: SessionRecord) => {
    if (activeByKey.get(record.keyId) === record.id) {
      activeByKey.delete(record.keyId);
    }
  };

  const clearExpiry = (record: SessionRecord) => {
    if (record.timer !== undefined) {
      clock.clearTimeout(record.timer);
      record.timer = undefined;
    }
  };

  const cancelDriver = (record: SessionRecord) => {
    const driverSession = record.driverSession;
    record.driverSession = undefined;
    try {
      driverSession?.cancel();
    } catch {
      // Session ownership and credential cleanup must not depend on a plugin.
    }
  };

  const snapshot = (record: SessionRecord): ChannelAuthSessionSnapshot => ({
    id: record.id,
    state: record.state,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    qrRevision: record.qrRevision,
    ...(record.error ? { error: record.error } : {}),
  });

  const finish = (
    record: SessionRecord,
    state: Extract<ChannelAuthState, 'cancelled' | 'expired' | 'error'>,
    error?: unknown,
  ) => {
    if (terminal(record.state)) return;
    record.state = state;
    record.error = error === undefined ? undefined : diagnostic(error);
    credentials.delete(record.id);
    releaseActive(record);
    clearExpiry(record);
    record.controller.abort();
    cancelDriver(record);
  };

  const expire = (record: SessionRecord) => {
    if (!terminal(record.state)) finish(record, 'expired');
  };

  const expireIfNeeded = (record: SessionRecord) => {
    if (clock.now() >= record.expiresAtMs) expire(record);
  };

  const ownedRecord = (
    requestedKey: ChannelAuthSessionKey,
    sessionId: string,
  ) => {
    const record = sessions.get(sessionId);
    if (!record || !sameKey(record.key, requestedKey)) {
      throw new ChannelAuthSessionError(
        'channel_auth_session_not_found',
        'Channel authentication session was not found.',
      );
    }
    expireIfNeeded(record);
    return record;
  };

  const refreshFromDriver = (record: SessionRecord) => {
    if (terminal(record.state) || record.state === 'ready') return;
    const driverSession = record.driverSession;
    if (!driverSession) return;
    try {
      const driverSnapshot = driverSession.snapshot();
      record.qrRevision = safeQrRevision(driverSnapshot.qrRevision);
      const mapped = mappedDriverState(
        driverSnapshot.state,
        typeof driverSnapshot.qrPayload === 'string' &&
          driverSnapshot.qrPayload.length > 0,
      );
      if (mapped === 'cancelled') {
        finish(record, 'cancelled');
      } else if (mapped === 'error') {
        finish(
          record,
          'error',
          new Error('Authentication driver reported an unsupported state.'),
        );
      } else {
        record.state = mapped;
      }
    } catch (error) {
      finish(record, 'error', error);
    }
  };

  const publicSnapshot = (record: SessionRecord) => {
    expireIfNeeded(record);
    refreshFromDriver(record);
    return snapshot(record);
  };

  return {
    async begin(key) {
      if (stopped) {
        throw new ChannelAuthSessionError(
          'channel_auth_unavailable',
          'Channel authentication is unavailable.',
        );
      }
      const exactKeyId = keyId(key);
      if (activeByKey.has(exactKeyId)) {
        throw new ChannelAuthSessionError(
          'channel_auth_in_progress',
          'Channel authentication is already in progress.',
        );
      }

      const id = createSessionId();
      const expiresAtMs = clock.now() + ttlMs;
      const record: SessionRecord = {
        id,
        key: { ...key },
        keyId: exactKeyId,
        expiresAtMs,
        controller: new AbortController(),
        state: 'requesting',
        qrRevision: 0,
        commitStarted: false,
      };
      record.timer = clock.setTimeout(() => expire(record), ttlMs);
      sessions.set(id, record);
      activeByKey.set(exactKeyId, id);

      try {
        const resources = await options.resolve(record.key);
        const configured = await resources.managementService.list();
        const instance = Object.hasOwn(
          configured.instances,
          record.key.instanceName,
        )
          ? configured.instances[record.key.instanceName]
          : undefined;
        if (!instance || instance.config['type'] !== record.key.channelType) {
          throw new ChannelAuthSessionError(
            'channel_auth_instance_mismatch',
            'The configured Channel instance does not match this authentication request.',
          );
        }
        if (resources.driver.kind !== 'qr') {
          throw new ChannelAuthSessionError(
            'channel_auth_unsupported',
            'The Channel type does not support QR authentication.',
          );
        }
        const driverSession = await resources.driver.begin({
          channelName: record.key.instanceName,
          stateDir: daemonChannelStateDir(
            record.key.workspaceCwd,
            record.key.instanceName,
            record.key.channelType,
          ),
          signal: record.controller.signal,
        });
        record.driverSession = driverSession;
        if (terminal(record.state)) {
          cancelDriver(record);
        }
        void driverSession.ready.then(
          (resolvedCredentials) => {
            expireIfNeeded(record);
            if (terminal(record.state) || record.commitStarted) return;
            credentials.set(record.id, resolvedCredentials);
            record.state = 'ready';
            record.error = undefined;
          },
          (error: unknown) => {
            expireIfNeeded(record);
            if (!terminal(record.state)) finish(record, 'error', error);
          },
        );
        return publicSnapshot(record);
      } catch (error) {
        clearExpiry(record);
        credentials.delete(record.id);
        releaseActive(record);
        record.controller.abort();
        cancelDriver(record);
        sessions.delete(record.id);
        if (error instanceof ChannelAuthSessionError) throw error;
        throw new ChannelAuthSessionError(
          'channel_auth_failed',
          diagnostic(error),
        );
      }
    },

    get(key, sessionId) {
      return publicSnapshot(ownedRecord(key, sessionId));
    },

    getQr(key, sessionId) {
      const record = ownedRecord(key, sessionId);
      refreshFromDriver(record);
      if (
        record.state !== 'awaiting_scan' &&
        record.state !== 'scanned' &&
        record.state !== 'refreshing'
      ) {
        throw new ChannelAuthSessionError(
          'channel_auth_qr_unavailable',
          'The QR code is not available for this authentication session.',
        );
      }
      let driverSnapshot;
      try {
        driverSnapshot = record.driverSession?.snapshot();
      } catch (error) {
        finish(record, 'error', error);
        throw new ChannelAuthSessionError(
          'channel_auth_failed',
          'Channel authentication failed.',
        );
      }
      if (!driverSnapshot) {
        throw new ChannelAuthSessionError(
          'channel_auth_qr_unavailable',
          'The QR code is not available for this authentication session.',
        );
      }
      const payload = driverSnapshot?.qrPayload;
      if (typeof payload !== 'string' || payload.length === 0) {
        throw new ChannelAuthSessionError(
          'channel_auth_qr_unavailable',
          'The QR code is not available for this authentication session.',
        );
      }
      return {
        payload,
        revision: safeQrRevision(driverSnapshot.qrRevision),
      };
    },

    cancel(key, sessionId) {
      const record = ownedRecord(key, sessionId);
      if (record.commitStarted && record.state === 'ready') {
        throw new ChannelAuthSessionError(
          'channel_auth_commit_in_progress',
          'Channel authentication commit is in progress.',
        );
      }
      if (!terminal(record.state)) finish(record, 'cancelled');
      return snapshot(record);
    },

    async commit(key, sessionId) {
      const record = ownedRecord(key, sessionId);
      if (record.commitStarted) {
        if (record.state !== 'ready') throw errorForState(record.state);
        throw new ChannelAuthSessionError(
          'channel_auth_commit_in_progress',
          'Channel authentication commit is in progress.',
        );
      }
      if (record.state !== 'ready') throw errorForState(record.state);
      const resolvedCredentials = credentials.get(record.id);
      if (resolvedCredentials === undefined || !record.driverSession) {
        throw new ChannelAuthSessionError(
          'channel_auth_not_ready',
          'Channel authentication is not ready to commit.',
        );
      }

      record.commitStarted = true;
      credentials.delete(record.id);
      try {
        await record.driverSession.commit(resolvedCredentials);
        expireIfNeeded(record);
        if ((record.state as ChannelAuthState) !== 'ready') {
          throw errorForState(record.state as ChannelAuthState);
        }
        record.state = 'committed';
        record.error = undefined;
        releaseActive(record);
        clearExpiry(record);
        record.controller.abort();
        cancelDriver(record);
        return snapshot(record);
      } catch (error) {
        if (error instanceof ChannelAuthSessionError) throw error;
        if (!terminal(record.state)) finish(record, 'error', error);
        throw new ChannelAuthSessionError(
          'channel_auth_commit_failed',
          diagnostic(error),
        );
      }
    },

    removeWorkspace(workspaceCwd, runtimeId) {
      for (const record of sessions.values()) {
        if (
          record.key.workspaceCwd === workspaceCwd &&
          (runtimeId === undefined || record.key.runtimeId === runtimeId) &&
          !terminal(record.state)
        ) {
          finish(record, 'cancelled');
        }
      }
    },

    shutdown() {
      stopped = true;
      for (const record of sessions.values()) {
        if (!terminal(record.state)) finish(record, 'cancelled');
      }
    },
  };
}
