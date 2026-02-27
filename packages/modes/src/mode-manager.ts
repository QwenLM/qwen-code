/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModeDefinition,
  CustomModeConfig,
  ModesSettings,
} from './mode-definition.js';
import {
  BUILTIN_MODES,
  DEFAULT_MODE,
  getBuiltinMode,
} from './modes/builtin-modes.js';

/**
 * Менеджер режимов работы агента
 * Управляет переключением между режимами, кастомными режимами и композицией промптов
 */
export class ModeManager {
  private currentMode: ModeDefinition;
  private customModes: Map<string, ModeDefinition> = new Map();
  private globalInstructions?: string;
  private onModeChangeCallbacks: ((mode: ModeDefinition) => void)[] = [];

  constructor(defaultModeId?: string) {
    const defaultMode = defaultModeId
      ? getBuiltinMode(defaultModeId) || DEFAULT_MODE
      : DEFAULT_MODE;
    this.currentMode = defaultMode;
  }

  /**
   * Инициализация менеджера режимов из настроек
   */
  static fromSettings(settings: ModesSettings): ModeManager {
    const manager = new ModeManager(settings.defaultMode);

    if (settings.globalInstructions) {
      manager.setGlobalInstructions(settings.globalInstructions);
    }

    if (settings.customModes) {
      for (const config of settings.customModes) {
        manager.registerCustomMode(config);
      }
    }

    return manager;
  }

  /**
   * Получить текущий режим
   */
  getCurrentMode(): ModeDefinition {
    return this.currentMode;
  }

  /**
   * Переключить режим
   */
  async switchMode(modeId: string): Promise<ModeDefinition> {
    // Проверяем встроенные режимы
    let newMode = getBuiltinMode(modeId);

    // Проверяем кастомные режимы
    if (!newMode) {
      newMode = this.customModes.get(modeId);
    }

    if (!newMode) {
      throw new Error(
        `Режим "${modeId}" не найден. Доступные режимы: ${this.getAvailableModes().map((m) => m.id).join(', ')}`,
      );
    }

    this.currentMode = newMode;

    // Уведомляем подписчиков об изменении
    for (const callback of this.onModeChangeCallbacks) {
      callback(newMode);
    }

    return newMode;
  }

  /**
   * Зарегистрировать кастомный режим
   */
  registerCustomMode(config: CustomModeConfig): void {
    // Проверяем, не конфликтует ли ID со встроенными режимами
    if (getBuiltinMode(config.id)) {
      throw new Error(
        `Нельзя зарегистрировать кастомный режим с ID "${config.id}" — это встроенный режим`,
      );
    }

    const mode: ModeDefinition = {
      id: config.id,
      name: config.name,
      description: config.description,
      roleSystemPrompt: config.roleSystemPrompt,
      allowedTools: config.allowedTools as ModeDefinition['allowedTools'],
      excludedTools: config.excludedTools as ModeDefinition['excludedTools'],
      customInstructions: config.customInstructions,
      useCases: config.useCases || [],
      safetyConstraints: [],
      color: config.color,
      icon: config.icon,
    };

    this.customModes.set(config.id, mode);
  }

  /**
   * Установить глобальные инструкции
   */
  setGlobalInstructions(instructions: string): void {
    this.globalInstructions = instructions;
  }

  /**
   * Получить глобальные инструкции
   */
  getGlobalInstructions(): string | undefined {
    return this.globalInstructions;
  }

  /**
   * Получить все доступные режимы (встроенные + кастомные)
   */
  getAvailableModes(): ModeDefinition[] {
    const customModesArray = Array.from(this.customModes.values());
    return [...BUILTIN_MODES, ...customModesArray];
  }

  /**
   * Подписаться на изменение режима
   */
  onModeChange(callback: (mode: ModeDefinition) => void): () => void {
    this.onModeChangeCallbacks.push(callback);

    // Возвращаем функцию для отписки
    return () => {
      this.onModeChangeCallbacks = this.onModeChangeCallbacks.filter(
        (cb) => cb !== callback,
      );
    };
  }

  /**
   * Получить информацию о режиме по ID
   */
  getModeById(modeId: string): ModeDefinition | undefined {
    if (modeId === this.currentMode.id) {
      return this.currentMode;
    }

    return getBuiltinMode(modeId) || this.customModes.get(modeId);
  }

  /**
   * Сбросить режим к режиму по умолчанию
   */
  resetToDefault(): Promise<ModeDefinition> {
    return this.switchMode(DEFAULT_MODE.id);
  }
}
