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

  // ---- POST /session/:id/model → session/set_model --------------------

  it('POST /session/:id/model maps to session/set_model', () => {
    const result = matchRoute('/session/s7/model', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/set_model');
  });

  // ---- Vendor session extensions (_qwen/ prefix) ----------------------

  it('PATCH /session/:id/metadata maps to _qwen/session/update_metadata', () => {
    const result = matchRoute('/session/s6/metadata', 'PATCH');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/update_metadata');
  });

  it('POST /session/:id/heartbeat maps to _qwen/session/heartbeat', () => {
    const result = matchRoute('/session/s8/heartbeat', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/heartbeat');
  });

  it('POST /session/:id/recap maps to _qwen/session/recap', () => {
    const result = matchRoute('/session/s9/recap', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/recap');
  });

  it('POST /session/:id/btw maps to _qwen/session/btw', () => {
    const result = matchRoute('/session/s10/btw', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/btw');
  });

  it('POST /session/:id/shell maps to _qwen/session/shell', () => {
    const result = matchRoute('/session/s11/shell', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/shell');
  });

  it('POST /session/:id/branch maps to session/fork', () => {
    const result = matchRoute('/session/s13/branch', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('session/fork');
  });

  it('POST /session/:id/detach maps to _qwen/session/detach', () => {
    const result = matchRoute('/session/s14/detach', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/detach');
  });

  // ---- Session diagnostic routes (_qwen/ prefix) ----------------------

  it('GET /session/:id/context maps to _qwen/session/context', () => {
    const result = matchRoute('/session/s14/context', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/context');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ sessionId: 's14' });
  });

  it('GET /session/:id/context-usage maps to _qwen/session/context_usage', () => {
    const result = matchRoute('/session/s15/context-usage', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/context_usage');
  });

  it('GET /session/:id/supported-commands maps to _qwen/session/supported_commands', () => {
    const result = matchRoute('/session/s16/supported-commands', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/supported_commands');
  });

  it('GET /session/:id/tasks maps to _qwen/session/tasks', () => {
    const result = matchRoute('/session/s17/tasks', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/session/tasks');
  });

  // ---- Granular workspace routes ----------------------------------------

  it('GET /workspace/mcp maps to _qwen/workspace/mcp', () => {
    const result = matchRoute('/workspace/mcp', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/mcp');
  });

  it('GET /workspace/skills maps to _qwen/workspace/skills', () => {
    const result = matchRoute('/workspace/skills', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/skills');
  });

  it('GET /workspace/providers maps to _qwen/workspace/providers', () => {
    const result = matchRoute('/workspace/providers', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/providers');
  });

  it('GET /workspace/env maps to _qwen/workspace/env', () => {
    const result = matchRoute('/workspace/env', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/env');
  });

  it('GET /workspace/preflight maps to _qwen/workspace/preflight', () => {
    const result = matchRoute('/workspace/preflight', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/preflight');
  });

  it('POST /workspace/init maps to _qwen/workspace/init', () => {
    const result = matchRoute('/workspace/init', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/init');
  });

  it('GET /workspace/tools maps to _qwen/workspace/tools', () => {
    const result = matchRoute('/workspace/tools', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/tools');
  });

  it('GET /workspace/memory maps to _qwen/workspace/memory', () => {
    const result = matchRoute('/workspace/memory', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/memory');
  });

  it('POST /workspace/memory maps to _qwen/workspace/memory/write', () => {
    const result = matchRoute('/workspace/memory', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/memory/write');
    const params = result!.mapping.extractParams(
      result!.segments,
      { content: 'hi' },
      'POST',
    );
    expect(params).toEqual({ content: 'hi' });
  });

  it('GET /workspace/agents maps to _qwen/workspace/agents/list', () => {
    const result = matchRoute('/workspace/agents', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/agents/list');
  });

  it('POST /workspace/agents maps to _qwen/workspace/agents/create', () => {
    const result = matchRoute('/workspace/agents', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/agents/create');
  });

  it('GET /workspace/agents/:agentType maps to _qwen/workspace/agents/get', () => {
    const result = matchRoute('/workspace/agents/coder', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/agents/get');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ agentType: 'coder' });
  });

  it('DELETE /workspace/agents/:agentType maps to _qwen/workspace/agents/delete', () => {
    const result = matchRoute('/workspace/agents/coder', 'DELETE');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/agents/delete');
    const params = result!.mapping.extractParams(
      result!.segments,
      { scope: 'workspace' },
      'DELETE',
    );
    expect(params).toEqual({ agentType: 'coder', scope: 'workspace' });
  });

  it('GET /workspace/mcp/:server/tools maps to _qwen/workspace/mcp/tools', () => {
    const result = matchRoute('/workspace/mcp/fs/tools', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/mcp/tools');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ serverName: 'fs' });
  });

  it('POST /workspace/mcp/servers maps to _qwen/workspace/mcp/servers/add', () => {
    const result = matchRoute('/workspace/mcp/servers', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/mcp/servers/add');
    const params = result!.mapping.extractParams(
      result!.segments,
      { name: 'test', config: {} },
      'POST',
    );
    expect(params).toEqual({ name: 'test', config: {} });
  });

  it('DELETE /workspace/mcp/servers/:name maps to _qwen/workspace/mcp/servers/remove', () => {
    const result = matchRoute('/workspace/mcp/servers/test', 'DELETE');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/mcp/servers/remove');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'DELETE',
    );
    expect(params).toEqual({ name: 'test' });
  });

  it('POST /workspace/set-tool-enabled maps to _qwen/workspace/set_tool_enabled', () => {
    const result = matchRoute('/workspace/set-tool-enabled', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/set_tool_enabled');
  });

  it('POST /workspace/mcp/:server/restart maps to _qwen/workspace/restart_mcp_server', () => {
    const result = matchRoute('/workspace/mcp/fs/restart', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/restart_mcp_server');
    const params = result!.mapping.extractParams(
      result!.segments,
      { entryIndex: 0 },
      'POST',
    );
    expect(params).toEqual({ serverName: 'fs', entryIndex: 0 });
  });

  it('GET /workspace/auth/status maps to _qwen/workspace/auth/status', () => {
    const result = matchRoute('/workspace/auth/status', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/auth/status');
  });

  it('POST /workspace/auth/device-flow maps to _qwen/workspace/auth/device_flow/start', () => {
    const result = matchRoute('/workspace/auth/device-flow', 'POST');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe(
      '_qwen/workspace/auth/device_flow/start',
    );
  });

  it('GET /workspace/auth/device-flow/:id maps to _qwen/workspace/auth/device_flow/get', () => {
    const result = matchRoute('/workspace/auth/device-flow/flow-1', 'GET');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe('_qwen/workspace/auth/device_flow/get');
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'GET',
    );
    expect(params).toEqual({ id: 'flow-1' });
  });

  it('DELETE /workspace/auth/device-flow/:id maps to _qwen/workspace/auth/device_flow/cancel', () => {
    const result = matchRoute('/workspace/auth/device-flow/flow-1', 'DELETE');
    expect(result).not.toBeNull();
    expect(result!.mapping.method).toBe(
      '_qwen/workspace/auth/device_flow/cancel',
    );
    const params = result!.mapping.extractParams(
      result!.segments,
      undefined,
      'DELETE',
    );
    expect(params).toEqual({ id: 'flow-1' });
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

  // ---- Removed routes (no dispatcher handler) ----------------------------

  it('returns null for removed route /session/:id/approval-mode', () => {
    expect(matchRoute('/session/s12/approval-mode', 'POST')).toBeNull();
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
