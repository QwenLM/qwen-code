import { ruPlural } from './utils/plural.js';

export const RU_PART3: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  'daemon.usage.modelShareTitle': 'доля модели',
  'daemon.usage.modelShareSub':
    'доля токенов · светло-зелёный — чтение из кэша',
  'daemon.usage.modelMeta': (v) =>
    `${v?.tokens ?? '0'} ${ruPlural(v?.tokens, 'токен', 'токена', 'токенов')} · кэш ${v?.cache ?? 0}%`,
  'daemon.usage.skillTitle': 'вызовы навыков',
  'daemon.usage.skillSub': 'название навыка / число',
  'daemon.usage.skillName': 'Навык',
  'daemon.usage.skillCount': 'Число',
  'daemon.usage.dailyTokensTitle': 'токены',
  'daemon.usage.dailyTokensSub': 'сумма токенов за день',
  'daemon.usage.dailySessionsTitle': 'сессии',
  'daemon.usage.dailySessionsSub': 'завершённые запуски по дням',
  'delete.cannotCurrent':
    'Нельзя удалить текущую сессию, пока она выполняется.',
  'delete.action': 'Удалить',
  'delete.deleted': 'Сессия удалена.',
  'delete.deletedCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сессия', 'сессии', 'сессий')} удалено.`,
  'delete.deleting': 'Удаление...',
  'delete.failed': (v) =>
    `Не удалось удалить сессию.${v?.reason ? ` ${v.reason}` : ''}`,
  'delete.footer': '↑↓ навигация · Space выбрать · Enter удалить · Esc отмена',
  'delete.noMatch': (v) => `Нет сессии по запросу «${v?.query ?? ''}»`,
  'delete.none': 'Нет сессий для удаления',
  'delete.allFailed': (v) =>
    `Не удалось удалить ${v?.count ?? 0} ${ruPlural(v?.count, 'сессию', 'сессии', 'сессий')}: ${v?.reason ?? 'неизвестная ошибка'}`,
  'delete.nonRemoved': 'Сессии не удалены.',
  'delete.notFound': 'Сессия не найдена — возможно, её уже удалили.',
  'delete.partialFail': (v) =>
    `${v?.removed ?? 0} удалено, ${v?.failed ?? 0} с ошибкой: ${v?.detail ?? 'неизвестная ошибка'}`,
  'delete.matches': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'совпадение', 'совпадения', 'совпадений')}`,
  'delete.pressSearch':
    'Нажмите / для поиска; Space — выбрать; Enter — удалить',
  'delete.selected': (v) => `Выбрано: ${v?.count ?? 0}`,
  'delete.title': 'Удалить сессию',
  'time.justNow': 'только что',
  'time.minutesAgo': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'минуту', 'минуты', 'минут')} назад`,
  'time.hoursAgo': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'час', 'часа', 'часов')} назад`,
  'time.daysAgo': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'день', 'дня', 'дней')} назад`,
  'dialog.footer.close': 'Esc — закрыть',
  'dialog.footer.confirmCancel': 'Enter — подтвердить · Esc — отмена',
  'release.cannotCurrent': 'Нельзя освободить текущую активную сессию.',
  'release.action': 'Освободить',
  'release.released': 'Сессия освобождена.',
  'release.failed': (v) =>
    `Не удалось освободить сессию.${v?.reason ? ` ${v.reason}` : ''}`,
  'release.footer': '↑↓ навигация · Enter — освободить · Esc — отмена',
  'release.inactive': 'Освободить можно только активные live-сессии.',
  'release.inactiveBadge': 'неактивна',
  'release.noMatch': (v) => `Нет сессии по запросу «${v?.query ?? ''}»`,
  'release.matches': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'совпадение', 'совпадения', 'совпадений')}`,
  'release.none': 'Нет live-сессий для освобождения',
  'release.pressSearch':
    'Нажмите / для поиска; Enter освобождает выбранную live-сессию',
  'release.releasing': 'Освобождение...',
  'release.title': 'Освободить сессию',
  'session.limit.reached':
    'Достигнут лимит live-сессий. Освободите простаивающую сессию или дождитесь окончания текущей работы.',
  'session.limit.release': 'Освободить простаивающие сессии',
  'dialog.footer.menu': 'Esc — в меню',
  'dialog.footer.mcpServers':
    '↑↓ навигация · Enter — подробности · r обновить · Esc закрыть',
  'dialog.footer.mcpSelect': '↑↓ навигация · Enter — выбрать · Esc — назад',
  'dialog.footer.modelFast':
    '↑↓ навигация · / поиск · c своя модель · Enter задать fast model · Esc отмена',
  'dialog.footer.navSelectCancel':
    '↑↓ навигация · Enter — выбрать · Esc — отмена',
  'dialog.footer.navSelectClose':
    '↑↓ навигация · Enter — выбрать · Esc — закрыть',
  'dialog.footer.navSelectMenu':
    '↑↓ навигация · Enter — выбрать · Esc — в меню',
  'dialog.footer.navOpenClose':
    '↑↓ навигация · Enter — открыть · Esc — закрыть',
  'dialog.footer.navOpenMenu': '↑↓ навигация · Enter — открыть · Esc — в меню',
  'dialog.footer.back': 'Esc — назад',
  'dialog.footer.backClose': 'Esc — закрыть',
  'dialog.footer.saveClose': '↑↓ поля · ⌘/Ctrl+Enter сохранить · Esc закрыть',
  'dialog.footer.saveMenu': '↑↓ поля · ⌘/Ctrl+Enter сохранить · Esc в меню',
  'dialog.footer.search':
    'Вводите для поиска · Enter подтвердить · Esc очистить',
  'dialog.footer.select': 'Enter — выбрать',
  'editor.escClearHint': 'Нажмите Esc ещё раз, чтобы очистить',
  'editor.hintCommands': 'команды',
  'editor.hintFiles': 'Файлы',
  'editor.hintNext': 'далее',
  'editor.hintPrev': 'назад',
  'editor.hintSearch': 'поиск',
  'editor.noHistory': 'Нет совпадений в истории',
  'editor.placeholder': 'Сообщение или @ путь к файлу',
  'history.loadingEarlier': 'Загрузка более ранних сообщений…',
  'history.openEarlier': 'Открыть более раннюю историю',
  'history.loadEarlier': 'Загрузить раньше',
  'history.loadNewer': 'Загрузить новее',
  'history.returnLatest': 'К последним',
  'history.viewUnavailable':
    'История временно недоступна: сессия переподключается или восстанавливает запись.',
  'history.snapshotView': 'Исторический снимок · только чтение',
  'history.viewError':
    'Этот фрагмент не удалось загрузить. Сдвиньте позицию чтения и повторите или вернитесь к последним.',
  'history.capacityReached':
    'Достигнут лимит отображения истории. Более ранние сообщения сохранены.',
  'history.paginationError': 'Не удалось загрузить более раннюю историю.',
  'history.retry': 'Повторить',
  'editor.shellPlaceholder': 'Введите команду терминала',
  'editor.send': 'Отправить сообщение',
  'editor.imagesSkipped': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')} недоступны и пропущены.`,
  'editor.imagesReadFailed': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')} не удалось прочитать.`,
  'editor.imagesTooLarge': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')} превысили лимит вложения.`,
  'editor.pastedTextShowInEditor': 'Показать в поле',
  'editor.connectionDisconnected':
    'Соединение прервано. Повторите после восстановления.',
  'editor.sessionLoading': 'Сессия ещё загружается. Повторите чуть позже.',
  'editor.processing': 'Идёт обработка. Новые сообщения попадут в очередь.',
  'editor.searchHint':
    'ctrl+r далее · tab принять · enter отправить · esc отмена',
  'editor.searchLabel': 'reverse-i-search:',
  'editor.searchPlaceholder': 'введите для поиска...',
  'editor.newSessionSuggestionTitle': 'Похоже на новую тему',
  'editor.newSessionSuggestionStart': 'Отправить в новой сессии',
  'editor.btwSuggestionTitle': 'Похоже на побочный вопрос',
  'editor.btwSuggestionSend': 'Спросить через BTW',
  'quickActions.extensions': 'Расширения',
  'quickActions.help': 'Справка',
  'quickActions.auth': 'Авторизация',
  'quickActions.settings': 'Настройки',
  'quickActions.copy': 'Копировать вывод',
  'quickActions.shellMode': 'Режим Shell',
  'quickActions.exitShellMode': 'Выйти из Shell',
  'session.missing': 'Текущая сессия не существует',
  'session.new': 'Новая сессия',
  'workspace.loadFailed': 'Не удалось загрузить рабочую область',
  'workspace.notFound': 'Рабочая область не найдена',
  'workspace.notFoundDescription':
    'Эта рабочая область могла быть удалена, или ссылка больше не действует.',
  'workspace.loadFailedDescription':
    'Сервис рабочих областей недоступен. Проверьте демон и повторите.',
  'scheduledTasks.title': 'Задачи по расписанию',
  'scheduledTasks.subtitle':
    'Запускайте задачи автоматически по расписанию или вручную в любой момент.',
  'scheduledTasks.loading': 'Загрузка…',
  'scheduledTasks.count': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'задача', 'задачи', 'задач')}`,
  'scheduledTasks.refresh': 'Обновить',
  'scheduledTasks.new': 'Новая задача по расписанию',
  'scheduledTasks.createViaChat': 'Создать в чате',
  'scheduledTasks.chatStarter':
    'Помоги настроить повторяющуюся задачу по расписанию (надолго). Нужно: ',
  'scheduledTasks.name': 'Название',
  'scheduledTasks.workspace': 'Рабочая область',
  'scheduledTasks.workspaceFixedByHost': 'Задано хостом',
  'scheduledTasks.session.label': 'Диалог',
  'scheduledTasks.session.dedicated': 'Отдельный диалог задачи',
  'scheduledTasks.session.current': 'Текущий диалог',
  'scheduledTasks.session.dedicatedHint':
    'Запуски хранятся в отдельном диалоге, созданном для этой задачи.',
  'scheduledTasks.session.currentHint':
    'Следующие запуски продолжатся в открытом сейчас диалоге.',
  'scheduledTasks.session.currentUnsupported':
    'Планирование в текущем диалоге на этом демоне недоступно.',
  'scheduledTasks.session.currentUnavailable':
    'Сначала откройте существующий диалог, чтобы выбрать текущий.',
  'scheduledTasks.session.currentBusy':
    'Дождитесь окончания текущего хода или ожидающего действия.',
  'scheduledTasks.session.currentIneligible':
    'Этот тип диалога не может владеть задачей по расписанию.',
  'scheduledTasks.session.currentWorkspaceMismatch':
    'Текущий диалог принадлежит другой рабочей области.',
  'scheduledTasks.session.currentAlreadyBound':
    'Текущий диалог уже привязан к задаче по расписанию.',
  'scheduledTasks.taskId': 'ID задачи',
  'scheduledTasks.schedule': 'Расписание',
  'scheduledTasks.type': 'Тип',
  'scheduledTasks.status': 'Статус',
  'scheduledTasks.namePlaceholder': 'Необязательно — по умолчанию из промпта',
  'scheduledTasks.prompt': 'Промпт',
  'scheduledTasks.promptPlaceholder': 'Что должна делать эта задача?',
  'workflowRuns.title': 'Воркфлоу',
  'workflowRuns.saved': 'Сохранённые',
  'workflowRuns.active': 'Выполняются',
  'workflowRuns.history': 'История',
  'workflowRuns.create': 'Создать',
  'workflowRuns.refresh': 'Обновить',
  'workflowRuns.loading': 'Загрузка запусков воркфлоу…',
  'workflowRuns.loadFailed': 'Не удалось загрузить запуски воркфлоу.',
  'workflowRuns.noSession':
    'Откройте сессию в этом проекте, чтобы увидеть запуски воркфлоу.',
  'workflowRuns.emptyActive': 'Сейчас воркфлоу не выполняются.',
  'workflowRuns.emptyHistory': 'Сохранённых запусков воркфлоу пока нет.',
  'workflowRuns.emptySaved': 'Сохранённых воркфлоу для повторного запуска нет.',
  'workflowRuns.emptySavedHint':
    'Нажмите «Создать», чтобы сделать воркфлоу с Qwen Code, сохраните завершённый запуск из терминала или добавьте файл .js в .qwen/workflows.',
  'workflowRuns.project': 'Проект',
  'workflowRuns.user': 'Пользователь',
  'workflowRuns.projectDescription': 'Доступно в этом проекте',
  'workflowRuns.userDescription': 'Доступно во всех проектах',
  'workflowRuns.extension': 'Расширение',
  'workflowRuns.extensionDescription':
    'Предоставлено установленным расширением',
  'workflowRuns.detail.toggle': (v) => `Показать сведения о ${v?.name ?? ''}`,
  'workflowRuns.detail.loading': 'Загрузка определения воркфлоу…',
  'workflowRuns.detail.unavailable':
    'Определение этого воркфлоу больше недоступно.',
  'workflowRuns.detail.loadFailed':
    'Не удалось прочитать определение воркфлоу.',
  'workflowRuns.detail.retry': 'Повторить',
  'workflowRuns.detail.noDescription': 'У этого воркфлоу нет описания.',
  'workflowRuns.detail.whenToUse': 'Когда использовать',
  'workflowRuns.detail.metaError': (v) =>
    `Не удалось разобрать блок meta: ${v?.error ?? ''}`,
  'workflowRuns.detail.phases': (v) => `Этапы (${v?.count ?? 0})`,
  'workflowRuns.detail.recentRuns': 'Недавние запуски',
  'workflowRuns.detail.noRuns': 'В этой сессии запусков ещё не было.',
  'workflowRuns.detail.viewRuns': (v) =>
    `Показать ${v?.count ?? 0} ${ruPlural(v?.count, 'запуск', 'запуска', 'запусков')} в истории`,
  'workflowRuns.detail.showSource': 'Показать исходник',
  'workflowRuns.detail.hideSource': 'Скрыть исходник',
  'workflowRuns.run': 'Запустить',
  'workflowRuns.starting': 'Запуск…',
  'workflowRuns.runNamed': (v) => `Запустить ${v?.name ?? ''}`,
  'workflowRuns.startFailed':
    'Сохранённый воркфлоу не удалось запустить. Обновите и повторите.',
  'scheduledTasks.reference.extension': 'Расширения',
  'scheduledTasks.reference.skill': 'Навыки',
  'scheduledTasks.reference.mcp': 'MCP',
  'scheduledTasks.referencePicker': 'Выбор ссылок',
  'scheduledTasks.reference.remove': 'Удалить',
  'scheduledTasks.reference.loading': 'Загрузка…',
  'scheduledTasks.reference.empty': 'Нет доступных элементов.',
  'scheduledTasks.frequency': 'Частота',
  'scheduledTasks.freq.daily': 'Ежедневно',
  'scheduledTasks.freq.weekdays': 'По будням',
  'scheduledTasks.freq.weekly': 'Еженедельно',
  'scheduledTasks.freq.hourly': 'Ежечасно',
  'scheduledTasks.freq.minutes': 'Каждые N минут',
  'scheduledTasks.freq.custom': 'Своё (cron)',
  'scheduledTasks.time': 'Время',
  'scheduledTasks.weekday': 'День недели',
  'scheduledTasks.interval': 'Минуты',
  'scheduledTasks.cron': 'Выражение cron',
  'scheduledTasks.weekdayNames': 'вс,пн,вт,ср,чт,пт,сб',
  'scheduledTasks.human.daily': (v) => `Ежедневно в ${v?.time ?? ''}`,
  'scheduledTasks.human.weekdays': (v) => `По будням в ${v?.time ?? ''}`,
  'scheduledTasks.human.weekly': (v) =>
    `Каждый ${v?.day ?? ''} в ${v?.time ?? ''}`,
  'scheduledTasks.human.hourly': (v) => `Ежечасно в :${v?.min ?? '00'}`,
  'scheduledTasks.human.everyMinutes': (v) =>
    `Раз в ${v?.n ?? ''} ${ruPlural(v?.n, 'минуту', 'минуты', 'минут')}`,
  'scheduledTasks.never': 'Ещё не запускалась',
  'scheduledTasks.repeats': 'Повторяется',
  'scheduledTasks.runsOnce': 'Один раз',
  'scheduledTasks.lastFired': (v) => `Последний запуск: ${v?.when ?? ''}`,
  'scheduledTasks.lastChecked': (v) => `Последняя проверка: ${v?.when ?? ''}`,
  'scheduledTasks.runNow': 'Запустить сейчас',
  'scheduledTasks.enable': 'Включить',
  'scheduledTasks.disable': 'Отключить',
  'scheduledTasks.delete': 'Удалить',
  'scheduledTasks.deleteConfirmTitle': 'Удалить задачу по расписанию',
  'scheduledTasks.deleteConfirm': (v) =>
    `Удалить задачу по расписанию «${v?.name ?? ''}»?`,
  'scheduledTasks.deletedSnapshot':
    'Эта задача по расписанию удалена. Показан снимок на момент создания.',
  'scheduledTasks.sessionScopedSnapshot':
    'Это задача по расписанию в рамках сессии. Показан снимок на момент создания.',
  'scheduledTasks.empty': 'Задач по расписанию пока нет. Создайте первую.',
  'scheduledTasks.create': 'Создать',
  'scheduledTasks.creating': 'Создание…',
  'scheduledTasks.cancel': 'Отмена',
  'scheduledTasks.error.invalidSchedule': 'Некорректное расписание',
  'scheduledTasks.error.workspaceUnavailable':
    'Выбранная рабочая область недоступна или не пользуется доверием',
  'scheduledTasks.error.emptyPrompt': 'Нужен промпт',
  'scheduledTasks.error.gateUnavailable':
    'Этот демон не принимает изменения гейта; отмените их или подключитесь к демону с поддержкой команд гейта',
  'scheduledTasks.error.promptTooLong': (v) =>
    `Промпт превышает лимит ${v?.max ?? 100_000} символов`,
  'scheduledTasks.error.goalActive':
    'Нельзя запустить задачу по расписанию, пока активна цель.',
  'scheduledTasks.error.toggleFailed': 'Не удалось обновить задачу',
  'scheduledTasks.error.deleteFailed': 'Не удалось удалить задачу',
  'scheduledTasks.edit': 'Изменить',
  'scheduledTasks.editTitle': 'Изменить задачу по расписанию',
  'scheduledTasks.save': 'Сохранить',
  'scheduledTasks.saving': 'Сохранение…',
  'scheduledTasks.runHistory': (v) => `История запусков (${v?.count ?? 0})`,
  'scheduledTasks.viewHistory': (v) => `Открыть диалог (${v?.count ?? 0})`,
  'scheduledTasks.viewHistoryEmpty': 'Открыть диалог',
  'scheduledTasks.viewHistoryHint':
    'Откройте сессию задачи, чтобы увидеть запуски',
  'scheduledTasks.runKind.catchUp': 'с опозданием',
  'scheduledTasks.runKind.manual': 'вручную',
  'scheduledTasks.runKind.withheld': 'пропущено',
  'scheduledTasks.runKind.sessionDispatchFailed':
    'новая сессия не создалась, ничего не запустилось',
  'scheduledTasks.runKind.sessionDispatchFallback':
    'новая сессия не создалась, запущено в сессии задачи',
  'scheduledTasks.openRunSession': 'Открыть сессию этого запуска',
  'scheduledTasks.runContext.title': 'Запуск задачи по расписанию',
  'scheduledTasks.runContext.taskId': 'ID задачи',
  'scheduledTasks.runContext.schedule': 'Расписание',
  'scheduledTasks.runContext.triggeredAt': 'Сработало',
  'scheduledTasks.runContext.trigger.scheduled': 'По расписанию',
  'scheduledTasks.runContext.trigger.manual': 'Запуск вручную',
  'scheduledTasks.error.runFailed': 'Не удалось записать запуск',
  'scheduledTasks.error.oneShotConsumedButFailed':
    'Задача удалена, но промпт не доставлен — она так и не запустилась. Создайте её заново.',
  'scheduledTasks.dueNow': 'Пора запускать',
  'scheduledTasks.nextRunTooltip': (v) => `Следующий запуск: ${v?.when ?? ''}`,
  'scheduledTasks.dur.d': 'д',
  'scheduledTasks.dur.h': 'ч',
  'scheduledTasks.dur.m': 'м',
  'scheduledTasks.dur.s': 'с',
  'scheduledTasks.runIn': 'Запуск через',
  'scheduledTasks.sessionMode.perRun': 'Новая сессия на каждый запуск',
  'scheduledTasks.sessionMode.persistent': 'Постоянная сессия задачи',
  'scheduledTasks.sessionMode.perRun.hint':
    'Каждый запуск получает чистый контекст и свой диалог.',
  'scheduledTasks.sessionMode.persistent.hint':
    'Все запуски продолжаются в одном диалоге задачи.',
  'scheduledTasks.model': 'Модель',
  'scheduledTasks.model.workspaceDefault':
    'Модель рабочей области по умолчанию',
  'scheduledTasks.model.hint':
    'Выбранная модель применяется при создании каждой новой сессии запуска.',
  'scheduledTasks.group': 'Группа сессий',
  'scheduledTasks.group.none': 'Без группы',
  'scheduledTasks.group.create': 'Создать новую группу…',
  'scheduledTasks.group.name': 'Название новой группы',
  'scheduledTasks.group.color': 'Цвет группы',
  'scheduledTasks.group.hint':
    'Диалог каждого запуска помещается в эту группу.',
  'scheduledTasks.group.nameRequired': 'Введите название новой группы.',
  'scheduledTasks.routing.loading': 'Загрузка моделей и групп…',
  'scheduledTasks.delivery.channel': 'Канал доставки',
  'scheduledTasks.delivery.configuredGroupHint':
    'Сообщения отправляются в группу, заданную для этого канала.',
  'scheduledTasks.delivery.configuredEndpointHint':
    'Сообщения отправляются на конечную точку, заданную для этого канала.',
  'scheduledTasks.delivery.endpoint': 'Конечная точка',
  'scheduledTasks.delivery.configuredHint':
    'Сообщения отправляются по адресу, заданному для этого канала.',
  'scheduledTasks.delivery.useConfiguredDestination':
    'Использовать заданный адрес',
  'scheduledTasks.delivery.differentConfiguredDestination':
    'Сохранённый адрес отличается от заданного для канала.',
  'scheduledTasks.delivery.off': 'Доставка выключена',
  'scheduledTasks.delivery.hint':
    'Отправить финальный ответ успешного запуска по расписанию на этот адрес. Доставка зависит от канала и не гарантирует получение.',
  'scheduledTasks.delivery.unavailable':
    'Этот демон не поддерживает изменение доставки через канал.',
  'scheduledTasks.delivery.discardChanges': 'Отменить изменения доставки',
  'scheduledTasks.delivery.perRun':
    'Новая сессия на каждый запуск не поддерживает доставку через канал. Перед сохранением выберите постоянную сессию или отключите доставку.',
  'scheduledTasks.delivery.required': 'Выберите канал и введите ID адресата.',
  'scheduledTasks.delivery.whitespace':
    'У этого ID есть пробелы в начале или в конце, они уйдут как часть адреса.',
  'scheduledTasks.delivery.trimWhitespace': 'Убрать пробелы по краям',
  'scheduledTasks.delivery.loading': 'Загрузка каналов…',
  'scheduledTasks.delivery.loadingContacts': 'Загрузка предложенных адресов…',
  'scheduledTasks.delivery.channelsFailed':
    'Не удалось загрузить каналы. Закройте и снова откройте форму, чтобы повторить; текущая доставка сохранена.',
  'scheduledTasks.delivery.noChannels':
    'В этой рабочей области нет настроенных каналов. Сначала настройте один в разделе «Каналы».',
  'scheduledTasks.delivery.targetUnavailable':
    'Этот канал недоступен в этой рабочей области. Сохранённый адрес сохранён; можно выбрать другой канал или отключить доставку.',
  'scheduledTasks.delivery.notObserved':
    'Этого адреса нет в недавних подсказках. Его ID сохранён; для доставки поиск контактов не обязателен.',
  'scheduledTasks.delivery.suggestion': 'Предложенный адрес',
  'scheduledTasks.delivery.manual': 'Введите ID адресата ниже',
  'scheduledTasks.delivery.contactsFailed':
    'Не удалось загрузить подсказки. Можно ввести ID адресата; текущая доставка сохранена.',
  'scheduledTasks.delivery.suggestionsHint':
    'Подсказки берутся из недавно замеченных контактов. Можно также ввести известный ID пользователя или чата, который поддерживает канал.',
  'scheduledTasks.delivery.type': 'Тип адресата',
  'scheduledTasks.delivery.id': 'ID адресата',
  'scheduledTasks.delivery.user': 'Пользователь',
  'scheduledTasks.delivery.chat': 'Чат',
  'scheduledTasks.delivery.cardPrefix': 'Доставка:',
  'scheduledTasks.gate': 'Команда-гейт (необязательно)',
  'scheduledTasks.gatePlaceholder':
    'напр. ./check-pr.sh 15057 — команда, которая печатает только изменения',
  'scheduledTasks.gate.hint':
    'Запускается из каталога проекта перед каждым срабатыванием по расписанию, вне модели. Код 0 с выводом будит сессию и прикладывает вывод как данные; код 0 без stdout пропускает срабатывание без хода; ненулевой код сообщает только stderr и только когда гейт начинает сбоить. Без подтверждения выполняется лишь там, где сессия запустила бы ту же команду без вопроса — сохранённое правило Monitor(…) или Bash(…), команда только для чтения либо сессия auto/yolo; иначе каждое срабатывание блокируется.',
  'scheduledTasks.gate.cardPrefix': 'Гейт:',
  'autofixPrWatches.title': 'Наблюдение за PR',
  'autofixPrWatches.description':
    'Наблюдения /autofix-pr ваших рабочих областей: что сделал каждый раунд и что ждёт вас.',
  'autofixPrWatches.empty':
    'Наблюдений /autofix-pr ещё нет. Запустите /autofix-pr <PR> в сессии, чтобы начать.',
  'autofixPrWatches.loadFailed': 'Не удалось загрузить наблюдения за PR',
  'autofixPrWatches.unreadable': (v) =>
    `Не удалось прочитать наблюдение PR #${v?.pr ?? ''}: ${v?.error ?? ''}`,
  'autofixPrWatches.phase.merged': 'PR влит — наблюдение можно остановить',
  'autofixPrWatches.phase.closed': 'PR закрыт — наблюдение можно остановить',
  'autofixPrWatches.phase.ended': (v) => `Остановлено: ${v?.reason ?? ''}`,
  'autofixPrWatches.phase.unscheduled': 'Нет проверки по расписанию',
  'autofixPrWatches.phase.fixing': (v) =>
    `Исправление в фоне (${v?.minutes ?? 0} ${ruPlural(v?.minutes, 'минуту', 'минуты', 'минут')})`,
  'autofixPrWatches.phase.fixingStarting': 'Исправление в фоне',
  'autofixPrWatches.phase.abandonedFix':
    'Фоновое исправление осталось незавершённым — следующий раунд переделает его',
  'autofixPrWatches.phase.watching': 'Наблюдение',
  'autofixPrWatches.phase.idle': 'Давно не проверялось',
  'autofixPrWatches.pushes': (v) => `Пуши ${v?.count ?? 0}/${v?.max ?? 0}`,
  'autofixPrWatches.lastCheck': (v) => `Последняя проверка ${v?.when ?? ''}`,
  'autofixPrWatches.neverChecked': 'Ещё не проверялось',
  'autofixPrWatches.lastRound': (v) => `Последний раунд ${v?.when ?? ''}`,
  'autofixPrWatches.needsHuman': (v) => `Нужно ваше решение (${v?.count ?? 0})`,
  'autofixPrWatches.staleTask':
    'Эта задача больше не ведёт наблюдение; оно остановится при следующем срабатывании.',
  'autofixPrWatches.openSession': 'Открыть сессию',
  'autofixPrWatches.stop': 'Остановить наблюдение',
  'autofixPrWatches.stopHint': (v) =>
    `Запускает /autofix-pr stop ${v?.pr ?? ''} в сессии, которой принадлежит наблюдение`,
  'autofixPrWatches.outsideDaemon':
    'Принадлежит сессии вне этого Web Shell (например, терминалу): остановите там.',
  'autofixPrWatches.stopFailed': 'Не удалось остановить наблюдение',
  'autofixPrWatches.noOwner': (v) =>
    `Ни одна сессия этого Web Shell его не выполняет. В сессии его рабочей области /autofix-pr stop ${v?.pr ?? ''} очистит его, а /autofix-pr resume ${v?.pr ?? ''} запустит снова.`,
  'scheduledTasks.gate.notRunYet': 'гейт ещё не запускался',
  'scheduledTasks.gate.neverDelivered': 'никогда',
  'scheduledTasks.gate.lastFailed': 'последний запуск не удался',
  'scheduledTasks.gate.lastBlocked': 'заблокирован',
  'scheduledTasks.gate.status': (v) =>
    `тишина ×${v?.quiet ?? 0} · последняя доставка ${v?.delivered ?? 'никогда'} · ${v?.failures ?? 0} ${ruPlural(v?.failures, 'сбой', 'сбоя', 'сбоев')}`,
  'scheduledTasks.runKind.gateFailed': 'гейт не сработал',
  'scheduledTasks.runKind.gateBlocked': 'гейт заблокирован',
  'turnOutputs.filesEdited': (v) =>
    `Изменено ${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')}`,
  'turnOutputs.imagePreview': 'Просмотр изображения',
  'turnOutputs.viewChanges': 'Показать изменения',
  'turnOutputs.review': 'Изменения',
  'turnOutputs.reviewLatest': 'Показать недавние изменения файлов',
  'codeReview.authoritativeVerdict': 'Итоговое заключение',
  'codeReview.targetEffort': (v) =>
    `Цель: ${v?.target ?? ''} · Усилие: ${v?.effort ?? ''}`,
  'codeReview.openReport': 'Открыть отчёт Markdown',
  'codeReview.loadingReport': 'Загрузка отчёта Markdown...',
  'codeReview.back': 'Назад к ревью',
  'codeReview.reviewCounts': 'Счётчики ревью',
  'codeReview.total': 'Всего',
  'codeReview.confidence': (v) => `${v?.value ?? ''} уверенность`,
  'codeReview.held': 'Отложено',
  'codeReview.heldByMeasurement':
    'Не повышено до Critical по результатам измерения',
  'codeReview.caps': 'Потолки',
  'codeReview.none': 'Нет',
  'codeReview.severity': 'Серьёзность',
  'codeReview.confidenceLabel': 'Уверенность',
  'codeReview.all': 'Все',
  'codeReview.noMatches': 'Нет находок по этим фильтрам.',
  'codeReview.source': (v) => `Источник: ${v?.value ?? ''}`,
  'codeReview.failureScenario': 'Сценарий сбоя',
  'codeReview.witness': 'Свидетельство',
  'codeReview.suggestedFix': 'Предлагаемое исправление',
  'codeReview.fixWitness': 'Свидетельство исправления',
  'codeReview.outcome': 'Исход',
  'codeReview.locations': 'Места',
  'codeReview.evidence': 'Доказательства',
  'codeReview.notLinked': 'не связано',
  'codeReview.loadErrorTitle': 'Не удалось показать ревью кода',
  'codeReview.loading': 'Загрузка ревью кода...',
  'codeReview.artifactTruncated':
    'Артефакт ревью кода обрезан и не может быть проверен.',
  'codeReview.reportTruncated': 'Отчёт Markdown обрезан.',
  'codeReview.unavailable': (v) =>
    `Это ревью кода больше не авторитетно: статус артефакта ${v?.status ?? 'unknown'}. Сгенерируйте ревью заново, чтобы посмотреть.`,
  'codeReview.workspaceRequired':
    'Артефакты ревью кода должны быть читаемыми файлами рабочей области.',
  'sideTask.title': 'Побочная задача',
  'sideTask.description': 'Просмотр и создание побочных задач',
  'sideTask.new': 'Создать',
  'sideTask.create': 'Новая побочная задача',
  'sideTask.archiveCompleted': 'Архивировать завершённые',
  'sideTask.archiveUnavailable':
    'Архивировать можно только завершённые побочные задачи.',
  'webPreview.title': 'Веб-превью',
  'webPreview.openHint': 'Превью веб-приложений',
  'webPreview.address': 'Адрес разработки',
  'webPreview.open': 'Открыть',
  'webPreview.refresh': 'Обновить превью',
  'webPreview.desktop': 'Ширина для компьютера',
  'webPreview.mobile': 'Ширина для телефона (390 px)',
  'webPreview.external': 'Открыть снаружи',
  'webPreview.frame': 'Кадр веб-превью',
  'webPreview.saved': 'Сохранённая версия',
  'webPreview.savedFrame': 'Сохранённая версия страницы',
  'webPreview.savedUnavailable':
    'Эта сохранённая версия отсутствует или изменилась. Открыть её нельзя.',
  'webPreview.savedLoadFailed':
    'Не удалось загрузить эту сохранённую версию. Повторите.',
  'webPreview.page': 'Превью приложения',
  'webPreview.empty': 'Запустите сервер разработки и введите его URL выше.',
  'webPreview.reachable':
    'Укажите адрес, доступный этому браузеру. Для удалённого сервера — доступный URL или уже настроенный проброс порта.',
  'webPreview.fallback':
    'Пустая страница? Проверьте сервер или откройте снаружи. Адрес и обновление используют исходный URL.',
  'webPreview.live':
    'Живая страница. Ссылка из более раннего сообщения покажет текущее содержимое, а не сохранённую версию.',
  'webPreview.invalidUrl':
    'Укажите отдельный HTTP/HTTPS-адрес разработки с именем хоста или IPv4, без учётных данных. Адреса Web Shell и демона превьюить нельзя.',
  'terminal.title': 'Терминал',
  'terminal.open': 'Открыть терминал',
  'terminal.notice.exited': (v) =>
    `Процесс завершился с кодом ${v?.exitCode ?? '?'}`,
  'terminal.notice.error': (v) => `Ошибка: ${v?.message ?? ''}`,
  'terminal.notice.unknownError': 'Неизвестная ошибка',
  'terminal.notice.reconnecting': 'Соединение потеряно — переподключение…',
  'terminal.notice.lost': 'Этот терминал больше недоступен.',
  'terminal.notice.protocolMismatch':
    'Протокол терминала изменился; перезапустите демон и обновите страницу.',
  'localFiles.title': 'Локальные файлы',
  'localFiles.trigger': 'Локальные файлы',
  'localFiles.hint':
    'Позволяет этой сессии читать и писать один каталог на вашем компьютере. Файлы остаются у вас; агенту уходит только то, что он запросил.',
  'localFiles.connect': 'Подключить каталог…',
  'localFiles.reconnect': 'Подключить снова',
  'localFiles.disconnect': 'Отключить',
  'localFiles.openInNewTab': 'Открыть в новой вкладке',
  'localFiles.directory': 'Каталог',
  'localFiles.tools': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'инструмент', 'инструмента', 'инструментов')}`,
  'localFiles.status.idle': 'Не подключено',
  'localFiles.status.connecting': 'Подключение…',
  'localFiles.status.registering': 'Регистрация…',
  'localFiles.status.connected': 'Подключено',
  'localFiles.status.reconnecting': 'Переподключение…',
  'localFiles.status.heldElsewhere': 'Подключено в другой вкладке',
  'localFiles.status.needsSession': 'Ожидание сессии',
  'localFiles.status.needsGesture': 'Подключите снова, чтобы продолжить',
  'localFiles.status.failed': 'Ошибка',
  'localFiles.status.unavailable': 'Здесь недоступно',
  'localFiles.status.resolving': 'Определение…',
  'localFiles.needsSessionHint':
    'Сначала запустите сессию. Мост привязан ровно к одной сессии, поэтому другие сессии до ваших файлов не доберутся.',
  'localFiles.blocker.insecureContext': (v) =>
    v?.localPort !== undefined
      ? `Эта страница не в безопасном контексте, браузер не даст доступ к локальным файлам. Откройте Web Shell по https или выполните скопированную команду SSH-туннеля и откройте http://localhost:${v.localPort}.`
      : 'Эта страница не в безопасном контексте, браузер не даст доступ к локальным файлам. Откройте Web Shell по https или пробросьте порт демона через SSH и откройте http://localhost:<port>.',
  'localFiles.blocker.crossOriginFrame':
    'Доступ к локальным файлам заблокирован во фрейме с другого источника. Откройте Web Shell в отдельной вкладке браузера, чтобы подключить каталог.',
  'localFiles.blocker.unsupportedBrowser':
    'В этом браузере нет File System Access API. Чтобы подключить локальный каталог, используйте Chrome или Edge.',
  'localFiles.blocker.workspaceIneligible':
    'Рабочая область этого диалога не может принять локальный каталог (нет доверия или live-область). Используйте сессию в доверенной обычной рабочей области.',
  'localFiles.blocker.workspaceResolving':
    'Ещё неизвестно, к какой рабочей области относится этот диалог.',
  'localFiles.blocker.unsupportedDaemon':
    'Этот демон не объявляет мост клиентской файловой системы (client_mcp_over_ws). Запустите демон с QWEN_SERVE_CLIENT_MCP_OVER_WS=1, чтобы включить локальные файлы.',
  'localFiles.changeDirectory': 'Сменить каталог…',
  'localFiles.session': 'Сессия',
  'localFiles.newSession': 'Новая сессия',
  'localFiles.retry': 'Повторить',
  'localFiles.copyStartupCommand': 'Копировать команду запуска',
  'localFiles.copyTunnelCommand': 'Копировать команду SSH-туннеля',
  'localFiles.copied': 'Команда скопирована',
  'localFiles.copyFailed': 'Не удалось скопировать команду',
  'localFiles.changeDirectoryFailed':
    'Не удалось сменить каталог. Текущий каталог по-прежнему подключён.',
  'localFiles.changeDirectoryDeferred':
    'Смена каталога сохранена. Она вступит в силу, когда рабочая область будет определена; до тех пор подключён текущий каталог.',
  'localFiles.gestureToast': (v) =>
    v?.name
      ? `Локальный каталог «${v.name}» нужно подключить снова. Откройте «Локальные файлы», чтобы выдать доступ.`
      : 'Локальные файлы нужно подключить снова. Откройте «Локальные файлы», чтобы выдать доступ.',
  'rightPanel.add': 'Добавить панель',
  'attachment.showPreview': 'Превью',
  'attachment.showSource': 'Исходник',
  'attachment.previewUnsupported': 'Превью для этого типа файла недоступно.',
  'attachment.readFailed': 'Не удалось прочитать вложение.',
  'attachment.loadingFile': 'Загрузка файла...',
  'attachment.loadingPreview': 'Загрузка превью...',
  'sideTask.creating': 'Создание побочной задачи…',
  'sideTask.createFailed': 'Не удалось создать побочную задачу',
  'sideTask.commandsLoadingTimedOut':
    'Сведения о командах ещё недоступны. Промпт побочной задачи сохранён и будет проверен после загрузки.',
  'sideTask.promptFailed': 'Не удалось отправить вопрос побочной задачи',
  'sideTask.renameFailed': 'Не удалось задать имя побочной задачи',
  'turnOutputs.preview': 'Превью',
  'turnOutputs.collapseFiles': 'Свернуть файлы',
  'turnOutputs.showMoreFiles': (v) =>
    `Показать ещё ${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')}`,
  'turnOutputs.collapseArtifacts': 'Свернуть артефакты',
  'turnOutputs.showMoreArtifacts': (v) =>
    `Показать ещё ${v?.count ?? 0} ${ruPlural(v?.count, 'артефакт', 'артефакта', 'артефактов')}`,
  'turnOutputs.previousTurn': 'Предыдущий ход',
  'turnOutputs.fileCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')}`,
  'turnOutputs.openFileTree': 'Открыть дерево файлов',
  'turnOutputs.closeFileTree': 'Закрыть дерево файлов',
  'turnOutputs.artifactMissing': 'Файл не найден в рабочей области',
  'turnOutputs.artifactChanged': 'Изменён после записи',
  'turnOutputs.artifactUnavailable': (v) =>
    v?.path
      ? `Файл не найден в рабочей области · ${v.path}`
      : 'Файл не найден в рабочей области',
  'sidebar.label': 'Боковая панель рабочих областей',
  'sidebar.home': 'Главная',
  'sidebar.channelSettings': 'Настройки',
  'sidebar.liveSettings': 'Настройки',
  'sidebar.liveSettingsUnavailable':
    'Настройки Live на этом сервере недоступны.',
  'sidebar.more': 'Ещё',
  'sidebar.navigation': 'Основная навигация',
  'sidebar.toggleMenu': 'Переключить меню',
  'sidebar.newChat': 'Новый чат',
  'sidebar.newTask': 'Новая сессия',
  'sidebar.newWorktreeTask': 'Новая сессия worktree',
  'sidebar.moveWorkspaceUp': 'Выше',
  'sidebar.moveWorkspaceDown': 'Ниже',
  'sidebar.plugins': 'Плагины',
  'sidebar.channels': 'Каналы',
  'sidebar.channelEvents': 'События каналов',
  'sidebar.sessionSource': 'Источник сессии',
  'sidebar.archiveSessionSource': 'Источник архивной сессии',
  'sidebar.sessionSource.tasks': 'Задачи',
  'sidebar.sessionSource.channels': 'Каналы',
  'sidebar.channelType.other': 'Другие каналы',
  'sidebar.live': 'Live',
  'sidebar.liveVoicePending': 'Голосовой чат',
  'sidebar.project': 'Рабочие области',
  'sidebar.pinnedSessions': 'Закреплённые',
  'sidebar.sessionSort': 'Сортировка сессий',
  'sidebar.sessionDisplay': 'Параметры отображения',
  'sidebar.groupBy': 'Группировать по',
  'sidebar.groupWorkspace': 'Рабочая область',
  'sidebar.groupActivityDate': 'Дата активности',
  'sidebar.groupThisWeek': 'На этой неделе',
  'sidebar.groupLast30Days': 'За последние 30 дней',
  'sidebar.groupOlder': 'Ранее',
  'sidebar.recentConversations': 'Недавние разговоры',
  'sidebar.sortBy': 'Сортировать',
  'sidebar.sortActivity': 'Недавняя активность',
  'sidebar.sortQuestion': 'Последний вопрос',
  'sidebar.workspaceFilter': 'Рабочая область',
  'sidebar.filterAll': 'Все',
  'sidebar.restoreDefaults': 'Сбросить настройки',
  'sidebar.recentSessions': 'Недавние',
  'sidebar.standalonePinUnavailable':
    'Закрепление сессий без рабочей области пока не поддерживается.',
  'sidebar.workspaceSelectLabel': 'Рабочая область',
  'sidebar.noWorkspace': 'Без рабочей области',
  'sidebar.liveSessions': 'Активные сессии',
  'sidebar.noWorkspaceSessions': 'Сессии без рабочей области',
  'sidebar.copySessionId': 'Копировать ID сессии',
  'sidebar.copySessionIdFailed': 'Не удалось скопировать ID сессии',
  'sidebar.sessionIdCopied': 'ID сессии скопирован',
  'sidebar.workspaceUntrusted': 'нет доверия',
  'sidebar.manageWorkspaces': 'Управление рабочими областями…',
  'sidebar.collapseAllWorkspaces': 'Свернуть все рабочие области',
  'sidebar.expandAllWorkspaces': 'Развернуть все рабочие области',
  'sidebar.workspaceOrderError':
    'Не удалось загрузить или сохранить порядок рабочих областей. Обновите и повторите.',
  'sidebar.workspaceReadOnly': 'только чтение',
  'sidebar.workspaceTrustToOpen':
    'Чтобы открыть сессию, доверьтесь этой рабочей области.',
  'sidebar.addWorkspace': 'Добавить рабочую область',
  'sidebar.newWorkspace': 'Новая рабочая область',
  'sidebar.startFromScratch': 'Начать с нуля',
  'sidebar.useExistingFolder': 'Использовать существующую папку…',
  'sidebar.scratchOutcomeUnknownTitle': 'Проверьте создание рабочей области',
  'sidebar.scratchOutcomeUnknown':
    'Ответ демона прервался. Перед созданием ещё одной области проверьте обновлённый список.',
  'sidebar.scratchOutcomeRefresh': 'Обновить список рабочих областей',
  'sidebar.scratchOutcomeAcknowledge': 'Я проверил список рабочих областей',
  'sidebar.addWorkspaceTitle': 'Добавить рабочую область',
  'sidebar.addWorkspacePath': 'Путь к каталогу',
  'sidebar.addWorkspaceBrowse': 'Обзор…',
  'sidebar.addWorkspaceBrowsing': 'Выбор каталога…',
  'sidebar.addWorkspaceBrowseError':
    'Не удалось открыть выбор папки. Введите абсолютный путь.',
  'sidebar.addWorkspaceDisplayName': 'Отображаемое имя (необязательно)',
  'sidebar.addWorkspaceDisplayNameHint':
    'Показывается в Web Shell; идентификатор рабочей области — путь к каталогу.',
  'sidebar.addWorkspaceRegister': 'Добавить рабочую область',
  'sidebar.addWorkspaceCancel': 'Отмена',
  'sidebar.addWorkspaceError': 'Не удалось добавить рабочую область',
  'sidebar.addWorkspaceBusyError':
    'Выполняется другая операция с рабочей областью',
  'sidebar.addWorkspacePersistenceError':
    'Демон не подтвердил постоянную регистрацию рабочей области',
  'sidebar.addWorkspaceRefreshError':
    'Рабочая область добавлена, но список не удалось обновить',
  'sidebar.addWorkspaceAbsError':
    'Введите абсолютный путь или URL рабочей области SSH.',
  'sidebar.addWorkspaceHint':
    'Введите локальный абсолютный путь или ssh://user@host/absolute/project. Для SSH нужны ключевая аутентификация, доверенный ключ хоста и Python 3 на удалённом компьютере. Для команд оболочки также нужен Bash; Qwen там не требуется.',
  'sidebar.addWorkspaceSuggestions': 'Подсказки каталогов',
  'sidebar.addWorkspacePersist': 'Сохранить после перезапуска демона',
  'sidebar.addWorkspacePersistHint':
    'Сохранить регистрацию этой рабочей области в конфигурации демона.',
  'sidebar.addWorkspaceAdding': 'Добавление…',
  'sidebar.addWorkspaceSource': 'Источник',
  'sidebar.addWorkspaceSourceDirectory': 'Существующий каталог',
  'sidebar.addWorkspaceSourceGit': 'Репозиторий Git',
  'sidebar.gitCloneUrl': 'URL репозитория',
  'sidebar.gitCloneUrlPlaceholder': 'https://github.com/org/repo.git',
  'sidebar.gitCloneUrlHint':
    'Подходят публичные URL, адреса SSH-агента и URL со своим токеном. Демон передаёт токен Git и никогда не записывает его в клонированный репозиторий; учётные данные Git на хосте не используются.',
  'sidebar.gitCloneTarget': 'Клонировать в',
  'sidebar.gitCloneTargetPlaceholder': '/absolute/path/for/new/repo',
  'sidebar.gitCloneTargetHint':
    'Абсолютный путь, которого ещё нет. Родительский каталог должен уже существовать.',
  'sidebar.gitCloneTargetSuggestHint':
    'Введите путь родителя, чтобы выбрать из его подпапок.',
  'sidebar.gitCloneSubmit': 'Клонировать и добавить',
  'sidebar.gitCloneProgress': (vars) => `Клонирование… ${vars?.percent}%`,
  'sidebar.gitCloneProgressLabel': 'Ход клонирования',
  'sidebar.gitCloneCancel': 'Отменить клонирование',
  'sidebar.gitCloneCancelled': 'Клонирование отменено.',
  'sidebar.gitCloneFailed': 'Клонирование не удалось',
  'sidebar.gitCloneInvalidInput':
    'Введите URL Git и абсолютный путь назначения.',
  'sidebar.gitCloneInvalidTarget': 'Введите абсолютный путь назначения.',
  'sidebar.gitCloneUnknown':
    'Не удалось подтвердить результат клонирования. Проверьте список рабочих областей, прежде чем клонировать снова.',
  'sidebar.gitCloneJobGone':
    'Эта задача клонирования больше недоступна, результат подтвердить нельзя. Перед повторным клонированием проверьте список рабочих областей или наличие пути назначения.',
  'sidebar.gitCloneRecheck': 'Проверить снова',
  'sidebar.gitCloneBack': 'Назад',
  'sidebar.gitCloneRegisterRetry': (vars) =>
    `Клонировано в ${vars?.path}. Отправьте форму, чтобы зарегистрировать.`,
  'workspaceHost.source': 'Источник папки',
  'workspaceHost.thisComputer': 'Этот компьютер',
  'workspaceHost.folderOn': (vars) => `Папка на ${vars?.address}`,
  'workspaceHost.folderOnThisComputer': 'Папка на этом компьютере',
  'workspaceHost.browseHint':
    'Выберите папку ниже или введите абсолютный путь.',
  'workspaceHost.parent': 'Родительская папка',
  'workspaceHost.addFolder': 'Добавить эту папку',
  'workspaceHost.noFolders': 'В этом каталоге нет подпапок.',
  'workspaceHost.folderListError':
    'Не удалось прочитать папки с этого компьютера. Проверьте путь или соединение.',
  'workspaceHost.navigationUnavailable':
    'Хранилище браузера недоступно, поэтому удалённый выбор папки нельзя продолжить безопасно.',
  'workspaceHost.unsupported':
    'Этот компьютер не поддерживает добавление рабочих областей.',
  'workspaceHost.loadingFolders': 'Загрузка папок с этого компьютера…',
  'workspaceHost.connectionError':
    'Не удалось загрузить возможности рабочих областей с этого компьютера.',
  'workspaceDirectories.title': 'Каталоги рабочей области',
  'workspaceDirectories.description':
    'Инструменты могут читать и править эти каталоги в дополнение к корню рабочей области. Новые сессии наследуют этот список.',
  'workspaceDirectories.warning':
    'Добавление каталога расширяет доступ к файлам за пределы корня рабочей области. Добавляйте только те каталоги, которым доверяете.',
  'workspaceDirectories.primary': 'Основной',
  'workspaceDirectories.empty': 'Дополнительных каталогов нет.',
  'workspaceDirectories.add': 'Добавить каталог',
  'workspaceDirectories.addTitle': 'Добавить каталог в рабочую область',
  'workspaceDirectories.addSubmit': 'Добавить каталог',
  'workspaceDirectories.pathHint':
    'Введите абсолютный путь на машине, где работает эта рабочая область.',
  'workspaceDirectories.remove': 'Удалить каталог',
  'workspaceDirectories.loading': 'Загрузка каталогов…',
  'workspaceDirectories.loadFailed':
    'Не удалось загрузить каталоги рабочей области.',
  'workspaceDirectories.removeFailed': 'Не удалось удалить каталог',
  'sidebar.removeWorkspace': 'Удалить рабочую область',
  'sidebar.workspaceActions': 'Действия рабочей области',
  'sidebar.renameWorkspace': 'Переименовать…',
  'sidebar.renameWorkspaceTitle': 'Переименовать рабочую область',
  'sidebar.workspaceNamePrompt': 'Отображаемое имя',
  'sidebar.workspaceNameHint': 'Оставьте пустым, чтобы показать имя папки.',
  'sidebar.workspaceNameInvalid': 'Имя не может содержать управляющие символы.',
  'sidebar.renameWorkspaceFailed': 'Не удалось переименовать рабочую область',
  'sidebar.copyWorkspacePath': 'Копировать путь',
  'sidebar.copyWorkspacePathFailed':
    'Не удалось скопировать путь рабочей области',
  'sidebar.openWorkspaceFolder': 'Открыть папку',
  'sidebar.openWorkspaceFolderFailed':
    'Не удалось открыть папку рабочей области',
  'sidebar.openWorkspaceFolderOpened': 'Папка рабочей области открыта',
  'sidebar.openWorkspaceTerminal': 'Открыть терминал',
  'sidebar.openWorkspaceTerminalFailed': 'Не удалось открыть терминал',
  'sidebar.openWorkspaceTerminalOpened': 'Терминал открыт в рабочей области',
  'sidebar.manageWorkspace': 'Управление',
  'sidebar.reloadWorkspace': 'Перезагрузить среду',
  'sidebar.reloadWorkspaceFailed':
    'Не удалось перезагрузить среду рабочей области',
  'sidebar.workspaceCount': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'рабочая область', 'рабочие области', 'рабочих областей')}`,
  'sidebar.sessionsRunning': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сессия', 'сессии', 'сессий')} в работе`,
  'sidebar.sessionsAttention': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'сессия', 'сессии', 'сессий')} ждут вас`,
  'sidebar.sessionsTotal': (v) =>
    `${v?.count ?? 0}${v?.truncated ? '+' : ''} ${ruPlural(
      v?.truncated ? 5 : v?.count,
      'сессия',
      'сессии',
      'сессий',
    )}`,
  'sidebar.overview.sessions': 'Сессии',
  'sidebar.overview.mcp': 'MCP',
  'sidebar.overview.skills': 'Навыки',
  'sidebar.overview.extensions': 'Расширения',
  'sidebar.overview.channels': 'Каналы',
  'sidebar.overview.context': 'Контекст',
  'sidebar.overview.hooks': 'Hooks',
  'sidebar.overview.settings': 'Настройки',
  'sidebar.overview.mcpDetail': (v) =>
    `${v?.connected ?? 0} из ${v?.configured ?? 0} подключено` +
    (Number(v?.failed) > 0 ? `, ошибок: ${v?.failed}` : '') +
    (Number(v?.disabled) > 0 ? `, отключено: ${v?.disabled}` : ''),
  'sidebar.overview.skillsDetail': (v) =>
    `${v?.enabled ?? 0} из ${v?.total ?? 0} включено`,
  'sidebar.overview.extensionsDetail': (v) =>
    `${v?.active ?? 0} из ${v?.total ?? 0} активно`,
  'sidebar.overview.channelsDetail': (v) =>
    `${v?.connected ?? 0} из ${v?.configured ?? 0} подключено` +
    (Number(v?.failed) > 0 ? `, ошибок: ${v?.failed}` : ''),
  'sidebar.overview.contextDetail': (v) =>
    `${v?.files ?? 0} ${ruPlural(v?.files, 'файл контекста', 'файла контекста', 'файлов контекста')}, ${v?.rules ?? 0} ${ruPlural(v?.rules, 'правило', 'правила', 'правил')}`,
  'sidebar.overview.hooksDetail': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'хук', 'хука', 'хуков')}`,
  'sidebar.overview.hooksDisabled': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'хук', 'хука', 'хуков')} (отключено)`,
  'sidebar.overview.hooksUntrusted': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'хук', 'хука', 'хуков')}, ${v?.untrusted ?? 0} не загружено (папка без доверия). Включите security.folderTrust.enabled и доверьтесь папке или запустите qwen интерактивно для проверки.`,
  'sidebar.forceRemoveWorkspace': 'Принудительно удалить',
  'sidebar.removeWorkspaceTitle': 'Удалить рабочую область',
  'sidebar.removeWorkspaceConfirm': (v) =>
    `Удалить среду и постоянную регистрацию «${v?.name ?? ''}»? Файлы, настройки и история сессий не будут удалены.`,
  'sidebar.removeWorkspaceBusy': (v) =>
    `У «${v?.name ?? ''}» ещё есть активные ресурсы среды. Принудительное удаление их завершит.`,
  'sidebar.removeWorkspaceCurrentSession':
    'Перед принудительным удалением переключитесь на другую рабочую область или закройте текущую сессию.',
  'sidebar.removeWorkspaceInProgress':
    'Другой клиент уже удаляет эту рабочую область. Обновите после завершения операции.',
  'sidebar.removeWorkspaceError': 'Не удалось удалить рабочую область',
  'sidebar.removeWorkspaceSessions': (v) => `Сессии: ${v?.count ?? 0}`,
  'sidebar.removeWorkspacePrompts': (v) => `Активные промпты: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceStarts': (v) =>
    `Ожидающие запуски сессий: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceConnections': (v) =>
    `Подключения ACP: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceMemoryTasks': (v) =>
    `Задачи памяти: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceWorkers': (v) => `Воркеры каналов: ${v?.count ?? 0}`,
  'sidebar.removeWorkspaceVoiceSessions': (v) =>
    `Голосовые сессии: ${v?.count ?? 0}`,
  'sidebar.noSessions': 'Нет сессий.',
  'sidebar.untitledSession': 'Сессия без названия',
  'sidebar.projectFallback': 'Рабочая область',
  'sidebar.sessionsOverview': 'Обзор сессий',
  'sidebar.splitView': 'Раздельный вид',
  'sidebar.addToSplitView': 'Добавить в раздельный вид',
  'sidebar.splitAtCapacity': (v) =>
    `В раздельном виде уже ${v?.max ?? 6} ${ruPlural(v?.max, 'сессия', 'сессии', 'сессий')} — закройте панель, чтобы добавить ещё`,
  'sidebar.splitAlreadyOpen': 'Эта сессия уже открыта в раздельном виде',
  'sidebar.splitCurrentDisabled':
    'Текущую сессию нельзя добавить, пока раздельный вид закрыт',
  'sidebar.settings': 'Настройки',
  'update.button': 'Обновить',
  'update.restarting': 'Перезапуск…',
  'update.readyTitle': (v) => `Обновить до v${v?.version} и перезапустить`,
  'update.manualTitle': (v) => `Обновить до v${v?.version} (вручную)`,
  'update.manualHint':
    'Эту установку нельзя обновить из Web Shell. Как обновить:',
  'update.failed':
    'Обновление не завершилось. Проверьте соединение со службой и повторите.',
  'sidebar.daemonStatus': 'Состояние демона',
  'sidebar.scheduledTasks': 'Задачи по расписанию',
  'sidebar.workflows': 'Воркфлоу',
  'sidebar.goals': 'Цели',
  'sidebar.sessionGoal': (v) =>
    `Цель: ${v?.status ?? ''} — ${v?.objective ?? ''}`,
  'sidebar.prWatches': 'Наблюдение за PR',
  'sidebar.themeLight': 'Переключить на светлую тему',
  'sidebar.themeDark': 'Переключить на тёмную тему',
  'sidebar.collapse': 'Свернуть',
  'sidebar.expand': 'Развернуть',
  'sidebar.showAllSessions': 'Показать все',
  'sidebar.showMoreSessions': (v) => `Показать ещё ${v?.['count'] ?? 0}`,
  'sidebar.subSessions': (v) =>
    `${v?.['count'] ?? 0} ${ruPlural(v?.['count'], 'подсессия', 'подсессии', 'подсессий')}`,
  'sidebar.collapseProject': 'Свернуть рабочую область',
  'sidebar.expandProject': 'Развернуть рабочую область',
  'sidebar.search': 'Поиск сессий',
  'sidebar.searchPlaceholder': 'Поиск сессий',
  'sidebar.searchResults': 'Сессии',
  'sidebar.searchLoading': 'Поиск сессий…',
  'sidebar.searchEmpty': 'Сессии не найдены',
  'sidebar.searchEmptyHint': 'Попробуйте другое название или фразу из диалога.',
  'sidebar.searchRecentEmpty': 'Здесь появятся ваши недавние сессии.',
  'sidebar.searchPartialFailure': 'Некоторые сессии не удалось найти.',
  'sidebar.searchNavigate': 'Перейти',
  'sidebar.searchOpen': 'Открыть',
  'sidebar.rename': 'Переименовать',
  'sidebar.export': 'Экспортировать запись диалога',
  'sidebar.exportFailed': 'Не удалось экспортировать сессию',
  'sidebar.delete': 'Удалить',
  'sidebar.archive': 'Архивировать',
};
