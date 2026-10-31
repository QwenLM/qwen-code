import { createContext, useContext, useSyncExternalStore } from 'react';
import type {
  DaemonAvailability,
  DaemonAvailabilityState,
} from './availability.js';

export const DaemonAvailabilityContext = createContext<
  DaemonAvailability | undefined
>(undefined);

const subscribe = () => () => {};
const available = (): DaemonAvailabilityState => 'available';

export function useDaemonAvailabilityController() {
  return useContext(DaemonAvailabilityContext);
}

export function useDaemonAvailability(): DaemonAvailabilityState {
  const controller = useDaemonAvailabilityController();
  return useSyncExternalStore(
    controller?.subscribe ?? subscribe,
    controller?.getSnapshot ?? available,
    available,
  );
}
