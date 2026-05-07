/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DualOutputBridgeLike } from '../dualOutput/DualOutputContext.js';
import type { RemoteInputController } from '../remoteInput/RemoteInputContext.js';
import {
  MutableDualOutputBridge,
  MutableRemoteInputController,
} from './TuiRemoteControlManager.js';

function createDualOutputBridge(
  overrides: Partial<DualOutputBridgeLike> = {},
): DualOutputBridgeLike {
  return {
    isConnected: true,
    processEvent: vi.fn(),
    startAssistantMessage: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    emitUserMessage: vi.fn(),
    emitToolResult: vi.fn(),
    emitPermissionRequest: vi.fn(),
    emitControlResponse: vi.fn(),
    emitControlError: vi.fn(),
    emitSystemMessage: vi.fn(),
    ...overrides,
  };
}

function createRemoteInputController(): RemoteInputController {
  return {
    setSubmitFn: vi.fn(),
    setConfirmationHandler: vi.fn(),
    setControlHandler: vi.fn(),
    notifyIdle: vi.fn(),
  };
}

describe('MutableDualOutputBridge', () => {
  it('fans events out to connected bridges and supports removal', () => {
    const mutable = new MutableDualOutputBridge();
    const connected = createDualOutputBridge();
    const disconnected = createDualOutputBridge({ isConnected: false });

    const removeConnected = mutable.addBridge(connected);
    mutable.addBridge(disconnected);
    mutable.startAssistantMessage();

    expect(connected.startAssistantMessage).toHaveBeenCalled();
    expect(disconnected.startAssistantMessage).not.toHaveBeenCalled();
    expect(mutable.isConnected).toBe(true);

    removeConnected();
    expect(mutable.isConnected).toBe(false);
  });
});

describe('MutableRemoteInputController', () => {
  it('applies existing handlers to controllers added later', () => {
    const mutable = new MutableRemoteInputController();
    const submit = vi.fn();
    const confirmation = vi.fn();
    const control = vi.fn();
    mutable.setSubmitFn(submit);
    mutable.setConfirmationHandler(confirmation);
    mutable.setControlHandler(control);

    const controller = createRemoteInputController();
    mutable.addController(controller);

    expect(controller.setSubmitFn).toHaveBeenCalledWith(submit);
    expect(controller.setConfirmationHandler).toHaveBeenCalledWith(
      confirmation,
    );
    expect(controller.setControlHandler).toHaveBeenCalledWith(control);
  });

  it('fans notifyIdle out to all controllers', () => {
    const mutable = new MutableRemoteInputController();
    const first = createRemoteInputController();
    const second = createRemoteInputController();
    mutable.addController(first);
    mutable.addController(second);

    mutable.notifyIdle();

    expect(first.notifyIdle).toHaveBeenCalled();
    expect(second.notifyIdle).toHaveBeenCalled();
  });
});
