/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type {
  TrajectoryLiveSnapshot,
  TrajectoryLiveStore,
} from './trajectory-live-store.js';

const emptySnapshot: TrajectoryLiveSnapshot = {
  status: 'unavailable',
  requests: { entries: new Map() },
  tools: { entries: new Map() },
  incomplete: false,
  truncated: false,
};
const getEmptySnapshot = () => emptySnapshot;
const subscribeToEmptySnapshot = () => () => {};
export const TrajectoryLiveContext = createContext<TrajectoryLiveStore | null>(
  null,
);

export function useTrajectoryLiveSnapshot() {
  const store = useContext(TrajectoryLiveContext);
  return useSyncExternalStore(
    store?.subscribe ?? subscribeToEmptySnapshot,
    store?.getSnapshot ?? getEmptySnapshot,
    store?.getSnapshot ?? getEmptySnapshot,
  );
}
