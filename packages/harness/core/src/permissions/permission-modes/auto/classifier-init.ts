/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import stripJsonComments from 'strip-json-comments';
import { stripBOM } from '../../../utils/stripBom.js';
import { Storage } from '../../../config/storage.js';
import type { AutoModeUserConfig } from './classifier.js';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

interface AutoModeSettingsFragment {
  autoMode?: {
    allow?: unknown;
    soft_deny?: unknown;
    hard_deny?: unknown;
    environment?: unknown;
  };
}

function readAutoModeFromFile(
  filePath: string,
): AutoModeUserConfig | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(
      stripJsonComments(stripBOM(raw)),
    ) as AutoModeSettingsFragment;
    const block = parsed?.autoMode;
    if (!block || typeof block !== 'object') return undefined;
    const out: AutoModeUserConfig = {};
    if (isStringArray(block.allow)) out.allow = block.allow;
    if (isStringArray(block.soft_deny)) out.soft_deny = block.soft_deny;
    if (isStringArray(block.hard_deny)) out.hard_deny = block.hard_deny;
    if (isStringArray(block.environment)) out.environment = block.environment;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 用户全局 settings 的 autoMode 规则；每次判定实时读。
 * workspace 文件一律忽略：它们可能随 checkout 进入仓库。
 */
export function hasAutoModeBlock(filePath: string): boolean {
  return readAutoModeFromFile(filePath) !== undefined;
}

export function readGlobalAutoModeUserConfig(): AutoModeUserConfig | undefined {
  return readAutoModeFromFile(Storage.getGlobalSettingsPath());
}
