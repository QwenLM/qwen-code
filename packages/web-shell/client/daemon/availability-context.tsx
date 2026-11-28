import type { Context } from 'react';
import {
  ServiceAvailabilityContext,
  useServiceAvailability,
  useServiceAvailabilityController,
} from '../utils/service-availability.js';
import type {
  DaemonAvailability,
  DaemonAvailabilityState,
} from './availability.js';

export const DaemonAvailabilityContext =
  ServiceAvailabilityContext as unknown as Context<
    DaemonAvailability | undefined
  >;

export function useDaemonAvailabilityController():
  | DaemonAvailability
  | undefined {
  return useServiceAvailabilityController() as DaemonAvailability | undefined;
}

export function useDaemonAvailability(): DaemonAvailabilityState {
  return useServiceAvailability();
}
