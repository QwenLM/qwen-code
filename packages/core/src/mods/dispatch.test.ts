/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ModRuntime } from './runtime.js';
import type { ModLog } from './types.js';

const signal = () => new AbortController().signal;
const provider = `let count = 0;
export function register(on) {
  on('session.start', async ($, e, next) => { await $.command.register({name:'hello',description:'Hello'}); return next(e); });
  on('command.run', {command:'hello'}, ($, e) => { $.ui.log('effect:' + ++count); return {text: count + ':' + e.args}; });
}`;
const wrapper = (body: string, recovery = '') => `export function register(on) {
  on('command.run', {command:'hello'}, async ($, e, next) => { ${body} })${recovery ? `.catch(async ($, e, next) => { ${recovery} })` : ''};
}`;

describe('Mod middleware through real isolated realms', () => {
  const runtimes: ModRuntime[] = [];
  const logs: Array<ModLog & { plugin: string }> = [];
  const group = async (...sources: string[]) => {
    const runtime = await ModRuntime.createGroup(
      sources.map((source, i) => ({
        id: 'id' + i,
        name: 'plugin' + i,
        options: {},
        source: {
          root: '/fixture' + i,
          entry: '/fixture' + i + '/mod.js',
          source,
        },
      })),
      '/workspace',
      (entry, plugin) => logs.push({ ...entry, plugin }),
      signal(),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const effects = () =>
    logs.filter((log) => log.text.startsWith('effect:')).map((log) => log.text);
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    logs.length = 0;
  });

  it('registers every plugin before startup, preserves ownership, and wraps another plugin', async () => {
    const runtime = await group(
      `export function register(on) {
      on('command.register', { name:'hello' }, ($, e, next) => next({...e,description:'Wrapped'}));
      on('command.run', ($, e, next) => next({...e,args:e.args+'!'}).then(r=>({text:'['+r.text+']'})));
    }`,
      provider,
    );
    expect(runtime.getCommands('id0')).toEqual([]);
    expect(runtime.getCommands('id1')).toEqual([
      { name: 'hello', description: 'Wrapped' },
    ]);
    expect(await runtime.runCommand('hello', 'world', signal())).toBe(
      '[1:world!]',
    );
    expect(effects()).toEqual(['effect:1']);
  });

  it('keeps same-name commands owned by the first registering plugin', async () => {
    const runtime = await group(provider, provider);
    expect(runtime.getCommands('id0')).toHaveLength(1);
    expect(runtime.getCommands('id1')).toEqual([]);
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
    expect(logs.some((log) => /already registered/.test(log.text))).toBe(true);
  });

  it('registers and logs at the group and command capacity', async () => {
    const runtime = await group(
      ...Array.from(
        { length: 32 },
        (_, i) => `export function register(on) {
          on('session.start', async ($, e, next) => {
            await $.command.register({name:'first${i}',description:'First'});
            await $.command.register({name:'second${i}',description:'Second'});
            $.ui.log('first${i}'); $.ui.log('second${i}');
            return next(e);
          });
        }`,
      ),
    );
    for (let i = 0; i < 32; i++) {
      expect(
        runtime.getCommands('id' + i).map((command) => command.name),
      ).toEqual(['first' + i, 'second' + i]);
    }
    expect(logs.filter((log) => log.to === 'transcript')).toHaveLength(64);
  });

  it.each([1, 32])(
    'delivers the same log volume with %s plugins',
    async (size) => {
      const runtime = await group(
        ...Array.from(
          { length: size - 1 },
          () => 'export function register() {}',
        ),
        provider.replace(
          "$.ui.log('effect:' + ++count); return {text: count + ':' + e.args};",
          "for (let i=0; i<200; i++) $.ui.log('line:' + i); return {text:'done'};",
        ),
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe('done');
      expect(logs.map((log) => log.text)).toEqual(
        Array.from({ length: 200 }, (_, i) => 'line:' + i),
      );
    },
  );

  it('retains the operation cap for API chains and resets it on the next request', async () => {
    const runtime = await group(
      provider.replace(
        "$.ui.log('effect:' + ++count); return {text: count + ':' + e.args};",
        "for (let i=0; i<(e.args==='limit'?4200:1); i++) $.ui.log('line:' + i); return {text:'done'};",
      ),
    );
    expect(await runtime.runCommand('hello', 'limit', signal())).toBe('done');
    expect(logs.map((log) => log.text)).toEqual(
      Array.from({ length: 4095 }, (_, i) => 'line:' + i),
    );
    logs.length = 0;
    expect(await runtime.runCommand('hello', '', signal())).toBe('done');
    expect(logs.map((log) => log.text)).toEqual(['line:0']);
  });

  it('allows lifecycle short circuit after all module registrations', async () => {
    const runtime = await group(
      `export function register(on) { on('session.start', ($,e) => ({cwd:e.cwd})); }`,
      provider,
    );
    expect(runtime.getCommands('id1')).toEqual([]);
  });

  it('matches patterns, copied nested/array/regex fields, and equal exact matchers in registration order', async () => {
    const runtime = await group(
      `export function register(on) {
      const matcher = { command: ['unused', /^hell/], origin: {kind:['sdk']}, presentation:{columns:/^80$/} };
      on('command.*', matcher, async ($,e,next) => { $.ui.log('prefix'); return next(e); });
      matcher.command.length=0;
      on('!session.*', {command:'hello'}, async ($,e,next) => { $.ui.log('negative'); return next(e); });
      on('command.run', {command:'hello'}, async ($,e,next) => { $.ui.log('same1'); return next(e); });
      on('command.run', {command:'hello'}, async ($,e,next) => { $.ui.log('same2'); return next(e); });
      on('command.run', {args:{startsWith:'x'}}, () => ({text:'wrong'}));
      on('command.run', {missing:null}, () => ({text:'wrong'}));
    }`,
      provider,
    );
    expect(await runtime.runCommand('hello', 'x', signal())).toBe('1:x');
    expect(logs.map((log) => log.text)).toEqual([
      'prefix',
      'negative',
      'same1',
      'same2',
      'effect:1',
    ]);
  });

  it.each([
    "on('command.run',()=>({})); on('command.run',()=>({}));",
    "on('*',{},()=>({})); on('*',{args:'x'},()=>({}));",
    "on('command.run',{command:/hello/g},()=>({}));",
    "on('!*',()=>({}));",
    "on('model.request',()=>({}));",
    "on('command.run',{args:undefined},()=>({}));",
    "on('command.run',()=>({})).catch(()=>({})).catch(()=>({}));",
  ])('rejects unsupported registration: %s', async (code) => {
    await expect(
      group(`export function register(on) {${code}}`),
    ).rejects.toThrow();
  });

  it.each([
    'throw new Error("before")',
    'return undefined',
    'return {context:[]}',
    'return next({...e,command:"other"})',
  ])(
    'skips failed middleware without poisoning the session: %s',
    async (body) => {
      const runtime = await group(wrapper(body), provider);
      expect(await runtime.runCommand('hello', 'one', signal())).toBe('1:one');
      expect(await runtime.runCommand('hello', 'two', signal())).toBe('2:two');
      expect(effects()).toEqual(['effect:1', 'effect:2']);
      expect(logs.filter((log) => log.to === 'debug')).toHaveLength(2);
    },
  );

  it.each([
    [
      "new Error('upload interrupted by server')",
      'Error: upload interrupted by server',
    ],
    ["new Error('interrupted')", 'Error: interrupted'],
    [
      "Object.assign(new Error('upload interrupted'), {name:'InternalError'})",
      'InternalError: upload interrupted',
    ],
  ])('preserves guest-thrown error metadata for %s', async (error, message) => {
    const runtime = await group(
      wrapper(
        `throw ${error};`,
        `return {text: next.error.kind + ':' + next.error.message};`,
      ),
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe(
      'throw:' + message,
    );
    expect(effects()).toEqual([]);
  });

  it('keeps an outer failure distinct from a sibling catch timeout in the same realm', async () => {
    const runtime = await group(
      `let innerCatches = 0; export function register(on) {
        on('*', async ($, e, next) => {
          const result = await next(e);
          if (next.event === 'command.run' && e.args !== 'inspect') throw new Error('outer unrelated failure');
          return result;
        }).catch(($, e, next) => {
          if (next.event === 'command.run') return {text: next.error.kind + ':' + next.error.message};
          return next(e);
        });
        on('ui.log', {text:'effect:1'}, () => { throw new Error('inner failure'); })
          .catch(() => { innerCatches++; while (true) {} });
        on('command.run', {args:'inspect'}, () => ({text:String(innerCatches)}));
      }`,
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe(
      'throw:Error: outer unrelated failure',
    );
    expect(effects()).toEqual(['effect:1']);
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe('1');
  });

  it.each(['throw new Error("after")', 'return undefined', 'return {text:3}'])(
    'retains the last normal next result after %s',
    async (ending) => {
      const runtime = await group(
        wrapper(
          `await next({...e,args:'first'}); await next({...e,args:'last'}); ${ending}`,
        ),
        provider,
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe('2:last');
      expect(effects()).toEqual(['effect:1', 'effect:2']);
    },
  );

  it('replays only the last started next in catch and does not inspect replay arguments', async () => {
    const runtime = await group(
      wrapper(
        `await Promise.all([next({...e,args:'first'}),next({...e,args:'last'})]); throw new Error('boom');`,
        `if (!next.called || next.error.kind!=='throw') throw new Error('metadata'); const a=await next({get args(){throw new Error('must not read')}}); const b=await next(); return {text:a.text+'|'+b.text};`,
      ),
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe(
      '2:last|2:last',
    );
    expect(effects()).toEqual(['effect:1', 'effect:2']);
  });

  it.each([
    'return b',
    'throw new Error("catch failed")',
    'return undefined',
    'return {wrong:true}',
  ])(
    'catch before next executes downstream at most once when %s',
    async (ending) => {
      const runtime = await group(
        wrapper(
          'throw new Error("before")',
          `if (next.called) throw new Error('called'); const a=await next({...e,args:'catch'}); const b=await next({...e,args:'ignored'}); ${ending}`,
        ),
        provider,
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe('1:catch');
      expect(effects()).toEqual(['effect:1']);
    },
  );

  it('contains throwing catches and allows a catch to answer without next', async () => {
    const runtime = await group(
      wrapper(
        'throw new Error("before")',
        'return {text:next.error.kind+":"+next.called}',
      ),
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('throw:false');
    expect(effects()).toEqual([]);
  });

  it('folds same-plugin hooks and tries catches in registration order with each passed input', async () => {
    const runtime = await group(
      `export function register(on) {
      on('command.run', {command:'hello'}, ($,e,next)=>next({...e,args:'inner'})).catch(($,e,next)=>{ if(next.called) throw new Error('must be false'); $.ui.log('outer:'+e.args); });
      on('command.run', {command:'hello'}, ()=>{throw new Error('inner');}).catch(($,e,next)=>{ $.ui.log('inner:'+e.args); return next({...e,args:'recovered'}); });
    }`,
      provider,
    );
    expect(await runtime.runCommand('hello', 'original', signal())).toBe(
      '1:recovered',
    );
    expect(logs.map((log) => log.text)).toEqual([
      'outer:original',
      'inner:inner',
      'effect:1',
    ]);
  });

  it.each([
    ['return {wrong:true};', '1:', true],
    ['return {text:"first catch recovered"};', 'first catch recovered', false],
    ['return undefined;', 'second catch recovered', false],
    ['throw new Error("catch failed");', 'second catch recovered', false],
    ['await next(e); throw new Error("catch failed");', '1:', true],
    ['await next(e); return {wrong:true};', '1:', true],
    ['await next(e);', '1:', true],
  ])(
    'stops catch selection after an answer or a replay: %s',
    async (body, expected, called) => {
      const runtime = await group(
        `export function register(on) {
        on('command.run', {}, ($,e,next)=>next(e)).catch(async ($,e,next)=>{${body}});
        on('command.run', {}, ()=>{throw new Error('inner');}).catch(()=>({text:'second catch recovered'}));
      }`,
        provider,
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe(expected);
      expect(effects()).toEqual(called ? ['effect:1'] : []);
    },
  );

  it.each([false, true])(
    'retains catch replay when normal next was called: %s',
    async (called) => {
      const runtime = await group(
        `export function register(on) {
        on('command.run', {}, ($,e,next)=>next(e)).catch(async ($,e,next)=>{await next({...e,args:'first'}); throw new Error('catch failed');});
        on('command.run', {}, async ($,e,next)=>{${called ? "await next({...e,args:'normal'});" : ''} throw new Error('inner');}).catch(($,e,next)=>{$.ui.log('unexpected later catch'); return next(e);});
      }`,
        provider,
      );
      const result = called ? '1:normal' : '1:first';
      expect(await runtime.runCommand('hello', '', signal())).toBe(result);
      expect(
        logs.filter((log) => log.to === 'transcript').map((log) => log.text),
      ).toEqual(['effect:1']);
    },
  );

  it.each(['undefined', 'null', 'false'])(
    'rejects a missing same-plugin next result before an outer hook can wrap it: %s',
    async (result) => {
      const runtime = await group(
        `export function register(on) {
        on('command.run', {}, async ($,e,next)=>({text:'outer accepted '+String(await next(e))})).catch(()=>({text:'caught missing result'}));
        on('command.run', {}, ()=>${result});
      }`,
        provider,
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe(
        'caught missing result',
      );
      expect(effects()).toEqual([]);
    },
  );

  it('exposes frozen data, origin/is metadata, a fresh budget snapshot and void log API events', async () => {
    const runtime = await group(
      `export function register(on) {
      on('ui.log', async ($,e,next)=>{
        if(next.origin.plugin!=='plugin1'||next.origin.tier!=='user') throw new Error('wrong origin');
        const result=await next({...e,text:'wrapped:'+e.text});
        if(!Object.hasOwn(result,'value')||result.value!==undefined) throw new Error('wrong void envelope');
        return result;
      });
    }`,
      `export function register(on) {
      on('session.start',async ($,e,next)=>{await $.command.register({name:'hello',description:'Hello'}); return next(e);});
      on('command.run',async ($,e,next)=>{
        if(!Object.isFrozen(next)||!Object.isFrozen(e.origin)||!Object.isFrozen(next.origin)||!next.is('command.*')||next.is('session.*')||next.origin.plugin!=='engine'||next.signal.aborted) throw new Error('metadata');
        const before=next.budget; const until=Date.now()+30; while(Date.now()<until){};
        if(before.ms!==10000||next.budget.remainingMs>=before.remainingMs||!Object.isFrozen(before)) throw new Error('budget');
        if($.ui.log('hello')!==undefined) throw new Error('log not void'); return {text:'ok'};
      });
    }`,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('ok');
    expect(logs).toEqual([
      { plugin: 'plugin1', to: 'transcript', text: 'wrapped:hello' },
    ]);
  });

  it('denies an API without executing its core operation', async () => {
    const runtime = await group(
      `export function register(on) {on('ui.log',()=>({deny:'no log'}));}`,
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
    expect(effects()).toEqual([]);
  });

  it.each(['direct', 'middleware'])(
    'rejects non-string log sinks from %s without leaking debug output',
    async (path) => {
      const runtime = await group(
        path === 'middleware'
          ? `export function register(on) {on('ui.log', ($,e,next)=>next({...e,to:['debug']}));}`
          : `export function register() {}`,
        provider.replace(
          "$.ui.log('effect:' + ++count)",
          `$.ui.log('effect:' + ++count, {to:${path === 'direct' ? "['debug']" : "'debug'"}})`,
        ),
      );
      expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
      const output = logs.filter((log) => log.text.startsWith('effect:'));
      expect(output).toEqual(
        path === 'direct'
          ? []
          : [{ text: 'effect:1', to: 'debug', plugin: 'plugin1' }],
      );
    },
  );

  it('preserves the void API envelope when a catch answers before core', async () => {
    const runtime = await group(
      `let observed; export function register(on) {
      on('ui.log', async ($,e,next)=>{const result=await next(e); observed=Object.hasOwn(result,'value')&&result.value===undefined; return result;});
      on('command.run', ($,e,next)=>e.args==='inspect'?{text:String(observed)}:next(e));
    }`,
      `export function register(on) {
      on('ui.log', ()=>{throw new Error('recover');}).catch(()=>({value:undefined}));
    }`,
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe('true');
    expect(effects()).toEqual([]);
  });

  it('refuses stale next and API continuations after settlement', async () => {
    const runtime = await group(
      `let saved; export function register(on) {
      on('command.run',async ($,e,next)=>{
        if(e.args==='save') {saved=next; return {text:'saved'};}
        try {await saved(e);} catch {return {text:'closed'};} return {text:'bad'};
      });
    }`,
      provider,
    );
    expect(await runtime.runCommand('hello', 'save', signal())).toBe('saved');
    expect(await runtime.runCommand('hello', 'later', signal())).toBe('closed');
    expect(effects()).toEqual([]);
  });

  it('keeps pending and rejected downstream calls in the recovery ledger', async () => {
    const runtime = await group(
      wrapper(
        `next(e); throw new Error('after starting next');`,
        `const a=await next(e).then(()=>false,()=>true); const b=await next({...e,args:'retry'}).then(()=>false,()=>true); return {text:String(next.called)+':'+a+':'+b};`,
      ),
      provider.replace(
        "return {text: count + ':' + e.args};",
        "throw new Error('provider failed');",
      ),
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe(
      'true:true:true',
    );
    expect(effects()).toEqual(['effect:1']);
  });

  it('abandons unawaited downstream work when an outer hook answers early', async () => {
    const runtime = await group(
      wrapper(
        `if(e.args==='short'){void next(e).catch(()=>{}); return {text:'short'};} return next(e);`,
      ),
      provider.replace(
        "$.ui.log('effect:' + ++count); return {text: count + ':' + e.args};",
        "if(e.args==='short') return new Promise(()=>{}); $.ui.log('effect:'+ ++count); return {text:'alive'};",
      ),
    );
    const start = Date.now();
    expect(await runtime.runCommand('hello', 'short', signal())).toBe('short');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await runtime.runCommand('hello', 'ok', signal())).toBe('alive');
    expect(effects()).toEqual(['effect:1']);
  });

  it('cancels without falling through to provider effects and keeps later commands working', async () => {
    const runtime = await group(
      wrapper(
        `if(e.args==='cancel') await new Promise(()=>{}); return next(e);`,
      ),
      provider,
    );
    await expect(
      runtime.runCommand('hello', 'cancel', AbortSignal.timeout(100)),
    ).rejects.toThrow(/cancelled/);
    expect(effects()).toEqual([]);
    expect(await runtime.runCommand('hello', 'ok', signal())).toBe('1:ok');
  });

  it('falls back once when catch exceeds its grace after calling next', async () => {
    const runtime = await group(
      wrapper(
        'throw new Error("before")',
        "await next({...e,args:'once'}); await new Promise(()=>{});",
      ),
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:once');
    expect(effects()).toEqual(['effect:1']);
  });

  it('charges catch execution while a void log notification is pending', async () => {
    const runtime = await group(
      wrapper(
        'throw new Error("before")',
        `$.ui.log('hold'); await Promise.resolve(); await Promise.resolve();
        const start=Date.now(); while(Date.now()-start<1600){}
        return {text:'catch escaped its budget'};`,
      ),
      `export function register(on) {
        on('ui.log', {text:'hold'}, ()=>new Promise(()=>{}));
      }`,
      provider,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
    expect(effects()).toEqual(['effect:1']);
  }, 20_000);

  it('skips immediate and ancestor catches without disabling other registrations or later calls', async () => {
    const runtime = await group(
      `let caught = 0, logCalls = 0; export function register(on) {
      on('*', ($,e,next)=>next(e)).catch(($,e,next)=>{caught++; return next(e);});
      on('ui.log', ($,e,next)=>{
        logCalls++;
        $.ui.log('self');
        return next({...e,text:'seen:'+e.text});
      }).catch(($,e,next)=>{caught++; return next(e);});
      on('command.run', {args:'inspect'}, ()=>{
        return {text:JSON.stringify({caught,logCalls})};
      });
    }`,
      provider,
    );
    expect(await runtime.runCommand('hello', 'ok', signal())).toBe('1:ok');
    expect(
      logs
        .filter((log) => log.to === 'transcript')
        .map((log) => log.text)
        .sort(),
    ).toEqual(['seen:effect:1', 'self']);
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe(
      '{"caught":0,"logCalls":1}',
    );
    expect(await runtime.runCommand('hello', 'again', signal())).toBe(
      '2:again',
    );
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe(
      '{"caught":0,"logCalls":2}',
    );
    expect(runtime.getCommands('id0')).toEqual([]);
    expect(runtime.getCommands('id1')).toEqual([
      { name: 'hello', description: 'Hello' },
    ]);
  });

  it('excludes ancestor catches while preserving matching siblings and their normal budget', async () => {
    const runtime = await group(
      `let caught = 0, siblingBudget; export function register(on) {
      on('ui.log', {}, ($,e,next)=>{if(e.text==='outer') $.ui.log('nested-a'); return next(e);}).catch(($,e,next)=>{caught++; return next(e);});
      on('ui.log', {text:'ancestor'}, ($,e,next)=>{siblingBudget=next.budget.ms; return next({...e,text:'SIBLING:'+e.text});});
      on('ui.log', {text:'not-matched'}, ()=>{throw new Error('matcher was ignored');});
      on('command.run', {args:'inspect'}, ()=>({text:JSON.stringify({caught,siblingBudget})}));
    }`,
      `export function register(on) {
      on('ui.log', ($,e,next)=>{if(e.text==='nested-a') $.ui.log('ancestor'); return next(e);});
      on('session.start', async ($,e,next)=>{await $.command.register({name:'hello',description:'Hello'}); return next(e);});
      on('command.run', ($,e)=>{$.ui.log('outer'); return {text:'done'};});
    }`,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('done');
    expect(
      logs.filter((log) => log.to === 'transcript').map((log) => log.text),
    ).toEqual(['outer', 'nested-a', 'SIBLING:ancestor']);
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe(
      '{"caught":0,"siblingBudget":10000}',
    );
    expect(logs.filter((log) => log.to === 'debug')).toEqual([]);
  });

  it('does not select excluded ancestor catches when a sibling genuinely fails', async () => {
    const runtime = await group(
      `let caught = 0, recovered = 0, catchBudget; export function register(on) {
      on('ui.log', {}, ($,e,next)=>{if(e.text==='outer') $.ui.log('nested-a'); return next(e);}).catch(($,e,next)=>{caught++; return next(e);});
      on('ui.log', {text:'ancestor'}, ()=>{throw new Error('sibling failed');}).catch(($,e,next)=>{
        recovered++;
        catchBudget=next.budget.ms;
        return next({...e,text:'RECOVERED:'+e.text});
      });
      on('command.run', {args:'inspect'}, ()=>({text:JSON.stringify({caught,recovered,catchBudget})}));
    }`,
      `export function register(on) {
      on('session.start', async ($,e,next)=>{await $.command.register({name:'hello',description:'Hello'}); return next(e);});
      on('ui.log', ($,e,next)=>{if(e.text==='nested-a') $.ui.log('ancestor'); return next(e);});
      on('command.run', ($,e)=>{$.ui.log('outer'); return {text:'done'};});
    }`,
    );
    expect(await runtime.runCommand('hello', '', signal())).toBe('done');
    expect(
      logs.filter((log) => log.to === 'transcript').map((log) => log.text),
    ).toEqual(['outer', 'nested-a', 'RECOVERED:ancestor']);
    expect(await runtime.runCommand('hello', 'inspect', signal())).toBe(
      '{"caught":0,"recovered":1,"catchBudget":1000}',
    );
  });

  it.each(['while(true){}', 'await new Promise(()=>{})'])(
    'recovers from a timeout and retains the realm: %s',
    async (body) => {
      const runtime = await group(
        wrapper(
          `if(e.args==='timeout'){${body}} return next(e);`,
          `if(next.error.kind!=='timeout'||next.budget.ms!==1000||next.signal.aborted) throw new Error('bad catch metadata'); return {text:'recovered'};`,
        ),
        provider,
      );
      expect(await runtime.runCommand('hello', 'timeout', signal())).toBe(
        'recovered',
      );
      expect(await runtime.runCommand('hello', 'ok', signal())).toBe('1:ok');
      expect(effects()).toEqual(['effect:1']);
    },
    20_000,
  );
});
