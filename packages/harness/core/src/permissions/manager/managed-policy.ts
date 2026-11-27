/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import { CoreEvent, coreEvents } from '../../utils/events.js';
import { PERMISSION_MODES } from './decision/index.js';
import type { PermissionMode, PermissionRules } from './decision/index.js';
import type { ManagedPolicy } from './types.js';

interface ManagedRule {
  readonly subject?: {
    readonly kind?: string;
    readonly toolName?: string;
    readonly content?: string;
    readonly mode?: string;
  };
  readonly behavior?: string;
  readonly message?: string;
}

interface ManagedDocument {
  readonly rules?: readonly ManagedRule[];
}

interface CompiledPolicy {
  readonly rules: PermissionRules;
  readonly modeRestrictions: ReadonlyMap<PermissionMode, { message?: string }>;
}

function emptyRules(): PermissionRules {
  return { allow: {}, deny: {}, ask: {} };
}

const EMPTY_POLICY: CompiledPolicy = {
  rules: emptyRules(),
  modeRestrictions: new Map(),
};

function compileManagedDocument(document: ManagedDocument): CompiledPolicy {
  const rules = emptyRules();
  const modeRestrictions = new Map<PermissionMode, { message?: string }>();
  const modes = new Set<string>(PERMISSION_MODES);

  for (const rule of document.rules ?? []) {
    const behavior = rule.behavior;
    if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'ask') {
      continue;
    }
    const subject = rule.subject;
    if (!subject) continue;

    if (subject.kind === 'tool' && typeof subject.toolName === 'string') {
      const text =
        typeof subject.content === 'string'
          ? `${subject.toolName}(${subject.content})`
          : subject.toolName;
      const bucket = rules[behavior];
      bucket.policySettings = [...(bucket.policySettings ?? []), text];
      continue;
    }

    if (
      subject.kind === 'mode' &&
      behavior === 'deny' &&
      typeof subject.mode === 'string' &&
      modes.has(subject.mode)
    ) {
      modeRestrictions.set(subject.mode as PermissionMode, {
        message: rule.message,
      });
    }
  }

  return { rules, modeRestrictions };
}

/**
 * 开源版的托管策略：读取设置服务投影的企业策略文件。
 *
 * 投影每次访问都重新读文件，所以管理员改动在下一次判定即生效，不需要
 * 监听事件；解析失败保留 last-known，不因单次坏文件放宽限制。策略文件
 * 被移除/清空意味着策略撤回，不能继续沿用 last-known。
 */
export class SettingsManagedPolicy implements ManagedPolicy {
  private lastPolicy: CompiledPolicy = EMPTY_POLICY;

  constructor(private readonly settings?: SettingsService) {}

  getRules(): PermissionRules {
    return this.current().rules;
  }

  getModeRestriction(
    mode: PermissionMode,
  ): { readonly message?: string } | undefined {
    return this.current().modeRestrictions.get(mode);
  }

  /** 设置被重写时通知订阅方；读取路径仍直接取最新投影。 */
  subscribe(listener: () => void): () => void {
    coreEvents.on(CoreEvent.SettingsChanged, listener);
    return () => coreEvents.off(CoreEvent.SettingsChanged, listener);
  }

  dispose(): void {}

  private current(): CompiledPolicy {
    if (!this.settings) return EMPTY_POLICY;
    const projected = this.settings.getPolicySettings();
    if (!projected) {
      this.lastPolicy = EMPTY_POLICY;
      return this.lastPolicy;
    }
    try {
      this.lastPolicy = compileManagedDocument(
        projected.value as ManagedDocument,
      );
    } catch {
      return this.lastPolicy;
    }
    return this.lastPolicy;
  }
}
