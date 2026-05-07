/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { DualOutputBridge } from '../dualOutput/DualOutputBridge.js';
import type { DualOutputBridgeLike } from '../dualOutput/DualOutputContext.js';
import { RemoteInputWatcher } from '../remoteInput/RemoteInputWatcher.js';
import type { RemoteInputController } from '../remoteInput/RemoteInputContext.js';
import type { PermissionMode } from '../nonInteractive/types.js';
import { RemoteControlServer } from './RemoteControlServer.js';
import type { RemoteControlServerInfo } from './RemoteControlServer.js';
import { TuiSessionRegistry } from './TuiSessionRegistry.js';

const debugLogger = createDebugLogger('TUI_REMOTE_CONTROL');

export interface TuiRemoteBridgeOptions {
  host?: string;
  port?: number;
  allowLan?: boolean;
  noUi?: boolean;
  tokenTtlMs?: number;
  version?: string;
}

export class CompositeDualOutputBridge implements DualOutputBridgeLike {
  constructor(private readonly bridges: DualOutputBridgeLike[]) {}

  get isConnected(): boolean {
    return this.bridges.some((bridge) => bridge.isConnected);
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

export class CompositeRemoteInputController implements RemoteInputController {
  constructor(private readonly controllers: RemoteInputController[]) {}

  setSubmitFn(...args: Parameters<RemoteInputController['setSubmitFn']>) {
    for (const controller of this.controllers) {
      controller.setSubmitFn(...args);
    }
  }

  setConfirmationHandler(
    ...args: Parameters<RemoteInputController['setConfirmationHandler']>
  ) {
    for (const controller of this.controllers) {
      controller.setConfirmationHandler(...args);
    }
  }

  setControlHandler(
    ...args: Parameters<RemoteInputController['setControlHandler']>
  ) {
    for (const controller of this.controllers) {
      controller.setControlHandler(...args);
    }
  }

  notifyIdle(...args: Parameters<RemoteInputController['notifyIdle']>) {
    for (const controller of this.controllers) {
      controller.notifyIdle(...args);
    }
  }
}

export class TuiRemoteBridge {
  private readonly tmpDir: string;
  private readonly inputFilePath: string;
  private readonly outputFilePath: string;
  private readonly registry: TuiSessionRegistry;
  private readonly dualOutputBridge: DualOutputBridge;
  private readonly remoteInputWatcher: RemoteInputWatcher;
  private readonly server: RemoteControlServer;
  private started = false;

  constructor(config: Config, options: TuiRemoteBridgeOptions = {}) {
    this.tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-remote-control-'));
    this.inputFilePath = path.join(this.tmpDir, 'input.jsonl');
    this.outputFilePath = path.join(this.tmpDir, 'output.jsonl');
    writeFileSync(this.inputFilePath, '', 'utf-8');
    writeFileSync(this.outputFilePath, '', 'utf-8');

    this.registry = new TuiSessionRegistry({
      sessionId: config.getSessionId(),
      cwd: config.getTargetDir(),
      model: config.getModel(),
      permissionMode: String(config.getApprovalMode()) as PermissionMode,
      inputFilePath: this.inputFilePath,
      outputFilePath: this.outputFilePath,
    });
    this.dualOutputBridge = new DualOutputBridge(
      config,
      { filePath: this.outputFilePath },
      { version: options.version },
    );
    this.remoteInputWatcher = new RemoteInputWatcher(this.inputFilePath);
    this.server = new RemoteControlServer({
      host: options.host,
      port: options.port,
      allowLan: options.allowLan,
      noUi: options.noUi,
      tokenTtlMs: options.tokenTtlMs,
      cwd: config.getTargetDir(),
      cliEntryPath: findCliEntryPath(),
      defaultModel: config.getModel(),
      defaultPermissionMode: String(config.getApprovalMode()) as PermissionMode,
      registry: this.registry,
      capabilities: {
        canCreateWorkerSession: false,
        canAttachCurrentTui: true,
      },
    });
  }

  async start(): Promise<RemoteControlServerInfo> {
    if (this.started) {
      return this.server.getInfo();
    }
    const info = await this.server.start();
    await this.registry.checkForOutput();
    this.started = true;
    return info;
  }

  getDualOutputBridge(): DualOutputBridgeLike {
    return this.dualOutputBridge;
  }

  getRemoteInputController(): RemoteInputController {
    return this.remoteInputWatcher;
  }

  async shutdown(): Promise<void> {
    try {
      await this.dualOutputBridge.shutdown();
      await this.registry.checkForOutput();
      await this.server.stop();
    } catch (error) {
      debugLogger.debug('TUI remote-control shutdown error:', error);
    } finally {
      this.remoteInputWatcher.shutdown();
      this.registry.shutdown();
      rmSync(this.tmpDir, { recursive: true, force: true });
    }
  }
}

function findCliEntryPath(): string {
  const mainModule = process.argv[1];
  return mainModule ? path.resolve(mainModule) : process.cwd();
}
