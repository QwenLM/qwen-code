/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ApprovalMode, Config } from '../../../config/config.js';
import { Storage } from '../../../config/storage.js';
import type { ContentGenerator } from '../../../core/contentGenerator.js';
import { createRuntimeContentGeneratorView } from '../../../models/content-generator-config.js';
import { createDenialState } from '../../../permissions/denialTracking.js';
import { FileDiscoveryService } from '../../../services/fileDiscoveryService.js';
import type { ToolRegistry } from '../../../tools/tool-registry.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { WorkspaceContext } from '../../../utils/workspaceContext.js';
import type { InProcessSpawnConfig } from '../../backends/types.js';
import type { RuntimeContentGeneratorView } from '../agent-context.js';

const debugLogger = createDebugLogger('IN_PROCESS_RUNTIME');

export interface ApprovalModeOverrideHooks {
  acquireAutoApprovalOverride(): boolean;
  releaseAutoApprovalOverride(): void;
}

export async function createPerAgentConfig(
  base: Config,
  agentId: string,
  cwd: string,
  modelId?: string,
  authOverrides?: InProcessSpawnConfig['authOverrides'],
  approvalMode?: ApprovalMode,
  approvalModeHooks?: ApprovalModeOverrideHooks,
): Promise<{
  config: Config;
  contentGenerator?: ContentGenerator;
  runtimeView?: RuntimeContentGeneratorView;
  cleanup: () => void;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let override = Object.create(base) as any;
  let dedicatedContentGenerator: ContentGenerator | undefined;
  let runtimeView: RuntimeContentGeneratorView | undefined;
  let cleanup = () => {};

  if (approvalMode !== undefined) {
    const handle = createApprovalModeConfigOverride(
      base,
      approvalMode,
      approvalModeHooks,
    );
    override = handle.config as unknown as Record<string, unknown>;
    cleanup = handle.cleanup;
  }

  let agentRegistry: ToolRegistry | undefined;
  try {
    override.getWorkingDir = () => cwd;
    override.getTargetDir = () => cwd;
    override.getProjectRoot = () => cwd;
    override.getPlanFilePath = () => {
      const sessionId = Storage.sanitizePlanSessionId(base.getSessionId());
      const scopedAgentId = Storage.sanitizePlanSessionId(agentId);
      return path.join(base.getPlansDir(), `${sessionId}-${scopedAgentId}.md`);
    };

    const agentWorkspace = new WorkspaceContext(cwd);
    override.getWorkspaceContext = () => agentWorkspace;

    const agentFileService = new FileDiscoveryService(
      cwd,
      base.getFileFilteringOptions().customIgnoreFiles,
    );
    override.getFileService = () => agentFileService;

    const registry = await override.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });
    agentRegistry = registry;
    registry.copyDiscoveredToolsFrom(base.getToolRegistry());
    override.getToolRegistry = () => registry;

    if (authOverrides?.authType) {
      try {
        runtimeView = await createRuntimeContentGeneratorView(
          base,
          override as Config,
          modelId,
          authOverrides,
        );
        dedicatedContentGenerator = runtimeView.contentGenerator;
        debugLogger.info(
          `Created per-agent ContentGenerator: authType=${authOverrides.authType}, model=${runtimeView.contentGeneratorConfig.model}`,
        );
      } catch (error) {
        debugLogger.error(
          'Failed to create per-agent ContentGenerator, falling back to parent:',
          error,
        );
      }
    }

    return {
      config: override as Config,
      contentGenerator:
        dedicatedContentGenerator ??
        (authOverrides?.authType ? undefined : base.getContentGenerator()),
      runtimeView,
      cleanup,
    };
  } catch (error) {
    cleanup();
    if (agentRegistry) {
      void agentRegistry.stop().catch((stopError) => {
        debugLogger.error(
          'Failed to stop partially created agent tool registry:',
          stopError,
        );
      });
    }
    throw error;
  }
}

function createApprovalModeConfigOverride(
  base: Config,
  mode: ApprovalMode,
  hooks?: ApprovalModeOverrideHooks,
): { config: Config; cleanup: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;
  const baseApprovalMode = base.getApprovalMode();
  const initialMode = getTrustedInitialApprovalMode(base, mode);
  let autoOverrideAcquired = false;
  const acquireAutoOverride = () => {
    if (autoOverrideAcquired || base.getApprovalMode() === ApprovalMode.AUTO) {
      return;
    }
    if (hooks) {
      autoOverrideAcquired = hooks.acquireAutoApprovalOverride();
      return;
    }
    base.getPermissionManager?.()?.stripDangerousRulesForAutoMode();
    autoOverrideAcquired = true;
  };
  const releaseAutoOverride = () => {
    if (!autoOverrideAcquired) return;
    if (hooks) {
      hooks.releaseAutoApprovalOverride();
    } else if (base.getApprovalMode() !== ApprovalMode.AUTO) {
      base.getPermissionManager?.()?.restoreDangerousRules();
    }
    autoOverrideAcquired = false;
  };

  override.approvalMode = initialMode;
  override.manualPlanExitNoticeEventState = {
    ...(override.manualPlanExitNoticeEventState ?? {
      version: 0,
      kind: 'clear',
    }),
  };
  override.getApprovalMode = Config.prototype.getApprovalMode;
  override.prePlanMode =
    initialMode === ApprovalMode.PLAN
      ? baseApprovalMode === ApprovalMode.PLAN
        ? base.getPrePlanMode()
        : baseApprovalMode
      : undefined;
  override.approvalModeRevision = 0;

  override.setApprovalMode = (
    nextMode: ApprovalMode,
    options?: Parameters<Config['setApprovalMode']>[1],
  ) => {
    const beforeMode = (override as Config).getApprovalMode();
    const hadOwnPermissionManager = Object.prototype.hasOwnProperty.call(
      override,
      'permissionManager',
    );
    const ownPermissionManager = override.permissionManager;
    override.permissionManager = null;
    try {
      Config.prototype.setApprovalMode.call(
        override as Config,
        nextMode,
        options,
      );
    } finally {
      if (hadOwnPermissionManager) {
        override.permissionManager = ownPermissionManager;
      } else {
        delete override.permissionManager;
      }
    }

    const afterMode = (override as Config).getApprovalMode();
    if (beforeMode !== ApprovalMode.AUTO && afterMode === ApprovalMode.AUTO) {
      acquireAutoOverride();
    } else if (
      beforeMode === ApprovalMode.AUTO &&
      afterMode !== ApprovalMode.AUTO
    ) {
      releaseAutoOverride();
    }
  };
  override.autoModeDenialState = createDenialState();

  const cleanup = () => releaseAutoOverride();
  if (
    initialMode === ApprovalMode.AUTO &&
    base.getApprovalMode() !== ApprovalMode.AUTO
  ) {
    acquireAutoOverride();
  }

  return { config: override as Config, cleanup };
}

function getTrustedInitialApprovalMode(
  base: Config,
  mode: ApprovalMode,
): ApprovalMode {
  if (
    !base.isTrustedFolder() &&
    mode !== ApprovalMode.DEFAULT &&
    mode !== ApprovalMode.PLAN
  ) {
    return ApprovalMode.DEFAULT;
  }
  return mode;
}
