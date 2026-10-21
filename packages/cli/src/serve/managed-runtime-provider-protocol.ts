/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  managedToolDigest,
  parseManagedToolCallIdentity,
  parseManagedToolConfirmationPayload,
  parseManagedToolContentModification,
  parseManagedToolInvocationReference,
  parseManagedToolMediaContext,
  type ManagedToolCallIdentity,
  type ManagedToolContentModification,
  type ManagedToolInvocationReference,
  type ManagedToolMediaContext,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  parseManagedToolFileHistoryBinding,
  parseManagedToolFileHistoryPromptId,
  parseManagedToolFileHistoryState,
  type ManagedToolFileHistoryBinding,
} from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import {
  historyPath,
  parseHostedFileHistoryState,
  type RawFileHistoryOperation,
} from './hosted-file-history-protocol.js';
import { isShellResultDisplay } from '@qwen-code/qwen-code-core/utils/shell-result.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ToolConfirmationPayload } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ManagedToolConfirmationPhase } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';

export const MANAGED_RUNTIME_PROVIDER_PROTOCOL = 'managed-runtime-provider/1';
export const MANAGED_RUNTIME_PROVIDER_ROUTE = Object.freeze({
  key: 'provider-control',
  method: 'POST',
  path: '/internal/managed-runtime/provider/v1/control',
  protocolVersion: 1,
  requestBodyLimitBytes: 8 * 1024 * 1024,
  responseBodyLimitBytes: 8 * 1024 * 1024,
  cacheControl: 'no-store',
} as const);

/**
 * The project instruction files a Hosted turn reads from the Session's
 * working directory, in prompt order.
 */
export const MANAGED_WORKSPACE_CONTEXT_FILES = [
  'QWEN.md',
  'AGENTS.md',
] as const;

/**
 * Each file's text is capped in characters so the whole result stays under
 * the 1 MiB control limit even when every character JSON-escapes to six bytes.
 */
export const MANAGED_WORKSPACE_CONTEXT_FILE_CHARS = 64 * 1024;

export interface ManagedWorkspaceContextFile {
  name: (typeof MANAGED_WORKSPACE_CONTEXT_FILES)[number];
  text: string;
}

export interface ManagedRuntimeProviderSession {
  readonly harnessSessionId: string;
  readonly runtimeSessionId: string;
  readonly turnKind: 'bootstrap' | 'continuation';
}

export type ManagedRuntimeProviderControl =
  | RawFileHistoryOperation
  | { kind: 'manifest' | 'history' | 'workspace-context' }
  | { kind: 'begin-turn'; identity: ManagedToolCallIdentity }
  | {
      kind: 'prepare';
      identity: ManagedToolCallIdentity;
      toolName: string;
      input: Record<string, unknown>;
      modification?: ManagedToolContentModification;
      mediaContext?: ManagedToolMediaContext;
    }
  | {
      kind: 'confirmation' | 'preflight';
      reference: ManagedToolInvocationReference;
    }
  | {
      kind: 'confirm';
      reference: ManagedToolInvocationReference;
      outcome: ToolConfirmationOutcome;
      payload?: ToolConfirmationPayload;
      phase?: ManagedToolConfirmationPhase;
    }
  | { kind: 'bind-history'; binding: ManagedToolFileHistoryBinding }
  | { kind: 'checkpoint'; promptId: string };

export type ManagedRuntimeProviderOperation =
  | ManagedRuntimeProviderControl
  | { kind: 'acquire' | 'release' }
  | { kind: 'execute' | 'cancel'; reference: ManagedToolInvocationReference }
  | {
      kind: 'status';
      reference: ManagedToolInvocationReference;
      afterSequence?: number;
    };

export interface ManagedRuntimeProviderRequest {
  protocolVersion: 1;
  providerProtocol: typeof MANAGED_RUNTIME_PROVIDER_PROTOCOL;
  session: ManagedRuntimeProviderSession;
  operation: ManagedRuntimeProviderOperation;
}

export class ManagedRuntimeProviderProtocolError extends Error {
  constructor(
    message = 'Managed Runtime provider request is invalid.',
    readonly status = 400,
    readonly code = 'managed_runtime_provider_invalid',
  ) {
    super(message);
    this.name = 'ManagedRuntimeProviderProtocolError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedRuntimeProviderProtocolError();
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new ManagedRuntimeProviderProtocolError();
}

function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 512 ||
    value.includes('\0')
  )
    throw new ManagedRuntimeProviderProtocolError();
  return value;
}

/**
 * Envelope Session ids become core's `Config.sessionId` and the file-history
 * owner's directory name, both of which are interpolated into file names and
 * log lines, so they are an allow-list rather than a list of known-bad
 * characters: 1-512 ASCII letters, digits, `.`, `_` or `-`, never `.`/`..` and
 * never containing `..`. The Broker refuses the same ids, the Harness Session id
 * already at warm and both at acquire, since every Runtime Session is released
 * through this envelope. The wire contract deliberately does not require the
 * UUID form — the Broker's own fault gates drive this route with opaque ids,
 * and non-identity operations (acquire/release/manifest) stay available to
 * them. Identity-bearing operations keep requiring core's UUID form through
 * `checkSession`.
 */
const SESSION_ID = /^[A-Za-z0-9._-]{1,512}$/;

function envelopeSessionId(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !SESSION_ID.test(value) ||
    value === '.' ||
    value.includes('..')
  )
    throw new ManagedRuntimeProviderProtocolError(
      "Managed Runtime provider Session identity must be 1-512 ASCII letters, digits, '.', '_' or '-', without '..'.",
    );
}

function sequence(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ManagedRuntimeProviderProtocolError();
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function checkSession(
  identity: ManagedToolCallIdentity,
  session: ManagedRuntimeProviderSession,
): void {
  if (identity.sessionId !== session.runtimeSessionId)
    throw new ManagedRuntimeProviderProtocolError(
      'Managed Runtime provider Session identity conflicts.',
      409,
      'managed_runtime_identity_conflict',
    );
}

export function managedRuntimeProviderLimit(kind: string): number {
  return ['bind-history', 'checkpoint', 'history'].includes(kind)
    ? 8 * 1024 * 1024
    : 1024 * 1024;
}

export function parseManagedRuntimeProviderOperation(
  value: unknown,
  session: ManagedRuntimeProviderSession,
  boundedByCaller = false,
): ManagedRuntimeProviderOperation {
  const op = object(value);
  const kind = id(op['kind']);
  // The composed request parser bounds the whole envelope per kind, which
  // strictly implies this bound; only standalone callers need it re-run.
  if (!boundedByCaller)
    managedToolDigest(value, managedRuntimeProviderLimit(kind));
  switch (kind) {
    case 'raw-file-history': {
      const action = op['action'];
      if (action === 'bind') {
        keys(op, ['kind', 'action', 'state']);
        if (op['state'] !== null)
          parseHostedFileHistoryState(op['state'], session.harnessSessionId);
      } else if (action === 'prepare') {
        keys(op, ['kind', 'action', 'promptId', 'paths']);
        parseManagedToolFileHistoryPromptId(op['promptId']);
        if (!Array.isArray(op['paths']) || !op['paths'].length)
          throw new ManagedRuntimeProviderProtocolError();
        op['paths'].forEach(historyPath);
      } else if (action === 'rewind') {
        keys(op, ['kind', 'action', 'promptId']);
        parseManagedToolFileHistoryPromptId(op['promptId']);
      } else if (action === 'snapshot') keys(op, ['kind', 'action']);
      else throw new ManagedRuntimeProviderProtocolError();
      break;
    }
    case 'acquire':
    case 'release':
    case 'manifest':
    case 'history':
    case 'workspace-context':
      keys(op, ['kind']);
      break;
    case 'begin-turn':
    case 'prepare': {
      keys(
        op,
        kind === 'prepare'
          ? ['kind', 'identity', 'toolName', 'input']
          : ['kind', 'identity'],
        kind === 'prepare' ? ['modification', 'mediaContext'] : [],
      );
      checkSession(parseManagedToolCallIdentity(op['identity']), session);
      if (kind === 'prepare') {
        id(op['toolName']);
        object(op['input']);
        if ('modification' in op)
          checkSession(
            parseManagedToolContentModification(op['modification']).source,
            session,
          );
        if ('mediaContext' in op)
          parseManagedToolMediaContext(op['mediaContext']);
      }
      break;
    }
    case 'confirmation':
    case 'confirm':
    case 'preflight':
    case 'execute':
    case 'status':
    case 'cancel':
      keys(
        op,
        kind === 'confirm'
          ? ['kind', 'reference', 'outcome']
          : ['kind', 'reference'],
        kind === 'confirm'
          ? ['payload', 'phase']
          : kind === 'status'
            ? ['afterSequence']
            : [],
      );
      checkSession(
        parseManagedToolInvocationReference(op['reference']),
        session,
      );
      if (kind === 'confirm') {
        if (
          !Object.values(ToolConfirmationOutcome).includes(
            op['outcome'] as ToolConfirmationOutcome,
          ) ||
          op['outcome'] === ToolConfirmationOutcome.RestorePrevious
        )
          throw new ManagedRuntimeProviderProtocolError();
        if ('payload' in op) parseManagedToolConfirmationPayload(op['payload']);
        if ('phase' in op && !oneOf(op['phase'], ['permission', 'preflight']))
          throw new ManagedRuntimeProviderProtocolError();
      }
      if ('afterSequence' in op) sequence(op['afterSequence']);
      break;
    case 'bind-history': {
      keys(op, ['kind', 'binding']);
      const binding = parseManagedToolFileHistoryBinding(op['binding']);
      if (
        binding.ownerSessionId !== session.harnessSessionId ||
        binding.ownerRuntimeSessionId !== session.runtimeSessionId
      )
        throw new ManagedRuntimeProviderProtocolError(
          'Managed Runtime file history owner conflicts.',
          409,
          'managed_runtime_identity_conflict',
        );
      break;
    }
    case 'checkpoint':
      keys(op, ['kind', 'promptId']);
      parseManagedToolFileHistoryPromptId(op['promptId']);
      break;
    default:
      throw new ManagedRuntimeProviderProtocolError(
        'Managed Runtime provider operation is unsupported.',
        501,
        'managed_runtime_provider_unsupported',
      );
  }
  return structuredClone(value) as ManagedRuntimeProviderOperation;
}

export function parseManagedRuntimeProviderRequest(
  value: unknown,
): ManagedRuntimeProviderRequest {
  const request = object(value);
  keys(request, [
    'protocolVersion',
    'providerProtocol',
    'session',
    'operation',
  ]);
  if (
    request['protocolVersion'] !== 1 ||
    request['providerProtocol'] !== MANAGED_RUNTIME_PROVIDER_PROTOCOL
  )
    throw new ManagedRuntimeProviderProtocolError(
      'Managed Runtime provider protocol is incompatible.',
      409,
      'managed_runtime_provider_incompatible',
    );
  const session = object(request['session']);
  keys(session, ['harnessSessionId', 'runtimeSessionId', 'turnKind']);
  envelopeSessionId(session['harnessSessionId']);
  envelopeSessionId(session['runtimeSessionId']);
  if (!oneOf(session['turnKind'], ['bootstrap', 'continuation']))
    throw new ManagedRuntimeProviderProtocolError();
  const parsedSession = session as unknown as ManagedRuntimeProviderSession;
  const parsed: ManagedRuntimeProviderRequest = {
    protocolVersion: 1,
    providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
    session: structuredClone(parsedSession),
    operation: parseManagedRuntimeProviderOperation(
      request['operation'],
      parsedSession,
      true,
    ),
  };
  managedToolDigest(value, managedRuntimeProviderLimit(parsed.operation.kind));
  return parsed;
}

export function parseManagedRuntimeProviderResult(
  operation: ManagedRuntimeProviderOperation,
  value: unknown,
  session: ManagedRuntimeProviderSession,
): unknown {
  managedToolDigest(value, managedRuntimeProviderLimit(operation.kind));
  if (operation.kind === 'begin-turn' || operation.kind === 'confirm') {
    if (value !== null) throw new ManagedRuntimeProviderProtocolError();
    return null;
  }
  if (operation.kind === 'acquire' || operation.kind === 'release') {
    if (value !== true) throw new ManagedRuntimeProviderProtocolError();
    return true;
  }
  const result = object(value);
  switch (operation.kind) {
    case 'raw-file-history': {
      if (operation.action !== 'rewind')
        return parseHostedFileHistoryState(value, session.harnessSessionId);
      keys(result, ['state', 'filesChanged', 'filesFailed', 'conflict']);
      const state = parseHostedFileHistoryState(
        result['state'],
        session.harnessSessionId,
      );
      if (
        !Array.isArray(result['filesChanged']) ||
        !Array.isArray(result['filesFailed']) ||
        typeof result['conflict'] !== 'boolean'
      )
        throw new ManagedRuntimeProviderProtocolError();
      result['filesChanged'].forEach(historyPath);
      result['filesFailed'].forEach(historyPath);
      if (
        new Set(result['filesChanged']).size !==
          result['filesChanged'].length ||
        result['filesChanged'].some(
          (file) => !Object.hasOwn(state.files, file),
        ) ||
        !state.snapshots.some(
          (snapshot) => snapshot.promptId === operation.promptId,
        ) ||
        (result['conflict'] && result['filesChanged'].length !== 0)
      )
        throw new ManagedRuntimeProviderProtocolError(
          'Invalid Hosted file history rewind outcome.',
        );
      break;
    }
    case 'workspace-context': {
      keys(result, ['files']);
      if (!Array.isArray(result['files']))
        throw new ManagedRuntimeProviderProtocolError();
      let next = 0;
      for (const entry of result['files']) {
        const file = object(entry);
        keys(file, ['name', 'text']);
        const index = MANAGED_WORKSPACE_CONTEXT_FILES.indexOf(
          file['name'] as ManagedWorkspaceContextFile['name'],
        );
        if (
          index < next ||
          typeof file['text'] !== 'string' ||
          file['text'].length > MANAGED_WORKSPACE_CONTEXT_FILE_CHARS
        )
          throw new ManagedRuntimeProviderProtocolError(
            'Invalid Workspace context result.',
          );
        next = index + 1;
      }
      return result['files'] as ManagedWorkspaceContextFile[];
    }
    case 'bind-history':
    case 'checkpoint':
    case 'history': {
      const state = parseManagedToolFileHistoryState(value);
      if (state.ownerSessionId !== session.harnessSessionId)
        throw new ManagedRuntimeProviderProtocolError(
          'Managed file history owner changed.',
        );
      return state;
    }
    case 'manifest':
      keys(result, ['tools', 'capabilityDigest', 'policyRevision']);
      id(result['policyRevision']);
      if (
        !Array.isArray(result['tools']) ||
        managedToolDigest(result['tools'], 1024 * 1024) !==
          result['capabilityDigest']
      )
        throw new ManagedRuntimeProviderProtocolError(
          'Managed tool manifest digest changed.',
        );
      for (const tool of result['tools']) {
        const descriptor = object(tool);
        id(descriptor['name']);
        object(descriptor['schema']);
      }
      break;
    case 'prepare': {
      const reference = Object.fromEntries(
        [
          'sessionId',
          'promptId',
          'callId',
          'capabilityDigest',
          'policyRevision',
          'invocationId',
          'argsDigest',
        ].map((key) => [key, result[key]]),
      );
      checkSession(parseManagedToolInvocationReference(reference), session);
      for (const [key, expected] of Object.entries(operation.identity))
        if (result[key] !== expected)
          throw new ManagedRuntimeProviderProtocolError();
      object(result['params']);
      if (
        managedToolDigest(result['params']) !== result['argsDigest'] ||
        typeof result['description'] !== 'string' ||
        !Array.isArray(result['locations']) ||
        !oneOf(result['defaultPermission'], [
          'allow',
          'ask',
          'deny',
          'default',
        ]) ||
        typeof result['requiresUserInteraction'] !== 'boolean'
      )
        throw new ManagedRuntimeProviderProtocolError();
      id(result['toolUseId']);
      break;
    }
    case 'confirmation': {
      if (
        !oneOf(result['type'], ['edit', 'exec', 'mcp', 'info']) ||
        typeof result['title'] !== 'string'
      )
        throw new ManagedRuntimeProviderProtocolError();
      // The fields core's serializer always emits for each variant; optional
      // ones stay open, since the variants carry more than these.
      const required = {
        edit: ['fileName', 'filePath', 'fileDiff', 'newContent'],
        exec: ['command', 'rootCommand'],
        mcp: ['serverName', 'toolName', 'toolDisplayName'],
        info: ['prompt'],
      }[result['type'] as 'edit' | 'exec' | 'mcp' | 'info'];
      if (
        required.some((key) => typeof result[key] !== 'string') ||
        (result['type'] === 'edit' &&
          result['originalContent'] !== null &&
          typeof result['originalContent'] !== 'string')
      )
        throw new ManagedRuntimeProviderProtocolError();
      break;
    }
    case 'preflight':
      if (typeof result['shouldProceed'] !== 'boolean')
        throw new ManagedRuntimeProviderProtocolError();
      break;
    case 'execute':
      if (
        !oneOf(result['executionStatus'], [
          'not_started',
          'success',
          'error',
          'cancelled',
        ])
      )
        throw new ManagedRuntimeProviderProtocolError();
      if (result['executionStatus'] === 'success') object(result['result']);
      break;
    case 'status':
    case 'cancel':
      if (result['state'] === 'unknown') {
        keys(result, ['state']);
        break;
      }
      if (
        !oneOf(result['state'], [
          'prepared',
          'executing',
          'cancel_requested',
          'settled',
        ]) ||
        typeof result['cancelRequested'] !== 'boolean' ||
        typeof result['progressGap'] !== 'boolean' ||
        !Array.isArray(result['progress'])
      )
        throw new ManagedRuntimeProviderProtocolError();
      sequence(result['lastSeq']);
      sequence(result['firstAvailableSeq']);
      if (result['state'] === 'settled')
        parseManagedRuntimeProviderResult(
          { kind: 'execute', reference: operation.reference },
          result['result'],
          session,
        );
      else if ('result' in result)
        throw new ManagedRuntimeProviderProtocolError();
      break;
    default:
      throw new ManagedRuntimeProviderProtocolError();
  }
  return structuredClone(value);
}

function providerFitNotice(omitted: number, budgetBytes: number): string {
  return `\n[Managed Runtime provider omitted ${omitted} characters here to fit the ${budgetBytes}-byte wire limit.]\n`;
}

const PROVIDER_RESULT_STUB =
  '[Managed Runtime provider omitted this tool result to fit the wire limit.]';

interface ProviderFitSlot {
  get(): string;
  set(next: string): void;
}

/**
 * The string leaves of one execution result that legitimately carry bulk tool
 * output. When `display` is a shell result its `truncated` flag flips on any
 * cut; other consumers read the notice marker in the text itself.
 */
function providerFitSlots(target: Record<string, unknown>): ProviderFitSlot[] {
  const slots: ProviderFitSlot[] = [];
  const collect = (
    owner: Record<string, unknown>,
    key: string,
    mark?: () => void,
  ): void => {
    if (typeof owner[key] !== 'string') return;
    slots.push({
      get: () => owner[key] as string,
      set: (next) => {
        owner[key] = next;
        mark?.();
      },
    });
  };
  const result = target['result'];
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const toolResult = result as Record<string, unknown>;
    const llmContent = toolResult['llmContent'];
    if (typeof llmContent === 'string') collect(toolResult, 'llmContent');
    else if (Array.isArray(llmContent)) {
      for (const part of llmContent)
        if (part && typeof part === 'object' && !Array.isArray(part))
          collect(part as Record<string, unknown>, 'text');
    }
    const display = toolResult['returnDisplay'];
    if (typeof display === 'string') collect(toolResult, 'returnDisplay');
    else if (isShellResultDisplay(display)) {
      const mark = () => {
        display.truncated = true;
      };
      const record = display as unknown as Record<string, unknown>;
      collect(record, 'output', mark);
      collect(record, 'text', mark);
      collect(record, 'error', mark);
      display.notices.forEach((_, index) =>
        slots.push({
          get: () => display.notices[index],
          set: (next) => {
            display.notices[index] = next;
            mark();
          },
        }),
      );
    }
  }
  const error = target['error'];
  if (error && typeof error === 'object' && !Array.isArray(error))
    collect(error as Record<string, unknown>, 'message');
  return slots;
}

/** UTF-8 bytes one code point occupies inside a JSON string literal. */
function jsonCodePointBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20)
    return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint) ? 2 : 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  // JSON.stringify escapes an unpaired surrogate as `\uXXXX`.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return codePoint < 0x10000 ? 3 : 4;
}

/** UTF-8 bytes `text` occupies inside a JSON string literal. */
function jsonTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/**
 * Cuts the middle of one slot so its JSON-encoded text, notice included,
 * takes at most `targetBytes`. Budgets are counted in encoded bytes because
 * that is what the wire limit measures, and whole code points are removed so a
 * surrogate pair is never split. A slot too short to hold its notice is left
 * as it is rather than grown.
 */
function cutProviderFitSlot(
  slot: ProviderFitSlot,
  targetBytes: number,
  budgetBytes: number,
): void {
  const text = slot.get();
  const size = jsonTextBytes(text);
  if (size <= targetBytes) return;
  // `text.length` bounds the omitted code points, so this notice is the
  // largest the cut can produce.
  const keep = Math.max(
    0,
    targetBytes - jsonTextBytes(providerFitNotice(text.length, budgetBytes)),
  );
  let head = 0;
  let headBytes = 0;
  while (head < text.length) {
    const codePoint = text.codePointAt(head)!;
    const cost = jsonCodePointBytes(codePoint);
    if (headBytes + cost > Math.ceil(keep / 2)) break;
    headBytes += cost;
    head += codePoint > 0xffff ? 2 : 1;
  }
  let tail = text.length;
  let tailBytes = 0;
  while (tail > head) {
    let start = tail - 1;
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff && start > head) {
      const previous = text.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start--;
    }
    const cost = jsonCodePointBytes(text.codePointAt(start)!);
    if (headBytes + tailBytes + cost > keep) break;
    tailBytes += cost;
    tail = start;
  }
  let omitted = 0;
  for (const _ of text.slice(head, tail)) omitted++;
  const next =
    text.slice(0, head) +
    providerFitNotice(omitted, budgetBytes) +
    text.slice(tail);
  if (omitted > 0 && jsonTextBytes(next) < size) slot.set(next);
}

interface ProviderFitSize {
  readonly bytes: number;
  /** The largest notice a cut can leave; a slot no larger never shrinks. */
  readonly floor: number;
}

/** The bytes the slots give up when every one above `level` is cut to it. */
function providerFitShed(
  slots: readonly ProviderFitSize[],
  level: number,
): number {
  return slots.reduce(
    (shed, { bytes, floor }) =>
      shed + Math.max(0, bytes - Math.max(level, floor)),
    0,
  );
}

/**
 * The highest common size the slots can be cut to so they shed `excess`
 * bytes together: no field is emptied while another keeps most of its text,
 * and each slot's floor is counted, so fields whose notices differ in size
 * still meet the budget in one pass.
 */
function providerFitLevel(
  slots: readonly ProviderFitSize[],
  excess: number,
): number {
  let low = 0;
  let high = slots.reduce((largest, { bytes }) => Math.max(largest, bytes), 0);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (providerFitShed(slots, middle) >= excess) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Shrinks an `execute`/`status`/`cancel` result until its JSON fits the wire
 * budget, so a legitimately large tool result stays observable instead of
 * turning the route's size gate into a 400 that strands the execution as
 * UNKNOWN. Oldest progress events are evicted first (the client is told
 * through `firstAvailableSeq`/`progressGap`), then bulk text fields are cut
 * head-and-tail with an inline notice; `truncated` is set on shell displays.
 * Mutates and returns `value`; the caller owns a JSON-round-tripped copy.
 */
export function fitManagedRuntimeProviderResult(
  operation: ManagedRuntimeProviderOperation,
  value: unknown,
  budgetBytes: number,
): unknown {
  if (
    operation.kind !== 'execute' &&
    operation.kind !== 'status' &&
    operation.kind !== 'cancel'
  )
    return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const fits = () =>
    Buffer.byteLength(JSON.stringify(root), 'utf8') <= budgetBytes;
  if (fits()) return value;
  const status = operation.kind === 'execute' ? undefined : root;
  const execution = (
    operation.kind === 'execute' ? root : status?.['result']
  ) as Record<string, unknown> | undefined;

  // 1. Evict oldest progress events; they re-derive from the settled result.
  const progress = status?.['progress'];
  if (status !== undefined && Array.isArray(progress) && progress.length > 0) {
    const lastSeq =
      typeof status['lastSeq'] === 'number' ? status['lastSeq'] : 0;
    const sizes = progress.map(
      (event) => Buffer.byteLength(JSON.stringify(event), 'utf8') + 1,
    );
    let bytes = Buffer.byteLength(JSON.stringify(root), 'utf8');
    let evict = 0;
    while (evict < progress.length && bytes > budgetBytes)
      bytes -= sizes[evict++];
    // The estimate can be a few bytes off; close the gap exactly. Progress is
    // evicted before result text is cut because it re-derives from the
    // settled result.
    let retained = progress.slice(evict);
    while (true) {
      status['progress'] = retained;
      const first = retained[0];
      status['firstAvailableSeq'] =
        first &&
        typeof first === 'object' &&
        typeof (first as Record<string, unknown>)['seq'] === 'number'
          ? ((first as Record<string, unknown>)['seq'] as number)
          : lastSeq + 1;
      status['progressGap'] = true;
      if (
        retained.length === 0 ||
        Buffer.byteLength(JSON.stringify(root), 'utf8') <= budgetBytes
      )
        break;
      retained = retained.slice(1);
    }
  }

  // 2. Cut the bulk text fields once, down to one common size. Each field is
  //    cut at most once, so its notice counts everything omitted. When even
  //    every field at its floor cannot meet the budget, step 3 takes over.
  if (execution && !fits()) {
    const measure = () =>
      providerFitSlots(execution).map((slot) => ({
        slot,
        bytes: jsonTextBytes(slot.get()),
        floor: jsonTextBytes(providerFitNotice(slot.get().length, budgetBytes)),
      }));
    let slots = measure();
    // What the cut cannot reach goes before any text is cut when even fully
    // cut text could not fit beside it: first what only feeds a client
    // surface (a structured display such as a file diff, then artifacts),
    // then hook results, so the model keeps its own content.
    const overflows = () =>
      Buffer.byteLength(JSON.stringify(root), 'utf8') -
        providerFitShed(slots, 0) >
      budgetBytes;
    const result = execution['result'];
    const toolResult =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : undefined;
    const display = toolResult?.['returnDisplay'];
    if (
      toolResult &&
      display !== undefined &&
      typeof display !== 'string' &&
      overflows()
    ) {
      toolResult['returnDisplay'] = PROVIDER_RESULT_STUB;
      slots = measure();
    }
    if (toolResult && toolResult['artifacts'] !== undefined && overflows())
      delete toolResult['artifacts'];
    if (overflows()) {
      delete execution['postHook'];
      delete execution['failureHook'];
    }
    if (!fits()) {
      const level = providerFitLevel(
        slots,
        Buffer.byteLength(JSON.stringify(root), 'utf8') - budgetBytes,
      );
      for (const { slot, bytes } of slots)
        if (bytes > level) cutProviderFitSlot(slot, level, budgetBytes);
    }
  }

  // 3. Last resort: when even that cannot fit (content the cut cannot reach,
  //    such as inline media), the model content becomes an explicit stub so
  //    the terminal observation always fits.
  if (!fits() && execution) {
    const result = execution['result'];
    if (result && typeof result === 'object' && !Array.isArray(result))
      (result as Record<string, unknown>)['llmContent'] = PROVIDER_RESULT_STUB;
  }
  return value;
}
