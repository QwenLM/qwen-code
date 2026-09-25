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

  it('returns a fresh empty result when .mcp.json is absent', () => {
    const first = loadProjectMcpServers(dir);
    first.servers['stale'] = { command: 'node' };
    first.errors.push('stale error');

    const second = loadProjectMcpServers(dir);
    expect(second.servers).toEqual({});
    expect(second.errors).toEqual([]);
    expect(second).not.toBe(first);
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

  describe('env-var expansion (#11499)', () => {
    const savedToken = process.env['MY_MCP_TOKEN'];
    const savedHostName = process.env['HOST_NAME'];
    const savedHome = process.env['QWEN_HOME'];
    let homeDir: string;

    beforeEach(() => {
      process.env['MY_MCP_TOKEN'] = 'tok-from-process-env';
      process.env['HOST_NAME'] = 'example.test';
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjson-home-'));
      process.env['QWEN_HOME'] = homeDir;
    });

    afterEach(() => {
      for (const [key, saved] of [
        ['MY_MCP_TOKEN', savedToken],
        ['HOST_NAME', savedHostName],
        ['QWEN_HOME', savedHome],
      ] as const) {
        if (saved === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved;
        }
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it('resolves $VAR and ${VAR} in headers, env, url and command/args', () => {
      write(
        JSON.stringify({
          mcpServers: {
            http: {
              httpUrl: 'https://${HOST_NAME}/mcp',
              headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
            },
            stdio: {
              command: 'node',
              args: ['--flag', '$MY_MCP_TOKEN'],
              env: { TOKEN: '$MY_MCP_TOKEN' },
            },
          },
        }),
      );
      const { servers, errors } = loadProjectMcpServers(dir);
      expect(errors).toEqual([]);
      expect(servers['http']).toMatchObject({
        httpUrl: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer tok-from-process-env' },
        scope: 'project',
      });
      expect(servers['stdio']).toMatchObject({
        command: 'node',
        args: ['--flag', 'tok-from-process-env'],
        env: { TOKEN: 'tok-from-process-env' },
      });
    });
    it('falls back to the home ~/.qwen/.env for vars not in process.env', () => {
      delete process.env['MY_MCP_TOKEN'];
      fs.writeFileSync(
        path.join(homeDir, '.env'),
        'MY_MCP_TOKEN=tok-from-home-env\n',
      );
      write(
        JSON.stringify({
          mcpServers: {
            http: {
              httpUrl: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
            },
          },
        }),
      );
      const { servers, errors } = loadProjectMcpServers(dir);
      expect(errors).toEqual([]);
      expect(servers['http']).toMatchObject({
        headers: { Authorization: 'Bearer tok-from-home-env' },
      });
    });

    it('keeps an unresolved placeholder literal rather than erroring', () => {
      delete process.env['MY_MCP_TOKEN'];
      write(
        JSON.stringify({
          mcpServers: {
            http: {
              httpUrl: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
            },
          },
        }),
      );
      const { servers, errors } = loadProjectMcpServers(dir);
      expect(errors).toEqual([]);
      expect(servers['http']).toMatchObject({
        headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
      });
    });

    it('reports the pre-expansion literal configs alongside the resolved ones', () => {
      write(
        JSON.stringify({
          mcpServers: {
            http: {
              httpUrl: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
            },
          },
        }),
      );
      const { servers, literalServers } = loadProjectMcpServers(dir);
      expect(servers['http']).toMatchObject({
        headers: { Authorization: 'Bearer tok-from-process-env' },
      });
      expect(literalServers['http']).toMatchObject({
        httpUrl: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
        scope: 'project',
      });
    });

    it('expands after Claude transport normalization (httpUrl carries the placeholder)', () => {
      write(
        JSON.stringify({
          mcpServers: {
            claudeHttp: {
              type: 'http',
              url: 'https://example.test/${MY_MCP_TOKEN}/mcp',
            },
          },
        }),
      );
      const { servers, errors } = loadProjectMcpServers(dir);
      expect(errors).toEqual([]);
      expect(servers['claudeHttp']).toMatchObject({
        httpUrl: 'https://example.test/tok-from-process-env/mcp',
        scope: 'project',
      });
    });
  });
});
