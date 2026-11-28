/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

export type ServiceAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'auth-required';

export interface ServiceAvailabilityController {
  getSnapshot(): ServiceAvailabilityState;
  subscribe(listener: () => void): () => void;
  assertAvailable(): void;
  getGeneration(): number;
  reportFailure(
    error: unknown,
    signal?: AbortSignal,
    generation?: number,
    source?: 'fetch' | 'consumer',
  ): void;
}

export class ServiceUnavailableError extends Error {
  constructor(message = 'The service is unavailable.') {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

export function isServiceUnavailableError(error: unknown): boolean {
  return error instanceof ServiceUnavailableError;
}

export const ServiceAvailabilityContext = createContext<
  ServiceAvailabilityController | undefined
>(undefined);

const noopSubscribe = () => () => {};
const alwaysAvailable = (): ServiceAvailabilityState => 'available';

export function useServiceAvailabilityController():
  | ServiceAvailabilityController
  | undefined {
  return useContext(ServiceAvailabilityContext);
}

export function useServiceAvailability(): ServiceAvailabilityState {
  const controller = useServiceAvailabilityController();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? alwaysAvailable,
    alwaysAvailable,
  );
}
