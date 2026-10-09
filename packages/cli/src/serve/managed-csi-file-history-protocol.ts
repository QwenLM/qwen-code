/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  parseHostedFileHistoryState,
  type HostedFileHistoryState,
} from './hosted-file-history-protocol.js';
import type { ManagedCsiBackupPin } from './managed-csi-file-backend.js';
import {
  MANAGED_CSI_FILE_PROTOCOL,
  type ManagedCsiFileBoot,
} from './managed-csi-file-envelope.js';
import { createManagedContextAttestationResponse } from './managed-context-envelope.js';
import { readCsiNativeRequest } from './managed-csi-native-readback.js';
import type { CsiNativeReadbackResponse } from './managed-csi-native-readback.js';
import { historyPath } from './hosted-file-history-protocol.js';
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import { parseManagedSessionRecordJson } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export const CSI_FILE_HISTORY_PATH =
  '/internal/managed-runtime/csi/v2/file-history';
export type CsiFileHistoryOperation =
  | { kind: 'csi-file-history'; version: 1; action: 'bind' | 'snapshot' }
  | {
      kind: 'csi-file-history';
      version: 1;
      action: 'prepare';
      preparationRef: ManagedSessionDurableRef;
    };
export interface CsiFileHistoryObservation {
  state: HostedFileHistoryState;
  backupDirectory: {
    volumeDevice: string;
    volumeInode: string;
    directoryDevice: string;
    directoryInode: string;
  };
  retainedBackups: ManagedCsiBackupPin[];
}

export interface CsiHistoryInvocation {
  executionCallId: string;
  callId: string;
  functionCallId: string;
  toolName: string;
  partIndex: number;
  ordinal: number;
  requestDigest: string;
  inputRef: ManagedSessionDurableRef;
  toolDefinitionRef: ManagedSessionDurableRef;
}
export interface CsiHistoryPreparation {
  stage: 'intent' | 'prepared';
  turnId: string;
  promptId: string;
  batchId: string;
  invocations: CsiHistoryInvocation[];
  paths: string[];
  intentRef?: ManagedSessionDurableRef;
}

export function readCsiPreparationEvidence(
  response: CsiNativeReadbackResponse,
): {
  preparation: CsiHistoryPreparation;
  observation: CsiFileHistoryObservation;
} {
  ensure(response.action === 'prepare');
  const owner = response.identity['sessionId'];
  ensure(typeof owner === 'string');
  const evidence = response.evidence;
  ensure(
    evidence['kind'] === 'intent' &&
      Array.isArray(evidence['resources']) &&
      Array.isArray(evidence['members']),
  );
  const resources = new Map<string, Buffer>();
  for (const candidate of evidence['resources']) {
    const item = object(candidate);
    const ref = object(item['reference']);
    ensure(
      typeof ref['resourceId'] === 'string' &&
        typeof item['bytesBase64'] === 'string',
    );
    resources.set(
      ref['resourceId'],
      Buffer.from(item['bytesBase64'], 'base64'),
    );
  }
  const originalRef = object(evidence['intentRef']);
  ensure(typeof originalRef['resourceId'] === 'string');
  const bytes = resources.get(originalRef['resourceId']);
  ensure(bytes !== undefined);
  const body = closed(parseManagedCsiFileJson(bytes, 64 * 1024), [
    'operationId',
    'revision',
    'previousRecordRef',
    'schemaVersion',
    'profile',
    'runtimeSessionId',
    'state',
    'backupDirectory',
    'retainedBackups',
    'preparation',
    'record',
  ]);
  ensure(
    body['schemaVersion'] === 2 &&
      body['profile'] === 'csi-files-retirement/1' &&
      body['runtimeSessionId'] === owner,
  );
  const preparation = closed(body['preparation'], [
    'stage',
    'turnId',
    'promptId',
    'batchId',
    'invocations',
    'paths',
  ]);
  ensure(
    preparation['stage'] === 'intent' &&
      preparation['turnId'] === preparation['promptId'] &&
      Array.isArray(preparation['invocations']) &&
      Array.isArray(preparation['paths']) &&
      preparation['invocations'].length === evidence['members'].length,
  );
  const paths = new Set<string>();
  for (const [index, candidate] of preparation['invocations'].entries()) {
    const invocation = closed(candidate, [
      'executionCallId',
      'callId',
      'functionCallId',
      'toolName',
      'partIndex',
      'ordinal',
      'requestDigest',
      'inputRef',
      'toolDefinitionRef',
    ]);
    ensure(
      typeof invocation['executionCallId'] === 'string' &&
        invocation['executionCallId'].length > 0,
    );
    const member = object(evidence['members'][index]);
    ensure(
      isDeepStrictEqual(member, {
        sessionId: owner,
        promptId: preparation['promptId'],
        batchId: preparation['batchId'],
        callId: invocation['callId'],
        functionCallId: invocation['functionCallId'],
        partIndex: invocation['partIndex'],
        ordinal: invocation['ordinal'],
        argsDigest: invocation['requestDigest'],
        inputRef: invocation['inputRef'],
        toolDefinitionRef: invocation['toolDefinitionRef'],
        dispatchMode: 'deferred',
      }),
    );
    const inputRef = object(invocation['inputRef']);
    ensure(typeof inputRef['resourceId'] === 'string');
    const inputBytes = resources.get(inputRef['resourceId']);
    ensure(inputBytes !== undefined);
    const wrapper = closed(parseManagedCsiFileJson(inputBytes, 64 * 1024), [
      'harnessSessionId',
      'runtimeSessionId',
      'payloadJson',
    ]);
    ensure(
      wrapper['harnessSessionId'] === owner &&
        wrapper['runtimeSessionId'] === owner &&
        typeof wrapper['payloadJson'] === 'string',
    );
    const payload = closed(
      parseManagedSessionRecordJson(wrapper['payloadJson'], 64 * 1024),
      ['toolName', 'input'],
    );
    ensure(
      payload['toolName'] === invocation['toolName'] &&
        ['read_file', 'write_file', 'edit'].includes(
          String(invocation['toolName']),
        ),
    );
    const file = historyPath(object(payload['input'])['file_path']);
    if (invocation['toolName'] !== 'read_file') paths.add(file);
  }
  ensure(
    paths.size > 0 &&
      isDeepStrictEqual([...paths].sort(), preparation['paths']),
  );
  return {
    preparation: structuredClone(
      preparation,
    ) as unknown as CsiHistoryPreparation,
    observation: readCsiFileHistoryObservation(
      {
        state: body['state'],
        backupDirectory: body['backupDirectory'],
        retainedBackups: body['retainedBackups'],
      },
      owner,
    ),
  };
}

export function readCsiFileHistoryOperation(
  value: unknown,
): CsiFileHistoryOperation {
  const operation = object(value);
  closed(operation, [
    'kind',
    'version',
    'action',
    ...(operation['action'] === 'prepare' ? ['preparationRef'] : []),
  ]);
  ensure(
    operation['kind'] === 'csi-file-history' && operation['version'] === 1,
  );
  ensure(['bind', 'snapshot', 'prepare'].includes(String(operation['action'])));
  if (operation['action'] === 'prepare') {
    const reference = assertManagedSessionDurableRef(
      operation['preparationRef'] as ManagedSessionJsonValue,
      'CSI preparation',
    );
    ensure(
      reference.kind === 'managed-file_history' &&
        reference.schemaVersion === 1 &&
        reference.byteLength > 0 &&
        reference.byteLength <= 64 * 1024,
    );
  }
  return structuredClone(operation) as unknown as CsiFileHistoryOperation;
}

export function csiFileHistoryEnvelope(
  boot: ManagedCsiFileBoot,
  installedContext: Record<string, unknown>,
  operation: CsiFileHistoryOperation,
) {
  ensure(boot.version === 5);
  const result = {
    protocolVersion: 2,
    managedCsi: MANAGED_CSI_FILE_PROTOCOL,
    identity: boot.identity,
    context: createManagedContextAttestationResponse(boot.context),
    installedContext,
    operation: readCsiFileHistoryOperation(operation),
  };
  readCsiFileHistoryEnvelope(result, boot, installedContext);
  ensure(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
  return result;
}

export function readCsiFileHistoryEnvelope(
  value: unknown,
  boot: ManagedCsiFileBoot,
  installedContext: Record<string, unknown>,
): CsiFileHistoryOperation {
  const body = closed(value, [
    'protocolVersion',
    'managedCsi',
    'identity',
    'context',
    'installedContext',
    'operation',
  ]);
  ensure(
    boot.version === 5 &&
      body['protocolVersion'] === 2 &&
      body['managedCsi'] === MANAGED_CSI_FILE_PROTOCOL,
  );
  ensure(
    isDeepStrictEqual(body['identity'], boot.identity) &&
      isDeepStrictEqual(
        body['context'],
        createManagedContextAttestationResponse(boot.context),
      ) &&
      isDeepStrictEqual(body['installedContext'], installedContext),
  );
  readCsiNativeRequest({
    protocolVersion: 1,
    requestId: '00000000-0000-4000-8000-000000000000',
    action: 'bind',
    identity: boot.identity,
    context: body['context'],
    installedContext,
    subject: null,
  });
  return readCsiFileHistoryOperation(body['operation']);
}

export function readCsiFileHistoryObservation(
  value: unknown,
  owner: string,
): CsiFileHistoryObservation {
  const body = closed(value, ['state', 'backupDirectory', 'retainedBackups']);
  const state = parseHostedFileHistoryState(body['state'], owner);
  const directory = closed(body['backupDirectory'], [
    'volumeDevice',
    'volumeInode',
    'directoryDevice',
    'directoryInode',
  ]);
  for (const value of Object.values(directory)) decimal(value);
  ensure(directory['volumeDevice'] === directory['directoryDevice']);
  ensure(Array.isArray(body['retainedBackups']));
  const pins = new Map<string, ManagedCsiBackupPin>();
  let previous = '';
  for (const candidate of body['retainedBackups']) {
    const pin = closed(candidate, [
      'name',
      'device',
      'inode',
      'byteLength',
      'digest',
      'mode',
    ]);
    const name = pin['name'];
    ensure(
      typeof name === 'string' &&
        name.length > 0 &&
        name.length <= 256 &&
        name !== '.' &&
        name !== '..' &&
        !/[/\\]/.test(name) &&
        [...name].every(
          (char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
        ) &&
        name > previous,
    );
    decimal(pin['device']);
    decimal(pin['inode']);
    ensure(pin['device'] === directory['volumeDevice']);
    ensure(
      Number.isSafeInteger(pin['byteLength']) &&
        (pin['byteLength'] as number) >= 0 &&
        (pin['byteLength'] as number) < Number.MAX_SAFE_INTEGER,
    );
    ensure(
      Number.isSafeInteger(pin['mode']) &&
        (pin['mode'] as number) >= 0 &&
        (pin['mode'] as number) <= 0o7777,
    );
    ensure(
      typeof pin['digest'] === 'string' && /^[0-9a-f]{64}$/.test(pin['digest']),
    );
    pins.set(name, structuredClone(pin) as unknown as ManagedCsiBackupPin);
    previous = name;
  }
  const names = new Set<string>();
  for (const snapshot of state.snapshots) {
    ensure(
      snapshot.promptId.normalize('NFC') === snapshot.promptId &&
        Buffer.byteLength(snapshot.promptId) <= 512 &&
        [...snapshot.promptId].every(
          (char) =>
            char.charCodeAt(0) > 31 &&
            (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159),
        ),
    );
    for (const backup of Object.values(snapshot.trackedFileBackups)) {
      ensure(
        backup.failed !== true && backup.version < Number.MAX_SAFE_INTEGER,
      );
      if (backup.backupFileName !== null) {
        ensure(pins.has(backup.backupFileName));
        names.add(backup.backupFileName);
      }
    }
  }
  ensure(names.size === pins.size);
  return {
    state,
    backupDirectory: structuredClone(
      directory,
    ) as unknown as CsiFileHistoryObservation['backupDirectory'],
    retainedBackups: [...pins.values()],
  };
}

function decimal(value: unknown): void {
  ensure(
    typeof value === 'string' &&
      /^(?:0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 20 &&
      BigInt(value) <= 18446744073709551615n,
  );
}

export function csiHistoryContentDigest(
  content: Record<string, unknown>,
): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    const result = JSON.stringify(value);
    ensure(result !== undefined);
    return result;
  };
  const semantic = { ...content };
  delete semantic['record'];
  return createHash('sha256').update(canonical(semantic)).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  const body = object(value);
  ensure(isDeepStrictEqual(Object.keys(body).sort(), [...keys].sort()));
  return body;
}
function ensure(condition: boolean): asserts condition {
  if (!condition) throw new Error('Invalid private CSI file history.');
}
