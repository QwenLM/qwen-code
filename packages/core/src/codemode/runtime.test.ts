/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { ScriptRuntime } from './runtime.js';
import { ScriptWorkers } from './workers.js';
import {
  SCRIPT_LIMITS,
  STORE_LIMITS,
  ScriptToolError,
  type JsonObject,
  type ScriptHost,
  type ScriptNamespace,
  type ScriptStartMessage,
  type ScriptToolDescription,
  type ScriptWorkerData,
  type WorkerMessage,
} from './types.js';
import { ToolSearchIndex } from './tool-search.js';

let directory: string;
let runtime: ScriptRuntime;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'test-codemode-'));
  const outfile = join(directory, 'worker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
  });
  runtime = new ScriptRuntime(outfile);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
/** Ranks the admitted catalog the way CodeModeHost does. */
const catalogSearch = (
  catalog: readonly ScriptToolDescription[],
  tools: readonly string[],
  namespaces: readonly ScriptNamespace[] = [],
): NonNullable<ScriptHost['search']> => {
  const index = new ToolSearchIndex(
    catalog.filter((entry) => tools.includes(entry.name)),
    namespaces,
  );
  return (request) =>
    index
      .search(request.query, {
        limit: request.limit,
        namespace: request.namespace,
      })
      .map((tool) => tool.name);
};
const execute = (
  code: string,
  host: ScriptHost = { call: async () => null },
  tools: string[] = [],
  directTools: string[] = [],
  toolCatalog: ScriptToolDescription[] = [],
) =>
  runtime.execute(
    {
      code,
      tools,
      directTools,
      toolCatalog,
      signal: new AbortController().signal,
      timeoutMs: 5000,
    },
    { search: catalogSearch(toolCatalog, tools), ...host },
  );

// Original scripts from the nine benchmark failures; tool results are mocked,
// while the Worker, QuickJS bridge and session memo use production code.
const memoScripts: Array<{ name: string; code: string }> = JSON.parse(
  await readFile(
    new URL('./fixtures/memo-pending-scripts.json', import.meta.url),
    'utf8',
  ),
);

describe('isolated script runtime', () => {
  it('returns rejected promises for unserializable arguments without abandoning other calls', async () => {
    const call = vi.fn(async () => 'ok');
    const result = await execute(
      `
      const cycle = {}; cycle.self = cycle;
      const results = await Promise.allSettled([tools.Read(undefined), tools.Read({value: 1n}), tools.Read(cycle), tools.Read({})]);
      text(results.map(r => r.status));
    `,
      { call },
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['["rejected","rejected","rejected","fulfilled"]'],
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it('discards a spare worker that reports initialization failure before acquisition', async () => {
    const path = join(directory, 'failing-spare.mjs');
    await writeFile(
      path,
      `import {parentPort} from 'node:worker_threads';
      let failed = false;
      parentPort.on('message', message => {
        if (message.type === 'fail') { failed = true; parentPort.postMessage({type:'done',status:'error',errorKind:'runtime_start'}); }
        else if (message.type === 'start' && !failed) parentPort.postMessage({type:'done',status:'completed'});
      });`,
    );
    const warm = new ScriptRuntime(path, { prewarm: true });
    const run = () =>
      warm.execute(
        {
          code: '',
          tools: [],
          signal: new AbortController().signal,
          timeoutMs: 1000,
        },
        { call: async () => null },
      );
    expect((await run()).status).toBe('completed');
    const spare = Reflect.get(Reflect.get(warm, 'workers'), 'spare') as {
      worker: Worker;
    };
    const failed = once(spare.worker, 'message');
    spare.worker.postMessage({ type: 'fail' });
    await failed;
    expect((await run()).status).toBe('completed');
    const next = Reflect.get(Reflect.get(warm, 'workers'), 'spare') as {
      worker: Worker;
    };
    await next.worker.terminate();
  });

  it('exits after VM initialization fails even without a start message', async () => {
    const wasm = await WebAssembly.compile(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const worker = new Worker(join(directory, 'worker.mjs'), {
      workerData: { wasm },
      execArgv: [],
    });
    const exited = once(worker, 'exit');
    try {
      const [message] = await once(worker, 'message');
      expect(message).toMatchObject({
        type: 'done',
        status: 'error',
        errorKind: 'runtime_start',
      });
      await exited;
    } finally {
      await worker.terminate();
    }
  });
  it('prints undefined fields without changing empty script return behavior', async () => {
    const result = await execute(
      'const r = await tools.Read({}); text(r.missing); text(null); text(0); text(false); text("");',
      { call: async () => ({ content: 'read' }) },
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['undefined', 'null', '0', 'false', ''],
    });
    expect(await execute('return undefined;')).toEqual({
      status: 'completed',
      output: [],
    });
  });

  it('discovers only callable tools without executing them or allowing catalog mutation', async () => {
    const call = vi.fn(async () => null);
    const catalog = [
      {
        name: 'Read',
        description: 'Read a file: Promise<{ content: string }>',
      },
      {
        name: 'Bash',
        description: 'Run a shell command: Promise<{ output: string }>',
      },
      { name: 'Hidden', description: 'private hidden tool' },
      { name: '$private', description: 'private host helper' },
    ];
    const result = await execute(
      `
      ALL_TOOLS[0].description = 'changed';
      text([Object.isFrozen(ALL_TOOLS), Object.isFrozen(ALL_TOOLS[0])]);
      text(ALL_TOOLS.map(t => t.name));
      text(await describeTool('Read'));
      text(await describeTool('Hidden'));
      text(await searchTools('shell command', {limit: 1}));
      text(await searchTools('missing'));
      text((await searchTools('')).length);
      `,
      { call },
      ['Read', 'Bash'],
      ['TaskCreate'],
      catalog,
    );
    expect(result).toEqual({
      status: 'completed',
      output: [
        '[true,true]',
        '["Read","Bash"]',
        catalog[0].description,
        'undefined',
        JSON.stringify([catalog[1]]),
        '[]',
        '2',
      ],
    });
    expect(call).not.toHaveBeenCalled();
    const next = await execute(
      'text(ALL_TOOLS); text(await describeTool("Read"));',
    );
    expect(next.output).toEqual(['[]', 'undefined']);
  });

  it('validates discovery queries and ranks exact tool names before description matches', async () => {
    const result = await execute(
      `
      text((await searchTools('Read', {limit: 1})).map(t => t.name));
      const invalid = await Promise.allSettled([
        describeTool(null), searchTools(null), searchTools('read', null),
        searchTools('read', {limit: 0}), searchTools('read', {limit: 1.5}),
      ]);
      text(invalid.map(r => r.status));
      `,
      undefined,
      ['Grep', 'Read'],
      [],
      [
        { name: 'Grep', description: 'Read search results' },
        { name: 'Read', description: 'Read a file' },
      ],
    );
    expect(result).toEqual({
      status: 'completed',
      output: [
        '["Read"]',
        '["rejected","rejected","rejected","rejected","rejected"]',
      ],
    });
  });

  it('limits the number of host searches per script', async () => {
    const result = await execute(
      `for (let i = 0; i <= ${SCRIPT_LIMITS.searches}; i++) await searchTools('x');`,
    );
    expect(result).toMatchObject({
      status: 'limit',
      error: 'Tool search limit exceeded',
    });
  });

  describe('BM25 discovery, namespaces and images', () => {
    const catalog: ScriptToolDescription[] = [
      {
        name: 'Read',
        description: 'Read a file from disk. Reads the file path.',
      },
      {
        name: 'mcp__github__search_issues',
        description: 'Search issues in a repository',
        namespace: 'github',
      },
      {
        name: 'mcp__github__get_file',
        description: 'Get file contents of a repository file',
        namespace: 'github',
      },
      {
        name: 'mcp__dev-docs__search',
        description: 'Search documentation pages',
        namespace: 'dev-docs',
      },
      { name: 'Grep', description: '搜索代码仓库中的问题' },
      { name: 'Glob', description: '读取文件内容' },
    ];
    const namespaces = [
      {
        name: 'github',
        description: 'GitHub issues and pull requests',
        instructions: 'Use owner/repo names.',
        tools: [
          'mcp__github__search_issues',
          'mcp__github__get_file',
          'mcp__github__hidden',
        ],
      },
      { name: 'dev-docs', tools: ['mcp__dev-docs__search'] },
    ];
    const run = (code: string) =>
      runtime.execute(
        {
          code,
          tools: catalog.map((entry) => entry.name),
          toolCatalog: catalog,
          namespaces,
          signal: new AbortController().signal,
          timeoutMs: 5000,
        },
        {
          call: async () => null,
          search: catalogSearch(
            catalog,
            catalog.map((entry) => entry.name),
            namespaces,
          ),
        },
      );
    const names = 'const names = r => r.map(t => t.name);';

    it('ranks by BM25 with stemming, namespace filters and CJK bigrams', async () => {
      const result = await run(`${names}
        text(names(await searchTools('search issues', {limit: 2})));
        text(names(await searchTools('issue', {limit: 1})));
        text(names(await searchTools('pull requests', {limit: 1})));
        text(names(await searchTools('search', {namespace: 'mcp__dev_docs'})));
        text(names(await searchTools('file', {namespace: 'GitHub'})));
        text(names(await searchTools('搜索问题', {limit: 1})));
        text((await searchTools('', {limit: 3})).length);
        text(names(await searchTools('zzz')));
        text((await Promise.allSettled([searchTools('x', {namespace: 1})]))[0].status);
      `);
      expect(result.status).toBe('completed');
      expect(result.output).toEqual([
        '["mcp__github__search_issues","mcp__dev-docs__search"]',
        '["mcp__github__search_issues"]',
        // Server metadata contributes to ranking.
        '["mcp__github__search_issues"]',
        '["mcp__dev-docs__search"]',
        '["mcp__github__get_file"]',
        '["Grep"]',
        '3',
        '[]',
        'rejected',
      ]);
    });

    it('describes namespaces by any server spelling, listing only callable tools', async () => {
      const result = await run(`
        text(await describeNamespace('mcp__github'));
        text((await describeNamespace('dev_docs')).tools);
        text(await describeNamespace('missing'));
        text((await Promise.allSettled([describeNamespace(1)]))[0].status);
      `);
      expect(result.output).toEqual([
        JSON.stringify({
          name: 'github',
          description: 'GitHub issues and pull requests',
          instructions: 'Use owner/repo names.',
          tools: ['mcp__github__search_issues', 'mcp__github__get_file'],
        }),
        '["mcp__dev-docs__search"]',
        'undefined',
        'rejected',
      ]);
    });

    it('forwards valid images in order and rejects malformed ones catchably', async () => {
      const result = await run(`
        text('before');
        image({type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png'});
        image('data:image/jpg;base64,/9j/4AAQ');
        const bad = await Promise.allSettled([
          (async () => image({type: 'image', data: 'abc', mimeType: 'image/tiff'}))(),
          (async () => image({type: 'image', data: 'not base64!', mimeType: 'image/png'}))(),
          (async () => image('https://example.com/a.png'))(),
        ]);
        text(bad.map(r => r.status));
      `);
      expect(result).toEqual({
        status: 'completed',
        output: [
          'before',
          '[image 1: image/png]',
          '[image 2: image/jpeg]',
          '["rejected","rejected","rejected"]',
        ],
        images: [
          { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
        ],
      });
    });

    it('stops the script when the image count limit is exceeded', async () => {
      const result = await run(`
        for (let i = 0; i <= ${SCRIPT_LIMITS.images}; i++)
          image({type: 'image', data: 'AAAA', mimeType: 'image/png'});
      `);
      expect(result.status).toBe('limit');
      expect(result.images).toHaveLength(SCRIPT_LIMITS.images);
    });

    it('shows a local image file through the host and numbers it with inline images', async () => {
      const readImage = vi.fn(async (path: string) => {
        if (path.endsWith('.txt'))
          throw new ScriptToolError({
            kind: 'execution',
            toolName: 'Read',
            message: 'Not an image file',
          });
        return { mimeType: 'image/jpeg', data: '/9j/4AAQ' };
      });
      const result = await execute(
        `
        image({type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png'});
        text(await image({path: '/tmp/a.jpg'}));
        const failed = await Promise.allSettled([
          image({path: '/tmp/notes.txt'}),
          image({path: ''}),
          (async () => image({type: 'image', data: '/tmp/a.jpg', mimeType: 'image/jpeg'}))(),
        ]);
        text(failed.map(r => r.status === 'rejected' ? r.reason.name + ': ' + r.reason.message : r.status));
        `,
        { call: async () => null, readImage },
      );
      expect(result).toEqual({
        status: 'completed',
        output: [
          '[image 1: image/png]',
          '[image 2: image/jpeg]',
          'null',
          expect.stringContaining(
            '["ToolCallError: Not an image file","Error: image() path must be a non-empty file path","Error: image() data must be base64 without whitespace; to show a file, await image({path})"]',
          ),
        ],
        images: [
          { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
        ],
      });
      expect(readImage.mock.calls.map(([path]) => path)).toEqual([
        '/tmp/a.jpg',
        '/tmp/notes.txt',
      ]);
    });

    it.each([0, 4])(
      'shares local and inline image byte budgets at overflow=%s',
      async (overflow) => {
        const result = await execute(
          `image({type: 'image', data: 'AAAA', mimeType: 'image/png'}); await image({path: '/tmp/large.png'}); text('done');`,
          {
            call: async () => null,
            readImage: async () => ({
              mimeType: 'image/png',
              data: 'A'.repeat(SCRIPT_LIMITS.imageBytes - 4 + overflow),
            }),
          },
        );
        expect(result.status).toBe(overflow ? 'limit' : 'completed');
        expect(result.images).toHaveLength(overflow ? 1 : 2);
        if (overflow) expect(result.limitKind).toBe('images');
        else expect(result.output).toContain('done');
      },
    );

    it('bounds local image path bytes before calling the host', async () => {
      const readImage = vi.fn(async () => ({
        mimeType: 'image/png',
        data: 'AAAA',
      }));
      const result = await execute(
        `try { await image({path: 'x'.repeat(${SCRIPT_LIMITS.argumentBytes + 1})}); } catch (error) { text(error.message); }`,
        { call: async () => null, readImage },
      );
      expect(result.status).toBe('completed');
      expect(result.output).toEqual(['Image path exceeds the byte limit']);
      expect(readImage).not.toHaveBeenCalled();
    });

    it('rejects image({path}) catchably when the host cannot read files', async () => {
      const result = await execute(`
        try { await image({path: '/tmp/a.png'}); } catch (error) { text(error.message); }
      `);
      expect(result).toEqual({
        status: 'completed',
        output: ['Image files are not available to this script'],
      });
    });

    it('counts image files against the image budget', async () => {
      const result = await execute(
        `for (let i = 0; i <= ${SCRIPT_LIMITS.images}; i++) await image({path: '/tmp/' + i + '.png'});`,
        {
          call: async () => null,
          readImage: async () => ({ mimeType: 'image/png', data: 'AAAA' }),
        },
      );
      expect(result.status).toBe('limit');
      expect(result.limitKind).toBe('images');
      expect(result.images).toHaveLength(SCRIPT_LIMITS.images);
    });
  });

  it('uses direct results with Promise.all and preserves failures with Promise.allSettled', async () => {
    const result = await execute(
      `
      const [r] = await Promise.all([tools.Read({})]);
      text(r.content);
      const results = await Promise.allSettled([tools.Read({}), tools.Read({fail: true})]);
      text(results.map(r => r.status === 'fulfilled' ? r.value.content : r.reason.message));
      `,
      {
        call: async (_name, args) => {
          if (args['fail']) throw new Error('read failed');
          return { content: 'read' };
        },
      },
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['read', '["read","read failed"]'],
    });
  });

  it.each(memoScripts)(
    'completes benchmark script $name after replacing async memo with store',
    async ({ code }) => {
      const result = await execute(
        code.replace(/\bmemo\.set\(/g, 'store('),
        {
          call: async () => ({
            content: 'example\n',
            totalLines: 1,
            complete: true,
            filenames: [],
            output: 'example',
            stderr: '',
            exitCode: 0,
          }),
        },
        ['Read', 'Grep', 'Bash'],
      );
      expect(result.status).toBe('completed');
      expect(result.pendingCalls).toBeUndefined();
      expect(result.storeWrites?.length).toBeGreaterThan(0);
    },
  );

  it('copies synchronous state, distinguishes missing/null, and rejects promises and oversized state', async () => {
    const result = await execute(`
      text(typeof memo);
      text(load('missing'));
      const value = {items: [1]}; store('__proto__', value); value.items.push(2);
      const copy = load('__proto__'); copy.items.push(3); text(load('__proto__'));
      store('null', null); text(load('null')); store('deleted', 1); store('deleted', undefined);
      for (const value of [Promise.resolve(1), {x: undefined}, NaN, new Date()]) {
        try { store('bad', value); } catch (e) { text(e.message); }
      }
      try { store('large', '中'.repeat(${Math.floor(STORE_LIMITS.totalBytes / 2)})); } catch (e) { text(e.message); }
    `);
    expect(result.status).toBe('completed');
    expect(result.output.slice(0, 4)).toEqual([
      'undefined',
      'undefined',
      '{"items":[1]}',
      'null',
    ]);
    expect(
      result.output.slice(4, 8).every((item) => item.includes('JSON value')),
    ).toBe(true);
    expect(result.output[8]).toContain('size limit');
    expect(result.storeWrites).toEqual([
      { key: '__proto__', value: { items: [1] } },
      { key: 'null', value: null },
    ]);
  });

  it('preserves rejection reasons and error fields in printed and thrown diagnostics', async () => {
    const unhandled = await execute(
      'Promise.reject(new Error("rejection detail"));',
    );
    expect(unhandled).toMatchObject({
      status: 'error',
      errorKind: 'unhandled_rejection',
      error: expect.stringContaining('rejection detail'),
    });
    const handled = await execute(
      'const p = Promise.reject(new Error("handled")); await p.catch(() => {});',
    );
    expect(handled.status).toBe('completed');
    const printed = await execute(
      'try { await tools.Read({}); } catch (e) { text(e); console.error(e); text([{reason:e}]); }',
      {
        call: async () => {
          throw new ScriptToolError({
            kind: 'invalid_args',
            toolName: 'Read',
            message: 'bad path',
            callId: 'child',
          });
        },
      },
      ['Read'],
    );
    expect(JSON.parse(printed.output[0])).toEqual({
      name: 'ToolCallError',
      message: 'bad path',
      kind: 'invalid_args',
      toolName: 'Read',
      callId: 'child',
    });
    expect(printed.output[1]).toBe(printed.output[0]);
    expect(printed.output[2]).toContain('bad path');
    const unavailable = await execute('tools.Raed({});', undefined, ['Read']);
    expect(unavailable.error).toContain('Similar callable tools: Read');
  });

  it.each(['all', 'allSettled'])(
    'reports nested tool promises left pending by Promise.%s',
    async (method) => {
      const nested = await execute(
        `store("discard", true); await Promise.${method}([{p: tools.Read({})}]);`,
        {
          call: () => new Promise(() => {}),
        },
        ['Read'],
      );
      expect(nested).toMatchObject({
        status: 'incomplete',
        pendingCalls: [{ name: 'Read' }],
      });
      expect(nested).not.toHaveProperty('storeWrites');
    },
  );

  it.each([true, false])(
    'only suggests a direct tool when exposed (%s)',
    async (available) => {
      const call = vi.fn(async () => null);
      const result = await execute(
        `
      try { await tools.TaskCreate({}); }
      catch (e) { text([e.name, e.kind, e.toolName, e.message]); }
    `,
        { call },
        ['Read'],
        available ? ['TaskCreate'] : [],
      );
      expect(result.status).toBe('completed');
      expect(result.output[0]).toContain('ToolCallError');
      expect(result.output[0]).toContain('unavailable');
      expect(result.output[0]).toContain('TaskCreate');
      expect(result.output[0].includes('Call TaskCreate directly')).toBe(
        available,
      );
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('preserves tool introspection, JSON formatting and Promise assimilation', async () => {
    const result = await execute(
      `
      text([Object.keys(tools), 'Read' in tools, 'Missing' in tools, Object.isFrozen(tools)]);
      text(await Promise.resolve(tools));
      return tools;
    `,
      undefined,
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['[["Read"],true,false,true]', '{}'],
      returnValue: '{}',
    });
  });

  it('reports calls that are delivered to the worker but not acknowledged before done', async () => {
    const path = join(directory, 'done-before-ack.mjs');
    await writeFile(
      path,
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (m) => {
        if (m.type === 'start') parentPort.postMessage({type:'call',id:1,name:'Read',args:'{}'});
        else parentPort.postMessage({type:'done',status:'completed'});
      });
    `,
    );
    const value = { content: 'read' };
    const host = { call: async () => value, discardResult: vi.fn() };
    const result = await new ScriptRuntime(path).execute(
      {
        code: '',
        tools: ['Read'],
        signal: new AbortController().signal,
        timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
      },
      host,
    );
    expect(result).toMatchObject({
      status: 'incomplete',
      pendingCalls: [{ id: 1, name: 'Read', phase: 'awaiting_delivery' }],
    });
    expect(host.discardResult).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('retains worker-side pending IDs when a rejected result is in transit', async () => {
    const path = join(directory, 'pending-rejection.mjs');
    await writeFile(
      path,
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (m) => {
        if (m.type === 'start') parentPort.postMessage({type:'call',id:1,name:'Read',args:'{}'});
        else parentPort.postMessage({type:'done',status:'incomplete',pendingCallIds:[1]});
      });
    `,
    );
    const result = await new ScriptRuntime(path).execute(
      {
        code: '',
        tools: ['Read'],
        signal: new AbortController().signal,
        timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
      },
      {
        call: async () => {
          throw new Error('invalid value');
        },
      },
    );
    expect(result).toMatchObject({
      status: 'incomplete',
      pendingCalls: [{ id: 1, name: 'Read', phase: 'awaiting_delivery' }],
    });
  });

  it.each(['', 'await tools.Grep({pattern: "before"});\n'])(
    'reports the submitted source location for invalid object keys after %j without executing any calls',
    async (prefix) => {
      const call = vi.fn(async () => null);
      const invalid = 'await tools.Grep({pattern: "x", -n:true});';
      const result = await execute(prefix + invalid, { call }, ['Grep']);
      expect(result.status).toBe('error');
      expect(result.output).toEqual([]);
      expect(result.error).toContain('SyntaxError: invalid property name');
      expect(result.error).toMatch(
        new RegExp(`at code:${prefix ? 2 : 1}:\\d+\\n`),
      );
      expect(result.error).toContain(invalid);
      expect(result.error).not.toContain('worker.mjs');
      expect(call).not.toHaveBeenCalled();
    },
  );
  it('passes quoted Grep flags unchanged through the real VM', async () => {
    const call = vi.fn(async () => ({ content: 'file.java:1:match' }));
    const result = await execute(
      'text(await tools.Grep({pattern: "match", "-n": true, "-A": 2}));',
      { call },
      ['Grep'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['{"content":"file.java:1:match"}'],
    });
    expect(call).toHaveBeenCalledExactlyOnceWith('Grep', {
      pattern: 'match',
      '-n': true,
      '-A': 2,
    });
  });
  it('discards results that arrive after execution has already stopped', async () => {
    let release!: (value: { value: string }) => void;
    const host = {
      call: () =>
        new Promise<{ value: string }>((resolve) => {
          release = resolve;
        }),
      discardResult: vi.fn(),
    };
    expect((await execute('tools.Read({});', host, ['Read'])).status).toBe(
      'incomplete',
    );
    const value = { value: 'unseen' };
    release(value);
    await vi.waitFor(() =>
      expect(host.discardResult).toHaveBeenCalledWith(value),
    );
  });
  it('discards in-flight results unless the worker acknowledges delivery', async () => {
    const path = join(directory, 'no-ack-worker.mjs');
    await writeFile(
      path,
      `import { parentPort } from 'node:worker_threads'; parentPort.postMessage({type:'call',id:1,name:'Read',args:'{}'}); parentPort.on('message', () => {});`,
    );
    const value = { value: 'unseen' };
    const host = { call: async () => value, discardResult: vi.fn() };
    const result = await new ScriptRuntime(path).execute(
      {
        code: '',
        tools: ['Read'],
        signal: new AbortController().signal,
        timeoutMs: 250,
      },
      host,
    );
    expect(result.status).toBe('timeout');
    expect(host.discardResult).toHaveBeenCalledExactlyOnceWith(value);
  });
  it('does not discard results acknowledged by the real VM', async () => {
    const host = {
      call: async () => ({ value: 'seen' }),
      discardResult: vi.fn(),
    };
    expect(
      (await execute('await tools.Read({});', host, ['Read'])).status,
    ).toBe('completed');
    expect(host.discardResult).not.toHaveBeenCalled();
  });
  it('rejects duplicate worker calls without executing a tool twice', async () => {
    const path = join(directory, 'invalid-worker.mjs');
    await writeFile(
      path,
      `import { parentPort } from 'node:worker_threads'; const call = {type:'call',id:1,name:'Read',args:'{}'}; parentPort.postMessage(call); parentPort.postMessage(call);`,
    );
    const call = vi.fn(() => new Promise<null>(() => {}));
    const result = await new ScriptRuntime(path).execute(
      {
        code: '',
        tools: ['Read'],
        signal: new AbortController().signal,
        timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
      },
      { call },
    );
    expect(result).toMatchObject({
      status: 'error',
      error: 'Invalid or duplicate worker message',
    });
    expect(call).toHaveBeenCalledOnce();
  });
  it('ignores tool calls after the worker reports completion', async () => {
    const path = join(directory, 'late-worker.mjs');
    await writeFile(
      path,
      `import { parentPort } from 'node:worker_threads'; parentPort.postMessage({type:'done',status:'completed'}); parentPort.postMessage({type:'call',id:1,name:'Read',args:'{}'});`,
    );
    const call = vi.fn(async () => null);
    expect(
      (
        await new ScriptRuntime(path).execute(
          {
            code: '',
            tools: ['Read'],
            signal: new AbortController().signal,
            timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
          },
          { call },
        )
      ).status,
    ).toBe('completed');
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps eval and Function isolated and rejects module loading', async () => {
    const result = await execute(
      `text(eval('typeof process')); text(Function('return typeof require')()); try { await import('node:fs'); } catch { text('blocked'); }`,
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['undefined', 'undefined', 'blocked'],
    });
  });
  it('enforces argument and result byte limits before forwarding values', async () => {
    const call = vi.fn(async () => 'x'.repeat(SCRIPT_LIMITS.resultBytes));
    const args = await execute(
      `try { await tools.Read({ value: 'x'.repeat(${SCRIPT_LIMITS.argumentBytes}) }); } catch (e) { text(e.message); }`,
      { call },
      ['Read'],
    );
    expect(args.output[0]).toMatch(/arguments.*byte limit/);
    expect(call).not.toHaveBeenCalled();
    const result = await execute(
      `try { await tools.Read({}); } catch (e) { text(e.message); }`,
      { call },
      ['Read'],
    );
    expect(result.output[0]).toMatch(/result.*byte limit/);
    expect(result.status).toBe('completed');
  });
  it('counts oversized results toward the cumulative hard limit even when caught', async () => {
    const call = vi.fn(async () => 'x'.repeat(SCRIPT_LIMITS.resultBytes));
    const result = await execute(
      'for (let i = 0; i < 12; i++) { try { await tools.Read({}); } catch {} }',
      { call },
      ['Read'],
    );
    expect(result.status).toBe('limit');
    expect(call.mock.calls.length).toBeLessThan(12);
  });
  it('isolates memory exhaustion from the host', async () => {
    expect(
      (
        await execute(
          'const buffers = []; while (true) buffers.push(new ArrayBuffer(8 * 1024 * 1024));',
        )
      ).status,
    ).toBe('error');
    expect((await execute('return 1')).returnValue).toBe('1');
  });
  it('hints at template literal escaping only for syntax errors in code that uses them', async () => {
    const withTemplate = await execute('const s = `a ${ b`; text(s);');
    expect(withTemplate).toMatchObject({
      status: 'error',
      errorKind: 'syntax',
    });
    expect(withTemplate.error).toContain('escape embedded backticks');
    const plain = await execute('const = 1;');
    expect(plain).toMatchObject({ status: 'error', errorKind: 'syntax' });
    expect(plain.error).not.toContain('escape embedded backticks');
  });

  it('supports async bodies, text, console and return without host globals', async () => {
    expect(
      await execute(`
      text([typeof process, typeof require, typeof fetch, typeof setTimeout]);
      console.log('hello', { n: 2 });
      return await Promise.resolve(42);
    `),
    ).toEqual({
      status: 'completed',
      output: [
        '["undefined","undefined","undefined","undefined"]',
        'hello {"n":2}',
      ],
      returnValue: '42',
    });
  });
  it('passes JSON and preserves tool names including prototype names', async () => {
    const call = vi.fn(async (_name, args) => ({ result: args }));
    const result = await execute(
      `
      const values = await Promise.all([
        tools['x.y']({ a: 1 }), tools['__proto__']({ b: 2 })
      ]);
      text(values);
    `,
      { call },
      ['x.y', '__proto__'],
    );
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output[0])).toEqual([
      { result: { a: 1 } },
      { result: { b: 2 } },
    ]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('returns bounded catchable tool errors', async () => {
    const result = await execute(
      `try { await tools.Read({}); } catch (e) { text([e.name, e.kind, e.callId]); }`,
      {
        call: async () => {
          throw new ScriptToolError({
            kind: 'denied',
            toolName: 'Read',
            callId: 'child1',
            message: 'denied',
          });
        },
      },
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['["ToolCallError","denied","child1"]'],
    });
  });
  it('allows nested calls during JSON argument serialization', async () => {
    const call = vi.fn(async (_name, args) => args);
    const result = await execute(
      `
      let inner;
      const outer = tools.Read({ toJSON() {
        inner = tools.Read({ value: 'inner' });
        return { value: 'outer' };
      } });
      text(await Promise.all([outer, inner]));
      `,
      { call },
      ['Read'],
    );
    expect(result).toEqual({
      status: 'completed',
      output: ['[{"value":"outer"},{"value":"inner"}]'],
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('detects both abandoned calls and stalled promises', async () => {
    const call = vi.fn(() => new Promise<null>(() => {}));
    expect(
      (await execute('tools.Read({}); return 1;', { call }, ['Read'])).status,
    ).toBe('incomplete');
    expect(call).toHaveBeenCalledOnce();
    expect((await execute('await new Promise(() => {});')).status).toBe(
      'incomplete',
    );
  });
  it('reports unhandled rejections but permits handled errors', async () => {
    expect((await execute('Promise.reject(new Error("lost"));')).error).toMatch(
      /Unhandled/,
    );
    expect(
      (await execute('await Promise.reject(1).catch(() => {});')).status,
    ).toBe('completed');
  });
  it.each(['while (true) {}', 'while (true) { await Promise.resolve(); }'])(
    'interrupts %s',
    async (code) => {
      const result = await runtime.execute(
        {
          code,
          tools: [],
          signal: new AbortController().signal,
          timeoutMs: 250,
        },
        { call: async () => null },
      );
      expect(result.status).toBe('timeout');
      expect((await execute('return 7;')).status).toBe('completed');
    },
  );
  // Bun cannot terminate a worker spinning in WASM, so the shared flag alone must stop the VM.
  it.each([
    'while (true) {}',
    'while (true) await null;',
    'const f = () => Promise.resolve().then(f); f(); await new Promise(() => {});',
  ])('stops %s through the interrupt flag without terminate', async (code) => {
    const wasm = await WebAssembly.compile(
      new Uint8Array(
        await readFile(
          createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'),
        ),
      ),
    );
    const worker = new Worker(join(directory, 'worker.mjs'), {
      workerData: { wasm } satisfies ScriptWorkerData,
      execArgv: [],
    });
    try {
      const interrupt = new SharedArrayBuffer(4);
      const done = new Promise<WorkerMessage>((resolve) =>
        worker.on('message', (message: WorkerMessage) => {
          if (message.type === 'done') resolve(message);
        }),
      );
      worker.postMessage({
        type: 'start',
        code,
        tools: [],
        interrupt,
      } satisfies ScriptStartMessage);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const raised = performance.now();
      Atomics.store(new Int32Array(interrupt), 0, 1);
      expect((await done).type).toBe('done');
      expect(performance.now() - raised).toBeLessThan(1000);
    } finally {
      await worker.terminate();
    }
  });
  it('cancels a spinning VM from the host', async () => {
    const controller = new AbortController();
    const result = runtime.execute(
      {
        code: 'while (true) {}',
        tools: [],
        signal: controller.signal,
        timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
      },
      { call: async () => null },
    );
    setTimeout(() => controller.abort(), 100);
    expect((await result).status).toBe('cancelled');
  });
  it('does not let catch bypass output or attempted-call limits', async () => {
    expect(
      (
        await execute(
          `for (let i = 0; i < 1002; i++) { try { text('x'); } catch {} }`,
        )
      ).status,
    ).toBe('limit');
    expect(
      (
        await execute(
          `const x = {}; x.x = x; for (let i = 0; i < 130; i++) { try { tools.Read(x); } catch {} }`,
          { call: async () => null },
          ['Read'],
        )
      ).status,
    ).toBe('limit');
  });
  it('continues safely when guest intrinsics are overwritten', async () => {
    const result = await execute(
      `
      const p = tools.Read({ value: 1 });
      JSON.parse = () => { throw 0; };
      JSON.stringify = () => 'wrong';
      Object.hasOwn = () => false;
      text(await p);
    `,
      { call: async () => ({ value: 2 }) },
      ['Read'],
    );
    expect(result).toEqual({ status: 'completed', output: ['{"value":2}'] });
  });
  it('preserves settled tool errors and assert() guest line numbers', async () => {
    const call = vi.fn(async (_name, args: { n: number }) => {
      if (args.n === 2)
        throw new ScriptToolError({
          kind: 'execution',
          toolName: 'Read',
          callId: 'c2',
          message: 'two failed',
        });
      return { n: args.n };
    });
    const result = await execute(
      `
      const settled = await Promise.allSettled([1, 2, 3].map(n => tools.Read({ n })));
      text(settled.map(r => r.status === 'fulfilled' ? r.value : [r.reason.message, r.reason.kind, r.reason.toolName, r.reason.name]));
      assert(settled[1].status === 'fulfilled', 'second failed');
      `,
      { call },
      ['Read'],
    );
    expect(JSON.parse(result.output[0])).toEqual([
      { n: 1 },
      ['two failed', 'execution', 'Read', 'ToolCallError'],
      { n: 3 },
    ]);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(
      /^Error: second failed\nat code:4:\d+\n {6}assert\(settled\[1\]\.status === 'fulfilled', 'second failed'\);$/,
    );
  });
  it('calls MCP tools through tools without an mcp global', async () => {
    const call = vi.fn(async (name: string, args: JsonObject) => ({
      name,
      args,
    }));
    const result = await execute(
      `
      text([Object.keys(tools), typeof store, typeof mcp]);
      text(await tools.mcp__s__t({ a: 1 }));
      `,
      { call },
      ['mcp__s__t'],
    );
    expect(result.status).toBe('completed');
    expect(result.output.map((item) => JSON.parse(item))).toEqual([
      [['mcp__s__t'], 'function', 'undefined'],
      { name: 'mcp__s__t', args: { a: 1 } },
    ]);
    expect((await execute('text([typeof memo, typeof mcp]);')).output).toEqual([
      '["undefined","undefined"]',
    ]);
  });
  it('reuses a prewarmed worker without sharing guest state between scripts', async () => {
    const warm = new ScriptRuntime(join(directory, 'worker.mjs'), {
      prewarm: true,
    });
    const run = (code: string) =>
      warm.execute(
        {
          code,
          tools: [],
          signal: new AbortController().signal,
          timeoutMs: 5000,
        },
        { call: async () => null },
      );
    expect(
      (await run('globalThis.leak = 1; return typeof leak;')).returnValue,
    ).toBe('number');
    const results = await Promise.all([
      run('return typeof leak;'),
      run('return typeof leak;'),
    ]);
    expect(results.map((item) => item.returnValue)).toEqual([
      'undefined',
      'undefined',
    ]);
    const spinning = await warm.execute(
      {
        code: 'while (true) {}',
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 200,
      },
      { call: async () => null },
    );
    expect(spinning.status).toBe('timeout');
    expect((await run('return 3;')).returnValue).toBe('3');
  });
  it('pauses the script timeout while the host waits for an approval', async () => {
    const listeners = new Set<(waiting: boolean) => void>();
    const host: ScriptHost = {
      call: async () => {
        listeners.forEach((listener) => listener(true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        listeners.forEach((listener) => listener(false));
        return 'approved';
      },
      subscribeApprovalWait: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const run = (subscribe: boolean) =>
      runtime.execute(
        {
          code: 'return await tools.Write({});',
          tools: ['Write'],
          signal: new AbortController().signal,
          timeoutMs: 250,
        },
        subscribe ? host : { call: host.call },
      );
    expect(await run(true)).toEqual({
      status: 'completed',
      output: [],
      returnValue: 'approved',
    });
    expect(listeners.size).toBe(0);
    expect((await run(false)).status).toBe('timeout');
  });
  it('interrupts a loop that never yields while the budget is paused', async () => {
    const guarded = new ScriptRuntime(join(directory, 'worker.mjs'), {
      maxSyncMs: 200,
    });
    const listeners = new Set<(waiting: boolean) => void>();
    const host: ScriptHost = {
      // The approval never resolves, so only the worker guard can end the script.
      call: () => {
        listeners.forEach((listener) => listener(true));
        return new Promise(() => {});
      },
      subscribeApprovalWait: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const run = (code: string, signal = new AbortController().signal) =>
      guarded.execute(
        { code, tools: ['Write'], signal, timeoutMs: 1000 },
        host,
      );
    const spinning = await run('void tools.Write({}); while (true) {}');
    expect(spinning.status).toBe('timeout');
    expect(spinning.error).toContain('without awaiting a tool call');
    expect(spinning.pendingCalls).toEqual([
      { id: 1, name: 'Write', phase: 'executing' },
    ]);
    // An idle await outlives both the guard and the paused budget until the host cancels.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    const idle = await run('await tools.Write({});', controller.signal);
    expect(idle.status).toBe('cancelled');
  });
});

describe('runtime worker lifetime', () => {
  const terminate = Worker.prototype.terminate;
  const stopping = new Set<Worker>();
  const controllers: AbortController[] = [];
  const controller = () => {
    const value = new AbortController();
    controllers.push(value);
    return value;
  };
  const request = (code: string, abort = controller(), timeoutMs = 5000) => ({
    code,
    tools: ['Ready'],
    signal: abort.signal,
    timeoutMs,
  });

  beforeEach(() => {
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
      this: Worker,
    ) {
      stopping.add(this);
      // Model Bun waiting for a built-in that does not poll the interrupt flag.
      this.ref();
      return new Promise<number>(() => {});
    });
  });
  afterEach(async () => {
    for (const value of controllers) value.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    await Promise.all([...stopping].map((worker) => terminate.call(worker)));
    controllers.length = 0;
    stopping.clear();
  });

  it.each(['success', 'abort', 'timeout'] as const)(
    'returns %s promptly but holds capacity until the worker exits',
    async (how) => {
      const limited = new ScriptRuntime(join(directory, 'worker.mjs'), {
        maxWorkers: 1,
      });
      const unref = vi.spyOn(Worker.prototype, 'unref');
      const abort = controller();
      let ready!: () => void;
      const called = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const pending = limited.execute(
        request(
          `await tools.Ready({}); ${how === 'success' ? 'return 1;' : 'while (true) {}'}`,
          abort,
          how === 'timeout' ? 1000 : 5000,
        ),
        {
          call: async () => {
            ready();
            return null;
          },
        },
      );
      await called;
      if (how === 'abort') abort.abort();
      expect((await pending).status).toBe(
        how === 'success'
          ? 'completed'
          : how === 'abort'
            ? 'cancelled'
            : 'timeout',
      );
      expect(stopping.size).toBe(1);
      expect(unref).toHaveBeenCalledOnce();
      const first = [...stopping][0];
      expect(first.threadId).not.toBe(-1);

      let admitted = false;
      const next = limited
        .execute(request('return 2;'), { call: async () => null })
        .then((result) => {
          admitted = true;
          return result;
        });
      const queuedAbort = controller();
      const cancelled = limited.execute(request('return 3;', queuedAbort), {
        call: async () => null,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      queuedAbort.abort();
      expect((await cancelled).status).toBe('cancelled');
      expect(
        await limited.execute(request('return 4;', controller(), 20), {
          call: async () => null,
        }),
      ).toMatchObject({
        status: 'timeout',
        error: expect.stringContaining('while waiting for a free worker'),
      });
      expect(admitted).toBe(false);
      expect(stopping.size).toBe(1);

      await terminate.call(first);
      expect(await next).toMatchObject({
        status: 'completed',
        returnValue: '2',
      });
      expect(stopping.size).toBe(2);
    },
  );

  it.each(['abort', 'timeout'] as const)(
    'terminates an acquired worker on %s even while store restoration is stuck',
    async (how) => {
      const limited = new ScriptRuntime(join(directory, 'worker.mjs'), {
        maxWorkers: 1,
      });
      const ref = vi.spyOn(Worker.prototype, 'ref');
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      const abort = controller();
      let restore!: (value: JsonObject) => void;
      const snapshot = new Promise<JsonObject>((resolve) => {
        restore = resolve;
      });
      const pending = limited.execute(
        request('return 1;', abort, how === 'timeout' ? 200 : 5000),
        {
          call: async () => null,
          storeSnapshot: () => snapshot,
        },
      );
      await vi.waitFor(() => expect(ref).toHaveBeenCalled());
      if (how === 'abort') abort.abort();
      expect((await pending).status).toBe(
        how === 'abort' ? 'cancelled' : 'timeout',
      );
      expect(stopping.size).toBe(1);
      expect(post).not.toHaveBeenCalled();
      restore({});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('does not start a late acquisition after the script was cancelled', async () => {
    const limited = new ScriptRuntime(join(directory, 'worker.mjs'), {
      maxWorkers: 1,
      prewarm: true,
    });
    const acquire = ScriptWorkers.prototype.acquire;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delayed = vi
      .spyOn(ScriptWorkers.prototype, 'acquire')
      .mockImplementation(async function (this: ScriptWorkers, ...args) {
        await gate;
        return acquire.apply(this, args);
      });
    const ref = vi.spyOn(Worker.prototype, 'ref');
    const abort = controller();
    const pending = limited.execute(request('return 1;', abort), {
      call: async () => null,
    });
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce());
    abort.abort();
    expect((await pending).status).toBe('cancelled');
    resume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ref).not.toHaveBeenCalled();
    expect(stopping.size).toBe(0);
  });
});
