/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from '../config/settings.js';

export type VoiceMode = 'hold' | 'tap';

export function readVoiceModel(settings: {
  merged?: { voiceModel?: unknown };
}): string | undefined {
  const value = settings.merged?.voiceModel;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isVoiceEnabled(settings: {
  merged?: { general?: { voice?: { enabled?: unknown } } };
}): boolean {
  return settings.merged?.general?.voice?.enabled === true;
}

export function readVoiceMode(settings: {
  merged?: { general?: { voice?: { mode?: unknown } } };
}): VoiceMode {
  return settings.merged?.general?.voice?.mode === 'tap' ? 'tap' : 'hold';
}

export function readVoiceLanguage(settings: LoadedSettings): string {
  const language = (
    settings.merged.general as { voice?: { language?: unknown } } | undefined
  )?.voice?.language;
  if (typeof language !== 'string') {
    return '';
  }
  return language.trim();
}

export function getVoiceSettingsScope(settings: {
  isTrusted?: boolean;
}): SettingScope {
  return settings.isTrusted === true
    ? SettingScope.Workspace
    : SettingScope.User;
}

export function isVoiceMode(value: unknown): value is VoiceMode {
  return value === 'hold' || value === 'tap';
}
