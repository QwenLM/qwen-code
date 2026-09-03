import { describe, expect, it, vi } from 'vitest';
import { LocalDirectoryError } from './local-directory.js';
import {
  LOCAL_FILES_PROTOCOL_VERSION,
  LOCAL_FILES_SERVER_NAME,
  LocalFilesMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LocalFilesFs,
} from './mcp-server.js';

function fakeFs(overrides: Partial<LocalFilesFs> = {}): LocalFilesFs {
  return {
    name: 'ai_coding',
    list: async () => ({ entries: [], truncated: false, limit: 500 }),
    read: async (path) => ({
      path,
      content: 'body',
      totalLines: 1,
      returnedLines: 1,
      truncated: false,
    }),
    write: async (path, content) => ({
      path,
      bytes: content.length,
      created: true,
    }),
    search: async (pattern) => ({
      pattern,
      hits: [],
      filesScanned: 0,
      bytesScanned: 0,
      filesSkipped: 0,
      truncated: false,
      truncatedBy: null,
    }),
    ...overrides,
  };
}

async function call(
  fs: LocalFilesFs,
  method: string,
  params?: unknown,
  id: number | string = 1,
): Promise<JsonRpcResponse | undefined> {
  const message: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
  return new LocalFilesMcpServer(fs).handle(message);
}

function resultText(response: JsonRpcResponse | undefined): string {
  const result = response?.result as { content?: Array<{ text?: string }> };
  return result.content?.[0]?.text ?? '';
}

function isErrorResult(response: JsonRpcResponse | undefined): boolean {
  return (response?.result as { isError?: boolean })?.isError === true;
}

describe('initialize', () => {
  it('echoes the protocol version the client asked for', async () => {
    const response = await call(fakeFs(), 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'qwen', version: '1' },
    });
    const result = response?.result as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } });
    expect(result['serverInfo']).toEqual({
      name: LOCAL_FILES_SERVER_NAME,
      version: '1.0.0',
    });
  });

  it('falls back to a stated protocol version when the client omits one', async () => {
    const response = await call(fakeFs(), 'initialize', {});
    const result = response?.result as Record<string, unknown>;
    expect(result['protocolVersion']).toBe(LOCAL_FILES_PROTOCOL_VERSION);
  });

  it('names the granted directory so the model knows whose machine this is', async () => {
    const response = await call(fakeFs(), 'initialize', {});
    const result = response?.result as { instructions?: string };
    expect(result.instructions).toContain('ai_coding');
    expect(result.instructions).toMatch(/user's own machine/i);
  });

  it('is idempotent — one registration drives more than one handshake', async () => {
    const server = new LocalFilesMcpServer(fakeFs());
    const first = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const second = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    });
    expect(first?.result).toEqual(second?.result);
    expect(second?.id).toBe(2);
  });
});

describe('notifications and probes', () => {
  it('never replies to a notification', async () => {
    const response = await new LocalFilesMcpServer(fakeFs()).handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeUndefined();
  });

  it('answers the discovery probes the daemon sends even though we serve none', async () => {
    expect((await call(fakeFs(), 'prompts/list'))?.result).toEqual({
      prompts: [],
    });
    expect((await call(fakeFs(), 'resources/list'))?.result).toEqual({
      resources: [],
    });
    expect((await call(fakeFs(), 'resources/templates/list'))?.result).toEqual({
      resourceTemplates: [],
    });
    expect((await call(fakeFs(), 'ping'))?.result).toEqual({});
  });

  it('maps an unknown method to -32601, not an internal error', async () => {
    const response = await call(fakeFs(), 'tools/destroy');
    expect(response?.error?.code).toBe(-32601);
    expect(response?.result).toBeUndefined();
  });
});

describe('tools/list', () => {
  it('advertises the four v1 tools with the granted directory in every description', async () => {
    const response = await call(fakeFs(), 'tools/list');
    const tools = (
      response?.result as { tools: Array<Record<string, unknown>> }
    ).tools;
    expect(tools.map((tool) => tool['name'])).toEqual([
      'list_directory',
      'read_file',
      'write_file',
      'search_files',
    ]);
    for (const tool of tools) {
      expect(String(tool['description'])).toContain('ai_coding');
      expect(String(tool['description'])).toMatch(/USER'S OWN MACHINE/);
      expect(tool['inputSchema']).toBeTypeOf('object');
    }
  });

  it('marks the required arguments', async () => {
    const response = await call(fakeFs(), 'tools/list');
    const tools = (
      response?.result as { tools: Array<Record<string, unknown>> }
    ).tools;
    const byName = new Map(tools.map((tool) => [tool['name'], tool]));
    expect(
      (byName.get('read_file')?.['inputSchema'] as { required: string[] })
        .required,
    ).toEqual(['path']);
    expect(
      (byName.get('write_file')?.['inputSchema'] as { required: string[] })
        .required,
    ).toEqual(['path', 'content']);
    expect(
      (byName.get('search_files')?.['inputSchema'] as { required: string[] })
        .required,
    ).toEqual(['pattern']);
  });
});

describe('tools/call', () => {
  it('lists a directory as readable lines', async () => {
    const fs = fakeFs({
      list: async () => ({
        entries: [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'a.ts', path: 'a.ts', kind: 'file', size: 12 },
        ],
        truncated: false,
        limit: 500,
      }),
    });
    const response = await call(fs, 'tools/call', {
      name: 'list_directory',
      arguments: { path: '' },
    });
    expect(resultText(response)).toBe('dir   src/\nfile  12  a.ts');
    expect(isErrorResult(response)).toBe(false);
  });

  it('appends a truncation note so a capped listing is not read as complete', async () => {
    const fs = fakeFs({
      list: async () => ({
        entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file', size: 1 }],
        truncated: true,
        limit: 1,
      }),
    });
    const response = await call(fs, 'tools/call', {
      name: 'list_directory',
      arguments: {},
    });
    expect(resultText(response)).toBe(
      'file  1  a.ts\n(listing stopped at 1 entries; narrow the path to see the rest)',
    );
  });

  it('reports an empty directory instead of an empty string', async () => {
    const response = await call(fakeFs(), 'tools/call', {
      name: 'list_directory',
      arguments: {},
    });
    expect(resultText(response)).toBe('(empty directory)');
  });

  it('reads a file and passes offset and limit through', async () => {
    const read = vi.fn(async () => ({
      path: 'a.ts',
      content: 'line',
      totalLines: 9,
      returnedLines: 1,
      truncated: true,
    }));
    const response = await call(fakeFs({ read }), 'tools/call', {
      name: 'read_file',
      arguments: { path: 'a.ts', offset: 3, limit: 1 },
    });
    expect(read).toHaveBeenCalledWith('a.ts', 3, 1);
    expect(resultText(response)).toContain('line');
    expect(resultText(response)).toMatch(/1 of 9 lines/);
  });

  it('writes a file and says whose machine it landed on', async () => {
    const response = await call(fakeFs(), 'tools/call', {
      name: 'write_file',
      arguments: { path: 'out.txt', content: 'hi' },
    });
    expect(resultText(response)).toBe(
      "Created out.txt (2 bytes) on the user's machine.",
    );
  });

  it('searches and reports the scan budget it spent', async () => {
    const fs = fakeFs({
      search: async () => ({
        pattern: 'needle',
        hits: [{ path: 'a/b.ts', line: 7, text: '  const needle = 1;  ' }],
        filesScanned: 12,
        bytesScanned: 3400,
        filesSkipped: 3,
        truncated: true,
        truncatedBy: 'files',
      }),
    });
    const response = await call(fs, 'tools/call', {
      name: 'search_files',
      arguments: { pattern: 'needle', path: 'a' },
    });
    const text = resultText(response);
    expect(text).toContain('a/b.ts:7: const needle = 1;');
    expect(text).toContain('scanned 12 file(s), 3400 bytes');
    expect(text).toMatch(/stopped early: hit the files budget/);
  });

  it('names the files it skipped so "no match" cannot mean "never looked"', async () => {
    const fs = fakeFs({
      search: async () => ({
        pattern: 'needle',
        hits: [],
        filesScanned: 4,
        bytesScanned: 900,
        filesSkipped: 2,
        truncated: false,
        truncatedBy: null,
      }),
    });
    const response = await call(fs, 'tools/call', {
      name: 'search_files',
      arguments: { pattern: 'needle' },
    });
    expect(resultText(response)).toBe(
      'No match for "needle" (scanned 4 file(s), 900 bytes, skipped 2 (binary or over the read limit)).',
    );
  });

  it('says so plainly when a search found nothing', async () => {
    const response = await call(fakeFs(), 'tools/call', {
      name: 'search_files',
      arguments: { pattern: 'nothing' },
    });
    expect(resultText(response)).toMatch(/^No match for "nothing"/);
  });

  it.each([
    ['read_file without a path', { name: 'read_file', arguments: {} }],
    [
      'write_file without content',
      { name: 'write_file', arguments: { path: 'a' } },
    ],
    ['search_files without a pattern', { name: 'search_files', arguments: {} }],
    ['an unknown tool', { name: 'delete_everything', arguments: {} }],
  ])(
    'turns %s into a tool error, not a protocol error',
    async (_label, args) => {
      const response = await call(fakeFs(), 'tools/call', args);
      expect(isErrorResult(response)).toBe(true);
      expect(response?.error).toBeUndefined();
      expect(resultText(response).length).toBeGreaterThan(0);
    },
  );

  it('explains that write_file replaces the whole file when content is missing', async () => {
    const response = await call(fakeFs(), 'tools/call', {
      name: 'write_file',
      arguments: { path: 'a.ts' },
    });
    expect(resultText(response)).toMatch(/complete new content/);
  });

  it('surfaces a filesystem failure as a tool error the model can act on', async () => {
    const fs = fakeFs({
      read: async () => {
        throw new LocalDirectoryError(
          'too_large',
          'a.ts is 9000000 bytes, over the 1000000-byte read limit.',
        );
      },
    });
    const response = await call(fs, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'a.ts' },
    });
    expect(isErrorResult(response)).toBe(true);
    expect(resultText(response)).toMatch(/over the 1000000-byte read limit/);
    expect(response?.error).toBeUndefined();
  });

  it('maps an unexpected failure to a JSON-RPC internal error', async () => {
    const fs = fakeFs({
      list: async () => {
        throw new TypeError('boom');
      },
    });
    const response = await call(fs, 'tools/call', {
      name: 'list_directory',
      arguments: {},
    });
    expect(response?.error?.code).toBe(-32603);
    expect(response?.error?.message).toContain('boom');
  });

  it('passes maxFiles and maxBytes through only when the caller set them', async () => {
    const search = vi.fn(async (pattern: string) => ({
      pattern,
      hits: [],
      filesScanned: 0,
      bytesScanned: 0,
      filesSkipped: 0,
      truncated: false,
      truncatedBy: null,
    }));
    await call(fakeFs({ search }), 'tools/call', {
      name: 'search_files',
      arguments: { pattern: 'x', maxFiles: 5 },
    });
    expect(search).toHaveBeenCalledWith('x', { maxFiles: 5 });
    await call(fakeFs({ search }), 'tools/call', {
      name: 'search_files',
      arguments: { pattern: 'y' },
    });
    expect(search).toHaveBeenLastCalledWith('y', {});
  });
});
