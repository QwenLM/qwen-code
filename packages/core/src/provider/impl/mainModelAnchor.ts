/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';

import { Storage } from '../../config/storage.js';
import { BRAND_ENV_PREFIX } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { QODER_PROVIDER_ID } from '../modelProvider.js';

/** 锚点存储形态：归属 providerId + 模型 key，选模对象由持有方按此兑换。 */
export interface MainModelRef {
  readonly providerId: string;
  readonly modelKey: string;
}

/** user scope settings 里 model 块的形状（anchor 只消费 name）。 */
interface UserModelSettingsBlock {
  name?: string;
}

export interface CreateMainModelAnchorOptions {
  /** 项目根目录：求解 settings 档时用于定位 project / local scope；缺省则该档留空。 */
  projectPath?: string;
  /** 进程级 settings 服务：求解 settings 档并承载 persist 写回。 */
  settingsService?: SettingsService;
}

/**
 * 主模型锚点：解析并维护“当前会话的主模型是谁”，存储形态是 MainModelRef
 * 二元组。职责三项：start() 时按档位求解并锚定默认模型（env >
 * merged settings model.name > 兜底 'auto'，归属按 key 首个斜杠还原），读
 * current()，写 switchTo()。完整 Model 对象与 persist 落盘由持有方
 * （ModelProviderManager）裁决。
 */
export class MainModelAnchor {
  private readonly projectPath?: string;
  private readonly settingsService?: SettingsService;
  private anchor?: MainModelRef;

  constructor(options: CreateMainModelAnchorOptions) {
    this.projectPath = options.projectPath;
    this.settingsService = options.settingsService;
  }

  /**
   * 生命周期装载（由持有方 start() 调用）：按档位求解并锚定主模型。
   * 已锚定（resume 快照盖回早于 start）时跳过，幂等。
   */
  start(): void {
    // TODO: 初始化 ref 时还需消费 transcript（resume 快照盖回默认链），
    // 等具备 TranscriptManager 后补充。
    this.anchor ??= this.resolveDefaultRef();
  }

  /** 生命周期卸载：清空锚点与会话态，主模型选择不跨会话泄漏。 */
  stop(): void {
    this.anchor = undefined;
  }

  /** 读当前锚点；未锚定返回 undefined，由调用方决定是否必须存在。 */
  current(): MainModelRef | undefined {
    return this.anchor;
  }

  /**
   * 切换主模型：盖回锚点二元组（从 Model 取权威二元组的动作由持有方
   * 完成）。persist 为 true 时同步把 modelKey 写回 settings model.name
   * （全局默认主模型）；默认只改本会话内存态。
   */
  switchTo(ref: MainModelRef, persist?: boolean): boolean {
    this.anchor = ref;
    return !persist || this.persistModelName(ref.modelKey);
  }

  /**
   * 按 key 切换主模型：归属按 resolveRef 同一规则从 key 还原。用于目录里
   * 查不到对应 Model（空目录、未加载、待后端校验的透传 key）但仍须记住
   * 用户选择的场景。
   */
  switchToKey(modelKey: string, persist?: boolean): boolean {
    return this.switchTo(this.resolveRef(modelKey), persist);
  }

  /**
   * persist 落盘：把 modelKey 写回 user scope settings 的 model.name。根
   * 未绑定时跳过写回而非抢先绑定；写失败只记日志，不影响已生效的会话态。
   */
  private persistModelName(modelKey: string): boolean {
    try {
      const source = this.settingsService?.peekUserSettingsSource(
        Storage.getGlobalSettingsPath(),
      );
      if (!source) {
        runLogger.warn(
          '[main-model-anchor] persist skipped: user settings source is not bound',
        );
        return false;
      }
      source.mutate((latest) => {
        const block = (latest['model'] ??= {}) as Record<string, unknown>;
        if (block['name'] === modelKey) return false;
        block['name'] = modelKey;
        return true;
      });
      return true;
    } catch (error) {
      runLogger.warn(`[main-model-anchor] persist model name failed: ${error}`);
      return false;
    }
  }

  /**
   * 读 merged settings 的 model.name（含 project / local scope 覆盖）。构造材料
   * 缺失、服务未初始化或读失败一律返 undefined，不在锚定期报错。
   */
  private readSettingsModelName(): string | undefined {
    if (!this.settingsService || !this.projectPath) return undefined;
    try {
      const settings = this.settingsService.resolve({
        projectPath: this.projectPath,
      });
      return (settings.merged.model as UserModelSettingsBlock | undefined)?.name;
    } catch (error) {
      runLogger.warn(`[main-model-anchor] read user settings failed: ${error}`);
      return undefined;
    }
  }

  /**
   * 按档位求解默认主模型：env > merged settings model.name > 兜底
   * 'auto'。
   */
  private resolveDefaultRef(): MainModelRef {
    return this.resolveRef(
      process.env[`${BRAND_ENV_PREFIX}MODEL`] ||
        this.readSettingsModelName() ||
        'auto',
    );
  }

  /**
   * 从 model key 还原归属：custom provider 的 key 形如
   * `${providerId}/${modelId}`，按首个斜杠拆出归属；不带斜杠的（qoder
   * 官方域 key、兜底 'auto'）归 qoder 域。modelKey 本身保留前缀，跟
   * switchTo() 收到的 Model.key 形态一致。
   */
  private resolveRef(modelKey: string): MainModelRef {
    const slash = modelKey.indexOf('/');
    return slash > 0
      ? { providerId: modelKey.slice(0, slash), modelKey }
      : { providerId: QODER_PROVIDER_ID, modelKey };
  }
}
