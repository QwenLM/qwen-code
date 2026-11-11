/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ThreadCanUseToolRequest } from '../thread-manager/thread-session/contract/hostContext.js';
import { StdioPermissionChannel } from './controlStream.js';

function makeRequest(
  overrides: Partial<ThreadCanUseToolRequest> = {},
): ThreadCanUseToolRequest {
  return {
    toolName: 'Bash',
    input: { command: 'ls' },
    suggestions: [],
    blockedPath: undefined,
    title: undefined,
    description: undefined,
    toolUseId: 'tool-1',
    displayName: 'Bash',
    details: undefined,
    ...overrides,
  };
}

async function readFrame(output: PassThrough): Promise<Record<string, unknown>> {
  const [chunk] = await once(output, 'data');
  return JSON.parse(String(chunk)) as Record<string, unknown>;
}

describe('StdioPermissionChannel', () => {
  it('sends can_use_tool and decodes an allow response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = new StdioPermissionChannel(input, output, 'session-1');

    const resultPromise = channel.requestCanUseTool(makeRequest());
    const frame = await readFrame(output);
    expect(frame).toMatchObject({
      type: 'control_request',
      session_id: 'session-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        display_name: 'Bash',
        input: { command: 'ls' },
      },
    });

    input.write(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: frame['request_id'],
          response: {
            behavior: 'allow',
            updatedInput: { command: 'ls -la' },
            permissionScope: 'session',
          },
        },
      }) + '\n',
    );

    await expect(resultPromise).resolves.toEqual({
      decision: {
        behavior: 'allow',
        updatedInput: { command: 'ls -la' },
        permissionScope: 'session',
      },
    });
    channel.close();
  });

  it('withdraws a pending request on abort and treats a late response as orphaned', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = new StdioPermissionChannel(input, output, 'session-1');
    const controller = new AbortController();

    const resultPromise = channel.requestCanUseTool(makeRequest(), {
      signal: controller.signal,
    });
    const requestFrame = await readFrame(output);
    expect(requestFrame['type']).toBe('control_request');

    controller.abort();
    const cancelFrame = await readFrame(output);
    expect(cancelFrame).toEqual({
      type: 'control_cancel_request',
      request_id: requestFrame['request_id'],
      session_id: 'session-1',
    });
    await expect(resultPromise).resolves.toEqual({
      decision: { behavior: 'deny', message: '', interrupt: false },
    });

    input.write(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestFrame['request_id'],
          response: { behavior: 'allow', updatedInput: {} },
        },
      }) + '\n',
    );
    channel.close();
  });
});
