/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProjectMcpJsonCache,
  loadProjectMcpJson,
  writeProjectMcpJson,
} from './projectMcpJson.js';

describe('project MCP configuration', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'project-mcp-vpc-'));
  });

  afterEach(() => {
    clearProjectMcpJsonCache();
    rmSync(directory, { recursive: true, force: true });
  });

  it('caches raw server configuration until invalidated', () => {
    const ordinary = { command: 'node', args: ['server.js'] };
    const invalid = {
      url: 'https://provider.example/mcp',
      description: 'reject',
    };
    writeFileSync(
      join(directory, '.mcp.json'),
      JSON.stringify({ mcpServers: { ordinary, invalid } }),
    );
    expect(loadProjectMcpJson(directory)).toEqual({ ordinary, invalid });
    writeFileSync(
      join(directory, '.mcp.json'),
      JSON.stringify({ mcpServers: { ordinary } }),
    );
    expect(loadProjectMcpJson(directory)).toEqual({ ordinary, invalid });
    clearProjectMcpJsonCache();
    expect(loadProjectMcpJson(directory)).toEqual({ ordinary });
  });

  it('keeps raw and product views independent and invalidates both on writes', () => {
    const ordinary = { command: 'node' };
    const invalid = {
      url: 'https://provider.example/mcp',
      description: 'reject',
    };
    writeProjectMcpJson(directory, { ordinary, invalid });
    const validator = {
      validateServerConfig(config: { description?: string }) {
        if (config.description === 'reject')
          throw new Error('invalid product endpoint');
      },
    };
    expect(loadProjectMcpJson(directory)).toEqual({ ordinary, invalid });
    expect(loadProjectMcpJson(directory, validator)).toEqual({ ordinary });
    expect(loadProjectMcpJson(directory)).toHaveProperty('invalid');
    writeProjectMcpJson(directory, { invalid });
    expect(loadProjectMcpJson(directory, validator)).toEqual({});
    expect(loadProjectMcpJson(directory)).toEqual({ invalid });
  });

  it('does not let one product policy replace another policy or its cached result', () => {
    writeProjectMcpJson(directory, { server: { command: 'node' } });
    const reject = {
      validateServerConfig() {
        throw new Error('rejected');
      },
    };
    const accept = { validateServerConfig() {} };
    expect(loadProjectMcpJson(directory, reject)).toEqual({});
    expect(loadProjectMcpJson(directory, accept)).toHaveProperty('server');
    expect(loadProjectMcpJson(directory, reject)).toEqual({});
    expect(loadProjectMcpJson(directory)).toHaveProperty('server');
  });


});
