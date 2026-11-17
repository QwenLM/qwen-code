/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isWithinRepository,
  loadAutoRecallRuntimeConfiguration,
} from './config.js';
import { renderResult } from './profile.js';
import { createRequestEngine } from './request-engine.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_AUTO_QUERY_CHARACTERS = 512;
const MAX_SANITIZER_INPUT_CHARACTERS = 4096;
const HOOK_WALL_CLOCK_TIMEOUT_MS = 6500;
// Check each identifier once, without overlapping scans around the keyword.
const SECRET_ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_.-])["']?(?=[A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret))[A-Za-z0-9_.-]+["']?[^\S\r\n]*[:=][^\S\r\n]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)?/gi;

interface HookInput {
  submittedPrompt: string;
  cwd: string;
}

type HookOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit';
        additionalContext: string;
      };
    };

type HookInputStream = AsyncIterable<string | Uint8Array> & {
  destroy?(): void;
};

interface HookOutputStream {
  write(value: string): unknown;
}

export async function runAutoRecall(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal = new AbortController().signal,
): Promise<HookOutput> {
  const input = parseHookInput(value);
  if (!input) return {};

  const runtime = await loadAutoRecallRuntimeConfiguration({ env });
  if (
    !(await isWithinRepository(
      runtime.instance.autoRecall.repositoryRoot,
      input.cwd,
    ))
  ) {
    return {};
  }

  const query = createAutoRecallQuery(
    input.submittedPrompt,
    runtime.credential,
  );
  if (!query) return {};

  const items = await createRequestEngine(runtime)({
    query,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(runtime.instance.timeoutMs),
    ]),
  });
  if (items.length === 0) return {};

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: renderResult(items).text,
    },
  };
}

export function createAutoRecallQuery(
  submittedPrompt: string,
  credential: string,
): string | undefined {
  let query = submittedPrompt;
  if (query.length > MAX_SANITIZER_INPUT_CHARACTERS) {
    query = Array.from(query).slice(0, MAX_SANITIZER_INPUT_CHARACTERS).join('');
  }
  query = query
    .replace(/(```|~~~)[\s\S]*?\1/g, ' ')
    .replace(/(?:```|~~~)[\s\S]*$/g, ' ');
  if (credential) query = query.replaceAll(credential, ' ');
  query = query
    .replace(SECRET_ASSIGNMENT_PATTERN, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, ' ')
    .replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      ' ',
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!query) return undefined;
  return Array.from(query).slice(0, MAX_AUTO_QUERY_CHARACTERS).join('');
}

export async function runAutoRecallCli(
  inputStream: HookInputStream = process.stdin,
  outputStream: HookOutputStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HookOutput>((resolveTimeout) => {
    timeout = setTimeout(() => {
      controller.abort();
      inputStream.destroy?.();
      resolveTimeout({});
    }, HOOK_WALL_CLOCK_TIMEOUT_MS);
  });

  const work = (async (): Promise<HookOutput> => {
    const input = await readHookInput(inputStream);
    return input === undefined
      ? {}
      : runAutoRecall(input, env, controller.signal);
  })().catch(() => ({}));

  const output = await Promise.race([work, timedOut]);
  controller.abort();
  if (timeout !== undefined) clearTimeout(timeout);
  outputStream.write(JSON.stringify(output));
}

async function readHookInput(
  inputStream: HookInputStream,
): Promise<unknown | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const source of inputStream) {
    const chunk = Buffer.from(source);
    total += chunk.byteLength;
    if (total > MAX_HOOK_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function parseHookInput(value: unknown): HookInput | undefined {
  if (!isRecord(value)) return undefined;
  const submittedPrompt = value['submitted_prompt'];
  const cwd = value['cwd'];
  if (
    value['hook_event_name'] !== 'UserPromptSubmit' ||
    typeof submittedPrompt !== 'string' ||
    submittedPrompt.trim().length === 0 ||
    typeof cwd !== 'string'
  ) {
    return undefined;
  }
  return { submittedPrompt, cwd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isDirectEntryPoint(): Promise<boolean> {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;
  try {
    return (
      (await realpath(fileURLToPath(import.meta.url))) ===
      (await realpath(resolve(entryPoint)))
    );
  } catch {
    return false;
  }
}

if (await isDirectEntryPoint()) {
  await runAutoRecallCli().catch(() => undefined);
  // Aborted fetches or filesystem reads can retain handles after output is ready.
  process.stdout.end(() => process.exit(0));
}
