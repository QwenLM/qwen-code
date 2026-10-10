/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookEventName,
  HooksConfigSource,
  HookExecutionOutcome,
  HookInput,
  HookOutput,
  PromptHookConfig,
} from '../hooks/types.js';
import type { OperationGrant } from './managed-extension-record.js';
import type { ManagedSessionKey } from './managed-session-records.js';

export const MANAGED_HOOK_ROUTE = '/internal/managed-runtime/v3/hooks';
export const MANAGED_HOOK_MAX_RUNNING = 16;
export const MANAGED_HOOK_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface RegisteredHandlerRef {
  readonly handlerId: string;
  readonly handlerRevision: number;
}

export interface ManagedHookCatalogPin {
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly definitionDigest: string;
}

export interface ManagedHookDescriptor {
  readonly source?: HooksConfigSource;
  readonly sourceTrusted?: boolean;
  readonly enabled?: boolean;
  readonly agentScope?: string;
  readonly owner?: {
    readonly sessionId: string;
    readonly agentId: string | null;
  };
  readonly plannerKey?: string;
  readonly hookId: string;
  readonly eventName: HookEventName;
  readonly matcher?: string;
  readonly sequential: boolean;
  readonly onceKey: string | null;
  readonly failClosed: boolean;
  readonly async: boolean;
  readonly config:
    | PromptHookConfig
    | {
        readonly type: 'command' | 'http' | 'function';
        readonly name?: string;
      };
  readonly handler?: RegisteredHandlerRef;
}

export interface ManagedHookCatalog extends ManagedHookCatalogPin {
  readonly hooks: readonly ManagedHookDescriptor[];
}

interface Identity {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
}

export interface ManagedHookCatalogRequest extends Identity {
  readonly kind: 'hook-catalog';
  readonly pin: ManagedHookCatalogPin;
}

export interface ManagedHookExecute extends Identity {
  readonly kind: 'hook-execute';
  readonly pin: ManagedHookCatalogPin;
  readonly hookId: string;
  readonly input: HookInput;
  readonly grant: OperationGrant;
}

export type ManagedHookLookup = Identity & {
  readonly targetOperationId: string;
} & ({ readonly kind: 'hook-status' } | { readonly kind: 'hook-cancel' });

export type ManagedHookControl =
  | ManagedHookCatalogRequest
  | ManagedHookExecute
  | ManagedHookLookup;

export interface ManagedHookResult {
  readonly success: boolean;
  readonly outcome: HookExecutionOutcome;
  readonly duration: number;
  readonly output?: HookOutput;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export interface ManagedHookOperationView {
  readonly operationId: string;
  readonly state: 'running' | 'settled' | 'outcome_unknown';
  readonly catalog?: ManagedHookCatalog;
  readonly result?: ManagedHookResult;
  readonly error?: { readonly code: string };
}
