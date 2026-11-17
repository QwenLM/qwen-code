export const MANAGED_EXTENSION_MESSAGES_EN = {
  'managed.install.skillsTitle': 'Managed Skills',
  'managed.extensions.title': 'Managed extensions',
  'managed.extensions.description':
    'Publish a fixed package, select versions, then apply to an idle session.',
  'managed.extensions.selectSession':
    'Select a workspace and session to manage extensions.',
  'managed.extensions.unsupported':
    'Package extensions are unavailable for this target.',
  'managed.extensions.source': 'Original Git, npm, directory or archive source',
  'managed.extensions.ref': 'Source revision (optional)',
  'managed.extensions.target': 'Target platform',
  'managed.extensions.publish': 'Publish package',
  'managed.extensions.new': 'New extension',
  'managed.extensions.update': 'Update selected extension',
  'managed.extensions.apply': 'Apply selection',
  'managed.extensions.retry': 'Retry original request',
  'managed.extensions.continue': 'Continue original operation',
  'managed.extensions.recover': 'Restore previous version',
  'managed.extensions.settings': 'Settings',
  'managed.extensions.settingsDescription':
    'Enter the complete set of environment settings. Saved values are never displayed.',
  'managed.extensions.addSetting': 'Add setting',
  'managed.extensions.key': 'Environment variable',
  'managed.extensions.value': 'Value',
  'managed.extensions.saveSettings': 'Save settings revision',
  'managed.extensions.useSettings': 'Use saved settings revision',
  'managed.extensions.settingsRevision': 'Settings revision (optional)',
  'managed.extensions.installed': 'Installed',
  'managed.extensions.pending': 'Pending apply',
  'managed.extensions.active': 'Active',
  'managed.extensions.preparing': 'Preparing',
  'managed.extensions.prepared': 'Ready to apply',
  'managed.extensions.committed': 'Applying',
  'managed.extensions.recovery_required': 'Recovery blocked',
  'managed.extensions.failed': 'Failed',
  'managed.extensions.empty': 'No packages published in this workspace.',
  'managed.extensions.failedRequest':
    'The request could not be confirmed. Refresh status or retry the original request.',
  'managed.extensions.localPublisher':
    'A connected daemon is required to prepare an original source.',
  'managed.install.title': 'Install a Skill or MCP connection',
  'managed.install.description':
    'Save a version in this workspace and apply it only to the selected idle session.',
  'managed.install.kind': 'Installation source',
  'managed.install.kind.skill': 'Skill archive',
  'managed.install.kind.extension': 'Extension archive',
  'managed.install.kind.mcp': 'MCP configuration',
  'managed.install.name': 'Name (optional for archives)',
  'managed.install.serverName': 'MCP server name',
  'managed.install.archive': 'ZIP or tar.gz archive',
  'managed.install.transport': 'Transport',
  'managed.install.command': 'Executable command',
  'managed.install.arguments': 'Arguments (JSON string array)',
  'managed.install.environment': 'Environment (JSON object)',
  'managed.install.url': 'MCP server URL',
  'managed.install.headers': 'Headers (JSON object)',
  'managed.install.secretHelp':
    'Declare secret setting names below. Use ${NAME} in arguments, environment, URL or headers; enter the value only in its password field.',
  'managed.install.secretKeys': 'Secret setting names, separated by commas',
  'managed.install.workspaceCredentials':
    'Workspace service credentials can be used by authorized executions in this workspace. Saved values are never displayed.',
  'managed.install.keepSettings':
    'Keep the currently selected saved settings revision',
  'managed.install.updateTarget': 'New package or update target',
  'managed.install.install': 'Install into current session',
  'managed.install.complete': 'Installed in the selected session.',
  'managed.install.savedNotApplied':
    'Installation is not confirmed. A saved package may be available; check or retry the original request before starting another installation.',
  'managed.install.recoverBeforeEdit':
    'An earlier installation requires recovery. Cancel editing to return to the original installation before changing this connection.',
  'managed.install.required.source':
    'Select or recreate the original input to continue. Its digest must match the saved request.',
  'managed.install.required.settings':
    'Enter the complete set of credential values to continue. Values are not retained after a reload.',
  'managed.install.stage.publish': 'Saving package version…',
  'managed.install.stage.settings': 'Package saved; preparing settings…',
  'managed.install.stage.apply':
    'Package saved; applying to the selected session…',
  'managed.install.reviewAgain': 'Review current selection',
  'managed.install.inspect': 'Inspect package',
  'managed.install.packageSource': 'Versioned package',
  'managed.install.staticSource': 'Static session snapshot',
  'managed.install.staticHelp':
    'Static Skill snapshots stay fixed. Install a separately qualified package Skill or create a new session to change the base snapshot.',
  'managed.install.ownedMcp':
    'This connection belongs to a package. Edit its package configuration instead of its independent server definition.',
  'managed.install.editMcp': 'Edit connection configuration',
  'managed.install.files': 'Package files',
  'managed.install.truncated': 'The file list is truncated.',
  'managed.install.review': 'Review package',
  'managed.install.reviewed':
    'Current selection loaded. Confirm the original installation again to apply its saved package.',
  'managed.install.invalidInput':
    'The source could not be prepared. Check the archive, configuration fields and declared settings.',
  'managed.install.redacted':
    'Saved literal environment/header values are redacted. Enter them again or replace them with declared secret placeholders before reviewing.',
  'managed.install.createMcp': 'Create MCP connection',
  'managed.install.packageEditUnavailable':
    'This package could not be opened as a single connection. Manage composite extensions from the Extensions page.',
  'managed.install.replacePackage':
    'This updates the entire selected package in this session. Other sessions keep their selected versions.',
  'managed.runtimeSkills.title': 'Import from current Workspace',
  'managed.runtimeSkills.description':
    'Scan project Skills in the selected Runtime, review an immutable snapshot, then explicitly install it into this session.',
  'managed.runtimeSkills.scan': 'Scan current Runtime',
  'managed.runtimeSkills.empty':
    'No project Skills were found in the current Runtime.',
  'managed.runtimeSkills.shadowed': 'Lower-priority source',
  'managed.runtimeSkills.incompatible': 'This Skill uses unsupported metadata.',
  'managed.runtimeSkills.failed':
    'The Runtime source could not be confirmed. Check the original operation; changed sources or Runtime owners require an explicit new scan and snapshot.',
  'managed.install.discardDraft': 'Discard draft; keep saved versions',
  'managed.install.discarded':
    'The draft was discarded. Any saved package or settings revisions remain available in this workspace.',
} as const;
export const MANAGED_EXTENSION_MESSAGES_ZH: Record<
  keyof typeof MANAGED_EXTENSION_MESSAGES_EN,
  string
> = {
  'managed.install.skillsTitle': 'Managed Skills',
  'managed.extensions.title': 'Managed 扩展',
  'managed.extensions.description':
    '发布固定版本的包，选择版本后，在会话空闲时显式应用。',
  'managed.extensions.selectSession': '请选择 Workspace 和会话以管理扩展。',
  'managed.extensions.unsupported': '当前目标尚未开放整包扩展。',
  'managed.extensions.source': '原始 Git、npm、目录或 archive 来源',
  'managed.extensions.ref': '来源修订（可选）',
  'managed.extensions.target': '目标平台',
  'managed.extensions.publish': '发布扩展包',
  'managed.extensions.new': '新扩展',
  'managed.extensions.update': '更新所选扩展',
  'managed.extensions.apply': '应用所选版本',
  'managed.extensions.retry': '重试原请求',
  'managed.extensions.continue': '继续原操作',
  'managed.extensions.recover': '恢复上一版',
  'managed.extensions.settings': '设置',
  'managed.extensions.settingsDescription':
    '输入完整的环境设置。已保存的值不会回显。',
  'managed.extensions.addSetting': '添加设置',
  'managed.extensions.key': '环境变量名',
  'managed.extensions.value': '值',
  'managed.extensions.saveSettings': '保存设置修订',
  'managed.extensions.useSettings': '使用已保存的设置修订',
  'managed.extensions.settingsRevision': '设置修订（可选）',
  'managed.extensions.installed': '已安装',
  'managed.extensions.pending': '待应用',
  'managed.extensions.active': '已生效',
  'managed.extensions.preparing': '准备中',
  'managed.extensions.prepared': '已准备',
  'managed.extensions.committed': '应用中',
  'managed.extensions.recovery_required': '恢复阻塞',
  'managed.extensions.failed': '失败',
  'managed.extensions.empty': '此 Workspace 尚未发布扩展包。',
  'managed.extensions.failedRequest':
    '请求结果尚未确认。请刷新状态或重试原请求。',
  'managed.extensions.localPublisher': '需要连接 daemon 才能准备原始来源。',
  'managed.install.title': '安装 Skill 或 MCP 连接',
  'managed.install.description':
    '将版本保存在此 Workspace，并只应用到所选空闲会话。',
  'managed.install.kind': '安装来源',
  'managed.install.kind.skill': 'Skill 归档',
  'managed.install.kind.extension': '扩展归档',
  'managed.install.kind.mcp': 'MCP 配置',
  'managed.install.name': '名称（归档可选）',
  'managed.install.serverName': 'MCP server 名称',
  'managed.install.archive': 'ZIP 或 tar.gz 归档',
  'managed.install.transport': '传输类型',
  'managed.install.command': '可执行命令',
  'managed.install.arguments': '参数（JSON 字符串数组）',
  'managed.install.environment': '环境变量（JSON 对象）',
  'managed.install.url': 'MCP server URL',
  'managed.install.headers': 'Headers（JSON 对象）',
  'managed.install.secretHelp':
    '在下方声明秘密设置名称，在参数、环境变量、URL 或 header 中使用 ${NAME}；实际值只填入对应密码框。',
  'managed.install.secretKeys': '秘密设置名称，以逗号分隔',
  'managed.install.workspaceCredentials':
    'Workspace 服务凭据可供此 Workspace 内经授权的执行使用。已保存值不会回显。',
  'managed.install.keepSettings': '沿用当前选中的已保存 settings revision',
  'managed.install.updateTarget': '新包或更新目标',
  'managed.install.install': '安装到当前会话',
  'managed.install.complete': '已安装到所选会话。',
  'managed.install.savedNotApplied':
    '安装结果尚未确认。包可能已保存；开始其他安装前，请检查或重试原请求。',
  'managed.install.recoverBeforeEdit':
    '先前的安装仍需恢复。请取消编辑并返回原安装流程，确认其结果后再修改此连接。',
  'managed.install.required.source':
    '请选择或重新填写原始输入以继续；其摘要必须与保存的请求一致。',
  'managed.install.required.settings':
    '请填写完整凭据值以继续。页面刷新后不会保留这些值。',
  'managed.install.stage.publish': '正在保存包版本…',
  'managed.install.stage.settings': '包已保存，正在准备 settings…',
  'managed.install.stage.apply': '包已保存，正在应用到所选会话…',
  'managed.install.reviewAgain': '重新查看当前选择',
  'managed.install.inspect': '检查包内容',
  'managed.install.packageSource': '版本化扩展包',
  'managed.install.staticSource': '会话静态快照',
  'managed.install.staticHelp':
    '静态 Skill 快照保持固定。可安装带独立限定名的包 Skill，或创建新会话来更改基础快照。',
  'managed.install.ownedMcp':
    '此连接属于扩展包。请编辑包配置，而不是独立 server 定义。',
  'managed.install.editMcp': '编辑连接配置',
  'managed.install.files': '包文件',
  'managed.install.truncated': '文件清单已截断。',
  'managed.install.review': '预览包内容',
  'managed.install.reviewed':
    '已读取当前选择。请再次确认原安装，以应用已保存的包。',
  'managed.install.invalidInput':
    '无法准备来源。请检查归档、配置字段与声明的 settings。',
  'managed.install.redacted':
    '已保存的环境变量/header 字面值已脱敏。预览前请重新填写，或改为声明的秘密占位符。',
  'managed.install.createMcp': '创建 MCP 连接',
  'managed.install.packageEditUnavailable':
    '此包无法作为独立连接打开。请在扩展页面管理复合扩展包。',
  'managed.install.replacePackage':
    '这会更新此会话所选的整个扩展包。其他会话继续使用其已选版本。',
  'managed.runtimeSkills.title': '从当前 Workspace 导入',
  'managed.runtimeSkills.description':
    '扫描所选 Runtime 的项目 Skills，预览不可变快照，然后显式安装到此会话。',
  'managed.runtimeSkills.scan': '扫描当前 Runtime',
  'managed.runtimeSkills.empty': '当前 Runtime 中没有发现项目 Skill。',
  'managed.runtimeSkills.shadowed': '较低优先级来源',
  'managed.runtimeSkills.incompatible': '此 Skill 使用了不支持的元数据。',
  'managed.runtimeSkills.failed':
    '无法确认 Runtime 来源。请检查原操作；来源或 Runtime owner 变化后，需要显式重新扫描并制作快照。',
  'managed.install.discardDraft': '放弃草稿，保留已保存版本',
  'managed.install.discarded':
    '已放弃草稿。已保存的包或 settings revisions 仍保留在此 Workspace。',
};

export const MANAGED_EXTENSION_MESSAGES_RU: Record<
  keyof typeof MANAGED_EXTENSION_MESSAGES_EN,
  string
> = {
  'managed.install.skillsTitle': 'Managed Skills',
  'managed.extensions.title': 'Managed-расширения',
  'managed.extensions.description':
    'Опубликуйте фиксированный пакет, выберите версии, затем примените к простаивающей сессии.',
  'managed.extensions.selectSession':
    'Выберите workspace и сессию для управления расширениями.',
  'managed.extensions.unsupported':
    'Пакетные расширения для этой цели недоступны.',
  'managed.extensions.source': 'Исходный Git, npm, каталог или архив',
  'managed.extensions.ref': 'Редакция источника (необязательно)',
  'managed.extensions.target': 'Целевая платформа',
  'managed.extensions.publish': 'Опубликовать пакет',
  'managed.extensions.new': 'Новое расширение',
  'managed.extensions.update': 'Обновить выбранное расширение',
  'managed.extensions.apply': 'Применить выбор',
  'managed.extensions.retry': 'Повторить исходный запрос',
  'managed.extensions.continue': 'Продолжить исходную операцию',
  'managed.extensions.recover': 'Восстановить предыдущую версию',
  'managed.extensions.settings': 'Настройки',
  'managed.extensions.settingsDescription':
    'Введите полный набор переменных окружения. Сохранённые значения никогда не отображаются.',
  'managed.extensions.addSetting': 'Добавить настройку',
  'managed.extensions.key': 'Переменная окружения',
  'managed.extensions.value': 'Значение',
  'managed.extensions.saveSettings': 'Сохранить редакцию настроек',
  'managed.extensions.useSettings':
    'Использовать сохранённую редакцию настроек',
  'managed.extensions.settingsRevision': 'Редакция настроек (необязательно)',
  'managed.extensions.installed': 'Установлено',
  'managed.extensions.pending': 'Ожидает применения',
  'managed.extensions.active': 'Активно',
  'managed.extensions.preparing': 'Подготовка',
  'managed.extensions.prepared': 'Готово к применению',
  'managed.extensions.committed': 'Применение',
  'managed.extensions.recovery_required': 'Восстановление заблокировано',
  'managed.extensions.failed': 'Ошибка',
  'managed.extensions.empty':
    'В этой рабочей области нет опубликованных пакетов.',
  'managed.extensions.failedRequest':
    'Запрос не удалось подтвердить. Обновите статус или повторите исходный запрос.',
  'managed.extensions.localPublisher':
    'Для подготовки исходного источника нужен подключённый daemon.',
  'managed.install.title': 'Установить Skill или MCP-соединение',
  'managed.install.description':
    'Сохраните версию в этой рабочей области и примените её только к выбранной простаивающей сессии.',
  'managed.install.kind': 'Источник установки',
  'managed.install.kind.skill': 'Архив Skill',
  'managed.install.kind.extension': 'Архив расширения',
  'managed.install.kind.mcp': 'Конфигурация MCP',
  'managed.install.name': 'Имя (для архивов необязательно)',
  'managed.install.serverName': 'Имя MCP-сервера',
  'managed.install.archive': 'Архив ZIP или tar.gz',
  'managed.install.transport': 'Транспорт',
  'managed.install.command': 'Исполняемая команда',
  'managed.install.arguments': 'Аргументы (JSON-массив строк)',
  'managed.install.environment': 'Окружение (JSON-объект)',
  'managed.install.url': 'URL MCP-сервера',
  'managed.install.headers': 'Заголовки (JSON-объект)',
  'managed.install.secretHelp':
    'Ниже объявите имена секретных настроек. Используйте ${NAME} в аргументах, окружении, URL или заголовках; значение вводите только в соответствующем поле пароля.',
  'managed.install.secretKeys': 'Имена секретных настроек, через запятую',
  'managed.install.workspaceCredentials':
    'Служебные учётные данные Workspace могут использовать авторизованные выполнения в этой рабочей области. Сохранённые значения никогда не отображаются.',
  'managed.install.keepSettings':
    'Оставить текущую выбранную сохранённую редакцию настроек',
  'managed.install.updateTarget': 'Новый пакет или цель обновления',
  'managed.install.install': 'Установить в текущую сессию',
  'managed.install.complete': 'Установлено в выбранную сессию.',
  'managed.install.savedNotApplied':
    'Установка не подтверждена. Сохранённый пакет может быть доступен; проверьте или повторите исходный запрос, прежде чем начинать другую установку.',
  'managed.install.recoverBeforeEdit':
    'Более ранняя установка требует восстановления. Отмените правку, чтобы вернуться к исходной установке, прежде чем менять это соединение.',
  'managed.install.required.source':
    'Выберите или заново создайте исходный ввод, чтобы продолжить. Его дайджест должен совпадать с сохранённым запросом.',
  'managed.install.required.settings':
    'Введите полный набор значений учётных данных, чтобы продолжить. После перезагрузки значения не сохраняются.',
  'managed.install.stage.publish': 'Сохранение версии пакета…',
  'managed.install.stage.settings': 'Пакет сохранён; подготовка настроек…',
  'managed.install.stage.apply':
    'Пакет сохранён; применение к выбранной сессии…',
  'managed.install.reviewAgain': 'Просмотреть текущий выбор',
  'managed.install.inspect': 'Просмотреть пакет',
  'managed.install.packageSource': 'Версионированный пакет',
  'managed.install.staticSource': 'Статический снимок сессии',
  'managed.install.staticHelp':
    'Статические снимки Skill остаются фиксированными. Установите отдельно квалифицированный пакетный Skill или создайте новую сессию, чтобы сменить базовый снимок.',
  'managed.install.ownedMcp':
    'Это соединение принадлежит пакету. Редактируйте конфигурацию пакета, а не независимое определение сервера.',
  'managed.install.editMcp': 'Изменить конфигурацию соединения',
  'managed.install.files': 'Файлы пакета',
  'managed.install.truncated': 'Список файлов усечён.',
  'managed.install.review': 'Просмотреть пакет',
  'managed.install.reviewed':
    'Текущий выбор загружен. Снова подтвердите исходную установку, чтобы применить её сохранённый пакет.',
  'managed.install.invalidInput':
    'Источник не удалось подготовить. Проверьте архив, поля конфигурации и объявленные настройки.',
  'managed.install.redacted':
    'Сохранённые литеральные значения окружения/заголовков скрыты. Введите их снова или замените объявленными плейсхолдерами секретов перед просмотром.',
  'managed.install.createMcp': 'Создать MCP-соединение',
  'managed.install.packageEditUnavailable':
    'Этот пакет нельзя открыть как одно соединение. Составные расширения управляйте со страницы расширений.',
  'managed.install.replacePackage':
    'Это обновит весь выбранный пакет в этой сессии. Другие сессии сохранят выбранные версии.',
  'managed.runtimeSkills.title': 'Импорт из текущего Workspace',
  'managed.runtimeSkills.description':
    'Просканируйте проектные Skills в выбранном Runtime, просмотрите неизменяемый снимок, затем явно установите его в эту сессию.',
  'managed.runtimeSkills.scan': 'Сканировать текущий Runtime',
  'managed.runtimeSkills.empty':
    'В текущем Runtime проектные Skills не найдены.',
  'managed.runtimeSkills.shadowed': 'Источник с более низким приоритетом',
  'managed.runtimeSkills.incompatible':
    'Этот Skill использует неподдерживаемые метаданные.',
  'managed.runtimeSkills.failed':
    'Источник Runtime не удалось подтвердить. Проверьте исходную операцию; изменённые источники или владельцы Runtime требуют явного нового сканирования и снимка.',
  'managed.install.discardDraft':
    'Отбросить черновик; сохранить сохранённые версии',
  'managed.install.discarded':
    'Черновик отброшен. Сохранённые пакеты или редакции настроек остаются доступны в этой рабочей области.',
};
