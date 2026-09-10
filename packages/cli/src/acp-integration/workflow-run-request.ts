/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { normalizeWorkflowSourceRef } from '@qwen-code/qwen-code-core';
import type {
  ServeSessionWorkflowRunRequest,
  ServeSessionWorkflowRunResult,
} from '@qwen-code/acp-bridge/status';

export const WORKFLOW_RUN_MAX_SCRIPT_BYTES = 256 * 1024;
export const WORKFLOW_RUN_MAX_ARGS_BYTES = 256 * 1024;

export class WorkflowRunRequestError extends Error {
  readonly data: { errorKind: string };

  constructor(code: string, message: string) {
    super(message);
    this.data = { errorKind: code };
  }
}

export function workflowRunErrorStatus(error: unknown): number | undefined {
  const code = (error as { data?: { errorKind?: string } } | null)?.data
    ?.errorKind;
  switch (code) {
    case 'invalid_workflow_run_request':
      return 400;
    case 'workflow_disabled':
      return 403;
    case 'workflow_request_conflict':
    case 'workflow_workspace_mismatch':
      return 409;
    case 'workflow_start_failed':
      return 422;
    default:
      return undefined;
  }
}

function invalid(message: string): never {
  throw new WorkflowRunRequestError('invalid_workflow_run_request', message);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function canonicalJson(value: unknown, depth = 0): unknown {
  if (depth > 100) invalid('Workflow arguments exceed the nesting limit.');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJson(entry, depth + 1));
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalJson((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  }
  return invalid('Workflow arguments must be JSON values.');
}

export function parseExpectedWorkflowWorkspaceCwd(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.length > 4096 ||
    hasControlCharacters(value)
  ) {
    invalid('expectedWorkspaceCwd must be an absolute path.');
  }
  return value;
}

export function parseWorkflowRunRequest(
  value: unknown,
): ServeSessionWorkflowRunRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('Workflow run request must be an object.');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'script',
    'args',
    'sourceRef',
    'clientRequestId',
    'expectedWorkspaceCwd',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    invalid('Unknown workflow run request field.');
  }
  const script = input['script'];
  if (
    typeof script !== 'string' ||
    !script.trim() ||
    Buffer.byteLength(script, 'utf8') > WORKFLOW_RUN_MAX_SCRIPT_BYTES
  ) {
    invalid('Workflow script must be nonempty and at most 256 KiB.');
  }
  const clientRequestId = input['clientRequestId'];
  if (
    typeof clientRequestId !== 'string' ||
    !clientRequestId ||
    clientRequestId.length > 256 ||
    clientRequestId.trim() !== clientRequestId ||
    hasControlCharacters(clientRequestId)
  ) {
    invalid(
      'clientRequestId must be a nonempty identifier of at most 256 characters.',
    );
  }
  let sourceRef: ServeSessionWorkflowRunRequest['sourceRef'];
  try {
    sourceRef = normalizeWorkflowSourceRef(input['sourceRef']);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid sourceRef.');
  }
  const expectedWorkspaceCwd = parseExpectedWorkflowWorkspaceCwd(
    input['expectedWorkspaceCwd'],
  );
  const args =
    input['args'] === undefined ? undefined : canonicalJson(input['args']);
  if (
    args !== undefined &&
    Buffer.byteLength(JSON.stringify(args), 'utf8') >
      WORKFLOW_RUN_MAX_ARGS_BYTES
  ) {
    invalid('Workflow arguments must be at most 256 KiB of JSON.');
  }
  return {
    script,
    ...(args === undefined ? {} : { args }),
    sourceRef,
    clientRequestId,
    ...(expectedWorkspaceCwd === undefined ? {} : { expectedWorkspaceCwd }),
  };
}

/** 失败也保留：启动结果不确定时，同一请求不能重新派发外部写入。 */
export class SessionWorkflowRunRequests {
  private readonly requests = new Map<
    string,
    {
      digest: string;
      result: Promise<ServeSessionWorkflowRunResult>;
    }
  >();

  run(
    request: ServeSessionWorkflowRunRequest,
    start: () => Promise<ServeSessionWorkflowRunResult>,
  ): Promise<ServeSessionWorkflowRunResult> {
    const digest = createHash('sha256')
      .update(JSON.stringify(canonicalJson(request)))
      .digest('hex');
    const previous = this.requests.get(request.clientRequestId);
    if (previous) {
      if (previous.digest !== digest) {
        throw new WorkflowRunRequestError(
          'workflow_request_conflict',
          'clientRequestId already identifies a different workflow request.',
        );
      }
      return previous.result;
    }
    const result = Promise.resolve().then(start);
    this.requests.set(request.clientRequestId, { digest, result });
    return result;
  }
}
