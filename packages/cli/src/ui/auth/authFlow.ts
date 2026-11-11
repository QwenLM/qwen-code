/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AuthGateRequest {
  readonly id: number;
  readonly kind: 'login' | 'refresh';
}

let requestId = 0;
let current: AuthGateRequest | undefined;
const listeners = new Set<() => void>();

/** Ask the session gate to reopen the connect-provider flow. */
export function requestAuthGate(kind: AuthGateRequest['kind'] = 'login'): void {
  requestId += 1;
  current = { id: requestId, kind };
  for (const listener of listeners) listener();
}

export function subscribeAuthGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthGateRequest(): AuthGateRequest | undefined {
  return current;
}
