/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError } from './DaemonHttpError.js';

/** Retains the attempt ID even when the daemon's response was never received. */
export class DaemonSkillInstallError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;

  constructor(
    readonly attemptId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'DaemonSkillInstallError';
    this.status = cause instanceof DaemonHttpError ? cause.status : undefined;
    this.body = cause instanceof DaemonHttpError ? cause.body : undefined;
  }
}
