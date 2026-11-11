/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 判定用的配置快照与两个操作：mergeSnapshot（叠盖单次覆盖）、configDiffers（逐字段
// 按引用比较）。逐字段是为了：叠盖只钉住给了的字段；比较能识别「改的字段恰好被钉住」。

import type {
  PermissionMode,
  PermissionRules,
  PermissionRulesBySource,
  PreToolUseHookVerdict,
} from './types/decision.js';
import type { CheckPermissionOptions } from './types/options.js';

export interface ConfigSnapshot {
  permissionMode: PermissionMode;
  rules: PermissionRules;
  cwd: string;
  additionalDirectories: string[];
  toolCheckVersion: number;
  // 只来自单次调用覆盖，对象状态从不持有。
  preToolUseHookVerdict?: PreToolUseHookVerdict;
}

// 叠加结果缓存：configDiffers 按引用比较，同一对输入必须返回同一个对象，
// 否则无关的配置变更会误触发重跑。
const overlayCache = new WeakMap<
  PermissionRules,
  WeakMap<PermissionRules, PermissionRules>
>();

function mergeBucket(
  base: PermissionRulesBySource,
  overlay: PermissionRulesBySource,
): PermissionRulesBySource {
  const merged: PermissionRulesBySource = { ...base };
  for (const source of Object.keys(overlay)) {
    const key = source as keyof PermissionRulesBySource;
    const patterns = overlay[key];
    if (!patterns || patterns.length === 0) continue;
    const existing = merged[key];
    merged[key] = existing ? [...existing, ...patterns] : [...patterns];
  }
  return merged;
}

export function mergeRuleOverlay(
  base: PermissionRules,
  overlay: PermissionRules,
): PermissionRules {
  let byOverlay = overlayCache.get(base);
  if (byOverlay === undefined) {
    byOverlay = new WeakMap();
    overlayCache.set(base, byOverlay);
  }
  const cached = byOverlay.get(overlay);
  if (cached !== undefined) {
    return cached;
  }
  const merged: PermissionRules = {
    allow: mergeBucket(base.allow, overlay.allow),
    deny: mergeBucket(base.deny, overlay.deny),
    ask: mergeBucket(base.ask, overlay.ask),
  };
  byOverlay.set(overlay, merged);
  return merged;
}

// override 给了的字段盖住 live，没给的保留 live（后续改动下次合并仍可见）。
export function mergeSnapshot<TReason>(
  live: ConfigSnapshot,
  override: CheckPermissionOptions<TReason> | undefined,
): ConfigSnapshot {
  if (override === undefined) {
    return live;
  }

  const merged: ConfigSnapshot = {
    permissionMode: live.permissionMode,
    rules: live.rules,
    cwd: live.cwd,
    additionalDirectories: live.additionalDirectories,
    toolCheckVersion: live.toolCheckVersion,
    preToolUseHookVerdict: live.preToolUseHookVerdict,
  };

  if (override.permissionMode !== undefined) {
    merged.permissionMode = override.permissionMode;
  }
  if (override.rules !== undefined) {
    // rules 整体替换 = 钉住；additionalRules 叠加不钉住，弹窗期间的规则编辑仍触发重查。
    merged.rules = override.rules;
  } else if (override.additionalRules !== undefined) {
    merged.rules = mergeRuleOverlay(live.rules, override.additionalRules);
  }
  if (override.cwd !== undefined) {
    merged.cwd = override.cwd;
  }
  if (override.additionalDirectories !== undefined) {
    merged.additionalDirectories = override.additionalDirectories;
  }
  if (override.preToolUseHookVerdict !== undefined) {
    // 调用级裁决钉住整个调用，重跑携带同一份。
    merged.preToolUseHookVerdict = override.preToolUseHookVerdict;
  }

  return merged;
}

// setter 都是整体替换，引用变了就是变了，无需深比较。
export function configDiffers(
  a: ConfigSnapshot,
  b: ConfigSnapshot,
): boolean {
  if (a.permissionMode !== b.permissionMode) {
    return true;
  }
  if (a.rules !== b.rules) {
    return true;
  }
  if (a.cwd !== b.cwd) {
    return true;
  }
  if (a.additionalDirectories !== b.additionalDirectories) {
    return true;
  }
  if (a.toolCheckVersion !== b.toolCheckVersion) {
    return true;
  }
  if (a.preToolUseHookVerdict !== b.preToolUseHookVerdict) {
    return true;
  }
  return false;
}
