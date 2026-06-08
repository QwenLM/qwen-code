/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildPayload } from './payload.js';

describe('buildPayload', () => {
  it('maps permission_request to permission.required with toolName, requestId, url', () => {
    const p = buildPayload(
      {
        type: 'permission_request',
        data: {
          toolCall: { name: 'run_shell_command' },
          requestId: 'req-7',
        },
      },
      { sessionId: 's1', sessionName: 'My Session' },
    );
    expect(p).not.toBeNull();
    expect(p!.v).toBe(1);
    expect(p!.kind).toBe('permission.required');
    expect(p!.sessionId).toBe('s1');
    expect(p!.sessionName).toBe('My Session');
    expect(p!.summary).toBe('Permission needed: run_shell_command');
    expect(p!.url).toBe('/ui/?session=s1');
    expect(p!.requestId).toBe('req-7');
  });

  it('falls back to "a tool call" when no toolName is present', () => {
    const p = buildPayload(
      { type: 'permission_request', data: { requestId: 'req-1' } },
      { sessionId: 's2' },
    );
    expect(p!.summary).toBe('Permission needed: a tool call');
  });

  it('truncates summary to <=140 chars with an ellipsis', () => {
    const longName = 'x'.repeat(300);
    const p = buildPayload(
      { type: 'permission_request', data: { toolName: longName } },
      { sessionId: 's3' },
    );
    expect(p!.summary.length).toBe(140);
    expect(p!.summary.endsWith('…')).toBe(true);
  });

  it('returns null for an unknown event type', () => {
    const p = buildPayload(
      { type: 'something_else', data: {} },
      { sessionId: 's4' },
    );
    expect(p).toBeNull();
  });

  it('never leaks tool args/secrets into the summary', () => {
    const SECRET = 'SUPER-SECRET-API-KEY-9f3a';
    const p = buildPayload(
      {
        type: 'permission_request',
        data: {
          toolCall: {
            name: 'run_shell_command',
            args: { command: `curl -H "auth: ${SECRET}"`, path: '/etc/passwd' },
          },
          requestId: 'req-9',
        },
      },
      { sessionId: 's5' },
    );
    expect(p!.summary).not.toContain(SECRET);
    expect(p!.summary).not.toContain('/etc/passwd');
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it('encodes the sessionId in the url', () => {
    const p = buildPayload(
      { type: 'permission_request', data: {} },
      { sessionId: 'a/b c' },
    );
    expect(p!.url).toBe('/ui/?session=a%2Fb%20c');
  });
});
