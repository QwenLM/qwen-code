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
  // Attachment hints
  '↑ to manage attachments': '↑ управление вложениями',
  '← → select, Delete to remove, ↓ to exit':
    '← → выбрать, Delete удалить, ↓ выйти',
  'Attachments: ': 'Вложения: ',
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
  '(shift + tab to cycle)': '(Shift + Tab для переключения)',
  '(tab to cycle)': '(Tab для переключения)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Выполняйте команды терминала через {{symbol}} (например, {{example1}}) или используйте естественный язык (например, {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
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
    'Подключение к MCP servers... ({{connected}}/{{total}})',
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
  'to toggle compact mode': 'переключить компактный режим',

  // ============================================================================
  // Поля системной информации
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Среда выполнения',
  OS: 'ОС',
  Auth: 'Аутентификация',
  Model: 'Модель',
  'Fast Model': 'Быстрая модель',
  Sandbox: 'Песочница',
  'Session ID': 'ID сессии',
  'Base URL': 'Base URL',
  Proxy: 'Прокси',
  'Memory Usage': 'Использование памяти',
  'IDE Client': 'Клиент IDE',

  // ============================================================================
  // Команды - Общие
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Анализ проекта и создание адаптированного файла QWEN.md',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'Просмотр доступных инструментов Qwen Code. Использование: /tools [desc]',
  'List available skills.': 'Показать доступные навыки.',
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
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    'Показать фоновые задачи (текстовый вывод; интерактивный диалог открывается через плашку внизу экрана)',
  'Delete a previous session': 'Удалить предыдущую сессию',
  'Run installation and environment diagnostics':
    'Запустить диагностику установки и окружения',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    'Просмотреть динамические каталоги моделей и выбрать, какие модели оставить включёнными локально',
  'Generate a one-line session recap now':
    'Сейчас создать однострочное резюме сессии',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    'Переименовать текущий разговор. --auto позволит быстрой модели выбрать заголовок.',
  'Rewind conversation to a previous turn':
    'Откатить разговор к предыдущему ходу',
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
  'Enter to submit, Esc to go back': 'Enter для отправки, Esc для возврата',
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
    'Все инструменты выбраны, включая MCP tools',
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
  // ============================================================================
  // Метки настроек
  // ============================================================================
  'Vim Mode': 'Режим Vim',
  'Attribution: commit': 'Атрибуция: коммит',
  'Terminal Bell Notification': 'Звуковое уведомление терминала',
  'Enable Usage Statistics': 'Включить сбор статистики использования',
  Theme: 'Тема',
  'Preferred Editor': 'Предпочтительный редактор',
  'Auto-connect to IDE': 'Автоподключение к IDE',
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
  'Screen Reader Mode': 'Режим программы чтения с экрана',
  'Max Session Turns': 'Макс. количество ходов сессии',
  'Skip Next Speaker Check': 'Пропустить проверку следующего говорящего',
  'Skip Loop Detection': 'Пропустить обнаружение циклов',
  'Skip Startup Context': 'Пропустить начальный контекст',
  'Enable OpenAI Logging': 'Включить логирование OpenAI',
  'OpenAI Logging Directory': 'Директория логов OpenAI',
  Timeout: 'Таймаут',
  'Max Retries': 'Макс. количество попыток',
  'Load Memory From Include Directories':
    'Загружать память из включенных директорий',
  'Respect .gitignore': 'Учитывать .gitignore',
  'Respect .qwenignore': 'Учитывать .qwenignore',
  'Enable Recursive File Search': 'Включить рекурсивный поиск файлов',
  'Interactive Shell (PTY)': 'Интерактивный терминал (PTY)',
  'Show Color': 'Показывать цвета',
  'Auto Accept': 'Автоподтверждение',
  'Use Ripgrep': 'Использовать Ripgrep',
  'Use Builtin Ripgrep': 'Использовать встроенный Ripgrep',
  'Tool Output Truncation Threshold': 'Порог обрезки вывода инструментов',
  'Tool Output Truncation Lines': 'Лимит строк вывода инструментов',
  'Folder Trust': 'Доверие к папке',
  'Tool Schema Compliance': 'Соответствие Tool Schema',
  // Варианты перечислений настроек
  'Auto (detect from system)': 'Авто (определить из системы)',
  'Auto (detect terminal theme)': 'Авто (определить тему терминала)',
  Auto: 'Авто',
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
  'Manage installed extensions': 'Управлять установленными расширениями',
  'Disable an extension': 'Отключить расширение',
  'Enable an extension': 'Включить расширение',
  'Install an extension from a git repo or local path':
    'Установить расширение из Git-репозитория или локального пути',
  'Uninstall an extension': 'Удалить расширение',
  'No extensions installed.': 'Расширения не установлены.',
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
  'Do you want to continue? [Y/n]: ': 'Хотите продолжить? [Y/n]: ',
  'Do you want to continue?': 'Хотите продолжить?',
  'Installing extension "{{name}}".': 'Установка расширения "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**Расширения могут вызывать неожиданное поведение. Убедитесь, что вы изучили источник расширения и доверяете автору.**',
  'This extension will run the following MCP servers:':
    'Это расширение запустит следующие MCP servers:',
  local: 'локальный',
  remote: 'удалённый',
  'This extension will add the following commands: {{commands}}.':
    'Это расширение добавит следующие команды: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'Это расширение добавит информацию в ваш контекст QWEN.md с помощью {{fileName}}',
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
  'MCP servers:': 'MCP servers:',
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
  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Управлять хуками Qwen Code',
  'List all configured hooks': 'Показать все настроенные хуки',
  // Hooks - Dialog
  Hooks: 'Хуки',
  'Loading hooks...': 'Загрузка хуков...',
  'Error loading hooks:': 'Ошибка загрузки хуков:',
  'Press Escape to close': 'Нажмите Escape для закрытия',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Нажмите Escape, Ctrl+C или Ctrl+D для отмены',
  'Press Space, Enter, or Escape to dismiss':
    'Нажмите Space, Enter или Escape для закрытия',
  'No hook selected': 'Хук не выбран',
  // Hooks - List Step
  'No hook events found.': 'События хуков не найдены.',
  '{{count}} hook configured': '{{count}} хук настроен',
  '{{count}} hooks configured': '{{count}} хуков настроено',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'Это меню только для чтения. Чтобы добавить или изменить хуки, отредактируйте settings.json напрямую или спросите Qwen Code.',
  'Enter to select · Esc to cancel': 'Enter для выбора · Esc для отмены',
  // Hooks - Detail Step
  'Exit codes:': 'Коды выхода:',
  'Configured hooks:': 'Настроенные хуки:',
  'No hooks configured for this event.':
    'Для этого события нет настроенных хуков.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'Чтобы добавить хуки, отредактируйте settings.json напрямую или спросите Qwen.',
  'Enter to select · Esc to go back': 'Enter для выбора · Esc для возврата',
  // Hooks - Config Detail Step
  'Hook details': 'Детали хука',
  'Event:': 'Событие:',
  'Extension:': 'Расширение:',
  'Desc:': 'Описание:',
  'No hook config selected': 'Конфигурация хука не выбрана',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'Чтобы изменить или удалить этот хук, отредактируйте settings.json напрямую или спросите Qwen.',
  // Hooks - Disabled Step
  'Hook Configuration - Disabled': 'Конфигурация хуков - Отключено',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'Все хуки в данный момент отключены. У вас {{count}} не выполняются.',
  '{{count}} configured hook': '{{count}} настроенный хук',
  '{{count}} configured hooks': '{{count}} настроенных хуков',
  'When hooks are disabled:': 'Когда хуки отключены:',
  'No hook commands will execute': 'Никакие команды хуков не будут выполняться',
  'StatusLine will not be displayed': 'StatusLine не будет отображаться',
  'Tool operations will proceed without hook validation':
    'Операции инструментов будут выполняться без проверки хуков',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'Чтобы снова включить хуки, удалите "disableAllHooks" из settings.json или спросите Qwen Code.',
  // Hooks - Source
  Project: 'Проект',
  User: 'Пользователь',
  Skill: 'Навык',
  System: 'Система',
  Extension: 'Расширение',
  'Local Settings': 'Локальные настройки',
  'User Settings': 'Пользовательские настройки',
  'System Settings': 'Системные настройки',
  Extensions: 'Расширения',
  'Session (temporary)': 'Сессия (временно)',
  // Hooks - Event Descriptions (short)
  'Before tool execution': 'Перед выполнением инструмента',
  'After tool execution': 'После выполнения инструмента',
  'After tool execution fails': 'При неудачном выполнении инструмента',
  'When notifications are sent': 'При отправке уведомлений',
  'When the user submits a prompt': 'Когда пользователь отправляет промпт',
  'When a new session is started': 'При запуске новой сессии',
  'Right before Qwen Code concludes its response':
    'Непосредственно перед завершением ответа Qwen Code',
  'When a subagent (Agent tool call) is started':
    'При запуске субагента (вызов инструмента Agent)',
  'Right before a subagent concludes its response':
    'Непосредственно перед завершением ответа субагента',
  'Before conversation compaction': 'Перед сжатием разговора',
  'When a session is ending': 'При завершении сессии',
  'When a permission dialog is displayed': 'При отображении диалога разрешений',
  'When a new todo item is created': 'При создании новой задачи',
  'When a todo item is marked as completed':
    'При отметке задачи как выполненной',
  // Hooks - Event Descriptions (detailed)
  'Input to command is JSON of tool call arguments.':
    'Ввод в команду — это JSON аргументов вызова инструмента.',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'Ввод в команду — это JSON с полями "inputs" (аргументы вызова инструмента) и "response" (ответ вызова инструмента).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'Ввод в команду — это JSON с tool_name, tool_input, tool_use_id, error, error_type, is_interrupt и is_timeout.',
  'Input to command is JSON with notification message and type.':
    'Ввод в команду — это JSON с сообщением уведомления и типом.',
  'Input to command is JSON with original user prompt text.':
    'Ввод в команду — это JSON с исходным текстом промпта пользователя.',
  'Input to command is JSON with session start source.':
    'Ввод в команду — это JSON с источником запуска сессии.',
  'Input to command is JSON with session end reason.':
    'Ввод в команду — это JSON с причиной завершения сессии.',
  'Input to command is JSON with agent_id and agent_type.':
    'Ввод в команду — это JSON с agent_id и agent_type.',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    'Ввод в команду — это JSON с agent_id, agent_type и agent_transcript_path.',
  'Input to command is JSON with compaction details.':
    'Ввод в команду — это JSON с деталями сжатия.',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    'Ввод в команду — это JSON с tool_name, tool_input и tool_use_id. Вывод — JSON с hookSpecificOutput, содержащим решение о разрешении или отказе.',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'Ввод в команду — это JSON с todo_id, todo_content, todo_status, all_todos и phase. В validation вывод — JSON с decision (allow/block/deny) и reason. В postWrite block/deny игнорируется.',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'Ввод в команду — это JSON с todo_id, todo_content, previous_status, all_todos и phase. В validation вывод — JSON с decision (allow/block/deny) и reason. В postWrite block/deny игнорируется.',
  // Hooks - Exit Code Descriptions
  'stdout/stderr not shown': 'stdout/stderr не отображаются',
  'show stderr to model and continue conversation':
    'показать stderr модели и продолжить разговор',
  'show stderr to user only': 'показать stderr только пользователю',
  'stdout shown in transcript mode (ctrl+o)':
    'stdout отображается в режиме транскрипции (ctrl+o)',
  'show stderr to model immediately': 'показать stderr модели немедленно',
  'show stderr to user only but continue with tool call':
    'показать stderr только пользователю, но продолжить вызов инструмента',
  'block processing, erase original prompt, and show stderr to user only':
    'заблокировать обработку, стереть исходный промпт и показать stderr только пользователю',
  'stdout shown to Qwen': 'stdout показан Qwen',
  'show stderr to user only (blocking errors ignored)':
    'показать stderr только пользователю (блокирующие ошибки игнорируются)',
  'command completes successfully': 'команда успешно завершена',
  'stdout shown to subagent': 'stdout показан субагенту',
  'show stderr to subagent and continue having it run':
    'показать stderr субагенту и продолжить его выполнение',
  'stdout appended as custom compact instructions':
    'stdout добавлен как пользовательские инструкции сжатия',
  'block compaction': 'заблокировать сжатие',
  'show stderr to user only but continue with compaction':
    'показать stderr только пользователю, но продолжить сжатие',
  'use hook decision if provided':
    'использовать решение хука, если предоставлено',
  'allow todo creation': 'разрешить создание задачи',
  'block todo creation and show reason to model':
    'заблокировать создание задачи и показать причину модели',
  'allow todo completion': 'разрешить выполнение задачи',
  'block todo completion and show reason to model':
    'заблокировать выполнение задачи и показать причину модели',
  // Hooks - Messages
  'Config not loaded.': 'Конфигурация не загружена.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Хуки не включены. Включите хуки в настройках, чтобы использовать эту функцию.',
  // ============================================================================
  // Commands - Session Export
  // ============================================================================
  'Export current session message history to a file':
    'Экспортировать историю сообщений текущей сессии в файл',
  'Export session to HTML format': 'Экспортировать сессию в формат HTML',
  'Export session to JSON format': 'Экспортировать сессию в формат JSON',
  'Export session to JSONL format (one message per line)':
    'Экспортировать сессию в формат JSONL (одно сообщение на строку)',
  'Export session to markdown format':
    'Экспортировать сессию в формат Markdown',

  // ============================================================================
  // Commands - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    'Создать персонализированные инсайты по программированию на основе истории чата',

  // ============================================================================
  // Commands - Session History
  // ============================================================================
  'Resume a previous session': 'Продолжить предыдущую сессию',
  'Fork the current conversation into a new session':
    'Создать ветку текущего разговора в новой сессии',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    'Нельзя создать ветку, пока выполняется ответ или вызов инструмента. Дождитесь завершения или обработайте ожидающий вызов инструмента.',
  'No conversation to branch.': 'Нет разговора для создания ветки.',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    'Восстановить вызов инструмента. Это вернет историю разговора и файлов к состоянию на момент, когда был предложен этот вызов инструмента',
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
  'Set UI language': 'Установка языка интерфейса',
  'Set LLM output language': 'Установка языка вывода LLM',
  'Usage: /language ui [{{options}}]':
    'Использование: /language ui [{{options}}]',
  'Usage: /language output <language>':
    'Использование: /language output <language>',
  'Example: /language output 中文': 'Пример: /language output 中文',
  'Example: /language output English': 'Пример: /language output English',
  'Example: /language output 日本語': 'Пример: /language output 日本語',
  'UI language changed to {{lang}}': 'Язык интерфейса изменен на {{lang}}',
  'LLM output language set to {{lang}}':
    'Язык вывода LLM установлен на {{lang}}',
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
  '{{mode}} mode': 'Режим {{mode}}',
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
  'Workspace Settings': 'Настройки рабочего пространства',
  'Open auto-memory folder': 'Открыть папку автопамяти',
  'Auto-memory: {{status}}': 'Автопамять: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    'Автоконсолидация: {{status}} · {{lastDream}} · /dream для запуска',
  never: 'никогда',
  on: 'вкл',
  off: 'выкл',
  'Remove matching entries from managed auto-memory.':
    'Удалить совпадающие записи из управляемой автопамяти.',
  'Usage: /forget <memory text to remove>':
    'Использование: /forget <текст воспоминания для удаления>',
  'No managed auto-memory entries matched: {{query}}':
    'Не найдено совпадающих записей автопамяти: {{query}}',
  'Consolidate managed auto-memory topic files.':
    'Консолидировать файлы тем управляемой автопамяти.',
  'Could not retrieve tool registry.':
    'Не удалось получить реестр инструментов.',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Успешно авторизовано и обновлены инструменты для '{{name}}'.",
  "Re-discovering tools from '{{name}}'...":
    "Повторное обнаружение инструментов от '{{name}}'...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "Обнаружено {{count}} инструмент(ов) от '{{name}}'.",
  'Authentication complete. Returning to server details...':
    'Аутентификация завершена. Возврат к деталям сервера...',
  'Authentication successful.': 'Аутентификация успешна.',
  // =========================================================
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
  'Processing summary...': 'Обработка сводки...',
  'Project summary generated and saved successfully!':
    'Сводка проекта успешно создана и сохранена!',
  'Saved to: {{filePath}}': 'Сохранено в: {{filePath}}',
  'Stopped because': 'Остановлено, потому что',
  'Failed to generate summary - no text content received from LLM response':
    'Не удалось сгенерировать сводку - не получен текстовый контент из ответа LLM',

  // ============================================================================
  // Команды - Модель
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'Переключение модели для этой сессии (--fast для модели подсказок)',
  'Set a lighter model for prompt suggestions and speculative execution':
    'Установить облегчённую модель для подсказок и спекулятивного выполнения',
  'Content generator configuration not available.':
    'Конфигурация генератора содержимого недоступна.',
  'Authentication type not available.': 'Тип авторизации недоступен.',
  'No models available for the current authentication type ({{authType}}).':
    'Нет доступных моделей для текущего типа авторизации ({{authType}}).',
  // Needs translation

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
  Yes: 'Да',
  No: 'Нет',
  'No (esc)': 'Нет (esc)',
  // MCP Management - Core translations
  Disable: 'Отключить',
  Enable: 'Включить',
  Authenticate: 'Аутентификация',
  'Re-authenticate': 'Повторная аутентификация',
  'Clear Authentication': 'Очистить аутентификацию',
  disabled: 'отключен',
  enabled: 'включен',
  'Server:': 'Сервер:',
  Reconnect: 'Переподключить',
  'View tools': 'Просмотреть инструменты',
  'Error:': 'Ошибка:',
  tool: 'инструмент',
  connected: 'подключен',
  connecting: 'подключение',
  disconnected: 'отключен',
  error: 'ошибка',
  // Invalid tool related translations
  '{{count}} invalid tools': '{{count}} недействительных инструментов',
  invalid: 'недействительный',
  'invalid: {{reason}}': 'недействительно: {{reason}}',
  'missing name': 'отсутствует имя',
  'missing description': 'отсутствует описание',
  '(unnamed)': '(без имени)',
  'Warning: This tool cannot be called by the LLM':
    'Предупреждение: Этот инструмент не может быть вызван LLM',
  Reason: 'Причина',
  'Tools must have both name and description to be used by the LLM.':
    'Инструменты должны иметь как имя, так и описание, чтобы использоваться LLM.',
  'Modify in progress:': 'Идет изменение:',
  'Save and close external editor to continue':
    'Сохраните и закройте внешний редактор для продолжения',
  'Apply this change?': 'Применить это изменение?',
  'Yes, allow always': 'Да, всегда разрешать',
  'Modify with external editor': 'Изменить во внешнем редакторе',
  'No, suggest changes (esc)': 'Нет, предложить изменения (esc)',
  "Allow execution of: '{{command}}'?": "Разрешить выполнение: '{{command}}'?",
  'Always allow in this project': 'Всегда разрешать в этом проекте',
  'Always allow {{action}} in this project':
    'Всегда разрешать {{action}} в этом проекте',
  'Always allow for this user': 'Всегда разрешать для этого пользователя',
  'Always allow {{action}} for this user':
    'Всегда разрешать {{action}} для этого пользователя',
  'Yes, restore previous mode ({{mode}})':
    'Да, восстановить предыдущий режим ({{mode}})',
  'Yes, and auto-accept edits': 'Да, и автоматически принимать правки',
  'Yes, and manually approve edits': 'Да, и вручную подтверждать правки',
  'No, keep planning (esc)': 'Нет, продолжить планирование (esc)',
  'URLs to fetch:': 'URL для загрузки:',
  'MCP Server: {{server}}': 'MCP Server: {{server}}',
  'Tool: {{tool}}': 'Инструмент: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Разрешить выполнение MCP tool "{{tool}}" с MCP server "{{server}}"?',
  // ============================================================================
  // Диалоги - Подтверждение оболочки
  // ============================================================================
  'Shell Command Execution': 'Выполнение команды терминала',
  'A custom command wants to run the following shell commands:':
    'Пользовательская команда хочет выполнить следующие команды терминала:',
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
  'Select Authentication Method': 'Выберите метод авторизации',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'Вы должны выбрать метод авторизации для продолжения. Нажмите Ctrl+C снова для выхода.',
  'Terms of Services and Privacy Notice':
    'Условия обслуживания и уведомление о конфиденциальности',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    'Прекращено — переключитесь на Coding Plan или API Key',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Бесплатный уровень Qwen OAuth прекращён 2026-04-15. Выберите Coding Plan или API Key.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Бесплатный уровень Qwen OAuth был прекращен 2026-04-15. Пожалуйста, выберите модель от другого провайдера или выполните /auth для переключения.',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Бесплатный уровень Qwen OAuth прекращён 2026-04-15. Выберите другую опцию.\n',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    'Платно \u00B7 До 6 000 запросов/5 часов \u00B7 Все модели Alibaba Cloud Coding Plan',
  'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
  'Bring your own API key': 'Используйте свой API Key',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    'Браузерная аутентификация с использованием сторонних провайдеров (например, OpenRouter, ModelScope)',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'Авторизация должна быть {{enforcedType}}, но вы сейчас используете {{currentType}}.',
  'Qwen OAuth Authentication': 'Авторизация Qwen OAuth',
  'Please visit this URL to authorize:':
    'Пожалуйста, посетите этот URL для авторизации:',
  'Waiting for authorization': 'Ожидание авторизации',
  'Time remaining:': 'Осталось времени:',
  'Qwen OAuth Authentication Timeout': 'Таймаут авторизации Qwen OAuth',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'Токен OAuth истек (более {{seconds}} секунд). Пожалуйста, выберите метод авторизации снова.',
  'Press any key to return to authentication type selection.':
    'Нажмите любую клавишу для возврата к выбору типа авторизации.',
  'Waiting for Qwen OAuth authentication...':
    'Ожидание авторизации Qwen OAuth...',
  'Authentication timed out. Please try again.':
    'Время ожидания авторизации истекло. Пожалуйста, попробуйте снова.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Ожидание авторизации... (Нажмите ESC или CTRL+C для отмены)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'Отсутствует API Key для аутентификации, совместимой с OpenAI. Укажите settings.security.auth.apiKey или переменную окружения {{envKeyHint}}.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    'Переменная окружения {{envKeyHint}} не найдена. Укажите её в файле .env или среди системных переменных.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    'Переменная окружения {{envKeyHint}} не найдена (или установите settings.security.auth.apiKey). Укажите её в файле .env или среди системных переменных.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'Отсутствует API Key для аутентификации, совместимой с OpenAI. Установите переменную окружения {{envKeyHint}}.',
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
  // ============================================================================
  // Диалоги - Модель
  // ============================================================================
  'Select Model': 'Выбрать модель',
  'API Key': 'API Key',
  '(default)': '(по умолчанию)',
  '(not set)': '(не задано)',
  Modality: 'Модальность',
  'Context Window': 'Контекстное окно',
  text: 'текст',
  'text-only': 'только текст',
  image: 'изображение',
  pdf: 'PDF',
  audio: 'аудио',
  video: 'видео',
  'not set': 'не задано',
  none: 'нет',
  unknown: 'неизвестно',
  // ============================================================================
  // Диалоги - Разрешения
  // ============================================================================
  'Manage folder trust settings': 'Управление настройками доверия к папкам',
  'Manage permission rules': 'Управление permission rules',
  Allow: 'Разрешить',
  Ask: 'Спросить',
  Deny: 'Запретить',
  Workspace: 'Рабочая область',
  "Qwen Code won't ask before using allowed tools.":
    'Qwen Code не будет спрашивать перед использованием разрешённых инструментов.',
  'Qwen Code will ask before using these tools.':
    'Qwen Code спросит перед использованием этих инструментов.',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code не может использовать запрещённые инструменты.',
  'Manage trusted directories for this workspace.':
    'Управление доверенными каталогами для этой рабочей области.',
  'Any use of the {{tool}} tool': 'Любое использование инструмента {{tool}}',
  "{{tool}} commands matching '{{pattern}}'":
    "Команды {{tool}}, соответствующие '{{pattern}}'",
  'From user settings': 'Из пользовательских настроек',
  'From project settings': 'Из настроек проекта',
  'From session': 'Из сессии',
  'Project settings': 'Настройки проекта',
  'Checked in at .qwen/settings.json': 'Зафиксировано в .qwen/settings.json',
  'User settings': 'Пользовательские настройки',
  'Saved in at ~/.qwen/settings.json': 'Сохранено в ~/.qwen/settings.json',
  'Add a new rule…': 'Добавить новое правило…',
  'Add {{type}} permission rule': 'Добавить {{type}} permission rule',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'permission rules — это имя инструмента, за которым может следовать спецификатор в скобках.',
  'e.g.,': 'напр.',
  or: 'или',
  'Enter permission rule…': 'Введите permission rule…',
  'Enter to submit · Esc to cancel': 'Enter для отправки · Esc для отмены',
  'Where should this rule be saved?': 'Где сохранить это правило?',
  'Enter to confirm · Esc to cancel':
    'Enter для подтверждения · Esc для отмены',
  'Delete {{type}} rule?': 'Удалить правило {{type}}?',
  'Are you sure you want to delete this permission rule?':
    'Вы уверены, что хотите удалить это permission rule?',
  'Permissions:': 'Разрешения:',
  '(←/→ or tab to cycle)': '(←/→ или Tab для переключения)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    '↑↓ навигация · Enter выбор · Ввод для поиска · Esc отмена',
  'Search…': 'Поиск…',
  // Workspace directory management
  'Add directory…': 'Добавить каталог…',
  'Add directory to workspace': 'Добавить каталог в рабочую область',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code может читать файлы в рабочей области и вносить правки, когда автоприём правок включён.',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code сможет читать файлы в этом каталоге и вносить правки, когда автоприём правок включён.',
  'Enter the path to the directory:': 'Введите путь к каталогу:',
  'Enter directory path…': 'Введите путь к каталогу…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab для завершения · Enter для добавления · Esc для отмены',
  'Remove directory?': 'Удалить каталог?',
  'Are you sure you want to remove this directory from the workspace?':
    'Вы уверены, что хотите удалить этот каталог из рабочей области?',
  '  (Original working directory)': '  (Исходный рабочий каталог)',
  '  (from settings)': '  (из настроек)',
  'Directory does not exist.': 'Каталог не существует.',
  'Path is not a directory.': 'Путь не является каталогом.',
  'This directory is already in the workspace.':
    'Этот каталог уже есть в рабочей области.',
  'Already covered by existing directory: {{dir}}':
    'Уже охвачен существующим каталогом: {{dir}}',

  // ============================================================================
  // Строка состояния
  // ============================================================================
  'Using:': 'Используется:',
  '{{count}} open file': '{{count}} открытый файл',
  '{{count}} open files': '{{count}} открытых файла(ов)',
  '(ctrl+g to view)': '(ctrl+g для просмотра)',
  '{{count}} {{name}} file': '{{count}} файл {{name}}',
  '{{count}} {{name}} files': '{{count}} файла(ов) {{name}}',
  '{{count}} MCP server': '{{count}} MCP server',
  '{{count}} MCP servers': '{{count}} MCP servers',
  '{{count}} Blocked': '{{count}} заблокирован(о)',
  '(ctrl+t to view)': '(ctrl+t для просмотра)',
  '(ctrl+t to toggle)': '(ctrl+t для переключения)',
  'Press Ctrl+C again to exit.': 'Нажмите Ctrl+C снова для выхода.',
  'Press Ctrl+D again to exit.': 'Нажмите Ctrl+D снова для выхода.',
  'Press Esc again to clear.': 'Нажмите Esc снова для очистки.',
  'Press ↑ to edit queued messages':
    'Нажмите ↑ для редактирования сообщений в очереди',

  // ============================================================================
  // Статус MCP
  // ============================================================================
  'No MCP servers configured.': 'MCP servers не настроены.',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers запускаются ({{count}} инициализируется)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Примечание: Первый запуск может занять больше времени. Доступность инструментов обновится автоматически.',
  'Configured MCP servers:': 'Настроенные MCP servers:',
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
  'to show tool parameter schemas': 'для показа tool parameter schemas',
  'to hide descriptions': 'для скрытия описаний',
  'to authenticate with OAuth-enabled servers':
    'для авторизации на серверах с поддержкой OAuth',
  Press: 'Нажмите',
  'to toggle tool descriptions on/off':
    'для переключения описаний инструментов',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Начало авторизации OAuth для MCP server '{{name}}'...",
  // ============================================================================
  // Подсказки при запуске
  // ============================================================================

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
  'Current tasks': 'Текущие задачи',
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
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'Используйте /compress, когда разговор становится длинным, чтобы подвести итог и освободить контекст.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'Начните новую идею с /clear или /new; предыдущая сессия останется в истории.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Используйте /bug, чтобы сообщить о проблемах разработчикам.',
  'Switch auth type quickly with /auth.':
    'Быстро переключите тип аутентификации с помощью /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Вы можете выполнять любые shell-команды в Qwen Code с помощью ! (например, !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'Введите /, чтобы открыть меню команд; Tab автодополняет слэш-команды и сохранённые промпты.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'Вы можете продолжить предыдущий разговор, запустив qwen --continue или qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Вы можете быстро переключать режим разрешений с помощью Shift+Tab или /approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Вы можете быстро переключать режим разрешений с помощью Tab или /approval-mode.',
  'Try /insight to generate personalized insights from your chat history.':
    'Попробуйте /insight, чтобы получить персонализированные выводы из истории чатов.',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    'Нажмите Ctrl+O для переключения компактного режима — скрыть вывод инструментов и рассуждения.',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'Добавьте файл QWEN.md, чтобы предоставить Qwen Code постоянный контекст проекта.',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    'Используйте /btw, чтобы задать короткий побочный вопрос, не прерывая основной разговор.',
  'Context is almost full! Run /compress now or start /new to continue.':
    'Контекст почти заполнен! Выполните /compress сейчас или начните /new, чтобы продолжить.',
  'Context is getting full. Use /compress to free up space.':
    'Контекст заполняется. Используйте /compress, чтобы освободить место.',
  'Long conversation? /compress summarizes history to free context.':
    'Долгий разговор? /compress подведёт итог истории, чтобы освободить контекст.',

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'Вы можете настроить API Key и модели в settings.json',
  'Refer to the documentation for setup instructions':
    'Инструкции по настройке см. в документации',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'API Key не может быть пустым.',
  'You can get your Coding Plan API key here':
    'Вы можете получить API Key Coding Plan здесь',
  'Failed to update Coding Plan configuration: {{message}}':
    'Не удалось обновить конфигурацию Coding Plan: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  Custom: 'Пользовательский',
  'Select Region for Coding Plan': 'Выберите регион Coding Plan',
  'Choose based on where your account is registered':
    'Выберите в зависимости от места регистрации вашего аккаунта',
  'Enter Coding Plan API Key': 'Введите API Key Coding Plan',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'Доступны новые конфигурации моделей для {{region}}. Обновить сейчас?',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    'Конфигурация {{region}} успешно обновлена. Модель переключена на "{{model}}".',
  // ============================================================================
  // Context Usage Component
  // ============================================================================
  'Context Usage': 'Использование контекста',
  '% used': '% использовано',
  '% context used': '% контекста использовано',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'Контекст превышает лимит! Используйте /compress или /clear для уменьшения.',
  'No API response yet. Send a message to see actual usage.':
    'Пока нет ответа от API. Отправьте сообщение, чтобы увидеть фактическое использование.',
  'Estimated pre-conversation overhead':
    'Оценочные накладные расходы перед беседой',
  'Context window': 'Контекстное окно',
  tokens: 'токенов',
  Used: 'Использовано',
  Free: 'Свободно',
  'Autocompact buffer': 'Буфер автоупаковки',
  'Usage by category': 'Использование по категориям',
  'System prompt': 'Системная подсказка',
  'Built-in tools': 'Встроенные инструменты',
  'MCP tools': 'MCP tools',
  'Memory files': 'Файлы памяти',
  Skills: 'Навыки',
  Messages: 'Сообщения',
  'Run /context detail for per-item breakdown.':
    'Выполните /context detail для детализации по элементам.',
  active: 'активно',
  'body loaded': 'содержимое загружено',
  memory: 'память',
  'Server Detail': 'Детали сервера',
  'Tool Detail': 'Детали инструмента',
  'Loading...': 'Загрузка...',
  'Unknown step': 'Неизвестный шаг',
  'Esc to back': 'Esc для возврата',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ навигация · Enter выбрать · Esc закрыть',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ навигация · Enter выбрать · Esc назад',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ навигация · Enter подтвердить · Esc назад',
  'User Settings (global)': 'Настройки пользователя (глобальные)',
  'Workspace Settings (project-specific)':
    'Настройки рабочего пространства (проектные)',
  'Disable server:': 'Отключить сервер:',
  'Select where to add the server to the exclude list:':
    'Выберите, где добавить сервер в список исключений:',
  'Press Enter to confirm, Esc to cancel':
    'Enter для подтверждения, Esc для отмены',
  'Status:': 'Статус:',
  'Command:': 'Команда:',
  'Working Directory:': 'Рабочий каталог:',
  'No server selected': 'Сервер не выбран',

  // MCP Server List
  'User MCPs': 'MCP пользователя',
  'Project MCPs': 'MCP проекта',
  'Extension MCPs': 'MCP расширений',
  server: 'сервер',
  servers: 'серверов',
  'Add MCP servers to your settings to get started.':
    'Добавьте MCP servers в настройки, чтобы начать.',
  'Run qwen --debug to see error logs':
    'Запустите qwen --debug для просмотра журналов ошибок',

  // MCP OAuth Authentication
  'OAuth Authentication': 'OAuth-аутентификация',
  'Authenticating... Please complete the login in your browser.':
    'Аутентификация... Пожалуйста, завершите вход в браузере.',
  // MCP Tool List
  'No tools available for this server.':
    'Для этого сервера нет доступных инструментов.',
  destructive: 'деструктивный',
  'read-only': 'только чтение',
  'open-world': 'открытый мир',
  idempotent: 'идемпотентный',
  'Tools for {{serverName}}': 'Инструменты для {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',

  // MCP Tool Detail
  required: 'обязательный',
  Parameters: 'Параметры',
  'No tool selected': 'Инструмент не выбран',
  Server: 'Сервер',
  '{{region}} configuration updated successfully.':
    'Конфигурация {{region}} успешно обновлена.',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    'Успешная аутентификация с {{region}}. API Key и конфигурации моделей сохранены в settings.json.',
  'Tip: Use /model to switch between available Coding Plan models.':
    'Совет: Используйте /model для переключения между доступными моделями Coding Plan.',
  'Type something...': 'Введите что-то...',
  Submit: 'Отправить',
  'Submit answers': 'Отправить ответы',
  Cancel: 'Отмена',
  'Your answers:': 'Ваши ответы:',
  '(not answered)': '(не отвечено)',
  'Ready to submit your answers?': 'Готовы отправить свои ответы?',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: Навигация | ←/→: Переключение вкладок | Enter: Выбор',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: Навигация | Enter: Выбор | Esc: Отмена',
  'Authenticate using Qwen OAuth': 'Аутентификация через Qwen OAuth',
  'Authenticate using Alibaba Cloud Coding Plan':
    'Аутентификация через Alibaba Cloud Coding Plan',
  'Region for Coding Plan (china/global)':
    'Регион для Coding Plan (china/global)',
  'API key for Coding Plan': 'API Key для Coding Plan',
  'Show current authentication status':
    'Показать текущий статус аутентификации',
  'Authentication completed successfully.': 'Аутентификация успешно завершена.',
  'Starting Qwen OAuth authentication...':
    'Запуск аутентификации Qwen OAuth...',
  'Successfully authenticated with Qwen OAuth.':
    'Успешная аутентификация через Qwen OAuth.',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Ошибка аутентификации через Qwen OAuth: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'Обработка аутентификации Alibaba Cloud Coding Plan...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'Успешная аутентификация через Alibaba Cloud Coding Plan.',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Ошибка аутентификации через Coding Plan: {{error}}',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'Глобальный',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Выберите регион для Coding Plan:',
  'Enter your Coding Plan API key: ': 'Введите ваш API Key Coding Plan: ',
  'Select authentication method:': 'Выберите метод аутентификации:',
  '\n=== Authentication Status ===\n': '\n=== Статус аутентификации ===\n',
  '⚠️  No authentication method configured.\n':
    '⚠️  Метод аутентификации не настроен.\n',
  'Run one of the following commands to get started:\n':
    'Выполните одну из следующих команд для начала:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - Аутентификация через Qwen OAuth (прекращено)',
  'Or simply run:': 'Или просто выполните:',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - Интерактивная настройка аутентификации\n',
  '✓ Authentication Method: Qwen OAuth': '✓ Метод аутентификации: Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  Тип: Бесплатный уровень (прекращено 2026-04-15)',
  '  Limit: No longer available': '  Лимит: Больше не доступен',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Бесплатный уровень Qwen OAuth прекращён 2026-04-15. Выполните /auth для переключения на Coding Plan, OpenRouter, Fireworks AI или другого провайдера.',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ Метод аутентификации: Alibaba Cloud Coding Plan',
  'Global - Alibaba Cloud': 'Глобальный - Alibaba Cloud',
  '  Region: {{region}}': '  Регион: {{region}}',
  '  Current Model: {{model}}': '  Текущая модель: {{model}}',
  '  Config Version: {{version}}': '  Версия конфигурации: {{version}}',
  '  Status: API key configured\n': '  Статус: API Key настроен\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  Метод аутентификации: Alibaba Cloud Coding Plan (Не завершён)',
  '  Issue: API key not found in environment or settings\n':
    '  Проблема: API Key не найден в окружении или настройках\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  Выполните `qwen auth coding-plan` для повторной настройки.\n',
  '✓ Authentication Method: {{type}}': '✓ Метод аутентификации: {{type}}',
  '  Status: Configured\n': '  Статус: Настроено\n',
  'Failed to check authentication status: {{error}}':
    'Не удалось проверить статус аутентификации: {{error}}',
  'Select an option:': 'Выберите вариант:',
  'Raw mode not available. Please run in an interactive terminal.':
    'Raw-режим недоступен. Пожалуйста, запустите в интерактивном терминале.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(↑ ↓ стрелки для навигации, Enter для выбора, Ctrl+C для выхода)\n',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'Скрывать вывод инструментов и процесс рассуждений для более чистого вида (переключить с помощью Ctrl+O).',
  'Press Ctrl+O to show full tool output':
    'Нажмите Ctrl+O для показа полного вывода инструментов',
  'Switch to plan mode or exit plan mode':
    'Переключиться в режим плана или выйти из режима плана',
  'Exited plan mode. Previous approval mode restored.':
    'Режим плана завершён. Предыдущий режим утверждения восстановлен.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'Режим плана включён. Агент будет анализировать и планировать без выполнения инструментов.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'Уже в режиме плана. Используйте "/plan exit" для выхода из режима плана.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'Не в режиме плана. Сначала используйте "/plan" для входа в режим плана.',
  "Set up Qwen Code's status line UI":
    'Настроить интерфейс строки состояния Qwen Code',

  // === Core: added from PR #3328 ===
  'Open the memory manager.': 'Открыть менеджер памяти.',
  'Save a durable memory to the memory system.':
    'Сохранить долгосрочную память в системе памяти.',
  Tools: 'Инструменты',
  prompts: 'Подсказки',
  tools: 'инструменты',
  'Manage dynamic translation cache': 'Управлять кешем динамического перевода',
  'Open MCP management dialog': 'Открыть диалог управления MCP',
  'Manage MCP servers': 'Управление MCP servers',
  'Manage extension settings': 'Управление настройками расширения',
  'Manage Extensions': 'Управление расширениями',
  'Extension Details': 'Сведения о расширении',
  'View Extension': 'Просмотреть расширение',
  'Update Extension': 'Обновить расширение',
  'Disable Extension': 'Отключить расширение',
  'Enable Extension': 'Включить расширение',
  'Uninstall Extension': 'Удалить расширение',
  'Select Scope': 'Выбрать область',
  'User Scope': 'Область пользователя',
  'Workspace Scope': 'Область рабочего пространства',
  'No extensions found.': 'Расширения не найдены.',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'Вы уверены, что хотите удалить расширение "{{name}}"?',
  'This action cannot be undone.': 'Это действие нельзя отменить.',
  'Extension "{{name}}" updated successfully.':
    'Расширение "{{name}}" успешно обновлено.',
  'Name:': 'Имя:',
  'MCP Servers:': 'MCP Servers:',
  'Settings:': 'Настройки:',
  'View Details': 'Просмотреть сведения',
  'Update failed:': 'Ошибка обновления:',
  'Updating {{name}}...': 'Обновление {{name}}...',
  'Update complete!': 'Обновление завершено!',
  'User (global)': 'Пользователь (глобально)',
  'Workspace (project-specific)': 'Рабочее пространство (для проекта)',
  'Disable "{{name}}" - Select Scope': 'Отключить "{{name}}" - выбрать область',
  'Enable "{{name}}" - Select Scope': 'Включить "{{name}}" - выбрать область',
  'No extension selected': 'Расширение не выбрано',
  '{{count}} extensions installed': 'Установлено расширений: {{count}}',
  'up to date': 'актуально',
  'update available': 'доступно обновление',
  'checking...': 'проверка...',
  'not updatable': 'обновление недоступно',
  'Re-translate currently loaded dynamic slash descriptions for the current UI language':
    'Перевести загруженные описания динамических слеш-команд для текущего языка интерфейса',
  'Clear cached translations for the current UI language':
    'Очистить кешированные переводы для текущего языка интерфейса',
  'Manage AI translation for dynamic slash command descriptions':
    'Управлять AI-переводом описаний динамических слеш-команд',
  'Enable AI translation for dynamic slash command descriptions':
    'Включить AI-перевод описаний динамических слеш-команд',
  'Disable AI translation for dynamic slash command descriptions':
    'Отключить AI-перевод описаний динамических слеш-команд',
  'Show AI translation status for dynamic slash command descriptions':
    'Показать статус AI-перевода описаний динамических слеш-команд',
  'AI translation for dynamic slash command descriptions is {{status}}.':
    'AI-перевод описаний динамических слеш-команд {{status}}.',
  'AI translation for dynamic slash command descriptions is now enabled.':
    'AI-перевод описаний динамических слеш-команд теперь включен.',
  'AI translation for dynamic slash command descriptions is now disabled.':
    'AI-перевод описаний динамических слеш-команд теперь отключен.',
  'Ask a quick side question without affecting the main conversation':
    'Задать быстрый побочный вопрос, не затрагивая основной разговор',
  'Manage Arena sessions': 'Управлять сессиями Arena',
  'Start an Arena session with multiple models competing on the same task':
    'Запустить сессию Arena, где несколько моделей соревнуются на одной и той же задаче',
  'Stop the current Arena session': 'Остановить текущую сессию Arena',
  'Show the current Arena session status':
    'Показать статус текущей сессии Arena',
  'Select a model result and merge its diff into the current workspace':
    'Выбрать результат модели и объединить его diff с текущим рабочим пространством',
  'No running Arena session found.': 'Запущенная сессия Arena не найдена.',
  'No Arena session found. Start one with /arena start.':
    'Сессия Arena не найдена. Запустите её с помощью /arena start.',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Сессия Arena всё ещё выполняется. Дождитесь её завершения или сначала используйте /arena stop.',
  'No successful agent results to select from. All agents failed or were cancelled.':
    'Нет успешных результатов агентов для выбора. Все агенты завершились с ошибкой или были отменены.',
  'Use /arena stop to end the session.':
    'Используйте /arena stop для завершения сессии.',
  'No idle agent found matching "{{name}}".':
    'Не найден свободный агент, соответствующий "{{name}}".',
  'Failed to apply changes from {{label}}: {{error}}':
    'Не удалось применить изменения от {{label}}: {{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    'Изменения от {{label}} применены к рабочему пространству. Сессия Arena завершена.',
  'Discard all Arena results and clean up worktrees?':
    'Отменить все результаты Arena и очистить рабочие деревья?',
  'Arena results discarded. All worktrees cleaned up.':
    'Результаты Arena отменены. Все рабочие деревья очищены.',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena не поддерживается в неинтерактивном режиме. Используйте интерактивный режим для запуска сессии Arena.',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena не поддерживается в неинтерактивном режиме. Используйте интерактивный режим для остановки сессии Arena.',
  'Arena is not supported in non-interactive mode.':
    'Arena не поддерживается в неинтерактивном режиме.',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    'Сессия Arena уже существует. Используйте /arena stop или /arena select для её завершения перед запуском новой.',
  'Usage: /arena start --models model1,model2 <task>':
    'Использование: /arena start --models model1,model2 <задача>',
  'Models to compete (required, at least 2)':
    'Модели для соревнования (обязательно, минимум 2)',
  'Format: authType:modelId or just modelId':
    'Формат: authType:modelId или просто modelId',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena требует минимум 2 модели. Используйте --models model1,model2 для указания.',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena запущена с {{count}} агентами на задаче: "{{task}}"\nМодели:\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Панели Arena запущены в tmux. Подключитесь с помощью: `{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] ошибка: {{error}}',
  'Loading suggestions...': 'Загрузка предложений...',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'Показать разбивку использования окна контекста. Используйте "/context detail" для детализации по элементам.',
  'Show per-item context usage breakdown.':
    'Показать разбивку использования контекста по элементам.',

  // === Missing key backfill ===
  'Updating...': 'Обновление...',
  Unknown: 'Неизвестно',
  Error: 'Ошибка',
  'Version:': 'Версия:',
  "Use '/extensions install' to install your first extension.":
    "Используйте '/extensions install', чтобы установить первое расширение.",
  'Value:': 'Значение:',
  'Press c to copy the authorization URL to your clipboard.':
    'Нажмите c, чтобы скопировать URL авторизации в буфер обмена.',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'Запрос копирования отправлен в терминал. Если вставка пуста, скопируйте URL выше вручную.',
  'Cannot write to terminal — copy the URL above manually.':
    'Не удалось записать в терминал — скопируйте URL выше вручную.',
  'Tips:': 'Советы:',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Повтор через {{seconds}} секунд… (попытка {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'Нажмите Ctrl+Y, чтобы повторить',
  'No failed request to retry.': 'Нет неудачного запроса для повтора.',
  'to retry last request': 'чтобы повторить последний запрос',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    'Недействительный API Key. Coding Plan API Keys начинаются с "sk-sp-". Проверьте.',
  'Lock release warning': 'Предупреждение о снятии блокировки',
  'Metadata write warning': 'Предупреждение о записи метаданных',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    'Последующие dream-запуски могут пропускаться как заблокированные, пока следующая очистка устаревших сессий не удалит файл.',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    'Планировщик не увидел временную метку этого dream-запуска; следующий цикл dream может запуститься раньше обычного.',
  // === Same-as-English optimization ===
  ' (not in model registry)': ' (не в реестре моделей)',
  'start server': 'запустить сервер',
  '中国 (China)': 'Китай',
  '中国 (China) - 阿里云百炼': 'Китай - 阿里云百炼',
};
