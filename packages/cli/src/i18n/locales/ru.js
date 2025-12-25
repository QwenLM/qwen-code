/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Русский перевод для Qwen Code CLI
// Ключ служит одновременно ключом перевода и текстом по умолчанию

export default {
  // ============================================================================
  // Справка / Компоненты интерфейса
  // ============================================================================
  'Basics:': 'Основы:',
  'Add context': 'Добавить контекст',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Используйте {{symbol}} для добавления файлов в контекст (например, {{example}}) для выбора конкретных файлов или папок).',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Режим терминала',
  'YOLO mode': 'Режим YOLO',
  'plan mode': 'Режим планирования',
  'auto-accept edits': 'Режим принятия правок',
  'Accepting edits': 'Принятие правок',
  '(shift + tab to cycle)': '(shift + tab для переключения)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Выполняйте команды терминала через {{symbol}} (например, {{example1}}) или используйте естественный язык (например, {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'start server',
  'Commands:': 'Команды:',
  'shell command': 'команда терминала',
  'Model Context Protocol command (from external servers)':
    'Команда Model Context Protocol (из внешних серверов)',
  'Keyboard Shortcuts:': 'Горячие клавиши:',
  'Jump through words in the input': 'Переход по словам во вводе',
  'Close dialogs, cancel requests, or quit application':
    'Закрыть диалоги, отменить запросы или выйти из приложения',
  'New line': 'Новая строка',
  'New line (Alt+Enter works for certain linux distros)':
    'Новая строка (Alt+Enter работает только в некоторых дистрибутивах Linux)',
  'Clear the screen': 'Очистить экран',
  'Open input in external editor': 'Открыть ввод во внешнем редакторе',
  'Send message': 'Отправить сообщение',
  'Initializing...': 'Инициализация...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Подключение к MCP-серверам... ({{connected}}/{{total}})',
  'Type your message or @path/to/file': 'Введите сообщение или @путь/к/файлу',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Нажмите 'i' для режима ВСТАВКА и 'Esc' для ОБЫЧНОГО режима.",
  'Cancel operation / Clear input (double press)':
    'Отменить операцию / Очистить ввод (двойное нажатие)',
  'Cycle approval modes': 'Переключение режимов подтверждения',
  'Cycle through your prompt history': 'Пролистать историю запросов',
  'For a full list of shortcuts, see {{docPath}}':
    'Полный список горячих клавиш см. в {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'Справка по Qwen Code',
  'show version info': 'Просмотр информации о версии',
  'submit a bug report': 'Отправка отчёта об ошибке',
  'About Qwen Code': 'Об Qwen Code',

  // ============================================================================
  // Поля системной информации
  // ============================================================================
  'CLI Version': 'Версия CLI',
  'Git Commit': 'Git-коммит',
  Model: 'Модель',
  Sandbox: 'Песочница',
  'OS Platform': 'Платформа ОС',
  'OS Arch': 'Архитектура ОС',
  'OS Release': 'Версия ОС',
  'Node.js Version': 'Версия Node.js',
  'NPM Version': 'Версия NPM',
  'Session ID': 'ID сессии',
  'Auth Method': 'Метод авторизации',
  'Base URL': 'Базовый URL',
  'Memory Usage': 'Использование памяти',
  'IDE Client': 'Клиент IDE',

  // ============================================================================
  // Команды - Общие
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Анализ проекта и создание адаптированного файла QWEN.md',
  'list available Qwen Code tools. Usage: /tools [desc]':
    'Просмотр доступных инструментов Qwen Code. Использование: /tools [desc]',
  'Available Qwen Code CLI tools:': 'Доступные инструменты Qwen Code CLI:',
  'No tools available': 'Нет доступных инструментов',
  'View or change the approval mode for tool usage':
    'Просмотр или изменение режима подтверждения для использования инструментов',
  'View or change the language setting':
    'Просмотр или изменение настроек языка',
  'change the theme': 'Изменение темы',
  'Select Theme': 'Выбор темы',
  Preview: 'Предпросмотр',
  '(Use Enter to select, Tab to configure scope)':
    '(Enter для выбора, Tab для настройки области)',
  '(Use Enter to apply scope, Tab to select theme)':
    '(Enter для применения области, Tab для выбора темы)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Настройка темы недоступна из-за переменной окружения NO_COLOR.',
  'Theme "{{themeName}}" not found.': 'Тема "{{themeName}}" не найдена.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Тема "{{themeName}}" не найдена в выбранной области.',
  'clear the screen and conversation history':
    'Очистка экрана и истории диалога',
  'Compresses the context by replacing it with a summary.':
    'Сжатие контекста заменой на краткую сводку',
  'open full Qwen Code documentation in your browser':
    'Открытие полной документации Qwen Code в браузере',
  'Configuration not available.': 'Конфигурация недоступна.',
  'change the auth method': 'Изменение метода авторизации',
  'Copy the last result or code snippet to clipboard':
    'Копирование последнего результата или фрагмента кода в буфер обмена',

  // ============================================================================
  // Команды - Агенты
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Управление подагентами для делегирования специализированных задач',
  'Manage existing subagents (view, edit, delete).':
    'Управление существующими подагентами (просмотр, правка, удаление)',
  'Create a new subagent with guided setup.':
    'Создание нового подагента с пошаговой настройкой',

  // ============================================================================
  // Агенты - Диалог управления
  // ============================================================================
  Agents: 'Агенты',
  'Choose Action': 'Выберите действие',
  'Edit {{name}}': 'Редактировать {{name}}',
  'Edit Tools: {{name}}': 'Редактировать инструменты: {{name}}',
  'Edit Color: {{name}}': 'Редактировать цвет: {{name}}',
  'Delete {{name}}': 'Удалить {{name}}',
  'Unknown Step': 'Неизвестный шаг',
  'Esc to close': 'Esc для закрытия',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter для выбора, ↑↓ для навигации, Esc для закрытия',
  'Esc to go back': 'Esc для возврата',
  'Enter to confirm, Esc to cancel': 'Enter для подтверждения, Esc для отмены',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter для выбора, ↑↓ для навигации, Esc для возврата',
  'Invalid step: {{step}}': 'Неверный шаг: {{step}}',
  'No subagents found.': 'Подагенты не найдены.',
  "Use '/agents create' to create your first subagent.":
    "Используйте '/agents create' для создания первого подагента.",
  '(built-in)': '(встроенный)',
  '(overridden by project level agent)':
    '(переопределен агентом уровня проекта)',
  'Project Level ({{path}})': 'Уровень проекта ({{path}})',
  'User Level ({{path}})': 'Уровень пользователя ({{path}})',
  'Built-in Agents': 'Встроенные агенты',
  'Using: {{count}} agents': 'Используется: {{count}} агент(ов)',
  'View Agent': 'Просмотреть агента',
  'Edit Agent': 'Редактировать агента',
  'Delete Agent': 'Удалить агента',
  Back: 'Назад',
  'No agent selected': 'Агент не выбран',
  'File Path: ': 'Путь к файлу: ',
  'Tools: ': 'Инструменты: ',
  'Color: ': 'Цвет: ',
  'Description:': 'Описание:',
  'System Prompt:': 'Системный промпт:',
  'Open in editor': 'Открыть в редакторе',
  'Edit tools': 'Редактировать инструменты',
  'Edit color': 'Редактировать цвет',
  '❌ Error:': '❌ Ошибка:',
  'Are you sure you want to delete agent "{{name}}"?':
    'Вы уверены, что хотите удалить агента "{{name}}"?',
  // ============================================================================
  // Агенты - Мастер создания
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Уровень проекта (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'Уровень пользователя (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ Подагент успешно создан!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'Подагент "{{name}}" сохранен на уровне {{level}}.',
  'Name: ': 'Имя: ',
  'Location: ': 'Расположение: ',
  '❌ Error saving subagent:': '❌ Ошибка сохранения подагента:',
  'Warnings:': 'Предупреждения:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'Имя "{{name}}" уже существует на уровне {{level}} - существующий подагент будет перезаписан',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'Имя "{{name}}" существует на уровне пользователя - уровень проекта будет иметь приоритет',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'Имя "{{name}}" существует на уровне проекта - существующий подагент будет иметь приоритет',
  'Description is over {{length}} characters':
    'Описание превышает {{length}} символов',
  'System prompt is over {{length}} characters':
    'Системный промпт превышает {{length}} символов',
  // Агенты - Шаги мастера создания
  'Step {{n}}: Choose Location': 'Шаг {{n}}: Выберите расположение',
  'Step {{n}}: Choose Generation Method': 'Шаг {{n}}: Выберите метод генерации',
  'Generate with Qwen Code (Recommended)':
    'Сгенерировать с помощью Qwen Code (Рекомендуется)',
  'Manual Creation': 'Ручное создание',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'Опишите, что должен делать этот подагент и когда его следует использовать. (Будьте подробны для лучших результатов)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'например, Экспертный ревьювер кода, проверяющий код на соответствие лучшим практикам...',
  'Generating subagent configuration...': 'Генерация конфигурации подагента...',
  'Failed to generate subagent: {{error}}':
    'Не удалось сгенерировать подагента: {{error}}',
  'Step {{n}}: Describe Your Subagent': 'Шаг {{n}}: Опишите подагента',
  'Step {{n}}: Enter Subagent Name': 'Шаг {{n}}: Введите имя подагента',
  'Step {{n}}: Enter System Prompt': 'Шаг {{n}}: Введите системный промпт',
  'Step {{n}}: Enter Description': 'Шаг {{n}}: Введите описание',
  // Агенты - Выбор инструментов
  'Step {{n}}: Select Tools': 'Шаг {{n}}: Выберите инструменты',
  'All Tools (Default)': 'Все инструменты (по умолчанию)',
  'All Tools': 'Все инструменты',
  'Read-only Tools': 'Инструменты только для чтения',
  'Read & Edit Tools': 'Инструменты для чтения и редактирования',
  'Read & Edit & Execution Tools':
    'Инструменты для чтения, редактирования и выполнения',
  'All tools selected, including MCP tools':
    'Все инструменты выбраны, включая инструменты MCP',
  'Selected tools:': 'Выбранные инструменты:',
  'Read-only tools:': 'Инструменты только для чтения:',
  'Edit tools:': 'Инструменты редактирования:',
  'Execution tools:': 'Инструменты выполнения:',
  'Step {{n}}: Choose Background Color': 'Шаг {{n}}: Выберите цвет фона',
  'Step {{n}}: Confirm and Save': 'Шаг {{n}}: Подтвердите и сохраните',
  // Агенты - Навигация и инструкции
  'Esc to cancel': 'Esc для отмены',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Enter для сохранения, e для сохранения и редактирования, Esc для возврата',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Enter для продолжения, {{navigation}}Esc для {{action}}',
  cancel: 'отмены',
  'go back': 'возврата',
  '↑↓ to navigate, ': '↑↓ для навигации, ',
  'Enter a clear, unique name for this subagent.':
    'Введите четкое, уникальное имя для этого подагента.',
  'e.g., Code Reviewer': 'например, Ревьювер кода',
  'Name cannot be empty.': 'Имя не может быть пустым.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'Напишите системный промпт, определяющий поведение подагента. Будьте подробны для лучших результатов.',
  'e.g., You are an expert code reviewer...':
    'например, Вы экспертный ревьювер кода...',
  'System prompt cannot be empty.': 'Системный промпт не может быть пустым.',
  'Describe when and how this subagent should be used.':
    'Опишите, когда и как следует использовать этого подагента.',
  'e.g., Reviews code for best practices and potential bugs.':
    'например, Проверяет код на соответствие лучшим практикам и потенциальные ошибки.',
  'Description cannot be empty.': 'Описание не может быть пустым.',
  'Failed to launch editor: {{error}}':
    'Не удалось запустить редактор: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'Не удалось сохранить и отредактировать подагента: {{error}}',

  // ============================================================================
  // Команды - Общие (продолжение)
  // ============================================================================
  'View and edit Qwen Code settings': 'Просмотр и изменение настроек Qwen Code',
  Settings: 'Настройки',
  '(Use Enter to select{{tabText}})': '(Enter для выбора{{tabText}})',
  ', Tab to change focus': ', Tab для смены фокуса',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Для применения изменений необходимо перезапустить Qwen Code. Нажмите r для выхода и применения изменений.',

  // ============================================================================
  // Метки настроек
  // ============================================================================
  'Vim Mode': 'Режим Vim',
  'Disable Auto Update': 'Отключить автообновление',
  'Enable Prompt Completion': 'Включить автодополнение промптов',
  'Debug Keystroke Logging': 'Логирование нажатий клавиш для отладки',
  Language: 'Язык',
  'Output Format': 'Формат вывода',
  'Hide Window Title': 'Скрыть заголовок окна',
  'Show Status in Title': 'Показывать статус в заголовке',
  'Hide Tips': 'Скрыть подсказки',
  'Hide Banner': 'Скрыть баннер',
  'Hide Context Summary': 'Скрыть сводку контекста',
  'Hide CWD': 'Скрыть текущую директорию',
  'Hide Sandbox Status': 'Скрыть статус песочницы',
  'Hide Model Info': 'Скрыть информацию о модели',
  'Hide Footer': 'Скрыть нижний колонтитул',
  'Show Memory Usage': 'Показывать использование памяти',
  'Show Line Numbers': 'Показывать номера строк',
  'Show Citations': 'Показывать цитаты',
  'Custom Witty Phrases': 'Пользовательские остроумные фразы',
  'Enable Welcome Back': 'Включить приветствие при возврате',
  'Disable Loading Phrases': 'Отключить фразы при загрузке',
  'Screen Reader Mode': 'Режим программы чтения с экрана',
  'IDE Mode': 'Режим IDE',
  'Max Session Turns': 'Макс. количество ходов сессии',
  'Skip Next Speaker Check': 'Пропустить проверку следующего говорящего',
  'Skip Loop Detection': 'Пропустить обнаружение циклов',
  'Skip Startup Context': 'Пропустить начальный контекст',
  'Enable OpenAI Logging': 'Включить логирование OpenAI',
  'OpenAI Logging Directory': 'Директория логов OpenAI',
  Timeout: 'Таймаут',
  'Max Retries': 'Макс. количество попыток',
  'Disable Cache Control': 'Отключить управление кэшем',
  'Memory Discovery Max Dirs': 'Макс. директорий для поиска в памяти',
  'Load Memory From Include Directories':
    'Загружать память из включенных директорий',
  'Respect .gitignore': 'Учитывать .gitignore',
  'Respect .qwenignore': 'Учитывать .qwenignore',
  'Enable Recursive File Search': 'Включить рекурсивный поиск файлов',
  'Disable Fuzzy Search': 'Отключить нечеткий поиск',
  'Enable Interactive Shell': 'Включить интерактивный терминал',
  'Show Color': 'Показывать цвета',
  'Auto Accept': 'Автоподтверждение',
  'Use Ripgrep': 'Использовать Ripgrep',
  'Use Builtin Ripgrep': 'Использовать встроенный Ripgrep',
  'Enable Tool Output Truncation': 'Включить обрезку вывода инструментов',
  'Tool Output Truncation Threshold': 'Порог обрезки вывода инструментов',
  'Tool Output Truncation Lines': 'Лимит строк вывода инструментов',
  'Folder Trust': 'Доверие к папке',
  'Vision Model Preview': 'Визуальная модель (предпросмотр)',
  // Варианты перечислений настроек
  'Auto (detect from system)': 'Авто (определить из системы)',
  Text: 'Текст',
  JSON: 'JSON',
  Plan: 'План',
  Default: 'По умолчанию',
  'Auto Edit': 'Авторедактирование',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'Включение/выключение режима vim',
  'check session stats. Usage: /stats [model|tools]':
    'Просмотр статистики сессии. Использование: /stats [model|tools]',
  'Show model-specific usage statistics.':
    'Показать статистику использования модели.',
  'Show tool-specific usage statistics.':
    'Показать статистику использования инструментов.',
  'exit the cli': 'Выход из CLI',
  'list configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    'Показать настроенные MCP-серверы и инструменты, или авторизоваться на серверах с поддержкой OAuth',
  'Manage workspace directories':
    'Управление директориями рабочего пространства',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'Добавить директории в рабочее пространство. Используйте запятую для разделения путей',
  'Show all directories in the workspace':
    'Показать все директории в рабочем пространстве',
  'set external editor preference':
    'Установка предпочитаемого внешнего редактора',
  'Manage extensions': 'Управление расширениями',
  'List active extensions': 'Показать активные расширения',
  'Update extensions. Usage: update |--all':
    'Обновить расширения. Использование: update |--all',
  'manage IDE integration': 'Управление интеграцией с IDE',
  'check status of IDE integration': 'Проверить статус интеграции с IDE',
  'install required IDE companion for {{ideName}}':
    'Установить необходимый компаньон IDE для {{ideName}}',
  'enable IDE integration': 'Включение интеграции с IDE',
  'disable IDE integration': 'Отключение интеграции с IDE',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'Интеграция с IDE не поддерживается в вашем окружении. Для использования этой функции запустите Qwen Code в одной из поддерживаемых IDE: VS Code или форках VS Code.',
  'Set up GitHub Actions': 'Настройка GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Настройка привязки клавиш терминала для многострочного ввода (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Пожалуйста, перезапустите терминал для применения изменений.',
  'Failed to configure terminal: {{error}}':
    'Не удалось настроить терминал: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Не удалось определить путь конфигурации {{terminalName}} в Windows: переменная окружения APPDATA не установлена.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json существует, но не является корректным массивом JSON. Пожалуйста, исправьте файл вручную или удалите его для автоматической настройки.',
  'File: {{file}}': 'Файл: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Не удалось разобрать {{terminalName}} keybindings.json. Файл содержит некорректный JSON. Пожалуйста, исправьте файл вручную или удалите его для автоматической настройки.',
  'Error: {{error}}': 'Ошибка: {{error}}',
  'Shift+Enter binding already exists': 'Привязка Shift+Enter уже существует',
  'Ctrl+Enter binding already exists': 'Привязка Ctrl+Enter уже существует',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'Обнаружены существующие привязки клавиш. Не будут изменены во избежание конфликтов.',
  'Please check and modify manually if needed: {{file}}':
    'Пожалуйста, проверьте и измените вручную при необходимости: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'Добавлены привязки Shift+Enter и Ctrl+Enter для {{terminalName}}.',
  'Modified: {{file}}': 'Изменено: {{file}}',
  '{{terminalName}} keybindings already configured.':
    'Привязки клавиш {{terminalName}} уже настроены.',
  'Failed to configure {{terminalName}}.':
    'Не удалось настроить {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'Ваш терминал уже настроен для оптимальной работы с многострочным вводом (Shift+Enter и Ctrl+Enter).',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'Не удалось определить тип терминала. Поддерживаемые терминалы: VS Code, Cursor, Windsurf и Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'Терминал "{{terminal}}" еще не поддерживается.',

  // ============================================================================
  // Команды - Язык
  // ============================================================================
  'Invalid language. Available: en-US, zh-CN':
    'Неверный язык. Доступны: en-US, zh-CN, ru-RU',
  'Language subcommands do not accept additional arguments.':
    'Подкоманды языка не принимают дополнительных аргументов.',
  'Current UI language: {{lang}}': 'Текущий язык интерфейса: {{lang}}',
  'Current LLM output language: {{lang}}': 'Текущий язык вывода LLM: {{lang}}',
  'LLM output language not set': 'Язык вывода LLM не установлен',
  'Set UI language': 'Установка языка интерфейса',
  'Set LLM output language': 'Установка языка вывода LLM',
  'Usage: /language ui [zh-CN|en-US]':
    'Использование: /language ui [zh-CN|en-US|ru-RU]',
  'Usage: /language output ': 'Использование: /language output ',
  'Example: /language output 中文': 'Пример: /language output 中文',
  'Example: /language output English': 'Пример: /language output English',
  'Example: /language output 日本語': 'Пример: /language output 日本語',
  'UI language changed to {{lang}}': 'Язык интерфейса изменен на {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'Файл правил языка вывода LLM создан в {{path}}',
  'Please restart the application for the changes to take effect.':
    'Пожалуйста, перезапустите приложение для применения изменений.',
  'Failed to generate LLM output language rule file: {{error}}':
    'Не удалось создать файл правил языка вывода LLM: {{error}}',
  'Invalid command. Available subcommands:':
    'Неверная команда. Доступные подкоманды:',
  'Available subcommands:': 'Доступные подкоманды:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'Для запроса дополнительных языковых пакетов интерфейса, пожалуйста, создайте обращение на GitHub.',
  'Available options:': 'Доступные варианты:',
  ' - zh-CN: Simplified Chinese': ' - zh-CN: Упрощенный китайский',
  ' - en-US: English': ' - en-US: Английский',
  ' - ru-RU: Russian': ' - ru-RU: Русский',
  'Set UI language to Simplified Chinese (zh-CN)':
    'Установить язык интерфейса на упрощенный китайский (zh-CN)',
  'Set UI language to English (en-US)':
    'Установить язык интерфейса на английский (en-US)',

  // ============================================================================
  // Команды - Режим подтверждения
  // ============================================================================
  'Approval Mode': 'Режим подтверждения',
  'Current approval mode: {{mode}}': 'Текущий режим подтверждения: {{mode}}',
  'Available approval modes:': 'Доступные режимы подтверждения:',
  'Approval mode changed to: {{mode}}':
    'Режим подтверждения изменен на: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    'Режим подтверждения изменен на: {{mode}} (сохранено в настройках {{scope}}{{location}})',
  'Usage: /approval-mode [--session|--user|--project]':
    'Использование: /approval-mode [--session|--user|--project]',
  'Scope subcommands do not accept additional arguments.':
    'Подкоманды области не принимают дополнительных аргументов.',
  'Plan mode - Analyze only, do not modify files or execute commands':
    'Режим планирования - только анализ, без изменения файлов или выполнения команд',
  'Default mode - Require approval for file edits or shell commands':
    'Режим по умолчанию - требуется подтверждение для редактирования файлов или команд терминала',
  'Auto-edit mode - Automatically approve file edits':
    'Режим авторедактирования - автоматическое подтверждение изменений файлов',
  'YOLO mode - Automatically approve all tools':
    'Режим YOLO - автоматическое подтверждение всех инструментов',
  '{{mode}} mode': 'Режим {{mode}}',
  'Settings service is not available; unable to persist the approval mode.':
    'Служба настроек недоступна; невозможно сохранить режим подтверждения.',
  'Failed to save approval mode: {{error}}':
    'Не удалось сохранить режим подтверждения: {{error}}',
  'Failed to change approval mode: {{error}}':
    'Не удалось изменить режим подтверждения: {{error}}',
  'Apply to current session only (temporary)':
    'Применить только к текущей сессии (временно)',
  'Persist for this project/workspace':
    'Сохранить для этого проекта/рабочего пространства',
  'Persist for this user on this machine':
    'Сохранить для этого пользователя на этой машине',
  'Analyze only, do not modify files or execute commands':
    'Только анализ, без изменения файлов или выполнения команд',
  'Require approval for file edits or shell commands':
    'Требуется подтверждение для редактирования файлов или команд терминала',
  'Automatically approve file edits':
    'Автоматически подтверждать изменения файлов',
  'Automatically approve all tools':
    'Автоматически подтверждать все инструменты',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'Режим подтверждения рабочего пространства существует и имеет приоритет. Изменение на уровне пользователя не будет иметь эффекта.',
  '(Use Enter to select, Tab to change focus)':
    '(Enter для выбора, Tab для смены фокуса)',
  'Apply To': 'Применить к',
  'User Settings': 'Настройки пользователя',
  'Workspace Settings': 'Настройки рабочего пространства',

  // ============================================================================
  // Команды - Память
  // ============================================================================
  'Commands for interacting with memory.':
    'Команды для взаимодействия с памятью',
  'Show the current memory contents.': 'Показать текущее содержимое памяти.',
  'Show project-level memory contents.': 'Показать память уровня проекта.',
  'Show global memory contents.': 'Показать глобальную память.',
  'Add content to project-level memory.':
    'Добавить содержимое в память уровня проекта.',
  'Add content to global memory.': 'Добавить содержимое в глобальную память.',
  'Refresh the memory from the source.': 'Обновить память из источника.',
  'Usage: /memory add --project <text to remember>':
    'Использование: /memory add --project <текст для запоминания>',
  'Usage: /memory add --global <text to remember>':
    'Использование: /memory add --global <текст для запоминания>',
  'Attempting to save to project memory: "{{text}}"':
    'Попытка сохранить в память проекта: "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'Попытка сохранить в глобальную память: "{{text}}"',
  'Current memory content from {{count}} file(s):':
    'Текущее содержимое памяти из {{count}} файла(ов):',
  'Memory is currently empty.': 'Память в настоящее время пуста.',
  'Project memory file not found or is currently empty.':
    'Файл памяти проекта не найден или в настоящее время пуст.',
  'Global memory file not found or is currently empty.':
    'Файл глобальной памяти не найден или в настоящее время пуст.',
  'Global memory is currently empty.':
    'Глобальная память в настоящее время пуста.',
  'Global memory content:\n\n---\n{{content}}\n---':
    'Содержимое глобальной памяти:\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    'Содержимое памяти проекта из {{path}}:\n\n---\n{{content}}\n---',
  'Project memory is currently empty.':
    'Память проекта в настоящее время пуста.',
  'Refreshing memory from source files...':
    'Обновление памяти из исходных файлов...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'Добавить содержимое в память. Используйте --global для глобальной памяти или --project для памяти проекта.',
  'Usage: /memory add [--global|--project] <text to remember>':
    'Использование: /memory add [--global|--project] <текст для запоминания>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'Попытка сохранить в память {{scope}}: "{{fact}}"',

  // ============================================================================
  // Команды - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    'Авторизоваться на MCP-сервере с поддержкой OAuth',
  'List configured MCP servers and tools':
    'Просмотр настроенных MCP-серверов и инструментов',
  'Restarts MCP servers.': 'Перезапустить MCP-серверы.',
  'Config not loaded.': 'Конфигурация не загружена.',
  'Could not retrieve tool registry.':
    'Не удалось получить реестр инструментов.',
  'No MCP servers configured with OAuth authentication.':
    'Нет MCP-серверов, настроенных с авторизацией OAuth.',
  'MCP servers with OAuth authentication:': 'MCP-серверы с авторизацией OAuth:',
  'Use /mcp auth <server-name> to authenticate.':
    'Используйте /mcp auth <имя-сервера> для авторизации.',
  "MCP server '{{name}}' not found.": "MCP-сервер '{{name}}' не найден.",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Успешно авторизовано и обновлены инструменты для '{{name}}'.",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "Не удалось авторизоваться на MCP-сервере '{{name}}': {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "Повторное обнаружение инструментов от '{{name}}'...",

  // ============================================================================
  // Команды - Чат
  // ============================================================================
  'Manage conversation history.': 'Управление историей диалогов.',
  'List saved conversation checkpoints':
    'Показать сохраненные точки восстановления диалога',
  'No saved conversation checkpoints found.':
    'Не найдено сохраненных точек восстановления диалога.',
  'List of saved conversations:': 'Список сохраненных диалогов:',
  'Note: Newest last, oldest first':
    'Примечание: новые последними, старые первыми',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    'Сохранить текущий диалог как точку восстановления. Использование: /chat save <тег>',
  'Missing tag. Usage: /chat save <tag>':
    'Отсутствует тег. Использование: /chat save <тег>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    'Удалить точку восстановления диалога. Использование: /chat delete <тег>',
  'Missing tag. Usage: /chat delete <tag>':
    'Отсутствует тег. Использование: /chat delete <тег>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "Точка восстановления диалога '{{tag}}' удалена.",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "Ошибка: точка восстановления с тегом '{{tag}}' не найдена.",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    'Возобновить диалог из точки восстановления. Использование: /chat resume <тег>',
  'Missing tag. Usage: /chat resume <tag>':
    'Отсутствует тег. Использование: /chat resume <тег>',
  'No saved checkpoint found with tag: {{tag}}.':
    'Не найдена сохраненная точка восстановления с тегом: {{tag}}.',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    'Точка восстановления с тегом {{tag}} уже существует. Перезаписать?',
  'No chat client available to save conversation.':
    'Нет доступного клиента чата для сохранения диалога.',
  'Conversation checkpoint saved with tag: {{tag}}.':
    'Точка восстановления диалога сохранена с тегом: {{tag}}.',
  'No conversation found to save.': 'Нет диалога для сохранения.',
  'No chat client available to share conversation.':
    'Нет доступного клиента чата для экспорта диалога.',
  'Invalid file format. Only .md and .json are supported.':
    'Неверный формат файла. Поддерживаются только .md и .json.',
  'Error sharing conversation: {{error}}':
    'Ошибка при экспорте диалога: {{error}}',
  'Conversation shared to {{filePath}}': 'Диалог экспортирован в {{filePath}}',
  'No conversation found to share.': 'Нет диалога для экспорта.',
  'Share the current conversation to a markdown or json file. Usage: /chat share <путь-к-файлу>':
    'Экспортировать текущий диалог в markdown или json файл. Использование: /chat share <путь-к-файлу>',

  // ============================================================================
  // Команды - Резюме
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Сгенерировать сводку проекта и сохранить её в .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'Нет доступного чат-клиента для генерации сводки.',
  'Already generating summary, wait for previous request to complete':
    'Генерация сводки уже выполняется, дождитесь завершения предыдущего запроса',
  'No conversation found to summarize.':
    'Не найдено диалогов для создания сводки.',
  'Failed to generate project context summary: {{error}}':
    'Не удалось сгенерировать сводку контекста проекта: {{error}}',

  // ============================================================================
  // Команды - Модель
  // ============================================================================
  'Switch the model for this session': 'Переключение модели для этой сессии',
  'Content generator configuration not available.':
    'Конфигурация генератора содержимого недоступна.',
  'Authentication type not available.': 'Тип авторизации недоступен.',
  'No models available for the current authentication type ({{authType}}).':
    'Нет доступных моделей для текущего типа авторизации ({{authType}}).',

  // ============================================================================
  // Команды - Очистка
  // ============================================================================
  'Clearing terminal and resetting chat.': 'Очистка терминала и сброс чата.',
  'Clearing terminal.': 'Очистка терминала.',

  // ============================================================================
  // Команды - Сжатие
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Уже выполняется сжатие, дождитесь завершения предыдущего запроса',
  'Failed to compress chat history.': 'Не удалось сжать историю чата.',
  'Failed to compress chat history: {{error}}':
    'Не удалось сжать историю чата: {{error}}',
  'Compressing chat history': 'Сжатие истории чата',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'История чата сжата с {{originalTokens}} до {{newTokens}} токенов.',
  'Compression was not beneficial for this history size.':
    'Сжатие не было полезным для этого размера истории.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'Сжатие истории чата не уменьшило размер. Это может указывать на проблемы с промптом сжатия.',
  'Could not compress chat history due to a token counting error.':
    'Не удалось сжать историю чата из-за ошибки подсчета токенов.',
  'Chat history is already compressed.': 'История чата уже сжата.',

  // ============================================================================
  // Команды - Директория
  // ============================================================================
  'Configuration is not available.': 'Конфигурация недоступна.',
  'Please provide at least one path to add.':
    'Пожалуйста, укажите хотя бы один путь для добавления.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'Команда /directory add не поддерживается в ограничительных профилях песочницы. Пожалуйста, используйте --include-directories при запуске сессии.',
  "Error adding '{{path}}': {{error}}":
    "Ошибка при добавлении '{{path}}': {{error}}",
  'Successfully added GEMINI.md files from the following directories if there are:\n- {{directories}}':
    'Успешно добавлены файлы GEMINI.md из следующих директорий (если они есть):\n- {{directories}}',
  'Error refreshing memory: {{error}}':
    'Ошибка при обновлении памяти: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'Успешно добавлены директории:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    'Текущие директории рабочего пространства:\n{{directories}}',

  // ============================================================================
  // Команды - Документация
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Пожалуйста, откройте следующий URL в браузере для просмотра документации:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Открытие документации в браузере: {{url}}',

  // ============================================================================
  // Диалоги - Подтверждение инструментов
  // ============================================================================
  'Do you want to proceed?': 'Вы хотите продолжить?',
  'Yes, allow once': 'Да, разрешить один раз',
  'Allow always': 'Всегда разрешать',
  No: 'Нет',
  'No (esc)': 'Нет (esc)',
  'Yes, allow always for this session': 'Да, всегда разрешать для этой сессии',
  'Modify in progress:': 'Идет изменение:',
  'Save and close external editor to continue':
    'Сохраните и закройте внешний редактор для продолжения',
  'Apply this change?': 'Применить это изменение?',
  'Yes, allow always': 'Да, всегда разрешать',
  'Modify with external editor': 'Изменить во внешнем редакторе',
  'No, suggest changes (esc)': 'Нет, предложить изменения (esc)',
  "Allow execution of: '{{command}}'?": "Разрешить выполнение: '{{command}}'?",
  'Yes, allow always ...': 'Да, всегда разрешать ...',
  'Yes, and auto-accept edits': 'Да, и автоматически принимать правки',
  'Yes, and manually approve edits': 'Да, и вручную подтверждать правки',
  'No, keep planning (esc)': 'Нет, продолжить планирование (esc)',
  'URLs to fetch:': 'URL для загрузки:',
  'MCP Server: {{server}}': 'MCP-сервер: {{server}}',
  'Tool: {{tool}}': 'Инструмент: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Разрешить выполнение инструмента MCP "{{tool}}" с сервера "{{server}}"?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'Да, всегда разрешать инструмент "{{tool}}" с сервера "{{server}}"',
  'Yes, always allow all tools from server "{{server}}"':
    'Да, всегда разрешать все инструменты с сервера "{{server}}"',

  // ============================================================================
  // Диалоги - Подтверждение оболочки
  // ============================================================================
  'Shell Command Execution': 'Выполнение команды терминала',
  'A custom command wants to run the following shell commands:':
    'Пользовательская команда хочет выполнить следующие команды терминала:',

  // ============================================================================
  // Диалоги - Квота подписки Pro
  // ============================================================================
  'Pro quota limit reached for {{model}}.':
    'Исчерпана квота подписки Pro для {{model}}.',
  'Change auth (executes the /auth command)':
    'Изменить авторизацию (выполняет команду /auth)',
  'Continue with {{model}}': 'Продолжить с {{model}}',

  // ============================================================================
  // Диалоги - Приветствие при возвращении
  // ============================================================================
  'Current Plan:': 'Текущий план:',
  'Progress: {{done}}/{{total}} tasks completed':
    'Прогресс: {{done}}/{{total}} задач выполнено',
  ', {{inProgress}} in progress': ', {{inProgress}} в процессе',
  'Pending Tasks:': 'Ожидающие задачи:',
  'What would you like to do?': 'Что вы хотите сделать?',
  'Choose how to proceed with your session:':
    'Выберите, как продолжить сессию:',
  'Start new chat session': 'Начать новую сессию чата',
  'Continue previous conversation': 'Продолжить предыдущий диалог',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 С возвращением! (Последнее обновление: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Общая цель:',

  // ============================================================================
  // Диалоги - Авторизация
  // ============================================================================
  'Get started': 'Начать',
  'How would you like to authenticate for this project?':
    'Как вы хотите авторизоваться для этого проекта?',
  'OpenAI API key is required to use OpenAI authentication.':
    'Для использования авторизации OpenAI требуется ключ API OpenAI.',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'Вы должны выбрать метод авторизации для продолжения. Нажмите Ctrl+C снова для выхода.',
  '(Use Enter to Set Auth)': '(Enter для установки авторизации)',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Условия обслуживания и уведомление о конфиденциальности для Qwen Code',
  'Qwen OAuth': 'Qwen OAuth',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'Не удалось войти. Сообщение: {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'Авторизация должна быть {{enforcedType}}, но вы сейчас используете {{currentType}}.',
  'Qwen OAuth authentication timed out. Please try again.':
    'Время ожидания авторизации Qwen OAuth истекло. Пожалуйста, попробуйте снова.',
  'Qwen OAuth authentication cancelled.': 'Авторизация Qwen OAuth отменена.',
  'Qwen OAuth Authentication': 'Авторизация Qwen OAuth',
  'Please visit this URL to authorize:':
    'Пожалуйста, посетите этот URL для авторизации:',
  'Or scan the QR code below:': 'Или отсканируйте QR-код ниже:',
  'Waiting for authorization': 'Ожидание авторизации',
  'Time remaining:': 'Осталось времени:',
  '(Press ESC or CTRL+C to cancel)': '(Нажмите ESC или CTRL+C для отмены)',
  'Qwen OAuth Authentication Timeout': 'Таймаут авторизации Qwen OAuth',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'Токен OAuth истек (более {{seconds}} секунд). Пожалуйста, выберите метод авторизации снова.',
  'Press any key to return to authentication type selection.':
    'Нажмите любую клавишу для возврата к выбору типа авторизации.',
  'Waiting for Qwen OAuth authentication...':
    'Ожидание авторизации Qwen OAuth...',
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    'Примечание: Ваш существующий ключ API в settings.json не будет удален при использовании Qwen OAuth. Вы можете переключиться обратно на авторизацию OpenAI позже при необходимости.',
  'Authentication timed out. Please try again.':
    'Время ожидания авторизации истекло. Пожалуйста, попробуйте снова.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Ожидание авторизации... (Нажмите ESC или CTRL+C для отмены)',
  'Failed to authenticate. Message: {{message}}':
    'Не удалось авторизоваться. Сообщение: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    'Успешно авторизовано с учетными данными {{authType}}.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Неверное значение QWEN_DEFAULT_AUTH_TYPE: "{{value}}". Допустимые значения: {{validValues}}',
  'OpenAI Configuration Required': 'Требуется конфигурация OpenAI',
  'Please enter your OpenAI configuration. You can get an API key from':
    'Пожалуйста, введите конфигурацию OpenAI. Вы можете получить ключ API на',
  'API Key:': 'Ключ API:',
  'Invalid credentials: {{errorMessage}}':
    'Неверные учетные данные: {{errorMessage}}',
  'Failed to validate credentials': 'Не удалось проверить учетные данные',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Enter для продолжения, Tab/↑↓ для навигации, Esc для отмены',

  // ============================================================================
  // Диалоги - Модель
  // ============================================================================
  'Select Model': 'Выбрать модель',
  '(Press Esc to close)': '(Нажмите Esc для закрытия)',
  'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)':
    'Последняя модель Qwen Coder от Alibaba Cloud ModelStudio (версия: qwen3-coder-plus-2025-09-23)',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    'Последняя модель Qwen Vision от Alibaba Cloud ModelStudio (версия: qwen3-vl-plus-2025-09-23)',

  // ============================================================================
  // Диалоги - Разрешения
  // ============================================================================
  'Manage folder trust settings': 'Управление настройками доверия к папкам',

  // ============================================================================
  // Строка состояния
  // ============================================================================
  'Using:': 'Используется:',
  '{{count}} open file': '{{count}} открытый файл',
  '{{count}} open files': '{{count}} открытых файла(ов)',
  '(ctrl+g to view)': '(ctrl+g для просмотра)',
  '{{count}} {{name}} file': '{{count}} файл {{name}}',
  '{{count}} {{name}} files': '{{count}} файла(ов) {{name}}',
  '{{count}} MCP server': '{{count}} MCP-сервер',
  '{{count}} MCP servers': '{{count}} MCP-сервера(ов)',
  '{{count}} Blocked': '{{count}} заблокирован(о)',
  '(ctrl+t to view)': '(ctrl+t для просмотра)',
  '(ctrl+t to toggle)': '(ctrl+t для переключения)',
  'Press Ctrl+C again to exit.': 'Нажмите Ctrl+C снова для выхода.',
  'Press Ctrl+D again to exit.': 'Нажмите Ctrl+D снова для выхода.',
  'Press Esc again to clear.': 'Нажмите Esc снова для очистки.',

  // ============================================================================
  // Статус MCP
  // ============================================================================
  'No MCP servers configured.': 'Не настроено MCP-серверов.',
  'Please view MCP documentation in your browser:':
    'Пожалуйста, просмотрите документацию MCP в браузере:',
  'or use the cli /docs command': 'или используйте команду cli /docs',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP-серверы запускаются ({{count}} инициализируется)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Примечание: Первый запуск может занять больше времени. Доступность инструментов обновится автоматически.',
  'Configured MCP servers:': 'Настроенные MCP-серверы:',
  Ready: 'Готов',
  'Starting... (first startup may take longer)':
    'Запуск... (первый запуск может занять больше времени)',
  Disconnected: 'Отключен',
  '{{count}} tool': '{{count}} инструмент',
  '{{count}} tools': '{{count}} инструмента(ов)',
  '{{count}} prompt': '{{count}} промпт',
  '{{count}} prompts': '{{count}} промпта(ов)',
  '(from {{extensionName}})': '(от {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth истек',
  'OAuth not authenticated': 'OAuth не авторизован',
  'tools and prompts will appear when ready':
    'инструменты и промпты появятся, когда будут готовы',
  '{{count}} tools cached': '{{count}} инструмента(ов) в кэше',
  'Tools:': 'Инструменты:',
  'Parameters:': 'Параметры:',
  'Prompts:': 'Промпты:',
  Blocked: 'Заблокировано',
  '💡 Tips:': '💡 Подсказки:',
  Use: 'Используйте',
  'to show server and tool descriptions':
    'для показа описаний сервера и инструментов',
  'to show tool parameter schemas': 'для показа схем параметров инструментов',
  'to hide descriptions': 'для скрытия описаний',
  'to authenticate with OAuth-enabled servers':
    'для авторизации на серверах с поддержкой OAuth',
  Press: 'Нажмите',
  'to toggle tool descriptions on/off':
    'для переключения описаний инструментов',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Начало авторизации OAuth для MCP-сервера '{{name}}'...",
  'Restarting MCP servers...': 'Перезапуск MCP-серверов...',

  // ============================================================================
  // Подсказки при запуске
  // ============================================================================
  'Tips for getting started:': 'Подсказки для начала работы:',
  '1. Ask questions, edit files, or run commands.':
    '1. Задавайте вопросы, редактируйте файлы или выполняйте команды.',
  '2. Be specific for the best results.':
    '2. Будьте конкретны для лучших результатов.',
  'files to customize your interactions with Qwen Code.':
    'файлы для настройки взаимодействия с Qwen Code.',
  'for more information.': 'для получения дополнительной информации.',

  // ============================================================================
  // Экран выхода / Статистика
  // ============================================================================
  'Agent powering down. Goodbye!': 'Агент завершает работу. До свидания!',
  'Interaction Summary': 'Сводка взаимодействия',
  'Session ID:': 'ID сессии:',
  'Tool Calls:': 'Вызовы инструментов:',
  'Success Rate:': 'Процент успеха:',
  'User Agreement:': 'Согласие пользователя:',
  reviewed: 'проверено',
  'Code Changes:': 'Изменения кода:',
  Performance: 'Производительность',
  'Wall Time:': 'Общее время:',
  'Agent Active:': 'Активность агента:',
  'API Time:': 'Время API:',
  'Tool Time:': 'Время инструментов:',
  'Session Stats': 'Статистика сессии',
  'Model Usage': 'Использование модели',
  Reqs: 'Запросов',
  'Input Tokens': 'Входных токенов',
  'Output Tokens': 'Выходных токенов',
  'Savings Highlight:': 'Экономия:',
  'of input tokens were served from the cache, reducing costs.':
    'входных токенов обслужено из кэша, снижая затраты.',
  'Tip: For a full token breakdown, run `/stats model`.':
    'Подсказка: Для полной разбивки токенов выполните `/stats model`.',
  'Model Stats For Nerds': 'Статистика модели для гиков',
  'Tool Stats For Nerds': 'Статистика инструментов для гиков',
  Metric: 'Метрика',
  API: 'API',
  Requests: 'Запросы',
  Errors: 'Ошибки',
  'Avg Latency': 'Средняя задержка',
  Tokens: 'Токены',
  Total: 'Всего',
  Prompt: 'Промпт',
  Cached: 'Кэшировано',
  Thoughts: 'Размышления',
  Tool: 'Инструмент',
  Output: 'Вывод',
  'No API calls have been made in this session.':
    'В этой сессии не было вызовов API.',
  'Tool Name': 'Имя инструмента',
  Calls: 'Вызовы',
  'Success Rate': 'Процент успеха',
  'Avg Duration': 'Средняя длительность',
  'User Decision Summary': 'Сводка решений пользователя',
  'Total Reviewed Suggestions:': 'Всего проверено предложений:',
  ' » Accepted:': ' » Принято:',
  ' » Rejected:': ' » Отклонено:',
  ' » Modified:': ' » Изменено:',
  ' Overall Agreement Rate:': ' Общий процент согласия:',
  'No tool calls have been made in this session.':
    'В этой сессии не было вызовов инструментов.',
  'Session start time is unavailable, cannot calculate stats.':
    'Время начала сессии недоступно, невозможно рассчитать статистику.',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...':
    'Ожидание подтверждения от пользователя...',
  '(esc to cancel, {{time}})': '(esc для отмены, {{time}})',
  "I'm Feeling Lucky": 'Мне повезёт!',
  'Shipping awesomeness... ': 'Доставляем крутизну... ',
  'Painting the serifs back on...': 'Рисуем засечки на буквах...',
  'Navigating the slime mold...': 'Пробираемся через слизевиков..',
  'Consulting the digital spirits...': 'Советуемся с цифровыми духами...',
  'Reticulating splines...': 'Сглаживание сплайнов...',
  'Warming up the AI hamsters...': 'Разогреваем ИИ-хомячков...',
  'Asking the magic conch shell...': 'Спрашиваем волшебную ракушку...',
  'Generating witty retort...': 'Генерируем остроумный ответ...',
  'Polishing the algorithms...': 'Полируем алгоритмы...',
  "Don't rush perfection (or my code)...":
    'Не торопите совершенство (или мой код)...',
  'Brewing fresh bytes...': 'Завариваем свежие байты...',
  'Counting electrons...': 'Пересчитываем электроны...',
  'Engaging cognitive processors...': 'Задействуем когнитивные процессоры...',
  'Checking for syntax errors in the universe...':
    'Ищем синтаксические ошибки во вселенной...',
  'One moment, optimizing humor...': 'Секундочку, оптимизируем юмор...',
  'Shuffling punchlines...': 'Перетасовываем панчлайны...',
  'Untangling neural nets...': 'Распутаваем нейросети...',
  'Compiling brilliance...': 'Компилируем гениальность...',
  'Loading wit.exe...': 'Загружаем yumor.exe...',
  'Summoning the cloud of wisdom...': 'Призываем облако мудрости...',
  'Preparing a witty response...': 'Готовим остроумный ответ...',
  "Just a sec, I'm debugging reality...": 'Секунду, идёт отладка реальности...',
  'Confuzzling the options...': 'Запутываем варианты...',
  'Tuning the cosmic frequencies...': 'Настраиваем космические частоты...',
  'Crafting a response worthy of your patience...':
    'Создаем ответ, достойный вашего терпения...',
  'Compiling the 1s and 0s...': 'Компилируем единички и нолики...',
  'Resolving dependencies... and existential crises...':
    'Разрешаем зависимости... и экзистенциальные кризисы...',
  'Defragmenting memories... both RAM and personal...':
    'Дефрагментация памяти... и оперативной, и личной...',
  'Rebooting the humor module...': 'Перезагрузка модуля юмора...',
  'Caching the essentials (mostly cat memes)...':
    'Кэшируем самое важное (в основном мемы с котиками)...',
  'Optimizing for ludicrous speed': 'Оптимизация для безумной скорости',
  "Swapping bits... don't tell the bytes...":
    'Меняем биты... только байтам не говорите...',
  'Garbage collecting... be right back...': 'Сборка мусора... скоро вернусь...',
  'Assembling the interwebs...': 'Сборка интернетов...',
  'Converting coffee into code...': 'Превращаем кофе в код...',
  'Updating the syntax for reality...': 'Обновляем синтаксис реальности...',
  'Rewiring the synapses...': 'Переподключаем синапсы...',
  'Looking for a misplaced semicolon...': 'Ищем лишнюю точку с запятой...',
  "Greasin' the cogs of the machine...": 'Смазываем шестерёнки машины...',
  'Pre-heating the servers...': 'Разогреваем серверы...',
  'Calibrating the flux capacitor...': 'Калибруем потоковый накопитель...',
  'Engaging the improbability drive...': 'Включаем двигатель невероятности...',
  'Channeling the Force...': 'Направляем Силу...',
  'Aligning the stars for optimal response...':
    'Выравниваем звёзды для оптимального ответа...',
  'So say we all...': 'Так скажем мы все...',
  'Loading the next great idea...': 'Загрузка следующей великой идеи...',
  "Just a moment, I'm in the zone...": 'Минутку, я в потоке...',
  'Preparing to dazzle you with brilliance...':
    'Готовлюсь ослепить вас гениальностью...',
  "Just a tick, I'm polishing my wit...": 'Секунду, полирую остроумие...',
  "Hold tight, I'm crafting a masterpiece...": 'Держитесь, создаю шедевр...',
  "Just a jiffy, I'm debugging the universe...":
    'Мигом, отлаживаю вселенную...',
  "Just a moment, I'm aligning the pixels...": 'Момент, выравниваю пиксели...',
  "Just a sec, I'm optimizing the humor...": 'Секунду, оптимизирую юмор...',
  "Just a moment, I'm tuning the algorithms...":
    'Момент, настраиваю алгоритмы...',
  'Warp speed engaged...': 'Варп-скорость включена...',
  'Mining for more Dilithium crystals...': 'Добываем кристаллы дилития...',
  "Don't panic...": 'Без паники...',
  'Following the white rabbit...': 'Следуем за белым кроликом...',
  'The truth is in here... somewhere...': 'Истина где-то здесь... внутри...',
  'Blowing on the cartridge...': 'Продуваем картридж...',
  'Loading... Do a barrel roll!': 'Загрузка... Сделай бочку!',
  'Waiting for the respawn...': 'Ждем респауна...',
  'Finishing the Kessel Run in less than 12 parsecs...':
    'Делаем Дугу Кесселя менее чем за 12 парсеков...',
  "The cake is not a lie, it's just still loading...":
    'Тортик — не ложь, он просто ещё грузится...',
  'Fiddling with the character creation screen...':
    'Возимся с экраном создания персонажа...',
  "Just a moment, I'm finding the right meme...":
    'Минутку, ищу подходящий мем...',
  "Pressing 'A' to continue...": "Нажимаем 'A' для продолжения...",
  'Herding digital cats...': 'Пасём цифровых котов...',
  'Polishing the pixels...': 'Полируем пиксели...',
  'Finding a suitable loading screen pun...':
    'Ищем подходящий каламбур для экрана загрузки...',
  'Distracting you with this witty phrase...':
    'Отвлекаем вас этой остроумной фразой...',
  'Almost there... probably...': 'Почти готово... вроде...',
  'Our hamsters are working as fast as they can...':
    'Наши хомячки работают изо всех сил...',
  'Giving Cloudy a pat on the head...': 'Гладим Облачко по голове...',
  'Petting the cat...': 'Гладим кота...',
  'Rickrolling my boss...': 'Рикроллим начальника...',
  'Never gonna give you up, never gonna let you down...':
    'Never gonna give you up, never gonna let you down...',
  'Slapping the bass...': 'Лабаем бас-гитару...',
  'Tasting the snozberries...': 'Пробуем снузберри на вкус...',
  "I'm going the distance, I'm going for speed...":
    'Иду до конца, иду на скорость...',
  'Is this the real life? Is this just fantasy?...':
    'Is this the real life? Is this just fantasy?...',
  "I've got a good feeling about this...": 'У меня хорошее предчувствие...',
  'Poking the bear...': 'Дразним медведя... (Не лезь...)',
  'Doing research on the latest memes...': 'Изучаем свежие мемы...',
  'Figuring out how to make this more witty...':
    'Думаем, как сделать это остроумнее...',
  'Hmmm... let me think...': 'Хмм... дайте подумать...',
  'What do you call a fish with no eyes? A fsh...':
    'Как называется бумеранг, который не возвращается? Палка...',
  'Why did the computer go to therapy? It had too many bytes...':
    'Почему компьютер простудился? Потому что оставил окна открытыми...',
  "Why don't programmers like nature? It has too many bugs...":
    'Почему программисты не любят гулять на улице? Там среда не настроена...',
  'Why do programmers prefer dark mode? Because light attracts bugs...':
    'Почему программисты предпочитают тёмную тему? Потому что в темноте не видно багов...',
  'Why did the developer go broke? Because they used up all their cache...':
    'Почему разработчик разорился? Потому что потратил весь свой кэш...',
  "What can you do with a broken pencil? Nothing, it's pointless...":
    'Что можно делать со сломанным карандашом? Ничего — он тупой...',
  'Applying percussive maintenance...': 'Провожу настройку методом тыка...',
  'Searching for the correct USB orientation...':
    'Ищем, какой стороной вставлять флешку...',
  'Ensuring the magic smoke stays inside the wires...':
    'Следим, чтобы волшебный дым не вышел из проводов...',
  'Rewriting in Rust for no particular reason...':
    'Переписываем всё на Rust без особой причины...',
  'Trying to exit Vim...': 'Пытаемся выйти из Vim...',
  'Spinning up the hamster wheel...': 'Раскручиваем колесо для хомяка...',
  "That's not a bug, it's an undocumented feature...": 'Это не баг, а фича...',
  'Engage.': 'Поехали!',
  "I'll be back... with an answer.": 'Я вернусь... с ответом.',
  'My other process is a TARDIS...': 'Мой другой процесс — это ТАРДИС...',
  'Communing with the machine spirit...': 'Общаемся с духом машины...',
  'Letting the thoughts marinate...': 'Даем мыслям замариноваться...',
  'Just remembered where I put my keys...':
    'Только что вспомнил, куда положил ключи...',
  'Pondering the orb...': 'Размышляю над сферой...',
  "I've seen things you people wouldn't believe... like a user who reads loading messages.":
    'Я видел такое, во что вы, люди, просто не поверите... например, пользователя, читающего сообщения загрузки.',
  'Initiating thoughtful gaze...': 'Инициируем задумчивый взгляд...',
  "What's a computer's favorite snack? Microchips.":
    'Что сервер заказывает в баре? Пинг-коладу.',
  "Why do Java developers wear glasses? Because they don't C#.":
    'Почему Java-разработчики не убираются дома? Они ждут сборщик мусора...',
  'Charging the laser... pew pew!': 'Заряжаем лазер... пиу-пиу!',
  'Dividing by zero... just kidding!': 'Делим на ноль... шучу!',
  'Looking for an adult superviso... I mean, processing.':
    'Ищу взрослых для присмот... в смысле, обрабатываю.',
  'Making it go beep boop.': 'Делаем бип-буп.',
  'Buffering... because even AIs need a moment.':
    'Буферизация... даже ИИ нужно мгновение.',
  'Entangling quantum particles for a faster response...':
    'Запутываем квантовые частицы для быстрого ответа...',
  'Polishing the chrome... on the algorithms.':
    'Полируем хром... на алгоритмах.',
  'Are you not entertained? (Working on it!)':
    'Вы ещё не развлеклись?! Разве вы не за этим сюда пришли?!',
  'Summoning the code gremlins... to help, of course.':
    'Призываем гремлинов кода... для помощи, конечно же.',
  'Just waiting for the dial-up tone to finish...':
    'Ждем, пока закончится звук dial-up модема...',
  'Recalibrating the humor-o-meter.': 'Перекалибровка юморометра.',
  'My other loading screen is even funnier.':
    'Мой другой экран загрузки ещё смешнее.',
  "Pretty sure there's a cat walking on the keyboard somewhere...":
    'Кажется, где-то по клавиатуре гуляет кот...',
  'Enhancing... Enhancing... Still loading.':
    'Улучшаем... Ещё улучшаем... Всё ещё грузится.',
  "It's not a bug, it's a feature... of this loading screen.":
    'Это не баг, это фича... экрана загрузки.',
  'Have you tried turning it off and on again? (The loading screen, not me.)':
    'Пробовали выключить и включить снова? (Экран загрузки, не меня!)',
  'Constructing additional pylons...': 'Нужно построить больше пилонов...',
};
