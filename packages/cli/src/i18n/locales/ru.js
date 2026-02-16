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
  '(tab to cycle)': '(Tab для переключения)',
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
  'Toggle this help display': 'Показать/скрыть эту справку',
  'Toggle shell mode': 'Переключить режим оболочки',
  'Open command menu': 'Открыть меню команд',
  'Add file context': 'Добавить файл в контекст',
  'Accept suggestion / Autocomplete': 'Принять подсказку / Автодополнение',
  'Reverse search history': 'Обратный поиск по истории',
  'Press ? again to close': 'Нажмите ? ещё раз, чтобы закрыть',
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
  '? for shortcuts': '? — горячие клавиши',
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
  Status: 'Статус',

  // Keyboard shortcuts panel descriptions
  'for shell mode': 'режим оболочки',
  'for commands': 'меню команд',
  'for file paths': 'пути к файлам',
  'to clear input': 'очистить ввод',
  'to cycle approvals': 'переключить режим',
  'to quit': 'выход',
  'for newline': 'новая строка',
  'to clear screen': 'очистить экран',
  'to search history': 'поиск в истории',
  'to paste images': 'вставить изображения',
  'for external editor': 'внешний редактор',

  // ============================================================================
  // Поля системной информации
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Среда выполнения',
  OS: 'ОС',
  Auth: 'Аутентификация',
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
  Proxy: 'Прокси',
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
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Недопустимый режим подтверждения "{{arg}}". Допустимые режимы: {{modes}}',
  'Approval mode set to "{{mode}}"':
    'Режим подтверждения установлен на "{{mode}}"',
  'View or change the language setting':
    'Просмотр или изменение настроек языка',
  'change the theme': 'Изменение темы',
  'Select Theme': 'Выбор темы',
  Preview: 'Предпросмотр',
  '(Use Enter to select, Tab to configure scope)':
    '(Enter для выбора, Tab для настройки области)',
  '(Use Enter to apply scope, Tab to go back)':
    '(Enter для применения области, Tab для возврата)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Настройка темы недоступна из-за переменной окружения NO_COLOR.',
  'Theme "{{themeName}}" not found.': 'Тема "{{themeName}}" не найдена.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Тема "{{themeName}}" не найдена в выбранной области.',
  'Clear conversation history and free up context':
    'Очистить историю диалога и освободить контекст',
  'Compresses the context by replacing it with a summary.':
    'Сжатие контекста заменой на краткую сводку',
  'open full Qwen Code documentation in your browser':
    'Открытие полной документации Qwen Code в браузере',
  'Configuration not available.': 'Конфигурация недоступна.',
  'change the auth method': 'Изменение метода авторизации',
  'Configure authentication information for login':
    'Настройка аутентификационной информации для входа',
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
  'Extension Agents': 'Агенты расширений',
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
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'Для применения изменений необходимо перезапустить Qwen Code. Нажмите r для выхода и применения изменений.',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'Команда "/{{command}}" не поддерживается в неинтерактивном режиме.',
  // ============================================================================
  // Метки настроек
  // ============================================================================
  'Vim Mode': 'Режим Vim',
  'Disable Auto Update': 'Отключить автообновление',
  'Attribution: commit': 'Атрибуция: коммит',
  'Terminal Bell Notification': 'Звуковое уведомление терминала',
  'Enable Usage Statistics': 'Включить сбор статистики использования',
  Theme: 'Тема',
  'Preferred Editor': 'Предпочтительный редактор',
  'Auto-connect to IDE': 'Автоподключение к IDE',
  'Enable Prompt Completion': 'Включить автодополнение промптов',
  'Debug Keystroke Logging': 'Логирование нажатий клавиш для отладки',
  'Language: UI': 'Язык: интерфейс',
  'Language: Model': 'Язык: модель',
  'Output Format': 'Формат вывода',
  'Hide Window Title': 'Скрыть заголовок окна',
  'Show Status in Title': 'Показывать статус в заголовке',
  'Hide Tips': 'Скрыть подсказки',
  'Show Line Numbers in Code': 'Показывать номера строк в коде',
  'Show Citations': 'Показывать цитаты',
  'Custom Witty Phrases': 'Пользовательские остроумные фразы',
  'Show Welcome Back Dialog': 'Показывать диалог приветствия',
  'Enable User Feedback': 'Включить отзывы пользователей',
  'How is Qwen doing this session? (optional)':
    'Как дела у Qwen в этой сессии? (необязательно)',
  Bad: 'Плохо',
  Fine: 'Нормально',
  Good: 'Хорошо',
  Dismiss: 'Отклонить',
  'Not Sure Yet': 'Пока не уверен',
  'Any other key': 'Любая другая клавиша',
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
  'Interactive Shell (PTY)': 'Интерактивный терминал (PTY)',
  'Show Color': 'Показывать цвета',
  'Auto Accept': 'Автоподтверждение',
  'Use Ripgrep': 'Использовать Ripgrep',
  'Use Builtin Ripgrep': 'Использовать встроенный Ripgrep',
  'Enable Tool Output Truncation': 'Включить обрезку вывода инструментов',
  'Tool Output Truncation Threshold': 'Порог обрезки вывода инструментов',
  'Tool Output Truncation Lines': 'Лимит строк вывода инструментов',
  'Folder Trust': 'Доверие к папке',
  'Vision Model Preview': 'Визуальная модель (предпросмотр)',
  'Tool Schema Compliance': 'Соответствие схеме инструмента',
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
  'Select Editor': 'Выбрать редактор',
  'Editor Preference': 'Настройка редактора',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'В настоящее время поддерживаются следующие редакторы. Обратите внимание, что некоторые редакторы нельзя использовать в режиме песочницы.',
  'Your preferred editor is:': 'Ваш предпочитаемый редактор:',
  'Manage extensions': 'Управление расширениями',
  'List active extensions': 'Показать активные расширения',
  'Update extensions. Usage: update <extension-names>|--all':
    'Обновить расширения. Использование: update <extension-names>|--all',
  'Disable an extension': 'Отключить расширение',
  'Enable an extension': 'Включить расширение',
  'Install an extension from a git repo or local path':
    'Установить расширение из Git-репозитория или локального пути',
  'Uninstall an extension': 'Удалить расширение',
  'No extensions installed.': 'Расширения не установлены.',
  'Usage: /extensions update <extension-names>|--all':
    'Использование: /extensions update <имена-расширений>|--all',
  'Extension "{{name}}" not found.': 'Расширение "{{name}}" не найдено.',
  'No extensions to update.': 'Нет расширений для обновления.',
  'Usage: /extensions install <source>':
    'Использование: /extensions install <источник>',
  'Installing extension from "{{source}}"...':
    'Установка расширения из "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Расширение "{{name}}" успешно установлено.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Не удалось установить расширение из "{{source}}": {{error}}',
  'Usage: /extensions uninstall <extension-name>':
    'Использование: /extensions uninstall <имя-расширения>',
  'Uninstalling extension "{{name}}"...': 'Удаление расширения "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    'Расширение "{{name}}" успешно удалено.',
  'Failed to uninstall extension "{{name}}": {{error}}':
    'Не удалось удалить расширение "{{name}}": {{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    'Использование: /extensions {{command}} <расширение> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", should be one of "user" or "workspace"':
    'Неподдерживаемая область "{{scope}}", должна быть "user" или "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    'Расширение "{{name}}" отключено для области "{{scope}}"',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    'Расширение "{{name}}" включено для области "{{scope}}"',
  'Do you want to continue? [Y/n]: ': 'Хотите продолжить? [Y/n]: ',
  'Do you want to continue?': 'Хотите продолжить?',
  'Installing extension "{{name}}".': 'Установка расширения "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**Расширения могут вызывать неожиданное поведение. Убедитесь, что вы изучили источник расширения и доверяете автору.**',
  'This extension will run the following MCP servers:':
    'Это расширение запустит следующие MCP-серверы:',
  local: 'локальный',
  remote: 'удалённый',
  'This extension will add the following commands: {{commands}}.':
    'Это расширение добавит следующие команды: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Это расширение добавит информацию в ваш контекст QWEN.md с помощью {{fileName}}',
  'This extension will exclude the following core tools: {{tools}}':
    'Это расширение исключит следующие основные инструменты: {{tools}}',
  'This extension will install the following skills:':
    'Это расширение установит следующие навыки:',
  'This extension will install the following subagents:':
    'Это расширение установит следующие подагенты:',
  'Installation cancelled for "{{name}}".': 'Установка "{{name}}" отменена.',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'Вы устанавливаете расширение от {{originSource}}. Некоторые функции могут работать не идеально с Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref и --auto-update неприменимы для расширений из маркетплейса.',
  'Extension "{{name}}" installed successfully and enabled.':
    'Расширение "{{name}}" успешно установлено и включено.',
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    'Устанавливает расширение из URL Git-репозитория, локального пути или маркетплейса Claude (marketplace-url:plugin-name).',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'URL GitHub, локальный путь или источник в маркетплейсе (marketplace-url:plugin-name) устанавливаемого расширения.',
  'The git ref to install from.': 'Git-ссылка для установки.',
  'Enable auto-update for this extension.':
    'Включить автообновление для этого расширения.',
  'Enable pre-release versions for this extension.':
    'Включить пре-релизные версии для этого расширения.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    'Подтвердить риски безопасности установки расширения и пропустить запрос подтверждения.',
  'The source argument must be provided.':
    'Необходимо указать аргумент источника.',
  'Extension "{{name}}" successfully uninstalled.':
    'Расширение "{{name}}" успешно удалено.',
  'Uninstalls an extension.': 'Удаляет расширение.',
  'The name or source path of the extension to uninstall.':
    'Имя или путь к источнику удаляемого расширения.',
  'Please include the name of the extension to uninstall as a positional argument.':
    'Пожалуйста, укажите имя удаляемого расширения как позиционный аргумент.',
  'Enables an extension.': 'Включает расширение.',
  'The name of the extension to enable.': 'Имя включаемого расширения.',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    'Область для включения расширения. Если не задана, будет включено во всех областях.',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'Расширение "{{name}}" успешно включено для области "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'Расширение "{{name}}" успешно включено во всех областях.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Недопустимая область: {{scope}}. Пожалуйста, используйте одну из {{scopes}}.',
  'Disables an extension.': 'Отключает расширение.',
  'The name of the extension to disable.': 'Имя отключаемого расширения.',
  'The scope to disable the extenison in.':
    'Область для отключения расширения.',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'Расширение "{{name}}" успешно отключено для области "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'Расширение "{{name}}" успешно обновлено: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'Невозможно установить расширение "{{name}}" из-за отсутствия метаданных установки',
  'Extension "{{name}}" is already up to date.':
    'Расширение "{{name}}" уже актуально.',
  'Updates all extensions or a named extension to the latest version.':
    'Обновляет все расширения или указанное расширение до последней версии.',
  'The name of the extension to update.': 'Имя обновляемого расширения.',
  'Update all extensions.': 'Обновить все расширения.',
  'Either an extension name or --all must be provided':
    'Необходимо указать имя расширения или --all',
  'Lists installed extensions.': 'Показывает установленные расширения.',
  'Path:': 'Путь:',
  'Source:': 'Источник:',
  'Type:': 'Тип:',
  'Ref:': 'Ссылка:',
  'Release tag:': 'Тег релиза:',
  'Enabled (User):': 'Включено (Пользователь):',
  'Enabled (Workspace):': 'Включено (Рабочее пространство):',
  'Context files:': 'Контекстные файлы:',
  'Skills:': 'Навыки:',
  'Agents:': 'Агенты:',
  'MCP servers:': 'MCP-серверы:',
  'Link extension failed to install.':
    'Не удалось установить связанное расширение.',
  'Extension "{{name}}" linked successfully and enabled.':
    'Расширение "{{name}}" успешно связано и включено.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'Связывает расширение из локального пути. Изменения в локальном пути будут всегда отражаться.',
  'The name of the extension to link.': 'Имя связываемого расширения.',
  'Set a specific setting for an extension.':
    'Установить конкретную настройку для расширения.',
  'Name of the extension to configure.': 'Имя настраиваемого расширения.',
  'The setting to configure (name or env var).':
    'Настройка для конфигурирования (имя или переменная окружения).',
  'The scope to set the setting in.': 'Область для установки настройки.',
  'List all settings for an extension.': 'Показать все настройки расширения.',
  'Name of the extension.': 'Имя расширения.',
  'Extension "{{name}}" has no settings to configure.':
    'Расширение "{{name}}" не имеет настроек для конфигурирования.',
  'Settings for "{{name}}":': 'Настройки для "{{name}}":',
  '(workspace)': '(рабочее пространство)',
  '(user)': '(пользователь)',
  '[not set]': '[не задано]',
  '[value stored in keychain]': '[значение хранится в связке ключей]',
  'Manage extension settings.': 'Управление настройками расширений.',
  'You need to specify a command (set or list).':
    'Необходимо указать команду (set или list).',
  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.':
    'В этом маркетплейсе нет доступных плагинов.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Выберите плагин для установки из маркетплейса "{{name}}":',
  'Plugin selection cancelled.': 'Выбор плагина отменён.',
  'Select a plugin from "{{name}}"': 'Выберите плагин из "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Используйте ↑↓ или j/k для навигации, Enter для выбора, Escape для отмены',
  '{{count}} more above': 'ещё {{count}} выше',
  '{{count}} more below': 'ещё {{count}} ниже',
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
  'Invalid language. Available: {{options}}':
    'Недопустимый язык. Доступны: {{options}}',
  'Language subcommands do not accept additional arguments.':
    'Подкоманды языка не принимают дополнительных аргументов.',
  'Current UI language: {{lang}}': 'Текущий язык интерфейса: {{lang}}',
  'Current LLM output language: {{lang}}': 'Текущий язык вывода LLM: {{lang}}',
  'LLM output language not set': 'Язык вывода LLM не установлен',
  'Set UI language': 'Установка языка интерфейса',
  'Set LLM output language': 'Установка языка вывода LLM',
  'Usage: /language ui [{{options}}]':
    'Использование: /language ui [{{options}}]',
  'Usage: /language output <language>':
    'Использование: /language output <language>',
  'Example: /language output 中文': 'Пример: /language output 中文',
  'Example: /language output English': 'Пример: /language output English',
  'Example: /language output 日本語': 'Пример: /language output 日本語',
  'Example: /language output Português': 'Пример: /language output Português',
  'UI language changed to {{lang}}': 'Язык интерфейса изменен на {{lang}}',
  'LLM output language set to {{lang}}':
    'Язык вывода LLM установлен на {{lang}}',
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
  'Set UI language to {{name}}': 'Установить язык интерфейса на {{name}}',

  // ============================================================================
  // Команды - Режим подтверждения
  // ============================================================================
  'Tool Approval Mode': 'Режим подтверждения инструментов',
  'Current approval mode: {{mode}}': 'Текущий режим подтверждения: {{mode}}',
  'Available approval modes:': 'Доступные режимы подтверждения:',
  'Approval mode changed to: {{mode}}':
    'Режим подтверждения изменен на: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    'Режим подтверждения изменен на: {{mode}} (сохранено в настройках {{scope}}{{location}})',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Использование: /approval-mode <mode> [--session|--user|--project]',
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
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    'Экспортировать текущий диалог в markdown или json файл. Использование: /chat share <файл>',

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
  'Saved project summary to {{filePathForDisplay}}.':
    'Сводка проекта сохранена в {{filePathForDisplay}}',
  'Saving project summary...': 'Сохранение сводки проекта...',
  'Generating project summary...': 'Генерация сводки проекта...',
  'Failed to generate summary - no text content received from LLM response':
    'Не удалось сгенерировать сводку - не получен текстовый контент из ответа LLM',

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
  'Starting a new session, resetting chat, and clearing terminal.':
    'Начало новой сессии, сброс чата и очистка терминала.',
  'Starting a new session and clearing.': 'Начало новой сессии и очистка.',

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
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'Успешно добавлены файлы QWEN.md из следующих директорий (если они есть):\n- {{directories}}',
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
  'Login with QwenChat account to use daily free quota.':
    'Войдите с помощью аккаунта QwenChat, чтобы использовать ежедневную бесплатную квоту.',
  'API-KEY': 'API-KEY',
  'Use coding plan credentials or your own api-keys/providers.':
    'Используйте учетные данные Coding Plan или свои собственные API-ключи/провайдеры.',
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
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'Отсутствует API-ключ для аутентификации, совместимой с OpenAI. Укажите settings.security.auth.apiKey или переменную окружения {{envKeyHint}}.',
  '{{envKeyHint}} environment variable not found.':
    'Переменная окружения {{envKeyHint}} не найдена.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    'Переменная окружения {{envKeyHint}} не найдена. Укажите её в файле .env или среди системных переменных.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    'Переменная окружения {{envKeyHint}} не найдена (или установите settings.security.auth.apiKey). Укажите её в файле .env или среди системных переменных.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'Отсутствует API-ключ для аутентификации, совместимой с OpenAI. Установите переменную окружения {{envKeyHint}}.',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'У провайдера Anthropic отсутствует обязательный baseUrl в modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    'Переменная окружения ANTHROPIC_BASE_URL не найдена.',
  'Invalid auth method selected.': 'Выбран недопустимый метод авторизации.',
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
  'Current (effective) configuration': 'Текущая (фактическая) конфигурация',
  AuthType: 'Тип авторизации',
  'API Key': 'API-ключ',
  unset: 'не задано',
  '(default)': '(по умолчанию)',
  '(set)': '(установлено)',
  '(not set)': '(не задано)',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "Не удалось переключиться на модель '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.5 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.5 Plus — эффективная гибридная модель с лидирующей производительностью в программировании',
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
  'To continue this session, run': 'Для продолжения этой сессии, выполните',
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
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': 'Миграция формата команд',
  'Found {{count}} TOML command file:': 'Найден {{count}} файл команд TOML:',
  'Found {{count}} TOML command files:':
    'Найдено {{count}} файлов команд TOML:',
  '... and {{count}} more': '... и ещё {{count}}',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'Формат TOML устарел. Хотите перенести их в формат Markdown?',
  '(Backups will be created and original files will be preserved)':
    '(Будут созданы резервные копии, исходные файлы будут сохранены)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...':
    'Ожидание подтверждения от пользователя...',
  '(esc to cancel, {{time}})': '(esc для отмены, {{time}})',

  // ============================================================================

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  WITTY_LOADING_PHRASES: [
    'Мне повезёт!',
    'Доставляем крутизну... ',
    'Рисуем засечки на буквах...',
    'Пробираемся через слизевиков..',
    'Советуемся с цифровыми духами...',
    'Сглаживание сплайнов...',
    'Разогреваем ИИ-хомячков...',
    'Спрашиваем волшебную ракушку...',
    'Генерируем остроумный ответ...',
    'Полируем алгоритмы...',
    'Не торопите совершенство (или мой код)...',
    'Завариваем свежие байты...',
    'Пересчитываем электроны...',
    'Задействуем когнитивные процессоры...',
    'Ищем синтаксические ошибки во вселенной...',
    'Секундочку, оптимизируем юмор...',
    'Перетасовываем панчлайны...',
    'Распутаваем нейросети...',
    'Компилируем гениальность...',
    'Загружаем yumor.exe...',
    'Призываем облако мудрости...',
    'Готовим остроумный ответ...',
    'Секунду, идёт отладка реальности...',
    'Запутываем варианты...',
    'Настраиваем космические частоты...',
    'Создаем ответ, достойный вашего терпения...',
    'Компилируем единички и нолики...',
    'Разрешаем зависимости... и экзистенциальные кризисы...',
    'Дефрагментация памяти... и оперативной, и личной...',
    'Перезагрузка модуля юмора...',
    'Кэшируем самое важное (в основном мемы с котиками)...',
    'Оптимизация для безумной скорости',
    'Меняем биты... только байтам не говорите...',
    'Сборка мусора... скоро вернусь...',
    'Сборка интернетов...',
    'Превращаем кофе в код...',
    'Обновляем синтаксис реальности...',
    'Переподключаем синапсы...',
    'Ищем лишнюю точку с запятой...',
    'Смазываем шестерёнки машины...',
    'Разогреваем серверы...',
    'Калибруем потоковый накопитель...',
    'Включаем двигатель невероятности...',
    'Направляем Силу...',
    'Выравниваем звёзды для оптимального ответа...',
    'Так скажем мы все...',
    'Загрузка следующей великой идеи...',
    'Минутку, я в потоке...',
    'Готовлюсь ослепить вас гениальностью...',
    'Секунду, полирую остроумие...',
    'Держитесь, создаю шедевр...',
    'Мигом, отлаживаю вселенную...',
    'Момент, выравниваю пиксели...',
    'Секунду, оптимизирую юмор...',
    'Момент, настраиваю алгоритмы...',
    'Варп-прыжок активирован...',
    'Добываем кристаллы дилития...',
    'Без паники...',
    'Следуем за белым кроликом...',
    'Истина где-то здесь... внутри...',
    'Продуваем картридж...',
    'Загрузка... Сделай бочку!',
    'Ждем респауна...',
    'Делаем Дугу Кесселя менее чем за 12 парсеков...',
    'Тортик — не ложь, он просто ещё грузится...',
    'Возимся с экраном создания персонажа...',
    'Минутку, ищу подходящий мем...',
    "Нажимаем 'A' для продолжения...",
    'Пасём цифровых котов...',
    'Полируем пиксели...',
    'Ищем подходящий каламбур для экрана загрузки...',
    'Отвлекаем вас этой остроумной фразой...',
    'Почти готово... вроде...',
    'Наши хомячки работают изо всех сил...',
    'Гладим Облачко по голове...',
    'Гладим кота...',
    'Рикроллим начальника...',
    'Never gonna give you up, never gonna let you down...',
    'Лабаем бас-гитару...',
    'Пробуем снузберри на вкус...',
    'Иду до конца, иду на скорость...',
    'Is this the real life? Is this just fantasy?...',
    'У меня хорошее предчувствие...',
    'Дразним медведя... (Не лезь...)',
    'Изучаем свежие мемы...',
    'Думаем, как сделать это остроумнее...',
    'Хмм... дайте подумать...',
    'Как называется бумеранг, который не возвращается? Палка...',
    'Почему компьютер простудился? Потому что оставил окна открытыми...',
    'Почему программисты не любят гулять на улице? Там среда не настроена...',
    'Почему программисты предпочитают тёмную тему? Потому что в темноте не видно багов...',
    'Почему разработчик разорился? Потому что потратил весь свой кэш...',
    'Что можно делать со сломанным карандашом? Ничего — он тупой...',
    'Провожу настройку методом тыка...',
    'Ищем, какой стороной вставлять флешку...',
    'Следим, чтобы волшебный дым не вышел из проводов...',
    'Пытаемся выйти из Vim...',
    'Раскручиваем колесо для хомяка...',
    'Это не баг, а фича...',
    'Поехали!',
    'Я вернусь... с ответом.',
    'Мой другой процесс — это ТАРДИС...',
    'Общаемся с духом машины...',
    'Даем мыслям замариноваться...',
    'Только что вспомнил, куда положил ключи...',
    'Размышляю над сферой...',
    'Я видел такое, что вам, людям, и не снилось... пользователя, читающего эти сообщения.',
    'Инициируем задумчивый взгляд...',
    'Что сервер заказывает в баре? Пинг-коладу.',
    'Почему Java-разработчики не убираются дома? Они ждут сборщик мусора...',
    'Заряжаем лазер... пиу-пиу!',
    'Делим на ноль... шучу!',
    'Ищу взрослых для присмот... в смысле, обрабатываю.',
    'Делаем бип-буп.',
    'Буферизация... даже ИИ нужно время подумать.',
    'Запутываем квантовые частицы для быстрого ответа...',
    'Полируем хром... на алгоритмах.',
    'Вы ещё не развлеклись?! Разве вы не за этим сюда пришли?!',
    'Призываем гремлинов кода... для помощи, конечно же.',
    'Ждем, пока закончится звук dial-up модема...',
    'Перекалибровка юморометра.',
    'Мой другой экран загрузки ещё смешнее.',
    'Кажется, где-то по клавиатуре гуляет кот...',
    'Улучшаем... Ещё улучшаем... Всё ещё грузится.',
    'Это не баг, это фича... экрана загрузки.',
    'Пробовали выключить и включить снова? (Экран загрузки, не меня!)',
    'Нужно построить больше пилонов...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': 'Введите значение...',
  'Enter sensitive value...': 'Введите секретное значение...',
  'Press Enter to submit, Escape to cancel':
    'Нажмите Enter для отправки, Escape для отмены',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Markdown-файл уже существует: {{filename}}',
  'TOML Command Format Deprecation Notice':
    'Уведомление об устаревании формата TOML',
  'Found {{count}} command file(s) in TOML format:':
    'Найдено {{count}} файл(ов) команд в формате TOML:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'Формат TOML для команд устаревает в пользу формата Markdown.',
  'Markdown format is more readable and easier to edit.':
    'Формат Markdown более читаемый и простой для редактирования.',
  'You can migrate these files automatically using:':
    'Вы можете автоматически мигрировать эти файлы с помощью:',
  'Or manually convert each file:': 'Или вручную конвертировать каждый файл:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: YAML frontmatter + содержимое',
  'The migration tool will:': 'Инструмент миграции:',
  'Convert TOML files to Markdown': 'Конвертирует TOML-файлы в Markdown',
  'Create backups of original files': 'Создаёт резервные копии исходных файлов',
  'Preserve all command functionality': 'Сохраняет всю функциональность команд',
  'TOML format will continue to work for now, but migration is recommended.':
    'Формат TOML пока продолжит работать, но миграция рекомендуется.',

  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser':
    'Открыть страницу расширений в браузере',
  'Unknown extensions source: {{source}}.':
    'Неизвестный источник расширений: {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'Страница расширений была бы открыта в браузере: {{url}} (пропущено в тестовой среде)',
  'View available extensions at {{url}}':
    'Посмотреть доступные расширения на {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'Открываем страницу расширений в браузере: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'Не удалось открыть браузер. Посетите галерею расширений по адресу {{url}}',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Вы можете быстро переключать режим разрешений с помощью Shift+Tab или /approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Вы можете быстро переключать режим разрешений с помощью Tab или /approval-mode.',

  // ============================================================================
  // Custom API-KEY Configuration
  // ============================================================================
  'For advanced users who want to configure models manually.':
    'Для продвинутых пользователей, которые хотят настраивать модели вручную.',
  'Please configure your models in settings.json:':
    'Пожалуйста, настройте ваши модели в settings.json:',
  'Set API key via environment variable (e.g., OPENAI_API_KEY)':
    'Установите ключ API через переменную окружения (например, OPENAI_API_KEY)',
  "Add model configuration to modelProviders['openai'] (or other auth types)":
    "Добавьте конфигурацию модели в modelProviders['openai'] (или другие типы аутентификации)",
  'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig':
    'Каждому провайдеру нужны: id, envKey (обязательно), а также опциональные baseUrl, generationConfig',
  'Use /model command to select your preferred model from the configured list':
    'Используйте команду /model, чтобы выбрать предпочитаемую модель из настроенного списка',
  'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.':
    'Поддерживаемые типы аутентификации: openai, anthropic, gemini, vertex-ai и др.',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'Please enter your API key:': 'Пожалуйста, введите ваш API-ключ:',
  'API key cannot be empty.': 'API-ключ не может быть пустым.',
  'You can get your exclusive Coding Plan API-KEY here:':
    'Получите свой эксклюзивный API-KEY Coding Plan здесь:',
  'New model configurations are available for Bailian Coding Plan. Update now?':
    'Доступны новые конфигурации моделей для Bailian Coding Plan. Обновить сейчас?',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Конфигурация Coding Plan успешно обновлена. Новые модели теперь доступны.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'API-ключ Coding Plan не найден. Пожалуйста, повторно авторизуйтесь с Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'Не удалось обновить конфигурацию Coding Plan: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  "Paste your api key of Bailian Coding Plan and you're all set!":
    'Вставьте ваш API-ключ Bailian Coding Plan и всё готово!',
  Custom: 'Пользовательский',
  'More instructions about configuring `modelProviders` manually.':
    'Дополнительные инструкции по ручной настройке `modelProviders`.',
  'Select API-KEY configuration mode:': 'Выберите режим конфигурации API-KEY:',
  '(Press Escape to go back)': '(Нажмите Escape для возврата)',
  '(Press Enter to submit, Escape to cancel)':
    '(Нажмите Enter для отправки, Escape для отмены)',
  'More instructions please check:': 'Дополнительные инструкции см.:',
};
