/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Worker } from 'node:worker_threads';
import { loadWasmBinary } from '../utils/fileUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { StoreRestoreError } from './store.js';
import {
  ScriptWorkers,
  WorkerWaitTimeoutError,
  type ScriptWorkerOptions,
} from './workers.js';
import {
  SCRIPT_IMAGE_TYPES,
  SCRIPT_LIMIT_ERRORS,
  SCRIPT_LIMITS,
  WORKER_DONE_STATUSES,
  ScriptToolError,
  type HostMessage,
  type JsonObject,
  type JsonValue,
  type ScriptHost,
  type ScriptImage,
  type ScriptLimitKind,
  type ScriptPendingCall,
  type ScriptRequest,
  type ScriptResult,
  type ScriptStartMessage,
  type WorkerMessage,
} from './types.js';

// Replaced by bundle/binary builds; Node packages use the adjacent compiled file.
declare const __CODE_MODE_WORKER__: 'embedded' | 'bundled' | undefined;
let compiledWasm: Promise<WebAssembly.Module> | undefined;

function defaultWorkerUrl(): string | URL {
  return typeof __CODE_MODE_WORKER__ !== 'undefined'
    ? __CODE_MODE_WORKER__ === 'embedded'
      ? './core/src/codemode/worker.js'
      : new URL('./codemode-worker.mjs', import.meta.url)
    : new URL(
        import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
        import.meta.url,
      );
}

async function compileWasm(): Promise<WebAssembly.Module> {
  compiledWasm ??= loadWasmBinary(
    () =>
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore resolved by the existing wasm-binary build plugin
      import('quickjs-wasi/quickjs.wasm?binary'),
    'quickjs-wasi/quickjs.wasm',
  )
    .then((bytes) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>))
    .catch((error: unknown) => {
      compiledWasm = undefined;
      throw error;
    });
  return compiledWasm;
}

let sharedRuntime: ScriptRuntime | undefined;

export class ScriptRuntime {
  private readonly workers: ScriptWorkers;

  /**
   * With `prewarm`, one idle worker with a fresh VM waits for the next script.
   * It is used once and replaced, so isolation stays per execution.
   */
  constructor(
    workerUrl: string | URL = defaultWorkerUrl(),
    options: ScriptWorkerOptions = {},
  ) {
    this.workers = new ScriptWorkers(workerUrl, options);
  }

  static shared(): ScriptRuntime {
    return (sharedRuntime ??= new ScriptRuntime(defaultWorkerUrl(), {
      prewarm: true,
    }));
  }

  async execute(
    request: ScriptRequest,
    host: ScriptHost,
  ): Promise<ScriptResult> {
    const output: string[] = [];
    if (request.signal.aborted) return { status: 'cancelled', output };
    const { timeoutMs } = request;
    const interrupt = new Int32Array(new SharedArrayBuffer(4));
    const acquisition = new AbortController();
    let worker: Worker | undefined;
    let stopped = false;
    let outputBytes = 0;
    let resultBytes = 0;
    let imageBytes = 0;
    const images: ScriptImage[] = [];
    const callNames = new Map<number, string>();
    const pending = new Set<number>();
    const inTransit = new Map<number, JsonValue>();
    const discard = (value: JsonValue) => {
      try {
        host.discardResult?.(value);
      } catch (error) {
        runLogger.warn('[CodeMode] Result invalidation failed', error);
      }
    };
    const discardCall = (id: number) => {
      if (!inTransit.has(id)) return;
      const value = inTransit.get(id)!;
      inTransit.delete(id);
      discard(value);
    };
    const names = new Set(request.tools);
    let searches = 0;
    return new Promise<ScriptResult>((resolve) => {
      const finish = (
        result: Omit<ScriptResult, 'output'>,
        workerPendingIds: readonly number[] = [],
      ) => {
        if (stopped) return;
        stopped = true;
        const pendingCalls: ScriptPendingCall[] = [];
        for (const id of new Set([
          ...pending,
          ...inTransit.keys(),
          ...workerPendingIds,
        ])) {
          const name = callNames.get(id);
          if (name !== undefined)
            pendingCalls.push({
              id,
              name,
              phase: pending.has(id) ? 'executing' : 'awaiting_delivery',
            });
        }
        clearTimeout(timer);
        unsubscribe?.();
        request.signal.removeEventListener('abort', abort);
        acquisition.abort();
        Atomics.store(interrupt, 0, 1);
        // Interrupt is necessary on runtimes where terminate waits for WASM.
        if (worker) this.workers.stop(worker);
        for (const id of inTransit.keys()) discardCall(id);
        resolve({
          ...result,
          output,
          ...(images.length ? { images } : {}),
          ...(pendingCalls.length ? { pendingCalls } : {}),
        });
      };
      const transportError = (error: string) =>
        finish({ status: 'error', errorKind: 'runtime_transport', error });
      const exceeded = (limitKind: ScriptLimitKind) =>
        finish({
          status: 'limit',
          error: SCRIPT_LIMIT_ERRORS[limitKind],
          limitKind,
        });
      /** Charges text against the output budget; false once the budget is spent. */
      const charge = (text: string): boolean => {
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > SCRIPT_LIMITS.outputBytes) {
          exceeded('output');
          return false;
        }
        return true;
      };
      const abort = () => finish({ status: 'cancelled' });
      const print = (text: string): boolean => {
        if (!charge(text)) return false;
        if (output.length >= SCRIPT_LIMITS.outputItems) {
          exceeded('output');
          return false;
        }
        output.push(text);
        request.onOutput?.(text);
        return true;
      };
      /** Admits an image within the cell's budgets; its marker keeps its position among text outputs. */
      const show = (image: ScriptImage): boolean => {
        imageBytes += image.data.length;
        if (
          images.length >= SCRIPT_LIMITS.images ||
          imageBytes > SCRIPT_LIMITS.imageBytes
        ) {
          exceeded('images');
          return false;
        }
        images.push(image);
        request.onImage?.(image);
        return print(`[image ${images.length}: ${image.mimeType}]`);
      };
      /** Registers a worker call id; false once the call budget is spent. */
      const admit = (id: number, name: string): boolean => {
        callNames.set(id, name);
        pending.add(id);
        if (callNames.size > SCRIPT_LIMITS.calls) {
          exceeded('calls');
          return false;
        }
        return true;
      };
      // While child calls are only being authorized and none is executing, the
      // script budget pauses; the worker's own guard catches a VM spinning meanwhile.
      let remaining = timeoutMs;
      let resumedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expire = () =>
        finish({
          status: 'timeout',
          error:
            worker === undefined
              ? `Script timed out: CodeMode execution budget of ${timeoutMs} ms exhausted while waiting for a free worker. Retry after the other scripts finish.`
              : `Script timed out: CodeMode execution budget of ${timeoutMs} ms exhausted. ` +
                'Child tool timeouts do not extend this budget. ' +
                (request.directTools?.includes('Bash')
                  ? 'For longer commands, call Bash directly outside CodeMode or split the work.'
                  : 'Split the work into shorter calls.'),
        });
      const arm = () => {
        resumedAt = Date.now();
        timer = setTimeout(expire, remaining);
      };
      arm();
      const unsubscribe = host.subscribeApprovalWait?.((waiting) => {
        if (stopped) return;
        if (waiting && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          remaining = Math.max(1, remaining - (Date.now() - resumedAt));
        } else if (!waiting && timer === undefined) arm();
      });
      request.signal.addEventListener('abort', abort, { once: true });
      const settle = (id: number, ok: boolean, payload: string) => {
        if (stopped || !pending.delete(id)) return;
        resultBytes += Buffer.byteLength(payload);
        if (resultBytes > SCRIPT_LIMITS.totalResultBytes) {
          exceeded('result');
          return;
        }
        const message: HostMessage = { type: 'settle', id, ok, payload };
        try {
          worker?.postMessage(message);
        } catch {
          transportError('Script worker disconnected');
        }
      };
      const reject = (id: number, name: string, error: unknown) => {
        discardCall(id);
        const failure =
          error instanceof ScriptToolError
            ? error.failure
            : {
                kind: 'execution',
                toolName: name,
                message:
                  error instanceof Error ? error.message : 'Tool call failed',
              };
        settle(
          id,
          false,
          JSON.stringify({
            ...failure,
            message: failure.message.slice(0, 4000),
          }),
        );
      };
      /** Hands a host value to the script as the resolution of call `id`. */
      const deliver = (id: number, value: JsonValue) => {
        inTransit.set(id, value);
        const payload = JSON.stringify(value);
        if (payload === undefined) throw new Error('Tool result must be JSON');
        const payloadBytes = Buffer.byteLength(payload);
        if (payloadBytes > SCRIPT_LIMITS.resultBytes) {
          // Charged despite the rejection, so a script looping on caught
          // errors still reaches the cumulative limit.
          resultBytes += payloadBytes;
          throw new Error('Tool result exceeds the byte limit');
        }
        settle(id, true, payload);
      };
      const onMessage = (message: WorkerMessage) => {
        if (stopped) return;
        if (!message || typeof message !== 'object') {
          transportError('Invalid worker message');
          return;
        }
        if (message.type === 'output' && typeof message.text === 'string') {
          print(message.text);
        } else if (message.type === 'image') {
          if (
            typeof message.data !== 'string' ||
            !SCRIPT_IMAGE_TYPES.includes(message.mimeType)
          ) {
            transportError('Invalid image message');
            return;
          }
          show({ mimeType: message.mimeType, data: message.data });
        } else if (
          message.type === 'imageFile' &&
          Number.isSafeInteger(message.id) &&
          message.id > 0 &&
          typeof message.path === 'string' &&
          !callNames.has(message.id)
        ) {
          if (!admit(message.id, READ_FILE_TOOL_NAME)) return;
          void (async () => {
            try {
              if (!host.readImage)
                throw new Error('Image files are not available to this script');
              const image = await host.readImage(message.path);
              if (stopped) return;
              // Bytes stay on the host; the script only gets null, so the result byte limit never applies.
              if (!show(image)) return;
              deliver(message.id, null);
            } catch (error) {
              reject(message.id, READ_FILE_TOOL_NAME, error);
            }
          })();
        } else if (
          message.type === 'search' &&
          Number.isSafeInteger(message.id) &&
          typeof message.query === 'string' &&
          Number.isSafeInteger(message.limit)
        ) {
          if (++searches > SCRIPT_LIMITS.searches) {
            exceeded('searches');
            return;
          }
          let found: readonly string[];
          try {
            found =
              host.search?.({
                query: message.query,
                limit: message.limit,
                ...(message.namespace === undefined
                  ? {}
                  : { namespace: message.namespace }),
              }) ?? [];
          } catch (error) {
            runLogger.warn('[CodeMode] Tool search failed', error);
            found = [];
          }
          try {
            worker?.postMessage({
              type: 'searched',
              id: message.id,
              names: found,
            } satisfies HostMessage);
          } catch {
            transportError('Script worker disconnected');
          }
        } else if (
          message.type === 'received' &&
          inTransit.delete(message.id)
        ) {
          // The VM parsed the value and resolved its Promise. A successful post
          // alone does not prove this when cancellation races worker execution.
        } else if (message.type === 'done') {
          if (!WORKER_DONE_STATUSES.includes(message.status)) {
            transportError('Invalid worker status');
            return;
          }
          const workerPendingIds = message.pendingCallIds ?? [];
          if (
            !Array.isArray(workerPendingIds) ||
            workerPendingIds.length > SCRIPT_LIMITS.calls ||
            !workerPendingIds.every((id) => callNames.has(id))
          ) {
            transportError('Invalid worker pending calls');
            return;
          }
          // The guest already charged the return value, but host-side budgets
          // never trust a guest-reported size.
          let returnValue: string | undefined;
          if (
            message.status === 'completed' &&
            typeof message.returnValue === 'string'
          ) {
            if (!charge(message.returnValue)) return;
            returnValue = message.returnValue;
          }
          finish(
            message.status === 'completed' &&
              (pending.size > 0 ||
                inTransit.size > 0 ||
                workerPendingIds.length > 0)
              ? {
                  status: 'incomplete',
                  error: 'Script returned with pending tool calls',
                }
              : {
                  status: message.status,
                  ...(message.errorKind
                    ? { errorKind: message.errorKind }
                    : {}),
                  ...(message.status === 'limit' && message.limitKind
                    ? { limitKind: message.limitKind }
                    : {}),
                  ...(message.status === 'completed' &&
                  message.storeWrites?.length
                    ? { storeWrites: message.storeWrites }
                    : {}),
                  ...(returnValue === undefined ? {} : { returnValue }),
                  ...(typeof message.error === 'string'
                    ? { error: message.error.slice(0, 4000) }
                    : {}),
                },
            workerPendingIds,
          );
        } else if (
          message.type === 'call' &&
          Number.isSafeInteger(message.id) &&
          message.id > 0 &&
          typeof message.name === 'string' &&
          typeof message.args === 'string' &&
          !callNames.has(message.id)
        ) {
          if (!admit(message.id, message.name)) return;
          void (async () => {
            try {
              if (!names.has(message.name))
                throw new Error('Tool is not available to this script');
              if (message.argumentError !== undefined)
                throw new Error('Tool arguments exceed the byte limit');
              if (Buffer.byteLength(message.args) > SCRIPT_LIMITS.argumentBytes)
                throw new Error('Tool arguments exceed the byte limit');
              const args: unknown = JSON.parse(message.args);
              if (!args || typeof args !== 'object' || Array.isArray(args))
                throw new Error('Tool arguments must be a JSON object');
              const value = await host.call(message.name, args as JsonObject);
              if (stopped) {
                discard(value);
                return;
              }
              deliver(message.id, value);
            } catch (error) {
              reject(message.id, message.name, error);
            }
          })();
        } else transportError('Invalid or duplicate worker message');
      };
      // Restoring the store reads the transcript; it overlaps with worker warm-up.
      const acquiring = compileWasm()
        .then((wasm) => this.workers.acquire(wasm, acquisition.signal))
        .then((acquired) => {
          worker = acquired;
          if (stopped) {
            this.workers.stop(acquired);
            return acquired;
          }
          // Own the worker immediately, even while store restoration is pending.
          acquired.on('message', onMessage);
          acquired.on('error', (error) =>
            transportError(
              `Script worker failed: ${error.message.slice(0, 2000)}`,
            ),
          );
          acquired.on('exit', () =>
            transportError('Script worker exited before completion'),
          );
          return acquired;
        });
      void (async () => {
        try {
          const restoring = Promise.resolve()
            .then(() => host.storeSnapshot?.())
            .then(
              (snapshot) => ({ snapshot, error: undefined }),
              (error: unknown) => {
                if (!(error instanceof StoreRestoreError)) throw error;
                return { snapshot: undefined, error: error.message };
              },
            );
          const [store, acquired] = await Promise.all([restoring, acquiring]);
          if (stopped) return;
          const start: ScriptStartMessage = {
            type: 'start',
            code: request.code,
            tools: request.tools,
            directTools: request.directTools,
            toolCatalog: request.toolCatalog,
            namespaces: request.namespaces,
            storeSnapshot: store.snapshot,
            storeError: store.error,
            interrupt: interrupt.buffer as SharedArrayBuffer,
          };
          acquired.postMessage(start);
        } catch (error) {
          if (error instanceof WorkerWaitTimeoutError) {
            finish({ status: 'timeout', error: error.message });
            return;
          }
          finish({
            status: 'error',
            errorKind: 'runtime_start',
            error: `Unable to start the isolated script runtime: ${error instanceof Error ? error.message.slice(0, 2000) : 'unknown error'}`,
          });
        }
      })();
    });
  }
}
