/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectMcpServers, PROJECT_MCP_FILENAME } from './mcpJson.js';

describe('loadProjectMcpServers', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjson-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string) =>
    fs.writeFileSync(path.join(dir, PROJECT_MCP_FILENAME), content);

  it('returns empty (no error) when .mcp.json is absent', () => {
    const result = loadProjectMcpServers(dir);
    expect(result.servers).toEqual({});
    expect(result.path).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('loads servers and tags each with scope: project', () => {
    write(
      JSON.stringify({
        mcpServers: {
          slack: { command: 'node', args: ['slack.js'] },
          remote: { httpUrl: 'https://example.test/mcp' },
        },
      }),
    );
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(errors).toEqual([]);
    expect(servers['slack']).toMatchObject({
      command: 'node',
      args: ['slack.js'],
      scope: 'project',
    });
    expect(servers['remote']).toMatchObject({
      httpUrl: 'https://example.test/mcp',
      scope: 'project',
    });
  });

  it('tolerates JSON comments (strip-json-comments)', () => {
    write(`{
      // a project server
      "mcpServers": { "a": { "command": "x" } }
    }`);
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(errors).toEqual([]);
    expect(servers['a']).toMatchObject({ command: 'x', scope: 'project' });
  });

  it('reports malformed JSON without throwing, and loads nothing', () => {
    write('{ not valid json');
    const result = loadProjectMcpServers(dir);
    expect(result.servers).toEqual({});
    expect(result.path).toContain(PROJECT_MCP_FILENAME);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse');
  });

  it('reports a missing mcpServers object', () => {
    write(JSON.stringify({ somethingElse: true }));
    const result = loadProjectMcpServers(dir);
    expect(result.servers).toEqual({});
    expect(result.errors[0]).toContain('no "mcpServers" object');
  });

  it('skips non-object server entries but keeps the valid ones', () => {
    write(
      JSON.stringify({
        mcpServers: {
          good: { command: 'ok' },
          bad: 'not-an-object',
          alsoBad: [1, 2, 3],
        },
      }),
    );
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(Object.keys(servers)).toEqual(['good']);
    expect(servers['good']).toMatchObject({ command: 'ok', scope: 'project' });
    expect(errors).toHaveLength(2);
  });
});
