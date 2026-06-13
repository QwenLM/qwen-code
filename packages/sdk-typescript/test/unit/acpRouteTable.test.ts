/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ROUTE_TABLE } from '../../src/daemon/acpRouteTable.js';
import { matchRoute } from '../../src/daemon/acpTransportUtils.js';

// ---------------------------------------------------------------------------
// ROUTE_TABLE shape
// ---------------------------------------------------------------------------

describe('acpRouteTable – ROUTE_TABLE', () => {
  it('is a non-empty readonly array', () => {
    expect(Array.isArray(ROUTE_TABLE)).toBe(true);
    expect(ROUTE_TABLE.length).toBeGreaterThan(0);
  });

  it('every entry has httpMethod, pattern, and mapping', () => {
    for (const entry of ROUTE_TABLE) {
      expect(typeof entry.httpMethod).toBe('string');
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.mapping.method).toBe('string');
      expect(typeof entry.mapping.extractParams).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// matchRoute – session routes
// ---------------------------------------------------------------------------

describe('acpRouteTable – matchRoute', () => {
  // ---- POST /session → session/new ------------------------------------

  it('POST /session maps to session/new', () => {
    const result = matchRoute('/session', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/new');
  });

  it('POST /session/ (trailing slash) maps to session/new', () => {
    const result = matchRoute('/session/', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/new');
  });

  it('POST /session passes body through as params', () => {
    const result = matchRoute('/session', 'POST')!;
    const params = result.mapping.extractParams(
      result.segments,
      { model: 'gpt-4' },
      'POST',
    );
    expect(params).toEqual({ model: 'gpt-4' });
  });

  it('POST /session with non-record body returns empty params', () => {
    const result = matchRoute('/session', 'POST')!;
    const params = result.mapping.extractParams(
      result.segments,
      'not-an-object',
      'POST',
    );
    expect(params).toEqual({});
  });

  // ---- POST /session/:id/prompt → session/prompt ---------------------

  it('POST /session/:id/prompt maps to session/prompt', () => {
    const result = matchRoute('/session/abc-123/prompt', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/prompt');
  });

  it('POST /session/:id/prompt extracts sessionId', () => {
    const result = matchRoute('/session/abc-123/prompt', 'POST')!;
    expect(result.segments[0]).toBe('abc-123');
    const params = result.mapping.extractParams(
      result.segments,
      { message: 'hello' },
      'POST',
    );
    expect(params).toEqual({ sessionId: 'abc-123', message: 'hello' });
  });

  // ---- POST /session/:id/cancel → session/cancel (notification) ------

  it('POST /session/:id/cancel maps to session/cancel', () => {
    const result = matchRoute('/session/s1/cancel', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/cancel');
    expect(result!.mapping.notification).toBe(true);
  });

  it('POST /session/:id/cancel extracts sessionId', () => {
    const result = matchRoute('/session/s1/cancel', 'POST')!;
    const params = result.mapping.extractParams(result.segments, {}, 'POST');
    expect(params).toEqual({ sessionId: 's1' });
  });

  // ---- DELETE /session/:id → session/close ----------------------------

  it('DELETE /session/:id maps to session/close', () => {
    const result = matchRoute('/session/s2', 'DELETE');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/close');
  });

  it('DELETE /session/:id/ (trailing slash) maps to session/close', () => {
    const result = matchRoute('/session/s2/', 'DELETE');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/close');
  });

  // ---- POST /session/:id/load → session/load --------------------------

  it('POST /session/:id/load maps to session/load', () => {
    const result = matchRoute('/session/s3/load', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/load');
    const params = result!.mapping.extractParams(
      result!.segments,
      { resumeFrom: 5 },
      'POST',
    );
    expect(params).toEqual({ sessionId: 's3', resumeFrom: 5 });
  });

  // ---- POST /session/:id/resume → session/resume ----------------------

  it('POST /session/:id/resume maps to session/resume', () => {
    const result = matchRoute('/session/s4/resume', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/resume');
  });

  // ---- POST /session/:id/permission/:reqId → session/permission ------

  it('POST /session/:id/permission/:reqId maps to session/permission', () => {
    const result = matchRoute('/session/s5/permission/req-7', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/permission');
    const params = result!.mapping.extractParams(
      result!.segments,
      { allow: true },
      'POST',
    );
    expect(params).toEqual({
      sessionId: 's5',
      requestId: 'req-7',
      allow: true,
    });
  });

  // ---- POST /permission/:reqId (no session prefix) --------------------

  it('POST /permission/:reqId maps to session/permission', () => {
    const result = matchRoute('/permission/req-9', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/permission');
    const params = result!.mapping.extractParams(
      result!.segments,
      { allow: false },
      'POST',
    );
    expect(params).toEqual({ requestId: 'req-9', allow: false });
  });

  // ---- GET /capabilities → _capabilities (special) -------------------

  it('GET /capabilities maps to _capabilities', () => {
    const result = matchRoute('/capabilities', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_capabilities');
  });

  it('GET /capabilities/ (trailing slash) maps to _capabilities', () => {
    const result = matchRoute('/capabilities/', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_capabilities');
  });

  // ---- GET /health → _qwen/health ------------------------------------

  it('GET /health maps to _qwen/health', () => {
    const result = matchRoute('/health', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/health');
  });

  // ---- workspace routes -----------------------------------------------

  it('GET /workspace/foo/bar maps to _qwen/workspace with path', () => {
    const result = matchRoute('/workspace/foo/bar', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ path: 'foo/bar' });
  });

  it('POST /workspace/settings maps to _qwen/workspace with body', () => {
    const result = matchRoute('/workspace/settings', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace');
    const params = result!.mapping.extractParams(
      result!.segments,
      { value: 42 },
      'POST',
    );
    expect(params).toEqual({ path: 'settings', value: 42 });
  });

  // ---- PATCH /session/:id/metadata → session/metadata ----------------

  it('PATCH /session/:id/metadata maps to session/metadata', () => {
    const result = matchRoute('/session/s6/metadata', 'PATCH');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/metadata');
  });

  // ---- POST /session/:id/model → session/set_config_option -----------

  it('POST /session/:id/model maps to session/set_config_option', () => {
    const result = matchRoute('/session/s7/model', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/set_config_option');
  });

  // ---- Other session action routes ------------------------------------

  it('POST /session/:id/heartbeat maps to session/heartbeat', () => {
    const result = matchRoute('/session/s8/heartbeat', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/heartbeat');
  });

  it('POST /session/:id/recap maps to session/recap', () => {
    const result = matchRoute('/session/s9/recap', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/recap');
  });

  it('POST /session/:id/btw maps to session/btw', () => {
    const result = matchRoute('/session/s10/btw', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/btw');
  });

  it('POST /session/:id/shell maps to session/shell', () => {
    const result = matchRoute('/session/s11/shell', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/shell');
  });

  it('POST /session/:id/approval-mode maps to session/approval_mode', () => {
    const result = matchRoute('/session/s12/approval-mode', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/approval_mode');
  });

  it('POST /session/:id/branch maps to session/branch', () => {
    const result = matchRoute('/session/s13/branch', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/branch');
  });

  // ---- Session diagnostic / action routes --------------------------------

  it('GET /session/:id/context maps to session/context', () => {
    const result = matchRoute('/session/s14/context', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/context');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ sessionId: 's14' });
  });

  it('GET /session/:id/context-usage maps to session/context_usage', () => {
    const result = matchRoute('/session/s15/context-usage', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/context_usage');
  });

  it('GET /session/:id/supported-commands maps to session/supported_commands', () => {
    const result = matchRoute('/session/s16/supported-commands', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/supported_commands');
  });

  it('GET /session/:id/tasks maps to session/tasks', () => {
    const result = matchRoute('/session/s17/tasks', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/tasks');
  });

  it('POST /session/:id/tasks/:taskId/cancel maps to session/task_cancel', () => {
    const result = matchRoute('/session/s18/tasks/t1/cancel', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/task_cancel');
    const params = result!.mapping.extractParams(
      result!.segments,
      { kind: 'shell' },
      'POST',
    );
    expect(params).toEqual({ sessionId: 's18', taskId: 't1', kind: 'shell' });
  });

  it('POST /session/:id/goal/clear maps to session/goal_clear', () => {
    const result = matchRoute('/session/s19/goal/clear', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/goal_clear');
  });

  it('GET /session/:id/stats maps to session/stats', () => {
    const result = matchRoute('/session/s20/stats', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/stats');
  });

  it('GET /session/:id/rewind/snapshots maps to session/rewind_snapshots', () => {
    const result = matchRoute('/session/s21/rewind/snapshots', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/rewind_snapshots');
  });

  it('POST /session/:id/rewind maps to session/rewind', () => {
    const result = matchRoute('/session/s22/rewind', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/rewind');
    const params = result!.mapping.extractParams(
      result!.segments,
      { promptId: 'p1' },
      'POST',
    );
    expect(params).toEqual({ sessionId: 's22', promptId: 'p1' });
  });

  it('POST /session/:id/language maps to session/language', () => {
    const result = matchRoute('/session/s23/language', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/language');
  });

  // ---- File system routes -----------------------------------------------

  it('GET /file maps to _qwen/file/read', () => {
    const result = matchRoute('/file', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/read');
  });

  it('GET /file/ (trailing slash) maps to _qwen/file/read', () => {
    const result = matchRoute('/file/', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/read');
  });

  it('GET /file/bytes maps to _qwen/file/read_bytes', () => {
    const result = matchRoute('/file/bytes', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/read_bytes');
  });

  it('GET /stat maps to _qwen/file/stat', () => {
    const result = matchRoute('/stat', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/stat');
  });

  it('GET /list maps to _qwen/file/list', () => {
    const result = matchRoute('/list', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/list');
  });

  it('GET /glob maps to _qwen/file/glob', () => {
    const result = matchRoute('/glob', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/glob');
  });

  it('POST /file/write maps to _qwen/file/write', () => {
    const result = matchRoute('/file/write', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/write');
    const params = result!.mapping.extractParams(
      result!.segments,
      { path: '/a.txt', content: 'hi' },
      'POST',
    );
    expect(params).toEqual({ path: '/a.txt', content: 'hi' });
  });

  it('POST /file/edit maps to _qwen/file/edit', () => {
    const result = matchRoute('/file/edit', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/file/edit');
    const params = result!.mapping.extractParams(
      result!.segments,
      { path: '/b.txt', oldText: 'a', newText: 'b' },
      'POST',
    );
    expect(params).toEqual({ path: '/b.txt', oldText: 'a', newText: 'b' });
  });

  // ---- Bulk session operations -------------------------------------------

  it('POST /sessions/delete maps to _qwen/sessions/delete', () => {
    const result = matchRoute('/sessions/delete', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/sessions/delete');
    const params = result!.mapping.extractParams(
      result!.segments,
      { sessionIds: ['a', 'b'] },
      'POST',
    );
    expect(params).toEqual({ sessionIds: ['a', 'b'] });
  });

  // ---- Unknown/unmatched routes ---------------------------------------

  it('returns null for unknown path', () => {
    expect(matchRoute('/unknown/path', 'GET')).toBeNull();
  });

  it('returns null for wrong HTTP method on known path', () => {
    // /session is POST-only
    expect(matchRoute('/session', 'GET')).toBeNull();
    // /capabilities is GET-only
    expect(matchRoute('/capabilities', 'POST')).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(matchRoute('', 'GET')).toBeNull();
  });

  // ---- URL-encoded path segments --------------------------------------

  it('decodes URL-encoded sessionId from path', () => {
    const result = matchRoute('/session/has%20space/prompt', 'POST');
    expect(result).not.toBeNull();
    expect(result!.segments[0]).toBe('has space');
  });
});
