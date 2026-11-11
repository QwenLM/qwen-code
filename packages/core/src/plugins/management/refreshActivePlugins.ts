/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { McpPluginOwner } from '../../mcp/mcpServerConfig.js';
import { CoreEvent, coreEvents } from '../../utils/events.js';
import { runLogger } from '../../utils/runLogger.js';
import { clearAllPluginCaches } from '../refresh.js';
import type { LoadedPlugin, PluginError } from '../types.js';
import { getLoadedPluginId } from './pluginDependencies.js';

export interface RefreshActivePluginsOptions {
  config: Config;
  reason: 'reload-command' | 'sync-install';
  emitToFeed?: boolean;
}

export interface RefreshActivePluginsResult {
  enabled: LoadedPlugin[];
  errors: PluginError[];
}

function toMcpPluginOwner(plugin: LoadedPlugin): McpPluginOwner {
  return {
    name: plugin.name,
    path: plugin.path,
    mcpServers: plugin.mcpServers,
    id: getLoadedPluginId(plugin),
  };
}

function mcpSignature(plugin: LoadedPlugin): string {
  return JSON.stringify(plugin.mcpServers ?? {});
}

/**
 * 在途刷新去重槽，**按 Config 键控**。
 *
 * 同一个 Config 的并发重载（连点 reload）共享一次执行；不同 Config 各自执行。
 * 键必须按 Config 收敛：模块级单槽会让会话 B 的 reload 拿到会话 A 的 promise，
 * 回包里 plugins 与 commands/agents 来自不同快照；企业插件补加载（root Config）
 * 与 reload_plugins（会话 Config）也会被错误地做成互斥。
 *
 * 仍属进程级的部分（clearAllPluginCaches 的 marketplace / orphan exclusions、
 * installedPlugins 磁盘状态）不受这把键影响：那是「单进程单会话」假设的遗留缓存，
 * 分片或挂 GlobalState 是另案待办，见 configurationHandlers 的 reload_plugins 注释。
 */
const refreshInFlightByConfig = new WeakMap<
  Config,
  Promise<RefreshActivePluginsResult>
>();

export async function refreshActivePlugins(
  opts: RefreshActivePluginsOptions,
): Promise<RefreshActivePluginsResult> {
  const existing = refreshInFlightByConfig.get(opts.config);
  if (existing) {
    return existing;
  }

  const doRefresh = async (): Promise<RefreshActivePluginsResult> => {
    const { config, reason, emitToFeed = false } = opts;

    clearAllPluginCaches({
      clearOrphanExclusions: reason === 'reload-command',
    });

    const oldPlugins = config.getEnabledPlugins();
    const oldSigs = new Map(
      oldPlugins.map((p) => [`${p.name}@${p.source}`, mcpSignature(p)]),
    );

    const result = await config.reloadPlugins?.().catch((error: unknown) => {
      coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
        sessionId: config.getSessionId(),
        failed: true,
      });
      throw error;
    });
    const reloaded = result?.enabled ?? [];
    const errors = result?.errors ?? [];

    const activeReloaded = reloaded.filter((p) => p.enabled !== false);

    const mcp = config.getMcpClientManager();
    if (mcp) {
      const newPluginIds = new Set(
        activeReloaded.map((p) => `${p.name}@${p.source}`),
      );

      // Stop removed plugins
      for (const old of oldPlugins) {
        const id = `${old.name}@${old.source}`;
        if (
          !newPluginIds.has(id) &&
          old.mcpServers &&
          Object.keys(old.mcpServers).length > 0
        ) {
          try {
            await mcp.stopPlugin(toMcpPluginOwner(old));
          } catch (e) {
            runLogger.warn(
              `[Plugin Refresh] Failed to stop MCP for "${old.name}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }

      // Start new or changed plugins
      for (const p of activeReloaded) {
        if (!p.mcpServers || Object.keys(p.mcpServers).length === 0) continue;
        const id = `${p.name}@${p.source}`;
        const oldSig = oldSigs.get(id);
        const newSig = mcpSignature(p);

        if (oldSig === undefined) {
          // New plugin
          try {
            await mcp.startPlugin(toMcpPluginOwner(p));
          } catch (e) {
            runLogger.warn(
              `[Plugin Refresh] Failed to start MCP for "${p.name}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else if (oldSig !== newSig) {
          // Changed plugin — stop then start
          const oldPlugin = oldPlugins.find(
            (o) => `${o.name}@${o.source}` === id,
          );
          if (oldPlugin) {
            try {
              await mcp.stopPlugin(toMcpPluginOwner(oldPlugin));
            } catch {
              /* best effort */
            }
          }
          try {
            await mcp.startPlugin(toMcpPluginOwner(p));
          } catch (e) {
            runLogger.warn(
              `[Plugin Refresh] Failed to restart MCP for "${p.name}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    }

    await config.reloadSkills?.();

    try {
      await config.getHookSystem()?.initialize({ emitToFeed });
    } catch (e) {
      coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
        sessionId: config.getSessionId(),
        failed: true,
      });
      runLogger.warn(
        `[Plugin Refresh] Hook reinit failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const agentRegistry = config.getAgentRegistry?.();
    if (agentRegistry) {
      await agentRegistry.reload();
    } else {
      await config.reloadAgents?.();
    }

    return { enabled: activeReloaded, errors };
  };

  const pending = doRefresh().finally(() => {
    // 只清自己这一笔：同 Config 的后续刷新可能已经登记，无条件 delete 会把它摘掉。
    if (refreshInFlightByConfig.get(opts.config) === pending) {
      refreshInFlightByConfig.delete(opts.config);
    }
  });
  refreshInFlightByConfig.set(opts.config, pending);
  return pending;
}
