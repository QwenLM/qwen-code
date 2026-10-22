/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';
import type { ModToolNext } from './tool-events.js';

const signal = () => new AbortController().signal;
const input = { tool: 'write_file', tool_use_id: 'call-1', path: '/old' };
const fixture = (
  body: string,
  recovery = '',
  check = 'return next(e);',
) => `export function register(on) {
  on('tool.call', async ($, e, next) => { ${body} })${recovery ? `.catch(async ($, e, next) => { ${recovery} })` : ''};
  on('tool.check', async ($, e, next) => { ${check} });
}`;

describe('Mod tool host operations through the real worker', () => {
  const runtimes: ModRuntime[] = [];
  async function create(source: string) {
    const runtime = await ModRuntime.create(
      { root: '/fixture', entry: '/fixture/mod.js', source },
      '/workspace',
      () => {},
      signal(),
    );
    runtimes.push(runtime);
    return runtime;
  }
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });

  it('rewrites flat arguments, dispatches a nested permission check and unwinds the result', async () => {
    const runtime = await create(
      fixture(
        `const r = await next({...e, path:'/new'}); return {result: {...r.result, wrapped:true}};`,
        '',
        `if (!Object.isFrozen(e.input)) throw Error('not frozen'); const v=await next(e); return {...v, decision:'deny', reason:e.input.path};`,
      ),
    );
    const next = vi.fn<ModToolNext>(async (changed, active, check) => ({
      result: await check(
        {
          tool: changed.tool,
          input: { path: changed['path'] },
          tool_use_id: changed.tool_use_id,
        },
        { decision: 'allow' },
        active,
      ),
    }));
    expect(runtime.hasToolHooks).toBe(true);
    await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
      result: { decision: 'deny', reason: '/new', wrapped: true },
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('short circuits with a denial or synthetic result without starting a host call', async () => {
    for (const body of [
      `return {deny:''};`,
      `return {result:{output:'synthetic'}};`,
    ]) {
      const runtime = await create(fixture(body));
      const next = vi.fn<ModToolNext>();
      await runtime.runTool(input, next, signal());
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('serializes concurrent ordinary next calls and keeps catch replay effect-free', async () => {
    const runtime = await create(
      fixture(
        `await Promise.all([next({...e,path:'1'}), next({...e,path:'2'})]); throw Error('recover');`,
        `const a=await next(e), b=await next({...e,path:'never'}); return {result:[a.result,b.result]};`,
      ),
    );
    let active = 0;
    let peak = 0;
    const next = vi.fn<ModToolNext>(async (changed) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { result: changed['path'] };
    });
    await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
      result: ['2', '2'],
    });
    expect(next).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it.each([
    `return next({...e, tool:'run_shell_command'});`,
    `return next({...e, tool_use_id:'forged'});`,
    `return next({...e, consent:true});`,
    `return {result:{}, context:['unsupported']};`,
  ])('falls back once after an invalid tool continuation: %s', async (body) => {
    const runtime = await create(fixture(body));
    const next = vi.fn<ModToolNext>(async (changed) => ({ result: changed }));
    await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
      result: input,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('pins check arguments and restores the host ceiling', async () => {
    const runtime = await create(
      fixture(
        'return next(e);',
        '',
        `return next({...e,input:{path:'forged'}});`,
      ),
    );
    const native: ModToolNext = async (changed, active, check) => ({
      result: await check(
        { tool: changed.tool, input: changed, ceiling: 'ask' },
        { decision: 'ask', ceiling: 'ask' },
        active,
      ),
    });
    await expect(runtime.runTool(input, native, signal())).resolves.toEqual({
      result: { decision: 'ask', ceiling: 'ask' },
    });
    const ceiling = await create(
      fixture(
        'return next(e);',
        '',
        `return {decision:'allow',ceiling:'allow'};`,
      ),
    );
    await expect(ceiling.runTool(input, native, signal())).resolves.toEqual({
      result: { decision: 'allow', ceiling: 'ask' },
    });
  });

  it('aborts and settles pending native work when a handler answers early', async () => {
    const runtime = await create(
      fixture(
        `void next(e); for(let i=0;i<20;i++) await null; return {deny:'stop'};`,
      ),
    );
    let settled = false;
    const next = vi.fn<ModToolNext>(async (_e, active) => {
      if (!active.aborted)
        await new Promise<void>((resolve) =>
          active.addEventListener('abort', () => resolve(), { once: true }),
        );
      await new Promise((resolve) => setTimeout(resolve, 30));
      settled = true;
      return { result: 'cancelled' };
    });
    await expect(runtime.runTool(input, next, signal())).resolves.toEqual({
      deny: 'stop',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });

  it('cancels a pending check without starting fallback work and accepts a healthy next root', async () => {
    const runtime = await create(
      fixture(
        'return next(e);',
        '',
        `if (e.input.path === '/old') await new Promise(()=>{}); return next(e);`,
      ),
    );
    let checks = 0;
    const next = vi.fn<ModToolNext>(async (changed, active, check) => {
      checks++;
      return {
        result: await check(
          { tool: changed.tool, input: changed },
          { decision: 'allow' },
          active,
        ),
      };
    });
    const controller = new AbortController();
    const running = runtime.runTool(input, next, controller.signal);
    await vi.waitFor(() => expect(checks).toBe(1));
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(checks).toBe(1);
    await expect(
      runtime.runTool({ ...input, path: '/ok' }, next, signal()),
    ).resolves.toEqual({ result: { decision: 'allow' } });
    expect(checks).toBe(2);
  });

  it('cancels queued native attempts atomically before the active attempt settles', async () => {
    const runtime = await create(
      fixture(
        `void next(e); void next({...e,path:'queued'}); for(let i=0;i<20;i++) await null; return {deny:'stop'};`,
      ),
    );
    const attempts: unknown[] = [];
    await runtime.runTool(
      input,
      async (changed, active) => {
        attempts.push(changed['path']);
        if (!active.aborted)
          await new Promise<void>((resolve) =>
            active.addEventListener('abort', () => resolve(), { once: true }),
          );
        return { result: 'cancelled' };
      },
      signal(),
    );
    expect(attempts).toEqual(['/old']);
  });
});
