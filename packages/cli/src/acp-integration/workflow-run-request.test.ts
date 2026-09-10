/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseWorkflowRunRequest,
  SessionWorkflowRunRequests,
  WORKFLOW_RUN_MAX_ARGS_BYTES,
  WORKFLOW_RUN_MAX_SCRIPT_BYTES,
} from './workflow-run-request.js';

const request = {
  script: 'return args;',
  args: { input: [1, true, null] },
  sourceRef: { id: 'flow-1', revision: 'r1' },
  clientRequestId: 'request-1',
  expectedWorkspaceCwd: '/workspace',
};

describe('structured workflow run requests', () => {
  it('preserves JSON inputs and rejects unknown fields', () => {
    expect(parseWorkflowRunRequest(request)).toEqual(request);
    expect(() =>
      parseWorkflowRunRequest({ ...request, scriptPath: '/tmp/a.js' }),
    ).toThrow('Unknown');
    expect(() =>
      parseWorkflowRunRequest({ ...request, args: { bad: undefined } }),
    ).toThrow('JSON');
  });

  it.each([
    ['empty script', { script: '' }],
    [
      'oversized script',
      { script: 'a'.repeat(WORKFLOW_RUN_MAX_SCRIPT_BYTES + 1) },
    ],
    ['oversized args', { args: 'a'.repeat(WORKFLOW_RUN_MAX_ARGS_BYTES) }],
    ['nonfinite args', { args: Infinity }],
    ['missing source revision', { sourceRef: { id: 'flow-1' } }],
    ['empty request ID', { clientRequestId: ' ' }],
    ['control characters in request ID', { clientRequestId: 'id\n' }],
    ['relative workspace', { expectedWorkspaceCwd: 'relative/path' }],
  ] as const)('rejects %s', (_label, override) => {
    expect(() =>
      parseWorkflowRunRequest({ ...request, ...override }),
    ).toThrow();
  });

  it('shares concurrent requests even when JSON key order differs', async () => {
    const requests = new SessionWorkflowRunRequests();
    const start = vi.fn(async () => ({
      sessionId: 'session-1',
      runId: 'wf-1',
    }));
    const a = parseWorkflowRunRequest({ ...request, args: { a: 1, b: 2 } });
    const b = parseWorkflowRunRequest({ ...request, args: { b: 2, a: 1 } });
    const first = requests.run(a, start);
    const second = requests.run(b, start);
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({
      sessionId: 'session-1',
      runId: 'wf-1',
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it('rejects reuse of the request ID for changed execution inputs', async () => {
    const requests = new SessionWorkflowRunRequests();
    const start = vi.fn(async () => ({
      sessionId: 'session-1',
      runId: 'wf-1',
    }));
    await requests.run(request, start);
    expect(() =>
      requests.run({ ...request, args: { input: 'changed' } }, start),
    ).toThrow('different workflow');
    expect(start).toHaveBeenCalledOnce();
  });

  it('retains uncertain failures instead of dispatching a retry', async () => {
    const requests = new SessionWorkflowRunRequests();
    const start = vi.fn(async () => {
      throw new Error('connection lost after dispatch');
    });
    await expect(requests.run(request, start)).rejects.toThrow(
      'connection lost',
    );
    await expect(requests.run(request, start)).rejects.toThrow(
      'connection lost',
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it('keeps request IDs local to a session instance', async () => {
    const start = vi.fn(async () => ({
      sessionId: 'session-1',
      runId: 'wf-1',
    }));
    await new SessionWorkflowRunRequests().run(request, start);
    await new SessionWorkflowRunRequests().run(request, start);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
