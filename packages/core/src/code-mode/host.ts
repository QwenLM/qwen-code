/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import {
  CODE_MODE_MAX_MEDIA_BYTES,
  CODE_MODE_MAX_MEDIA_ITEMS,
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_MAX_SOURCE_CHARS,
  CODE_MODE_TIMEOUT_MS,
  encodeFrame,
  FrameDecoder,
  type CodeModeContentItem,
  type ExecuteMessage,
  type HostMessage,
  type ParentMessage,
  type ToolResultMessage,
} from './protocol.js';

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;

function write(message: HostMessage): void {
  process.stdout.write(encodeFrame(message));
}

function errorMessage(value: unknown): string {
  let message: string;
  if (value && typeof value === 'object') {
    const error = value as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    try {
      message =
        typeof error.message === 'string'
          ? error.message
          : JSON.stringify(value) || String(value);
    } catch {
      message = String(value);
    }
    message =
      typeof error.stack === 'string' ? `${message}\n${error.stack}` : message;
  } else {
    message = String(value);
  }
  return message.slice(0, CODE_MODE_MAX_OUTPUT_CHARS);
}

function jsonHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  const source = `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  const parsed = vm.evalCode(source, 'host-value.js');
  if (parsed.error) {
    const dumped = vm.dump(parsed.error);
    parsed.error.dispose();
    throw new Error(`Cannot marshal host value: ${errorMessage(dumped)}`);
  }
  return parsed.value;
}

function appendBounded(
  output: string,
  value: unknown,
  maxOutputChars: number,
): string {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? 'undefined'
        : JSON.stringify(value);
  if (output.length >= maxOutputChars) return output;
  const next = output.length === 0 ? text : `\n${text}`;
  return output + next.slice(0, maxOutputChars - output.length);
}

function boundedValue(value: unknown, maxChars: number): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return '[Code mode value could not be serialized]';
  }
  if (serialized === undefined) return String(value).slice(0, maxChars);
  if (serialized.length <= maxChars) return value;
  const prefix = '[Code mode value truncated] ';
  return (prefix + serialized).slice(0, maxChars);
}

interface NormalizedMedia {
  type: 'image' | 'audio';
  mimeType: string;
  data: string;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBase64Media(
  kind: 'image' | 'audio',
  mimeTypeValue: unknown,
  dataValue: unknown,
): NormalizedMedia | undefined {
  if (typeof mimeTypeValue !== 'string' || typeof dataValue !== 'string') {
    return undefined;
  }
  const mimeType = mimeTypeValue.toLowerCase();
  const data = dataValue;
  const hasPadding = data.endsWith('=');
  if (
    !mimeType.startsWith(`${kind}/`) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
    data.length % 4 === 1 ||
    (hasPadding && data.length % 4 !== 0)
  ) {
    return undefined;
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return {
    type: kind,
    mimeType,
    data,
    bytes: Math.floor((data.length * 3) / 4) - padding,
  };
}

function normalizeMedia(
  kind: 'image' | 'audio',
  value: unknown,
): NormalizedMedia {
  if (kind === 'image' && isRecord(value) && value['type'] === 'image') {
    const media = normalizeBase64Media(kind, value['mimeType'], value['data']);
    if (media) return media;
    throw new Error(
      'image() expects Qwen MCP ImageContent with base64 data and an image MIME type.',
    );
  }
  if (typeof value !== 'string') {
    throw new Error(
      kind === 'image'
        ? 'image() expects a base64 data URL or Qwen MCP ImageContent.'
        : 'audio() expects a base64 data URL.',
    );
  }
  const match =
    /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      value,
    );
  const media = normalizeBase64Media(kind, match?.[1], match?.[2]);
  if (!media) {
    throw new Error(
      `${kind}() expects a base64 data URL with a ${kind} MIME type.`,
    );
  }
  return media;
}

function normalizeGeneratedImage(value: unknown): {
  images: NormalizedMedia[];
  outputHint: string;
} {
  if (
    !isRecord(value) ||
    typeof value['callId'] !== 'string' ||
    value['name'] !== 'image_gen' ||
    value['status'] !== 'success' ||
    typeof value['output'] !== 'string' ||
    !Array.isArray(value['content']) ||
    value['content'].length === 0
  ) {
    throw new Error(
      'generatedImage() expects the successful result returned by tools.image_gen().',
    );
  }
  return {
    images: value['content'].map((item) => normalizeMedia('image', item)),
    outputHint: value['output'],
  };
}

async function execute(message: ExecuteMessage): Promise<void> {
  if (message.source.length > CODE_MODE_MAX_SOURCE_CHARS) {
    throw new Error('JavaScript source exceeds the size limit.');
  }
  const timeoutMs = Math.min(
    Math.max(1, message.timeoutMs || CODE_MODE_TIMEOUT_MS),
    CODE_MODE_TIMEOUT_MS,
  );
  const maxOutputChars = Math.min(
    Math.max(1, message.maxOutputChars || CODE_MODE_MAX_OUTPUT_CHARS),
    CODE_MODE_MAX_OUTPUT_CHARS,
  );
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  let remainingCpuMs = timeoutMs;
  let cpuDeadline = Date.now() + remainingCpuMs;
  let cpuPaused = false;
  runtime.setInterruptHandler(() => !cpuPaused && Date.now() >= cpuDeadline);
  const vm = runtime.newContext();
  const pending = new Map<string, QuickJSDeferredPromise>();
  let output = '';
  const content: CodeModeContentItem[] = [];
  let mediaBytes = 0;
  let mediaItems = 0;
  const toolNames = message.tools.map((tool) => tool.jsName);
  let nextId = 0;

  const pauseCpuBudget = (): void => {
    if (cpuPaused) return;
    remainingCpuMs = Math.max(0, cpuDeadline - Date.now());
    cpuPaused = true;
  };
  const resumeCpuBudget = (): void => {
    if (!cpuPaused) return;
    cpuDeadline = Date.now() + remainingCpuMs;
    cpuPaused = false;
  };
  const executePendingJobs = (): void => {
    resumeCpuBudget();
    const jobs = runtime.executePendingJobs();
    if (pending.size > 0) pauseCpuBudget();
    if (jobs.error) {
      const dumped = jobs.error.context.dump(jobs.error);
      jobs.error.dispose();
      throw new Error(errorMessage(dumped));
    }
  };

  const appendMedia = (items: NormalizedMedia[]): void => {
    if (mediaItems + items.length > CODE_MODE_MAX_MEDIA_ITEMS) {
      throw new Error(
        `Code mode supports at most ${CODE_MODE_MAX_MEDIA_ITEMS} media outputs.`,
      );
    }
    const addedBytes = items.reduce((sum, item) => sum + item.bytes, 0);
    if (mediaBytes + addedBytes > CODE_MODE_MAX_MEDIA_BYTES) {
      throw new Error(
        `Code mode media output exceeds the ${CODE_MODE_MAX_MEDIA_BYTES / (1024 * 1024)}MB limit.`,
      );
    }
    mediaBytes += addedBytes;
    mediaItems += items.length;
    for (const { bytes: _bytes, ...item } of items) content.push(item);
  };

  let rejectHostFailure!: (reason: Error) => void;
  const hostFailure = new Promise<never>((_resolve, reject) => {
    rejectHostFailure = reject;
  });
  let hostFailed = false;
  const failHost = (error: unknown): void => {
    if (hostFailed) return;
    hostFailed = true;
    rejectHostFailure(
      error instanceof Error ? error : new Error(errorMessage(error)),
    );
  };

  const settleTool = (toolResult: ToolResultMessage): void => {
    const deferred = pending.get(toolResult.id);
    if (!deferred) return;
    pending.delete(toolResult.id);
    try {
      if (toolResult.ok && toolResult.result) {
        const handle = jsonHandle(vm, toolResult.result);
        deferred.resolve(handle);
        handle.dispose();
      } else {
        const handle = vm.newError(
          toolResult.error ?? 'Nested tool call failed.',
        );
        deferred.reject(handle);
        handle.dispose();
      }
      executePendingJobs();
    } finally {
      deferred.dispose();
    }
  };

  const decoder = new FrameDecoder<ParentMessage>();
  const onData = (chunk: Buffer) => {
    try {
      for (const item of decoder.push(chunk)) {
        if (item.type === 'tool_result') settleTool(item);
      }
    } catch (error) {
      failHost(error);
    }
  };
  process.stdin.on('data', onData);

  try {
    const callTool = vm.newFunction('__callTool', (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      if (!toolNames.includes(name)) {
        throw new Error(`Tool "${name}" is not available in code mode.`);
      }
      const args = vm.dump(argsHandle);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`tools.${name} expects one object argument.`);
      }
      const id = String(++nextId);
      const deferred = vm.newPromise();
      pending.set(id, deferred);
      write({
        type: 'tool_call',
        id,
        name,
        args: args as Record<string, unknown>,
      });
      return deferred.handle;
    });
    vm.setProp(vm.global, '__callTool', callTool);
    callTool.dispose();

    const appendText = vm.newFunction('__appendText', (valueHandle) => {
      output = appendBounded(output, vm.dump(valueHandle), maxOutputChars);
    });
    vm.setProp(vm.global, '__appendText', appendText);
    appendText.dispose();

    for (const kind of ['image', 'audio'] as const) {
      const appendMediaHelper = vm.newFunction(
        `__append_${kind}`,
        (valueHandle) => {
          appendMedia([normalizeMedia(kind, vm.dump(valueHandle))]);
        },
      );
      vm.setProp(vm.global, `__append_${kind}`, appendMediaHelper);
      appendMediaHelper.dispose();
    }

    const appendGeneratedImage = vm.newFunction(
      '__appendGeneratedImage',
      (valueHandle) => {
        const generated = normalizeGeneratedImage(vm.dump(valueHandle));
        appendMedia(generated.images);
        if (generated.outputHint) {
          output = appendBounded(output, generated.outputHint, maxOutputChars);
        }
      },
    );
    vm.setProp(vm.global, '__appendGeneratedImage', appendGeneratedImage);
    appendGeneratedImage.dispose();

    const toolEntries = toolNames
      .map(
        (name) =>
          `[${JSON.stringify(name)}]: (args) => hostCall(${JSON.stringify(name)}, args)`,
      )
      .join(',');
    const setup = vm.evalCode(
      `(() => {
      const hostCall = globalThis.__callTool;
      const hostText = globalThis.__appendText;
      const hostImage = globalThis.__append_image;
      const hostAudio = globalThis.__append_audio;
      const hostGeneratedImage = globalThis.__appendGeneratedImage;
      delete globalThis.__callTool;
      delete globalThis.__appendText;
      delete globalThis.__append_image;
      delete globalThis.__append_audio;
      delete globalThis.__appendGeneratedImage;
      const toolTarget = Object.freeze(Object.assign(Object.create(null), {${toolEntries}}));
      const tools = Object.freeze(new Proxy(toolTarget, {
        get(target, property) {
          if (typeof property !== 'string' || property in target) return target[property];
          throw new Error('Unknown or unavailable code mode tool: ' + property);
        },
      }));
      const ALL_TOOLS = Object.freeze(${JSON.stringify(message.tools)}.map(Object.freeze));
      const text = (value) => hostText(value);
      const image = (value) => hostImage(value);
      const audio = (value) => hostAudio(value);
      const generatedImage = (value) => hostGeneratedImage(value);
      const exit = () => { throw Object.freeze({ __codeModeExit: true }); };
      Object.defineProperties(globalThis, {
        tools: { value: tools, writable: false, configurable: false },
        ALL_TOOLS: { value: ALL_TOOLS, writable: false, configurable: false },
        text: { value: text, writable: false, configurable: false },
        image: { value: image, writable: false, configurable: false },
        audio: { value: audio, writable: false, configurable: false },
        generatedImage: { value: generatedImage, writable: false, configurable: false },
        exit: { value: exit, writable: false, configurable: false },
      });
      for (const name of ['process','require','module','Buffer','console','fetch','XMLHttpRequest','WebSocket','setTimeout','setInterval','setImmediate','queueMicrotask','Atomics','SharedArrayBuffer','WebAssembly']) {
        try { delete globalThis[name]; } catch {}
      }
    })()`,
      'setup.js',
    );
    if (setup.error) {
      const dumped = vm.dump(setup.error);
      setup.error.dispose();
      throw new Error(errorMessage(dumped));
    }
    setup.value.dispose();

    const evaluated = vm.evalCode(
      `
      (async () => {
        try {
          return await (async () => {${message.source}\n})();
        } catch (error) {
          if (error && error.__codeModeExit === true) return undefined;
          throw error;
        }
      })()
    `,
      'exec.js',
    );
    if (evaluated.error) {
      const dumped = vm.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(errorMessage(dumped));
    }
    const promiseHandle = evaluated.value;
    const nativePromise = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    executePendingJobs();
    const settled = await Promise.race([nativePromise, hostFailure]);
    if (settled.error) {
      const dumped = vm.dump(settled.error);
      settled.error.dispose();
      throw new Error(errorMessage(dumped));
    }
    const value = vm.dump(settled.value);
    settled.value.dispose();
    write({
      type: 'complete',
      output,
      ...(value === undefined
        ? {}
        : { value: boundedValue(value, maxOutputChars) }),
      ...(content.length === 0 ? {} : { content }),
    });
  } finally {
    process.stdin.off('data', onData);
    for (const deferred of pending.values()) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

const decoder = new FrameDecoder<ParentMessage>();
let started = false;
process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (message.type !== 'execute' || started) continue;
      started = true;
      void execute(message)
        .catch((error) => write({ type: 'error', error: errorMessage(error) }))
        .finally(() => {
          process.exitCode = 0;
          process.stdin.pause();
        });
    }
  } catch (error) {
    write({ type: 'error', error: errorMessage(error) });
    process.exitCode = 1;
    process.stdin.pause();
  }
});
