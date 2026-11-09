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
  type ModQueuedPrompt,
  type ModModelCompleteInput,
  type ModModelCompleteResult,
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
  modelCompleteCall,
  promptSubmitCall,
  record,
  validateInput,
  validateResult,
  validModelResult,
  type ModEvent,
  type ModFrame,
  type ModInput,
  type ModInvocation,
  type ModModelScope,
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
// $.prompt.submit calls waiting for the host to queue what they submitted.
const promptQueues = new Map<
  number,
  { resolve: (refused?: string) => void; reject: (error: Error) => void }
>();
// $.model.complete calls the host is running, by host operation id.
const modelOperations = new Map<
  number,
  {
    parent?: ModInvocation;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }
>();
// The AbortController behind each running call's `options.signal`, by the
// caller's plugin and the token its guest gave the call.
const modelSignals = new Map<string, AbortController>();
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
// Whether the host runs what `$.prompt.submit` submits.
let submitsPrompts = false;
// Whether the host runs `$.model.complete` calls.
let runsModels = false;
// The events this host runs: those it raises only where it draws need a site.
let supported: readonly ModEvent[] = MOD_EVENTS;
// A render hook that keeps failing the same way is said once per load.
const renderSkips = new Set<string>();
let facts: ModSessionFacts | undefined;
const send = (reply: ModReply, root = rootId) =>
  port.postMessage({ ...reply, root, phase });
const abandoned = () =>
  Atomics.load(cancelled, 0) !== 0 || rootBudget?.expired === true;
// The timeout timer cannot fire during a synchronous guest slice.
const modelAbandoned = (scope?: ModModelScope) =>
  scope !== undefined &&
  (scope.signal.aborted || performance.now() >= scope.deadline);
const callAbandoned = (call?: ModInvocation): boolean =>
  abandoned() ||
  Boolean(
    call &&
      (call.epoch !== epoch ||
        call.closed ||
        modelAbandoned(call.modelScope) ||
        (call.parent && callAbandoned(call.parent))),
  );
const assertLive = (call?: ModInvocation, modelScope?: ModModelScope) => {
  if (callAbandoned(call) || modelAbandoned(modelScope))
    throw new Error('Mod dispatch cancelled or timed out.');
};
const assertBudget = (call: ModInvocation) => {
  if (call.budget.expired) throw new ModTimeoutError();
};

// The root's clock stops while all it waits on is the host: a native tool
// or a model call.
function updateActivity(): void {
  if (!busy || !rootBudget) return;
  const waiting =
    !checks && toolRoot && native !== undefined && hostOperations.has(native)
      ? native
      : modelOperations.keys().next().value;
  const lending =
    waiting !== undefined &&
    !abandoned() &&
    !executing &&
    !guestNotifications.size &&
    !realms.some((realm) => realm.runtime.hasPendingJob()) &&
    ![...calls.values()].some((call) => call.live && !call.budget.lending);
  if (lending !== rootBudget.lending) {
    if (lending) rootBudget.pause();
    else rootBudget.resume();
  }
  const operation = lending ? waiting : undefined;
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
  private executingCall?: ModInvocation;
  private notifying = false;
  constructor(readonly plugin: ModPlugin) {
    this.runtime.setMemoryLimit(64 * 1024 * 1024);
    this.runtime.setMaxStackSize(1024 * 1024);
    this.runtime.setInterruptHandler(() => {
      if (performance.now() >= this.sliceDeadline) return true;
      if (this.notifying) return false;
      if (abandoned()) return true;
      const active = this.executingCall;
      // A pending promise job has no invocation ID. Per-call limits are
      // enforced at its own hook and API boundaries instead.
      return (
        active !== undefined && (active.budget.expired || callAbandoned(active))
      );
    });
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
      // A model call waits on the host as a next does, so its clock may stop.
      if (method !== 'next' && method !== 'model.complete')
        guestNotifications.add(task);
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
        assertBudget(call);
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
        return call?.aborted || call?.budget.expired || callAbandoned(call)
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
  execute<T>(action: () => T, call?: ModInvocation): T {
    executing++;
    updateActivity();
    this.sliceDeadline =
      performance.now() + (this.notifying ? 25 : MOD_TIMEOUT_MS);
    this.executingCall = call;
    try {
      return action();
    } finally {
      this.executingCall = undefined;
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
  async invoke(
    call: ModInvocation,
    method: 'run' | 'recover',
    data: ModInput,
  ): Promise<unknown> {
    assertLive(call);
    assertBudget(call);
    const input = this.vm.newString(JSON.stringify({ ...data, id: call.id }));
    try {
      return await this.settle(
        this.execute(
          () =>
            this.vm.unwrapResult(
              this.vm.callMethod(this.guest, method, [input]),
            ),
          call,
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
    assertBudget(call);
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
  modelScope = parent?.modelScope,
): Promise<unknown> {
  assertLive(parent, modelScope);
  if (index === 0 && ++operations > 4096)
    throw new Error('Mod dispatch operation limit exceeded.');
  const realm = realms[index];
  if (!realm) return bottom(input, frames, parent);
  let owner = parent;
  const next = (e: ModInput, nested: ModFrame[]) =>
    dispatch(event, e, origin, nested, bottom, index + 1, owner, modelScope);
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
    modelScope,
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
        realm.invoke(call, 'run', {
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
        last: call.last ? (call.promptFallback ?? call.last) : undefined,
        id: ++serial,
        budget: new ModBudget(1000),
        live: true,
        recovering: true,
        aborted: false,
      };
      calls.set(recovery.id, recovery);
      try {
        const value = await bounded(recovery, () =>
          realm.invoke(recovery!, 'recover', {
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
  const models = method === 'model.complete';
  const call = calls.get(id);
  if (!call?.live || callAbandoned(call)) {
    if (models) return ABORTED_MODEL_CALL;
    throw new Error('Mod continuation is no longer active.');
  }
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
  // A caller's `options.signal` aborted: not an event, so no hook hears it.
  if (method === 'model.abort') {
    modelSignals.get(call.plugin + ':' + String(payload['token']))?.abort();
    return undefined;
  }
  assertBudget(call);
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
  const plugin = realms[call.plugin].plugin;
  if (models && !runsModels)
    throw new Error('Mod model.complete: this host runs no model calls.');
  // A submitted prompt raises prompt.submit as a typed one does, through
  // every hook but the caller's. What arrives beneath them last is queued once
  // they have all answered. Its hooks do not run beneath the caller's, so a
  // call the caller does not await still queues after the caller returns.
  const submits = method === 'prompt.submit';
  const input = submits
    ? promptSubmitCall(value, plugin.name)
    : models
      ? modelCompleteCall(value)
      : value;
  if (!submits) validateInput(method, input, {});
  // No hook hears a prompt the host would not run, or one with no words.
  else if (!submitsPrompts)
    return { drop: 'this host does not run prompts a Mod submits' };
  else if (!String((input as ModInput)['text']).trim())
    return { drop: 'the prompt is empty' };
  else if (overPromptBudget(input as ModInput))
    return { drop: 'the prompt is too long for a Mod payload' };
  const detached = notice(method) || submits;
  let arrived: ModInput | undefined;
  // The original call's deadline applies even while a hook is rewriting it.
  const model = models ? new AbortController() : undefined;
  const signalKey = call.plugin + ':' + String(payload['token']);
  let modelScope = call.modelScope;
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  if (model) {
    const timeout = (input as ModInput)['timeoutMs'];
    const deadline =
      typeof timeout === 'number' ? performance.now() + timeout : Infinity;
    modelScope = {
      signal: modelScope
        ? AbortSignal.any([model.signal, modelScope.signal])
        : model.signal,
      deadline: Math.min(deadline, modelScope?.deadline ?? Infinity),
    };
    if (typeof timeout === 'number')
      modelTimer = setTimeout(() => model.abort(), timeout);
    modelSignals.set(signalKey, model);
  }
  const invoke = async () => {
    const result = await dispatch(
      method,
      input as ModInput,
      { plugin: plugin.name, tier: 'user' },
      frames,
      async (e) => {
        assertLive(detached ? undefined : call, modelScope);
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
                methods: [...MOD_METHODS, ...MOD_READS]
                  .filter((name) => name !== 'prompt.submit' || submitsPrompts)
                  .filter((name) => name !== 'model.complete' || runsModels)
                  .sort(),
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
        if (model && modelScope)
          return { value: await completeModel(e, modelScope, call) };
        if (submits) {
          arrived = {
            text: e['text'],
            ...(e['context'] !== undefined && { context: e['context'] }),
            origin: e['origin'],
          };
          return arrived;
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
      detached ? undefined : call,
      modelScope,
    );
    if (modelScope) assertLive(model ? call : undefined, modelScope);
    if (!record(result)) throw new Error('Invalid Mod API result.');
    if (submits) return queueArrived(result, arrived, plugin.name);
    if ('deny' in result) throw new Error(String(result['deny']));
    return result['value'];
  };
  // Void log notifications do not suspend their caller's execution, and a
  // sleep is the caller's own time; nor does a submit, whose hooks are the
  // other Mods' time and may still run after the caller has moved on. Other
  // calls lend the caller's budget.
  try {
    return await (detached || method === 'clock.sleep'
      ? invoke()
      : call.budget.lend(invoke));
  } catch (error) {
    if (model && (modelAbandoned(modelScope) || callAbandoned(call))) {
      model.abort();
      return ABORTED_MODEL_CALL;
    }
    throw error;
  } finally {
    clearTimeout(modelTimer);
    if (model && modelSignals.get(signalKey) === model)
      modelSignals.delete(signalKey);
  }
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

// A hook that passed the prompt on more than once queues it once, as it last
// arrived, and the call resolves to that.
// A prompt is held to half a Mod payload, as a typed one is, so what the call
// resolves to, which echoes it, always fits: it is never refused once queued.
const overPromptBudget = (prompt: ModInput) =>
  Buffer.byteLength(JSON.stringify(prompt)) > MOD_MAX_BYTES / 2;

async function queueArrived(
  result: ModInput,
  arrived: ModInput | undefined,
  plugin: string,
): Promise<ModInput> {
  if (typeof result['drop'] === 'string') return result;
  if (!arrived)
    return { drop: 'a hook answered without passing the prompt on' };
  if (!String(arrived['text']).trim())
    return { drop: 'a hook left the prompt empty' };
  if (overPromptBudget(arrived))
    return { drop: 'a hook made the prompt too long for a Mod payload' };
  const context = arrived['context'] as string[] | undefined;
  const origin = arrived['origin'] as ModInput;
  const refused = await queuePrompt({
    plugin,
    text: String(arrived['text']),
    ...(context !== undefined && { context }),
    ...(origin['asUser'] === true && { asUser: true }),
  });
  return refused === undefined ? arrived : { drop: refused };
}

function queuePrompt(prompt: ModQueuedPrompt): Promise<string | undefined> {
  const id = ++serial;
  return new Promise<string | undefined>((resolve, reject) => {
    promptQueues.set(id, { resolve, reject });
    send({ type: 'prompt-queue', id, prompt });
  }).finally(() => promptQueues.delete(id));
}

function cancelAbandonedOperations(): void {
  const cancelled: number[] = [];
  for (const [id, operation] of hostOperations) {
    if (!callAbandoned(operation.parent)) continue;
    hostOperations.delete(id);
    cancelled.push(id);
    operation.reject(new Error('Mod tool continuation is no longer active.'));
  }
  for (const [id, operation] of modelOperations) {
    if (!callAbandoned(operation.parent)) continue;
    modelOperations.delete(id);
    cancelled.push(id);
    operation.reject(new Error('Mod model call ended with its dispatch.'));
  }
  if (cancelled.length) send({ type: 'host-cancel', ids: cancelled });
}

const ABORTED_MODEL_CALL: ModModelCompleteResult = Object.freeze({
  isAnswered: false,
  reason: 'aborted',
  usage: Object.freeze({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }),
}) as ModModelCompleteResult;

// The host runs the call; the caller's signal cuts it, resolving `aborted`.
async function completeModel(
  input: ModInput,
  { signal, deadline }: ModModelScope,
  parent?: ModInvocation,
): Promise<unknown> {
  assertLive(parent);
  if (signal.aborted) return ABORTED_MODEL_CALL;
  if (++operations > 4096 || hostOperations.size + modelOperations.size >= 32)
    throw new Error('Mod host operation limit exceeded.');
  const id = ++serial;
  // A hook that passed `null` or `false` down sends no system prompt.
  const { system, ...request } = input;
  const sent = {
    ...request,
    ...(typeof system === 'string' && { system }),
  } as unknown as ModModelCompleteInput;
  let timer: ReturnType<typeof setInterval> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      modelOperations.set(id, { parent, resolve, reject });
      abort = () => {
        if (!modelOperations.delete(id)) return;
        send({ type: 'host-cancel', ids: [id] });
        resolve(ABORTED_MODEL_CALL);
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setInterval(cancelAbandonedOperations, 5);
      send({ type: 'model-complete', id, input: sent, deadline });
      updateActivity();
    });
  } finally {
    clearInterval(timer);
    if (abort) signal.removeEventListener('abort', abort);
    modelOperations.delete(id);
    updateActivity();
  }
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
  if (request.type === 'model-result') {
    if (!busy || request.root !== rootId) return;
    const operation = modelOperations.get(request.id);
    if (!operation) return;
    modelOperations.delete(request.id);
    updateActivity();
    if (request.error !== undefined)
      operation.reject(new Error('Mod model.complete: ' + request.error));
    else if (!validModelResult(request.result))
      operation.reject(new Error('Mod model.complete: invalid host result.'));
    else operation.resolve(request.result);
    return;
  }
  if (request.type === 'prompt-queue-result') {
    if (!busy || request.root !== rootId) return;
    promptQueues.get(request.id)?.resolve(request.refused);
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
      submitsPrompts = request.submits === true;
      runsModels = request.models === true;
      supported = MOD_EVENTS.filter(
        (event) =>
          !MOD_HOST_EVENTS.includes(event) ||
          (event === 'prompt.submit'
            ? request.prompts === true
            : sites.length > 0),
      );
      for (const plugin of request.plugins) {
        assertLive();
        const realm = new Realm(plugin);
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
    if (hostOperations.size || modelOperations.size)
      send({
        type: 'host-cancel',
        ids: [...hostOperations.keys(), ...modelOperations.keys()],
      });
    for (const operation of [
      ...hostOperations.values(),
      ...modelOperations.values(),
      ...turnAborts.values(),
      ...promptQueues.values(),
    ]) {
      operation.reject(new Error('Mod root dispatch has ended.'));
    }
    hostOperations.clear();
    modelOperations.clear();
    modelSignals.clear();
    turnAborts.clear();
    promptQueues.clear();
    starting = false;
    builtinTool = undefined;
    rootBudget = undefined;
    native = reportedNative = undefined;
    toolRoot = false;
    busy = false;
  }
});
