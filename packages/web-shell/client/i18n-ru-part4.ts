import { ruPlural } from './utils/plural.js';

export const RU_PART4: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  'sidebar.unarchive': 'Восстановить',
  'sidebar.moreActions': 'Ещё действия',
  'sidebar.archiveCurrentDisabled': 'Текущую сессию нельзя архивировать',
  'sidebar.archiveRunningDisabled':
    'Выполняющуюся сессию нельзя архивировать: архивирование остановит её работу',
  'sidebar.archivedTitle': 'Архив',
  'sidebar.standaloneLoadFailed': 'Не удалось загрузить недавние диалоги',
  'sidebar.standaloneActionFailed': 'Не удалось выполнить действие с диалогом',
  'sidebar.standaloneDeleteConfirm': 'Удалить этот диалог и его личные файлы?',
  'sidebar.standaloneCleanupPending':
    'Диалог удалён. Очистка личных файлов завершится автоматически.',
  'sidebar.archivedEmpty': 'Нет архивных сессий.',
  'sidebar.archiveFailed': 'Не удалось архивировать сессию',
  'sidebar.unarchiveFailed': 'Не удалось восстановить сессию',
  'sidebar.loadFailed':
    'Не удалось загрузить сессии. Нажмите, чтобы повторить.',
  'sidebar.renameFailed': 'Не удалось переименовать сессию',
  'sidebar.deleteFailed': 'Не удалось удалить сессию',
  'sidebar.newSessionFailed': 'Не удалось создать новую сессию',
  'sidebar.switchFailed': 'Не удалось переключить сессию',
  'sidebar.currentDeleteDisabled':
    'Текущая сессия выполняется и не может быть удалена',
  'sidebar.currentStandaloneDeleteDisabled':
    'Сначала откройте другой чат, чтобы удалить текущую сессию без рабочей области',
  'sidebar.deleteConfirmDescription': (v) =>
    `Удалить «${v?.name ?? ''}»? Это действие нельзя отменить.`,
  'sidebar.clients': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'клиент', 'клиента', 'клиентов')}`,
  'sidebar.running': 'Выполняется',
  'sidebar.activeWork': 'Активная работа',
  'sidebar.activityUnknown': 'Фоновая активность неизвестна',
  'sidebar.waitingForApproval': 'Ожидание подтверждения',
  'sidebar.waitingForApprovalShort': 'Подтверждение',
  'sidebar.sessionPr': (v) => `PR #${v?.number ?? ''}`,
  'sidebar.sessionPrMultiple': (v) =>
    `PR #${v?.number ?? ''} (всего ${v?.count ?? 0})`,
  'sidebar.sessionPrStateMerged': 'Слит',
  'sidebar.sessionPrStateClosed': 'Закрыт',
  'sidebar.sessionIssue': (v) => `Issue #${v?.number ?? ''}`,
  'sidebar.sessionIssueStateCompleted': 'Завершено',
  'sidebar.sessionIssueStateNotPlanned': 'Не запланировано',
  'sidebar.userInputNeeded': 'Нужен ввод пользователя',
  'sidebar.userInputNeededShort': 'Ввод',
  'sidebar.completedUnread': 'Завершено',
  'sidebar.pin': 'Закрепить',
  'sidebar.selectSessions': 'Выбрать сессии',
  'sidebar.exitSelection': 'Выйти из выбора',
  'sidebar.selectedSessions': (v) =>
    `Выбрано ${v?.count ?? 0} ${ruPlural(v?.count, 'сессия', 'сессии', 'сессий')}`,
  'sidebar.unpin': 'Открепить',
  'sidebar.sessionGroup': 'Группа',
  'sidebar.groupFilter': 'Группа сессий',
  'sidebar.groupAll': 'Все',
  'sidebar.groupPinned': 'Закреплённые',
  'sidebar.groupUngrouped': 'Без группы',
  'sidebar.groupRecent': 'Недавние',
  'sidebar.groupCreate': 'Создать группу',
  'sidebar.groupRename': 'Переименовать группу',
  'sidebar.groupDelete': 'Удалить группу',
  'sidebar.groupColor': 'Цвет группы',
  'sidebar.groupNamePrompt': 'Название группы',
  'sidebar.groupDeleteConfirm': (v) => `Удалить группу «${v?.name ?? ''}»?`,
  'sidebar.groupsLoadFailed': 'Не удалось загрузить группы сессий',
  'sidebar.groupCreateFailed': 'Не удалось создать группу',
  'sidebar.groupAssignFailedAfterCreate':
    'Группа создана, но не удалось переместить в неё сессию',
  'sidebar.groupUpdateFailed': 'Не удалось обновить группу',
  'sidebar.groupDeleteFailed': 'Не удалось удалить группу',
  'sidebar.organizationFailed': 'Не удалось обновить организацию сессий',
  'sidebar.groupColor.red': 'Красный',
  'sidebar.groupColor.orange': 'Оранжевый',
  'sidebar.groupColor.yellow': 'Жёлтый',
  'sidebar.groupColor.green': 'Зелёный',
  'sidebar.groupColor.blue': 'Синий',
  'sidebar.groupColor.purple': 'Фиолетовый',
  'sidebar.groupColor.custom': 'Свой…',
  'sidebar.groupColor.picker': 'Выберите свой цвет группы',
  'sidebar.groupColor.hex': 'Hex-цвет',
  'sidebar.groupColor.invalid':
    'Введите шестизначный Hex-цвет, например #416ef5.',
  'quickKeys.retry': 'Повторить неудачный запрос',
  'error.unsupportedTheme':
    'Тема не поддерживается. Используйте /theme light или /theme dark.',
  'queue.delete': 'Удалить',
  'queue.edit': 'Изменить',
  'queue.insert': 'Вставить',
  'queue.cleared': 'Очередь очищена.',
  'queue.deleteTip': 'Убрать из очереди',
  'queue.editTip': 'Убрать из очереди и изменить снова',
  'queue.submitting': 'Отправка...',
  'queue.midTurnQueued': 'В очереди...',
  'queue.serverQueued': 'В очереди на сервере...',
  'queue.editing': 'Редактирование...',
  'queue.inserting': 'Вставка...',
  'queue.removing': 'Обновление...',
  'queue.submittingDisabled': 'Отправка сообщения из очереди...',
  'queue.summaryEditDisabled':
    'Восстановленная сводка очереди не может вернуть исходные вложения.',
  'queue.admissionUnknown':
    'Доставка не подтверждена. Проверьте сессию перед повторной попыткой.',
  'queue.restoreUnknown': 'Восстановить локальную копию',
  'queue.discardUnknown': 'Отбросить локальную копию',
  'queue.continueEditing': 'Продолжить редактирование',
  'queue.continueEditingConfirm':
    'Запрос, возможно, уже выполняется. Продолжайте редактирование, только если принимаете риск повторной отправки.',
  'queue.commandBlocked':
    'Slash-команды нельзя ставить в очередь, пока выполняется ход.',
  'queue.commandGoalBlocked':
    'Slash-команды недоступны, пока сессией владеет цель или загружается её состояние.',
  'queue.shellQueued':
    'Команда shell поставлена в очередь — она выполнится после завершения текущего хода.',
  'queue.shellDropped': (v) => {
    const count = v?.count ?? 0;
    return `${count} ${ruPlural(count, 'команда shell', 'команды shell', 'команд shell')} из очереди не будет выполнено.`;
  },
  'queue.queueFailed': 'Не удалось поставить сообщение в очередь',
  'queue.attachmentCleanupFailed': 'Не удалось удалить загруженные вложения',
  'queue.deleteFailed': 'Не удалось убрать сообщение из очереди',
  'queue.editFailed': 'Не удалось изменить сообщение в очереди',
  'queue.insertFailed': 'Не удалось вставить сообщение из очереди',
  'queue.insertTip': 'Вставить в текущий ход',
  'queue.insertCommandDisabled': 'Команды нельзя вставить в середине хода',
  'queue.sendNow': 'Отправить сейчас',
  'queue.sendNowTip':
    'Немедленно отправить сообщения из очереди, прервав текущий ответ модели, если она ещё не начала вызов инструмента; выполняющиеся инструменты сначала завершатся',
  'queue.sendNowFailed': 'Не удалось немедленно отправить сообщения из очереди',
  'queue.footer':
    'Нажмите ↑, чтобы изменить последнее сообщение в очереди · Esc — очистить очередь',
  'queue.imageCount': (v) =>
    `(+${v?.count ?? 0} ${ruPlural(v?.count, 'изображение', 'изображения', 'изображений')})`,
  'queue.fileCount': (v) =>
    `(+${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')})`,
  'queue.more': (v) => `... (+ещё ${v?.count ?? 0})`,
  'help.builtIn': 'Встроенные команды',
  'help.commandCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'команда', 'команды', 'команд')}`,
  'help.commandMeta.builtIn': 'встроенная',
  'help.commandMeta.custom': 'пользовательская',
  'help.commandMeta.subcommands': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'подкоманда', 'подкоманды', 'подкоманд')}`,
  'help.commandsIntro': 'Просмотр встроенных команд:',
  'help.customGroup': 'Пользовательские, skills, plugins, MCP',
  'help.customIntro': 'Просмотр пользовательских команд, skill, plugin и MCP:',
  'help.empty': 'Сейчас нет доступных команд.',
  'help.emptyCustom': 'Сейчас нет доступных пользовательских команд.',
  'help.footer':
    'Tab/Shift+Tab — переключение вкладок · ↑/↓ или PgUp/PgDn — прокрутка · Esc — закрыть',
  'help.intro':
    'Qwen Code понимает ваш код, вносит правки с вашего разрешения и выполняет команды прямо из терминала.',
  'help.section.shortcuts': 'Сочетания клавиш',
  'help.search': 'Поиск команд',
  'help.shortcut.addContext': 'Добавить файлы или папки в контекст',
  'help.shortcut.altWords': 'Переход по словам',
  'help.shortcut.clear': 'Очистить экран',
  'help.shortcut.commandMenu': 'Открыть меню команд',
  'help.shortcut.completion':
    'Принять дополнение или переключить вкладки справки',
  'help.shortcut.history': 'Листать историю запросов или прокручивать списки',
  'help.shortcut.searchHistory': 'Искать в истории запросов',
  'help.shortcut.newline': 'Вставить новую строку',
  'help.shortcut.pasteImages': 'Вставить изображения',
  'help.shortcut.shell': 'Выполнить команды shell',
  'help.shortcut.togglePanel': 'Переключить эту панель',
  'help.shortcut.retry': 'Повторить последний запрос',
  'retry.hint': 'Нажмите Ctrl+Y или щёлкните, чтобы повторить',
  'retry.none': 'Нет неудачного запроса для повтора.',
  'system.taskNotification': 'Уведомление о задаче',
  'background.result': 'Фоновый результат',
  'background.agent': 'Фоновый агент',
  'background.running': 'Выполняются фоновые задачи',
  'background.task': 'Фоновая задача',
  'background.peer': 'Сообщение из другой сессии',
  'background.details': 'Подробности',
  'background.processing': (v) => `Обработка результатов: ${v?.label ?? ''}`,
  'background.source': 'Источник',
  'background.pending': 'Ожидает обработки',
  'system.taskCompleted': 'Фоновая задача завершена',
  'system.taskFailed': 'Фоновая задача завершилась ошибкой',
  'system.taskCancelled': 'Фоновая задача отменена',
  'notification.shell.completed': (v) =>
    `Фоновая команда shell «${v?.command ?? ''}» завершена.`,
  'notification.shell.failed': (v) =>
    `Фоновая команда shell «${v?.command ?? ''}» завершилась ошибкой.`,
  'notification.shell.cancelled': (v) =>
    `Фоновая команда shell «${v?.command ?? ''}» отменена.`,
  'notification.monitor.completed': (v) =>
    `Монитор «${v?.description ?? ''}» завершён. (${v?.events ?? 0} ${ruPlural(
      v?.events,
      'событие',
      'события',
      'событий',
    )}${
      v?.droppedLines
        ? `, ${v.droppedLines} ${ruPlural(v.droppedLines, 'строка', 'строки', 'строк')} отброшено из-за ограничения`
        : ''
    })`,
  'notification.monitor.failed': (v) =>
    `Монитор «${v?.description ?? ''}» завершился ошибкой. (${v?.events ?? 0} ${ruPlural(
      v?.events,
      'событие',
      'события',
      'событий',
    )}${
      v?.droppedLines
        ? `, ${v.droppedLines} ${ruPlural(v.droppedLines, 'строка', 'строки', 'строк')} отброшено из-за ограничения`
        : ''
    })`,
  'notification.monitor.cancelled': (v) =>
    `Монитор «${v?.description ?? ''}» отменён. (${v?.events ?? 0} ${ruPlural(
      v?.events,
      'событие',
      'события',
      'событий',
    )}${
      v?.droppedLines
        ? `, ${v.droppedLines} ${ruPlural(v.droppedLines, 'строка', 'строки', 'строк')} отброшено из-за ограничения`
        : ''
    })`,
  'notification.agent.completed': (v) =>
    `Фоновый агент «${v?.description ?? ''}» завершён.`,
  'notification.agent.failed': (v) =>
    `Фоновый агент «${v?.description ?? ''}» завершился ошибкой.`,
  'notification.agent.cancelled': (v) =>
    `Фоновый агент «${v?.description ?? ''}» отменён.`,
  'branch.failed': 'Не удалось создать ветку сессии.',
  'branch.stale':
    'Этот ответ больше не находится на активном пути истории. Транскрипт обновлён.',
  'branch.staleRefreshFailed':
    'Этот ответ больше не находится на активном пути истории, и не удалось обновить транскрипт. Повторите попытку.',
  'branch.staleUnsupported':
    'Этот ответ больше не находится на активном пути истории. Ветвление с этой точки не поддерживается текущей сессией.',
  'branch.success': (v) =>
    `Сессия скопирована. Имя новой сессии: «${v?.name ?? ''}». Переключено на новую сессию.`,
  'branch.dialog.title': 'Ветвление сессии',
  'branch.dialog.current.title': 'Текущая рабочая область',
  'branch.dialog.current.description':
    'Скопировать диалог и продолжить в текущей копии репозитория.',
  'branch.dialog.worktree.title': 'Новый worktree',
  'branch.dialog.worktree.description':
    'Создать изолированную копию из текущего Git HEAD. Файлы не будут восстановлены к состоянию этого ответа.',
  'branch.dialog.cancel': 'Отмена',
  'branch.dialog.confirm': 'Ветвить',
  'branch.dialog.creating': 'Создание…',
  'branch.worktreeActivationFailed':
    'Ветка сессии создана, но её worktree не удалось открыть автоматически. Откройте её из списка сессий.',
  'fork.empty': 'Укажите директиву. Использование: /fork <directive>',
  'fork.failed': (v) => `Не удалось запустить fork: ${v?.reason ?? ''}`,
  'fork.notStarted': 'Фоновый агент не запущен.',
  'fork.started': (v) =>
    `Запущен фоновый агент: «${v?.name ?? ''}». Следите за ним в фоновых задачах.`,
  'command.hidden': 'Эта команда недоступна.',
  'help.shortcut.approvals': 'Переключать режимы подтверждения',
  'help.shortcut.cancel': 'Закрыть диалоги или отменить операцию',
  'bug.failed':
    'Не удалось загрузить системную информацию для отчёта об ошибке.',
  'bug.popupBlocked':
    'Всплывающее окно заблокировано — разрешите всплывающие окна и повторите попытку.',
  'bug.submitted': 'Отчёт об ошибке открыт в новой вкладке.',
  'clear.blocked':
    'Нельзя очистить во время потоковой передачи — сначала отмените (Esc).',
  'error.unknown': 'Неизвестная ошибка',
  'error.modelStreamInterrupted':
    'Поток ответа модели прерван. Повторите попытку.',
  'error.loopDetected':
    'Модель застряла при использовании инструментов или достигла предела безопасности, поэтому этот ход остановлен. Сессия по-прежнему открыта — попробуйте более конкретную инструкцию, чтобы продолжить.',
  'error.loopDetected.explicitCap': (vars) =>
    `Этот ход достиг лимита ${vars?.limit} ${ruPlural(
      vars?.limit,
      'вызов инструмента',
      'вызова инструмента',
      'вызовов инструментов',
    )}, заданного model.maxToolCallsPerTurn, и был остановлен. Сессия по-прежнему открыта — увеличьте лимит в настройках или отправьте новую инструкцию, чтобы продолжить.`,
  'error.loopDetected.backstop': (vars) =>
    `Этот ход достиг предела безопасности в ${vars?.limit} ${ruPlural(
      vars?.limit,
      'вызов инструмента',
      'вызова инструмента',
      'вызовов инструментов',
    )} и был остановлен. Сессия по-прежнему открыта — отправьте новую инструкцию, чтобы продолжить, или задайте другой лимит через model.maxToolCallsPerTurn.`,
  'error.loopDetected.stuckRepetition': (vars) =>
    `После более чем ${vars?.limit} ${ruPlural(
      vars?.limit,
      'вызов инструмента',
      'вызова инструмента',
      'вызовов инструментов',
    )} модель продолжала повторять один и тот же вызов, поэтому ход остановлен. Сессия по-прежнему открыта — попробуйте другую или более конкретную инструкцию.`,
  'error.loopDetected.repeatedCall':
    'Модель продолжала повторять один и тот же вызов инструмента в этом ходе, поэтому он остановлен. Сессия по-прежнему открыта — попробуйте другую или более конкретную инструкцию.',
  'error.loopDetected.providerDuplicateId':
    'Служба модели отправила вызов инструмента, который уже выполнялся, поэтому ход остановлен вместо повторного запуска. Сессия по-прежнему открыта — отправьте новое сообщение, чтобы продолжить.',
  'error.loopDetected.invalidToolParams':
    'Модель продолжала передавать некорректные аргументы одному и тому же инструменту, поэтому ход остановлен. Сессия по-прежнему открыта — попробуйте более конкретную инструкцию, чтобы продолжить.',
  'error.loopDetected.repeatedToolFailure':
    'Один и тот же инструмент продолжал завершаться с той же ошибкой после напоминания, поэтому ход остановлен. Сессия по-прежнему открыта — проверьте ошибки выше или попробуйте другой подход.',
  'shell.command': 'Команда shell',
  'shell.result.timedOut': 'Время ожидания истекло',
  'shell.result.notices': 'Замечания',
  'shell.result.truncated': 'Предпросмотр вывода обрезан',
  'shell.result.outputFiles': 'Файлы вывода',
  'shell.result.output': 'Вывод',
  'shell.result.command': 'Команда',
  'shell.result.copy': 'Копировать команду',
  'shell.result.details': 'Сведения о выполнении',
  'shell.result.directory': 'Каталог',
  'shell.result.timeout': 'Таймаут',
  'shell.result.timeoutMs': (v) => `${v?.milliseconds} мс`,
  'shell.result.defaultTimeout': 'Использовать значение по умолчанию',
  'shell.result.exitCode': 'Код выхода',
  'shell.result.signal': 'Сигнал',
  'shell.result.pending': 'Ожидание',
  'shell.result.elapsed': 'Прошло',
  'shell.result.lines': 'Строк вывода',
  'shell.result.bytes': 'Байт вывода',
  'shell.result.running': 'Выполняется',
  'shell.result.completed': 'Завершено',
  'shell.result.success': 'Успешно',
  'shell.result.cancelled': 'Отменено',
  'shell.result.waiting': 'Ожидание вывода…',
  'shell.result.empty': 'Нет вывода',
  'shell.result.unavailable': 'Вывод для этого вызова инструмента недоступен.',
  'shell.result.exited': (v) => `Завершено с кодом ${v?.code}`,
  'turnCalls.open': 'Просмотреть вызовы инструментов',
  'turnCalls.title': 'Вызовы инструментов',
  'turnCalls.count': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'вызов инструмента', 'вызова инструмента', 'вызовов инструментов')}`,
  'turnCalls.tool': 'Вызов инструмента',
  'turnCalls.elapsed': (v) => `Прошло: ${v?.duration ?? ''}`,
  'turnCalls.startedAt': (v) => `Время начала: ${v?.time ?? ''}`,
  'turnCalls.endedAt': (v) => `Время окончания: ${v?.time ?? ''}`,
  'turnCalls.empty': 'Для этого хода нет записей вызовов инструментов',
  'turnCalls.arguments': 'Аргументы',
  'turnCalls.result': 'Результат',
  'turnCalls.other': 'Прочее',
  'turnCalls.completed': 'Завершено',
  'turnCalls.unknown': 'Неизвестный статус',
  'turnCalls.loading': 'Загрузка записей вызовов этого хода…',
  'turnCalls.loadError': 'Не удалось загрузить все записи вызовов этого хода.',
  'turnCalls.indexError': 'Не удалось обновить список запросов.',
  'turnCalls.unresolved':
    'Не удалось найти этот запрос в истории сессии. Попробуйте обновить.',
  'turnCalls.running': 'Выполняется',
  'turnCalls.pending': 'Ожидание',
  'turnCalls.cancelled': 'Отменено',
  'turnCalls.filter': 'Фильтр по типу инструмента',
  'turnCalls.prompt': 'Запрос',
  'turnCalls.refresh': 'Обновить',
  'turnCalls.all': 'Все инструменты',
  'help.subcommands': 'подкоманды',
  'help.tab.commands': 'Встроенные команды',
  'help.tab.custom': 'пользовательские команды',
  'help.tab.general': 'сочетания клавиш',
  'help.title': 'Справка',
  'slash.category.custom': 'Пользовательские команды',
  'slash.category.skill': 'Команды Skill',
  'slash.category.system': 'Системные команды',
  'language.changed': (v) => `Язык UI изменён на ${v?.language ?? ''}`,
  'language.current': (v) => `Текущий язык UI: ${v?.language ?? ''}`,
  'language.invalid': 'Недопустимый язык. Доступно: en, zh-CN, ru',
  'language.options': 'Доступные варианты:',
  'language.set': 'Задать язык UI',
  'language.refreshFailed':
    'Язык UI сохранён, но не удалось применить его полностью.',
  'language.usage':
    'Использование: /language ui [en|zh-CN|ru] [--project|--global] | output <language>',
  'localCommand.noSession':
    'Пока нет активной сессии. Отправьте первое сообщение, прежде чем использовать эту команду.',
  'localCommand.diffNoWorkspace':
    'Пока нет рабочей области, для которой можно показать изменения.',
  'localCommand.logNoWorkspace':
    'Пока нет рабочей области, для которой можно показать историю.',
  'localCommand.prsNoWorkspace':
    'Пока нет рабочей области, для которой можно показать запросы на слияние.',
  'localCommand.prsUnsupported':
    'Этот демон не поддерживает список запросов на слияние.',
  'local.agents': 'Управлять субагентами',
  'local.bug': 'Отправить отчёт об ошибке',
  'local.compress': 'Сжать контекст в сводку',
  'local.compressFast': 'Быстрое сжатие контекста без ИИ',
  'local.config': 'Получить или задать настройку по ключу с точечной нотацией',
  'local.diff':
    'Показать статистику изменений рабочего дерева относительно HEAD',
  'local.log': 'Показать историю коммитов рабочей области',
  'local.prs':
    'Показать открытые запросы на слияние GitHub для рабочей области',
  'local.directory': 'Управлять каталогами рабочей области',
  'local.docs': 'Открыть полную документацию Qwen Code',
  'local.doctor': 'Запустить диагностику установки и окружения',
  'local.dream': 'Объединить файлы тем управляемой автопамяти',
  'local.effort': 'Задать интенсивность рассуждения для подходящих моделей',
  'local.export': 'Экспортировать историю текущей сессии в файл',
  'local.forget': 'Удалить совпадающие записи из управляемой автопамяти',
  'local.pr': 'Привязать запрос на слияние GitHub к этой сессии',
  'local.hooks': 'Управлять хуками Qwen Code',
  'local.importConfig': 'Импортировать MCP-серверы из конфигураций Claude',
  'local.init': 'Проанализировать проект и создать файл QWEN.md',
  'local.insight': 'Сформировать выводы по программированию из истории чата',
  'local.lsp': 'Показать статус LSP-сервера',
  'local.remember': 'Сохранить постоянную память в системе памяти',
  'local.summary': 'Создать файл сводки проекта',
  'local.workflows':
    'Список запусков воркфлоу или совместная пауза/возобновление текущего запуска',
  'skilldesc.autofixPr':
    'Следить за запросом на слияние и исправлять CI, замечания ревью и конфликты',
  'skilldesc.batch': 'Выполнять пакетные операции по многим файлам параллельно',
  'skilldesc.dataviz':
    'Рекомендации по оформлению графиков и визуализаций данных',
  'skilldesc.extensionCreator':
    'Создавать, тестировать и настраивать расширения Qwen Code',
  'skilldesc.goalDraft':
    'Превратить размытое намерение в проверяемую цель /goal',
  'skilldesc.loop':
    'Запускать запрос по расписанию или по собственным пробуждениям',
  'skilldesc.newApp': 'Воркфлоу создания нового приложения с нуля',
  'skilldesc.qcHelper': 'Отвечать на вопросы об использовании Qwen Code',
  'skilldesc.review':
    'Проверять изменённый код на ошибки, безопасность и качество',
  'skilldesc.simplify':
    'Упрощать недавние изменения для повторного использования',
  'skilldesc.stuck': 'Диагностировать зависшие или медленные сессии Qwen Code',
  'skilldesc.agentReproduceAlign':
    'Согласовать портированную функцию Codex/Claude Code с оригиналом',
  'skilldesc.agentReproduceFeature':
    'Воспроизвести существующую функцию Codex/Claude Code',
  'skilldesc.autofix':
    'Проверять и исправлять локальные изменения или запускать воркфлоу Autofix репозитория',
  'skilldesc.bugfix':
    'Исправлять ошибку из GitHub issue, сначала воспроизведя её',
  'skilldesc.codegraph':
    'Анализировать кодовую базу через граф и векторный индекс',
  'skilldesc.createIssue':
    'Подготовить и отправить GitHub issue на основе идеи',
  'skilldesc.docsAuditAndRefresh':
    'Проверять и обновлять docs/ по кодовой базе',
  'skilldesc.docsUpdateFromDiff':
    'Обновлять официальную документацию по локальному git diff',
  'skilldesc.e2eTesting': 'Запускать сквозные тесты CLI Qwen Code',
  'skilldesc.featDev': 'Сквозной воркфлоу для нетривиальной функции',
  'skilldesc.memoryLeakDebug':
    'Диагностировать утечки памяти CLI по снимкам кучи',
  'skilldesc.preparePr': 'Подготовить заголовок и текст GitHub PR по ветке',
  'skilldesc.qwenCodeClaw': 'Использовать Qwen Code как агента понимания кода',
  'skilldesc.structuredDebugging': 'Методика гипотез для сложных ошибок',
  'skilldesc.terminalCapture':
    'Автоматизировать тестирование UI терминала по скриншотам',
  'skilldesc.tmuxRealUserTesting':
    'Тестирование реальным пользователем в tmux с сохранением логов',
  'skilldesc.triage': 'Разбирать и ревьюить issue и PR Qwen Code',
  'local.approvalMode': 'Изменить режим подтверждения',
  'local.auth': 'Подключить поставщика LLM',
  'auth.title': 'Подключить поставщика',
  'auth.step.group': 'Тип',
  'auth.step.authorization': 'Авторизация',
  'auth.step.provider': 'Поставщик',
  'auth.step.protocol': 'Протокол',
  'auth.step.api': 'API',
  'auth.step.baseUrl': 'Base URL',
  'auth.step.apiKey': 'API Key',
  'auth.step.models': 'ID моделей',
  'auth.step.advanced': 'Расширенные настройки',
  'auth.protocol.openai': 'Совместимый с OpenAI',
  'auth.protocol.openaiDesc':
    'Стандартный формат OpenAI API (самый распространённый)',
  'auth.protocol.anthropic': 'Совместимый с Anthropic',
  'auth.protocol.anthropicDesc': 'Формат Anthropic Messages API',
  'auth.protocol.gemini': 'Совместимый с Gemini',
  'auth.protocol.geminiDesc': 'Формат Google Gemini API',
  'auth.api.chatCompletions': 'Chat Completions',
  'auth.api.responses': 'Responses',
  'auth.apiKeyRequired': 'API key не может быть пустым.',
  'auth.baseUrlInvalid': 'Base URL должен начинаться с http:// или https://.',
  'auth.baseUrlPrompt': 'Введите API endpoint для этого протокола.',
  'auth.baseUrlRequired': 'Base URL не может быть пустым.',
  'auth.documentation': 'Документация',
  'auth.modelsRequired': 'ID моделей не могут быть пустыми.',
  'auth.review': 'Проверка',
  'auth.reviewText':
    'Проверьте параметры подключения и модели перед сохранением.',
  'auth.save': 'Сохранить',
  'auth.saving': 'Сохранение...',
  'auth.termsTitle': 'Условия использования и уведомление о конфиденциальности',
  'auth.continue': 'Продолжить',
  'auth.modelsPrompt': (v) =>
    `Введите ID моделей через запятую. Примеры: ${v?.modelIds ?? ''}`,
  'auth.advanced.prompt':
    'Необязательно: настройте расширенные параметры генерации.',
  'auth.advanced.thinking': 'Включить thinking',
  'auth.advanced.thinkingDesc':
    'Включить расширенное рассуждение. Оставьте выключенным, чтобы использовать значение модели по умолчанию.',
  'auth.advanced.modality': 'Включить модальность',
  'auth.advanced.modalityDesc':
    'Включает мультимодальный ввод (изображение, видео и т. д.).',
  'auth.advanced.modalityImage': 'Изображение',
  'auth.advanced.modalityVideo': 'Видео',
  'auth.advanced.modalityAudio': 'Аудио',
  'auth.advanced.modalityPdf': 'PDF',
  'auth.advanced.contextWindow': 'Окно контекста',
  'auth.advanced.contextDesc':
    'Ёмкость окна контекста в токенах. Оставьте пустым, чтобы вывести лимит из ID модели.',
  'auth.advanced.contextPlaceholder': 'Окно контекста (необязательно)',
  'auth.advanced.maxTokens': 'Максимум токенов вывода',
  'auth.advanced.maxTokensDesc':
    'Максимум токенов на ответ. Оставьте пустым, чтобы вывести лимит из ID модели.',
  'auth.advanced.tokenLimitInvalid': (v) =>
    `${v?.field ?? 'Лимит токенов'} должен быть целым числом от 1 до 10,000,000.`,
  'auth.advanced.modalitiesRequired':
    'Выберите хотя бы один тип ввода или отключите модальность.',
  'auth.advanced.defaults': 'Использовать значения модели по умолчанию',
  'auth.apiKeySet': 'Задан (скрыт)',
  'local.btw':
    'Задать быстрый побочный вопрос, не затрагивая основной диалог. Использование: /btw <your question>',
  'btw.empty': 'Укажите вопрос. Использование: /btw <your question>',
  'btw.side.empty': 'Укажите вопрос. Использование: /btw side <your question>',
  'btw.emptyAnswer': 'Ответ не получен.',
  'btw.failed': 'Не удалось ответить на вопрос btw',
  'btw.answering': '+ Ответ...',
  'btw.shortcuts.pending': 'Нажмите Escape, Ctrl+C или Ctrl+D, чтобы отменить',
  'btw.shortcuts.done': 'Нажмите Space, Enter или Escape, чтобы закрыть',
  'local.clear':
    'Начать новую сессию с пустым контекстом; предыдущая сессия останется на диске (можно возобновить через /resume)',
  'local.context':
    'Показать разбивку использования окна контекста. Используйте "/context detail" для поэлементной разбивки.',
  'local.copy': 'Копировать последний вывод или фрагмент',
  'local.delete': 'Удалить сессию безвозвратно',
  'local.release': 'Освободить live-сессию',
  'local.rewind': 'Откатить текущий диалог',
  'local.branch': 'Ответвить текущий диалог в новую сессию',
  'local.fork': 'Запустить фоновый агент из этого диалога',
  'local.help': 'Показать справку и команды',
  'local.language': 'Изменить язык UI',
  'local.mcp': 'Управлять MCP-серверами',
  'local.memory': 'Управлять памятью',
  'local.model': 'Сменить модель или задать fast model',
  'local.new': 'Начать новый диалог',
  'local.plan': 'Войти в режим Plan',
  'local.goal': 'Задать цель и работать, пока она не будет достигнута',
  'local.recap': 'Сформировать обзор сессии',
  'recap.label': 'Обзор',
  'recap.loading': 'Формирование обзора...',
  'recap.empty': 'Пока недостаточно контекста диалога для обзора.',
  'recap.failed': 'Не удалось сформировать обзор',
  'rewind.action': 'Откатить',
  'rewind.confirm': 'Подтвердить откат',
  'rewind.empty': 'Для этой сессии нет снимков для отката.',
  'rewind.failed': (v) => `Не удалось откатить сессию: ${v?.reason ?? ''}`,
  'rewind.identityUnavailable':
    'У этого снимка нет идентификатора запроса для отката.',
  'rewind.loading': 'Загрузка снимков для отката...',
  'rewind.promptFallback': (v) => `Prompt ${v?.id ?? ''}`,
  'rewind.rewinding': 'Откат...',
  'rewind.subtitle': 'Откатывается только диалог. Файлы не изменяются.',
  'rewind.title': 'Откатить диалог',
  'rewind.turn': (v) => `Prompt ${v?.turn ?? 0}`,
  'local.rename': 'Переименовать текущую сессию',
  'rename.empty':
    'Введите имя сессии, например /rename отладка проекта, или используйте /rename --auto.',
  'rename.success': (v) => `Сессия переименована в ${v?.name ?? ''}`,
  'local.reset': 'Сбросить текущий диалог',
  'local.resume': 'Возобновить предыдущую сессию',
  'local.skills': 'Показать доступные навыки',
  'local.stats': 'Показать статистику сессии',
  'local.tasks': 'Показать фоновые задачи',
  'local.status': 'Показать сведения о версии',
  'local.theme': 'Сменить тему',
  'local.settings': 'Просмотреть и изменить настройки',
  'local.schedule': 'Управлять задачами по расписанию',
  'local.extensions':
    'Управлять расширениями. Использование: /extensions manage|install <source>',
  'extensions.label': 'расширение',
  'extensions.action.failed': (v) =>
    `Действие с расширением не выполнено${
      v?.name ? ` для «${v.name}»` : v?.source ? ` из «${v.source}»` : ''
    }: ${v?.error ?? 'Неизвестная ошибка'}`,
  'extensions.commands.refreshFailed':
    'Не удалось обновить команды расширений.',
  'extensions.install.failed': (v) =>
    `Не удалось установить расширение${
      v?.source ? ` из «${v.source}»` : ''
    }: ${v?.error ?? 'Неизвестная ошибка'}`,
  'extensions.manage.agents': 'Агенты:',
  'extensions.manage.actions': 'Действия с расширением',
  'extensions.manage.add': 'Добавить',
  'extensions.manage.checkingUpdates': 'Проверка обновлений...',
  'extensions.manage.checkUpdates': 'Проверить обновления',
  'extensions.manage.commands': 'Команды:',
  'extensions.manage.contextFiles': 'Файлы контекста:',
  'extensions.manage.count': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'расширение', 'расширения', 'расширений')} установлено`,
  'extensions.manage.setting.disabled': 'Отключено',
  'extensions.manage.setting.default': 'По умолчанию',
  'extensions.manage.setting.enabled': 'Включено',
  'extensions.manage.setting.unknown': 'Недоступно',
  'extensions.manage.setting.unavailableDescription':
    'Служба не вернула настройки расширений по областям. Перезапустите qwen serve и повторите попытку.',
  'extensions.manage.userSetting': 'Глобальная настройка',
  'extensions.manage.userSettingDescription':
    'Применяется к вашим рабочим областям, пока настройка рабочей области её не переопределит.',
  'extensions.manage.workspaceSetting': 'Настройка рабочей области',
  'extensions.manage.workspaceSettingDescription':
    'Применяется только к текущей рабочей области.',
  'extensions.manage.disable': 'Отключить расширение',
  'extensions.manage.disabled': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» отключено.`,
  'extensions.manage.disabling': (v) =>
    `Отключение расширения «${v?.name ?? 'расширение'}»…`,
  'extensions.manage.inherited': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» теперь использует глобальную настройку.`,
  'extensions.manage.inheriting': (v) =>
    `Сброс расширения «${v?.name ?? 'расширение'}» к глобальной настройке…`,
  'extensions.manage.empty': 'Расширения не установлены.',
  'extensions.manage.emptyAgents': 'У этого расширения нет агентов.',
  'extensions.manage.emptyCommands': 'У этого расширения нет команд.',
  'extensions.manage.emptyContextFiles':
    'У этого расширения нет файлов контекста.',
  'extensions.manage.emptyDescription':
    'Установите расширение, чтобы добавить команды, навыки, агентов или MCP-серверы.',
  'extensions.manage.emptyMcpServers': 'У этого расширения нет MCP-серверов.',
  'extensions.manage.emptySkills': 'У этого расширения нет навыков.',
  'extensions.manage.enable': 'Включить расширение',
  'extensions.manage.enabled': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» включено.`,
  'extensions.manage.enabling': (v) =>
    `Включение расширения «${v?.name ?? 'расширение'}»…`,
  'extensions.manage.install': 'Установить',
  'extensions.manage.installDescription':
    'Введите источник GitHub, Git или npm либо загрузите архив расширения.',
  'extensions.manage.sourceTab': 'Источник',
  'extensions.manage.archiveTab': 'Архив',
  'extensions.manage.archiveSelect': 'Выберите архив .zip или .tar.gz.',
  'extensions.manage.archiveSelected': (v) =>
    `Выбран архив: ${v?.name ?? 'архив расширения'}`,
  'extensions.manage.archiveTooLarge':
    'Архивы расширений должны быть не больше 10 MB.',
  'extensions.manage.archiveEmpty': 'Выбранный архив расширения пуст.',
  'extensions.manage.archiveInvalid':
    'Выберите архив расширения .zip или .tar.gz с корректным именем файла до 255 байт.',
  'extensions.manage.installSelectPluginDescription': (v) =>
    `Выберите плагин из «${v?.marketplace ?? 'этого магазина'}».`,
  'extensions.manage.installTitle': 'Добавить расширение',
  'extensions.manage.installType': 'Тип установки:',
  'extensions.manage.mcpServers': 'MCP-серверы:',
  'extensions.manage.marketplaceRoot': 'Корень магазина',
  'extensions.manage.name': 'Имя:',
  'extensions.manage.notUpdatable': 'нельзя обновить',
  'extensions.manage.operationFailed': 'Операция с расширением не выполнена.',
  'extensions.manage.noDescription': 'Нет описания',
  'extensions.manage.noMatches': 'Нет подходящих расширений.',
  'extensions.manage.origin': 'Происхождение:',
  'extensions.manage.overview': 'Обзор',
  'extensions.manage.path': 'Путь:',
  'extensions.manage.queued': (v) =>
    `Действие с расширением поставлено в очередь для «${v?.name ?? 'расширение'}».`,
  'extensions.manage.refreshFailed': (v) =>
    `Действие с расширением выполнено, но не удалось обновить сессию${
      v?.error ? `: ${v.error}` : '.'
    }`,
  'extensions.manage.restartRequired': 'обновлено; требуется перезапуск',
  'extensions.manage.search': 'Поиск расширений…',
  'extensions.manage.selectExtension': 'Выберите расширение',
  'extensions.manage.settings': 'Настройки:',
  'extensions.manage.skills': 'Навыки:',
  'extensions.manage.source': 'Источник:',
  'extensions.manage.sourcePlaceholder': 'https://github.com/owner/repository',
  'extensions.manage.status': 'Статус:',
  'extensions.manage.status.disabled': 'отключено',
  'extensions.manage.status.enabled': 'включено',
  'extensions.manage.title': 'Управление расширениями',
  'extensions.manage.unknownUpdate': 'неизвестно',
  'extensions.manage.uninstalled': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» удалено.`,
  'extensions.manage.uninstalling': (v) =>
    `Удаление расширения «${v?.name ?? 'расширение'}»…`,
  'extensions.manage.uninstallAction': 'Удалить расширение',
  'extensions.manage.uninstallConfirm': (v) =>
    `Удалить расширение «${v?.name ?? 'расширение'}»?`,
  'extensions.manage.upToDate': 'актуально',
  'extensions.manage.update': 'Обновить расширение',
  'extensions.manage.updateAvailable': 'есть обновление',
  'extensions.manage.updateError': 'проверка обновлений не удалась',
  'extensions.manage.updateComplete': 'обновлено',
  'extensions.manage.updatedWithWarnings': 'обновлено с предупреждениями',
  'extensions.manage.updateStatus': 'Статус обновления:',
  'extensions.manage.updating': 'обновление…',
  'extensions.manage.updatingExtension': (v) =>
    `Обновление расширения «${v?.name ?? 'расширение'}»…`,
  'extensions.manage.updated': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» обновлено.`,
  'extensions.manage.updatedWithVersion': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» обновлено до v${v?.version ?? ''}.`,
  'extensions.manage.version': 'Версия:',
  'extensions.manage.viewDetails': 'Подробности',
  'extensions.install.installed': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» установлено.`,
  'extensions.install.installedWithVersion': (v) =>
    `Расширение «${v?.name ?? 'расширение'}» v${v?.version ?? ''} установлено.`,
  'extensions.install.missingOptionValue': (v) =>
    `Отсутствует значение для ${v?.option ?? 'параметра'}`,
  'extensions.install.requestFailed': 'Не удалось установить расширение',
  'extensions.install.started': (v) =>
    `Установка расширения из «${v?.source ?? ''}»...`,
  'extensions.install.unknownOption': (v) =>
    `Неизвестный параметр ${v?.option ?? ''}`,
  'extensions.install.usage':
    'Использование: /extensions manage|install <source>',
  'extensions.install.waitForSession':
    'Дождитесь подключения сессии, прежде чем устанавливать расширение.',
  'local.tools': 'Список доступных инструментов. Использование: /tools [desc]',
  'loadWarning.commands':
    'Не удалось загрузить список команд; slash-команды могут быть неполными.',
  'loadWarning.context':
    'Не удалось загрузить контекст сессии; текущий режим может быть неточным.',
  'loadWarning.models':
    'Не удалось загрузить список моделей; некоторые сведения о моделях могут быть недоступны.',
  'mcp.action.auth': 'Аутентифицировать',
  'mcp.action.authHint': 'Демон пока не предоставляет эту возможность',
  'mcp.action.authMessage':
    'daemon serve пока не предоставляет аутентификацию MCP.',
  'mcp.action.clearAuth': 'Сбросить аутентификацию',
  'mcp.action.disable': 'Отключить',
  'mcp.action.done': (v) => `${v?.action ?? 'Действие'} выполнено.`,
  'mcp.action.enable': 'Включить',
  'mcp.action.enableMessage':
    'daemon serve пока не предоставляет включение и отключение MCP.',
  'mcp.action.failed': (v) => `Не удалось: ${v?.error ?? ''}`,
  'mcp.action.running': (v) => `${v?.action ?? 'Действие'}...`,
  'mcp.action.reauth': 'Повторить аутентификацию',
  'mcp.action.approve': 'Одобрить',
  'mcp.actions': 'Действия сервера',
  'mcp.annotation.destructive': 'разрушительная',
  'mcp.annotation.idempotent': 'идемпотентная',
  'mcp.annotation.openWorld': 'открытый мир',
  'mcp.annotation.readOnly': 'только чтение',
  'mcp.annotations': 'Аннотации',
  'mcp.oauth.server': 'Сервер',
  'mcp.oauth.starting': (v) =>
    `Запуск OAuth-аутентификации для MCP-сервера «${v?.name ?? ''}»...`,
  'mcp.oauth.title': 'OAuth-аутентификация',
  'mcp.oauth.timeout':
    'Время аутентификации истекло. Обновите страницу, чтобы проверить статус.',
  'mcp.oauth.authenticationFailed': 'Аутентификация не удалась.',
  'mcp.oauth.statusFailed': 'Не удалось проверить статус аутентификации.',
  'mcp.oauth.serverRemoved': 'MCP-сервер был удалён во время аутентификации.',
  'mcp.clientBudget': (v) =>
    `${v?.count ?? 0}/${v?.budget ?? 0} ${ruPlural(v?.count, 'клиент', 'клиента', 'клиентов')} · ${v?.mode ?? 'off'}`,
  'mcp.command': 'Команда',
  'mcp.description': 'Описание:',
  'mcp.descriptionTitle': 'Описание',
  'mcp.basicInfo': 'Основные сведения',
  'mcp.action.reconnect': 'Переподключить',
  'mcp.action.edit': 'Изменить',
  'mcp.reconnect.skipped': (v) =>
    `Переподключение не завершено: ${v?.reason ?? 'неизвестная причина'}.`,
  'mcp.reconnect.authenticationRequired':
    'Перед переподключением требуется аутентификация.',
  'mcp.action.restart': 'Перезапустить',
  'mcp.action.tools': 'Просмотреть инструменты',
  'mcp.action.toolsHint': 'Enter — просмотреть',
  'mcp.empty': 'MCP-серверы не настроены.',
  'mcp.emptyDescription': 'Добавьте MCP-сервер, чтобы управлять им здесь.',
  'mcp.emptyTools': 'Инструменты не обнаружены.',
  'mcp.expand': 'Развернуть MCP-сервер',
  'mcp.collapse': 'Свернуть MCP-сервер',
  'mcp.inputSchema': 'Входная схема',
  'mcp.loadingStatus': 'Загрузка статуса MCP...',
  'mcp.loadingTools': 'Загрузка инструментов...',
  'mcp.name': 'Имя',
  'mcp.noDescription': 'Нет описания',
  'mcp.noMatches': 'Нет подходящих MCP-серверов.',
  'mcp.add.button': 'Добавить',
  'mcp.add.adding': 'Добавление MCP-сервера…',
  'mcp.add.title': 'Добавить MCP-сервер',
  'mcp.add.description':
    'Сохраните MCP-сервер в этой рабочей области с именем и конфигурацией.',
  'mcp.add.name': 'Имя',
  'mcp.add.serverDescription': 'Описание',
  'mcp.add.serverDescriptionPlaceholder': 'Опишите этот MCP-сервер',
  'mcp.add.scope': 'Расположение',
  'mcp.add.scope.global': 'Глобально',
  'mcp.add.nameRequired': 'Введите имя MCP-сервера.',
  'mcp.add.config': 'Конфигурация (JSON)',
  'mcp.add.configInvalid': 'Конфигурация должна быть JSON-объектом.',
  'mcp.add.done': (v) => `Добавлен ${v?.name ?? 'MCP-сервер'}.`,
  'mcp.edit.title': 'Изменить MCP-сервер',
  'mcp.edit.description':
    'Обновите описание или конфигурацию. Имя и расположение изменить нельзя.',
  'mcp.edit.save': 'Сохранить изменения',
  'mcp.edit.saving': 'Сохранение изменений…',
  'mcp.edit.done': (v) => `Обновлён ${v?.name ?? 'MCP-сервер'}.`,
  'mcp.edit.notFound': 'MCP-сервер больше не присутствует в настройках.',
  'mcp.runtime.notUpdated':
    'Конфигурация сохранена, но текущая сессия не обновлена.',
  'mcp.runtime.removeNotUpdated':
    'Конфигурация удалена, но текущая сессия не обновлена.',
  'mcp.discovery.empty': 'MCP-серверы не настроены.',
  'mcp.discovery.timeout':
    'Обнаружение MCP занимает больше времени, чем ожидалось. Обновите, чтобы проверить снова.',
  'mcp.add.settingsUnavailable': 'Настройки рабочей области недоступны.',
  'mcp.action.remove': 'Удалить',
  'mcp.remove.title': 'Удалить MCP-сервер',
  'mcp.remove.description': (v) =>
    `Удалить MCP-сервер «${v?.name ?? ''}» из этой рабочей области?`,
  'mcp.remove.description.global': (v) =>
    `Удалить MCP-сервер «${v?.name ?? ''}» из глобальных настроек?`,
  'mcp.remove.done': (v) => `Удалён ${v?.name ?? 'MCP-сервер'}.`,
  'mcp.remove.notWorkspace':
    'Этот MCP-сервер не задан в настройках рабочей области.',
  'mcp.source.all': 'Все',
  'mcp.noSchema': 'Нет входной схемы.',
  'mcp.oauth.open': 'Открыть страницу аутентификации',
  'mcp.serverTool': 'Инструмент сервера',
  'mcp.servers': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сервер', 'сервера', 'серверов')}`,
  'mcp.configuredServers': 'Настроенные MCP-серверы:',
  'mcp.fromExtension': (v) => `(из ${v?.name ?? ''})`,
  'mcp.extensionMcp': 'MCP расширения',
  'mcp.invalidReason': (v) => `некорректно: ${v?.reason ?? ''}`,
  'mcp.invalidReasonLabel': 'Причина:',
  'mcp.invalidToolHelp':
    'У инструментов должны быть и имя, и описание, чтобы LLM мог их использовать.',
  'mcp.invalidToolWarning':
    'Предупреждение: этот инструмент нельзя вызвать через LLM',
  'mcp.manageServers': 'Управлять MCP-серверами',
  'mcp.viewDetails': 'Подробности',
  'mcp.parameters': 'Параметры:',
  'mcp.required': ' обязательно',
  'mcp.resources': 'Ресурсы',
  'mcp.resourcesUnavailable': 'Сведения о ресурсах недоступны.',
  'mcp.noResources': 'Нет ресурсов.',
  'mcp.resourceCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'ресурс', 'ресурса', 'ресурсов')}`,
  'mcp.promptCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'промпт', 'промпта', 'промптов')}`,
  'mcp.resource.uriLabel': 'URI:',
  'mcp.resource.nameLabel': 'Имя:',
  'mcp.resource.mimeTypeLabel': 'Тип MIME:',
  'mcp.resource.sizeLabel': 'Размер:',
  'mcp.resource.bytes': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'байт', 'байта', 'байтов')}`,
  'mcp.scrollPosition': (v) => `${v?.current ?? 0}/${v?.total ?? 0}`,
  'mcp.shortcut.back': 'Esc — назад',
  'mcp.shortcut.close': 'Esc — закрыть',
  'mcp.shortcut.selectBack': '↑↓ — навигация · Enter — выбрать · Esc — назад',
  'mcp.shortcut.selectClose':
    '↑↓ — навигация · Enter — выбрать · Esc — закрыть',
  'mcp.settings': 'Настройки',
  'mcp.extension': (v) => `Расширение: ${v?.name ?? ''}`,
  'mcp.starting': (v) =>
    `⏳ MCP-серверы запускаются (${v?.count ?? 0} инициализируется)...`,
  'mcp.startingNote':
    'Примечание: первый запуск может занять больше времени. Доступность инструментов обновится автоматически.',
  'mcp.restartSkipped': (v) => `Пропущен ${v?.name ?? ''}: ${v?.reason ?? ''}`,
  'mcp.restarted': (v) =>
    `Перезапущен ${v?.name ?? ''} за ${v?.duration ?? 0}ms`,
  'mcp.restartEntries': (v) =>
    `Перезапущено ${v?.restarted ?? 0}/${v?.total ?? 0} ${ruPlural(
      v?.total,
      'запись',
      'записи',
      'записей',
    )} ${v?.name ?? ''}${v?.failedReasons ? ` (ошибки: ${v.failedReasons})` : ''}`,
  'mcp.source': 'Источник',
  'mcp.source.extension': 'Расширение',
  'mcp.source.project': 'Проектный MCP (.mcp.json)',
  'mcp.source.workspace': 'Настройки рабочей области',
  'mcp.source.user': 'Глобальные настройки',
  'mcp.status': 'Статус',
  'mcp.status.blocked': 'Заблокирован',
  'mcp.status.authenticating': 'Аутентификация',
  'mcp.status.authenticationFailed': 'Аутентификация не удалась',
  'mcp.status.needsAuthentication': 'Требуется аутентификация',
  'mcp.status.needsApproval': 'Требуется подтверждение',
  'mcp.status.rejected': 'Отклонён',
  'mcp.status.connected': 'подключён',
  'mcp.status.connecting': 'подключение',
  'mcp.status.disconnected': 'отключён',
  'mcp.status.disconnectedTitle': 'Отключён',
  'mcp.status.disabled': 'отключён',
  'mcp.status.ready': 'Готов',
  'mcp.status.starting':
    'Запуск... (первый запуск может занять больше времени)',
  'mcp.status.unknown': 'неизвестно',
  'mcp.tipDesc': 'показать описания серверов и инструментов',
  'mcp.tipNodesc': 'скрыть описания',
  'mcp.tipSchema': 'показать схемы параметров инструментов',
  'mcp.tips': '💡 Подсказки:',
  'mcp.toolCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'инструмент', 'инструмента', 'инструментов')}`,
  'mcp.toolsCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'инструмент', 'инструмента', 'инструментов')}`,
  'mcp.toolsLabel': 'Инструменты:',
  'mcp.title': 'MCP-серверы',
  'mcp.toolDetail': 'Сведения об инструменте',
  'mcp.tools': 'Инструменты',
  'mcp.toolsForServer': (v) => `Инструменты для ${v?.name ?? 'сервера'}`,
  'mcp.transport': 'Протокол передачи',
  'mcp.use': 'Использовать',
  'mcp.userMcp': 'Глобальный MCP',
  'mcp.workingDirectory': 'Рабочий каталог',
  'goal.aborted': 'Цель прервана',
  'goal.blocked': 'Цель заблокирована',
  'goal.usageLimited': 'Лимит использования цели',
  'goal.paused': 'Цель на паузе',
  'goal.achieved': 'Цель достигнута',
  'goal.check': 'Проверка цели',
  'goal.cleared': 'Цель снята',
  'goal.failed': 'Цель не достигнута',
  'goal.judge': 'Оценка',
  'goal.label': 'Цель',
  'goal.expandDetails': 'Показать подробности',
  'goal.collapseDetails': 'Скрыть подробности',
  'goal.lastCheck': 'Последняя проверка',
  'goal.notYetMet': 'условие не выполнено',
  'goal.reason.token_budget': (v) =>
    `Цель исчерпала автономный бюджет токенов (${v?.count} ${v?.unit}). Возобновите цель, чтобы выдать ещё одно окно бюджета, или снимите её.`,
  'goal.reason.turn_budget': (v) =>
    `Цель исчерпала бюджет ходов (${v?.count} ${v?.unit}). Возобновите цель, чтобы выдать ещё одно окно ходов, или снимите её.`,
  'goal.reason.time_budget': (v) =>
    `Цель исчерпала бюджет активного времени (${v?.count} ${v?.unit}). Возобновите цель, чтобы выдать ещё одно окно времени, или снимите её.`,
  'goal.reason.unit.token.one': 'токен',
  'goal.reason.unit.token.few': 'токена',
  'goal.reason.unit.token.many': 'токенов',
  'goal.reason.unit.turn.one': 'ход',
  'goal.reason.unit.turn.few': 'хода',
  'goal.reason.unit.turn.many': 'ходов',
  'goal.reason.unit.minute.one': 'минута',
  'goal.reason.unit.minute.few': 'минуты',
  'goal.reason.unit.minute.many': 'минут',
  'goal.reason.unit.second.one': 'секунда',
  'goal.reason.unit.second.few': 'секунды',
  'goal.reason.unit.second.many': 'секунд',
  'goal.set': 'Цель задана',
  'goal.statusActive': '/goal активен',
  'goal.status.active': 'В работе',
  'goal.status.paused': 'Пауза',
};
