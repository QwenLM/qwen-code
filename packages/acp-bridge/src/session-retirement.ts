/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_BYTES = 4096;

export interface SessionRetirementIdentity {
  sessionId: string;
  operationId: string;
  eventEpoch: string;
}

export interface SessionRetirementReceipt extends SessionRetirementIdentity {
  state: 'retiring' | 'retired' | 'result_unknown';
}

export class SessionRetirementError extends Error {
  constructor(
    readonly code:
      | 'session_retire_busy'
      | 'session_retire_unavailable'
      | 'session_retire_epoch_mismatch'
      | 'session_retire_identity_conflict'
      | 'session_retirement_fenced',
    message: string,
    readonly identity?: SessionRetirementIdentity,
  ) {
    super(message);
  }
}

export function isRetirementId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** A record fences this native ID in this source workspace, even after restart. */
export class SessionRetirementLedger {
  private readonly directory: string;

  constructor(runtimeRoot: string, workspace: string) {
    this.directory = path.join(
      runtimeRoot,
      'session-retirements',
      createHash('sha256').update(workspace).digest('hex'),
    );
  }

  private file(sessionId: string): string {
    return path.join(
      this.directory,
      createHash('sha256').update(sessionId.toLowerCase()).digest('hex') +
        '.json',
    );
  }

  read(sessionId: string): SessionRetirementReceipt | undefined {
    let fd: number;
    try {
      fd = openSync(
        this.file(sessionId),
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new Error('Invalid session retirement record');
      const receipt = JSON.parse(
        readFileSync(fd, 'utf8'),
      ) as Partial<SessionRetirementReceipt> | null;
      if (
        !receipt ||
        typeof receipt.sessionId !== 'string' ||
        receipt.sessionId.toLowerCase() !== sessionId.toLowerCase() ||
        !isRetirementId(receipt.operationId) ||
        !isRetirementId(receipt.eventEpoch) ||
        (receipt.state !== 'retiring' &&
          receipt.state !== 'retired' &&
          receipt.state !== 'result_unknown')
      )
        throw new Error('Invalid session retirement record');
      return {
        sessionId: receipt.sessionId,
        operationId: receipt.operationId,
        eventEpoch: receipt.eventEpoch,
        state: receipt.state,
      };
    } finally {
      closeSync(fd);
    }
  }

  assertOpen(sessionId: string): void {
    if (this.read(sessionId)) {
      throw new SessionRetirementError(
        'session_retirement_fenced',
        'This native session is fenced for retirement',
      );
    }
  }

  begin(identity: SessionRetirementIdentity): void {
    try {
      this.write({ ...identity, state: 'retiring' }, true);
    } catch (error) {
      if (
        error === null ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
      throw new SessionRetirementError(
        'session_retire_identity_conflict',
        'A retirement already owns this native session',
        identity,
      );
    }
  }

  releaseNotStarted(identity: SessionRetirementIdentity): void {
    const previous = this.read(identity.sessionId);
    if (
      !previous ||
      previous.operationId !== identity.operationId ||
      previous.eventEpoch !== identity.eventEpoch ||
      previous.state !== 'retiring'
    )
      throw new Error('Session retirement ownership changed');
    unlinkSync(this.file(identity.sessionId));
    this.syncDirectory(this.directory);
  }

  private syncDirectory(directory: string): void {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  settle(
    identity: SessionRetirementIdentity,
    state: 'retired' | 'result_unknown',
  ): SessionRetirementReceipt {
    const previous = this.read(identity.sessionId);
    if (
      !previous ||
      previous.operationId !== identity.operationId ||
      previous.eventEpoch !== identity.eventEpoch ||
      (previous.state !== 'retiring' &&
        !(previous.state === 'result_unknown' && state === 'retired'))
    )
      throw new Error('Session retirement ownership changed');
    const receipt = { ...identity, state };
    this.write(receipt, false);
    return receipt;
  }

  private write(receipt: SessionRetirementReceipt, exclusive: boolean): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(receipt.sessionId);
    const temporary = path.join(this.directory, randomUUID() + '.tmp');
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(receipt));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (exclusive) linkSync(temporary, target);
      else renameSync(temporary, target);
      this.syncDirectory(this.directory);
      if (exclusive) {
        this.syncDirectory(path.dirname(this.directory));
        this.syncDirectory(path.dirname(path.dirname(this.directory)));
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Temporary files are never a fence or receipt. Cleanup cannot
        // change the result of the committed write.
      }
    }
  }
}
