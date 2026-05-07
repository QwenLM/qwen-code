/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { DualOutputBridgeLike } from '../dualOutput/DualOutputContext.js';
import type {
  ConfirmationHandler,
  ControlHandler,
  SubmitFn,
} from '../remoteInput/RemoteInputWatcher.js';
import type { RemoteInputController } from '../remoteInput/RemoteInputContext.js';
import { TuiRemoteBridge } from './TuiRemoteBridge.js';
import type { RemoteControlServerInfo } from './RemoteControlServer.js';

export class MutableDualOutputBridge implements DualOutputBridgeLike {
  private readonly bridges = new Set<DualOutputBridgeLike>();

  get isConnected(): boolean {
    return [...this.bridges].some((bridge) => bridge.isConnected);
  }

  addBridge(bridge: DualOutputBridgeLike): () => void {
    this.bridges.add(bridge);
    return () => {
      this.bridges.delete(bridge);
    };
  }

  processEvent(...args: Parameters<DualOutputBridgeLike['processEvent']>) {
    this.forEachConnected((bridge) => bridge.processEvent(...args));
  }

  startAssistantMessage(
    ...args: Parameters<DualOutputBridgeLike['startAssistantMessage']>
  ) {
    this.forEachConnected((bridge) => bridge.startAssistantMessage(...args));
  }

  finalizeAssistantMessage(
    ...args: Parameters<DualOutputBridgeLike['finalizeAssistantMessage']>
  ) {
    this.forEachConnected((bridge) => bridge.finalizeAssistantMessage(...args));
  }

  emitUserMessage(
    ...args: Parameters<DualOutputBridgeLike['emitUserMessage']>
  ) {
    this.forEachConnected((bridge) => bridge.emitUserMessage(...args));
  }

  emitToolResult(...args: Parameters<DualOutputBridgeLike['emitToolResult']>) {
    this.forEachConnected((bridge) => bridge.emitToolResult(...args));
  }

  emitPermissionRequest(
    ...args: Parameters<DualOutputBridgeLike['emitPermissionRequest']>
  ) {
    this.forEachConnected((bridge) => bridge.emitPermissionRequest(...args));
  }

  emitControlResponse(
    ...args: Parameters<DualOutputBridgeLike['emitControlResponse']>
  ) {
    this.forEachConnected((bridge) => bridge.emitControlResponse(...args));
  }

  emitControlError(
    ...args: Parameters<DualOutputBridgeLike['emitControlError']>
  ) {
    this.forEachConnected((bridge) => bridge.emitControlError(...args));
  }

  emitSystemMessage(
    ...args: Parameters<DualOutputBridgeLike['emitSystemMessage']>
  ) {
    this.forEachConnected((bridge) => bridge.emitSystemMessage(...args));
  }

  private forEachConnected(fn: (bridge: DualOutputBridgeLike) => void): void {
    for (const bridge of this.bridges) {
      if (bridge.isConnected) {
        fn(bridge);
      }
    }
  }
}

export class MutableRemoteInputController implements RemoteInputController {
  private readonly controllers = new Set<RemoteInputController>();
  private submitFn: SubmitFn | null = null;
  private confirmationHandler: ConfirmationHandler | null = null;
  private controlHandler: ControlHandler | null = null;

  addController(controller: RemoteInputController): () => void {
    this.controllers.add(controller);
    if (this.submitFn) {
      controller.setSubmitFn(this.submitFn);
    }
    if (this.confirmationHandler) {
      controller.setConfirmationHandler(this.confirmationHandler);
    }
    if (this.controlHandler) {
      controller.setControlHandler(this.controlHandler);
    }
    return () => {
      this.controllers.delete(controller);
      controller.setConfirmationHandler(() => {});
      controller.setControlHandler(() => {});
    };
  }

  setSubmitFn(fn: SubmitFn): void {
    this.submitFn = fn;
    for (const controller of this.controllers) {
      controller.setSubmitFn(fn);
    }
  }

  setConfirmationHandler(fn: ConfirmationHandler): void {
    this.confirmationHandler = fn;
    for (const controller of this.controllers) {
      controller.setConfirmationHandler(fn);
    }
  }

  setControlHandler(fn: ControlHandler): void {
    this.controlHandler = fn;
    for (const controller of this.controllers) {
      controller.setControlHandler(fn);
    }
  }

  notifyIdle(): void {
    for (const controller of this.controllers) {
      controller.notifyIdle();
    }
  }
}

export interface TuiRemoteControlStartOptions {
  host?: string;
  port?: number;
  allowLan?: boolean;
  noUi?: boolean;
  tokenTtlMs?: number;
}

export interface TuiRemoteControlStartResult {
  info: RemoteControlServerInfo;
  alreadyStarted: boolean;
}

export interface TuiRemoteControlStatus {
  running: boolean;
  info?: RemoteControlServerInfo;
}

export class TuiRemoteControlManager {
  private bridge: TuiRemoteBridge | null = null;
  private info: RemoteControlServerInfo | null = null;
  private removeDualOutputBridge: (() => void) | null = null;
  private removeRemoteInputController: (() => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly options: {
      version?: string;
      dualOutput: MutableDualOutputBridge;
      remoteInput: MutableRemoteInputController;
    },
  ) {}

  async start(
    startOptions: TuiRemoteControlStartOptions = {},
  ): Promise<TuiRemoteControlStartResult> {
    if (this.bridge && this.info) {
      return {
        info: this.info,
        alreadyStarted: true,
      };
    }

    const bridge = new TuiRemoteBridge(this.config, {
      host: startOptions.host,
      port: startOptions.port,
      allowLan: startOptions.allowLan,
      noUi: startOptions.noUi,
      tokenTtlMs: startOptions.tokenTtlMs,
      version: this.options.version,
    });

    try {
      const info = await bridge.start();
      this.removeDualOutputBridge = this.options.dualOutput.addBridge(
        bridge.getDualOutputBridge(),
      );
      this.removeRemoteInputController = this.options.remoteInput.addController(
        bridge.getRemoteInputController(),
      );
      this.bridge = bridge;
      this.info = info;
      return {
        info,
        alreadyStarted: false,
      };
    } catch (error) {
      await bridge.shutdown();
      throw error;
    }
  }

  getStatus(): TuiRemoteControlStatus {
    return this.info
      ? {
          running: true,
          info: this.info,
        }
      : {
          running: false,
        };
  }

  async stop(): Promise<boolean> {
    if (!this.bridge) {
      return false;
    }
    const bridge = this.bridge;
    this.bridge = null;
    this.info = null;
    this.removeDualOutputBridge?.();
    this.removeDualOutputBridge = null;
    this.removeRemoteInputController?.();
    this.removeRemoteInputController = null;
    await bridge.shutdown();
    return true;
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}
