import { ruPlural } from './utils/plural.js';

export const RU_PART1: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  "You've used up your weekly credits.{{reset}} You can wait or run /upgrade to get more credits.":
    (v) =>
      `Недельный лимит кредитов исчерпан.${v?.['reset'] ?? ''} Можно подождать или выполнить /upgrade, чтобы получить больше кредитов.`,
  "You've used up your weekly credits.{{reset}} Please try again after the reset.":
    (v) =>
      `Недельный лимит кредитов исчерпан.${v?.['reset'] ?? ''} Повторите попытку после сброса.`,
  "You've used up your credits.{{reset}} Please try again after the reset.": (
    v,
  ) =>
    `Лимит кредитов исчерпан.${v?.['reset'] ?? ''} Повторите попытку после сброса.`,
  ' Your credits are expected to reset in {{time}}.': (v) =>
    ` Ожидается сброс через ${v?.['time'] ?? ''}.`,
  '{{days}} and {{hours}}': (v) =>
    `${v?.['days'] ?? ''} и ${v?.['hours'] ?? ''}`,
  '1 day': '1 день',
  '{{count}} days': (v) =>
    `${v?.['count'] ?? ''} ${ruPlural(v?.['count'], 'день', 'дня', 'дней')}`,
  '1 hour': '1 час',
  '{{count}} hours': (v) =>
    `${v?.['count'] ?? ''} ${ruPlural(v?.['count'], 'час', 'часа', 'часов')}`,
  'subscription.entryTitle': 'Аккаунт Qwen с подпиской',
  'subscription.entryDescription':
    'Откройте Qwen Code + Agent с планом Plus/Pro на chat.qwen.ai',
  'subscription.new': 'Новое',
  'subscription.openPlansDescription':
    'Открывает страницу тарифов Qwen Code в браузере',
  'subscription.switchProviderDescription':
    'Выбрать другого поставщика моделей',
  'subscription.upgradeDescription': 'Открыть тарифы подписки Qwen',
  'subscription.commandUnavailable':
    'Войдите в Qwen и выберите модель подписки Qwen, чтобы использовать эту команду.',
  'subscription.upgradeFailed':
    'Не удалось открыть тарифы подписки Qwen. Повторите попытку.',
  'subscription.signOutDescription':
    'Отключить это устройство от аккаунта Qwen',
  'subscription.title': 'Подписка Qwen',
  'subscription.waiting':
    'Открываем chat.qwen.ai в браузере… Войдите там, чтобы подключить Qwen Code.',
  'subscription.browserFallback': 'Если браузер не открылся, перейдите:',
  'subscription.pending': 'Ожидание входа…',
  'subscription.checking': 'Проверяем подписку…',
  'subscription.waitingForPurchase': 'Ожидаем активации подписки…',
  'subscription.included': 'Qwen Code входит в Qwen Plus и Pro',
  'subscription.openAuthorization': 'Открыть страницу авторизации',
  'subscription.openPlans': 'Тарифы',
  'subscription.checkAgain': 'Повторить подключение',
  'subscription.switchProvider': 'Сменить поставщика',
  'subscription.useAnotherAccount': 'Другой аккаунт',
  'subscription.successTitle': 'Вход выполнен',
  'subscription.successDescription': 'Теперь можно использовать Qwen Code.',
  'subscription.accountLabel': 'Аккаунт',
  'subscription.planLabel': 'План',
  'subscription.modelLabel': 'Модель',
  'subscription.startUsing': 'Начать',
  'subscription.signOut': 'Выйти',
  'subscription.signedOut':
    'Вы вышли из Qwen. Выполните /auth, чтобы войти снова.',
  'subscription.signedOutLocally':
    'Вы вышли локально, но удалённую сессию отозвать не удалось.',
  'subscription.signOutFailed': 'Не удалось выйти из Qwen. Повторите попытку.',
  'subscription.logoutNotRequired':
    'Для этого подключения /logout не нужен. Чтобы сменить поставщика моделей, используйте /auth.',
  'subscription.unavailable': 'Подписка Qwen недоступна в этой сборке.',
  'subscription.cancel': 'Отмена',
  'subscription.connecting': 'Загрузка моделей у поставщика…',
  'subscription.refreshFailed':
    'Не удалось обновить сессию Qwen. Повторите попытку.',
  'subscription.credentialsFailed':
    'Не удалось прочитать или сохранить учётные данные Qwen. Проверьте права на файлы и свободное место на диске.',
  'subscription.rateLimited':
    'Слишком много запросов. Повторите попытку позже.',
  'subscription.networkFailed':
    'Сетевой запрос не выполнен или истекло время ожидания.',
  'subscription.modelsUnavailable':
    'Не удалось загрузить модели. В аккаунте вы по-прежнему вошли. Повторите попытку.',
  'subscription.connected': (v) =>
    `✓ Вход выполнен · ${v?.email ?? ''}  \n✓ Текущий план: Qwen ${v?.plan ?? ''}. Qwen Code готов.${v?.model ? `  \nМодель: ${v.model}. Выполните /upgrade, чтобы повысить план, /usage — чтобы посмотреть использование, или /model — чтобы сменить модель.` : ''}${v?.url ? `  \nЕсли браузер не открылся, перейдите:  \n${v.url}` : ''}  \nЧастые команды: /usage   /upgrade   /model   /status   /logout`,
  'subscription.signedIn': (v) => `Вход выполнен · ${v?.email ?? ''}`,
  'subscription.modelSummary': (v) =>
    `Модель: ${v?.model ?? ''}. Выполните /upgrade, чтобы повысить план, /usage — чтобы посмотреть использование, или /model — чтобы сменить модель.`,
  'subscription.commonCommands':
    'Частые команды: /usage   /upgrade   /model   /status   /logout',
  'subscription.loginRequired':
    'Учётные данные больше недействительны. Выполните /auth, чтобы войти снова.',
  'subscription.signedInWithPlan': (v) =>
    `Вы вошли как ${v?.email ?? ''} (Qwen ${v?.plan ?? ''})`,
  'subscription.ready': (v) =>
    `Текущий план: Qwen ${v?.plan ?? ''}. Qwen Code готов.`,
  'subscription.purchase-required': (v) =>
    `Вы вошли с аккаунтом ${v?.plan ?? ''}, в который не входит Qwen Code. Выберите Plus или Pro в браузере; после оформления подписки Qwen Code продолжится автоматически.`,
  'remoteAccess.title': 'Разрешить удалённые подключения',
  'remoteAccess.description':
    'Откройте доступ к этому серверу без перезапуска. Локальные сессии и задачи продолжат работу.',
  'remoteAccess.server': 'Текущий сервер',
  'remoteAccess.loading': 'Читаем статус удалённого доступа…',
  'remoteAccess.on': 'Удалённый доступ включён.',
  'remoteAccess.off':
    'Удалённый доступ выключен. Включайте его здесь при необходимости; после перезапуска сервера он снова выключен.',
  'remoteAccess.external':
    'Основной слушатель настроен извне. Этот переключатель не закроет доступ, открытый параметрами запуска или прокси.',
  'remoteAccess.localOnly':
    'Откройте настройки этого сервера через его авторизованное локальное подключение, чтобы управлять удалённым доступом.',
  'remoteAccess.unavailable':
    'Этот daemon не поддерживает настройки удалённого доступа.',
  'remoteAccess.network': 'Сетевой интерфейс',
  'remoteAccess.noNetwork':
    'На этом сервере нет доступного внешнего IPv4-интерфейса.',
  'remoteAccess.address': 'Адрес подключения',
  'remoteAccess.reveal': 'Показать токен',
  'remoteAccess.hide': 'Скрыть токен',
  'remoteAccess.copyToken': 'Копировать токен',
  'remoteAccess.reset': 'Сбросить токен',
  'remoteAccess.resetHint':
    'Отключение доступа или сброс токена разрывает удалённых клиентов. Задачи на сервере продолжают работу.',
  'remoteAccess.http':
    'HTTP не шифруется. Используйте этот адрес в доверенной сети; страницам HTTPS нужна конечная точка HTTPS.',
  'remoteAccess.encrypted':
    'Эта конечная точка использует HTTPS. Клиент должен доверять её сертификату.',
  'remoteAccess.advanced': 'Расширенные параметры подключения',
  'remoteAccess.port': 'Порт (пустое значение — текущий порт сервера)',
  'remoteAccess.origins':
    'Дополнительные источники страниц (по одному в строке)',
  'remoteAccess.originsHint':
    'HTTP-страницы на localhost и 127.0.0.1 с любым портом уже разрешены. Применение источников переподключает удалённых клиентов.',
  'remoteAccess.apply': 'Применить источники',
  'remoteAccess.copied': 'Скопировано.',
  'remoteAccess.copyFailed':
    'Не удалось скопировать. Покажите значение и выделите его, чтобы скопировать вручную.',
  'capacityChoice.persistenceUnconfirmed':
    'Сохранение последнего прерванного хода не подтверждено.',
  'capacityChoice.title': 'Выберите рабочую область для остановки',
  'capacityChoice.description':
    'Свободной ёмкости ACP нет. Выберите рабочую область, сессии которой нужно остановить, или отмените и продолжите работу.',
  'capacityChoice.warning':
    'Остановка прервёт все перечисленные сессии и их инструменты. Файлы, регистрация рабочей области и сохранённая история останутся. Несохранённая работа может быть потеряна. Закрытие этого диалога после подтверждения не отменяет остановку.',
  'capacityChoice.outdated':
    'Черновик, сессия или daemon изменились. Отмените и повторите исходную операцию.',
  'capacityChoice.inProgress':
    'Выбранная остановка ещё обрабатывается. Обновите её статус, прежде чем продолжать.',
  'capacityChoice.failedUnreleased':
    'Остановка не удалась. Эта рабочая область недоступна, пока не подтверждено завершение старых процессов. Ёмкость по-прежнему занята. Обновите, чтобы проверить очистку.',
  'capacityChoice.failedUnknownCleanup':
    'Остановка не удалась. Очистку подтвердить не удалось. Обновите статус, прежде чем продолжать.',
  'capacityChoice.workspaces': 'Рабочая область для остановки',
  'capacityChoice.requester':
    'Эта рабочая область владеет операцией, которую вы пытаетесь продолжить.',
  'capacityChoice.running': 'Выполняется',
  'capacityChoice.waiting': 'Ожидание вашего ответа',
  'capacityChoice.background': 'Фоновая работа выполняется',
  'capacityChoice.backgroundUnknown': 'Статус фоновой работы неизвестен',
  'capacityChoice.none':
    'Сейчас здесь нельзя остановить ни одну рабочую область. Просмотрите причины выше, остановите независимую работу или отмените.',
  'capacityChoice.refresh': 'Обновить статус',
  'capacityChoice.continue': 'Продолжить исходную операцию',
  'capacityChoice.confirm': 'Остановить эти сессии и продолжить',
  'capacityChoice.stopped':
    'Эта рабочая область остановлена, чтобы освободить ёмкость ACP. Возобновите этот разговор при необходимости.',
  'capacityChoice.resume': 'Возобновить разговор',
  'capacityChoice.blocked.stopping': 'Остановка',
  'capacityChoice.blocked.not_live': 'Нет активного ACP',
  'capacityChoice.blocked.release_unavailable':
    'Освобождение своего процесса нельзя наблюдать',
  'capacityChoice.blocked.session_start_pending':
    'Идёт запуск или восстановление сессии',
  'capacityChoice.blocked.workspace_control_pending':
    'Идёт управление рабочей областью или работа MCP',
  'capacityChoice.blocked.session_closing': 'Идёт закрытие или сброс сессии',
  'capacityChoice.blocked.runtime_unavailable':
    'Рабочая область недоступна или не доверена',
  'capacityChoice.blocked.special_runtime':
    'Рабочая область специального назначения',
  'capacityChoice.blocked.unsupported': 'Остановка runtime не поддерживается',
  'capacityChoice.blocked.activity_unknown': 'Активность нельзя наблюдать',
  'capacityChoice.blocked.pendingSessionStarts': 'Ожидание запуска сессии',
  'capacityChoice.blocked.acpConnections': 'Подключён клиент ACP',
  'capacityChoice.blocked.memoryTasks': 'Выполняется задача памяти',
  'capacityChoice.blocked.channelWorkers': 'Выполняется воркер канала',
  'capacityChoice.blocked.voiceSessions': 'Активна голосовая сессия',
  'capacityChoice.blocked.management_pending':
    'Ожидается управление рабочей областью',
  'capacityChoice.blocked.scheduler_pending':
    'Идёт восстановление запланированной сессии',
  'capacityChoice.blocked.enabled_scheduled_tasks':
    'Сначала отключите включённые запланированные задачи',
  'capacityChoice.blocked.scheduled_tasks_unknown':
    'Не удалось прочитать запланированные задачи',
  'capacityChoice.capacity': (v) => `Ёмкость ACP: ${v?.used} / ${v?.limit}`,
  'capacityChoice.sessions': (v) =>
    `${v?.count} ${ruPlural(v?.count, 'загруженная сессия', 'загруженные сессии', 'загруженных сессий')}`,
  'capacityChoice.queued': (v) => `${v?.count} в очереди`,
  'capacityChoice.outcome': (v) =>
    `${v?.closed} ${ruPlural(v?.closed, 'сессия закрыта', 'сессии закрыты', 'сессий закрыто')}; осталось ${v?.remaining}.`,
  'footnotes.note': (v) => `Сноска ${v?.number ?? ''}`,
  'footnotes.references': (v) =>
    `Показать ${v?.count ?? ''} ${ruPlural(v?.count, 'ссылку', 'ссылки', 'ссылок')}`,
  'footnotes.preview': 'Предпросмотр ссылки',
  'footnotes.previous': 'Предыдущая ссылка',
  'footnotes.next': 'Следующая ссылка',
  'footnotes.citations': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'цитата', 'цитаты', 'цитат')}`,
  'daemon.connection.paused':
    'Сервис недоступен. Автообновление приостановлено на время переподключения.',
  'daemon.connection.authRequired':
    'Ошибка аутентификации сервиса. Проверьте учётные данные; автообновление приостановлено.',
  'daemon.connection.unavailable': 'Сервис недоступен.',
  'localControl.connectionRetry':
    'Соединение прервано. Повторите, чтобы обновить QR-код.',
  'daemon.connection.retry': 'Повторить подключение',
  'hooksApproval.title': 'Этот проект хочет запускать hooks',
  'hooksApproval.description':
    'Hooks в .qwen/settings.json этого проекта выполняют команды на вашем компьютере. Они остаются отключёнными, пока вы не одобрите именно эту конфигурацию. Любое изменение hooks или проектного .env запросит подтверждение снова.',
  'hooksApproval.scopeNote':
    'Одобрение записывает решение только для этого проекта. Если включено доверие к папке и эта папка не доверена, hooks останутся отключёнными, пока папка не станет доверенной.',
  'hooksApproval.approve': 'Одобрить hooks',
  'hooksApproval.reject': 'Оставить отключёнными',
  'hooksApproval.failed':
    'Решение не удалось сохранить. Ничего не изменилось; повторите попытку.',
  'daemon.capacity.exhausted':
    'Сервис достиг лимита одновременной ёмкости и не может запустить эту сессию. Повторите позже или отмените операцию.',
  'managed.title': 'Управляемые агенты',
  'managed.executionMode': 'Режим выполнения',
  'workspace.executionDaemon': 'Локальный (daemon)',
  'workspace.executionManaged': 'Управляемый (Managed Agent)',
  'workspace.executionHint':
    'Новые задачи в этой рабочей области используют выбранный сервис.',
  'managed.localMode': 'Локальный',
  'managed.managedMode': 'Управляемый',
  'managed.sessions': 'Управляемые сессии',
  'managed.conversation': 'Управляемый разговор',
  'managed.new': 'Новая управляемая задача',
  'managed.refresh': 'Обновить',
  'managed.empty': 'Управляемых задач пока нет.',
  'managed.loading': 'Загрузка…',
  'managed.listLoadFailed': 'Не удалось загрузить управляемые сессии.',
  'managed.listRetry': 'Повторить загрузку сессий',
  'managed.errorDetails': (v) =>
    `HTTP ${v?.status ?? ''} · ${v?.code ?? ''}${v?.requestId ? ` · ID запроса: ${v.requestId}` : ''}`,
  'managed.todo.loadedWindow': 'Из загруженной записи сессии.',
  'managed.more': 'Загрузить ещё',
  'managed.titleSearch': 'Поиск по заголовкам сессий',
  'managed.titleSearchPlaceholder': 'Фильтр по заголовку…',
  'managed.prompt': 'Сообщение управляемому агенту',
  'managed.queue.title': 'Сообщения в очереди',
  'managed.queue.paused': 'Пауза',
  'managed.queue.resume': 'Продолжить отправку',
  'managed.queue.edit': 'Изменить',
  'managed.queue.withdraw': 'Отозвать',
  'managed.queue.discard': 'Убрать из очереди',
  'managed.queue.unknownDelivery':
    'Доставка не подтверждена. Удаление из очереди снимает блокировку этим сообщением; уже полученный ввод не отменяется. После этого явно продолжите отправку.',
  'managed.queue.save': 'Сохранить',
  'managed.queue.cancelEdit': 'Отменить правку',
  'managed.queue.waiting': 'Ожидание вставки',
  'managed.queue.claimed': 'Подготовка доставки',
  'managed.queue.blocked': 'Доставка требует восстановления',
  'managed.queue.imagesIdleOnly':
    'Дождитесь окончания текущего Turn, прежде чем отправлять изображения.',
  'managed.queue.placeholder': 'Добавить указания к текущему Turn',
  'managed.runtime': 'Среда',
  'managed.unavailable': 'Управляемые агенты недоступны на этом daemon.',
  'managed.send': 'Отправить',
  'managed.sending': 'Отправка…',
  'managed.elapsed': (v) => `прошло ${v?.seconds ?? 0} с`,
  'managed.runningHint':
    'Этот ход выполняется. Отправка другого сообщения приостановлена.',
  'managed.retry': 'Повторить тот же запрос',
  'managed.cancel': 'Отменить ход',
  'managed.uncertain':
    'Предыдущее сообщение не подтверждено как отправленное. Повтор использует тот же запрос и не выполнится дважды.',
  'managed.pendingElsewhere':
    'В другом разговоре есть неподтверждённый запрос. Вернитесь к нему, прежде чем отправлять новое сообщение.',
  'managed.openPendingOwner': 'Открыть исходный разговор',
  'managed.discard': 'Отбросить этот запрос',
  'managed.pendingRestoreFailed':
    'Ожидающий запрос нельзя восстановить; возможно, он уже отправлен. Проверьте сессию, прежде чем отбрасывать эту запись.',
  'managed.pendingDiscardFailed':
    'Не удалось отбросить этот запрос. Хранилище браузера недоступно. Повторите или перезагрузите страницу.',
  'managed.discarded': 'Запрос отброшен. Черновик возвращён в поле ввода.',
  'managed.newRequired':
    'Начните новую задачу, чтобы отправить другое сообщение.',
  'managed.truncated': '[Подробности обрезаны]',
  'managed.actions.title': 'Ожидающие запросы',
  'managed.actions.root': 'Эта сессия',
  'managed.actions.child': (v) => `Дочерняя сессия · ${v?.session}`,
  'managed.actions.childSource': 'Запрос дочерней сессии',
  'managed.actions.question': 'Вопрос',
  'managed.actions.permission': 'Разрешение',
  'managed.actions.expired': 'Истекло',
  'managed.actions.expires': (v) => `Истекает ${v?.time}`,
  'managed.question.other': 'Другой ответ',
  'managed.question.expired':
    'Этот вопрос истёк. Обновите, чтобы проверить сессию.',
  'managed.question.tooLarge':
    'Каждый текстовый ответ — не более 8192 символов, все ответы вместе — не более 32 KiB.',
  'managed.question.failed':
    'Ответ не подтверждён. Повторите те же ответы или обновите, чтобы проверить статус.',
  'managed.question.forbidden':
    'Отвечать на эти вопросы может только владелец сессии или оператор рабочей области.',
  'managed.approval.failed':
    'Ответ на запрос разрешения не подтверждён. Повторите тот же вариант или обновите, чтобы проверить статус.',
  'managed.approval.loadFailed': 'Не удалось загрузить ожидающие запросы.',
  'managed.approval.refreshFailed': 'Не удалось обновить ожидающие запросы.',
  'managed.approval.retry': 'Повторить загрузку запросов',
  'managed.approval.forbidden':
    'Отвечать на этот запрос разрешения может только владелец сессии или оператор рабочей области.',
  'managed.approval.argumentsUnavailable':
    'Аргументы инструмента для этого разрешения недоступны.',
  'managed.approval.previewComplete': (v) =>
    `Предпросмотр ввода: ${v?.bytes ?? 0} ${ruPlural(v?.bytes, 'байт', 'байта', 'байтов')}.`,
  'managed.approval.previewTruncated': (v) =>
    `Предпросмотр ввода обрезан. Полный ввод: ${v?.bytes ?? 0} ${ruPlural(v?.bytes, 'байт', 'байта', 'байтов')}.`,
  'managed.result.range': (v) => `Байты ${v?.start}–${v?.end} из ${v?.total}`,
  'managed.result.outputs': 'Результаты',
  'managed.result.view': 'Показать вывод',
  'managed.result.empty': 'Опубликованного вывода пока нет.',
  'managed.result.description':
    'Читать сохранённый вывод без повторного запуска команды.',
  'managed.result.preview': 'Одобренный предпросмотр',
  'managed.result.previewTruncated':
    'Предпросмотр обрезан; это не значит, что захваченный вывод неполный.',
  'managed.result.execution.success': 'Команда выполнена',
  'managed.result.execution.error': 'Команда завершилась с ошибкой',
  'managed.result.execution.cancelled': 'Команда отменена',
  'managed.result.execution.not_started': 'Команда не выполнена',
  'managed.result.capture.complete': 'Захват завершён',
  'managed.result.capture.partial': 'Захват неполный',
  'managed.result.capture.unavailable': 'Захват недоступен',
  'managed.result.capture.none': 'Нет захвата',
  'managed.result.delivery.pending': 'Сохранение вывода',
  'managed.result.delivery.committed': 'Вывод сохранён',
  'managed.result.delivery.blocked': 'Доставка вывода заблокирована',
  'managed.result.forbidden': 'Исходный вывод недоступен для вашего аккаунта.',
  'managed.result.unavailable': 'Сохранённые байты сейчас недоступны.',
  'managed.result.downloadUnsupported':
    'Этому браузеру нужна интеграция с хостом, чтобы сохранить потоковую загрузку.',
  'managed.result.previous': 'Предыдущая страница',
  'managed.result.next': 'Следующая страница',
  'managed.result.expired': 'Эта редакция вывода истекла.',
  'managed.result.changed':
    'Эта редакция вывода изменилась. Обновите, чтобы выбрать текущую.',
  'managed.result.reading': 'Чтение вывода…',
  'managed.result.emptyStream': 'Пустой вывод (0 байт)',
  'managed.result.close': 'Закрыть вывод',
  'managed.result.refresh': 'Обновить вывод',
  'managed.phase.created': 'Создано',
  'managed.creationSkillsFromSettings':
    'Включённые Skill на странице Skills добавляются в новые управляемые сессии. Существующие сессии сохраняют исходные Skill.',
  'managed.creationSkillsSourceChanged':
    'Источник Skills изменился. Повторите с выбранным источником.',
  'managed.creationSkillsUnavailable':
    'Не удалось загрузить включённые Skill для этой управляемой сессии.',
  'managed.workspaceCreateTitle': 'Создать сессию рабочей области',
  'managed.workspaceLabel': 'Рабочая область',
  'managed.modelPreset': 'Модель / пресет агента',
  'managed.modelDefault': 'Модель сервера по умолчанию',
  'managed.modelPinned':
    'Выберите начальную модель и пресет агента. В поддерживаемых разговорах модель можно сменить в простое.',
  'managed.workspaceChoose': 'Выбрать рабочую область',
  'managed.workspaceDirectory': 'Относительный каталог',
  'managed.workspaceWorkingDirectory': 'Рабочий каталог',
  'managed.workspaceWorkingDirectoryDescription':
    'Выберите, откуда начнётся эта сессия внутри рабочей области. Используйте . для корня рабочей области.',
  'managed.cwd.path': 'Каталог относительно корня рабочей области',
  'managed.workspaceCreate': 'Создать сессию',
  'managed.workspaceBound': 'Привязанная рабочая область',
  'managed.workspaceExecutionUnavailable':
    'Рабочая область привязана. В этой сессии нельзя отправлять сообщения.',
  'managed.workspaceSharedFiles':
    'Сессии в одной рабочей области используют общие файлы. Доступность каталога проверяется перед выполнением.',
  'managed.workspaceEmpty': 'Нет доступных для чтения рабочих областей.',
  'managed.newWorkspaceTitle': 'Новая рабочая область',
  'managed.modelFixed':
    'Модель для этой задачи фиксирована. Чтобы выбрать другую, начните новую задачу.',
  'managed.approvalChange.loading': 'Загрузка политик разрешения…',
  'managed.approvalChange.optionsError':
    'Не удалось загрузить политики разрешения.',
  'managed.approvalChange.reload': 'Перезагрузить политики',
  'managed.approvalChange.nextTurn':
    'Изменения политики разрешения применяются к следующему ходу.',
  'managed.approvalChange.live':
    'Изменения политики разрешения применяются к последующим вызовам инструментов в этом ходе.',
  'managed.approvalChange.changing': 'Смена политики разрешения…',
  'managed.approvalChange.unconfirmed':
    'Смена разрешения не подтверждена. Продолжите подтверждение исходного запроса.',
  'managed.approvalChange.confirm': 'Продолжить подтверждение',
  'managed.approvalChange.busy':
    'Завершите текущий ход или восстановление, прежде чем менять политику разрешения.',
  'managed.approvalChange.storage':
    'Сессионное хранилище браузера недоступно. Смена разрешения не отправлена.',
  'managed.approvalChange.conflict':
    'Политика разрешения изменена в другом месте. Проверьте текущий выбор.',
  'managed.approvalChange.failed':
    'Смена разрешения отклонена. Просмотрите доступные политики.',
  'managed.permissionRules.title': 'Правила разрешений',
  'managed.permissionRules.description':
    'Правила принадлежат этому разговору. Редактируйте в простое. Запрет имеет приоритет, а явное «Спрашивать» всегда требует вашего одобрения, в том числе в YOLO.',
  'managed.permissionRules.syntax':
    'Одно правило в строке: Read, Bash(git status*), WebFetch(domain:example.com) или mcp__server__tool. Правила путей не поддерживаются. До 32 в каждом списке и 64 всего.',
  'managed.permissionRules.allow': 'Разрешить',
  'managed.permissionRules.ask': 'Спрашивать каждый раз',
  'managed.permissionRules.deny': 'Запретить',
  'managed.permissionRules.invalid':
    'Проверьте синтаксис правил, дубликаты и лимиты: 512 байт UTF-8 на правило, 8 KiB всего.',
  'managed.permissionRules.clear': 'Очистить правила',
  'managed.permissionRules.save': 'Сохранить правила',
  'managed.model.loading': 'Загрузка доступных моделей…',
  'managed.model.optionsError': 'Не удалось загрузить доступные модели.',
  'managed.model.reload': 'Перезагрузить модели',
  'managed.model.nextTurn':
    'Следующее сообщение использует выбранную модель. Уже выполняющаяся задача сохраняет свою модель; история разговора сохраняется.',
  'managed.model.changing': 'Смена модели…',
  'managed.model.busy':
    'Смена модели временно недоступна для этой сессии. Повторите чуть позже.',
  'managed.model.conflict':
    'Модель изменилась. Проверьте текущий выбор и повторите.',
  'managed.model.failed':
    'Не удалось сменить модель. Проверьте текущий выбор и повторите.',
  'managed.approvalOptionsLoading': 'Загрузка режимов разрешения…',
  'managed.approvalOptionsLoadFailed':
    'Не удалось загрузить режимы разрешения.',
  'managed.approvalOptionsInvalid':
    'Сервис вернул неподдерживаемые режимы разрешения.',
  'managed.approvalFixed':
    'Эта сессия не поддерживает смену политики разрешения.',
  'managed.newWorkspaceDescription':
    'Выберите существующий каталог проекта или задайте имя новой пустой рабочей области.',
  'managed.workspaceDirectoryRoot': 'Авторизованные каталоги',
  'managed.localDirectoryHint':
    'Выберите существующий проект на этом компьютере. Настройка рабочей области выполняется автоматически.',
  'managed.workspaceDirectoryHint':
    'Выберите существующий проект на узле выполнения внутри этого авторизованного корня.',
  'managed.workspaceChooseDirectory': 'Выбрать существующий каталог',
  'managed.workspaceDirectoryScope':
    'Выберите каталог внутри выбранного корня.',
  'managed.newWorkspaceName': 'Имя рабочей области',
  'managed.newWorkspaceNameInvalid':
    'Используйте имя из 1–128 символов без управляющих символов.',
  'managed.newWorkspaceCreate': 'Создать рабочую область',
  'managed.newWorkspaceCreating': 'Создание рабочей области…',
  'managed.newWorkspaceUncertain':
    'Создание ещё не подтверждено. Повторите, чтобы проверить ту же рабочую область, или откажитесь от локального подтверждения, чтобы начать заново. Отказ не удаляет рабочую область, которая, возможно, уже существует.',
  'managed.newWorkspaceResume': 'Продолжить создание рабочей области',
  'managed.newWorkspaceClose': 'Закрыть',
  'managed.workspaceUnsupported':
    'Этот сервис не поддерживает привязку рабочей области.',
  'managed.workspacePermission':
    'У вас нет прав на обнаружение рабочих областей.',
  'managed.workspaceLoadFailed': 'Не удалось загрузить рабочие области.',
  'managed.workspaceStorageUnavailable':
    'Сессионное хранилище браузера недоступно. Создание нельзя начать безопасно.',
  'managed.workspaceUncertain':
    'Создание не подтверждено. Повторите сохранённый запрос или прочитайте сохранённую сессию.',
  'managed.workspaceRetryRead': 'Повторить чтение сессии',
  'managed.workspaceSessionId': 'ID сессии',
  'managed.workspaceProtocolError': (v) =>
    `Сессия ${v?.sessionId ?? ''} создана, но её привязку к рабочей области подтвердить не удалось.`,
  'managed.workspaceAbandon': 'Отказаться от локального подтверждения',
  'managed.workspaceAbandonWarning':
    'Исходная пустая сессия всё ещё может существовать. Отказ от этой записи её не удаляет.',
  'managed.workspaceAbandonInputWarning':
    'Сессия с этим вводом уже может существовать или выполняться. Отказ от этой записи её не отменяет. Повторная отправка начнёт новый запрос и может повторить эффекты.',
  'managed.workspaceSwitchTitle': 'Сменить рабочую область?',
  'managed.workspaceSwitchDescription':
    'Смена сбрасывает относительный каталог на корень рабочей области.',
  'managed.workspaceKeep': 'Оставить выбор',
  'managed.workspaceSwitch': 'Сменить',
  'managed.phase.admitted': 'Принято',
  'managed.phase.runtime_starting': 'Подготовка среды',
  'managed.phase.agent_running': 'Думает / отвечает',
  'managed.phase.waiting_runtime': 'Ожидание среды',
  'managed.phase.tool_running': 'Выполнение инструмента',
  'managed.phase.cancelling': 'Отмена',
  'managed.phase.completed': 'Завершено',
  'managed.phase.failed': 'Ошибка',
  'managed.phase.cancelled': 'Отменено',
  'managed.runtime.unknown': 'Неизвестно',
  'managed.runtime.starting': 'Подготовка',
  'managed.runtime.ready': 'Готово',
  'managed.runtime.failed': 'Подготовка не удалась',
  'git.currentBranch': (v) => `Текущая ветка Git: ${v?.branch ?? ''}`,
  'git.detached': 'Отделённый HEAD',
  'git.clean': 'Рабочее дерево чистое',
  'git.operation.merge': 'Слияние',
  'git.operation.rebase': 'Перебазирование',
  'git.operation.cherry-pick': 'Cherry-pick',
  'git.operation.revert': 'Отмена коммита',
  'git.operation.bisect': 'Бинарный поиск',
  'git.conflicted': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'конфликт', 'конфликта', 'конфликтов')}`,
  'git.staged': (v) => `${v?.count ?? 0} в индексе`,
  'git.unstaged': (v) => `${v?.count ?? 0} изменено`,
  'git.untracked': (v) => `${v?.count ?? 0} неотслеживаемых`,
  'git.ahead': (v) => `${v?.count ?? 0} впереди`,
  'git.behind': (v) => `${v?.count ?? 0} позади`,
  'git.stash': (v) => `${v?.count ?? 0} в stash`,
  'branchPicker.label': 'Git',
  'branchPicker.search': 'Поиск веток и действий',
  'branchPicker.loading': 'Загрузка веток…',
  'branchPicker.noBranches': 'Нет веток',
  'branchPicker.noTags': 'Нет тегов',
  'branchPicker.action.pull': 'Обновить проект',
  'branchPicker.action.push': 'Отправить',
  'branchPicker.action.commit': 'Коммит',
  'branchPicker.action.newBranch': 'Новая ветка…',
  'branchPicker.action.checkoutRef': 'Переключить на тег или ревизию…',
  'branchPicker.action.viewChanges': 'Показать изменения',
  'branchPicker.action.worktrees': 'Worktrees…',
  'branchPicker.action.history': 'История',
  'branchPicker.newBranchPlaceholder': 'Имя ветки',
  'branchPicker.invalidBranchName':
    'Недопустимое имя ветки — избегайте пробелов, ~, ^, :, ? * и ведущего -',
  'branchPicker.checkoutRefPlaceholder': 'Имя тега или SHA коммита',
  'branchPicker.section.recent': 'Недавние',
  'branchPicker.section.local': 'Локальные',
  'branchPicker.section.remote': 'Удалённые',
  'branchPicker.section.tags': 'Теги',
  'branchPicker.checkedOut': (v) => `Переключено на ${v?.branch ?? ''}`,
  'branchPicker.checkoutBlocked':
    'Переключение блокируют незафиксированные изменения',
  'branchPicker.checkoutStash': 'Отложить изменения в stash и переключиться',
  'branchPicker.checkoutDiscard': 'Отбросить изменения и переключиться…',
  'branchPicker.checkoutDiscardGo': 'Отбросить и переключиться',
  'branchPicker.checkoutStashKept': (v) =>
    `Переключено на ${v?.branch ?? ''}. Ваши изменения сохранены в записи stash ${String(v?.sha ?? '').slice(0, 12) || '(см. git stash list)'} — восстановите их командой git stash apply, когда потребуется.`,
  'branchPicker.createdBranch': (v) => `Создана ветка ${v?.branch ?? ''}`,
  'branchPicker.pushSuccess': 'Успешно отправлено',
  'branchPicker.pullSuccess': 'Успешно обновлено',
  'branchPicker.pullBlocked':
    'Обновление блокируют незафиксированные изменения',
  'branchPicker.pullStash': 'Отложить изменения в stash и обновить',
  'branchPicker.pullDiscard': 'Отбросить изменения и обновить…',
  'branchPicker.pullDiscardConfirm':
    'Отбросить ВСЕ незафиксированные изменения (включая неотслеживаемые файлы)? Это нельзя отменить.',
  'branchPicker.pullDiscardGo': 'Отбросить и обновить',
  'branchPicker.pullStashConflict': (v) =>
    `Обновлено, но восстановить изменения из stash не удалось. Они сохранены в записи stash ${String(v?.sha ?? '').slice(0, 12) || '(см. git stash list)'} — разрешите маркеры конфликта, затем восстановите вручную.`,
  'branchPicker.cancel': 'Отмена',
  'branchPicker.hint.upToDate': 'Актуально',
  'branchPicker.hint.noUpstream': 'Нет отслеживания',
  'branchPicker.hint.upstreamGone': 'Отслеживание исчезло',
  'branchPicker.hint.behindDirty': (v) =>
    `↓${v?.count ?? 0} · незафиксированные изменения`,
  'branchPicker.hint.setsUpstream': 'Задаёт отслеживание при отправке',
  'branchPicker.hint.createsPushBranch': (v) => `Создаёт ${v?.target ?? ''}`,
  'branchPicker.hint.aheadBehind': (v) =>
    `↑${v?.ahead ?? 0} ↓${v?.behind ?? 0} · разошлись`,
  'branchPicker.hint.nothingToPush': 'Нечего отправлять',
  'branchPicker.hint.noChanges': 'Нет изменений',
  'branchPicker.hint.changes': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'изменение', 'изменения', 'изменений')}`,
  'branchPicker.hint.changesUntracked': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'изменение', 'изменения', 'изменений')} (${v?.untracked ?? 0} неотслеживаемых)`,
  'branchPicker.action.manageRemotes': 'Управление удалёнными…',
  'branchPicker.remotes.title': 'Удалённые',
  'branchPicker.remotes.back': 'Назад к веткам',
  'branchPicker.remotes.loading': 'Загрузка удалённых…',
  'branchPicker.remotes.empty': 'Удалённые не настроены',
  'branchPicker.remotes.noMatches': 'Нет удалённых, подходящих под поиск',
  'branchPicker.remotes.namePlaceholder': 'Имя удалённого',
  'branchPicker.remotes.urlPlaceholder': 'URL удалённого',
  'branchPicker.remotes.add': 'Добавить',
  'branchPicker.remotes.remove': (v) => `Удалить ${v?.name ?? ''}`,
  'branchPicker.remotes.removeConfirm': 'Подтвердить',
  'branchPicker.remotes.removeConfirmFor': (v) =>
    `Подтвердить удаление ${v?.name ?? ''}${v?.extras ? ` (${v.extras})` : ''}`,
  'branchPicker.remotes.invisibleName': '(невидимое имя)',
  'branchPicker.remotes.hiddenChars': '(скрытые символы)',
  'branchPicker.remotes.lookalikeName': '(похожее имя)',
  'branchPicker.remotes.searchPlaceholder': 'Поиск удалённых',
  'branchPicker.remotes.urlTooltipFetch': (v) => `fetch: ${v?.url ?? ''}`,
  'branchPicker.remotes.urlTooltipPush': (v) => `push: ${v?.url ?? ''}`,
  'branchPicker.remotes.promisor': 'частичный клон',
  'branchPicker.remotes.partialClone': (v) => `частичный клон (${v?.filter})`,
  'branchPicker.remotes.customRefspec': 'свой refspec',
  'branchPicker.remotes.extraUrls': (v) => `+${v?.count ?? 0} URL`,
  'branchPicker.remotes.otherSettings': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'другая настройка', 'другие настройки', 'других настроек')}`,
  'branchPicker.remotes.added': (v) => `Добавлен репозиторий ${v?.name ?? ''}`,
  'branchPicker.remotes.removed': (v) => `Удалён репозиторий ${v?.name ?? ''}`,
  'branchPicker.remotes.invalidInput':
    'Введите имя удалённого и URL (без ведущего -)',
  'gitCommit.title': 'Коммит',
  'gitCommit.messagePlaceholder':
    'Сообщение коммита (⌘/Ctrl+Enter — закоммитить)',
  'gitCommit.generating': 'Генерация сообщения коммита…',
  'gitCommit.genFailed': 'Автогенерация не удалась — напишите сообщение сами',
  'gitCommit.prLogUnavailable':
    'Не удалось загрузить коммиты для выбранной базовой ветки.',
  'gitCommit.prPushFirst':
    'Отправьте ветку в удалённый репозиторий, прежде чем создавать запрос на слияние.',
  'gitCommit.commit': 'Коммит',
  'gitCommit.commitAndPush': 'Закоммитить и отправить',
  'gitCommit.createPr': 'Создать запрос на слияние',
  'gitCommit.prTitlePlaceholder': 'Заголовок запроса на слияние',
  'gitCommit.prBodyPlaceholder': 'Описание (необязательно)',
  'gitCommit.prEdit': 'Изменить',
  'gitCommit.prPreview': 'Предпросмотр',
  'gitCommit.prSubmit': 'Создать',
  'gitCommit.prCreated': (v) => `Создан запрос на слияние #${v?.number ?? ''}`,
  'gitCommit.commitSuccess': (v) => `Закоммичено ${v?.sha ?? ''}`,
  'gitCommit.commitPushSuccess': (v) =>
    `Закоммичено и отправлено ${v?.sha ?? ''}`,
  'gitCommit.commitSuccessPushFailed': (v) =>
    `Закоммичено ${v?.sha ?? ''} — отправка не удалась: ${v?.error ?? 'неизвестно'}`,
  'branchSelect.baseBranch': 'Базовая ветка',
  'branchSelect.search': 'Поиск веток…',
  'branchSelect.loading': 'Загрузка…',
  'branchSelect.noMatches': 'Нет совпадений',
  'branchSelect.error': 'Не удалось загрузить ветки',
  'branchSelect.retry': 'Повторить',
  'branchSelect.local': 'локальная',
  'gitDiff.title': 'Изменения',
  'gitDiff.summary': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')} · +${v?.added ?? 0} −${v?.removed ?? 0}`,
  'gitDiff.loading': 'Загрузка изменений…',
  'gitDiff.empty': 'В рабочем дереве нет изменений',
  'gitDiff.unavailable': 'Git недоступен для этой рабочей области',
  'gitDiff.error': 'Не удалось загрузить изменения',
  'gitDiff.binary': 'Двоичный',
  'gitDiff.untracked': 'Неотслеживаемый',
  'gitDiff.deleted': 'Удалён',
  'gitDiff.noDiff': 'Нет изменений для отображения',
  'gitDiff.fileError': 'Не удалось загрузить этот diff',
  'gitDiff.truncated':
    'Diff обрезан — файл слишком большой, чтобы показать целиком',
  'gitDiff.hidden': (v) =>
    `ещё ${v?.count ?? 0} ${ruPlural(v?.count, 'файл не показан', 'файла не показаны', 'файлов не показано')}`,
  'gitDiff.expand': (v) => `Показать изменения для ${v?.path ?? 'файла'}`,
  'gitDiff.collapse': (v) => `Скрыть изменения для ${v?.path ?? 'файла'}`,
  'gitMode.title': 'Режим Git',
  'gitMode.current': 'Текущая ветка',
  'gitMode.currentDesc': (v) => `Разрабатывать прямо в ${v?.branch ?? 'main'}`,
  'gitMode.branch': 'Новая ветка',
  'gitMode.branchDesc': (v) => `Создать новую ветку от ${v?.branch ?? 'main'}`,
  'gitMode.branchPlaceholder': 'feat/my-feature',
  'gitMode.branchLabel': 'Имя ветки',
  'gitMode.branchConflictWarning':
    'Одновременно только одна сессия ветки на рабочую область',
  'gitMode.branchHint': 'Переключает рабочий каталог на новую ветку',
  'gitMode.branchInvalidName': 'Недопустимое имя ветки',
  'gitMode.worktree': 'Worktree',
  'gitMode.worktreeDesc':
    'Создаёт изолированную копию при отправке первого сообщения',
  'gitMode.confirmBranch': 'Создать ветку',
  'gitMode.resetToCurrent': 'Сбросить на текущую ветку',
  'gitLog.title': 'История',
  'gitLog.subtitle': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'коммит', 'коммита', 'коммитов')}`,
  'gitLog.loading': 'Загрузка истории…',
  'gitLog.empty': 'Коммитов пока нет',
  'gitLog.unavailable': 'Git недоступен для этой рабочей области',
  'gitLog.error': 'Не удалось загрузить историю',
  'gitLog.loadMore': 'Загрузить ещё',
  'gitLog.loadingMore': 'Загрузка…',
  'gitLog.files': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'файл', 'файла', 'файлов')} · +${v?.added ?? 0} −${v?.removed ?? 0}`,
  'gitLog.detailError': 'Не удалось загрузить сведения о коммите',
  'gitLog.hidden': (v) =>
    `ещё ${v?.count ?? 0} ${ruPlural(v?.count, 'файл не показан', 'файла не показаны', 'файлов не показано')}`,
  'gitLog.copySha': (v) => `Копировать коммит ${v?.sha ?? ''}`,
  'gitLog.allBranches': 'Все ветки',
  'gitLog.search': 'Поиск по сообщению, автору или хешу',
  'gitLog.noMatches': 'Нет подходящих коммитов',
  'gitWorktrees.title': 'Worktrees',
  'gitWorktrees.subtitle': (v) => `${v?.count ?? 0} worktree`,
  'gitWorktrees.loading': 'Загрузка worktrees…',
  'gitWorktrees.error': 'Не удалось загрузить worktrees',
  'gitWorktrees.unavailable': 'Git недоступен для этой рабочей области',
  'gitWorktrees.empty': 'Нет worktrees',
  'gitWorktrees.noMatches': 'Нет подходящих worktrees',
  'gitWorktrees.filter': 'Фильтр по пути или ветке',
  'gitWorktrees.newSession': 'Новая сессия worktree…',
  'gitWorktrees.main': 'основной',
  'gitWorktrees.current': 'эта рабочая область',
  'gitWorktrees.detached': 'отделённый HEAD',
  'gitWorktrees.bare': 'голый',
  'gitWorktrees.locked': 'заблокирован',
  'gitWorktrees.prunable': 'устаревший',
  'gitWorktrees.clean': 'чистый',
  'gitWorktrees.dirty': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'изменение', 'изменения', 'изменений')}`,
  'gitWorktrees.statusError': 'статус недоступен',
  'gitWorktrees.remove': 'Удалить',
  'gitWorktrees.removeLabel': (v) => `Удалить worktree ${v?.name ?? ''}`,
  'gitWorktrees.removing': 'Удаление…',
  'gitWorktrees.cancel': 'Отмена',
  'gitWorktrees.confirm':
    'Удалить этот worktree? Его каталог будет удалён с диска; ветка сохранится.',
  'gitWorktrees.confirmStale':
    'Удалить эту устаревшую запись? Git перестанет отслеживать worktrees, которые больше не может найти. То, что осталось в каталоге, сохранится; учётная запись git для него — нет.',
  'gitWorktrees.confirmDetached':
    'Удалить этот worktree? Его каталог будет удалён с диска. Он на отделённом HEAD, поэтому ветки для сохранения нет.',
  'gitWorktrees.blockedDirty': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'незафиксированное изменение будет отброшено', 'незафиксированных изменения будут отброшены', 'незафиксированных изменений будут отброшены')}.`,
  'gitWorktrees.blockedInUse': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'активная сессия потеряет', 'активные сессии потеряют', 'активных сессий потеряют')} рабочую копию.`,
  'gitWorktrees.blockedInUseUnknown': (v) =>
    `Не удалось прочитать, где работают ${v?.count ?? 0} ${ruPlural(v?.count, 'активная сессия', 'активные сессии', 'активных сессий')}. Те, что работают здесь, потеряют рабочую копию.`,
  'gitWorktrees.blockedUnknown':
    'Не удалось проверить рабочее дерево на незафиксированные изменения; если они есть, они будут отброшены.',
  'gitWorktrees.blockedOperation': (v) =>
    `Незавершённый ${v?.operation ?? 'git'} будет потерян.`,
  'gitWorktrees.blockedUnmerged': (v) =>
    `Никакая ветка не сохраняет коммиты здесь; ${String(v?.head ?? '').slice(0, 7)} останется для сборки мусора git.`,
  'gitWorktrees.blockedLocked': (v) =>
    v?.reason
      ? `Этот worktree заблокирован: ${v.reason}`
      : 'Этот worktree заблокирован.',
  'gitWorktrees.blockedRefused': 'Git отказался удалить этот worktree.',
  'gitWorktrees.blockedWorkspaceHere': (v) =>
    v?.name
      ? `Рабочая область ${v.name} находится в этом worktree, поэтому удаление уберёт и её. Сначала удалите рабочую область.`
      : 'В этом worktree находится зарегистрированная рабочая область, поэтому удаление уберёт и её. Сначала удалите рабочую область.',
  'gitWorktrees.blockedSubmodules':
    'Подмодуль этого worktree хранит собственный репозиторий, и удаление worktree удалит и его.',
  'gitWorktrees.blockedSubmodulesUnknown':
    'Не удалось проверить, хранит ли подмодуль этого worktree собственный репозиторий. Если да, удаление worktree удалит и его.',
  'gitWorktrees.refreshFailed':
    'Список не удалось обновить, поэтому он может быть устаревшим.',
  'gitWorktrees.removeAnyway': 'Удалить всё равно',
  'gitWorktrees.removeFailed': 'Не удалось удалить worktree',
  'gitWorktrees.keptDirectory': (v) =>
    `Git больше не отслеживает ${v?.name ?? ''}, но его каталог всё ещё на диске.`,
  'gitWorktrees.refusedElsewhere': (v) =>
    v?.reason
      ? `Удаление ${v?.name ?? ''} отклонено, пока вы смотрели в другое место: ${v.reason}`
      : `Удаление ${v?.name ?? ''} отклонено, пока вы смотрели в другое место.`,
  'githubPrs.title': 'Запросы на слияние',
  'githubPrs.subtitle': (v) => `${v?.count ?? 0} открыто`,
  'githubPrs.loading': 'Загрузка запросов на слияние…',
  'githubPrs.empty': 'Нет открытых запросов на слияние',
  'githubPrs.unavailable': 'Эта рабочая область не является git-репозиторием',
  'githubPrs.error': 'Не удалось загрузить запросы на слияние',
  'githubPrs.cliUnavailable':
    'GitHub CLI (gh) не установлен на хосте daemon.\nУстановите его и выполните `gh auth login`, затем повторите.',
  'githubPrs.reviewApproved': 'Одобрено',
  'githubPrs.reviewChanges': 'Запрошены изменения',
  'githubPrs.reviewRequired': 'Требуется ревью',
  'githubPrs.checksPassing': 'Проверки проходят',
  'githubPrs.checksFailing': 'Проверки не проходят',
  'githubPrs.checksPending': 'Проверки ожидаются',
  'githubPrs.open': (v) =>
    `Открыть запрос на слияние #${v?.number ?? ''} на GitHub`,
  'sessionsOverview.bindPr': 'Привязать PR',
  'sessionsOverview.bindPrPlaceholder': 'Номер или URL PR',
  'sessionsOverview.bindPrSubmit': 'Привязать',
  'sessionsOverview.bindPrInvalid': 'Введите номер PR или полный URL PR.',
  'sessionsOverview.bindPrNotInList': (v) =>
    `PR #${v?.number ?? ''} нет в списке открытых PR. Вставьте его полный URL.`,
  'sessionsOverview.bindPrListFailed':
    'Не удалось загрузить список PR. Вставьте полный URL PR.',
  'sessionsOverview.bindPrFailed': 'Не удалось привязать PR',
  'sessionsOverview.bindPrUnavailable':
    'Эта рабочая область не является git-репозиторием, поэтому номер PR нельзя найти. Вставьте полный URL PR.',
  'workspace.paneLabel': (v) => `Рабочая область: ${v?.name ?? ''}`,
  'about.auth': 'Аутентификация',
  'about.baseUrl': 'Base URL',
  'about.fastModel': 'Быстрая модель',
  'about.memoryUsage': 'Использование памяти',
  'about.model': 'Модель',
  'about.noProxy': 'без прокси',
  'about.noSandbox': 'без песочницы',
  'about.platform': 'ОС',
  'about.proxy': 'Прокси',
  'about.runtime': 'Среда выполнения',
  'about.sandbox': 'Песочница',
  'about.sessionId': 'ID сессии',
  'about.title': 'Статус',
  'agent.back': 'Назад',
  'agent.builtInBadge': '(встроенный)',
  'agent.action.delete': 'Удалить агента',
  'agent.action.edit': 'Изменить агента',
  'agent.action.view': 'Просмотреть агента',
  'agent.chooseAction': (v) => `Выберите действие для ${v?.name ?? ''}`,
  'agent.chooseActionTitle': 'Выберите действие',
  'agent.colorLabel': 'Цвет: ',
  'agent.colorUpdated': (v) => `Обновлён цвет для ${v?.name ?? ''}`,
  'agent.create': 'Создать нового субагента',
  'agent.create.button': 'Создать',
  'agent.create.confirm': 'Подтвердить и сохранить',
  'agent.create.desc': 'Создать нового субагента',
  'agent.create.descPlaceholder': 'Что делает этот агент?',
  'agent.create.describeAgent': 'Описать требования',
  'agent.create.description': 'Описание',
  'agent.create.editAgain': 'Изменить',
  'agent.create.enterDescription': 'Введите описание',
  'agent.create.enterName': 'Введите имя субагента',
  'agent.create.enterPrompt': 'Введите системный промпт',
  'agent.create.generateFailed': (v) =>
    `Не удалось сгенерировать субагента: ${v?.error ?? 'Неизвестная ошибка'}`,
  'agent.create.generate': 'Сгенерировать',
  'agent.create.generatedDescription': 'Описание',
  'agent.create.generatedSystemPrompt': 'Системный промпт',
  'agent.create.generatingConfig': 'Генерация конфигурации субагента...',
  'agent.create.generatingPrompt': 'Генерация...',
  'agent.create.loading': 'Создание...',
  'agent.create.location': 'Выберите расположение',
  'agent.create.method': 'Выберите способ генерации',
  'agent.create.method.manual': 'Создать вручную',
  'agent.create.method.qwen': 'Сгенерировать с Qwen Code',
  'agent.create.method.qwen.recommended':
    'Сгенерировать с Qwen Code (рекомендуется)',
  'agent.create.method.qwen.desc': 'LLM генерирует описание и системный промпт',
  'agent.create.name': 'Имя',
  'agent.create.namePlaceholder': 'my-agent',
  'agent.create.nameHelp':
    'Введите понятное уникальное имя для этого субагента.',
  'agent.create.project': 'Проект',
  'agent.create.project.cli': 'Рабочая область',
  'agent.create.project.desc': 'Создать субагента уровня проекта',
  'agent.create.prompt': 'Системный промпт',
  'agent.create.promptPlaceholder': 'Вы — специализированный агент, который...',
  'agent.create.promptPlaceholder.cli': 'напр., Вы — эксперт по ревью кода...',
  'agent.create.promptHelp':
    'Напишите системный промпт, который определяет поведение субагента. Для лучшего результата опишите подробно.',
  'agent.create.preview': 'Предпросмотр',
  'agent.create.qwenHint':
    'Опишите обязанности, сценарии использования и важные ограничения, затем сгенерируйте каждое поле отдельно.',
  'agent.create.qwenPlaceholder':
    '> напр., Эксперт по ревью кода, который проверяет код по лучшим практикам...',
  'agent.create.regenerate': 'Перегенерировать черновик',
  'agent.create.required': 'Имя, описание и системный промпт обязательны.',
  'agent.create.tools': 'Разрешённые инструменты',
  'agent.create.toolsHelp':
    'Введите канонические имена инструментов через запятую или с новой строки. Инструменты MCP используют mcp__server__tool; оставьте пустым, чтобы унаследовать все инструменты.',
  'agent.create.disallowedTools': 'Запрещённые инструменты',
  'agent.create.model': 'Модель',
  'agent.create.approvalMode': 'Режим разрешения',
  'agent.create.maxTurns': 'Максимум ходов выполнения',
  'agent.create.maxTurnsHelp':
    'Ограничивает раунды рассуждения модели для одной задачи. Выполнение останавливается на лимите; оставьте пустым, чтобы не задавать лимит агента.',
  'agent.create.maxTurnsInvalid':
    'Максимум ходов выполнения должен быть положительным целым числом.',
  'agent.create.mcpServers': 'Серверы MCP',
  'agent.create.mcpServers.empty': 'Нет доступных серверов MCP.',
  'agent.create.mcpServers.select': 'Выберите сервер MCP',
  'agent.create.mcpServers.noneSelected': 'Серверы MCP не выбраны.',
  'agent.create.modelGenerate': 'Сгенерировать моделью',
  'agent.create.modelGenerate.description':
    'Опишите, что нужно, затем сгенерируйте и проверьте описание и системный промпт отдельно.',
  'agent.create.color': 'Цвет',
  'agent.create.jsonObjectHelp': 'Введите JSON-объект или оставьте пустым.',
  'agent.create.save': 'Сохранить агента',
  'agent.create.scope': 'Категория',
  'agent.create.manualDescHelp':
    'Опишите, когда и как следует использовать этого субагента.',
  'agent.create.manualDescPlaceholder':
    'напр., Проверяет код на лучшие практики и возможные ошибки.',
  'agent.create.tools.builtin': 'Встроенные инструменты',
  'agent.create.tools.empty': 'Нет доступных инструментов.',
  'agent.create.tools.mcp': 'Инструменты MCP',
  'agent.create.tools.type': 'Тип инструмента',
  'agent.create.tools.selectServer': 'Выберите сервер MCP',
  'agent.create.tools.selectTool': 'Выберите инструмент',
  'agent.create.tools.noneSelected': 'Инструменты не выбраны.',
  'agent.create.tools.initializing': 'Инициализация каталогов инструментов...',
  'agent.create.tools.preheatFailed': 'Предпрогрев ACP не завершён.',
  'agent.create.tools.loadFailed':
    'Не удалось загрузить встроенные инструменты.',
  'agent.create.removeSelection': (v) => `Удалить ${v?.name ?? ''}`,
  'agent.create.toolsSelectHelp':
    'Выберите инструменты, которые может использовать этот субагент. Оставьте все снятыми, чтобы унаследовать все инструменты.',
  'agent.create.toolsSelection': 'Выбрать инструменты',
  'agent.create.tools.all': 'Все инструменты',
  'agent.create.tools.allDefault': 'Все инструменты (по умолчанию)',
  'agent.create.tools.allInfo':
    'Выбраны все инструменты, включая инструменты MCP',
  'agent.create.tools.allInfoFallback':
    'Выбраны все инструменты, включая инструменты MCP',
  'agent.create.tools.editLabel': '• Инструменты правки:',
  'agent.create.tools.executionLabel': '• Инструменты выполнения:',
  'agent.create.tools.none': '(нет)',
  'agent.create.tools.readEdit': 'Инструменты чтения и правки',
  'agent.create.tools.readEditExecute':
    'Инструменты чтения, правки и выполнения',
  'agent.create.tools.readOnlyLabel': '• Инструменты только для чтения:',
  'agent.create.tools.readOnly': 'Инструменты только для чтения',
  'agent.create.tools.selected': 'Выбранные инструменты:',
  'agent.create.user': 'Пользователь',
  'agent.create.user.cli': 'Глобальный',
  'agent.create.user.desc': 'Создать субагента уровня пользователя',
  'agent.create.useGenerated': 'Использовать этот черновик',
  'agent.approval.inherit': 'По умолчанию',
  'agent.approval.default': 'Разрешение по умолчанию',
  'agent.approval.plan': 'Только план',
  'agent.approval.auto-edit': 'Автоматически одобрять правки',
  'agent.approval.yolo': 'Автоматически одобрять все действия',
  'agent.approval.bubble': 'Передавать разрешение',
  'agent.approval.desc.inherit':
    'Использовать правила разрешения субагента по умолчанию.',
  'agent.approval.desc.bubble':
    'Передавать запросы разрешения инструментов родительской сессии.',
  'agent.createFirstHint':
    "Используйте '/agents create', чтобы создать первого субагента.",
  'agent.created': (v) => `Создан ${v?.name ?? ''}`,
  'agent.edit.save': 'Сохранить изменения',
  'agent.updated': (v) => `Обновлён ${v?.name ?? ''}`,
  'agent.turnsBadge': (v) =>
    `${v?.count ?? 0} ${ruPlural(v?.count, 'ход', 'хода', 'ходов')}`,
  'agent.delete': 'Удалить',
  'agent.delete.confirm': (v) => `Удалить «${v?.name ?? ''}»?`,
  'agent.delete.loading': 'Удаление...',
  'agent.delete.no': 'Нет',
  'agent.delete.title': (v) => `Удалить ${v?.name ?? ''}`,
  'agent.delete.yes': 'Да, удалить',
  'agent.deleted': (v) => `Удалён ${v?.name ?? ''}`,
  'agent.edit': 'Изменить',
  'agent.edit.color': 'Изменить цвет',
};
