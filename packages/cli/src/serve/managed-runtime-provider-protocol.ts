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

export interface ManagedRuntimeProviderSession {
  readonly harnessSessionId: string;
  readonly runtimeSessionId: string;
  readonly turnKind: 'bootstrap' | 'continuation';
}

export type ManagedRuntimeProviderControl =
  | { kind: 'manifest' | 'history' }
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
 * owner's directory name, both of which are interpolated into file names, so
 * only the lowercase UUID form every in-repo producer already generates is
 * admitted. Lowercase-only (no case folding): `checkSession` compares this
 * value verbatim against core's lowercased identity, and the response echoes
 * it unchanged for the Broker's equality check.
 */
const ENVELOPE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function envelopeSessionId(value: unknown): void {
  if (typeof value !== 'string' || !ENVELOPE_SESSION_ID_PATTERN.test(value))
    throw new ManagedRuntimeProviderProtocolError(
      'Managed Runtime provider Session identity must be a lowercase UUID.',
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
    case 'acquire':
    case 'release':
    case 'manifest':
    case 'history':
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
    case 'confirmation':
      if (
        !oneOf(result['type'], ['edit', 'exec', 'mcp', 'info']) ||
        typeof result['title'] !== 'string'
      )
        throw new ManagedRuntimeProviderProtocolError();
      break;
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

function cutProviderFitSlot(
  slot: ProviderFitSlot,
  removeChars: number,
  budgetBytes: number,
): void {
  const text = slot.get();
  let omitted = removeChars;
  for (let attempt = 0; attempt < 2; attempt++) {
    const notice = providerFitNotice(omitted, budgetBytes);
    const keep = text.length - omitted - notice.length;
    if (keep < 2) {
      const reduced = text.length - notice.length - 2;
      if (reduced <= 0 || reduced >= omitted) return;
      omitted = reduced;
      continue;
    }
    const head = Math.ceil(keep / 2);
    slot.set(text.slice(0, head) + notice + text.slice(head + omitted));
    return;
  }
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

  // 2. Cut the bulk text fields, largest first, until the budget is met.
  for (let attempt = 0; attempt < 8 && !fits(); attempt++) {
    if (!execution) break;
    const slots = providerFitSlots(execution);
    let largest: ProviderFitSlot | undefined;
    let largestBytes = 0;
    for (const slot of slots) {
      const bytes = Buffer.byteLength(slot.get(), 'utf8');
      if (bytes > largestBytes) {
        largest = slot;
        largestBytes = bytes;
      }
    }
    if (!largest) break;
    const excess =
      Buffer.byteLength(JSON.stringify(root), 'utf8') - budgetBytes;
    cutProviderFitSlot(largest, excess + 128, budgetBytes);
  }

  // 3. Last resort: replace the remaining payload with an explicit stub so
  //    the terminal observation always fits.
  if (!fits() && execution) {
    delete execution['postHook'];
    delete execution['failureHook'];
    const result = execution['result'];
    if (
      !fits() &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result)
    ) {
      const toolResult = result as Record<string, unknown>;
      toolResult['llmContent'] = PROVIDER_RESULT_STUB;
      if (
        toolResult['returnDisplay'] !== undefined &&
        typeof toolResult['returnDisplay'] !== 'string'
      )
        toolResult['returnDisplay'] = PROVIDER_RESULT_STUB;
    }
  }
  return value;
}
