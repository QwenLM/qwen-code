/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModeDefinition, ToolValidationResult, ToolName } from './mode-definition.js';

/**
 * Маршрутизатор инструментов
 * Фильтрует и валидирует инструменты на основе текущего режима
 */
export class ToolRouter {
  private readonly mode: ModeDefinition;
  private readonly allAvailableTools: ToolName[];

  constructor(
    mode: ModeDefinition,
    allAvailableTools: ToolName[] = ToolRouter.getAllToolNames(),
  ) {
    this.mode = mode;
    this.allAvailableTools = allAvailableTools;
  }

  /**
   * Получить все доступные имена инструментов из core
   */
  static getAllToolNames(): ToolName[] {
    // Полный список всех доступных инструментов в qwen-code
    return [
      'read_file',
      'write_file',
      'edit',
      'list_dir',
      'glob',
      'grep',
      'shell',
      'memory',
      'todo_write',
      'task',
      'web_search',
      'web_fetch',
      'lsp',
      'exit_plan_mode',
    ];
  }

  /**
   * Проверить, разрешён ли инструмент в текущем режиме
   */
  isToolAllowed(toolName: string): ToolValidationResult {
    const tool = toolName as ToolName;

    // Сначала проверяем явные исключения (excludedTools имеет приоритет)
    if (this.mode.excludedTools?.includes(tool)) {
      return {
        allowed: false,
        reason: `Инструмент "${toolName}" заблокирован в режиме "${this.mode.name}"`,
      };
    }

    // Затем проверяем разрешённые инструменты
    if (this.mode.allowedTools.includes(tool)) {
      return {
        allowed: true,
      };
    }

    // Инструмент не разрешён
    return {
      allowed: false,
      reason: `Инструмент "${toolName}" недоступен в режиме "${this.mode.name}". Доступные инструменты: ${this.mode.allowedTools.join(', ')}`,
      suggestion: this.suggestAlternative(tool),
    };
  }

  /**
   * Фильтровать список инструментов по режиму
   */
  filterTools(tools: ToolName[]): ToolName[] {
    return tools.filter((tool: ToolName) => this.isToolAllowed(tool).allowed);
  }

  /**
   * Получить все разрешённые инструменты для текущего режима
   */
  getAllowedTools(): ToolName[] {
    const allowed = this.mode.allowedTools.filter(
      (tool: ToolName) => !this.mode.excludedTools?.includes(tool),
    );

    // Фильтруем только существующие инструменты
    return allowed.filter((tool: ToolName) => this.allAvailableTools.includes(tool));
  }

  /**
   * Предложить альтернативный инструмент
   */
  private suggestAlternative(tool: ToolName): ToolName | undefined {
    // Простая эвристика для предложений
    const suggestions: Record<string, ToolName> = {
      write_file: 'read_file',
      edit: 'read_file',
      shell: 'read_file',
      task: 'memory',
    };

    return suggestions[tool];
  }

  /**
   * Валидировать вызов инструмента
   * Бросает ошибку, если инструмент запрещён
   */
  validateToolCall(toolName: string): void {
    const result = this.isToolAllowed(toolName);

    if (!result.allowed) {
      throw new Error(
        result.reason || `Инструмент "${toolName}" запрещён в текущем режиме`,
      );
    }
  }

  /**
   * Создать новый ToolRouter для другого режима
   */
  forMode(mode: ModeDefinition): ToolRouter {
    return new ToolRouter(mode, this.allAvailableTools);
  }

  /**
   * Получить информацию о блокировке инструмента для UI
   */
  getToolBlockageInfo(toolName: string): {
    blocked: boolean;
    reason?: string;
    modeName: string;
  } {
    const result = this.isToolAllowed(toolName);
    return {
      blocked: !result.allowed,
      reason: result.reason,
      modeName: this.mode.name,
    };
  }
}

/**
 * Утилита для фильтрации инструментов вне класса
 */
export function filterToolsByMode(
  tools: ToolName[],
  mode: ModeDefinition,
): ToolName[] {
  const router = new ToolRouter(mode);
  return router.filterTools(tools);
}

/**
 * Проверка доступности инструмента в режиме
 */
export function isToolAllowedInMode(
  toolName: string,
  mode: ModeDefinition,
): boolean {
  const router = new ToolRouter(mode);
  return router.isToolAllowed(toolName).allowed;
}
