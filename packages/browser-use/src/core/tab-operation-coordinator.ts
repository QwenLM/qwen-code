/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';
import { isLegacyObservationCommand } from './primitive-compatibility.js';
import type { SupportedCommand } from './schemas.js';

/**
 * Prevents two state-changing operations from interleaving on one tab.
 *
 * Observation/waiter commands deliberately do not take the lease: workflows
 * such as `waitForEvent()` followed by the triggering click require both calls
 * to be alive at the same time. Different tabs remain independent.
 */
export class TabOperationCoordinator {
  private readonly activeActions = new Map<
    string,
    { method: SupportedCommand }
  >();
  private readonly openGestures = new Map<string, 'pointer' | 'keyboard'>();

  async run<T>(
    method: SupportedCommand,
    args: Readonly<Record<string, unknown>>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : undefined;
    if (tabId === undefined || isLegacyObservationCommand(method))
      return await operation();

    const active = this.activeActions.get(tabId);
    if (active !== undefined) {
      throw new BrowserRuntimeError(
        'CONCURRENT_TAB_OPERATION',
        `Cannot run ${method} while ${active.method} is still changing the same tab`,
        { tabId, activeMethod: active.method, rejectedMethod: method },
      );
    }

    const gesture = this.openGestures.get(tabId);
    if (gesture !== undefined && !continuesGesture(method, gesture)) {
      throw new BrowserRuntimeError(
        'CONCURRENT_TAB_OPERATION',
        `Cannot run ${method} while a split ${gesture} gesture is still open on the same tab`,
        { tabId, activeGesture: gesture, rejectedMethod: method },
      );
    }

    const lease = { method };
    this.activeActions.set(tabId, lease);
    try {
      return await operation();
    } finally {
      if (this.activeActions.get(tabId) === lease)
        this.activeActions.delete(tabId);
    }
  }

  beginGesture(tabId: string, gesture: 'pointer' | 'keyboard'): void {
    const active = this.openGestures.get(tabId);
    if (active !== undefined && active !== gesture) {
      throw new BrowserRuntimeError(
        'CONCURRENT_TAB_OPERATION',
        `Cannot begin a ${gesture} gesture while a ${active} gesture is open on the same tab`,
        { tabId, activeGesture: active, rejectedGesture: gesture },
      );
    }
    this.openGestures.set(tabId, gesture);
  }

  endGesture(tabId: string, gesture: 'pointer' | 'keyboard'): void {
    if (this.openGestures.get(tabId) === gesture)
      this.openGestures.delete(tabId);
  }

  clearTab(tabId: string): void {
    // An in-flight action owns its lease until its own finally block runs.
    // Lifecycle cleanup may discard held input state, but must not admit a
    // second action while the first is still unwinding.
    this.openGestures.delete(tabId);
  }
}

export function isTabObservationCommand(method: SupportedCommand): boolean {
  return isLegacyObservationCommand(method);
}

function continuesGesture(
  method: SupportedCommand,
  gesture: 'pointer' | 'keyboard',
): boolean {
  if (
    method === 'tab.dialog.accept' ||
    method === 'tab.dialog.dismiss' ||
    method === 'tab.close'
  )
    return true;
  return gesture === 'pointer'
    ? method === 'cua.move' || method === 'cua.mouse_up'
    : method === 'cua.key_down' || method === 'cua.key_up';
}
