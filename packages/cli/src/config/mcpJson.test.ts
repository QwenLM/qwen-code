/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectMcpServers, PROJECT_MCP_FILENAME } from './mcpJson.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

describe('loadProjectMcpServers', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjson-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('returns a fresh empty result when .mcp.json is absent', () => {
    const first = loadProjectMcpServers(dir);
    first.servers['stale'] = { command: 'node' };
    first.errors.push('stale error');

    const second = loadProjectMcpServers(dir);
    expect(second.servers).toEqual({});
    expect(second.errors).toEqual([]);
    expect(second).not.toBe(first);
  });

  it.each(['directory', 'dangling symlink'])(
    'reports a %s as unreadable configuration without changing it',
    (kind) => {
      const file = path.join(dir, PROJECT_MCP_FILENAME);
      if (kind === 'directory') fs.mkdirSync(file);
      else fs.symlinkSync(path.join(dir, 'absent-target'), file);
      const before = fs.lstatSync(file);
      const result = loadProjectMcpServers(dir);
      expect(result.servers).toEqual({});
      expect(result.path).toBe(file);
      expect(result.errors).toEqual([
        expect.stringContaining('Failed to read'),
      ]);
      expect(fs.lstatSync(file).ino).toBe(before.ino);
      expect(fs.readdirSync(dir)).toEqual([PROJECT_MCP_FILENAME]);
    },
  );

  it.each(['delete', 'replace'])(
    'rejects a file changed by %s while it is read',
    (operation) => {
      const file = path.join(dir, PROJECT_MCP_FILENAME);
      write('{"mcpServers":{"original":{"command":"original"}}}');
      const readFile = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        const content = readFile(...args);
        if (args[0] === file) {
          fs.unlinkSync(file);
          if (operation === 'replace') write('{"mcpServers":{}}');
        }
        return content;
      });
      const result = loadProjectMcpServers(dir);
      expect(result.servers).toEqual({});
      expect(result.path).toBe(file);
      expect(result.errors).toEqual([
        expect.stringContaining('Failed to read'),
      ]);
    },
  );

  it('reports a dangling project directory instead of absent MCP configuration', () => {
    const project = path.join(dir, 'project');
    const target = path.join(dir, 'absent-project');
    fs.symlinkSync(target, project, 'dir');

    const result = loadProjectMcpServers(project);

    expect(result.servers).toEqual({});
    expect(result.path).toBe(path.join(project, PROJECT_MCP_FILENAME));
    expect(result.errors).toEqual([expect.stringContaining('ENOENT')]);
    expect(fs.readlinkSync(project)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
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

  it('normalizes Claude-style type-based transports (.mcp.json is a Claude convention)', () => {
    write(
      JSON.stringify({
        mcpServers: {
          httpServer: { type: 'http', url: 'https://example.test/mcp' },
          sseServer: { type: 'sse', url: 'https://example.test/sse' },
          stdioServer: { type: 'stdio', command: 'node', args: ['s.js'] },
        },
      }),
    );
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(errors).toEqual([]);

    expect(servers['httpServer']).toEqual({
      httpUrl: 'https://example.test/mcp',
      scope: 'project',
    });
    expect(servers['sseServer']).toEqual({
      url: 'https://example.test/sse',
      scope: 'project',
    });
    expect(servers['stdioServer']).toEqual({
      command: 'node',
      args: ['s.js'],
      scope: 'project',
    });
  });

  it('forces .mcp.json server scope to project', () => {
    write(
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', scope: 'system' },
        },
      }),
    );
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(errors).toEqual([]);
    expect(servers['local']).toMatchObject({
      command: 'node',
      scope: 'project',
    });
  });

  it('keeps __proto__ server names visible to approval checks', () => {
    write('{"mcpServers":{"__proto__":{"command":"node"}}}');
    const { servers, errors } = loadProjectMcpServers(dir);
    expect(errors).toEqual([]);
    expect(Object.keys(servers)).toEqual(['__proto__']);
    expect(servers['__proto__']).toMatchObject({
      command: 'node',
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
    const content = '{ synthetic-configuration-secret invalid json';
    write(content);
    const result = loadProjectMcpServers(dir);
    expect(result.servers).toEqual({});
    expect(result.path).toContain(PROJECT_MCP_FILENAME);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse');
    expect(result.errors[0]).not.toContain('synthetic-configuration-secret');
    expect(fs.readFileSync(path.join(dir, PROJECT_MCP_FILENAME), 'utf8')).toBe(
      content,
    );
  });

  it('reports a missing mcpServers object', () => {
    write(JSON.stringify({ somethingElse: true }));
    const result = loadProjectMcpServers(dir);
    expect(result.servers).toEqual({});
    expect(result.errors[0]).toContain('no "mcpServers" object');
  });

  it('rejects an array mcpServers value', () => {
    write(JSON.stringify({ mcpServers: [{ command: 'node' }] }));
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
