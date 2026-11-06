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
  'managed.oauth.notice':
    'Personal authorization is used only for your execution. Session history and tool results remain visible according to Workspace read permissions.',
  'managed.oauth.failed':
    'Authorization could not be confirmed. Check the original authorization status or start a new authorization if it has expired.',
  'managed.oauth.open': 'Open authorization page',
  'managed.oauth.check': 'Check original authorization',
  'managed.oauth.authorize': 'Authorize and use in this session',
  'managed.oauth.bind': 'Use my saved authorization',
  'managed.oauth.revoke': 'Revoke my authorization',
  'managed.oauth.state.pending': 'Waiting for authorization',
  'managed.oauth.state.code_received': 'Ready to complete authorization',
  'managed.oauth.state.exchanging': 'Completing authorization',
  'managed.oauth.state.completed': 'Authorized',
  'managed.oauth.state.failed': 'Authorization failed; authorize again',
  'managed.oauth.state.expired': 'Authorization expired',
  'managed.oauth.credential.unauthorized': 'Authorization required',
  'managed.oauth.credential.authorized': 'Authorized',
  'managed.oauth.credential.revoked': 'Revoked',
  'managed.oauth.credential.unavailable': 'Authorization unavailable',
  'managed.oauth.required':
    'The package is saved. Authorize its HTTP MCP connections before applying it.',
  'managed.oauth.configure': 'Use personal OAuth for this HTTP connection',
  'managed.oauth.provider': 'Configured authorization provider',
  'managed.oauth.scopes': 'Requested scopes, separated by commas',
  'managed.oauth.bindingPending':
    'The authorization binding is not confirmed. Check or continue the original configuration operation.',
  'managed.oauth.removeBinding': 'Remove authorization from this session',
  'managed.oauth.removeHelp':
    'This disconnects the OAuth MCP contribution and removes its tools until authorized again. The package and its other contents remain selected.',
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
  'managed.oauth.notice':
    '个人授权仅用于你本人驱动的执行。会话历史和工具结果仍按 Workspace 阅读权限可见。',
  'managed.oauth.failed':
    '授权结果尚未确认。请检查原授权状态；若已过期，请重新授权。',
  'managed.oauth.open': '打开授权页面',
  'managed.oauth.check': '检查原授权状态',
  'managed.oauth.authorize': '授权并用于此会话',
  'managed.oauth.bind': '使用我已保存的授权',
  'managed.oauth.revoke': '撤销我的授权',
  'managed.oauth.state.pending': '等待用户授权',
  'managed.oauth.state.code_received': '可以完成授权',
  'managed.oauth.state.exchanging': '正在完成授权',
  'managed.oauth.state.completed': '已授权',
  'managed.oauth.state.failed': '授权失败，请重新授权',
  'managed.oauth.state.expired': '授权已过期',
  'managed.oauth.credential.unauthorized': '需要授权',
  'managed.oauth.credential.authorized': '已授权',
  'managed.oauth.credential.revoked': '已撤销',
  'managed.oauth.credential.unavailable': '个人授权当前不可用',
  'managed.oauth.required': '包已保存。应用前请完成 HTTP MCP 连接的个人授权。',
  'managed.oauth.configure': '此 HTTP 连接使用个人 OAuth',
  'managed.oauth.provider': '已配置的授权 provider',
  'managed.oauth.scopes': '申请的 scopes，以逗号分隔',
  'managed.oauth.bindingPending': '授权绑定尚未确认。请检查或继续原配置操作。',
  'managed.oauth.removeBinding': '从此会话移除授权绑定',
  'managed.oauth.removeHelp':
    '这会断开对应 OAuth MCP 并移除其工具，直到再次授权。扩展包及其中其他内容继续保留。',
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
