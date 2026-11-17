/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

export const WORKFLOW_ANCESTOR_TRUST_METHOD =
  'qwen/control/workflow/ancestor-trust';
export const WORKFLOW_ANCESTOR_TRUST_MAX_ANCESTORS = 256;
export const WORKFLOW_ANCESTOR_TRUST_MAX_PATH_CHARS = 32_768;
export const WORKFLOW_ANCESTOR_TRUST_MAX_PATH_BYTES = 1024 * 1024;

export interface WorkflowAncestorTrustRequest {
  readonly v: 1;
  readonly sessionId: string;
  readonly canonicalTargetDir: string;
  readonly ancestorDirs: readonly string[];
}

export interface WorkflowAncestorTrustResponse {
  readonly v: 1;
  readonly trusted: readonly boolean[];
}

export interface WorkflowAncestorTrustContext {
  readonly sessionId: string;
  readonly workspaceCwd: string;
  readonly effectiveCwd: string;
  readonly canonicalTargetDir: string;
  readonly ancestorDirs: readonly string[];
}

export interface WorkflowAncestorTrustDecision {
  readonly trusted: readonly boolean[];
  /** Rechecks the host's captured runtime and policy after bridge I/O. */
  readonly isCurrent: () => boolean;
}

export type WorkflowAncestorTrustHandler = (
  context: WorkflowAncestorTrustContext,
) => Promise<WorkflowAncestorTrustDecision>;

function isPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= WORKFLOW_ANCESTOR_TRUST_MAX_PATH_CHARS &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

export function parseWorkflowAncestorTrustRequest(
  value: unknown,
): WorkflowAncestorTrustRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (
    request['v'] !== 1 ||
    typeof request['sessionId'] !== 'string' ||
    request['sessionId'].trim().length === 0 ||
    request['sessionId'].includes('\0') ||
    !isPath(request['canonicalTargetDir']) ||
    !Array.isArray(request['ancestorDirs']) ||
    request['ancestorDirs'].length > WORKFLOW_ANCESTOR_TRUST_MAX_ANCESTORS
  )
    return;

  const ancestorDirs: string[] = [];
  let bytes = Buffer.byteLength(request['canonicalTargetDir'], 'utf8');
  for (let index = 0; index < request['ancestorDirs'].length; index++) {
    if (!Object.hasOwn(request['ancestorDirs'], index)) return;
    const ancestor = request['ancestorDirs'][index];
    if (!isPath(ancestor)) return;
    bytes += Buffer.byteLength(ancestor, 'utf8');
    if (bytes > WORKFLOW_ANCESTOR_TRUST_MAX_PATH_BYTES) return;
    ancestorDirs.push(ancestor);
  }
  return {
    v: 1,
    sessionId: request['sessionId'],
    canonicalTargetDir: request['canonicalTargetDir'],
    ancestorDirs,
  };
}

export function isWorkflowAncestorTrustResponse(
  value: unknown,
  expectedLength: number,
): value is WorkflowAncestorTrustResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const trusted = response['trusted'];
  if (
    response['v'] !== 1 ||
    !Array.isArray(trusted) ||
    trusted.length !== expectedLength
  )
    return false;
  for (let index = 0; index < trusted.length; index++) {
    if (!Object.hasOwn(trusted, index) || typeof trusted[index] !== 'boolean')
      return false;
  }
  return true;
}
