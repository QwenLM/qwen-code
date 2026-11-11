/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { theme } from '../semantic-colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { coreEvents, CoreEvent } from '@qwen-code/core';

// Re-export profiler state from the standalone module (no ink dependency)
// to maintain backward compatibility for existing importers.
export {
  profiler,
  ACTION_TIMESTAMP_CAPACITY,
  FRAME_TIMESTAMP_CAPACITY,
} from './profiler-state.js';

// Import for local use in the component
import { profiler } from './profiler-state.js';

export const DebugProfiler = () => {
  const { showDebugProfiler, constrainHeight } = useUIState();
  const [forceRefresh, setForceRefresh] = useState(0);

  // Effect for listening to stdout resize and core/app events.
  // Note: stdin action tracking is handled directly in App.tsx's
  // processKeysInBatch (stdin.on('data') is unreliable when App uses
  // stdin.on('readable') + read()).
  useEffect(() => {
    profiler.profilersActive++;
    const stdout = process.stdout;

    const handler = () => {
      profiler.reportAction();
    };

    stdout.on('resize', handler);

    // Register handlers for all core and app events to ensure they are
    // considered "actions" and don't trigger spurious idle frame warnings.
    // These events are expected to trigger UI renders.
    for (const eventName of Object.values(CoreEvent)) {
      coreEvents.on(eventName, handler);
    }

    for (const eventName of Object.values(AppEvent)) {
      appEvents.on(eventName, handler);
    }

    // Register handlers for extension lifecycle events emitted on coreEvents
    // but not part of the CoreEvent enum, to prevent false-positive idle warnings.
    const extensionEvents = [
      'extensionsStarting',
      'extensionsStopping',
    ] as const;
    for (const eventName of extensionEvents) {
      coreEvents.on(eventName, handler);
    }

    return () => {
      stdout.off('resize', handler);

      for (const eventName of Object.values(CoreEvent)) {
        coreEvents.off(eventName, handler);
      }

      for (const eventName of Object.values(AppEvent)) {
        appEvents.off(eventName, handler);
      }

      for (const eventName of extensionEvents) {
        coreEvents.off(eventName, handler);
      }

      profiler.profilersActive--;
    };
  }, []);

  useEffect(() => {
    const updateInterval = setInterval(() => {
      profiler.checkForIdleFrames();
    }, 1000);
    return () => clearInterval(updateInterval);
  }, []);

  useEffect(
    () => profiler.registerFlickerHandler(constrainHeight),
    [constrainHeight],
  );

  // Effect for updating stats
  useEffect(() => {
    if (!showDebugProfiler) {
      return;
    }
    // Only update the UX infrequently as updating the UX itself will cause
    // frames to run so can disturb what we are measuring.
    const forceRefreshInterval = setInterval(() => {
      setForceRefresh((f) => f + 1);
      profiler.reportAction();
    }, 4000);
    return () => clearInterval(forceRefreshInterval);
  }, [showDebugProfiler]);

  if (!showDebugProfiler) {
    return null;
  }

  return (
    <Text color={theme.status.warning} key={forceRefresh}>
      Renders: {profiler.numFrames} (total),{' '}
      <Text color={theme.status.error}>{profiler.totalIdleFrames} (idle)</Text>,{' '}
      <Text color={theme.status.error}>
        {profiler.totalFlickerFrames} (flicker)
      </Text>
    </Text>
  );
};
