/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '../test-utils/config.js';
import { EditTool } from '../tools/edit.js';
import { ShellTool } from '../tools/shell.js';
import { DiscoveredTool, ToolRegistry } from '../tools/tool-registry.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { WriteFileTool } from '../tools/write-file.js';
import { ModRuntime } from './runtime.js';
import type { ModToolCallInput, ModToolNext } from './tool-events.js';

const signal = () => new AbortController().signal;
const source = (body: string) => `export function register(on) { ${body} }`;

describe('Claude tool input views through the real Mod worker', () => {
  const runtimes: ModRuntime[] = [];
  const logs: string[] = [];
  const config = makeFakeConfig({ chatRecording: false });
  const builtins = [
    new ShellTool(config),
    new EditTool(config),
    new WriteFileTool(config),
  ];
  async function create(
    plugins: Array<{ source: string; toolDialect?: 'native' | 'claude' }>,
    resolveTool: (
      name: string,
    ) => Promise<AnyDeclarativeTool | undefined> = async (name) =>
      builtins.find((tool) => tool.name === name),
  ) {
    const runtime = await ModRuntime.createGroup(
      plugins.map((plugin, index) => ({
        id: String(index),
        name: String(index),
        source: {
          root: '/fixture',
          entry: '/fixture/mod.js',
          source: plugin.source,
        },
        options: {},
        toolDialect: plugin.toolDialect,
      })),
      '/workspace',
      (entry) => logs.push(entry.text),
      signal(),
      resolveTool,
    );
    runtimes.push(runtime);
    return runtime;
  }
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    logs.length = 0;
  });

  it.each([
    {
      native: 'run_shell_command',
      tool: 'Bash',
      args: { command: 'before' },
      patch: { command: 'after' },
      hidden: {
        is_background: false,
        timeout: 5000,
        description: 'native',
        directory: '/workspace',
      },
    },
    {
      native: 'edit',
      tool: 'Edit',
      args: {
        file_path: '/file',
        old_string: 'before',
        new_string: 'after',
        replace_all: true,
      },
      patch: { file_path: '/other', replace_all: false },
      hidden: { modified_by_user: true, ai_proposed_content: 'native' },
    },
    {
      native: 'write_file',
      tool: 'Write',
      args: { file_path: '/file', content: 'before' },
      patch: { content: 'after' },
      hidden: {
        modified_by_user: true,
        ai_proposed_content: 'native',
        record_as_artifact: false,
      },
    },
  ])(
    'projects $tool inputs and keeps hidden native arguments and result references',
    async ({ native, tool, args, patch, hidden }) => {
      const runtime = await create([
        {
          toolDialect: 'claude',
          source: source(`
      on('tool.call', {tool:${JSON.stringify(tool)}}, async ($, e, next) => {
        if (!Object.isFrozen(e)) throw Error('not frozen');
        $.ui.log(JSON.stringify(e));
        return next({...e, ...${JSON.stringify(patch)}});
      });
      on('tool.check', {tool:${JSON.stringify(tool)}}, async ($, e, next) => {
        if (!Object.isFrozen(e.input)) throw Error('not frozen');
        $.ui.log(JSON.stringify(e)); return next(e);
      });
    `),
        },
      ]);
      const input = { tool: native, tool_use_id: 'id', ...args, ...hidden };
      const result = {
        ref: 1,
        result: { output: 'native combined output' },
        text: 'native',
      };
      const next = vi.fn<ModToolNext>(async (changed, active, check) => {
        const { tool: name, tool_use_id, ...params } = changed;
        expect(
          await check(
            { tool: name, tool_use_id, input: params, ceiling: 'ask' },
            { decision: 'ask' },
            active,
          ),
        ).toEqual({ decision: 'ask', ceiling: 'ask' });
        return result;
      });
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual(
        result,
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toEqual({ ...input, ...patch });
      expect(logs.map((entry) => JSON.parse(entry))).toEqual([
        { tool, tool_use_id: 'id', ...args },
        {
          tool,
          tool_use_id: 'id',
          input: { ...args, ...patch },
          ceiling: 'ask',
        },
      ]);
    },
  );

  it.each([undefined, 'native'] as const)(
    'keeps the original view when the dialect is %s',
    async (toolDialect) => {
      const runtime = await create([
        {
          toolDialect,
          source: source(`
      on('tool.call', {tool:'Bash'}, () => ({deny:'wrong dialect'}));
      on('tool.call', {tool:'run_shell_command'}, ($, e, next) => { $.ui.log(JSON.stringify(e)); return next(e); });
    `),
        },
      ]);
      const input = {
        tool: 'run_shell_command',
        command: 'original',
        directory: '/workspace',
      };
      const next = vi.fn<ModToolNext>(async (e) => ({ result: e }));
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: input,
      });
      expect(logs).toEqual([JSON.stringify(input)]);
    },
  );

  it.each([false, true])(
    'composes native and Claude frames in either order (reversed: %s)',
    async (reversed) => {
      const native = {
        source: source(`on('tool.call', {tool:'write_file'}, ($, e, next) => {
      $.ui.log('native:' + e.content + ':' + e.record_as_artifact);
      return next({...e, content:e.content+'N', record_as_artifact:false});
    });`),
      };
      const claude = {
        toolDialect: 'claude' as const,
        source: source(`on('tool.call', {tool:'Write'}, ($, e, next) => {
      $.ui.log('claude:' + e.content + ':' + ('record_as_artifact' in e));
      return next({...e, content:e.content+'C'});
    });`),
      };
      const runtime = await create(
        reversed ? [claude, native] : [native, claude],
      );
      const input = {
        tool: 'write_file',
        tool_use_id: 'id',
        file_path: '/file',
        content: '',
        record_as_artifact: true,
      };
      const next = vi.fn<ModToolNext>(async (e) => ({ result: e }));
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: {
          ...input,
          content: reversed ? 'CN' : 'NC',
          record_as_artifact: false,
        },
      });
      expect(next).toHaveBeenCalledTimes(1);
      expect(logs).toEqual(
        reversed
          ? ['claude::false', 'native:C:true']
          : ['native::true', 'claude:N:false'],
      );
    },
  );

  it('lets Claude matchers deny a native tool without invoking it', async () => {
    const runtime = await create([
      {
        toolDialect: 'claude',
        source: source(
          `on('tool.call', {tool:'Bash',command:/blocked/}, () => ({deny:'blocked'}));`,
        ),
      },
    ]);
    const next = vi.fn<ModToolNext>();
    await expect(
      runtime.runTool(
        { tool: 'run_shell_command', command: 'blocked' },
        next,
        signal(),
      ),
    ).resolves.toEqual({ deny: 'blocked' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['Bash', 'Edit', 'Write', 'mcp__server__Bash', 'read_file'])(
    'bypasses Claude tool frames for unsupported or same-name custom tool %s',
    async (tool) => {
      const runtime = await create([
        {
          toolDialect: 'claude',
          source: source(
            `on('tool.call', () => ({deny:'wrong builtin'})); on('tool.check', () => ({decision:'deny'}));`,
          ),
        },
        {
          source: source(
            `on('tool.call', ($, e, next) => { $.ui.log(e.tool); return next(e); });`,
          ),
        },
      ]);
      const input = { tool, command: 'original' };
      const next: ModToolNext = async (e, active, check) => ({
        result: await check(
          { tool: e.tool, input: { command: e['command'] } },
          { decision: 'allow' },
          active,
        ),
      });
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: { decision: 'allow' },
      });
      expect(logs).toEqual([tool]);
    },
  );

  it.each(
    ['run_shell_command', 'edit', 'write_file'].flatMap((tool) =>
      [false, true].map((reversed) => ({ tool, reversed })),
    ),
  )(
    'bypasses a discovered $tool replacing a builtin in either order (reversed: $reversed)',
    async ({ tool, reversed }) => {
      const registry = new ToolRegistry(config);
      registry.registerFactory(
        tool,
        async () => builtins.find((builtin) => builtin.name === tool)!,
      );
      const claude = {
        toolDialect: 'claude' as const,
        source: source(`
          on('tool.call', () => ({deny:'builtin guard'}));
          on('tool.check', () => ({decision:'deny'}));
        `),
      };
      const native = {
        source: source(`
          on('tool.call', ($, e, next) => { $.ui.log(JSON.stringify(e)); return next(e); });
          on('tool.check', ($, e, next) => { $.ui.log(JSON.stringify(e)); return next(e); });
        `),
      };
      const runtime = await create(
        reversed ? [claude, native] : [native, claude],
        (name) => registry.ensureTool(name),
      );
      const next = vi.fn<ModToolNext>(async (e, active, check) => ({
        result: await check(
          { tool: e.tool, input: { payload: e['payload'] } },
          { decision: 'allow' },
          active,
        ),
      }));
      await expect(runtime.runTool({ tool }, next, signal())).resolves.toEqual({
        deny: 'builtin guard',
      });
      expect(next).not.toHaveBeenCalled();
      logs.length = 0;

      registry.registerTool(
        new DiscoveredTool(config, tool, 'Custom payload tool', {
          type: 'object',
          properties: { payload: { type: 'string' } },
          required: ['payload'],
        }),
      );
      const input = { tool, payload: 'custom', builtinTool: tool };
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: { decision: 'allow' },
      });
      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0][0]).toEqual(input);
      expect(logs.map((entry) => JSON.parse(entry))).toEqual([
        input,
        { tool, input: { payload: 'custom' } },
      ]);
    },
  );

  it.each(['command', 'replace_all'])(
    'does not restore a mapped field removed by the guest: %s',
    async (field) => {
      const runtime = await create([
        {
          toolDialect: 'claude',
          source: source(
            `on('tool.call', ($, e, next) => { const changed={...e}; delete changed[${JSON.stringify(field)}]; return next(changed); });`,
          ),
        },
      ]);
      const input: ModToolCallInput =
        field === 'command'
          ? { tool: 'run_shell_command', command: 'original', timeout: 5000 }
          : {
              tool: 'edit',
              file_path: '/file',
              old_string: 'a',
              new_string: 'b',
              replace_all: true,
            };
      const expected = { ...input };
      delete expected[field];
      const next: ModToolNext = async (e) => ({ result: e });
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: expected,
      });
    },
  );

  it.each([
    '',
    'run_in_background',
    'timeout',
    'directory',
    'description',
    'is_background',
  ])(
    'reports unsupported Bash continuation field %s and falls back once',
    async (field) => {
      const runtime = await create([
        {
          toolDialect: 'claude',
          source: source(
            `on('tool.call', {tool:'Bash'}, ($, e, next) => next({...e, [${JSON.stringify(field)}]:'FORGED'}));`,
          ),
        },
      ]);
      const input = {
        tool: 'run_shell_command',
        command: 'original',
        timeout: 5000,
      };
      const next = vi.fn<ModToolNext>(async (e) => ({ result: e }));
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: input,
      });
      expect(next).toHaveBeenCalledTimes(1);
      expect(
        logs.some(
          (entry) =>
            entry.includes('Unsupported Claude') && entry.includes(field),
        ),
      ).toBe(true);
      expect(logs.join()).not.toContain('FORGED');
    },
  );

  it('recovers in the same dialect before next and replays completed attempts after next', async () => {
    const runtime = await create([
      {
        toolDialect: 'claude',
        source: source(`
      on('tool.call', {tool:'Write'}, async ($, e, next) => {
        if (e.content === 'before') return next({...e, record_as_artifact:true});
        await next({...e, content:'one'}); await next({...e, content:'two'});
        throw Error('after');
      }).catch(async ($, e, next) => {
        $.ui.log(e.tool + ':' + next.called);
        return next({...e, content:next.called ? 'must-not-run' : 'recovered'});
      });
    `),
      },
    ]);
    const next = vi.fn<ModToolNext>(async (e) => ({ result: e['content'] }));
    const input = {
      tool: 'write_file',
      file_path: '/file',
      content: 'before',
      record_as_artifact: false,
    };
    await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
      result: 'recovered',
    });
    await expect(
      runtime.runTool({ ...input, content: 'after' }, next, signal()),
    ).resolves.toEqual({ result: 'two' });
    expect(next.mock.calls.map(([e]) => e['content'])).toEqual([
      'recovered',
      'one',
      'two',
    ]);
    expect(
      next.mock.calls.every(([e]) => e['record_as_artifact'] === false),
    ).toBe(true);
    expect(logs).toEqual(['Write:false', 'Write:true']);
  });

  it.each([
    `return next({...e, tool:'Bash'});`,
    `return next({...e, tool_use_id:'forged'});`,
    `return next({...e, consent:true});`,
    `return next({...e, $shadowed:{tool:'forged'}});`,
  ])(
    'keeps reserved identities pinned in a projected input: %s',
    async (body) => {
      const runtime = await create([
        {
          toolDialect: 'claude',
          source: source(
            `on('tool.call', {tool:'Write'}, ($, e, next) => { ${body} });`,
          ),
        },
      ]);
      const input = {
        tool: 'write_file',
        tool_use_id: 'id',
        file_path: '/file',
        content: 'native',
        $shadowed: { tool: 'native argument' },
      };
      const next = vi.fn<ModToolNext>(async (e) => ({ result: e }));
      await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
        result: input,
      });
      expect(next).toHaveBeenCalledTimes(1);
      expect(logs.some((entry) => entry.includes('pinned tool fields'))).toBe(
        true,
      );
    },
  );

  it('pins projected check arguments and retains the native ceiling', async () => {
    const runtime = await create([
      {
        toolDialect: 'claude',
        source: source(`
      on('tool.check', {tool:'Bash'}, ($, e, next) => next({...e,input:{command:'forged'}}));
    `),
      },
    ]);
    const next: ModToolNext = async (e, active, check) => ({
      result: await check(
        {
          tool: e.tool,
          input: { command: 'original', directory: '/private' },
          ceiling: 'deny',
        },
        { decision: 'deny', ceiling: 'deny' },
        active,
      ),
    });
    await expect(
      runtime.runTool(
        { tool: 'run_shell_command', command: 'original' },
        next,
        signal(),
      ),
    ).resolves.toEqual({ result: { decision: 'deny', ceiling: 'deny' } });
    expect(logs.some((entry) => entry.includes('pinned event fields'))).toBe(
      true,
    );
  });
});
