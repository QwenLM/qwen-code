/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Имена инструментов доступные в qwen-code
 */
export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'shell'
  | 'memory'
  | 'todo_write'
  | 'task'
  | 'web_search'
  | 'web_fetch'
  | 'lsp'
  | 'exit_plan_mode';

/**
 * Определение режима работы агента
 */
export interface ModeDefinition {
  /** Уникальный идентификатор режима */
  id: string;

  /** Отображаемое название режима */
  name: string;

  /** Краткое описание для пользователя */
  description: string;

  /** Системный промпт, определяющий роль и поведение агента */
  roleSystemPrompt: string;

  /** Список разрешённых инструментов для этого режима */
  allowedTools: ToolName[];

  /** Список запрещённых инструментов (приоритет над allowedTools) */
  excludedTools?: ToolName[];

  /** Примеры использования режима */
  useCases: string[];

  /** Пользовательские инструкции (добавляются к системному промпту) */
  customInstructions?: string;

  /** Жёсткие ограничения безопасности, которые нельзя переопределить */
  safetyConstraints: string[];

  /** Цвет для отображения в UI (hex или название) */
  color?: string;

  /** Иконка для отображения в UI */
  icon?: string;
}

/**
 * Конфигурация пользовательского режима
 */
export interface CustomModeConfig {
  id: string;
  name: string;
  description: string;
  roleSystemPrompt: string;
  allowedTools: string[];
  excludedTools?: string[];
  customInstructions?: string;
  useCases?: string[];
  color?: string;
  icon?: string;
}

/**
 * Структура настроек режимов в settings.json
 */
export interface ModesSettings {
  /** Пользовательские режимы */
  customModes?: CustomModeConfig[];

  /** Глобальные инструкции, применяемые ко всем режимам */
  globalInstructions?: string;

  /** Режим по умолчанию */
  defaultMode?: string;

  /** Автоматическое переключение режимов на основе контекста */
  autoSwitch?: {
    enabled: boolean;
    rules: AutoSwitchRule[];
  };
}

/**
 * Правило автоматического переключения режима
 */
export interface AutoSwitchRule {
  /** Триггеры (ключевые слова в запросе пользователя) */
  triggers: string[];

  /** ID режима для переключения */
  modeId: string;

  /** Приоритет правила (чем выше, тем приоритетнее) */
  priority?: number;
}

/**
 * Результат композиции промпта для режима
 */
export interface ComposedPrompt {
  /** Полный системный промпт */
  systemPrompt: string;

  /** Отфильтрованный список инструментов */
  allowedTools: ToolName[];

  /** Информация о режиме */
  mode: ModeDefinition;
}

/**
 * Статус валидации инструмента
 */
export interface ToolValidationResult {
  /** Разрешён ли инструмент */
  allowed: boolean;

  /** Причина блокировки (если заблокирован) */
  reason?: string;

  /** Альтернативный инструмент (если есть) */
  suggestion?: ToolName;
}
