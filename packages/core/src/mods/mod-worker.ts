/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { MOD_GUEST_FACTORY } from './guest.js';
import { compileModModules } from './module-loader.js';
import {
  MOD_MAX_BYTES,
  MOD_TIMEOUT_MS,
  MOD_END_TIMEOUT_MS,
  type ModCommand,
  type ModPlugin,
  type ModReply,
  type ModRequest,
} from './types.js';
import {
  ModBudget,
  ModTimeoutError,
  engineOrigin,
  record,
  validateInput,
  validateResult,
  type ModEvent,
  type ModFrame,
  type ModInput,
  type ModInvocation,
  type ModOrigin,
} from './dispatch.js';

const port = parentPort!;
const cancelled = new Int32Array(workerData as SharedArrayBuffer);
const wasm = await newQuickJSWASMModuleFromVariant(variant);
const realms: Realm[] = [];
const calls = new Map<number, ModInvocation>();
const commands = new Map<string, ModCommand & { plugin: string }>();
const notifications = new Set<Promise<unknown>>();
let serial = 0;
let epoch = 0;
let deadline = Infinity;
let starting = false;
let busy = false;
let logChars = 0;
let operations = 0;
let pumping = false;
const send = (reply: ModReply) => port.postMessage(reply);
const abandoned = () =>
  Atomics.load(cancelled, 0) !== 0 || Date.now() >= deadline;
const callAbandoned = (call?: ModInvocation): boolean =>
  abandoned() ||
  Boolean(
    call &&
      (call.epoch !== epoch ||
        call.closed ||
        (call.parent && callAbandoned(call.parent))),
  );
const assertLive = (call?: ModInvocation) => {
  if (callAbandoned(call))
    throw new Error('Mod dispatch cancelled or timed out.');
};

class Realm {
  readonly runtime = wasm.newRuntime();
  readonly vm = this.runtime.newContext();
  readonly guest: QuickJSHandle;
  patterns: string[] = [];
  private sliceDeadline = Infinity;
  private notifying = false;
  constructor(
    readonly plugin: ModPlugin,
    readonly index: number,
  ) {
    this.runtime.setMemoryLimit(64 * 1024 * 1024);
    this.runtime.setMaxStackSize(1024 * 1024);
    this.runtime.setInterruptHandler(
      () =>
        performance.now() >= this.sliceDeadline ||
        (!this.notifying &&
          (abandoned() ||
            [...calls.values()].some(
              (call) =>
                call.plugin === index &&
                call.live &&
                (call.budget.expired || callAbandoned(call)),
            ))),
    );
    const bridge = this.vm.newFunction('modCall', (id, kind, data) => {
      const callId = this.vm.getNumber(id);
      const method = this.vm.getString(kind);
      const json = this.vm.getString(data);
      if (Buffer.byteLength(json) > MOD_MAX_BYTES)
        throw new Error('Mod API input is too large.');
      const deferred = this.vm.newPromise();
      const task = Promise.resolve().then(() =>
        hostCall(callId, method, JSON.parse(json)),
      );
      notifications.add(task);
      void task
        .then((value) => {
          const json = JSON.stringify({
            value,
            voidValue:
              record(value) && 'value' in value && value['value'] === undefined,
          });
          if (Buffer.byteLength(json) > MOD_MAX_BYTES)
            throw new Error('Mod API result is too large.');
          const result = this.vm.newString(json);
          deferred.resolve(result);
          result.dispose();
        })
        .catch((error) => {
          const value = this.vm.newError(String(error).slice(0, 4000));
          deferred.reject(value);
          value.dispose();
        })
        .finally(() => {
          notifications.delete(task);
          deferred.dispose();
          kick();
        });
      return deferred.handle;
    });
    const status = this.vm.newFunction('modStatus', (id, key, input) => {
      const call = calls.get(this.vm.getNumber(id));
      const name = this.vm.getString(key);
      if (name === 'validate' || name === 'validateResult') {
        if (!call?.live || callAbandoned(call))
          throw new Error('Mod continuation is no longer active.');
        const value = JSON.parse(this.vm.getString(input));
        if (name === 'validateResult') validateResult(call.event, value);
        else validateInput(call.event, value, call.input);
        return this.vm.undefined;
      }
      if (name === 'aborted')
        return call?.aborted || callAbandoned(call)
          ? this.vm.true
          : this.vm.false;
      return this.vm.newNumber(
        call ? (name === 'ms' ? call.budget.ms : call.budget.remainingMs) : 0,
      );
    });
    const factory = this.vm.unwrapResult(
      this.vm.evalCode(MOD_GUEST_FACTORY, 'mod-host.js'),
    );
    this.guest = this.vm.unwrapResult(
      this.vm.callFunction(factory, this.vm.undefined, bridge, status),
    );
    factory.dispose();
    bridge.dispose();
    status.dispose();
  }
  execute<T>(action: () => T): T {
    this.sliceDeadline =
      performance.now() + (this.notifying ? 25 : MOD_TIMEOUT_MS);
    try {
      return action();
    } finally {
      this.sliceDeadline = Infinity;
    }
  }
  pump(): void {
    const jobs = this.execute(() => this.runtime.executePendingJobs(64));
    if (jobs.error) jobs.error.dispose();
  }
  async settle(handle: QuickJSHandle): Promise<unknown> {
    const pending = this.vm.resolvePromise(handle);
    handle.dispose();
    kick();
    const value = this.vm.unwrapResult(await pending);
    try {
      if (this.vm.typeof(value) === 'undefined') return undefined;
      const json = this.vm.getString(value);
      if (Buffer.byteLength(json) > MOD_MAX_BYTES)
        throw new Error('Mod result is too large.');
      return JSON.parse(json);
    } finally {
      value.dispose();
    }
  }
  async invoke(method: string, data: unknown): Promise<unknown> {
    const input = this.vm.newString(JSON.stringify(data));
    try {
      return await this.settle(
        this.execute(() =>
          this.vm.unwrapResult(this.vm.callMethod(this.guest, method, [input])),
        ),
      );
    } finally {
      input.dispose();
    }
  }
  notify(method: string, id: number): void {
    const input = this.vm.newNumber(id);
    this.notifying = true;
    try {
      this.execute(() =>
        this.vm.unwrapResult(this.vm.callMethod(this.guest, method, [input])),
      ).dispose();
    } catch {
      /* Guest abort listeners cannot prevent cleanup. */
    } finally {
      this.notifying = false;
      input.dispose();
    }
  }
  async load(): Promise<void> {
    const { modules, imports } = await compileModModules(this.plugin.source);
    this.runtime.setModuleLoader(
      (name) => {
        const source = modules.get(name);
        if (source === undefined) throw new Error('Unknown Mod module.');
        return source;
      },
      (base, name) => {
        const resolved = imports.get(base)?.get(name);
        if (!resolved) throw new Error('Unknown Mod import.');
        return resolved;
      },
    );
    const evaluation = this.execute(() =>
      this.vm.unwrapResult(
        this.vm.evalCode(
          modules.get(this.plugin.source.entry)!,
          this.plugin.source.entry,
          { type: 'module' },
        ),
      ),
    );
    const namespacePromise = this.vm.resolvePromise(evaluation);
    evaluation.dispose();
    kick();
    const namespace = this.vm.unwrapResult(await namespacePromise);
    const register = this.vm.getProp(namespace, 'register');
    const options = this.vm.newString(JSON.stringify(this.plugin.options));
    try {
      this.patterns = (await this.settle(
        this.execute(() =>
          this.vm.unwrapResult(
            this.vm.callMethod(this.guest, 'load', [register, options]),
          ),
        ),
      )) as string[];
    } finally {
      register.dispose();
      options.dispose();
      namespace.dispose();
    }
  }
}

function kick(): void {
  if (pumping) return;
  pumping = true;
  void (async () => {
    try {
      while (realms.some((realm) => realm.runtime.hasPendingJob())) {
        for (const realm of realms)
          if (realm.runtime.hasPendingJob()) realm.pump();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      pumping = false;
    }
  })();
}

function patternMatches(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return !patternMatches(pattern.slice(1), event);
  return (
    pattern === '*' ||
    pattern === event ||
    (pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1)))
  );
}

async function bounded(
  call: ModInvocation,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const expiry = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (callAbandoned(call))
          reject(new Error('Mod dispatch cancelled or timed out.'));
        else if (call.budget.expired) reject(new ModTimeoutError());
      }, 5);
    });
    const result = await Promise.race([Promise.resolve().then(run), expiry]);
    assertLive(call);
    if (call.budget.expired) throw new ModTimeoutError();
    return result;
  } catch (error) {
    call.aborted = true;
    if (call.budget.expired || String(error).includes('interrupted'))
      throw new ModTimeoutError();
    throw error;
  } finally {
    clearInterval(timer);
    call.live = false;
    if (call.aborted) realms[call.plugin].notify('abort', call.id);
  }
}

async function dispatch(
  event: ModEvent,
  input: ModInput,
  origin: ModOrigin,
  frames: ModFrame[],
  bottom: (e: ModInput) => Promise<unknown>,
  index = 0,
  parent?: ModInvocation,
): Promise<unknown> {
  assertLive(parent);
  if (++operations > 4096)
    throw new Error('Mod dispatch operation limit exceeded.');
  const realm = realms[index];
  if (!realm) return bottom(input);
  let owner = parent;
  const next = (e: ModInput, nested: ModFrame[]) =>
    dispatch(event, e, origin, nested, bottom, index + 1, owner);
  if (!realm.patterns.some((pattern) => patternMatches(pattern, event)))
    return next(input, frames);
  const active = frames.filter((frame) => frame.plugin === index);
  const lastFrame = frames.at(-1);
  const leftOut = lastFrame?.plugin === index ? [lastFrame.registration] : [];
  const told = active
    .map((frame) => frame.registration)
    .filter((id) => !leftOut.includes(id));
  const call: ModInvocation = {
    id: ++serial,
    epoch,
    parent,
    closed: false,
    plugin: index,
    event,
    input,
    origin,
    frames,
    budget: new ModBudget(told.length ? 1000 : MOD_TIMEOUT_MS),
    live: true,
    recovering: false,
    aborted: false,
    next,
  };
  owner = call;
  calls.set(call.id, call);
  let recovery: ModInvocation | undefined;
  try {
    try {
      const value = await bounded(call, () =>
        realm.invoke('run', {
          id: call.id,
          event,
          input,
          origin,
          leftOut,
          told,
        }),
      );
      validateResult(event, value);
      return event === 'ui.log' && record(value) && !('deny' in value)
        ? { value: value['value'] }
        : value;
    } catch (error) {
      assertLive(call);
      await call.last?.catch(() => {});
      assertLive(call);
      recovery = {
        ...call,
        id: ++serial,
        budget: new ModBudget(1000),
        live: true,
        recovering: true,
        aborted: false,
      };
      calls.set(recovery.id, recovery);
      try {
        const value = await bounded(recovery, () =>
          realm.invoke('recover', {
            id: recovery!.id,
            previous: call.id,
            called: call.last !== undefined,
            error: {
              kind: error instanceof ModTimeoutError ? 'timeout' : 'throw',
              message: String(error).slice(0, 4000),
              budget: 1000,
            },
          }),
        );
        if (value !== undefined) {
          validateResult(event, value);
          return event === 'ui.log' && record(value) && !('deny' in value)
            ? { value: value['value'] }
            : value;
        }
      } catch {
        assertLive(call);
      }
      send({
        type: 'log',
        plugin: realm.plugin.name,
        to: 'debug',
        text: event + ' hook skipped: ' + String(error).slice(0, 2000),
      });
      return await (recovery.last ?? call.last ?? next(input, frames));
    }
  } finally {
    call.live = false;
    call.closed = true;
    realm.notify('finish', call.id);
    calls.delete(call.id);
    if (recovery) {
      recovery.live = false;
      recovery.closed = true;
      realm.notify('finish', recovery.id);
      calls.delete(recovery.id);
    }
  }
}

async function hostCall(
  id: number,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const call = calls.get(id);
  if (!call?.live || callAbandoned(call))
    throw new Error('Mod continuation is no longer active.');
  if (
    !record(payload) ||
    !Array.isArray(payload['frames']) ||
    payload['frames'].some((i) => !Number.isInteger(i) || i < 0 || i >= 128)
  )
    throw new Error('Invalid Mod call context.');
  const frames = [
    ...call.frames,
    ...payload['frames'].map((registration: number) => ({
      plugin: call.plugin,
      registration,
    })),
  ];
  const value = payload['value'];
  if (method === 'next') {
    if (call.recovering && call.last) return call.budget.lend(() => call.last!);
    validateInput(call.event, value, call.input);
    const task = call.budget.lend(() => call.next(value, frames));
    call.last = task;
    void task.catch(() => {});
    return task;
  }
  if (method !== 'command.register' && method !== 'ui.log')
    throw new Error('Mod API not supported: ' + method);
  validateInput(method, value, {});
  const plugin = realms[call.plugin].plugin;
  return call.budget.lend(async () => {
    const result = await dispatch(
      method,
      value,
      { plugin: plugin.name, tier: 'user' },
      frames,
      async (e) => {
        assertLive(method === 'ui.log' ? undefined : call);
        if (call.epoch !== epoch)
          throw new Error('Mod call belongs to an ended dispatch.');
        if (method === 'command.register') {
          if (!starting)
            throw new Error('Register Mod commands during session.start.');
          const spec = e as unknown as ModCommand;
          const existing = commands.get(spec.name);
          if (existing && existing.plugin !== plugin.id)
            throw new Error('Mod command already registered: ' + spec.name);
          if (!existing && commands.size >= 64)
            throw new Error('Too many Mod commands.');
          commands.set(spec.name, { ...spec, plugin: plugin.id });
          return { value: { command: spec.name } };
        }
        logChars += String(e['text']).length + 1;
        if (logChars > 100_000) throw new Error('Mod log budget exceeded.');
        send({
          type: 'log',
          plugin: plugin.name,
          text: String(e['text']),
          to: e['to'] as 'debug' | 'transcript',
        });
        return { value: undefined };
      },
      0,
      method === 'ui.log' ? undefined : call,
    );
    if (!record(result)) throw new Error('Invalid Mod API result.');
    if ('deny' in result) throw new Error(String(result['deny']));
    return result['value'];
  });
}

port.on('message', async (request: ModRequest) => {
  if (busy) {
    send({
      type: 'error',
      message: 'Concurrent Mod dispatch is not supported.',
    });
    return;
  }
  busy = true;
  epoch++;
  logChars = 0;
  operations = 0;
  deadline =
    Date.now() + (request.type === 'end' ? MOD_END_TIMEOUT_MS : 60_000);
  try {
    let result: unknown;
    if (request.type === 'load') {
      if (realms.length) throw new Error('Mods already loaded.');
      for (const plugin of request.plugins) {
        assertLive();
        const realm = new Realm(plugin, realms.length);
        realms.push(realm);
        try {
          await realm.load();
        } catch (error) {
          throw new Error('Mod ' + plugin.name + ': ' + String(error));
        }
      }
      starting = true;
      await dispatch(
        'session.start',
        { cwd: request.cwd, surface: null, isInteractive: false },
        engineOrigin,
        [],
        async (e) => ({ cwd: e['cwd'] }),
      );
      result = [...commands.values()];
    } else if (request.type === 'command') {
      if (!commands.has(request.command))
        throw new Error('Unknown Mod command.');
      result = await dispatch(
        'command.run',
        {
          command: request.command,
          args: request.args,
          origin: { kind: 'sdk' },
          presentation: { isFullscreen: false, columns: 80 },
        },
        engineOrigin,
        [],
        async (e) => {
          throw new Error('No Mod hook answered /' + String(e['command']));
        },
      );
    } else {
      result = await dispatch(
        'session.end',
        {
          sessionId: request.sessionId,
          reason: request.reason,
          resume: { id: request.sessionId },
        },
        engineOrigin,
        [],
        async (e) => ({ sessionId: e['sessionId'] }),
      );
    }
    while (notifications.size) {
      assertLive();
      await Promise.allSettled([...notifications]);
    }
    assertLive();
    send({ type: 'result', json: JSON.stringify(result) });
  } catch (error) {
    send({ type: 'error', message: String(error).slice(0, 4000) });
  } finally {
    for (const call of calls.values()) {
      call.closed = true;
      call.aborted = true;
      realms[call.plugin].notify('abort', call.id);
    }
    starting = false;
    deadline = Infinity;
    busy = false;
  }
});
