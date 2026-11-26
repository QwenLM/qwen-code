import { ruPlural } from './utils/plural.js';

export const RU_PART6: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  'tasks.empty': 'Сейчас нет выполняемых задач',
  'tasks.refreshStale':
    'Статус задач может быть устаревшим; повторное подключение…',
  'tasks.cancelFailed': 'Не удалось отменить задачу',
  'tasks.alreadyStopped': 'Задача уже остановлена',
  'tasks.moreAbove': (v) => `^ ещё ${v?.count ?? 0} выше`,
  'tasks.moreBelow': (v) => `v ещё ${v?.count ?? 0} ниже`,
  'tasks.running': 'Выполняется',
  'tasks.pausing': 'Приостановка',
  'tasks.completed': 'Завершено',
  'tasks.failed': 'Ошибка',
  'tasks.cancelled': 'Остановлено',
  'tasks.paused': 'На паузе',
  'tasks.kind.shell': 'Shell',
  'tasks.kind.monitor': 'Монитор',
  'tasks.kind.workflow': 'Рабочий процесс',
  'workflow.graph.waiting': 'Ожидание первого запуска агента…',
  'workflow.graph.notRecorded':
    'Для этого запуска граф выполнения не сохранён.',
  'workflow.inline.loading':
    'Загрузка выполнения рабочего процесса в реальном времени…',
  'workflow.inline.unavailable':
    'Этот запуск рабочего процесса больше недоступен в текущей сессии.',
  'workflow.graph.omitted': (v) =>
    `Граф ограничен ради производительности: пропущены ${v?.lanes ?? 0} ${ruPlural(v?.lanes, 'фаза', 'фазы', 'фаз')}, ${v?.nodes ?? 0} ${ruPlural(v?.nodes, 'агент', 'агента', 'агентов')} и ${v?.edges ?? 0} ${ruPlural(v?.edges, 'связь', 'связи', 'связей')}.`,
  'workflow.noPhase': 'Без фазы',
  'workflow.phase.notStarted': 'Не начата',
  'workflow.dispatchCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'запуск', 'запуска', 'запусков')}`,
  'workflow.selectedDispatch': 'Выбранный запуск',
  'workflow.dependencies': 'Зависит от',
  'workflow.action.pause': 'Пауза',
  'workflow.action.resume': 'Продолжить',
  'workflow.action.retry': 'Повторить сбойный путь',
  'workflow.action.rerun': 'Перезапустить всё',
  'workflow.action.unavailable':
    'Состояние рабочего процесса изменилось до действия.',
  'workflow.action.argsUnavailable':
    'Перезапуск невозможен: в истории нет аргументов, с которыми он был запущен.',
  'workflow.action.failed': 'Не удалось обновить рабочий процесс.',
  'workflow.history.retry': (v) => `Повторён с ${v?.runId ?? ''}`,
  'workflow.history.rerun': (v) => `Перезапущен с ${v?.runId ?? ''}`,
  'workflow.history.cached': (v) => `${v?.count ?? 0} из кэша`,
  'workflow.history.saved': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сохранённый запуск', 'сохранённых запуска', 'сохранённых запусков')}`,
  'workflow.history.restored': 'Сохранённый запуск',
  'workflow.history.showRuns': (v) => `История запусков (${v?.count ?? 0})`,
  'workflow.history.hideRuns': 'Скрыть историю',
  'workflow.history.filter': 'Фильтр запусков',
  'workflow.history.filterAll': 'Все статусы',
  'workflow.history.visibleCount': (v) =>
    `${v?.count ?? 0} из ${v?.total ?? 0}`,
  'workflow.history.filterEmpty':
    'Нет сохранённых запусков, подходящих под этот фильтр.',
  'workflow.history.exportVisible': 'Экспортировать видимые',
  'workflow.history.delete': 'Удалить',
  'workflow.history.deleteSaved': 'Удалить сохранённый запуск',
  'workflow.history.confirmDelete': 'Подтвердить удаление',
  'workflow.history.deleteUnavailable': 'Сохранённый запуск больше недоступен.',
  'workflow.history.deleteFailed': 'Не удалось удалить сохранённый запуск.',
  'workflow.history.compareRun': (v) => `Сравнить запуск ${v?.runId ?? ''}`,
  'workflow.history.compare': 'Сравнить запуски',
  'workflow.history.hideComparison': 'Скрыть сравнение',
  'workflow.history.source': 'Исходный запуск',
  'workflow.history.compared': 'Сравниваемый запуск',
  'workflow.history.current': 'Текущий запуск',
  'workflow.history.status': 'Статус',
  'workflow.history.agents': 'Агенты',
  'workflow.approvalNeeded': 'Нужно одобрение',
  'workflow.respondInChat': 'Ответить в чате',
  'workflow.metric.agents': 'агенты',
  'workflow.metric.running': 'выполняется',
  'workflow.metric.queued': 'в очереди',
  'workflow.metric.tokens': 'токены',
  'workflow.dispatch.queued': 'В очереди',
  'workflow.dispatch.running': 'Выполняется',
  'workflow.dispatch.completed': 'Завершено',
  'workflow.dispatch.failed': 'Ошибка',
  'workflow.dispatch.cancelled': 'Отменено',
  'workflow.dispatch.cached': 'Из кэша',
  'tasks.action.stop': 'Остановить',
  'tasks.action.abandon': 'Отказаться',
  'tasks.action.confirmStop': 'Подтвердить остановку',
  'tasks.action.confirmAbandon': 'Подтвердить отказ',
  'tasks.action.confirmHint': 'Это завершит блокирующий ход.',
  'tasks.pill.agent': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'локальный агент', 'локальных агента', 'локальных агентов')}`,
  'tasks.pill.agents': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'локальный агент', 'локальных агента', 'локальных агентов')}`,
  'tasks.pill.session': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'другой сеанс', 'других сеанса', 'других сеансов')}`,
  'tasks.pill.sessions': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'другой сеанс', 'других сеанса', 'других сеансов')}`,
  'tasks.pill.sessionWaiting': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сеанс ждёт', 'сеанса ждут', 'сеансов ждут')} вашего ответа`,
  'tasks.waitingForInput': 'Ждёт вашего ответа',
  'user.sentFrom': (v) => `Из ${v?.workspace ?? ''} · ${v?.session ?? ''}`,
  'user.sentTo': (v) => `В ${v?.workspace ?? ''} · ${v?.session ?? ''}`,
  'tasks.pill.monitor': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'монитор', 'монитора', 'мониторов')}`,
  'tasks.pill.monitors': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'монитор', 'монитора', 'мониторов')}`,
  'tasks.pill.shell': (v) => `${v?.count ?? 0} shell`,
  'tasks.pill.shells': (v) => `${v?.count ?? 0} shell`,
  'tasks.pill.workflow': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'рабочий процесс', 'рабочих процесса', 'рабочих процессов')}`,
  'tasks.pill.workflows': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'рабочий процесс', 'рабочих процесса', 'рабочих процессов')}`,
  'tasks.confirmStop':
    'ещё раз x, чтобы подтвердить остановку · завершит блокирующий ход',
  'tasks.shortcut.select': '↑/↓ выбрать',
  'tasks.shortcut.view': 'Enter открыть',
  'tasks.shortcut.stop': 'x остановить',
  'tasks.shortcut.abandon': 'x отказаться',
  'tasks.shortcut.listClose': '←/Esc закрыть',
  'tasks.shortcut.detailBack': '← назад',
  'tasks.shortcut.detailClose': 'Esc/Enter/Space закрыть',
  'tasks.shortcut.close': 'Esc закрыть',
  'tasks.shortcut.cancelConfirm': 'Esc отмена',
  'tasks.detail.workingDir': 'Рабочий каталог',
  'tasks.detail.outputFile': 'Файл вывода',
  'tasks.detail.startedAt': 'Начало',
  'tasks.detail.endedAt': 'Конец',
  'tasks.detail.totalDuration': 'Общая длительность',
  'tasks.detail.residentMemory': 'Резидентная память',
  'tasks.detail.output': 'Вывод',
  'tasks.detail.outputSize': (v) => `: ${v?.size ?? ''}`,
  'tasks.detail.outputEmpty': 'Вывода пока нет',
  'tasks.detail.outputNone': 'Нет вывода',
  'tasks.detail.runtimeUnavailable': 'Сведения о задаче больше недоступны',
  'tasks.detail.outputPartial':
    'Вывод доступен, но сведения о файле прочитать не удалось',
  'tasks.detail.outputRefreshFailed': 'Не удалось обновить вывод. ',
  'tasks.detail.outputTruncated': 'Показан только конец',
  'tasks.detail.outputUnavailable': 'Вывод недоступен',
  'tasks.detail.lastWrite': 'Последняя запись',
  'tasks.detail.command': 'Команда',
  'tasks.detail.events': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'событие', 'события', 'событий')}`,
  'tasks.detail.exit': (v) => `код выхода ${v?.exitCode ?? ''}`,
  'tasks.detail.dropped': (v) => `${v?.count ?? 0} отброшено`,
  'tasks.detail.error': 'Ошибка',
  'tasks.detail.stoppedBecause': 'Остановлено, потому что',
  'tasks.detail.resumeBlocked': 'Возобновление заблокировано',
  'tasks.detail.progress': 'Прогресс',
  'tasks.detail.prompt': 'Промпт',
  'tasks.detail.type': 'Тип',
  'tasks.detail.runtime': 'Время',
  'tasks.detail.eventCount': 'События',
  'tasks.detail.pid': 'PID',
  'tasks.detail.lastEvent': 'Последнее событие',
  'tasks.detail.droppedCount': 'Отброшено',
  'tasks.detail.exitCode': 'Код выхода',
  'tasks.detail.tokenCount': 'Токены',
  'tasks.detail.toolCallCount': 'Вызовы инструментов',
  'tasks.detail.tokens': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'токен', 'токена', 'токенов')}`,
  'tasks.detail.toolCalls': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'вызов инструмента', 'вызова инструмента', 'вызовов инструментов')}`,
  'tasks.detail.nesting': 'Вложенность',
  'tasks.detail.nestingValue': (v) =>
    `Уровень ${v?.level ?? '?'} · из ${v?.parent ?? '?'}`,
  'tasks.detail.nestingLevel': (v) => `Уровень ${v?.level ?? '?'}`,
  'tasks.row.from': (v) => `из ${v?.parent ?? '?'}`,
  'tasks.row.nested': 'вложенная',
  'tips.items':
    'Введите /, чтобы увидеть все доступные команды.|Используйте @, чтобы ссылаться на пути к файлам.|Нажмите Esc, чтобы отменить текущий запрос.|Shift+Enter — новая строка.|Нажмите ↑↓, чтобы листать историю сообщений.',
  'tools.available': 'Доступные инструменты:',
  'tools.none': 'Нет доступных инструментов.',
  'tools.empty': 'Встроенные инструменты недоступны. Сначала откройте сессию.',
  'tools.footer': (v) =>
    v?.name
      ? `${v?.details ? 'Enter/Space — подробности · ' : ''}t — переключить ${v.name} · r — обновить · Esc — закрыть`
      : 'r — обновить · Esc — закрыть',
  'tools.details.hide': 'Скрыть подробности',
  'tools.details.show': 'Показать подробности',
  'tools.description': 'Описание',
  'tools.details': 'Сведения об инструменте',
  'tools.loading': 'Загрузка инструментов...',
  'tools.name': 'Имя инструмента',
  'tools.noDescription': 'Нет описания',
  'tools.noMatches': 'Нет подходящих инструментов.',
  'tools.search': 'Поиск инструментов…',
  'tools.status': 'Статус',
  'tools.status.disabled': 'отключён',
  'tools.status.enabled': 'включён',
  'tools.summary': (v) => `${v?.enabled ?? 0}/${v?.total ?? 0} включено`,
  'tools.title': 'Инструменты',
  'tools.update.disable': 'Отключить',
  'tools.update.enable': 'Включить',
  'tools.updating': 'Обновление...',
  'tool.collapse': '▲ Свернуть',
  'tool.expand': 'Развернуть',
  'tool.viewFile': 'Открыть файл',
  'tool.viewImage': 'Открыть изображение',
  'tool.viewCurrentFile': 'Открыть текущий файл',
  'tool.collapseHint': 'Свернуть',
  'tool.status.failed': 'Ошибка',
  'toolGroup.moreKinds': (v) => ` +${v?.count ?? 0}`,
  'toolGroup.summary': (v) =>
    `Выполнено ${v?.count ?? 0} ${ruPlural(v?.count, 'инструмент', 'инструмента', 'инструментов')}`,
  'toolGroup.summary.ranAgents': (v) =>
    `Запущено ${v?.count ?? 0} ${ruPlural(v?.count, 'агент', 'агента', 'агентов')}`,
  'toolGroup.summary.editedFiles': (v) =>
    `Файлы изменены ${v?.count ?? 0} ${ruPlural(v?.count, 'раз', 'раза', 'раз')}`,
  'toolGroup.summary.ranCommands': (v) =>
    `Выполнено ${v?.count ?? 0} ${ruPlural(v?.count, 'команда', 'команды', 'команд')}`,
  'toolGroup.summary.readFiles': (v) =>
    `Файлы прочитаны ${v?.count ?? 0} ${ruPlural(v?.count, 'раз', 'раза', 'раз')}`,
  'toolGroup.summary.searched': (v) =>
    `Поиск выполнен ${v?.count ?? 0} ${ruPlural(v?.count, 'раз', 'раза', 'раз')}`,
  'toolGroup.summary.updatedTodos': (v) =>
    Number(v?.count ?? 0) === 1
      ? 'Обновлён список задач'
      : `Список задач обновлён ${v?.count ?? 0} ${ruPlural(v?.count, 'раз', 'раза', 'раз')}`,
  'toolGroup.summary.provideInformation': 'Предоставить сведения',
  'toolGroup.summary.askedQuestions': (v) =>
    `Задано ${v?.count ?? 0} ${ruPlural(v?.count, 'вопрос', 'вопроса', 'вопросов')}`,
  'toolGroup.summary.otherTools': (v) =>
    `Вызвано ${v?.count ?? 0} ${ruPlural(v?.count, 'другой инструмент', 'других инструмента', 'других инструментов')}`,
  'toolGroup.running': (v) =>
    Number(v?.count ?? 0) > 1
      ? `Выполняются ${v?.count ?? 0} ${ruPlural(v?.count, 'инструмент', 'инструмента', 'инструментов')}: ${v?.name ?? 'инструмент'}`
      : `Выполняется ${v?.name ?? 'инструмент'}`,
  'toolGroup.runningPrefix': 'Выполняется',
  'thinking.expand': 'Развернуть размышление',
  'thinking.collapse': 'Свернуть размышление',
  'thinking.running': (v) =>
    `Размышление${v?.duration ? ` ${v.duration}` : ''}`,
  'thinking.doneBriefly': 'Кратко подумал',
  'thinking.done': (v) =>
    v?.duration ? `Размышлял ${v.duration}` : 'Размышление завершено',
  'thinking.translate': 'Перевести',
  'thinking.translation': 'Переведённое размышление',
  'thinking.translating': 'Перевод...',
  'thinking.translationThinking': 'Размышление...',
  'thinking.translationFailed': 'Не удалось перевести',
  'thinking.retranslate': 'Перевести снова',
  'thinking.cancelTranslation': 'Отмена',
  'thinking.closeTranslation': 'Закрыть',
  'thinking.inputTokens': (v) => `Входные токены: ${v?.count ?? '--'}`,
  'thinking.outputTokens': (v) => `Выходные токены: ${v?.count ?? '--'}`,
  'sessionsOverview.current': 'Текущая',
  'sessionsOverview.empty': 'Сессий пока нет',
  'sessionsOverview.loadFailed': 'Не удалось загрузить сессии',
  'sessionsOverview.loading': 'Загрузка сессий…',
  'sessionsOverview.noData': 'Нет данных',
  'sessionsOverview.openInSplit': 'Открыть в разделении',
  'sessionsOverview.openInSplitHint':
    'Показать выбранные сессии рядом в этом окне',
  'sessionsOverview.splitLimit': (v) =>
    `Выберите не больше ${v?.max ?? 6} ${ruPlural(v?.max, 'сессии', 'сессий', 'сессий')}, чтобы открыть их вместе`,
  'sessionsOverview.openInTab': 'Открыть в новой вкладке',
  'sessionsOverview.openInTabHint':
    'Открыть выбранные сессии разделённым видом в новой вкладке браузера',
  'sessionsOverview.popupBlocked':
    'Всплывающие окна заблокированы. Разрешите их для этого сайта, чтобы открывать сессии в новых вкладках.',
  'sessionsOverview.refresh': 'Обновить',
  'sessionsOverview.selectAll': 'Выбрать все',
  'sessionsOverview.titleColumn': 'Название',
  'sessionsOverview.actions': 'Действия',
  'sessionsOverview.time': 'Время',
  'sessionsOverview.selectedRows': (v) =>
    `Выбрано ${v?.count ?? 0} из ${v?.total ?? 0} ${ruPlural(v?.total, 'строки', 'строк', 'строк')}.`,
  'sessionsOverview.previousPage': 'Назад',
  'sessionsOverview.nextPage': 'Далее',
  'sessionsOverview.pageInfo': (v) =>
    `Страница ${v?.page ?? 0} из ${v?.total ?? 0}`,
  'sessionsOverview.rowsPerPage': 'Строк на странице',
  'sessionsOverview.workspaceFilter': 'Фильтр по рабочей области',
  'sessionsOverview.allWorkspaces': 'Все',
  'sessionsOverview.searchPlaceholder': 'Поиск по названию, ветке, PR или ID…',
  'sessionsOverview.workspaceAll': 'Все рабочие области',
  'sessionsOverview.workspacesSelected': (v) =>
    `${v?.count ?? 0}/${v?.total ?? 0} ${ruPlural(v?.count, 'рабочая область', 'рабочие области', 'рабочих областей')}`,
  'sessionsOverview.statusColumn': 'Статус',
  'sessionsOverview.statusFilter': 'Фильтр по статусу сессии',
  'sessionsOverview.filter.all': 'Все',
  'sessionsOverview.filter.attention': 'Требует внимания',
  'sessionsOverview.filter.running': 'Выполняется',
  'sessionsOverview.filter.idle': 'Ожидание',
  'sessionsOverview.status.idle': 'Ожидание',
  'sessionsOverview.details': (v) => `Сведения о ${v?.name ?? ''}`,
  'sessionsOverview.sessionCount': (v) =>
    `${v?.total ?? 0} ${ruPlural(v?.total, 'сессия', 'сессии', 'сессий')}`,
  'sessionsOverview.confirmArchiveTitle': 'Архивировать сессию?',
  'sessionsOverview.confirmArchive': (v) =>
    `«${v?.name ?? ''}» будет перенесена в архив сессий.`,
  'sessionsOverview.confirmArchiveBulkTitle': (v) =>
    `Архивировать ${v?.count ?? 0} ${ruPlural(v?.count, 'сессию', 'сессии', 'сессий')}?`,
  'sessionsOverview.confirmArchiveBulk': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'выбранная сессия будет перенесена', 'выбранные сессии будут перенесены', 'выбранных сессий будут перенесены')} в архив сессий.`,
  'sessionsOverview.confirmDeleteTitle': 'Удалить сессию?',
  'sessionsOverview.confirmDelete': (v) =>
    `«${v?.name ?? ''}» и её история диалога будут удалены безвозвратно. Это нельзя отменить.`,
  'sessionsOverview.deleteFailed': 'Не удалось удалить сессию',
  'sessionsOverview.archiveFailed': 'Не удалось архивировать сессию',
  'sessionsOverview.actionUnavailable':
    'Это действие недоступно для выбранной сессии или рабочей области',
  'sessionsOverview.bulkArchive': 'Архивировать',
  'sessionsOverview.bulkArchiveHint': (v) =>
    `Архивировать ${v?.count ?? 0} ${ruPlural(v?.count, 'выбранную сессию', 'выбранные сессии', 'выбранных сессий')}`,
  'sessionsOverview.bulkDelete': 'Удалить',
  'sessionsOverview.bulkDeleteHint': (v) =>
    `Удалить ${v?.count ?? 0} ${ruPlural(v?.count, 'выбранную сессию', 'выбранные сессии', 'выбранных сессий')}`,
  'sessionsOverview.confirmDeleteBulkTitle': (v) =>
    `Удалить ${v?.count ?? 0} ${ruPlural(v?.count, 'сессию', 'сессии', 'сессий')}?`,
  'sessionsOverview.confirmDeleteBulk': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'выбранная сессия и её история диалога будут удалены', 'выбранные сессии и их история диалога будут удалены', 'выбранных сессий и их история диалога будут удалены')} безвозвратно. Это нельзя отменить.`,
  'sessionsOverview.selectSession': (v) => `Выбрать ${v?.name ?? ''}`,
  'sessionsOverview.status.askUserQuestion': 'Нужен ввод пользователя',
  'sessionsOverview.status.needsApproval': 'Нужно одобрение',
  'sessionsOverview.status.running': 'Выполняется',
  'sessionsOverview.title': 'Обзор сессий',
  'workspacesOverview.title': 'Рабочие области',
  'workspacesOverview.count': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'рабочая область', 'рабочие области', 'рабочих областей')}`,
  'workspacesOverview.column.name': 'Имя',
  'workspacesOverview.column.path': 'Путь',
  'workspacesOverview.column.sessions': 'Сессии',
  'workspacesOverview.column.mcp': 'MCP',
  'workspacesOverview.column.git': 'Ветка',
  'workspacesOverview.column.lastActivity': 'Последняя активность',
  'workspacesOverview.column.actions': 'Действия',
  'workspacesOverview.primaryBadge': 'основная',
  'workspacesOverview.running': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'выполняется', 'выполняются', 'выполняются')}`,
  'workspacesOverview.attention': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'требует внимания', 'требуют внимания', 'требуют внимания')}`,
  'workspacesOverview.truncated':
    'Сессий больше, чем на одной странице; счётчики — нижняя граница.',
  'workspacesOverview.dirty': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'изменение', 'изменения', 'изменений')}`,
  'workspacesOverview.mcpFailed': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'ошибка', 'ошибки', 'ошибок')}`,
  'workspacesOverview.newTask': 'Новая сессия',
  'workspacesOverview.trust': 'Доверять',
  'workspacesOverview.trusting': 'Выдача доверия…',
  'workspacesOverview.trustFailed': 'Не удалось выдать доверие рабочей области',
  'workspacesOverview.remove': 'Удалить рабочую область',
  'workspacesOverview.back': 'Назад',
  'splitView.title': 'Разделённый вид',
  'splitView.count': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'панель', 'панели', 'панелей')}`,
  'splitView.addPane': 'Добавить сессию',
  'splitView.closePane': 'Закрыть панель',
  'splitView.maximizePane': 'Развернуть панель',
  'splitView.restorePane': 'Восстановить панель',
  'splitView.morePaneActions': 'Другие действия панели',
  'splitView.defaultActionLabel': 'Действие',
  'splitView.paneError': 'В этой панели сессии произошла ошибка',
  'splitView.paneConnectionError': 'Соединение потеряно',
  'splitView.outerApprovalPending': 'Основная сессия ожидает одобрения.',
  'splitView.goToApproval': 'Перейти к ней',
  'splitView.pendingCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'ожидает ввода', 'ожидают ввода', 'ожидают ввода')}`,
  'splitView.nextPending': 'Перейти к следующей сессии, ожидающей ввода',
  'splitView.noOtherSessions': 'Других сессий нет',
  'splitView.empty': 'В разделении нет сессий. Добавьте одну, чтобы начать.',
  'splitView.composerPlaceholder': 'Сообщение этой сессии…',
  'channels.title': 'Каналы',
  'channels.description':
    'Подключите Qwen Code к местам, где уже работает ваша команда.',
  'channels.summary': (v) =>
    `${v?.workspace ?? ''} · настроено ${v?.count ?? 0}`,
  'channels.workspace.current': 'Текущая рабочая область',
  'channels.workspace.label': 'Рабочая область',
  'channels.workspace.primary': 'Основная',
  'channels.loading': 'Загрузка каналов',
  'channels.configuredCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'настроенный канал', 'настроенных канала', 'настроенных каналов')}`,
  'channels.configured': 'Настроенные каналы',
  'channels.configured.description':
    'Управляйте ботами, которые принимают и доставляют сообщения этой рабочей области.',
  'channels.availablePlatforms': 'Доступные платформы',
  'channels.availablePlatforms.description':
    'Выберите платформу, чтобы добавить ещё одно подключение к этой рабочей области.',
  'channels.platform.available': 'Доступна',
  'channels.platform.configure': 'Настроить',
  'channels.platform.add': 'Добавить подключение',
  'channels.platform.name.dingtalk': 'DingTalk',
  'channels.platform.name.feishu': 'Feishu',
  'channels.platform.name.wecom': 'WeCom',
  'channels.platform.name.generic-webhook': 'Generic Webhook',
  'channels.method.title': (v) =>
    `Выберите подключение ${v?.platform ?? 'канала'}`,
  'channels.method.description': (v) =>
    `Выберите, как этот канал подключается к ${v?.platform ?? 'платформе'}.`,
  'channels.method.applicationBot': 'Бот приложения',
  'channels.method.applicationBot.description':
    'Принимать сообщения и отвечать через бота приложения.',
  'channels.method.intelligentBot': 'Интеллектуальный бот',
  'channels.method.intelligentBot.description':
    'Принимать сообщения и отвечать через интеллектуального бота.',
  'channels.method.webhook': 'Webhook (только отправка)',
  'channels.method.webhook.description':
    'Отправлять уведомления в группу, заданную webhook пользовательского бота.',
  'channels.status.readyToSend': 'Готов к отправке',
  'channels.statusDescription.readyToSend':
    'Локально готов. Удалённые учётные данные проверяются при отправке.',
  'channels.statusDescription.notReadyToSend':
    'Не готов отправлять уведомления.',
  'channels.statusDescription.outbound':
    'Отправляет уведомления в настроенное назначение.',
  'channels.platform.configureNamed': (v) =>
    `Настроить ${v?.platform ?? 'канал'}`,
  'channels.status.stopped': 'Остановлен',
  'channels.status.starting': 'Запуск',
  'channels.status.connected': 'Подключён',
  'channels.status.partial': 'Частично подключён',
  'channels.status.error': 'Ошибка',
  'channels.statusDescription.stopped': 'Офлайн и не принимает сообщения.',
  'channels.statusDescription.starting': 'Сейчас подключается к платформе.',
  'channels.statusDescription.connected': 'Онлайн и готов принимать сообщения.',
  'channels.statusDescription.partial':
    'Подключён, но часть возможностей недоступна.',
  'channels.statusDescription.error':
    'Нужно внимание, прежде чем можно будет подключиться.',
  'channels.startsWithServe': 'Подключать при запуске Qwen Code',
  'channels.startsWithServe.description':
    'Автоматически выводить этот канал в онлайн после запуска Qwen Code.',
  'channels.unsupported.title': 'Управление каналами не поддерживается',
  'channels.unsupported.description':
    'Обновите Qwen Code до версии, которая поддерживает управление каналами.',
  'channels.readOnly.title': 'Управление каналами только для чтения',
  'channels.readOnly.description':
    'Перезапустите Qwen Code с bearer-токеном, чтобы управлять каналами.',
  'channels.loadError.title': 'Не удалось загрузить каналы',
  'channels.empty.title': 'Поддерживаемые каналы не настроены',
  'channels.empty.description':
    'Настройте WeChat, DingTalk, WeCom, Feishu, GitHub, GitLab или Email, чтобы принимать сообщения в этой рабочей области.',
  'channels.runtimeError': 'Ошибка среды выполнения канала',
  'channels.action.back': 'Назад',
  'channels.action.refresh': 'Обновить',
  'channels.action.start': 'Запустить',
  'channels.action.stop': 'Остановить',
  'channels.action.restart': 'Перезапустить',
  'channels.action.retry': 'Повторить',
  'channels.action.edit': 'Изменить',
  'channels.action.editNamed': (v) => `Изменить ${v?.name ?? 'канал'}`,
  'channels.action.moreNamed': (v) =>
    `Другие действия для ${v?.name ?? 'канала'}`,
  'channels.action.delete': 'Удалить',
  'channels.action.deleteNamed': (v) => `Удалить ${v?.name ?? 'канал'}`,
  'channels.action.startWithServeNamed': (v) =>
    `Запускать ${v?.name ?? ''} вместе с serve`,
  'channels.delete.title': (v) => `Удалить ${v?.name ?? 'канал'}?`,
  'channels.delete.description':
    'Канал будет остановлен и удалён из этой рабочей области. Это действие нельзя отменить.',
  'channels.delete.error': 'Канал не был удалён',
  'channels.editor.addTitle': (v) => `Настроить ${v?.platform ?? 'канал'}`,
  'channels.editor.editTitle': (v) => `Изменить ${v?.platform ?? 'канал'}`,
  'channels.editor.addDescription':
    'Подключите зарегистрированную рабочую область к существующему приложению платформы.',
  'channels.editor.editDescription':
    'Обновите открытые настройки или явно смените сохранённые учётные данные.',
  'channels.editor.section.identity': 'Идентификация',
  'channels.editor.section.credentials': 'Учётные данные',
  'channels.editor.section.connection': 'Подключение',
  'channels.editor.section.routing': 'Уведомления и маршрутизация',
  'channels.editor.section.boundSessions': 'Сессии, привязанные к PR',
  'channels.editor.section.boundSessions.description':
    'События наблюдения применяются к PR, привязанным к живой сессии. Сначала включите доставку, затем выберите переходы для наблюдения.',
  'channels.editor.section.session': 'Управление диалогами',
  'channels.editor.section.access': 'Контроль доступа',
  'channels.editor.section.access.description':
    'Настройте доступ личных сообщений и групп отдельно.',
  'channels.editor.section.advanced': 'Расширенные настройки',
  'channels.editor.section.advanced.description':
    'Редко меняемые параметры подключения, маршрутизации и поведения сессий.',
  'channels.editor.section.advanced.configuredCount': (v) =>
    `${v?.count ?? 0} настроено`,
  'channels.editor.session.isolation': 'Изоляция диалогов',
  'channels.editor.instanceName': 'Имя экземпляра',
  'channels.editor.instanceNamePlaceholder': 'напр. release-bot',
  'channels.editor.workspace': 'Рабочая область',
  'channels.editor.workspace.description':
    'Сообщения, сессии и настройки канала принадлежат этой рабочей области. По умолчанию выбрана основная.',
  'channels.editor.workspace.lockedDescription':
    'Настроенный канал остаётся привязанным к своей рабочей области. Создайте другой экземпляр, чтобы использовать другую.',
  'channels.editor.environmentReference': 'Поддерживается $ENV_VAR',
  'channels.editor.field.sessionScope': 'Область сессии',
  'channels.editor.field.sessionScope.description':
    'Определяет, какие входящие диалоги разделяют одну сессию агента.',
  'channels.editor.field.sessionScope.option.user': 'На пользователя и чат',
  'channels.editor.field.sessionScope.option.thread': 'На ветку',
  'channels.editor.field.sessionScope.option.chat_thread': 'На чат и ветку',
  'channels.editor.field.sessionScope.option.single': 'Одна общая сессия',
  'channels.qrLogin.title': 'Привязка по QR-коду',
  'channels.qrLogin.description':
    'Отсканируйте в мобильном приложении QQ, чтобы привязать бота. Секрет остаётся на этой машине.',
  'channels.qrLogin.start': 'Сканировать для привязки',
  'channels.qrLogin.refresh': 'Новый код',
  'channels.qrLogin.waiting': 'Подготовка QR-кода…',
  'channels.qrLogin.scanHint':
    'Откройте QQ на телефоне и отсканируйте этот код.',
  'channels.qrLogin.imageAlt': 'QR-код привязки бота QQ',
  'channels.qrLogin.bound':
    'Бот привязан. Канал теперь использует новые учётные данные.',
  'channels.qrLogin.failed': 'Привязка не удалась',
  'channels.qrLogin.expired': 'Код истёк. Запросите новый.',
  'channels.qrLogin.cancelled': 'Привязка отменена.',
  'channels.qrLogin.error': 'Не удалось завершить привязку по QR.',
  'channels.editor.field.dingtalk.clientId': 'Client ID (AppKey)',
  'channels.editor.field.dingtalk.clientSecret': 'Client Secret (AppSecret)',
  'channels.editor.field.webhook.webhookUrl': 'URL webhook',
  'channels.editor.field.webhook.webhookUrl.description':
    'Секретный адрес webhook вашего пользовательского бота.',
  'channels.editor.field.webhook.signingSecret': 'Секрет подписи',
  'channels.editor.field.webhook.signingSecret.description':
    'Нужен, если для пользовательского бота включена проверка подписи.',
  'channels.editor.field.genericWebhook.webhookUrl': 'URL webhook',
  'channels.editor.field.genericWebhook.webhookUrl.description':
    'HTTPS-адрес принимающего сервиса. Для локальных или частных адресов включите расширенную настройку ниже.',
  'channels.editor.field.genericWebhook.bearerToken': 'Токен Bearer',
  'channels.editor.field.genericWebhook.bearerToken.description':
    'Необязательный токен в заголовке Authorization. Оставьте пустым, если получателю не нужна аутентификация.',
  'channels.editor.field.genericWebhook.allowPrivateNetwork':
    'Разрешить локальные и частные адреса',
  'channels.editor.field.genericWebhook.networkDescription':
    'Сетевой доступ к этой конечной точке.',
  'channels.editor.field.genericWebhook.allowPrivateNetwork.description':
    'Разрешить обращения к локальным и частным адресам, в том числе по HTTP. localhost — хост или контейнер, где работает демон Qwen Code. Для публичных адресов по-прежнему требуется HTTPS.',
  'channels.editor.field.weixin.groupPolicy': 'Политика групп',
  'channels.editor.field.weixin.groupPolicy.description':
    'WeChat iLink Bot поддерживает только личные сообщения, поэтому группы остаются отключёнными.',
  'channels.editor.field.weixin.groupPolicy.option.disabled': 'Отключено',
  'channels.editor.field.weixin.allowedUsers':
    'Предварительно одобренные пользователи (необязательно)',
  'channels.editor.field.weixin.allowedUsers.description':
    'Оставьте пустым и одобряйте людей в разделе «Ожидающие запросы» ниже — одобрение запоминается. Заполняйте только чтобы заранее одобрить того, чей идентификатор пользователя платформы у вас уже есть (вида oAbCd…@im.wechat). Имя или ник WeChat здесь не совпадут и будут молча проигнорированы.',
  'channels.weixin.title': 'Аккаунт WeChat',
  'channels.weixin.description':
    'Войдите, отсканировав QR-код в WeChat. Этот аккаунт общий для всех каналов WeChat на этом демоне.',
  'channels.weixin.loggedIn': 'Вход выполнен',
  'channels.weixin.loggedOut': 'Вход не выполнен',
  'channels.weixin.login': 'Войти по QR-коду',
  'channels.weixin.relogin': 'Войти снова',
  'channels.weixin.logout': 'Выйти',
  'channels.weixin.refresh': 'Обновить QR-код',
  'channels.weixin.waiting': 'Отсканируйте QR-код в WeChat.',
  'channels.weixin.preparing': 'Подготовка нового QR-кода…',
  'channels.weixin.scanned': 'Отсканировано. Подтвердите на телефоне.',
  'channels.weixin.ready': 'WeChat подключён.',
  'channels.weixin.expired': 'QR-код истёк. Обновите, чтобы повторить.',
  'channels.weixin.error': 'Вход в WeChat не удался. Повторите попытку.',
  'channels.weixin.credentialsError':
    'WeChat подключён, но демон не смог сохранить учётные данные. Проверьте, что домашний каталог доступен для записи, и повторите попытку.',
  'channels.weixin.unsupported':
    'Этот демон не поддерживает вход в WeChat. Обновите демон или выполните «qwen channel configure-weixin» на хосте.',
  'channels.weixin.restartHint':
    'Уже запущенные каналы сохраняют предыдущий аккаунт, пока их не перезапустят.',
  'channels.weixin.userId': (v) => `ID пользователя: ${v?.id ?? ''}`,
  'channels.weixin.savedAt': (v) => `Вход выполнен в ${v?.time ?? ''}`,
  'channels.weixin.qrAlt': 'QR-код входа в WeChat',
  'channels.weixin.openUrl': 'Открыть URL входа',
  'channels.editor.field.wecom.botId': 'Bot ID',
  'channels.editor.field.wecom.secret': 'Bot Secret',
  'channels.editor.field.wecom.wsUrl': 'URL WebSocket',
  'channels.editor.field.feishu.clientId': 'App ID',
  'channels.editor.field.feishu.clientSecret': 'App Secret',
  'channels.editor.field.github.token': 'Персональный токен доступа',
  'channels.editor.field.github.token.description':
    'Необязательный классический PAT с областью «notifications». Переопределяет локальную аутентификацию gh',
  'channels.editor.field.github.token.localGhHint':
    'Выбрана локальная аутентификация gh. Токен здесь изменить нельзя, а сохранённый токен будет удалён при сохранении.',
  'channels.editor.field.github.allowedRepos': 'Разрешённые репозитории',
  'channels.editor.field.github.allowedRepos.description':
    'Полные имена репозиториев через запятую, например owner/repo.',
  'channels.editor.field.github.allowedRepos.placeholder': 'owner/repo',
  'channels.editor.field.gitlab.allowedRepos': 'Разрешённые проекты',
  'channels.editor.field.gitlab.allowedRepos.description':
    'Пути проектов через запятую, например group/subgroup/project.',
  'channels.editor.field.gitlab.allowedRepos.placeholder': 'group/project',
  'channels.editor.field.github.useLocalGh':
    'Использовать локальную аутентификацию GitHub CLI',
  'channels.editor.field.github.useLocalGh.description':
    'Явно повторно использовать вход gh на хосте демона, когда токен не задан',
  'channels.editor.field.github.baseUrl': 'Базовый URL API',
  'channels.editor.field.github.baseUrl.description':
    'Корень API GitHub Enterprise (напр. https://ghe.example.com/api/v3). Оставьте пустым для github.com',
  'channels.editor.field.github.pollInterval': 'Интервал опроса (мс)',
  'channels.editor.field.github.pollInterval.description':
    'Как часто проверять GitHub на новые уведомления. Оставьте пустым для 60000 (одна минута). Стабильный опрос поднимается до X-Poll-Interval конечной точки, если тот больше; это же задаёт темп наблюдения за PR, поэтому меньшее значение не ускорит обнаружение. При значении по умолчанию заголовок тоже 60 с.',
  'channels.editor.field.github.repositorySettings':
    'Настройки по репозиториям',
  'channels.editor.field.github.repositorySettings.description':
    'Каждый репозиторий из списка наследует настройки канала ниже, пока вы не переопределите их здесь.',
  'channels.editor.field.github.requireMention': 'Требовать упоминание',
  'channels.editor.field.github.requireMention.inheritOn':
    'Наследовать (требовать упоминание)',
  'channels.editor.field.github.requireMention.inheritOff':
    'Наследовать (отвечать без упоминания)',
  'channels.editor.field.github.requireMention.on': 'Требовать упоминание',
  'channels.editor.field.github.requireMention.off': 'Отвечать без упоминания',
  'channels.editor.field.github.repositorySenders': 'Кто может писать',
  'channels.editor.field.github.repositorySenders.inheritOpen':
    'Наследовать (кто угодно)',
  'channels.editor.field.github.repositorySenders.inheritAllowlist':
    'Наследовать (только белый список)',
  'channels.editor.field.github.repositorySenders.open': 'Кто угодно',
  'channels.editor.field.github.repositorySenders.allowlist':
    'Только белый список',
  'channels.editor.field.github.repositorySpeakers': 'Разрешённые авторы',
  'channels.editor.field.github.repositorySpeakers.placeholder': 'alice, bob',
  'channels.editor.field.github.repositorySpeakers.description':
    'Логины GitHub, которым разрешено запускать задачи в этом репозитории. Пустое значение означает никого.',
  'channels.editor.field.github.repositorySpeakers.inherited':
    'Логины GitHub, которым разрешено писать в этом репозитории. Оставьте пустым, чтобы использовать список канала.',
  'channels.editor.field.gitlab.repositorySpeakers.description':
    'Имена пользователей GitLab, которым разрешено запускать задачи в этом проекте. Пустое значение означает никого.',
  'channels.editor.field.gitlab.repositorySpeakers.inherited':
    'Имена пользователей GitLab, которым разрешено писать в этом проекте. Оставьте пустым, чтобы использовать список канала.',
  'channels.editor.field.github.retainedRepositorySettings.title':
    'Настройки репозиториев всё ещё применяются',
  'channels.editor.field.github.retainedRepositorySettings.description': (v) =>
    `Эти репозитории сохраняют собственные настройки авторов и упоминаний, хотя политика групп больше не использует белый список: ${v?.repositories ?? ''}. Верните политику групп на «Белый список», чтобы изменить их.`,
  'channels.editor.field.github.retainedRepositorySettings.disabled.title':
    'Настройки репозиториев сохранены, но не применяются',
  'channels.editor.field.github.retainedRepositorySettings.disabled.description':
    (v) =>
      `Политика групп — «Отключено», поэтому трафик репозиториев не обрабатывается. Эти репозитории сохраняют собственные настройки авторов и упоминаний и снова применятся, когда политика допустит групповой трафик: ${v?.repositories ?? ''}. Верните политику групп на «Белый список», чтобы изменить их.`,
  'channels.editor.field.github.groupPolicy': 'Политика групп',
  'channels.editor.field.github.groupPolicy.description':
    'Должно быть «Open», «Allowlist» или «Pairing», чтобы уведомления поступали',
  'channels.editor.field.github.reasonFilter': 'Фильтр причин',
  'channels.editor.field.github.reasonFilter.description':
    'Необязательно. Обрабатываются только уведомления с отмеченной причиной. Оставьте все причины неотмеченными, чтобы обрабатывать все.',
  'channels.editor.field.github.reasonFilter.option.mention':
    'mention — бота @упоминают',
  'channels.editor.field.github.reasonFilter.option.review_requested':
    'review_requested — бота или команду, в которой он состоит, попросили проверить pull request',
  'channels.editor.field.github.reasonFilter.option.assign':
    'assign — бот назначен на issue',
  'channels.editor.field.github.reasonFilter.option.author':
    'author — бот создал ветку обсуждения',
  'channels.editor.field.github.reasonFilter.option.comment':
    'comment — бот оставил комментарий в ветке',
  'channels.editor.field.github.reasonFilter.option.ci_activity':
    'ci_activity — завершился запуск рабочего процесса, который инициировал бот',
  'channels.editor.field.github.reasonFilter.option.manual':
    'manual — бот подписался на ветку из issue или pull request',
  'channels.editor.field.github.reasonFilter.option.state_change':
    'state_change — бот изменил состояние ветки, например закрыл issue',
  'channels.editor.field.github.reasonFilter.option.subscribed':
    'subscribed — бот следит за репозиторием',
  'channels.editor.field.github.reasonFilter.option.team_mention':
    'team_mention — @упоминают команду, в которой состоит бот',
  'channels.editor.field.github.reasonFilter.option.security_alert':
    'security_alert — GitHub нашёл уязвимость в репозитории',
  'channels.editor.field.github.reasonFilter.option.approval_requested':
    'approval_requested — бота попросили проверить и одобрить развёртывание',
  'channels.editor.field.github.reasonFilter.option.invitation':
    'invitation — бот принял приглашение участвовать в репозитории',
  'channels.editor.field.github.reasonFilter.option.member_feature_requested':
    'member_feature_requested — участники организации попросили включить функцию, например Copilot',
  'channels.editor.field.github.reasonFilter.option.security_advisory_credit':
    'security_advisory_credit — бота отметили за вклад в рекомендацию по безопасности',
  'channels.editor.field.github.repoFilterMode': 'Фильтр репозиториев',
  'channels.editor.field.github.repoFilterMode.description':
    'Фильтровать входящие уведомления по репозиторию. Уведомления о PR, привязанных к сессии, тоже фильтруются; только их события наблюдения за состоянием PR обходят фильтр.',
  'channels.editor.field.github.repoFilterMode.option.off':
    'Выкл. — все репозитории',
  'channels.editor.field.github.repoFilterMode.option.allowlist':
    'Белый список — только перечисленные репозитории',
  'channels.editor.field.github.repoFilterMode.option.blocklist':
    'Чёрный список — все, кроме перечисленных репозиториев',
  'channels.editor.field.github.repoFilter': 'Отфильтрованные репозитории',
  'channels.editor.field.github.repoFilter.description':
    'Имена owner/repo через запятую. Можно вставить URL репозитория или PR; при сохранении они сокращаются до owner/repo.',
  'channels.editor.field.github.deliverToBoundSessions':
    'Доставлять в сессии, привязанные к PR',
  'channels.editor.field.github.deliverToBoundSessions.description':
    'Доставлять события PR, привязанных к живой сессии, в эту сессию как промпт, а не в сессию канала. Требуется канал, которым управляет демон.',
  'channels.editor.field.github.requireBoundWatch':
    'Требовать активное наблюдение для сессий review/verify',
  'channels.editor.field.github.requireBoundWatch.description':
    'Доставлять события в сессии review/verify, привязанные к PR, только пока у них активно наблюдение за этим PR (наблюдение /autofix-pr или /verify-pr --watch). Одноразовые сессии /review и /verify-pr остаются привязанными, но ничего не получают; события без подходящей сессии завершаются скрыто, без публичного ответа. Требуется «Доставлять в сессии, привязанные к PR». Неизвестное состояние наблюдения (сбой обнаружения) продолжает доставку.',
  'channels.editor.field.github.requireBoundWatch.disabledHint':
    'Включите «Доставлять в сессии, привязанные к PR» выше, чтобы требовать активное наблюдение.',
  'channels.editor.field.github.prCommentWatch':
    'Наблюдение за комментариями PR',
  'channels.editor.field.github.prCommentWatch.description':
    'Опрашивать комментарии обсуждения и встроенные замечания рецензии в том же аккаунте на привязанных PR и доставлять каждый новый во все привязанные сессии, которые его не отправили. Включено по умолчанию; выключите, чтобы отключить. Требуется «Доставлять в сессии, привязанные к PR».',
  'channels.editor.field.github.prWatchEvents': 'События наблюдения за PR',
  'channels.editor.field.github.prWatchEvents.description':
    'Устарело. Демон теперь сам обнаруживает переходы состояния PR: настройте serve.sessionPrWatch в параметрах демона. В течение одного minor-релиза ключ принимается и читается как псевдоним для хоста для PR на веб-хосте этого канала, пока этот параметр не задан и включено «Доставлять в сессии, привязанные к PR».',
  'channels.editor.field.github.prWatchEvents.disabledHint':
    'Включите «Доставлять в сессии, привязанные к PR» выше, чтобы выбрать события наблюдения.',
  'channels.editor.field.github.prWatchEvents.option.ci_failure':
    'ci_failure — проверки CI становятся красными на head-коммите',
  'channels.editor.field.github.prWatchEvents.option.merge_conflict':
    'merge_conflict — у PR появляется конфликт слияния',
  'channels.editor.field.github.prWatchEvents.option.head_change':
    'head_change — меняется head-коммит PR',
  'channels.editor.field.github.prWatchEvents.option.state_change':
    'state_change — PR слит или закрыт',
  'channels.editor.field.github.boundSessionActions':
    'Действия привязанных сессий',
  'channels.editor.field.github.boundSessionActions.description':
    'Необязательно. Шаблоны инструкций, доставляемые в сессии, привязанные к PR. Выберите ключ события ниже; префикс роли (review:, verify:, fix:) направляет только на эту роль привязки. Требуется «Доставлять в сессии, привязанные к PR». Каждая роль с подходящим ключом получает свою доставку; роли без ключа пропускают событие. Переменные: %repo%, %pr%, %url%, %title%, %event%, %sender%, %role%; %% для литерала %. Оставьте пустым для стандартного общего промпта.',
  'channels.editor.field.github.boundSessionActions.disabledHint':
    'Включите «Доставлять в сессии, привязанные к PR» выше, чтобы добавить шаблоны.',
  'channels.editor.field.github.boundSessionActions.group.any': 'Любая роль',
  'channels.editor.field.github.boundSessionActions.group.review':
    'review — сессии код-ревью',
  'channels.editor.field.github.boundSessionActions.group.verify':
    'verify — сессии проверки',
  'channels.editor.field.github.boundSessionActions.group.fix':
    'fix — сессии исправления',
  'channels.editor.field.github.boundSessionActions.empty':
    'Шаблоны ещё не настроены.',
  'channels.editor.field.github.boundSessionActions.addPlaceholder':
    'Добавить шаблон…',
  'channels.editor.field.gitlab.action_prompt_template.empty':
    'Шаблоны ещё не настроены.',
  'channels.editor.field.gitlab.action_prompt_template.addPlaceholder':
    'Добавить шаблон…',
  'channels.editor.record.addPlaceholder': 'Добавить запись…',
  'channels.editor.record.empty': 'Записи ещё не настроены.',
  'channels.editor.record.remove': (v) => `Удалить ${v?.key ?? ''}`,
  'channels.editor.field.gitlab.token': 'Персональный токен доступа',
  'channels.editor.field.gitlab.token.description':
    'PAT с областями «read_api» + «api»',
  'channels.editor.field.gitlab.baseUrl': 'URL экземпляра',
  'channels.editor.field.gitlab.baseUrl.description':
    'URL самостоятельно размещённого экземпляра (напр. https://gitlab.example.com). Оставьте пустым для gitlab.com',
  'channels.editor.field.gitlab.groupPolicy': 'Политика групп',
  'channels.editor.field.gitlab.groupPolicy.description':
    'Должно быть «Open», «Allowlist» или «Pairing», чтобы обрабатывать todos',
  'channels.editor.field.gitlab.action_prompt_template': 'Шаблоны действий',
  'channels.editor.field.gitlab.action_prompt_template.description':
    'Обрабатываются только действия с шаблоном; остальные пропускаются. Переменные шаблона: %project%, %project_url%, %author%, %target_type%, %iid%, %title%, %description%, %todo_id%. Используйте %% для литерала %. Пример для «mentioned»: Project: %project% | Author: %author% | Title: %title%',
  'channels.editor.field.gitlab.action_prompt_template.option.mentioned':
    'Упомянут — @bot в комментарии или описании',
  'channels.editor.field.gitlab.action_prompt_template.option.directly_addressed':
    'Прямое обращение — комментарий начинается с @bot',
  'channels.editor.field.gitlab.action_prompt_template.option.assigned':
    'Назначен — бот назначен на issue или MR',
  'channels.editor.field.gitlab.action_prompt_template.option.review_requested':
    'Запрошено ревью — бота запросили как рецензента MR',
  'channels.editor.field.gitlab.action_prompt_template.option.approval_required':
    'Требуется одобрение — MR требует одобрения бота',
  'channels.editor.field.gitlab.action_prompt_template.option.marked':
    'Отмечен — кто-то отметил звёздочкой комментарий, issue или MR бота',
  'channels.editor.field.gitlab.action_prompt_template.option.build_failed':
    'Сборка не удалась — конвейер CI/CD падает на ветке или MR бота',
  'channels.editor.field.gitlab.action_prompt_template.option.unmergeable':
    'Нельзя слить — MR становится несливаемым (конфликты)',
  'channels.editor.field.gitlab.action_prompt_template.option.merge_train_removed':
    'Убран из merge train — MR убран из очереди слияния',
  'channels.editor.field.email.address': 'Адрес почтового ящика',
  'channels.editor.field.email.imapHost': 'Хост IMAP',
  'channels.editor.field.email.imapUser': 'Имя пользователя IMAP',
  'channels.editor.field.email.imapPassword': 'Пароль IMAP',
  'channels.editor.field.email.smtpHost': 'Хост SMTP',
  'channels.editor.field.email.smtpUser': 'Имя пользователя SMTP',
  'channels.editor.field.email.smtpPassword': 'Пароль SMTP',
  'channels.editor.field.email.folder': 'Папка IMAP',
  'channels.editor.field.email.imapPort': 'Порт IMAP',
  'channels.editor.field.email.smtpPort': 'Порт SMTP',
  'channels.editor.field.email.imapSecure': 'Неявный TLS IMAP',
  'channels.editor.field.email.imapSecure.description':
    'Если отключено, STARTTLS обязателен.',
  'channels.editor.field.email.smtpSecure': 'Неявный TLS SMTP',
  'channels.editor.field.email.smtpSecure.description':
    'Если отключено, STARTTLS обязателен.',
  'channels.editor.field.email.proactiveRecipients':
    'Получатели проактивной почты',
  'channels.editor.field.email.proactiveRecipients.description':
    'Явные адреса без отображаемого имени. Пустое значение отключает проактивную почту.',
  'channels.editor.field.email.pollInterval': 'Интервал опроса (мс)',
  'channels.editor.field.email.maxMessageBytes':
    'Лимит размера сообщения (байты)',
  'channels.editor.field.email.maxAttachmentBytes':
    'Лимит размера вложения (байты)',
  'channels.editor.field.email.maxTextLength': 'Лимит символов текста',
  'channels.editor.field.email.allowedUsers':
    'Разрешённые адреса электронной почты',
  'channels.editor.field.email.allowedUsers.description':
    'Адреса почтовых ящиков без отображаемого имени через запятую, которым можно начинать личные диалоги.',
  'channels.editor.field.email.operators': 'Адреса операторов сессии',
  'channels.editor.field.email.operators.description':
    'Адреса почтовых ящиков без отображаемого имени через запятую, которым можно одобрять использование инструментов и выполнять /cancel, /clear или /loop в общих сессиях.',
  'channels.editor.secret.environment': 'Хранится в окружении',
  'channels.editor.secret.stored': 'Сохранено безопасно',
  'channels.editor.secret.preserve': 'Оставить',
  'channels.editor.secret.replace': 'Заменить',
  'channels.editor.secret.clear': 'Очистить',
  'channels.editor.secret.placeholder': (v) =>
    `Введите ${v?.label ?? 'секрет'}`,
  'channels.editor.secret.clearHint':
    'Эти учётные данные будут удалены при сохранении.',
  'channels.editor.field.shared.outputMode': 'Режим вывода',
  'channels.editor.field.shared.outputMode.description':
    'Выберите один итоговый результат для всей задачи, каждый полный ответ ассистента или последний ответ в каждом ходе. По умолчанию — за ход: основной ответ завершается независимо от фоновых продолжений. Применяется к карточкам и обычным сообщениям.',
  'channels.editor.field.shared.outputMode.option.per_task': 'За задачу',
  'channels.editor.field.shared.outputMode.option.per_response': 'За ответ',
  'channels.editor.field.shared.outputMode.option.per_turn':
    'За ход (по умолчанию)',
  'channels.editor.field.shared.privatePolicy': 'Политика личных сообщений',
  'channels.editor.field.dws.privatePolicy': 'Политика личных сообщений',
  'channels.editor.field.dws.privatePolicy.description':
    'Определяет, какие пользователи могут запускать задачи из личных сообщений, уведомлений о документах и нативных дел.',
  'channels.editor.field.shared.privatePolicy.description':
    'Выберите, кто может начать личный диалог с этим каналом.',
  'channels.editor.field.shared.privatePolicy.option.disabled': 'Отключено',
  'channels.editor.field.shared.privatePolicy.option.pairing': 'Сопряжение',
  'channels.editor.field.shared.privatePolicy.option.allowlist': 'Белый список',
  'channels.editor.field.shared.privatePolicy.option.open': 'Открыто',
  'channels.editor.field.shared.allowedUsers': 'Разрешённые ID пользователей',
  'channels.editor.field.shared.allowedUsers.description':
    'Стабильные ID пользователей через запятую, которым можно начинать личные диалоги без сопряжения.',
  'channels.editor.field.shared.groupPolicy': 'Политика групп',
  'channels.editor.field.shared.groupPolicy.description':
    'Выберите, какие групповые диалоги могут использовать этот канал.',
  'channels.editor.field.shared.groupPolicy.option.disabled': 'Отключено',
  'channels.editor.field.shared.groupPolicy.option.pairing': 'Сопряжение',
  'channels.editor.field.shared.groupPolicy.option.allowlist': 'Белый список',
  'channels.editor.field.shared.groupPolicy.option.open': 'Открыто',
  'channels.editor.field.shared.allowedGroupIds': 'Разрешённые ID групп',
  'channels.editor.field.shared.allowedGroupIds.description':
    'Стабильные ID чатов или репозиториев через запятую, которым разрешено использовать этот канал.',
  'channels.editor.field.shared.allowedGroupIds.placeholder':
    'group-a, group-b',
  'channels.editor.field.shared.groupSenders': 'Кто может писать в группах',
  'channels.editor.field.shared.groupSenders.description':
    'Применяется ко всем допущенным группам. Для одной группы задайте иначе в settings.json.',
  'channels.editor.field.shared.groupSenders.option.open':
    'Любой участник группы',
  'channels.editor.field.shared.groupSenders.option.allowlist':
    'Только перечисленные участники',
  'channels.editor.field.shared.groupAllowedUsers':
    'Разрешённые ID участников группы',
  'channels.editor.field.shared.groupAllowedUsers.description':
    'Стабильные ID пользователей через запятую, которым можно писать в группах. Отдельно от разрешённых ID для личных сообщений.',
  'channels.editor.field.shared.groupAllowedUsers.placeholder':
    'user-a, user-b',
  'channels.editor.field.shared.operators': 'Операторы сессии',
  'channels.editor.field.shared.operators.description':
    'ID пользователей через запятую, которым можно одобрять использование инструментов и выполнять /cancel, /clear или /loop в общих сессиях. Оставьте пустым, чтобы не выдавать права оператора общей сессии.',
  'channels.editor.field.shared.sessionScope': 'Изоляция диалогов',
  'channels.editor.field.shared.sessionScope.description':
    'Выберите, как диалоги разделяют постоянный контекст агента.',
  'channels.editor.field.shared.sessionScope.option.user': 'По пользователю',
  'channels.editor.field.shared.sessionScope.option.thread':
    'По ветке (устаревшее)',
  'channels.editor.field.shared.sessionScope.option.chat_thread':
    'По чату или ветке',
  'channels.editor.field.shared.sessionScope.option.single': 'Общая для всех',
  'channels.editor.field.shared.sessionScope.detail.user':
    'Сообщения одного пользователя продолжаются в одном диалоге; пользователи изолированы друг от друга.',
  'channels.editor.field.shared.sessionScope.detail.thread':
    'Сохраняет устаревшую маршрутизацию веток, которую используют существующие сессии канала.',
  'channels.editor.field.shared.sessionScope.detail.chat_thread':
    'Сообщения в одной группе или теме делят один диалог; лучше всего для совместной работы.',
  'channels.editor.field.shared.sessionScope.detail.single':
    'Все сообщения делят один диалог; лучше всего для дежурного канала одного бота.',
  'channels.editor.field.shared.multiSession': 'Именованные задачи',
  'channels.editor.field.shared.instructions': 'Инструкции',
  'channels.editor.field.shared.instructions.description':
    'Подсказки, добавляемые в контекст каждой сессии канала. Некоторые каналы при задании этого значения заменяют собственные инструкции по умолчанию.',
  'channels.editor.field.shared.multiSession.description':
    'Вести отдельный каталог именованных задач в области владельца в режиме, которым управляет демон.',
  'channels.editor.policy.disabled.title': 'Отключено',
  'channels.editor.policy.disabled.description': 'Отключить личные диалоги.',
  'channels.editor.policy.allowlist.title': 'Белый список',
  'channels.editor.policy.allowlist.description':
    'Только перечисленные пользователи могут начинать личные диалоги.',
  'channels.editor.policy.pairing.title': 'Сопряжение',
  'channels.editor.policy.pairing.description':
    'Люди получают код сопряжения и могут писать после вашего одобрения.',
  'channels.editor.pairing.title': 'Ожидающие запросы',
  'channels.editor.pairing.description':
    'Сверьте общий код перед одобрением доступа. Одобрения вступают в силу сразу; «Сохранить» и «Отмена» их не отменяют.',
  'channels.editor.pairing.subject.group': (v) =>
    `Группа: ${v?.name ?? 'Неизвестно'}`,
  'channels.editor.pairing.requestedBy': (v) =>
    `Запросил ${v?.sender ?? 'Неизвестно'}`,
  'channels.editor.pairing.refresh': 'Обновить запросы сопряжения',
  'channels.editor.pairing.approve': 'Одобрить',
  'channels.editor.pairing.approveFor': (v) =>
    `Одобрить ${v?.sender ?? 'запрос'}, код ${v?.code ?? ''}`,
  'channels.editor.pairing.approved': (v) =>
    `${v?.sender ?? 'Этот человек'} теперь может использовать этот канал.`,
  'channels.editor.pairing.error': 'Запросы сопряжения не обновлены',
  'channels.editor.pairing.unavailable':
    'Запросы сопряжения временно недоступны. Повторите попытку.',
  'channels.editor.pairing.retry': 'Повторить',
  'channels.editor.pairing.empty.title': 'Нет ожидающих запросов',
  'channels.editor.pairing.empty.description':
    'Новые запросы появляются здесь после того, как кто-то напишет боту.',
  'channels.editor.pairing.saveFirst.title':
    'Сначала сохраните режим сопряжения',
  'channels.editor.pairing.saveFirst.description':
    'Ожидающие запросы появятся здесь после сохранения этого канала в режиме сопряжения.',
  'channels.editor.pairing.approvals.title': 'Одобрения сопряжения',
  'channels.editor.pairing.approvals.description':
    'ID пользователей и групп, одобренные через сопряжение для этого канала.',
  'channels.editor.pairing.approvals.refresh': 'Обновить одобрения сопряжения',
  'channels.editor.pairing.approvals.revoke': 'Отозвать',
  'channels.editor.pairing.approvals.revokeFor': (v) =>
    `Отозвать ${v?.senderId ?? 'одобрение сопряжения'}`,
  'channels.editor.pairing.approvals.revoked': (v) =>
    `Одобрение сопряжения для ${v?.senderId ?? 'этого отправителя'} отозвано.`,
  'channels.editor.pairing.approvals.error':
    'Одобрения сопряжения не обновлены',
  'channels.editor.pairing.approvals.unavailable':
    'Одобрения сопряжения временно недоступны. Повторите попытку.',
  'channels.editor.pairing.approvals.empty.title': 'Нет одобрений сопряжения',
  'channels.editor.pairing.approvals.empty.description':
    'Одобренные ID пользователей и групп появятся здесь.',
  'channels.editor.pairing.approvals.confirm.title': (v) =>
    `Отозвать одобрение сопряжения для ${v?.senderId || 'этого отправителя'}?`,
  'channels.editor.pairing.approvals.confirm.description':
    'Будет удалено только одобрение, созданное через сопряжение. Доступ из белого списка канала не изменится.',
  'channels.editor.pairing.approvals.confirm.action': 'Отозвать одобрение',
  'channels.editor.pairing.allowlist.title': 'Настроенный белый список',
  'channels.editor.pairing.allowlist.description':
    'Пользователи из настроенного белого списка остаются допущенными после отзыва одобрения сопряжения.',
  'channels.editor.policy.open.title': 'Открыто',
  'channels.editor.policy.open.description':
    'Любой, кто может достучаться до бота, может начать диалог.',
  'channels.editor.validation.required': (v) =>
    `${v?.label ?? 'Это поле'} обязательно.`,
  'channels.editor.validation.credential':
    'Введите токен или включите локальную аутентификацию GitHub CLI.',
  'channels.editor.validation.duplicate':
    'Канал с таким именем уже существует.',
  'channels.editor.validation.invalidName': 'Выберите другое имя экземпляра.',
  'channels.editor.validation.invalidGroupId':
    'Введите ID группы, отличный от __proto__, constructor или prototype.',
  'channels.editor.validation.invalidRepoId':
    'Укажите каждый репозиторий как owner/repo.',
  'channels.editor.validation.invalidProjectPath':
    'Укажите каждый проект как путь, например group/subgroup/project.',
  'channels.editor.validation.conflictingRepoAliases':
    'Этот канал дважды перечисляет один репозиторий с разными настройками и разным написанием (например Owner/repo и owner/repo). Удалите одну из записей из settings.json перед сохранением.',
  'channels.editor.validation.conflictingProjectAliases':
    'Этот канал дважды перечисляет один проект с разными настройками и разным написанием (например Group/Project и group/project). Удалите одну из записей из settings.json перед сохранением.',
  'channels.editor.validation.invalidGroupEntry': (v) =>
    `Этот канал хранит запись группы, которая не является объектом: ${v?.repositories ?? ''}. Пока она есть, демон отклоняет любое сохранение, а в форме для неё нет строки. Исправьте или удалите эту запись в settings.json, затем перезагрузите канал.`,
  'channels.editor.validation.invalidOption':
    'Удалите значения, которых нет в списке разрешённых.',
  'channels.editor.validation.requiresBoundDeliveryForWatchGate':
    'Включите «Доставлять в сессии, привязанные к PR», чтобы требовать активное наблюдение.',
  'channels.editor.validation.repoFilterRequired':
    'Укажите хотя бы один репозиторий или установите «Фильтр репозиториев» в «Выкл.».',
  'channels.editor.validation.number': 'Введите допустимое число.',
  'channels.editor.validation.outOfRange': (v) => {
    const lower =
      v?.minInclusive !== undefined
        ? `не меньше ${v.minInclusive}`
        : v?.min !== undefined
          ? `больше ${v.min}`
          : undefined;
    if (lower !== undefined && v?.max !== undefined) {
      return `Введите число ${lower} и не больше ${v.max}.`;
    }
    if (v?.max !== undefined) return `Введите число не больше ${v.max}.`;
    return `Введите число ${lower ?? 'больше 0'}.`;
  },
  'channels.editor.validation.policy': 'Выберите политику доступа.',
  'channels.editor.saveError': 'Изменения не сохранены',
  'channels.editor.reloadLatest': 'Загрузить последние',
  'channels.editor.cancel': 'Отмена',
  'channels.editor.save': 'Сохранить',
  'localControl.open': 'Мобильный доступ',
  'localControl.expires': (v) =>
    `Одноразовый QR · истекает через ${v?.seconds ?? ''} с · обновляется автоматически`,
  'localControl.expired': 'QR-код истёк. Получение нового кода…',
  'localControl.retry': 'Повторить',
  'localControl.noNetwork':
    'Нет доступного адреса локальной сети. Откройте Web Shell по адресу, доступному с телефона.',
  'localControl.securePairing':
    'Отсканируйте, чтобы выдать доступ до перезапуска этого демона.',
  'localControl.insecurePairing':
    'Отсканируйте, чтобы выдать доступ до перезапуска этого демона. Трафик не шифруется; используйте доверенную сеть.',
  'localControl.securePairingDynamic':
    'Отсканируйте, чтобы выдать доступ к этому демону. Устройство, которое сканирует, остаётся в системе до перезапуска демона или закрытия вкладки на этом устройстве.',
  'localControl.insecurePairingDynamic':
    'Отсканируйте, чтобы выдать доступ к этому демону. Устройство, которое сканирует, остаётся в системе до перезапуска демона или закрытия вкладки на этом устройстве. Трафик не шифруется; используйте доверенную сеть.',
  'localControl.disabledHint':
    'Локальное управление выключено. Включите его в настройках, чтобы сопрячь телефон в той же сети.',
  'localControl.openSettings': 'Открыть настройки',
  'welcome.changeModel': '(/model — сменить)',
  'welcome.defaultModel': 'неизвестная модель',
  'welcome.modeHint': 'Shift+Tab или /approval-mode',
  'welcome.prompt': 'Что вы хотите сделать?',
  'welcome.titlePrefix': 'Добро пожаловать в',
  'welcome.tipLabel': 'Подсказки:',
};
