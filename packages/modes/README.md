# @qwen-code/modes

Слой режимов работы (Modes Layer) для Qwen Code — специализированные профили агента для различных задач.

## Обзор

Каждый режим — это специализированный профиль агента с:
- Уникальной ролью и системным промптом
- Ограниченным набором инструментов
- Правилами безопасности
- Пользовательскими инструкциями

## Встроенные режимы

| Режим | Описание | Инструменты |
|-------|----------|-------------|
| **Architect** 📐 | Проектирование и планирование | read_file, list_dir, glob, grep, web_search, web_fetch, memory, todo_write |
| **Code** 💻 | Написание и модификация кода | read_file, write_file, edit, list_dir, glob, grep, shell, memory, todo_write, lsp |
| **Ask** ❓ | Ответы на вопросы | read_file, list_dir, glob, grep, web_search, web_fetch, memory |
| **Debug** 🐛 | Диагностика ошибок | read_file, write_file, edit, list_dir, glob, grep, shell, memory, todo_write, lsp |
| **Review** 🔍 | Код-ревью | read_file, list_dir, glob, grep, shell, memory, lsp |
| **Orchestrator** 🎯 | Координация задач | read_file, list_dir, glob, grep, memory, todo_write, task |

## Установка

Пакет является частью монорепозитория qwen-code и устанавливается автоматически.

## Использование

### Базовое использование

```typescript
import { ModeManager, ToolRouter, PromptComposer } from '@qwen-code/modes';

// Создание менеджера режимов
const modeManager = new ModeManager('code');

// Переключение режима
await modeManager.switchMode('architect');

// Получение текущего режима
const currentMode = modeManager.getCurrentMode();
console.log(`Текущий режим: ${currentMode.name}`);
```

### Фильтрация инструментов

```typescript
import { ToolRouter } from '@qwen-code/modes';
import { ARCHITECT_MODE } from '@qwen-code/modes';

const router = new ToolRouter(ARCHITECT_MODE);

// Проверка доступности инструмента
const result = router.isToolAllowed('write_file');
console.log(result.allowed); // false
console.log(result.reason); // "Инструмент недоступен в режиме Architect"

// Фильтрация списка инструментов
const allTools = ['read_file', 'write_file', 'shell'] as const;
const allowedTools = router.filterTools(allTools);
// ['read_file']
```

### Композиция промптов

```typescript
import { PromptComposer } from '@qwen-code/modes';
import { CODE_MODE } from '@qwen-code/modes';

const composer = new PromptComposer(CODE_MODE);
composer.setGlobalInstructions('Всегда пиши тесты');

const composed = composer.compose('Пользовательские инструкции');
console.log(composed.systemPrompt);
console.log(composed.allowedTools);
```

### Пользовательские режимы

```typescript
import { ModeManager } from '@qwen-code/modes';

const modeManager = new ModeManager();

// Регистрация кастомного режима
modeManager.registerCustomMode({
  id: 'security-audit',
  name: 'Security Audit',
  description: 'Аудит безопасности кода',
  roleSystemPrompt: 'Ты эксперт по безопасности. Анализируй код на уязвимости...',
  allowedTools: ['read_file', 'grep', 'glob', 'shell'],
  useCases: ['Поиск уязвимостей', 'Аудит зависимостей'],
  color: '#FF0000',
  icon: '🔒',
});

await modeManager.switchMode('security-audit');
```

### Интеграция с settings.json

```json
{
  "modes": {
    "defaultMode": "architect",
    "globalInstructions": "Всегда следуй принципам SOLID и пиши тесты.",
    "customModes": [
      {
        "id": "docs",
        "name": "Documentation",
        "description": "Написание документации",
        "roleSystemPrompt": "Ты технический писатель...",
        "allowedTools": ["read_file", "write_file", "list_dir"],
        "useCases": ["Создание README", "Документирование API"]
      }
    ],
    "autoSwitch": {
      "enabled": true,
      "rules": [
        {
          "triggers": ["спроектируй", "архитектура", "план"],
          "modeId": "architect",
          "priority": 1
        }
      ]
    }
  }
}
```

## API

### ModeManager

Управление режимами: переключение, регистрация кастомных режимов, подписка на изменения.

#### Методы

- `constructor(defaultModeId?: string)` — создание с режимом по умолчанию
- `static fromSettings(settings: ModesSettings)` — создание из настроек
- `getCurrentMode(): ModeDefinition` — получить текущий режим
- `switchMode(modeId: string): Promise<ModeDefinition>` — переключить режим
- `registerCustomMode(config: CustomModeConfig)` — зарегистрировать кастомный режим
- `getAvailableModes(): ModeDefinition[]` — получить все доступные режимы
- `onModeChange(callback)` — подписаться на изменение режима
- `getGlobalInstructions()` — получить глобальные инструкции
- `setGlobalInstructions(instructions)` — установить глобальные инструкции

### ToolRouter

Фильтрация и валидация инструментов по режиму.

#### Методы

- `constructor(mode: ModeDefinition, allTools?: ToolName[])`
- `isToolAllowed(toolName: string): ToolValidationResult` — проверить доступность
- `filterTools(tools: ToolName[]): ToolName[]` — отфильтровать инструменты
- `getAllowedTools(): ToolName[]` — получить все разрешённые инструменты
- `validateToolCall(toolName: string): void` — валидировать вызов (бросает ошибку)
- `forMode(mode: ModeDefinition): ToolRouter` — создать router для другого режима

### PromptComposer

Композиция системных промптов для режимов.

#### Методы

- `constructor(mode: ModeDefinition)`
- `setGlobalInstructions(instructions: string)`
- `composeSystemPrompt(customInstructions?: string): string`
- `compose(customInstructions?: string): ComposedPrompt`
- `getModeSummary(): string`
- `forMode(mode: ModeDefinition): PromptComposer`

## Утилиты

```typescript
import {
  filterToolsByMode,
  isToolAllowedInMode,
  composePromptForMode,
} from '@qwen-code/modes';

// Быстрая проверка
const allowed = isToolAllowedInMode('shell', ARCHITECT_MODE); // false

// Быстрая фильтрация
const tools = filterToolsByMode(
  ['read_file', 'write_file', 'shell'],
  CODE_MODE
);

// Быстрая композиция
const prompt = composePromptForMode(ARCHITECT_MODE, {
  globalInstructions: '...',
  customInstructions: '...',
});
```

## Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                    Modes Layer                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ModeManager  │  │ToolRouter   │  │PromptComposer   │ │
│  │             │  │             │  │                 │ │
│  │ - switch    │  │ - filter    │  │ - compose       │ │
│  │ - register  │  │ - validate  │  │ - global instr  │ │
│  │ - notify    │  │ - suggest   │  │ - safety blocks │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
├─────────────────────────────────────────────────────────┤
│              Built-in Modes                             │
│  Architect | Code | Ask | Debug | Review | Orchestrator │
├─────────────────────────────────────────────────────────┤
│              @qwen-code/qwen-code-core                  │
└─────────────────────────────────────────────────────────┘
```

## Безопасность

Слой режимов обеспечивает безопасность через:

1. **Физическую фильтрацию инструментов** — запрещённые инструменты не передаются в core
2. **Композитные промпты** — ограничения выделены в отдельные блоки
3. **Enforcement блок** — явное напоминание модели о соблюдении ограничений
4. **Tool Router валидацию** — дополнительная проверка на уровне вызова

## Тестирование

```bash
cd packages/modes
npm run test
```

## Лицензия

Apache 2.0
