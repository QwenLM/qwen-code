/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 配置类能力：`get_settings` / `apply_flag_settings` / `reload_plugins` /
 * `reload_skills` / `set_proxy`。
 *
 * 只产产品语义：入参已由宿主解析，结果用返回值交回，失败抛 `ThreadCapabilityError`，不读帧、不装帧。
 */

import {
  normalizeProxyUrl,
  refreshActivePlugins,
  runLogger,
} from '@qwen-code/core';
import {
  getModelPreference,
  getPreferredReasoningEffort,
} from '../../../utils/modelPreference.js';
import { loadFlagSettings } from '../../../config/settings.js';
import { requireSettingsDefinition } from '../../../config/settings-validation.js';
import {
  buildSdkCommandSnapshot,
  buildSdkSkillSnapshot,
} from '../../../sdkCommandCatalog.js';
import { normalizeProtocolError } from '../../support/protocolError.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type {
  ThreadAppliedFlagSettings,
  ThreadProxyResult,
} from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

const flagSettingsRevisions = new WeakMap<ThreadSessionInternals, number>();

/**
 * `get_settings`：回传各来源设置、合并结果与已生效的 effort / ultracode。
 *
 * 快照读本会话的 LoadedSettings 与 Config（ultracode / effort 均为会话态），不触进程级状态；
 * `sources` / `effective` / `applied` 是 wire 键名，宿主按原样透出，不做键名改写。
 */
export async function getSettings(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<Record<string, unknown>> {
  const config = session.requireConfig();
  const model = config.getModel();
  const identity = config.getModelRequestIdentity();
  const listed = await config.getModelProviderManager().getModel(model);
  if (
    session.isTerminated() ||
    session.signal.aborted ||
    session.requireConfig() !== config ||
    model !== config.getModel() ||
    identity !== config.getModelRequestIdentity()
  )
    throw new ThreadCapabilityError('会话目标已变化，设置查询已取消。');
  const snapshot = session.getCurrentSettings().getSnapshot();
  return {
    sources: {
      user: snapshot.user.settings,
      // workspace 是 wire 键名，映射自 project 层。
      workspace: snapshot.project.settings,
      local: snapshot.local.settings,
      flag: snapshot.flag.settings,
    },
    effective: {
      ...snapshot.merged,
      ultracode: config.getUltracode(),
    },
    applied: {
      effort: getPreferredReasoningEffort(config, listed) ?? null,
      ultracode: config.isUltracodeActive(listed),
    },
  };
}

// 只替换本会话的 flag 层。

/**
 * `apply_flag_settings`：用请求覆盖本会话的 flag 层设置；`ultracode` 属会话态，单独处理，不写回 flag 源。
 *
 * 错误文本即契约、均不带 code：settings 缺失或非对象抛 `'missing or invalid settings'`，
 * ultracode 非法抛 `'ultracode must be true, false, or null'`，其余取 `err.message`。
 */
export async function applyFlagSettings(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  settings: Record<string, unknown>,
): Promise<ThreadAppliedFlagSettings> {
  if (!settings || typeof settings !== 'object') {
    throw new ThreadCapabilityError('missing or invalid settings');
  }
  const config = session.requireConfig();
  const model = config.getModel();
  const identity = config.getModelRequestIdentity();
  const revision = (flagSettingsRevisions.get(session) ?? 0) + 1;
  flagSettingsRevisions.set(session, revision);
  const stillCurrent = () =>
    !session.isTerminated() &&
    !session.signal.aborted &&
    session.requireConfig() === config &&
    revision === flagSettingsRevisions.get(session) &&
    model === config.getModel() &&
    identity === config.getModelRequestIdentity();
  try {
    const hasUltracode = Object.prototype.hasOwnProperty.call(
      settings,
      'ultracode',
    );
    const ultracode = settings['ultracode'];
    if (
      hasUltracode &&
      ultracode !== true &&
      ultracode !== false &&
      ultracode !== null
    ) {
      throw new Error('ultracode must be true, false, or null');
    }

    // ultracode 是会话态：只处理超频请求，不改写 flag 源。
    const remainingSettings = Object.fromEntries(
      Object.entries(settings).filter(([key]) => key !== 'ultracode'),
    );
    if (Object.keys(remainingSettings).length > 0) {
      const loadedSettings = session.getCurrentSettings();
      const { validation } = requireSettingsDefinition(
        loadedSettings.getSettingsService() ?? config.getSettingsService(),
      );
      const refreshed = loadFlagSettings(remainingSettings, validation);
      loadedSettings.setFlagSettings(refreshed.flag, refreshed.errors);
      const reloadResults = await Promise.allSettled([
        config.reloadHooks('settings-event'),
        config.reloadSkills(),
      ]);
      const reloadLabels = ['hooks', 'skills'];
      for (const [index, result] of reloadResults.entries()) {
        if (result.status === 'rejected') {
          runLogger.error(
            `[thread-session] Failed to reload ${reloadLabels[index]} after flag settings update: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          );
        }
      }
    }

    const listed = await config.getModelProviderManager().getModel(model);
    if (!stillCurrent())
      throw new ThreadCapabilityError('会话目标已变化，设置更新已取消。');
    if (hasUltracode) {
      const previousPreference = JSON.stringify(
        getModelPreference(config, listed),
      );
      const applyUltracodeEffort = () => {
        if (!listed) return;
        config.getModelProviderManager().setModelConfig(listed, {
          reasoning: { effort: 'xhigh' },
        });
      };
      if (ultracode === true) {
        applyUltracodeEffort();
        config.setUltracode(true);
      } else if (ultracode === false) {
        config.setUltracode(false);
      } else {
        config.clearUltracodeOverride();
        if (config.getUltracode()) {
          applyUltracodeEffort();
        }
      }
      if (
        JSON.stringify(getModelPreference(config, listed)) !==
        previousPreference
      ) {
        // runner 是可替换绑定，必须经 getter 读当前值（handlerContract 纪律）。
        session
          .peekQueryRunner()
          ?.refreshRuntimeContext({ resetModelRouting: true });
      }
    }

    return {
      applied: {
        effort: getPreferredReasoningEffort(config, listed) ?? null,
        ultracode: config.isUltracodeActive(listed),
      },
    };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'apply_flag_settings failed',
    );
  }
}

/**
 * `reload_plugins`：重载本会话插件，回传命令、agent、插件与 MCP 快照。
 *
 * `mcpServers` 恒为空数组，保留该键是为了不回退 SDK 侧的形状契约。reload 只替换本会话
 * Config 的插件快照，其它会话保持各自快照直到自己 reload；进程级插件缓存与排除表仍是模块单例，
 * 一次 reload 会作用到全进程。错误抛 `<err.message 或 'reload_plugins failed'>`，不带 code。
 */
export async function reloadPlugins(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<Record<string, unknown>> {
  const config = session.requireConfig();
  try {
    const { enabled, errors } = await refreshActivePlugins({
      config,
      reason: 'reload-command',
      emitToFeed: false,
    });
    const pluginReloadErrorCount = errors.length;

    const commands = await buildSdkCommandSnapshot(config);

    const agentRegistry = config.getAgentRegistry?.();
    const agents =
      agentRegistry?.getAllAgentNames().map((name: string) => {
        const definition = agentRegistry.getDiscoveredDefinition(name);
        return {
          name,
          description: definition?.description ?? '',
        };
      }) ?? [];

    const plugins = enabled.map((p) => ({
      name: p.name,
      path: p.path,
      source: p.source,
    }));

    const mcpServers: Array<Record<string, unknown>> = [];

    return {
      commands,
      agents,
      plugins,
      mcpServers,
      error_count: pluginReloadErrorCount,
    };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'reload_plugins failed',
    );
  }
}

/**
 * `reload_skills`：重新发现 skill 并回传快照。
 *
 * 失败经 `normalizeProtocolError` 归一后抛 `ThreadCapabilityError(error, code)`：错误可能带
 * `<code>: 正文` 形式，调用方按 code 分支，故 code 不可省略。
 */
export async function reloadSkills(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<Record<string, unknown>> {
  const config = session.requireConfig();
  try {
    await config.reloadSkills();
    return { skills: buildSdkSkillSnapshot(config) };
  } catch (err) {
    const normalized = normalizeProtocolError(err);
    throw new ThreadCapabilityError(normalized.error, normalized.code);
  }
}

// 代理是进程级事实：`prepareProxy` 切换整个进程的网络出口，同进程内任一会话 set_proxy
// 都会影响所有会话；`config.setProxy` 只改本会话 Config。

/**
 * `set_proxy` / `set_http_proxy`：两个 wire method 共用实现；先交宿主写进程级代理，再写本会话 Config。
 *
 * 入参归一化由宿主完成（`proxy` → `httpProxy` → `http_proxy` 优先取第一个存在的键，null 视为 clear）；
 * 本函数只做 trim 与 `normalizeProxyUrl` 校验：缺失抛 `'missing proxy'`，其余错误取 `err.message`，均不带 code。
 */
export async function setProxy(
  session: ThreadSessionInternals,
  ctx: ThreadCallContext,
  proxy: string | undefined,
): Promise<ThreadProxyResult> {
  if (proxy === undefined) {
    throw new ThreadCapabilityError('missing proxy');
  }
  let normalized: string | undefined;
  const trimmed = proxy.trim();
  if (trimmed) {
    try {
      normalized = normalizeProxyUrl(trimmed);
    } catch (err) {
      throw new ThreadCapabilityError(
        err instanceof Error ? err.message : 'invalid proxy',
      );
    }
  }
  const config = session.requireConfig();
  try {
    await ctx.host.requests.prepareProxy?.({
      config,
      ...(normalized === undefined ? {} : { proxy: normalized }),
    });
    config.setProxy(normalized);
    return { proxy: normalized ?? null };
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'set_proxy failed',
    );
  }
}
