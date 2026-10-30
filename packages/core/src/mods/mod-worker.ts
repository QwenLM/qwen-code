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
import { CLAUDE_CODE_EVENTS_VERSION } from './claude-events.js';
import { MOD_GUEST_FACTORY } from './guest.js';
import { compileModModules } from './module-loader.js';
import { modToolInputView } from './tool-dialect.js';
import type { ModToolCallInput, ModToolCheckResult } from './tool-events.js';
import {
  MOD_MAX_BYTES,
  MOD_TIMEOUT_MS,
  MOD_END_TIMEOUT_MS,
  type ModCommand,
  type ModPlugin,
  type ModReply,
  type ModSessionFacts,
  type ModWorkerRequest,
} from './types.js';
import { ENGINE_NODE, type ModRenderSite } from './render-tree.js';
import {
  MOD_EVENTS,
  MOD_HOST_EVENTS,
  MOD_METHODS,
  MOD_READS,
  ModBudget,
  ModRenderShapeError,
  ModTimeoutError,
  assertModDepth,
  engineOrigin,
  isModMethod,
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
const guestNotifications = new Set<Promise<unknown>>();
const hostOperations = new Map<
  number,
  {
    parent?: ModInvocation;
    frames: ModFrame[];
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }
>();
// $.turn.abort calls waiting for the host, which owns the running turn.
const turnAborts = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
let serial = 0;
let epoch = 0;
let rootId = 0;
let rootBudget: ModBudget | undefined;
let toolRoot = false;
let native: number | undefined;
let reportedNative: number | undefined;
let activityRevision = 0;
let phase = 0;
let reportedPhase = 0;
let checks = 0;
let lastCheck = 0;
let executing = 0;
let starting = false;
let busy = false;
let logChars = 0;
let operations = 0;
let pumping = false;
let builtinTool: string | undefined;
let surface: 'terminal' | null = null;
let sites: readonly ModRenderSite[] = [];
let version = 'unknown';
// The events this host runs: those it raises only where it draws need a site.
let supported: readonly ModEvent[] = MOD_EVENTS;
// A render hook that keeps failing the same way is said once per load.
const renderSkips = new Set<string>();
let facts: ModSessionFacts | undefined;
const send = (reply: ModReply, root = rootId) =>
  port.postMessage({ ...reply, root, phase });
const abandoned = () =>
  Atomics.load(cancelled, 0) !== 0 || rootBudget?.expired === true;
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

function updateActivity(): void {
  if (!busy || !toolRoot || !rootBudget) return;
  const lending =
    native !== undefined &&
    hostOperations.has(native) &&
    !abandoned() &&
    !executing &&
    !checks &&
    !guestNotifications.size &&
    !realms.some((realm) => realm.runtime.hasPendingJob()) &&
    ![...calls.values()].some((call) => call.live && !call.budget.lending);
  if (lending !== rootBudget.lending) {
    if (lending) rootBudget.pause();
    else rootBudget.resume();
  }
  const operation = lending ? native : undefined;
  if (operation !== reportedNative || phase !== reportedPhase) {
    reportedNative = operation;
    reportedPhase = phase;
    send({ type: 'activity', revision: ++activityRevision, operation });
  }
}

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
      assertModDepth(json, 'Mod API input');
      const deferred = this.vm.newPromise();
      const task = Promise.resolve().then(() =>
        hostCall(callId, method, JSON.parse(json)),
      );
      notifications.add(task);
      if (method !== 'next') guestNotifications.add(task);
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
          guestNotifications.delete(task);
          deferred.dispose();
          kick();
          updateActivity();
        });
      return deferred.handle;
    });
    const status = this.vm.newFunction('modStatus', (id, key, input) => {
      const call = calls.get(this.vm.getNumber(id));
      const name = this.vm.getString(key);
      if (
        name === 'validate' ||
        name === 'validateResult' ||
        name === 'promptFallback'
      ) {
        if (!call?.live || callAbandoned(call))
          throw new Error('Mod continuation is no longer active.');
        const json = this.vm.getString(input);
        if (name !== 'validate' && Buffer.byteLength(json) > MOD_MAX_BYTES)
          throw new Error('Mod result is too large.');
        assertModDepth(json, 'Mod value');
        const value = JSON.parse(json);
        if (name === 'validate') validateInput(call.event, value, call.input);
        else {
          validateResult(call.event, value, call.input);
          if (name === 'promptFallback')
            call.promptFallback = Promise.resolve(value);
        }
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
    const identity = this.vm.newString(
      JSON.stringify({ name: plugin.name, root: plugin.source.root }),
    );
    this.guest = this.vm.unwrapResult(
      this.vm.callFunction(
        factory,
        this.vm.undefined,
        bridge,
        status,
        identity,
      ),
    );
    factory.dispose();
    bridge.dispose();
    status.dispose();
    identity.dispose();
  }
  execute<T>(action: () => T): T {
    executing++;
    updateActivity();
    this.sliceDeadline =
      performance.now() + (this.notifying ? 25 : MOD_TIMEOUT_MS);
    try {
      return action();
    } finally {
      this.sliceDeadline = Infinity;
      executing--;
      updateActivity();
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
      assertModDepth(json, 'Mod result');
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
  if (pumping || !busy) return;
  pumping = true;
  void (async () => {
    try {
      while (busy && realms.some((realm) => realm.runtime.hasPendingJob())) {
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
    if (
      call.budget.expired ||
      (error instanceof Error &&
        error.name === 'InternalError' &&
        error.message === 'interrupted')
    )
      throw new ModTimeoutError();
    throw error;
  } finally {
    clearInterval(timer);
    call.live = false;
    if (call.aborted) realms[call.plugin].notify('abort', call.id);
    updateActivity();
  }
}

// The engine names the plugin behind an ask it made or reworded; an answer
// passed up as heard keeps the owner it had, and a hook cannot write one.
// `setting` names a host option's own check, which Qwen Code does not report,
// so a hook's is dropped too.
async function ownCheck(
  value: ModToolCheckResult,
  below: Promise<unknown> | undefined,
  plugin: string,
): Promise<ModToolCheckResult> {
  const { plugin: _written, setting: _setting, ...answer } = value;
  if (answer.decision !== 'ask') return answer;
  const heard = (await below?.catch(() => undefined)) as
    | ModToolCheckResult
    | undefined;
  if (heard?.decision === 'ask' && heard.reason === answer.reason)
    return heard.plugin === undefined
      ? answer
      : { ...answer, plugin: heard.plugin };
  return { ...answer, plugin };
}

async function dispatch(
  event: ModEvent,
  input: ModInput,
  origin: ModOrigin,
  frames: ModFrame[],
  bottom: (
    e: ModInput,
    frames: ModFrame[],
    parent?: ModInvocation,
  ) => Promise<unknown>,
  index = 0,
  parent?: ModInvocation,
): Promise<unknown> {
  assertLive(parent);
  if (index === 0 && ++operations > 4096)
    throw new Error('Mod dispatch operation limit exceeded.');
  const realm = realms[index];
  if (!realm) return bottom(input, frames, parent);
  let owner = parent;
  const next = (e: ModInput, nested: ModFrame[]) =>
    dispatch(event, e, origin, nested, bottom, index + 1, owner);
  if (!realm.patterns.some((pattern) => patternMatches(pattern, event)))
    return next(input, frames);
  const view = modToolInputView(
    event,
    input,
    realm.plugin.toolDialect,
    builtinTool,
  );
  if (!view) return next(input, frames);
  const leftOut = frames
    .filter((frame) => frame.plugin === index)
    .map((frame) => frame.registration);
  const call: ModInvocation = {
    id: ++serial,
    epoch,
    parent,
    closed: false,
    plugin: index,
    event,
    input: view.input,
    toNativeInput: view.toNativeInput,
    origin,
    frames,
    budget: new ModBudget(MOD_TIMEOUT_MS),
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
          input: call.input,
          origin,
          leftOut,
        }),
      );
      validateResult(event, value, call.input);
      if (event === 'tool.check')
        return await ownCheck(
          value as ModToolCheckResult,
          call.last,
          realm.plugin.name,
        );
      return notice(event) && record(value) && !('deny' in value)
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
              message: failure(error).slice(0, 4000),
              budget: 1000,
            },
          }),
        );
        if (value !== undefined) {
          validateResult(event, value, call.input);
          await assertDropBeforeNext(event, value, recovery.last ?? call.last);
          if (event === 'prompt.submit' && (recovery.last ?? call.last))
            return await (recovery.last ?? call.last);
          if (event === 'tool.check')
            return await ownCheck(
              value as ModToolCheckResult,
              recovery.last ?? call.last,
              realm.plugin.name,
            );
          return notice(event) && record(value) && !('deny' in value)
            ? { value: value['value'] }
            : value;
        }
      } catch {
        assertLive(call);
      }
      const why = failure(error);
      if (
        event !== 'ui.render' ||
        !renderSkips.has(realm.plugin.name + '\0' + why)
      ) {
        if (event === 'ui.render')
          renderSkips.add(realm.plugin.name + '\0' + why);
        send({
          type: 'log',
          plugin: realm.plugin.name,
          to: 'debug',
          text: event + ' hook skipped: ' + why.slice(0, 2000),
        });
      }
      return await (recovery.last ??
        call.last ??
        call.promptFallback ??
        next(input, frames));
    }
  } finally {
    call.live = false;
    call.closed = true;
    cancelAbandonedOperations();
    realm.notify('finish', call.id);
    calls.delete(call.id);
    if (recovery) {
      recovery.live = false;
      recovery.closed = true;
      cancelAbandonedOperations();
      realm.notify('finish', recovery.id);
      calls.delete(recovery.id);
    }
  }
}

// A prompt a hook passed on has entered beneath it, so the hook cannot then
// drop it; it fails, and its last next stands. Handing on the drop its next
// resolved to is no drop of its own.
async function assertDropBeforeNext(
  event: ModEvent,
  value: unknown,
  last: Promise<unknown> | undefined,
): Promise<void> {
  if (
    event !== 'prompt.submit' ||
    !last ||
    !record(value) ||
    !('drop' in value)
  )
    return;
  const below = await last.catch(() => undefined);
  if (!record(below) || below['drop'] !== value['drop'])
    throw new Error('a drop after its next(e) was answered');
}

// A tree that does not validate is told in Claude Code's words, unprefixed.
const failure = (error: unknown) =>
  error instanceof ModRenderShapeError ? error.message : String(error);

// Void notifications: the caller does not wait, and they outlive its hook.
const notice = (event: string) =>
  event === 'ui.log' || event === 'ui.invalidate';

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
    let task: Promise<unknown>;
    if (call.recovering && call.last) {
      task = call.budget.lend(() => call.last!);
    } else {
      validateInput(call.event, value, call.input);
      const nativeInput = call.toNativeInput(value);
      task = call.budget.lend(() => call.next(nativeInput, frames));
      call.last = task;
    }
    void task.catch(() => {});
    updateActivity();
    try {
      return await task;
    } finally {
      updateActivity();
    }
  }
  if (!isModMethod(method)) throw new Error('Mod API not supported: ' + method);
  validateInput(method, value, {});
  const plugin = realms[call.plugin].plugin;
  const invoke = async () => {
    const result = await dispatch(
      method,
      value,
      { plugin: plugin.name, tier: 'user' },
      frames,
      async (e) => {
        assertLive(notice(method) ? undefined : call);
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
        if (method === 'session.version')
          return {
            value: {
              version,
              qwen: {
                claudeCode: CLAUDE_CODE_EVENTS_VERSION,
                events: supported,
                methods: [...MOD_METHODS, ...MOD_READS].sort(),
              },
            },
          };
        const fact = SESSION_FACTS[method];
        if (fact) {
          if (!facts) throw new Error('Mod session facts are unavailable.');
          return { value: facts[fact] };
        }
        if (method === 'session.surfaces')
          return { value: surface ? [surface] : [] };
        if (method === 'session.surface') return { value: surface };
        if (method === 'clock.now') return { value: Date.now() };
        if (method === 'clock.sleep') {
          await sleep(call, Number(e['ms']));
          return { value: undefined };
        }
        if (method === 'turn.abort') {
          await abortTurn(String(e['turnId']));
          return { value: undefined };
        }
        if (method === 'ui.invalidate') {
          send({
            type: 'invalidate',
            plugin: plugin.name,
            event: String(e['event']),
          });
          return { value: undefined };
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
      notice(method) ? undefined : call,
    );
    if (!record(result)) throw new Error('Invalid Mod API result.');
    if ('deny' in result) throw new Error(String(result['deny']));
    return result['value'];
  };
  // Void log notifications do not suspend their caller's execution, and a
  // sleep is the caller's own time; other calls lend the caller's budget.
  return notice(method) || method === 'clock.sleep'
    ? invoke()
    : call.budget.lend(invoke);
}

const SESSION_FACTS: Partial<Record<ModEvent, keyof ModSessionFacts>> = {
  'session.cwd': 'cwd',
  'session.id': 'id',
  'session.model': 'model',
  'session.root': 'root',
  'session.turns': 'turns',
  'session.usage': 'usage',
};

// Work cannot outlive its dispatch yet, so a sleep ends with its hook.
function sleep(call: ModInvocation, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      clearInterval(watch);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(), Math.min(ms, 2 ** 31 - 1));
    const watch = setInterval(() => {
      // A hook that timed out is no longer live while its catch recovers.
      if (!call.live || callAbandoned(call))
        settle(new Error('Mod sleep ended with its hook.'));
    }, 5);
  });
}

function abortTurn(turnId: string): Promise<void> {
  const id = ++serial;
  return new Promise<void>((resolve, reject) => {
    turnAborts.set(id, { resolve, reject });
    send({ type: 'turn-abort', id, turnId });
  }).finally(() => turnAborts.delete(id));
}

function cancelAbandonedOperations(): void {
  const cancelled: number[] = [];
  for (const [id, operation] of hostOperations) {
    if (!callAbandoned(operation.parent)) continue;
    hostOperations.delete(id);
    cancelled.push(id);
    operation.reject(new Error('Mod tool continuation is no longer active.'));
  }
  if (cancelled.length) send({ type: 'host-cancel', ids: cancelled });
}

async function executeHostTool(
  input: ModInput,
  frames: ModFrame[],
  parent?: ModInvocation,
): Promise<unknown> {
  assertLive(parent);
  if (++operations > 4096 || hostOperations.size >= 32)
    throw new Error('Mod host operation limit exceeded.');
  const id = ++serial;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      hostOperations.set(id, { parent, frames, resolve, reject });
      timer = setInterval(cancelAbandonedOperations, 5);
      send({ type: 'host-call', id, input: input as ModToolCallInput });
    });
  } finally {
    clearInterval(timer);
    hostOperations.delete(id);
    updateActivity();
  }
}

port.on('message', async (request: ModWorkerRequest) => {
  if (
    request.type === 'native' ||
    request.type === 'host-result' ||
    request.type === 'tool-check'
  ) {
    if (!busy || request.root !== rootId) return;
    if (request.phase < phase) return;
    phase = request.phase;
  }
  if (request.type === 'native') {
    if (!hostOperations.has(request.id)) return;
    native = request.id;
    updateActivity();
    return;
  }
  if (request.type === 'host-result') {
    const operation = hostOperations.get(request.id);
    if (!operation) return;
    if (native === request.id) native = undefined;
    updateActivity();
    hostOperations.delete(request.id);
    if (request.error !== undefined) operation.reject(new Error(request.error));
    else operation.resolve(request.result);
    return;
  }
  if (request.type === 'turn-abort-result') {
    if (!busy || request.root !== rootId) return;
    const pending = turnAborts.get(request.id);
    if (request.error !== undefined) pending?.reject(new Error(request.error));
    else pending?.resolve();
    return;
  }
  if (request.type === 'tool-check') {
    if (request.id <= lastCheck) return;
    lastCheck = request.id;
    const operation = hostOperations.get(request.operation);
    checks++;
    updateActivity();
    try {
      if (!busy || !operation) throw new Error('Mod tool operation has ended.');
      assertLive(operation.parent);
      const result = (await dispatch(
        'tool.check',
        request.input,
        engineOrigin,
        operation.frames,
        async () => request.verdict,
        0,
        operation.parent,
      )) as ModToolCheckResult;
      assertLive(operation.parent);
      send({ type: 'check-result', id: request.id, result }, request.root);
    } catch (error) {
      send(
        {
          type: 'check-result',
          id: request.id,
          error: String(error).slice(0, 4000),
        },
        request.root,
      );
    } finally {
      if (request.root === rootId) {
        checks--;
        updateActivity();
      }
    }
    return;
  }
  if (busy) {
    send(
      {
        type: 'error',
        message: 'Concurrent Mod dispatch is not supported.',
      },
      request.root,
    );
    return;
  }
  if (request.root <= rootId) return;
  busy = true;
  rootId = request.root;
  phase = reportedPhase = request.phase;
  toolRoot = request.type === 'tool';
  native = reportedNative = undefined;
  activityRevision = 0;
  checks = 0;
  lastCheck = 0;
  builtinTool = request.type === 'tool' ? request.builtinTool : undefined;
  facts = request.facts;
  epoch++;
  logChars = 0;
  operations = 0;
  rootBudget = new ModBudget(
    request.type === 'end' ? MOD_END_TIMEOUT_MS : 60_000,
  );
  try {
    let result: unknown;
    if (request.type === 'load') {
      if (realms.length) throw new Error('Mods already loaded.');
      surface = request.surface;
      version = request.version;
      sites = request.sites ?? [];
      supported = MOD_EVENTS.filter(
        (event) =>
          !MOD_HOST_EVENTS.includes(event) ||
          (event === 'prompt.submit'
            ? request.prompts === true
            : sites.length > 0),
      );
      for (const plugin of request.plugins) {
        assertLive();
        const realm = new Realm(plugin, realms.length);
        realms.push(realm);
        try {
          await realm.load();
        } catch (error) {
          throw new Error('Mod ' + plugin.name + ': ' + String(error));
        }
        const skipped = [
          ...new Set(
            realm.patterns.filter(
              (pattern) => !supported.some((e) => patternMatches(pattern, e)),
            ),
          ),
        ].sort();
        if (skipped.length && plugin.unsupportedEvents === 'reject')
          throw new Error(
            'Mod ' +
              plugin.name +
              ': Mod events not supported: ' +
              skipped.join(', '),
          );
        if (skipped.length)
          send({
            type: 'log',
            plugin: plugin.name,
            to: 'transcript',
            text:
              'Hooks for unsupported events will not run: ' +
              skipped.join(', '),
          });
      }
      starting = true;
      await dispatch(
        'session.start',
        { cwd: request.cwd, surface, isInteractive: surface === 'terminal' },
        engineOrigin,
        [],
        async (e) => ({ cwd: e['cwd'] }),
      );
      const hooked = (event: ModEvent) =>
        !supported.includes(event)
          ? []
          : realms
              .filter((realm) =>
                realm.patterns.some((pattern) =>
                  patternMatches(pattern, event),
                ),
              )
              .map((realm) => realm.plugin.name);
      result = {
        commands: [...commands.values()],
        tools: hooked('tool.call').length + hooked('tool.check').length > 0,
        turnStart: hooked('turn.start').length > 0,
        promptSubmit: hooked('prompt.submit'),
        turnComplete: hooked('turn.complete'),
        render: hooked('ui.render'),
      };
    } else if (request.type === 'command') {
      if (!commands.has(request.command))
        throw new Error('Unknown Mod command.');
      result = await dispatch(
        'command.run',
        {
          command: request.command,
          args: request.args,
          origin: { kind: surface === 'terminal' ? 'composer' : 'sdk' },
          presentation:
            surface === 'terminal' && request.presentation
              ? request.presentation
              : { isFullscreen: false, columns: 80 },
        },
        engineOrigin,
        [],
        async (e) => {
          throw new Error('No Mod hook answered /' + String(e['command']));
        },
      );
    } else if (request.type === 'tool') {
      result = await dispatch(
        'tool.call',
        request.input,
        engineOrigin,
        [],
        executeHostTool,
      );
    } else if (request.type === 'turn-start') {
      result = await dispatch(
        'turn.start',
        { ...request.input },
        engineOrigin,
        [],
        async (e) => ({ turnId: e['turnId'] }),
      );
    } else if (request.type === 'prompt-submit') {
      // The prompt that enters is the one that arrives beneath the hooks.
      let arrived: ModInput | undefined;
      const settled = await dispatch(
        'prompt.submit',
        { ...request.input },
        engineOrigin,
        [],
        async (e) => {
          arrived = {
            text: e['text'],
            ...(e['context'] !== undefined && { context: e['context'] }),
          };
          return { ...arrived, origin: e['origin'] };
        },
      );
      result =
        record(settled) && typeof settled['drop'] === 'string'
          ? { drop: settled['drop'], byHook: true }
          : (arrived ?? {
              drop: 'a hook answered without passing the prompt on',
              byHook: false,
            });
    } else if (request.type === 'render') {
      if (!sites.includes(request.input.component))
        throw new Error('This host draws no ' + request.input.component + '.');
      result = await dispatch(
        'ui.render',
        { ...request.input },
        engineOrigin,
        [],
        async () => ENGINE_NODE,
      );
    } else if (request.type === 'turn-complete') {
      result = await dispatch(
        'turn.complete',
        { ...request.input },
        engineOrigin,
        [],
        async (e) => ({
          text: e['answer'],
          ...(e['usage'] === undefined ? {} : { usage: e['usage'] }),
        }),
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
    if (hostOperations.size)
      send({ type: 'host-cancel', ids: [...hostOperations.keys()] });
    for (const operation of [
      ...hostOperations.values(),
      ...turnAborts.values(),
    ]) {
      operation.reject(new Error('Mod root dispatch has ended.'));
    }
    hostOperations.clear();
    turnAborts.clear();
    starting = false;
    builtinTool = undefined;
    rootBudget = undefined;
    native = reportedNative = undefined;
    toolRoot = false;
    busy = false;
  }
});
