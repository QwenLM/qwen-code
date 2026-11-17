/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  WorkspaceSkillManagementError,
  type WorkspaceSkillMutationResult,
  type WorkspaceSkillScope,
} from './workspace-skill-management.js';

export const SKILL_INSTALL_BUDGET_MS = 120_000;
export const SKILL_INSTALL_RECEIPT_TTL_MS = 10 * 60_000;
export const MAX_SKILL_INSTALL_ATTEMPTS = 256;
export const MAX_ACTIVE_SKILL_INSTALLS = 2;

export type SkillInstallPhase =
  | 'receiving'
  | 'copying'
  | 'waiting'
  | 'extracting'
  | 'publishing'
  | 'cleanup';
export interface SkillInstallAttempt {
  attemptId: string;
  scope: WorkspaceSkillScope;
  skillName: string;
  workspaceId: string;
  generationId?: number;
  state: 'running' | 'committed' | 'not_committed' | 'recovery_required';
  phase: SkillInstallPhase;
  archiveSha256?: string;
  result?: WorkspaceSkillMutationResult & {
    activation?: 'deferred' | 'reconciling';
    activationWarning?: string;
  };
  error?: { code: string; message: string; retainedPaths?: string[] };
}

export function validateSkillInstallAttemptId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new WorkspaceSkillManagementError(
      'invalid_skill_attempt_id',
      'attemptId must be a UUID',
    );
  }
  return value.toLowerCase();
}

export class SkillInstallAttemptStore {
  private readonly owners = new WeakMap<object, string>();
  private readonly records = new Map<
    string,
    { receipt: SkillInstallAttempt; settledAt?: number }
  >();

  private key(owner: string, attemptId: string): string {
    return `${owner}\0${attemptId}`;
  }

  owner(scope: WorkspaceSkillScope, identity: object): string {
    let token = this.owners.get(identity);
    if (!token) {
      token = randomUUID();
      this.owners.set(identity, token);
    }
    return `${scope}:${token}`;
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (
        record.settledAt !== undefined &&
        now - record.settledAt >= SKILL_INSTALL_RECEIPT_TTL_MS
      ) {
        this.records.delete(key);
      }
    }
  }

  reserve(
    owner: string,
    input: Pick<
      SkillInstallAttempt,
      | 'attemptId'
      | 'scope'
      | 'skillName'
      | 'workspaceId'
      | 'generationId'
      | 'phase'
    >,
  ): SkillInstallAttempt {
    const attemptId = validateSkillInstallAttemptId(input.attemptId);
    this.expire();
    const key = this.key(owner, attemptId);
    if (this.records.has(key)) {
      throw new WorkspaceSkillManagementError(
        'skill_attempt_conflict',
        'This attemptId has already been used by this owner; check its result',
        409,
      );
    }
    if (
      [...this.records.values()].filter(
        (record) => record.settledAt === undefined,
      ).length >= MAX_ACTIVE_SKILL_INSTALLS
    ) {
      throw new WorkspaceSkillManagementError(
        'skill_install_busy',
        'Two archive installations are already active',
        429,
      );
    }
    if (this.records.size >= MAX_SKILL_INSTALL_ATTEMPTS) {
      throw new WorkspaceSkillManagementError(
        'skill_install_receipts_full',
        'Installation receipts are full; try again after they expire',
        429,
      );
    }
    const receipt: SkillInstallAttempt = {
      ...input,
      attemptId,
      state: 'running',
    };
    this.records.set(key, { receipt });
    return receipt;
  }

  settle(owner: string, attemptId: string): void {
    const record = this.records.get(this.key(owner, attemptId));
    if (record && record.settledAt === undefined) record.settledAt = Date.now();
  }

  get(owner: string, attemptId: string): SkillInstallAttempt | undefined {
    this.expire();
    const receipt = this.records.get(
      this.key(owner, validateSkillInstallAttemptId(attemptId)),
    )?.receipt;
    return receipt ? structuredClone(receipt) : undefined;
  }
}
