/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import { JSException, MAX_STACK_SIZE, QuickJS } from 'quickjs-wasi';
import { PRELUDE_SOURCE } from './prelude.js';
import {
  SCRIPT_IMAGE_TYPES,
  SCRIPT_LIMIT_ERRORS,
  SCRIPT_LIMITS,
  type HostMessage,
  type ScriptStartMessage,
  type ScriptStatus,
  type ScriptErrorKind,
  type ScriptLimitKind,
  type StoreWrite,
  type ScriptWorkerData,
  type WorkerMessage,
} from './types.js';

function locate(
  message: string,
  stack: string | undefined,
  code: string,
): string {
  // Only guest source locations belong in diagnostics, never the host stack.
  // Helper frames such as assert() live in the prelude; use the first guest frame.
  const location = stack?.match(/[\s(]codemode\.js:(\d+):(\d+)/);
  if (!location) return message;
  // The async wrapper occupies one line before the submitted function body.
  const line = Number(location[1]) - 1;
  const source = code.split(/\r\n|[\n\r\u2028\u2029]/)[line - 1];
  if (source === undefined) return message;
  return `${message}\nat code:${line}:${location[2]}\n${source.slice(0, 500)}`;
}

function describeScriptError(error: unknown, code: string): string {
  if (!(error instanceof JSException))
    return error instanceof Error ? error.message : 'Script failed';
  return locate(`${error.name}: ${error.message}`, error.stack, code);
}

async function main(data: ScriptWorkerData): Promise<void> {
  let interrupt: Int32Array | undefined;
  let finished = false;
  let trackRejection: ReturnType<QuickJS['newFunction']> | undefined;
  let outputBytes = 0;
  let outputItems = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let sequence = 0;
  let code = '';
  let started = false;
  let returnValue: string | undefined;
  const maxSyncMs = data.maxSyncMs ?? SCRIPT_LIMITS.maxSyncMs;
  /** When the host last handed control to the guest; the interrupt handler measures from here. */
  let entered = performance.now();
  const seen = new Set<number>();
  const pending = new Set<number>();
  const names = new Set<string>();
  const searches = new Set<number>();
  let searchSequence = 0;
  /** Accepts a call id the guest announced with 'attempt' and has not used yet. */
  const claim = (id: number): boolean => {
    if (!Number.isSafeInteger(id) || id < 1 || id > sequence || seen.has(id))
      return false;
    seen.add(id);
    pending.add(id);
    return true;
  };
  const post = (message: WorkerMessage) => parentPort?.postMessage(message);
  interface FinishOptions {
    errorKind?: ScriptErrorKind;
    limitKind?: ScriptLimitKind;
    storeWrites?: StoreWrite[];
  }
  const finish = (
    status: Exclude<ScriptStatus, 'cancelled' | 'timeout'>,
    error?: string,
    options: FinishOptions = {},
  ) => {
    if (finished) return;
    finished = true;
    post({
      type: 'done',
      status,
      ...(options.errorKind ? { errorKind: options.errorKind } : {}),
      ...(options.limitKind ? { limitKind: options.limitKind } : {}),
      ...(options.storeWrites?.length
        ? { storeWrites: options.storeWrites }
        : {}),
      ...(error === undefined ? {} : { error: error.slice(0, 4000) }),
      ...(pending.size ? { pendingCallIds: [...pending] } : {}),
      ...(returnValue !== undefined && status === 'completed'
        ? { returnValue }
        : {}),
    });
  };
  // Attach before the first await: a prewarmed worker may receive its start
  // message while the VM is still being created.
  const early: HostMessage[] = [];
  let ready = false;
  parentPort?.on('message', (message: HostMessage) => {
    if (ready) handleHostMessage(message);
    else early.push(message);
  });
  const vm = await QuickJS.create({
    wasm: data.wasm,
    memoryLimit: SCRIPT_LIMITS.memoryBytes,
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => {
      if (finished) return true;
      if (interrupt !== undefined && Atomics.load(interrupt, 0) !== 0) return true;
      // Only runs while guest code executes, so idle awaits never trip it.
      if (performance.now() - entered <= maxSyncMs) return false;
      finished = true;
      post({
        type: 'done',
        status: 'timeout',
        error: `Script ran ${Math.round(maxSyncMs / 1000)}s without awaiting a tool call or returning; interrupted as a runaway loop. Await each call and split long computations.`,
        ...(pending.size ? { pendingCallIds: [...pending] } : {}),
      });
      return true;
    },
    onUnhandledRejection: (promise, reason, handled) => {
      if (trackRejection)
        vm.withScope(() =>
          vm.callFunction(
            trackRejection!,
            vm.undefined,
            promise,
            reason,
            handled ? vm.true : vm.false,
          ),
        );
    },
    // Never forward engine diagnostics to the CLI terminal.
    wasi: (memory) => ({
      fd_write: (_fd, iovs, count, written) => {
        const view = new DataView(memory.buffer);
        let size = 0;
        for (let i = 0; i < count; i++)
          size += view.getUint32(iovs + i * 8 + 4, true);
        view.setUint32(written, size, true);
        return 0;
      },
    }),
  });
  const exceeded = (limitKind: ScriptLimitKind) =>
    finish('limit', SCRIPT_LIMIT_ERRORS[limitKind], { limitKind });
  /** Charges text against the shared output budget; false once the budget is spent. */
  const account = (text: string): boolean => {
    outputBytes += Buffer.byteLength(text);
    if (
      outputBytes > SCRIPT_LIMITS.outputBytes ||
      ++outputItems > SCRIPT_LIMITS.outputItems
    ) {
      exceeded('output');
      return false;
    }
    return true;
  };
  const emit = (text: string) => {
    if (account(text)) post({ type: 'output', text });
  };
  const bridge = vm.newFunction('codeModeBridge', (kind, a, b, c) => {
    if (finished) return vm.undefined;
    switch (kind.toString()) {
      case 'attempt':
        sequence = a.toNumber();
        if (sequence > SCRIPT_LIMITS.calls) exceeded('calls');
        break;
      case 'output':
        emit(a.toString());
        break;
      case 'search': {
        const id = a.toNumber();
        let request: unknown;
        try {
          request = JSON.parse(b.toString());
        } catch {
          request = undefined;
        }
        const { query, limit, namespace } = (request ?? {}) as {
          query?: unknown;
          limit?: unknown;
          namespace?: unknown;
        };
        if (
          id !== ++searchSequence ||
          typeof query !== 'string' ||
          !Number.isSafeInteger(limit) ||
          (namespace !== undefined && typeof namespace !== 'string')
        ) {
          finish('error', 'Invalid search bridge call');
          break;
        }
        searches.add(id);
        post({
          type: 'search',
          id,
          query,
          limit: limit as number,
          ...(namespace === undefined ? {} : { namespace }),
        });
        break;
      }
      case 'image': {
        const mimeType = a.toString();
        const data = b.toString();
        imageBytes += data.length;
        if (
          !SCRIPT_IMAGE_TYPES.includes(mimeType) ||
          ++imageCount > SCRIPT_LIMITS.images ||
          imageBytes > SCRIPT_LIMITS.imageBytes
        ) {
          exceeded('images');
          break;
        }
        post({ type: 'image', mimeType, data });
        break;
      }
      case 'imageFile': {
        const id = a.toNumber();
        const path = b.toString();
        if (!claim(id)) {
          finish('error', 'Invalid image bridge call');
          break;
        }
        post({ type: 'imageFile', id, path });
        break;
      }
      case 'call': {
        const id = a.toNumber();
        const name = b.toString();
        const args = c.toString();
        // toJSON may issue another call before the outer serialization returns.
        if (!names.has(name) || !claim(id)) {
          finish('error', 'Invalid tool bridge call');
          break;
        }
        post(
          Buffer.byteLength(args) > SCRIPT_LIMITS.argumentBytes
            ? {
                type: 'call',
                id,
                name,
                args: '',
                argumentError: 'Tool arguments exceed the byte limit',
              }
            : { type: 'call', id, name, args },
        );
        break;
      }
      default:
        finish('error', 'Invalid bridge message');
    }
    return vm.undefined;
  });
  const fail = (error: unknown) => {
    const syntax = error instanceof JSException && error.name === 'SyntaxError';
    finish(
      'error',
      describeScriptError(error, code) +
        // Escaping embedded source is the usual cause; say so only when it can apply.
        (syntax && code.includes('`')
          ? '\nIn template literals, escape embedded backticks as \\` and ${ as \\${.'
          : ''),
      { errorKind: syntax ? 'syntax' : 'script_exception' },
    );
  };
  let settle: ReturnType<typeof vm.newFunction> | undefined;
  let settleSearch: typeof settle;
  let format: typeof settle;
  let api: typeof settle;
  const drain = () => {
    try {
      vm.executePendingJobs();
      // Guest/host promise adoption finishes on the host microtask queue over an
      // unspecified number of turns; a macrotask runs only once that queue drains.
      setImmediate(() => {
        if (!finished && pending.size === 0 && searches.size === 0)
          finish(
            'incomplete',
            'Script is waiting on a promise with no pending tool calls',
          );
      });
    } catch (error) {
      fail(error);
    }
  };
  const start = (message: ScriptStartMessage) => {
    started = true;
    code = message.code;
    interrupt = new Int32Array(message.interrupt);
    for (const name of message.tools) names.add(name);
    api = vm.withScope((scope) =>
      scope.escape(
        vm.callFunction(
          vm.evalCode(PRELUDE_SOURCE, 'codemode-prelude.js'),
          vm.undefined,
          bridge,
          vm.newString(JSON.stringify(message.tools)),
          vm.newString(JSON.stringify(message.directTools ?? [])),
          vm.newString(JSON.stringify(message.toolCatalog ?? [])),
          vm.newString(JSON.stringify(message.storeSnapshot ?? {})),
          vm.newString(message.storeError ?? ''),
          vm.newString(JSON.stringify(message.namespaces ?? [])),
        ),
      ),
    );
    settle = api.getProp('settle');
    settleSearch = api.getProp('settleSearch');
    format = api.getProp('format');
    trackRejection = api.getProp('trackRejection');
    const task = vm.evalCode(`(async () => {\n${code}\n})()`, 'codemode.js');
    vm.markPromiseHandled(task);
    void vm.resolvePromise(task).then((result) => {
      if (finished) return;
      try {
        const describe = (
          value: ReturnType<typeof vm.newString>,
          unhandled = false,
        ) => {
          let stack: string | undefined;
          let name: string | undefined;
          try {
            vm.withScope(() => {
              const location = value.getProp('stack');
              stack = location.isUndefined ? undefined : location.toString();
              name = value.getProp('name').toString();
            });
          } catch {
            /* Primitive rejections do not have properties. */
          }
          const kind =
            name === 'StoreRestoreError'
              ? 'store_restore'
              : unhandled
                ? 'unhandled_rejection'
                : name === 'SyntaxError'
                  ? 'syntax'
                  : name === 'ToolCallError'
                    ? 'tool_call'
                    : 'script_exception';
          finish(
            'error',
            locate(
              (unhandled ? 'Unhandled promise rejection: ' : '') +
                value.toString(),
              stack,
              code,
            ),
            { errorKind: kind },
          );
        };
        if ('error' in result) {
          describe(result.error);
          return;
        }
        const rejected = vm.withScope((scope) =>
          scope.escape(vm.callFunction(api!.getProp('rejection'), api!)),
        );
        if (!rejected.isUndefined) {
          vm.withScope(() => describe(rejected.getProp('reason'), true));
          rejected.dispose();
          return;
        }
        rejected.dispose();
        if (pending.size > 0) {
          finish('incomplete', 'Script returned with pending tool calls');
          return;
        }
        if (!result.value.isUndefined) {
          vm.withScope(() => {
            const rendered = vm.callFunction(format!, api!, result.value);
            if (rendered.isUndefined) return;
            // Charged against the output budget, but delivered with 'done' so a
            // poll boundary cannot separate it from the completion.
            const text = rendered.toString();
            if (account(text)) returnValue = text;
          });
        }
        const writes = vm.withScope(() =>
          vm.callFunction(api!.getProp('storeWrites'), api!).toString(),
        );
        finish('completed', undefined, {
          storeWrites: JSON.parse(writes) as StoreWrite[],
        });
      } catch (error) {
        fail(error);
      }
    }, fail);
    task.dispose();
    drain();
  };
  const handleHostMessage = (message: HostMessage) => {
    if (finished) return;
    entered = performance.now();
    if (message?.type === 'start') {
      if (
        started ||
        typeof message.code !== 'string' ||
        !Array.isArray(message.tools) ||
        (message.directTools !== undefined &&
          !Array.isArray(message.directTools)) ||
        (message.toolCatalog !== undefined &&
          (!Array.isArray(message.toolCatalog) ||
            !message.toolCatalog.every(
              (item) =>
                item &&
                typeof item.name === 'string' &&
                typeof item.description === 'string',
            ))) ||
        (message.namespaces !== undefined &&
          (!Array.isArray(message.namespaces) ||
            !message.namespaces.every(
              (item) =>
                item &&
                typeof item.name === 'string' &&
                Array.isArray(item.tools),
            ))) ||
        !(message.interrupt instanceof SharedArrayBuffer)
      ) {
        finish('error', 'Invalid start message');
        return;
      }
      try {
        start(message);
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (started && message?.type === 'searched') {
      if (
        !searches.delete(message.id) ||
        !Array.isArray(message.names) ||
        !message.names.every((name) => typeof name === 'string')
      ) {
        finish('error', 'Invalid host search result');
        return;
      }
      try {
        vm.withScope(() =>
          vm.callFunction(
            settleSearch!,
            api!,
            vm.newNumber(message.id),
            vm.newString(JSON.stringify(message.names)),
          ),
        );
        drain();
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (
      !started ||
      !message ||
      message.type !== 'settle' ||
      typeof message.ok !== 'boolean' ||
      typeof message.payload !== 'string' ||
      !pending.delete(message.id) ||
      Buffer.byteLength(message.payload) > SCRIPT_LIMITS.resultBytes
    ) {
      finish('error', 'Invalid host result');
      return;
    }
    try {
      vm.withScope(() =>
        vm.callFunction(
          settle!,
          api!,
          vm.newNumber(message.id),
          message.ok ? vm.true : vm.false,
          vm.newString(message.payload),
        ),
      );
      if (message.ok) post({ type: 'received', id: message.id });
      drain();
    } catch (error) {
      fail(error);
    }
  };
  ready = true;
  for (const message of early.splice(0)) handleHostMessage(message);
}

if (parentPort) {
  void main(workerData as ScriptWorkerData).catch(() => {
    parentPort?.postMessage({
      type: 'done',
      status: 'error',
      error: 'Unable to initialize the script VM',
      errorKind: 'runtime_start',
    } satisfies WorkerMessage);
    // Initialization failed before the message loop could become ready.
    // Close the port so an unused prewarmed worker cannot remain alive forever.
    parentPort?.close();
  });
}
