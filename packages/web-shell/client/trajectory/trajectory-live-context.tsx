/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  createTrajectoryLiveStore,
  type TrajectoryLiveStore,
} from './trajectory-live-store.js';

const emptyStore = createTrajectoryLiveStore();
export const TrajectoryLiveContext =
  createContext<TrajectoryLiveStore>(emptyStore);

export function useTrajectoryLiveSnapshot() {
  const store = useContext(TrajectoryLiveContext);
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
