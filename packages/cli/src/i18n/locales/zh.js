/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Chinese translations for Qwen Code CLI

export default {
  'Cannot disable an extension-provided MCP server here.':
    '无法在此处禁用扩展提供的 MCP 服务器。',
  'Cleared authentication for "{{name}}".': '已清空 "{{name}}" 的认证信息。',
  'MCP "{{name}}" disabled for all projects.':
    'MCP "{{name}}" 已在所有项目中禁用。',
  'Enable extension "{{name}}" to manage this MCP server.':
    '启用扩展 "{{name}}" 后才能管理此 MCP 服务器。',
  'Extension-provided MCP servers cannot be favorited.':
    '扩展提供的 MCP 服务器无法单独收藏。',

  'User level': '用户级',
  'Project level': '项目级',

  // ==========================================================================
  // Extensions manager dialog (Installed / Discover / Sources tabs)
  // ==========================================================================
  ' · {{marketplace}} (Tab to clear)': ' · {{marketplace}}（Tab 清除）',
  '"{{name}}" {{state}}.': '"{{name}}" {{state}}。',
  '(Tab / ←→ to switch)': '(Tab / ←→ 切换)',
  '+ Add new marketplace': '+ 添加新市场源',
  '+ Install a new extension': '+ 安装一个新扩展',
  Actions: '操作',
  'Add Marketplace': '添加市场源',
  'Add a marketplace in the Sources tab to discover extensions.':
    '在“来源”标签页中添加市场源以发现扩展。',
  'Add new': '新增',
  'Add to Favorites': '添加到收藏',
  'Added "{{name}}" to favorites.': '已将 "{{name}}" 添加到收藏。',
  'Added marketplace "{{name}}".': '已添加市场源 "{{name}}"。',
  'Adding...': '添加中...',
  'Back to extension list': '返回扩展列表',
  'Browse extensions ({{count}})': '浏览扩展（{{count}}）',
  'By: {{a}}': '作者：{{a}}',
  'Change scope': '更改作用域',
  'Change scope for "{{name}}":': '更改 "{{name}}" 的作用域：',
  'Changing scope...': '正在更改作用域...',
  'Uninstalling "{{name}}"...': '正在卸载 "{{name}}"...',
  'Update available for "{{name}}".': '"{{name}}" 有可用更新。',
  '"{{name}}" is already up to date.': '"{{name}}" 已是最新。',
  'Checking "{{name}}" for updates...': '正在检查 "{{name}}" 的更新...',
  '"{{name}}" does not support update checks.': '"{{name}}" 不支持检查更新。',
  '"{{name}}" cannot be update-checked (Claude marketplace plugins update by reinstalling).':
    '"{{name}}" 无法检查更新（Claude 市场源插件需卸载后重装来更新）。',
  'Failed to check "{{name}}" for updates.': '检查 "{{name}}" 的更新失败。',
  'Claude plugin marketplace': 'Claude 插件市场',
  Commands: '命令',
  'Components:': '组件：',
  'Could not load this marketplace.': '无法加载该市场源。',
  'Current: {{scope}}': '当前：{{scope}}',
  Disabled: '已禁用',
  Discover: '发现',
  'Disabling "{{name}}"...': '正在禁用 "{{name}}"...',
  'Disabling MCP "{{name}}"...': '正在禁用 MCP "{{name}}"...',
  'Discover extensions': '发现扩展',
  'Discovering extensions...': '正在发现扩展...',
  'Enabling "{{name}}"...': '正在启用 "{{name}}"...',
  'Enabling MCP "{{name}}"...': '正在启用 MCP "{{name}}"...',
  'Enter extension source:': '输入扩展来源：',
  'Enter marketplace source (Claude format):':
    '输入市场源地址（Claude 格式）：',
  'Examples:': '示例：',
  'Extension details': '扩展详情',
  'Extension v{{version}}': '扩展 v{{version}}',
  'Extensions are not available in this environment.': '当前环境中扩展不可用。',
  'Failed to open {{url}}': '打开 {{url}} 失败',
  Favorites: '收藏',
  'Global (User Scope)': '全局（用户作用域）',
  'Install Extension': '安装扩展',
  'Install for the current workspace (project scope)':
    '为当前工作区安装（项目作用域）',
  'Install for you (user scope)': '全局安装（用户作用域）',
  'Install {{count}} extension(s) to which scope?':
    '将 {{count}} 个扩展安装到哪个作用域？',
  Installed: '已安装',
  'Installed extension "{{name}}".': '已安装扩展 "{{name}}"。',
  'Installed extensions ({{count}}):': '已安装的扩展（{{count}}）：',
  'Installed {{count}} extension(s).': '已安装 {{count}} 个扩展。',
  '{{name}}: installed, but the scope rollback failed — it may be disabled at all scopes; re-enable it from the Installed tab.':
    '{{name}}：已安装,但作用域回滚失败 —— 该扩展可能在所有作用域均被禁用;请在“已安装”页重新启用。',
  'Could not change scope, and the rollback also failed — "{{name}}" may be disabled at all scopes. Re-enable it from the Installed tab. ({{error}})':
    '无法更改作用域,且回滚也失败 ——“{{name}}”可能在所有作用域均被禁用。请在“已安装”页重新启用。({{error}})',
  'Installed {{ok}}, failed {{fail}}: {{detail}}':
    '成功 {{ok}} 个，失败 {{fail}} 个：{{detail}}',
  'Installing...': '安装中...',
  'Last updated: {{date}}': '最近更新：{{date}}',
  MCP: 'MCP',
  'MCP "{{name}}" {{state}}.': 'MCP "{{name}}" {{state}}。',
  'MCP servers': 'MCP 服务器',
  'Mark for Update': '标记为待更新',
  Marketplaces: '市场源',
  'No extensions discovered.': '未发现任何扩展。',
  'No extensions match your search.': '没有与搜索匹配的扩展。',
  'No extensions or marketplaces added yet.': '尚未添加任何扩展或市场源。',
  'No homepage available.': '没有可用的主页。',
  'No installable extensions selected.': '未选择可安装的扩展。',
  'No plugins or MCP servers installed.': '尚未安装任何插件或 MCP 服务器。',
  None: '无',
  'Note: Uninstall permanently removes this extension.':
    '注意：卸载将永久移除此扩展。',
  'Open homepage': '打开主页',
  'Project (Workspace)': '项目（工作区）',
  'Refreshed {{count}} extension(s).': '已刷新 {{count}} 个扩展。',
  'Remove from Favorites': '从收藏中移除',
  'Remove marketplace': '移除市场源',
  'Remove marketplace "{{name}}"?': '移除市场源 "{{name}}"？',
  'Removed "{{name}}" from favorites.': '已将 "{{name}}" 从收藏中移除。',
  'Removed marketplace "{{name}}".': '已移除市场源 "{{name}}"。',
  'Scope:': '作用域：',
  'Set "{{name}}" scope to {{scope}}.':
    '已将 "{{name}}" 的作用域设为 {{scope}}。',
  Sources: '来源',
  'Type to search · Space to toggle · Enter to view · Ctrl+R refresh · Esc to go back':
    '输入以搜索 · Space 切换 · Enter 查看 · Ctrl+R 刷新 · Esc 返回',
  Uninstall: '卸载',
  'Uninstalled "{{name}}".': '已卸载 "{{name}}"。',
  'Update Now': '立即更新',
  'Update marketplace': '更新市场源',
  'Update marketplace (last updated {{date}})':
    '更新市场源（最近更新 {{date}}）',
  'Could not update marketplace "{{name}}".': '无法更新市场源 "{{name}}"。',
  'Updated "{{name}}".': '已更新 "{{name}}"。',
  'Updated marketplace "{{name}}".': '已更新市场源 "{{name}}"。',
  'Use the Discover tab to find and install plugins.':
    '使用“发现”标签页查找并安装扩展。',
  'Version: {{v}}': '版本：{{v}}',
  'Will install:': '将安装：',
  'Would open: {{url}}': '将打开：{{url}}',
  'Y/Enter to confirm · N/Esc to cancel': 'Y/Enter 确认 · N/Esc 取消',
  'Press R to retry · Esc to go back': '按 R 重试 · Esc 返回',
  'Enter to select · R refresh · Esc to go back':
    'Enter 选择 · R 刷新 · Esc 返回',
  'from {{marketplace}}': '来自 {{marketplace}}',
  installed: '已安装',
  '{{count}} Agents': '{{count}} 个智能体',
  '{{count}} Commands': '{{count}} 个命令',
  '{{count}} MCP': '{{count}} 个 MCP',
  '{{count}} Skills': '{{count}} 个技能',
  '{{count}} available extensions': '{{count}} 个可用扩展',
  '↑ more above': '↑ 上方更多',
  '↑↓ navigate · Enter open · d remove marketplace · Esc close':
    '↑↓ 导航 · Enter 打开 · d 移除市场源 · Esc 关闭',
  '↑↓ navigate · Enter select · Esc close': '↑↓ 导航 · Enter 选择 · Esc 关闭',
  '↑↓ navigate · Enter select · d remove marketplace · Esc close':
    '↑↓ 导航 · Enter 选择 · d 移除市场源 · Esc 关闭',
  '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close':
    '↑↓ 导航 · Space 启用/禁用 · f 收藏 · Enter 查看详情 · Esc 关闭',
  '↓ more below': '↓ 下方更多',
  '⚠ Make sure you trust an extension before installing, updating, or using it. We cannot verify what MCP servers, files, or other software an extension includes, or that it works as intended. See the extension homepage for more information.':
    '⚠ 在安装、更新或使用扩展前，请确保你信任它。我们无法验证扩展包含哪些 MCP 服务器、文件或其他软件，也无法保证其按预期工作。更多信息请查看扩展主页。',

  // ============================================================================
  // Tool display names (chat-stream badge labels)
  // ----------------------------------------------------------------------------
  // Keyed by `toolDisplayName.<English display name>` (from core
  // `ToolDisplayNames`). The namespace prevents collisions with same-spelled
  // generic UI strings (e.g. a standalone "Shell"). A missing key falls back to
  // the English display name via `localizeToolDisplayName`. Proper tool names /
  // acronyms are kept in English (Agent, Grep, Glob, LSP), as is a product name
  // inside an otherwise-translated label (e.g. `Notebook`).
  // ============================================================================
  'toolDisplayName.Edit': '编辑',
  'toolDisplayName.WriteFile': '写入文件',
  'toolDisplayName.ReadFile': '读取文件',
  'toolDisplayName.Grep': 'Grep',
  'toolDisplayName.Glob': 'Glob',
  'toolDisplayName.Shell': '运行命令',
  'toolDisplayName.Shell Command': 'Shell 命令',
  'toolDisplayName.TodoList': '任务清单',
  'toolDisplayName.SaveMemory': '保存记忆',
  'toolDisplayName.Agent': 'Agent',
  'toolDisplayName.Artifact': '制品',
  'toolDisplayName.Skill': '技能',
  'toolDisplayName.EnterPlanMode': '进入计划模式',
  'toolDisplayName.ExitPlanMode': '退出计划模式',
  'toolDisplayName.WebFetch': '网络抓取',
  'toolDisplayName.WebSearch': '网络搜索',
  'toolDisplayName.ListFiles': '列出文件',
  'toolDisplayName.Lsp': 'LSP',
  'toolDisplayName.AskUserQuestion': '询问用户',
  'toolDisplayName.CronCreate': '创建定时任务',
  'toolDisplayName.CronList': '定时任务列表',
  'toolDisplayName.CronDelete': '删除定时任务',
  'toolDisplayName.LoopWakeup': '循环唤醒',
  'toolDisplayName.TaskCreate': '创建任务',
  'toolDisplayName.TaskUpdate': '更新任务',
  'toolDisplayName.TaskList': '任务列表',
  'toolDisplayName.TaskStop': '停止任务',
  'toolDisplayName.TeamCreate': '创建团队',
  'toolDisplayName.TeamDelete': '删除团队',
  'toolDisplayName.SendMessage': '发送消息',
  'toolDisplayName.StructuredOutput': '结构化输出',
  'toolDisplayName.Monitor': '监控',
  'toolDisplayName.NotebookEdit': '编辑 Notebook',
  'toolDisplayName.ToolSearch': '工具搜索',
  'toolDisplayName.EnterWorktree': '进入 Worktree',
  'toolDisplayName.ExitWorktree': '退出 Worktree',
  'toolDisplayName.Workflow': '工作流',
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  // Attachment hints
  '↑ to manage attachments': '↑ 管理附件',
  '← → select, Delete to remove, ↓ to exit': '← → 选择，Delete 删除，↓ 退出',
  'Attachments: ': '附件：',
  'Basics:': '基础功能：',
  'Add context': '添加上下文',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    '使用 {{symbol}} 指定文件作为上下文（例如，{{example}}），用于定位特定文件或文件夹',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Shell 模式',
  'YOLO mode': 'YOLO 模式',
  'Auto mode': 'Auto 模式',
  'plan mode': '规划模式',
  'auto-accept edits': '自动接受编辑',
  'Accepting edits': '接受编辑',
  '(shift + tab to cycle)': '(Shift + Tab 切换)',
  '(tab to cycle)': '(按 Tab 切换)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    '通过 {{symbol}} 执行 shell 命令（例如，{{example1}}）或使用自然语言（例如，{{example2}}）',
  '!': '!',
  '!npm run start': '!npm run start',
  'Commands:': '命令：',
  'shell command': 'shell 命令',
  'Model Context Protocol command (from external servers)':
    'Model Context Protocol 命令（来自外部服务器）',
  'Keyboard Shortcuts:': '键盘快捷键：',
  'Toggle this help display': '切换此帮助显示',
  'Toggle shell mode': '切换命令行模式',
  'Open command menu': '打开命令菜单',
  'Add file context': '添加文件上下文',
  'Accept suggestion / Autocomplete': '接受建议 / 自动补全',
  'Reverse search history': '反向搜索历史',
  'Press ? again to close': '再次按 ? 关闭',
  // Keyboard shortcuts panel descriptions
  'for shell mode': '命令行模式',
  'for commands': '命令菜单',
  'for file paths': '文件路径',
  'to clear input': '清空输入',
  'to cycle approvals': '切换审批模式',
  'to quit': '退出',
  'for newline': '换行',
  'to clear screen': '清屏',
  'to search history': '搜索历史',
  'to paste images': '粘贴图片',
  'for external editor': '外部编辑器',
  'to toggle compact mode': '切换紧凑模式',
  'Jump through words in the input': '在输入中按单词跳转',
  'Close dialogs, cancel requests, or quit application':
    '关闭对话框、取消请求或退出应用程序',
  'New line': '换行',
  'New line (Alt+Enter works for certain linux distros)':
    '换行（某些 Linux 发行版支持 Alt+Enter）',
  'Clear the screen': '清屏',
  'Open input in external editor': '在外部编辑器中打开输入',
  'Send message': '发送消息',
  'Initializing...': '正在初始化...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    '正在连接到 MCP servers... ({{connected}}/{{total}})',
  'Type your message or @path/to/file': '输入您的消息或 @ 文件路径',
  '? for shortcuts': '按 ? 查看快捷键',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "按 'i' 进入插入模式，按 'Esc' 进入普通模式",
  'Cancel operation / Clear input (double press)':
    '取消操作 / 清空输入（双击）',
  'Cycle approval modes': '循环切换审批模式',
  'Cycle through your prompt history': '循环浏览提示历史',
  'For a full list of shortcuts, see {{docPath}}':
    '完整快捷键列表，请参阅 {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': '获取 Qwen Code 帮助',
  'show version info': '显示版本信息',
  'show paths for current session files and logs': '显示当前会话文件和日志路径',
  'submit a bug report': '提交错误报告',
  Status: '状态',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: '运行环境',
  OS: '操作系统',
  Auth: '认证',
  Model: '模型',
  'Fast Model': '快速模型',
  Sandbox: '沙箱',
  'Session ID': '会话 ID',
  'Base URL': 'Base URL',
  Proxy: '代理',
  'Memory Usage': '内存使用',
  'IDE Client': 'IDE 客户端',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    '分析项目并创建定制的 QWEN.md 文件',
  'List available Qwen Code tools. Usage: /tools [desc]':
    '列出可用的 Qwen Code 工具。用法：/tools [desc]',
  'Open the skills panel (browse, search, toggle, pick).':
    '打开技能面板（浏览、搜索、启停、选择）。',
  'Move this session to a new working directory': '将此会话移动到新的工作目录',
  // SkillsManagerDialog (`/skills` 弹出的面板)
  'Manage Skills': '管理技能',
  'Skills configuration saved.': '技能配置已保存。',
  'Skills configuration saved, but refresh failed: {{error}}. Restart to ensure the new state is applied.':
    '技能配置已保存，但刷新失败：{{error}}。请重启以确保新状态生效。',
  'Workspace is untrusted; workspace settings are ignored by the merged config. Run /trust first to persist skills changes here, or edit ~/.qwen/settings.json directly to manage skills at user scope.':
    '当前工作区未受信任，工作区设置会被合并配置忽略。请先执行 /trust，或直接编辑 ~/.qwen/settings.json 在用户范围管理技能。',
  'SkillManager not available.': 'SkillManager 不可用。',
  'Loading skills…': '正在加载技能…',
  'Failed to load skills: {{error}}': '加载技能失败：{{error}}',
  'Failed to save skills configuration: {{error}}':
    '保存技能配置失败：{{error}}',
  'All available skills are disabled. Edit ~/.qwen/settings.json or .qwen/settings.json (skills.disabled) to re-enable.':
    '所有可用技能均已禁用。请编辑 ~/.qwen/settings.json 或 .qwen/settings.json（skills.disabled）以重新启用。',
  'Press esc to close.': '按 Esc 关闭。',
  '{{count}} skills · ': '{{count}} 个技能 · ',
  '{{matched}} / {{total}} skills · ': '{{matched}} / {{total}} 个技能 · ',
  'Space toggle · Enter pick (fill input) · Esc save & exit · workspace scope':
    '空格 启停 · 回车 选中(填入输入框) · Esc 保存并退出 · 工作区范围',
  'Search:': '搜索：',
  'type to filter…': '输入以过滤…',
  'No skills are currently available.': '当前没有可用的技能。',
  'All available skills are locked at a higher scope (see below).':
    '所有可用技能都被更高范围锁定（详见下方）。',
  'No skills match the search.': '没有匹配搜索的技能。',
  'Locked by higher-scope settings (cannot toggle here):':
    '被更高范围设置锁定（此处无法切换）：',
  'higher scope': '更高范围',
  '  {{name}} {{description}}  [locked: {{scope}}]':
    '  {{name}} {{description}}  [已锁定：{{scope}}]',
  '↑/↓ navigate · backspace edits search': '↑/↓ 导航 · 退格 编辑搜索',
  // Note: Project / User / Extension are already translated elsewhere in
  // this file. `Bundled` is new — only the SkillsManagerDialog uses it
  // as a level label so far.
  Bundled: '内置',
  'Available Qwen Code CLI tools:': '可用的 Qwen Code CLI 工具：',
  'No tools available': '没有可用工具',
  'View or change the approval mode for tool usage':
    '查看或更改工具使用的审批模式',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    '无效的审批模式 "{{arg}}"。有效模式：{{modes}}',
  'Approval mode set to "{{mode}}"': '审批模式已设置为 "{{mode}}"',
  'View or change the language setting': '查看或更改语言设置',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    '列出后台任务（文本列表；交互式对话框可通过页脚中的“后台任务”入口打开）',
  'Delete a previous session': '删除先前的会话',
  'Run installation and environment diagnostics': '运行安装和环境诊断',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    '浏览动态模型目录，并选择在本地保持启用的模型',
  'Generate a one-line session recap now': '立即生成一条单行会话回顾',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    '重命名当前对话。--auto 会让快速模型自动生成标题。',
  'Rewind conversation to a previous turn': '将对话回退到之前的某一轮',
  'Rewind Conversation': '回退对话',
  'No user turns to rewind to.': '没有可回退的用户对话轮次。',
  'Rewind to: ': '回退到：',
  'Restore code and conversation': '恢复代码和对话',
  'Restore conversation only': '仅恢复对话',
  'Restore code only': '仅恢复代码',
  'Never mind': '算了',
  'Computing file changes...': '正在计算文件变更...',
  'Restoring...': '正在恢复...',
  'Restored {{count}} file(s).': '已恢复 {{count}} 个文件。',
  'Failed to restore files: {{error}}': '恢复文件失败：{{error}}',
  'Rewind failed: {{error}}': '回退失败：{{error}}',
  'Cannot rewind conversation: no active model client.':
    '无法回退对话：模型客户端未激活。',
  'Code restored, but conversation could not be rewound (no active client).':
    '代码已恢复，但对话无法回退（模型客户端未激活）。',
  'Conversation rewound. Edit your prompt and press Enter to continue.':
    '对话已回退。修改你的提示后按回车继续。',
  'Rewinding does not affect files edited manually or via shell commands.':
    '回退不会影响手工编辑或通过 shell 命令修改的文件。',
  'Cannot rewind to a turn that was compressed. Try a more recent turn.':
    '无法回退到已被压缩的轮次，请尝试更近一些的轮次。',
  'File restore is unavailable for this turn (no captured file changes, or this turn predates the current session).':
    '该轮次无法恢复文件（没有捕获到文件变更，或该轮次属于本次会话之前）。',
  '(+{{insertions}} -{{deletions}} in {{count}} file)':
    '(+{{insertions}} -{{deletions}}，{{count}} 个文件)',
  '(+{{insertions}} -{{deletions}} in {{count}} files)':
    '(+{{insertions}} -{{deletions}}，{{count}} 个文件)',
  'Failed to restore {{count}} file(s): {{files}}':
    '恢复 {{count}} 个文件失败：{{files}}',
  'Cannot restore files: this turn was created before file checkpointing was enabled.':
    '无法恢复文件：该轮对话创建时尚未启用文件检查点功能。',
  'No files needed to be restored.': '没有文件需要恢复。',
  '↑↓ to navigate · Enter to select · Esc to go back':
    '↑↓ 导航 · Enter 选择 · Esc 返回',
  '↑↓ to navigate · Enter to select · Esc to cancel':
    '↑↓ 导航 · Enter 选择 · Esc 取消',
  'Enter/Y to confirm · Esc/N to go back': 'Enter/Y 确认 · Esc/N 返回',
  'change the theme': '更改主题',
  'Select Theme': '选择主题',
  Preview: '预览',
  '(Use Enter to select, Tab to configure scope)':
    '（使用 Enter 选择，Tab 配置作用域）',
  '(Use Enter to apply scope, Tab to go back)':
    '（使用 Enter 应用作用域，Tab 返回）',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    '由于 NO_COLOR 环境变量，主题配置不可用。',
  'Theme "{{themeName}}" not found.': '未找到主题 "{{themeName}}"。',
  'Theme "{{themeName}}" not found in selected scope.':
    '在所选作用域中未找到主题 "{{themeName}}"。',
  'Clear conversation history and free up context': '清除对话历史并释放上下文',
  'Compresses the context by replacing it with a summary.':
    '通过摘要替换来压缩上下文',
  'Fast context compression without AI. Strips old tool outputs and thinking parts.':
    '无需 AI 的快速上下文压缩。清理旧工具输出并剥离思考过程。',
  'open full Qwen Code documentation in your browser':
    '在浏览器中打开完整的 Qwen Code 文档',
  'Configuration not available.': '配置不可用',
  'Connect an LLM provider': '连接 LLM 提供商',
  'Copy to clipboard: reply, code (by lang), LaTeX, or Mermaid. N = Nth-latest message, index = block number':
    '复制到剪贴板：AI 回复、代码块（可按语言筛选）、LaTeX 或 Mermaid。N 为倒数第 N 条消息，index 为代码块序号',
  'Show working-tree change stats versus HEAD':
    '显示工作区相对 HEAD 的变更统计',
  'Could not determine current working directory.': '无法确定当前工作目录。',
  'Failed to compute git diff stats': '计算 git diff 统计失败',
  'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.':
    '无可用 diff。可能不是 Git 仓库、HEAD 缺失，或正在执行 merge/rebase/cherry-pick/revert。',
  'Clean working tree — no changes against HEAD.':
    '工作区干净 —— 与 HEAD 无差异。',
  '{{count}} file changed, +{{added}} / -{{removed}}':
    '{{count}} 个文件变更，+{{added}} / -{{removed}}',
  '{{count}} files changed, +{{added}} / -{{removed}}':
    '{{count}} 个文件变更，+{{added}} / -{{removed}}',
  '{{count}} file changed': '{{count}} 个文件变更',
  '{{count}} files changed': '{{count}} 个文件变更',
  '…and {{hidden}} more (showing first {{shown}})':
    '…还有 {{hidden}} 个（仅显示前 {{shown}} 个）',
  '(binary)': '（二进制）',
  '(binary, new)': '（二进制，新增）',
  '(new)': '（新增）',
  '(new, partial)': '（新增，部分统计）',
  '(deleted)': '（已删除）',
  '(binary, deleted)': '（二进制，已删除）',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    '管理用于专门任务委派的子智能体',
  'Manage existing subagents (view, edit, delete).':
    '管理现有子智能体（查看、编辑、删除）',
  'Create a new subagent with guided setup.': '通过引导式设置创建新的子智能体',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: '智能体',
  'Choose Action': '选择操作',
  'Edit {{name}}': '编辑 {{name}}',
  'Edit Tools: {{name}}': '编辑工具: {{name}}',
  'Edit Color: {{name}}': '编辑颜色: {{name}}',
  'Delete {{name}}': '删除 {{name}}',
  'Unknown Step': '未知步骤',
  'Esc to close': '按 Esc 关闭',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter 选择，↑↓ 导航，Esc 关闭',
  'Esc to go back': '按 Esc 返回',
  'Enter to confirm, Esc to cancel': 'Enter 确认，Esc 取消',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter 选择，↑↓ 导航，Esc 返回',
  'Enter to submit, Esc to go back': 'Enter 提交，Esc 返回',
  'Invalid step: {{step}}': '无效步骤: {{step}}',
  'No subagents found.': '未找到子智能体。',
  "Use '/agents create' to create your first subagent.":
    "使用 '/agents create' 创建您的第一个子智能体。",
  '(built-in)': '（内置）',
  '(overridden by project level agent)': '（已被项目级智能体覆盖）',
  'Project Level ({{path}})': '项目级 ({{path}})',
  'User Level ({{path}})': '用户级 ({{path}})',
  'Built-in Agents': '内置智能体',
  'Extension Agents': '扩展智能体',
  'Using: {{count}} agents': '使用中: {{count}} 个智能体',
  'View Agent': '查看智能体',
  'Edit Agent': '编辑智能体',
  'Delete Agent': '删除智能体',
  Back: '返回',
  'No agent selected': '未选择智能体',
  'File Path: ': '文件路径: ',
  'Tools: ': '工具: ',
  'Color: ': '颜色: ',
  'Description:': '描述:',
  'System Prompt:': '系统提示:',
  'Open in editor': '在编辑器中打开',
  'Edit tools': '编辑工具',
  'Edit color': '编辑颜色',
  '❌ Error:': '❌ 错误:',
  'Are you sure you want to delete agent "{{name}}"?':
    '您确定要删除智能体 "{{name}}" 吗？',
  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': '项目级 (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': '用户级 (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ 子智能体创建成功！',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    '子智能体 "{{name}}" 已保存到 {{level}} 级别。',
  'Name: ': '名称: ',
  'Location: ': '位置: ',
  '❌ Error saving subagent:': '❌ 保存子智能体时出错:',
  'Warnings:': '警告:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    '名称 "{{name}}" 在 {{level}} 级别已存在 - 将覆盖现有子智能体',
  'Name "{{name}}" exists at user level - project level will take precedence':
    '名称 "{{name}}" 在用户级别存在 - 项目级别将优先',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    '名称 "{{name}}" 在项目级别存在 - 现有子智能体将优先',
  'Description is over {{length}} characters': '描述超过 {{length}} 个字符',
  'System prompt is over {{length}} characters':
    '系统提示超过 {{length}} 个字符',
  // Agents - Creation Wizard Steps
  'Step {{n}}: Choose Location': '步骤 {{n}}: 选择位置',
  'Step {{n}}: Choose Generation Method': '步骤 {{n}}: 选择生成方式',
  'Generate with Qwen Code (Recommended)': '使用 Qwen Code 生成（推荐）',
  'Manual Creation': '手动创建',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    '描述此子智能体应该做什么以及何时使用它。（为了获得最佳效果，请全面描述）',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    '例如：专业的代码审查员，根据最佳实践审查代码...',
  'Generating subagent configuration...': '正在生成子智能体配置...',
  'Failed to generate subagent: {{error}}': '生成子智能体失败: {{error}}',
  'Step {{n}}: Describe Your Subagent': '步骤 {{n}}: 描述您的子智能体',
  'Step {{n}}: Enter Subagent Name': '步骤 {{n}}: 输入子智能体名称',
  'Step {{n}}: Enter System Prompt': '步骤 {{n}}: 输入系统提示',
  'Step {{n}}: Enter Description': '步骤 {{n}}: 输入描述',
  // Agents - Tool Selection
  'Step {{n}}: Select Tools': '步骤 {{n}}: 选择工具',
  'All Tools (Default)': '所有工具（默认）',
  'All Tools': '所有工具',
  'Read-only Tools': '只读工具',
  'Read & Edit Tools': '读取和编辑工具',
  'Read & Edit & Execution Tools': '读取、编辑和执行工具',
  'All tools selected, including MCP tools': '已选择所有工具，包括 MCP tools',
  'Selected tools:': '已选择的工具:',
  'Read-only tools:': '只读工具:',
  'Edit tools:': '编辑工具:',
  'Execution tools:': '执行工具:',
  'Step {{n}}: Choose Background Color': '步骤 {{n}}: 选择背景颜色',
  'Step {{n}}: Confirm and Save': '步骤 {{n}}: 确认并保存',
  // Agents - Navigation & Instructions
  'Esc to cancel': '按 Esc 取消',
  'Press Enter to save, e to save and edit, Esc to go back':
    '按 Enter 保存，e 保存并编辑，Esc 返回',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    '按 Enter 继续，{{navigation}}Esc {{action}}',
  cancel: '取消',
  'go back': '返回',
  '↑↓ to navigate, ': '↑↓ 导航，',
  'Enter a clear, unique name for this subagent.':
    '为此子智能体输入一个清晰、唯一的名称。',
  'e.g., Code Reviewer': '例如：代码审查员',
  'Name cannot be empty.': '名称不能为空。',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    '编写定义此子智能体行为的系统提示。为了获得最佳效果，请全面描述。',
  'e.g., You are an expert code reviewer...':
    '例如：您是一位专业的代码审查员...',
  'System prompt cannot be empty.': '系统提示不能为空。',
  'Describe when and how this subagent should be used.':
    '描述何时以及如何使用此子智能体。',
  'e.g., Reviews code for best practices and potential bugs.':
    '例如：审查代码以查找最佳实践和潜在错误。',
  'Description cannot be empty.': '描述不能为空。',
  'Failed to launch editor: {{error}}': '启动编辑器失败: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    '保存并编辑子智能体失败: {{error}}',

  // ============================================================================
  // Extensions - Management Dialog
  // ============================================================================
  'Manage Extensions': '管理扩展',
  'Extension Details': '扩展详情',
  'View Extension': '查看扩展',
  'Update Extension': '更新扩展',
  'Disable Extension': '禁用扩展',
  'Enable Extension': '启用扩展',
  'Uninstall Extension': '卸载扩展',
  'Select Scope': '选择作用域',
  'User Scope': '用户作用域',
  'Workspace Scope': '工作区作用域',
  'No extensions found.': '未找到扩展。',
  'Updating...': '更新中...',
  Unknown: '未知',
  Error: '错误',
  'Stopped because': '停止原因',
  'Version:': '版本：',
  'Status:': '状态：',
  'Are you sure you want to uninstall extension "{{name}}"?':
    '确定要卸载扩展 "{{name}}" 吗？',
  'This action cannot be undone.': '此操作无法撤销。',
  'Extension "{{name}}" updated successfully.': '扩展 "{{name}}" 更新成功。',
  // Extension dialog - missing keys
  'Name:': '名称：',
  'MCP Servers:': 'MCP Servers：',
  'Settings:': '设置：',
  active: '已启用',
  'View Details': '查看详情',
  'Update failed:': '更新失败：',
  'Updating {{name}}...': '正在更新 {{name}}...',
  'Update complete!': '更新完成！',
  'User (global)': '用户（全局）',
  'Workspace (project-specific)': '工作区（项目特定）',
  'Disable "{{name}}" - Select Scope': '禁用 "{{name}}" - 选择作用域',
  'Enable "{{name}}" - Select Scope': '启用 "{{name}}" - 选择作用域',
  'No extension selected': '未选择扩展',
  '{{count}} extensions installed': '已安装 {{count}} 个扩展',
  "Use '/extensions install' to install your first extension.":
    "使用 '/extensions install' 安装您的第一个扩展。",
  // Update status values
  'up to date': '已是最新',
  'update available': '有可用更新',
  'checking...': '检查中...',
  'not updatable': '不可更新',
  error: '错误',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': '查看和编辑 Qwen Code 设置',
  Settings: '设置',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '要查看更改，必须重启 Qwen Code。按 r 退出并立即应用更改。',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim 模式',
  'Attribution: commit': '署名：提交',
  'Terminal Bell Notification': '终端响铃通知',
  'Enable Usage Statistics': '启用使用统计',
  Theme: '主题',
  'Preferred Editor': '首选编辑器',
  'Auto-connect to IDE': '自动连接到 IDE',
  'Debug Keystroke Logging': '调试按键记录',
  'Language: UI': '语言：界面',
  'Language: Model': '语言：模型',
  'Output Format': '输出格式',
  'Hide Window Title': '隐藏窗口标题',
  'Show Status in Title': '在标题中显示状态',
  'Hide Tips': '隐藏提示',
  'Show Line Numbers in Code': '在代码中显示行号',
  'Show Citations': '显示引用',
  'Custom Witty Phrases': '自定义诙谐短语',
  'Show Welcome Back Dialog': '显示欢迎回来对话框',
  'Enable User Feedback': '启用用户反馈',
  'How is Qwen doing this session? (optional)': 'Qwen 这次表现如何？（可选）',
  Bad: '不满意',
  Fine: '还行',
  Good: '满意',
  Dismiss: '忽略',
  'Screen Reader Mode': '屏幕阅读器模式',
  'Max Session Turns': '最大会话轮次',
  'Skip Next Speaker Check': '跳过下一个说话者检查',
  'Skip Loop Detection': '跳过循环检测',
  'Skip Startup Context': '跳过启动上下文',
  'Enable OpenAI Logging': '启用 OpenAI 日志',
  'OpenAI Logging Directory': 'OpenAI 日志目录',
  Timeout: '超时',
  'Max Retries': '最大重试次数',
  'Load Memory From Include Directories': '从包含目录加载内存',
  'Respect .gitignore': '遵守 .gitignore',
  'Respect .qwenignore': '遵守 .qwenignore',
  'Enable Recursive File Search': '启用递归文件搜索',
  'Interactive Shell (PTY)': '交互式 Shell (PTY)',
  'Show Color': '显示颜色',
  'Auto Accept': '自动接受',
  'Use Ripgrep': '使用 Ripgrep',
  'Use Builtin Ripgrep': '使用内置 Ripgrep',
  'Tool Output Truncation Threshold': '工具输出截断阈值',
  'Tool Output Truncation Lines': '工具输出截断行数',
  'Folder Trust': '文件夹信任',
  'Tool Schema Compliance': 'Tool Schema 兼容性',
  // Settings enum options
  'Auto (detect from system)': '自动（从系统检测）',
  'Auto (detect terminal theme)': '自动（检测终端主题）',
  Auto: '自动',
  Text: '文本',
  JSON: 'JSON',
  Plan: '规划',
  'Ask permissions': '请求授权',
  'Auto Edit': '自动编辑',
  YOLO: 'YOLO',
  'toggle vim mode on/off': '切换 vim 模式开关',
  'Show usage statistics dashboard.': '显示使用统计面板。',
  'Show model-specific usage statistics.': '显示模型相关的使用统计信息',
  'Show tool-specific usage statistics.': '显示工具相关的使用统计信息',
  'Show daily token usage statistics.': '显示每日 token 使用统计信息',
  'Show monthly token usage statistics.': '显示每月 token 使用统计信息',
  'Export token usage statistics to CSV or JSON.':
    '将 token 使用统计信息导出为 CSV 或 JSON',
  'No usage data.': '没有使用数据。',
  '{{label}}: {{tokens}} tokens ({{requests}} requests)':
    '{{label}}：{{tokens}} 个 token（{{requests}} 个请求）',
  'Daily token usage for {{value}}': '{{value}} 的每日 token 使用情况',
  'Monthly token usage for {{value}}': '{{value}} 的每月 token 使用情况',
  'Total: {{tokens}} tokens': '总计：{{tokens}} 个 token',
  'Requests: {{requests}}': '请求数：{{requests}}',
  'Breakdown:': '明细：',
  'Input: {{tokens}}': '输入：{{tokens}}',
  'Output: {{tokens}}': '输出：{{tokens}}',
  'Cached (included in Input): {{tokens}}':
    '缓存（已包含在输入中）：{{tokens}}',
  'Thoughts: {{tokens}}': '思考：{{tokens}}',
  'By model:': '按模型：',
  'By auth type:': '按认证类型：',
  'By model/auth type:': '按模型/认证类型：',
  'By source:': '按来源：',
  'Failed to load token usage stats: {{error}}':
    '加载 token 使用统计信息失败：{{error}}',
  'Expected --format csv or --format json.':
    '应为 --format csv 或 --format json。',
  'Expected a file path after --output.': '--output 后应提供文件路径。',
  'Unexpected argument: {{argument}}': '意外参数：{{argument}}',
  'Usage: /stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]':
    '用法：/stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]',
  'Token usage export path must be within the project working directory.':
    'Token 使用导出路径必须位于项目工作目录内。',
  'Export target does not exist: {{path}}': '导出目标不存在：{{path}}',
  'Cannot resolve export path within the working directory.':
    '无法在工作目录内解析导出路径。',
  'Could not create a temporary export file.': '无法创建临时导出文件。',
  'Token usage exported to {{format}}: {{path}}':
    'Token 使用情况已导出为 {{format}}：{{path}}',
  'Failed to export token usage stats: {{error}}':
    '导出 token 使用统计信息失败：{{error}}',
  'Unclosed quote in arguments.': '参数中存在未闭合的引号。',
  'Note: generation timing (TTFT/TPS) belongs to generation metrics.':
    '注意：生成耗时（TTFT/TPS）归属于生成指标。',
  'exit the cli': '退出命令行界面',
  'Manage workspace directories': '管理工作区目录',
  'Add directories to the workspace. Use comma to separate multiple paths':
    '将目录添加到工作区。使用逗号分隔多个路径',
  'Show all directories in the workspace': '显示工作区中的所有目录',
  'set external editor preference': '设置外部编辑器首选项',
  'Select Editor': '选择编辑器',
  'Editor Preference': '编辑器首选项',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    '当前支持以下编辑器。请注意，某些编辑器无法在沙箱模式下使用。',
  'Your preferred editor is:': '您的首选编辑器是：',
  'Manage extensions': '管理扩展',
  'Manage installed extensions': '管理已安装的扩展',
  'Disable an extension': '禁用扩展',
  'Enable an extension': '启用扩展',
  'Install an extension from a git repo or local path':
    '从 Git 仓库或本地路径安装扩展',
  'Uninstall an extension': '卸载扩展',
  'No extensions installed.': '未安装扩展。',
  'Extension "{{name}}" not found.': '未找到扩展 "{{name}}"。',
  'The scope to install the extension in: "user" (global, default) or "project" (current workspace only).':
    '安装扩展的作用域："user"（全局，默认）或 "project"（仅当前工作区）。',
  'Extension "{{name}}" installed successfully and enabled for the current workspace.':
    '扩展 "{{name}}" 安装成功，并已在当前工作区启用。',
  'Marketplace "{{name}}" not found.': '未找到市场源 "{{name}}"。',
  'No marketplace sources added yet.': '尚未添加任何市场源。',
  'No marketplaces added yet.': '尚未添加任何市场源。',
  'Adds a marketplace source (Claude format).':
    '添加一个市场源（Claude 格式）。',
  'The marketplace source to add: owner/repo (GitHub), a git or https URL, or a local path.':
    '要添加的市场源：owner/repo（GitHub）、git 或 https URL，或本地路径。',
  'Removes a marketplace source.': '移除一个市场源。',
  'The name of the marketplace to remove.': '要移除的市场源名称。',
  'Lists configured marketplace sources.': '列出已配置的市场源。',
  'Re-fetches a marketplace source and its plugin listing.':
    '重新拉取市场源及其插件列表。',
  'The name of the marketplace to update.': '要更新的市场源名称。',
  'Manage marketplace sources for discovering extensions.':
    '管理用于发现扩展的市场源。',
  'You need at least one command before continuing.':
    '需要至少提供一个子命令。',
  'No extensions to update.': '没有可更新的扩展。',
  'Usage: /extensions install <source>': '用法：/extensions install <来源>',
  'Installing extension from "{{source}}"...':
    '正在从 "{{source}}" 安装扩展...',
  'Extension "{{name}}" installed successfully.': '扩展 "{{name}}" 安装成功。',
  'Failed to install extension from "{{source}}": {{error}}':
    '从 "{{source}}" 安装扩展失败：{{error}}',
  'Do you want to continue? [Y/n]: ': '是否继续？[Y/n]：',
  'Do you want to continue?': '是否继续？',
  'Installing extension "{{name}}".': '正在安装扩展 "{{name}}"。',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**扩展可能会引入意外行为。请确保您已调查过扩展源并信任作者。**',
  'This extension will run the following MCP servers:':
    '此扩展将运行以下 MCP servers：',
  local: '本地',
  remote: '远程',
  'This extension will add the following commands: {{commands}}.':
    '此扩展将添加以下命令：{{commands}}。',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    '此扩展将使用 {{fileName}} 向您的 QWEN.md 上下文追加信息',
  'This extension will install the following skills:': '此扩展将安装以下技能：',
  'This extension will install the following subagents:':
    '此扩展将安装以下子智能体：',
  'Installation cancelled for "{{name}}".': '已取消安装 "{{name}}"。',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    '您正在安装来自 {{originSource}} 的扩展。某些功能可能无法完美兼容 Qwen Code。',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref 和 --auto-update 不适用于市场扩展。',
  'Extension "{{name}}" installed successfully and enabled.':
    '扩展 "{{name}}" 安装成功并已启用。',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    '要安装的扩展的 GitHub URL、本地路径或市场源（marketplace-url:plugin-name）。',
  'The git ref to install from.': '要安装的 Git 引用。',
  '--registry is only applicable for npm extensions.':
    '--registry 仅适用于 npm 扩展。',
  'Custom npm registry URL (only for npm extensions).':
    '自定义 npm registry URL（仅适用于 npm 扩展）。',
  '--ref is not applicable for npm extensions. Use @version suffix instead (e.g. @scope/package@1.2.0).':
    '--ref 不适用于 npm 扩展。请改用 @version 后缀（例如 @scope/package@1.2.0）。',
  'Installs an extension from a git repository URL, local path, scoped npm package (@scope/name), or claude marketplace (marketplace-url:plugin-name).':
    '从 Git 仓库 URL、本地路径、带作用域的 npm 包（@scope/name）或 Claude 市场源（marketplace-url:plugin-name）安装扩展。',
  Description: '描述',
  'Delete Session': '删除会话',
  'Enable auto-update for this extension.': '为此扩展启用自动更新。',
  'Enable pre-release versions for this extension.': '为此扩展启用预发布版本。',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    '确认安装扩展的安全风险并跳过确认提示。',
  'The source argument must be provided.': '必须提供来源参数。',
  'Extension "{{name}}" successfully uninstalled.':
    '扩展 "{{name}}" 卸载成功。',
  'Uninstalls an extension.': '卸载扩展。',
  'The name or source path of the extension to uninstall.':
    '要卸载的扩展的名称或源路径。',
  'Please include the name of the extension to uninstall as a positional argument.':
    '请将要卸载的扩展名称作为位置参数。',
  'Enables an extension.': '启用扩展。',
  'The name of the extension to enable.': '要启用的扩展名称。',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    '启用扩展的作用域。如果未设置，将在所有作用域中启用。',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    '扩展 "{{name}}" 已在作用域 "{{scope}}" 中启用。',
  'Extension "{{name}}" successfully enabled in all scopes.':
    '扩展 "{{name}}" 已在所有作用域中启用。',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    '无效的作用域：{{scope}}。请使用 {{scopes}} 之一。',
  'Disables an extension.': '禁用扩展。',
  'The name of the extension to disable.': '要禁用的扩展名称。',
  'The scope to disable the extenison in.': '禁用扩展的作用域。',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    '扩展 "{{name}}" 已在作用域 "{{scope}}" 中禁用。',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    '扩展 "{{name}}" 更新成功：{{oldVersion}} → {{newVersion}}。',
  'Unable to install extension "{{name}}" due to missing install metadata':
    '由于缺少安装元数据，无法安装扩展 "{{name}}"',
  'Extension "{{name}}" is already up to date.':
    '扩展 "{{name}}" 已是最新版本。',
  'Updates all extensions or a named extension to the latest version.':
    '将所有扩展或指定扩展更新到最新版本。',
  'Update all extensions.': '更新所有扩展。',
  'The name of the extension to update.': '要更新的扩展名称。',
  'Either an extension name or --all must be provided':
    '必须提供扩展名称或 --all',
  'List installed extensions': '列出已安装的扩展',
  'Lists installed extensions.': '列出已安装的扩展。',
  'Path:': '路径：',
  'Source:': '来源：',
  'Type:': '类型：',
  'Ref:': '引用：',
  'Release tag:': '发布标签：',
  'Enabled (User):': '已启用（用户）：',
  'Enabled (Workspace):': '已启用（工作区）：',
  'Context files:': '上下文文件：',
  'Skills:': '技能：',
  'Agents:': '智能体：',
  'MCP servers:': 'MCP servers：',
  'Link extension failed to install.': '链接扩展安装失败。',
  'Extension "{{name}}" linked successfully and enabled.':
    '扩展 "{{name}}" 链接成功并已启用。',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    '从本地路径链接扩展。对本地路径的更新将始终反映。',
  'The name of the extension to link.': '要链接的扩展名称。',
  'Set a specific setting for an extension.': '为扩展设置特定配置。',
  'Name of the extension to configure.': '要配置的扩展名称。',
  'The setting to configure (name or env var).':
    '要配置的设置（名称或环境变量）。',
  'The scope to set the setting in.': '设置配置的作用域。',
  'List all settings for an extension.': '列出扩展的所有设置。',
  'Name of the extension.': '扩展名称。',
  'Extension "{{name}}" has no settings to configure.':
    '扩展 "{{name}}" 没有可配置的设置。',
  'Settings for "{{name}}":': '"{{name}}" 的设置：',
  '(workspace)': '（工作区）',
  '(user)': '（用户）',
  '[not set]': '［未设置］',
  '[value stored in keychain]': '［值存储在钥匙串中］',
  'Value:': '值：',
  'Manage extension settings.': '管理扩展设置。',
  'You need to specify a command (set or list).':
    '您需要指定命令（set 或 list）。',
  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.': '此市场中没有可用的插件。',
  'Select a plugin to install from marketplace "{{name}}":':
    '从市场 "{{name}}" 中选择要安装的插件：',
  'Plugin selection cancelled.': '插件选择已取消。',
  'Select a plugin from "{{name}}"': '从 "{{name}}" 中选择插件',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    '使用 ↑↓ 或 j/k 导航，Enter 选择，Escape 取消',
  '{{count}} more above': '上方还有 {{count}} 项',
  '{{count}} more below': '下方还有 {{count}} 项',
  'manage IDE integration': '管理 IDE 集成',
  'check status of IDE integration': '检查 IDE 集成状态',
  'install required IDE companion for {{ideName}}':
    '安装 {{ideName}} 所需的 IDE 配套工具',
  'enable IDE integration': '启用 IDE 集成',
  'disable IDE integration': '禁用 IDE 集成',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    '您当前环境不支持 IDE 集成。要使用此功能，请在以下支持的 IDE 之一中运行 Qwen Code：VS Code 或 VS Code 分支版本。',
  'Set up GitHub Actions': '设置 GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    '配置终端按键绑定以支持多行输入（VS Code、Cursor、Windsurf、Trae）',
  'Please restart your terminal for the changes to take effect.':
    '请重启终端以使更改生效。',
  'Failed to configure terminal: {{error}}': '配置终端失败：{{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    '无法确定 {{terminalName}} 在 Windows 上的配置路径：未设置 APPDATA 环境变量。',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json 存在但不是有效的 JSON 数组。请手动修复文件或删除它以允许自动配置。',
  'File: {{file}}': '文件：{{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    '解析 {{terminalName}} keybindings.json 失败。文件包含无效的 JSON。请手动修复文件或删除它以允许自动配置。',
  'Error: {{error}}': '错误：{{error}}',
  'Shift+Enter binding already exists': 'Shift+Enter 绑定已存在',
  'Ctrl+Enter binding already exists': 'Ctrl+Enter 绑定已存在',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    '检测到现有按键绑定。为避免冲突，不会修改。',
  'Please check and modify manually if needed: {{file}}':
    '如有需要，请手动检查并修改：{{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    '已为 {{terminalName}} 添加 Shift+Enter 和 Ctrl+Enter 按键绑定。',
  'Modified: {{file}}': '已修改：{{file}}',
  '{{terminalName}} keybindings already configured.':
    '{{terminalName}} 按键绑定已配置。',
  'Failed to configure {{terminalName}}.': '配置 {{terminalName}} 失败。',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    '您的终端已配置为支持多行输入（Shift+Enter 和 Ctrl+Enter）的最佳体验。',
  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': '管理 Qwen Code Hook',
  'List all configured hooks': '列出所有已配置的 Hook',
  // Hooks - Dialog
  Hooks: 'Hook',
  'Loading hooks...': '正在加载 Hook...',
  'Error loading hooks:': '加载 Hook 出错：',
  'Press Escape to close': '按 Escape 关闭',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    '按 Escape、Ctrl+C 或 Ctrl+D 取消',
  'Press Space, Enter, or Escape to dismiss': '按 Space、Enter 或 Escape 关闭',
  'No hook selected': '未选择 Hook',
  'Session (temporary)': '会话（临时）',
  // Hooks - List Step
  'No hook events found.': '未找到 Hook 事件。',
  '{{count}} hook configured': '{{count}} 个 Hook 已配置',
  '{{count}} hooks configured': '{{count}} 个 Hook 已配置',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    '此菜单为只读。要添加或修改 Hook，请直接编辑 settings.json 或询问 Qwen Code。',
  'Enter to select · Esc to cancel': 'Enter 选择 · Esc 取消',
  // Hooks - Detail Step
  'Exit codes:': '退出码：',
  'Configured hooks:': '已配置的 Hook：',
  'No hooks configured for this event.': '此事件未配置 Hook。',
  'To add hooks, edit settings.json directly or ask Qwen.':
    '要添加 Hook，请直接编辑 settings.json 或询问 Qwen。',
  'Enter to select · Esc to go back': 'Enter 选择 · Esc 返回',
  // Hooks - Config Detail Step
  'Hook details': 'Hook 详情',
  'Event:': '事件：',
  'Extension:': '扩展：',
  'Desc:': '描述：',
  'No hook config selected': '未选择 Hook 配置',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    '要修改或删除此 Hook，请直接编辑 settings.json 或询问 Qwen。',
  // Hooks - Disabled Step
  'Hook Configuration - Disabled': 'Hook 配置 - 已禁用',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    '所有 Hook 当前已禁用。您有 {{count}} 未运行。',
  '{{count}} configured hook': '{{count}} 个已配置的 Hook',
  '{{count}} configured hooks': '{{count}} 个已配置的 Hook',
  'When hooks are disabled:': '当 Hook 被禁用时：',
  'No hook commands will execute': '不会执行任何 Hook 命令',
  'StatusLine will not be displayed': '不会显示状态栏',
  'Tool operations will proceed without hook validation':
    '工具操作将在没有 Hook 验证的情况下继续',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    '要重新启用 Hook，请从 settings.json 中删除 "disableAllHooks" 或询问 Qwen Code。',
  // Hooks - Source
  Project: '项目',
  User: '用户',
  Skill: '技能',
  System: '系统',
  Extension: '扩展',
  'Local Settings': '本地设置',
  'User Settings': '用户设置',
  'System Settings': '系统设置',
  Extensions: '扩展',
  // Hooks - Event Descriptions (short)
  'Before tool execution': '工具执行前',
  'After tool execution': '工具执行后',
  'After tool execution fails': '工具执行失败后',
  'When notifications are sent': '发送通知时',
  'When the user submits a prompt': '用户提交提示时',
  'When a slash command expands into a prompt': '斜杠命令展开为提示时',
  'When a new session is started': '新会话开始时',
  'Right before Qwen Code concludes its response': 'Qwen Code 结束响应之前',
  'When a subagent (Agent tool call) is started':
    '子智能体（Agent 工具调用）启动时',
  'Right before a subagent concludes its response': '子智能体结束响应之前',
  'Before conversation compaction': '对话压缩前',
  'When a session is ending': '会话结束时',
  'When a permission dialog is displayed': '显示权限对话框时',
  'When a new todo item is created': '创建新待办事项时',
  'When a todo item is marked as completed': '待办事项标记为完成时',
  // Hooks - Event Descriptions (detailed)
  'Input to command is JSON of tool call arguments.':
    '命令输入为工具调用参数的 JSON。',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    '命令输入为包含 "inputs"（工具调用参数）和 "response"（工具调用响应）字段的 JSON。',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    '命令输入为包含 tool_name、tool_input、tool_use_id、error、error_type、is_interrupt 和 is_timeout 的 JSON。',
  'Input to command is JSON with notification message and type.':
    '命令输入为包含通知消息和类型的 JSON。',
  'Input to command is JSON with original user prompt text.':
    '命令输入为包含原始用户提示文本的 JSON。',
  'Input to command is JSON with command_name, command_args, and expanded prompt text.':
    '命令输入为包含 command_name、command_args 和展开后提示文本的 JSON。',
  'Input to command is JSON with session start source.':
    '命令输入为包含会话启动来源的 JSON。',
  'Input to command is JSON with session end reason.':
    '命令输入为包含会话结束原因的 JSON。',
  'Input to command is JSON with agent_id and agent_type.':
    '命令输入为包含 agent_id 和 agent_type 的 JSON。',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    '命令输入为包含 agent_id、agent_type 和 agent_transcript_path 的 JSON。',
  'Input to command is JSON with compaction details.':
    '命令输入为包含压缩详情的 JSON。',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    '命令输入为包含 tool_name、tool_input 和 tool_use_id 的 JSON。输出包含 hookSpecificOutput 的 JSON，其中包含允许或拒绝的决定。',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    '命令输入为包含 todo_id、todo_content、todo_status、all_todos 和 phase 的 JSON。在 validation 中，输出包含 decision（allow/block/deny）和 reason 的 JSON。在 postWrite 中，block/deny 会被忽略。',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    '命令输入为包含 todo_id、todo_content、previous_status、all_todos 和 phase 的 JSON。在 validation 中，输出包含 decision（allow/block/deny）和 reason 的 JSON。在 postWrite 中，block/deny 会被忽略。',
  // Hooks - Exit Code Descriptions
  'stdout/stderr not shown': 'stdout/stderr 不显示',
  'show stderr to model and continue conversation':
    '向模型显示 stderr 并继续对话',
  'show stderr to user only': '仅向用户显示 stderr',
  'stdout shown in transcript mode (ctrl+o)': 'stdout 以转录模式显示 (ctrl+o)',
  'show stderr to model immediately': '立即向模型显示 stderr',
  'show stderr to user only but continue with tool call':
    '仅向用户显示 stderr 但继续工具调用',
  'block processing, erase original prompt, and show stderr to user only':
    '阻止处理，擦除原始提示，仅向用户显示 stderr',
  'block expanded prompt submission and show stderr to user only':
    '阻止提交展开后的提示，并仅向用户显示 stderr',
  'stdout shown to Qwen': '向 Qwen 显示 stdout',
  'show stderr to user only (blocking errors ignored)':
    '仅向用户显示 stderr（忽略阻塞错误）',
  'command completes successfully': '命令成功完成',
  'stdout shown to subagent': '向子智能体显示 stdout',
  'show stderr to subagent and continue having it run':
    '向子智能体显示 stderr 并继续运行',
  'stdout appended as custom compact instructions':
    'stdout 作为自定义压缩指令追加',
  'block compaction': '阻止压缩',
  'show stderr to user only but continue with compaction':
    '仅向用户显示 stderr 但继续压缩',
  'use hook decision if provided': '如果提供则使用 Hook 决定',
  'allow todo creation': '允许创建待办事项',
  'block todo creation and show reason to model':
    '阻止创建待办事项并向模型显示原因',
  'allow todo completion': '允许完成待办事项',
  'block todo completion and show reason to model':
    '阻止完成待办事项并向模型显示原因',
  // Hooks - Messages
  'Config not loaded.': '配置未加载。',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Hook 未启用。请在设置中启用 Hook 以使用此功能。',
  // ============================================================================
  // Commands - Session Export
  // ============================================================================
  'Export current session message history to a file':
    '将当前会话的消息记录导出到文件',
  'Export session to HTML format': '将会话导出为 HTML 文件',
  'Export session to JSON format': '将会话导出为 JSON 文件',
  'Export session to JSONL format (one message per line)':
    '将会话导出为 JSONL 文件（每行一条消息）',
  'Export session to markdown format': '将会话导出为 Markdown 文件',

  // ============================================================================
  // Commands - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    '根据你的聊天记录生成个性化编程洞察',

  // ============================================================================
  // Commands - Session History
  // ============================================================================
  'Resume a previous session': '恢复先前会话',
  'Fork the current conversation into a new session': '将当前对话分支到新会话',
  'Spawn a background agent that inherits the full conversation':
    '启动继承完整对话的后台智能体',
  'Please provide a directive. Usage: /fork <directive>':
    '请提供指令。用法：/fork <指令>',
  'Cannot fork while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    '响应或工具调用正在进行时无法分支。请等待其完成或处理待确认的工具调用。',
  'Cannot fork before the first conversation turn.': '首次对话轮次前无法分支。',
  'The agent tool is unavailable; cannot fork.': 'Agent 工具不可用；无法分支。',
  'Failed to launch fork: {{error}}': '启动分支失败：{{error}}',
  'the background agent could not be started.': '后台智能体无法启动。',
  'User launched a background fork via /fork: {{directive}}':
    '用户通过 /fork 启动了后台分支：{{directive}}',
  'Forked into a background agent. It inherits this conversation and runs without blocking — track it in the background tasks panel; it reports back when done.':
    '已分支到后台智能体。它会继承此对话并以非阻塞方式运行，可在后台任务面板中跟踪；完成后会回报结果。',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    '响应或工具调用正在进行时无法分支。请等待其完成或处理待确认的工具调用。',
  'No conversation to branch.': '没有可分支的对话。',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    '恢复某次工具调用。这将把对话与文件历史重置到提出该工具调用建议时的状态',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    '无法检测终端类型。支持的终端：VS Code、Cursor、Windsurf 和 Trae。',
  'Terminal "{{terminal}}" is not supported yet.':
    '终端 "{{terminal}}" 尚未支持。',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: {{options}}':
    '无效的语言。可用选项：{{options}}',
  'Language subcommands do not accept additional arguments.':
    '语言子命令不接受额外参数',
  'Current UI language: {{lang}}': '当前 UI 语言：{{lang}}',
  'Current LLM output language: {{lang}}': '当前 LLM 输出语言：{{lang}}',
  'Set UI language': '设置 UI 语言',
  'Set LLM output language': '设置 LLM 输出语言',
  'Usage: /language ui [{{options}}]': '用法：/language ui [{{options}}]',
  'Usage: /language output <language>': '用法：/language output <语言>',
  'Example: /language output 中文': '示例：/language output 中文',
  'Example: /language output English': '示例：/language output English',
  'Example: /language output 日本語': '示例：/language output 日本語',
  'UI language changed to {{lang}}': 'UI 语言已更改为 {{lang}}',
  'LLM output language set to {{lang}}': 'LLM 输出语言已设置为 {{lang}}',
  'Please restart the application for the changes to take effect.':
    '请重启应用程序以使更改生效。',
  'Failed to generate LLM output language rule file: {{error}}':
    '生成 LLM 输出语言规则文件失败：{{error}}',
  'Invalid command. Available subcommands:': '无效的命令。可用的子命令：',
  'Available subcommands:': '可用的子命令：',
  'To request additional UI language packs, please open an issue on GitHub.':
    '如需请求其他 UI 语言包，请在 GitHub 上提交 issue',
  'Available options:': '可用选项：',
  'Set UI language to {{name}}': '将 UI 语言设置为 {{name}}',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Tool Approval Mode': '工具审批模式',
  'Analyze only, do not modify files or execute commands':
    '仅分析，不修改文件或执行命令',
  'Require approval for file edits or shell commands':
    '需要批准文件编辑或 shell 命令',
  'Automatically approve file edits': '自动批准文件编辑',
  'Use classifier to automatically approve safe tool calls':
    '使用分类器自动批准安全的工具调用',
  'Automatically approve all tools': '自动批准所有工具',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    '工作区审批模式已存在并具有优先级。用户级别的更改将无效。',
  'Apply To': '应用于',
  'Workspace Settings': '工作区设置',
  'Open auto-memory folder': '打开自动记忆文件夹',
  'Auto-memory: {{status}}': '自动记忆：{{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    '自动整理：{{status}} · {{lastDream}} · /dream 立即运行',
  'Auto-skill: {{status}}': '自动技能：{{status}}',
  never: '从未',
  on: '开',
  off: '关',
  'Remove matching entries from managed auto-memory.':
    '从托管自动记忆中删除匹配的条目。',
  'Usage: /forget <memory text to remove>': '用法：/forget <要删除的记忆文本>',
  'No managed auto-memory entries matched: {{query}}':
    '没有匹配的托管自动记忆条目：{{query}}',
  'Consolidate managed auto-memory topic files.': '整理托管自动记忆主题文件',
  'Import MCP servers from Claude configs': '从 Claude 配置导入 MCP 服务器',
  'Open MCP management dialog': '打开 MCP 管理对话框',
  'Could not retrieve tool registry.': '无法检索工具注册表',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "成功认证并刷新了 '{{name}}' 的工具",
  "Re-discovering tools from '{{name}}'...":
    "正在重新发现 '{{name}}' 的工具...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "从 '{{name}}' 发现了 {{count}} 个工具。",
  'Authentication complete. Returning to server details...':
    '认证完成，正在返回服务器详情...',
  'Authentication successful.': '认证成功。',
  // ============================================================================
  // MCP Management Dialog
  // ============================================================================
  'Manage MCP servers': '管理 MCP servers',
  'Server Detail': '服务器详情',
  Tools: '工具',
  'Tool Detail': '工具详情',
  'Loading...': '加载中...',
  'Unknown step': '未知步骤',
  'Esc to back': 'Esc 返回',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ 导航 · Enter 选择 · Esc 关闭',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ 导航 · Enter 选择 · Esc 返回',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ 导航 · Enter 确认 · Esc 返回',
  'User Settings (global)': '用户设置（全局）',
  'Workspace Settings (project-specific)': '工作区设置（项目级）',
  'Disable server:': '禁用服务器：',
  'Select where to add the server to the exclude list:':
    '选择将服务器添加到排除列表的位置：',
  'Press Enter to confirm, Esc to cancel': '按 Enter 确认，Esc 取消',
  'View tools': '查看工具',
  'View resources': '查看资源',
  Reconnect: '重新连接',
  Enable: '启用',
  Disable: '禁用',
  Authenticate: '认证',
  'Re-authenticate': '重新认证',
  'Clear Authentication': '清空认证',
  disabled: '已禁用',
  enabled: '已启用',
  'Server:': '服务器：',
  'Error:': '错误：',
  tool: '工具',
  tools: '个工具',
  resource: '资源',
  resources: '个资源',
  connected: '已连接',
  connecting: '连接中',
  disconnected: '已断开',
  'needs authentication': '需要认证',

  // MCP Server List
  'User MCPs': '用户 MCP',
  'Project MCPs': '项目 MCP',
  'Extension MCPs': '扩展 MCP',
  server: '个服务器',
  servers: '个服务器',
  'Add MCP servers to your settings to get started.':
    '请在设置中添加 MCP servers 以开始使用。',
  'Run qwen --debug to see error logs': '运行 qwen --debug 查看错误日志',

  // MCP OAuth Authentication
  'OAuth Authentication': 'OAuth 认证',
  'Authenticating... Please complete the login in your browser.':
    '认证中... 请在浏览器中完成登录。',
  'Press c to copy the authorization URL to your clipboard.':
    '按 c 复制授权 URL 到剪贴板。',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    '已向终端发送复制请求；若粘贴为空，请手动复制上方 URL。',
  'Cannot write to terminal — copy the URL above manually.':
    '无法写入终端，请手动复制上方 URL。',
  // MCP Server Detail
  'Command:': '命令：',
  'Working Directory:': '工作目录：',
  'No server selected': '未选择服务器',
  prompts: '提示',

  // MCP Tool List
  'No tools available for this server.': '此服务器没有可用工具。',
  destructive: '破坏性',
  'read-only': '只读',
  'open-world': '开放世界',
  idempotent: '幂等',
  'Tools for {{serverName}}': '{{serverName}} 的工具',
  '{{current}}/{{total}}': '{{current}}/{{total}}',

  // MCP Tool Detail
  required: '必需',
  Parameters: '参数',
  'No tool selected': '未选择工具',
  Server: '服务器',

  // MCP Resource List/Detail
  'No resources available for this server.': '此服务器没有可用资源。',
  'Resources for {{serverName}}': '{{serverName}} 的资源',
  'No resource selected': '未选择资源',
  'Resource Detail': '资源详情',
  'URI:': 'URI：',
  'MIME Type:': 'MIME 类型：',
  'Size:': '大小：',
  '{{count}} bytes': '{{count}} 字节',
  'Reference in chat': '在对话中引用',

  // Invalid tool related translations
  '{{count}} invalid tools': '{{count}} 个无效工具',
  invalid: '无效',
  'invalid: {{reason}}': '无效：{{reason}}',
  'missing name': '缺少名称',
  'missing description': '缺少描述',
  '(unnamed)': '(未命名)',
  'Warning: This tool cannot be called by the LLM':
    '警告：此工具无法被 LLM 调用',
  Reason: '原因',
  'Tools must have both name and description to be used by the LLM.':
    '工具必须同时具有名称和描述才能被 LLM 使用。',
  // ===========================================================
  // Commands - Summary
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    '生成项目摘要并保存到 .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    '没有可用的聊天客户端来生成摘要',
  'Already generating summary, wait for previous request to complete':
    '正在生成摘要，请等待上一个请求完成',
  'No conversation found to summarize.': '未找到要总结的对话',
  'Failed to generate project context summary: {{error}}':
    '生成项目上下文摘要失败：{{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    '项目摘要已保存到 {{filePathForDisplay}}',
  'Saving project summary...': '正在保存项目摘要...',
  'Generating project summary...': '正在生成项目摘要...',
  'Processing summary...': '正在处理摘要...',
  'Project summary generated and saved successfully!':
    '项目摘要已生成并成功保存！',
  'Saved to: {{filePath}}': '保存至：{{filePath}}',
  'Failed to generate summary - no text content received from LLM response':
    '生成摘要失败 - 未从 LLM 响应中接收到文本内容',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    '切换此会话的模型（--fast 可设置建议模型）',
  'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, [model-id] to switch immediately).':
    '切换此会话的模型（--fast 可设置建议模型，--voice 可设置语音转写模型，[model-id] 可立即切换）',
  'Set a lighter model for prompt suggestions and speculative execution':
    '设置用于输入建议和推测执行的轻量模型',
  'Toggle voice dictation input': '切换语音听写输入',
  'Set the model for voice transcription': '设置语音转写模型',
  'Select Fast Model': '选择快速模型',
  'Select Voice Model': '选择语音模型',
  'Voice Model': '语音模型',
  'Selected voice model is unavailable.': '所选语音模型不可用。',
  "Voice model '{{model}}' is configured more than once. Remove duplicate model ids before selecting it for voice transcription.":
    "语音模型 '{{model}}' 被配置了多次。请先移除重复的模型 ID，再将其选为语音转写模型。",
  'Voice dictation: {{status}} (mode: {{mode}}, {{modelText}}).':
    '语音听写：{{status}}（模式：{{mode}}，{{modelText}}）。',
  'model: {{voiceModel}}': '模型：{{voiceModel}}',
  'no voice model selected': '未选择语音模型',
  'Voice dictation disabled.': '语音听写已禁用。',
  'Usage: /voice [hold|tap|off|status]': '用法：/voice [hold|tap|off|status]',
  'No voice model selected. Run /model --voice to choose one before enabling voice dictation.':
    '未选择语音模型。请先运行 /model --voice 选择模型，再启用语音听写。',
  'Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using {{voiceModel}}.':
    '语音听写已启用（点击模式）。在空输入框中点击 Space 开始，再点击一次或停顿后停止并提交，使用 {{voiceModel}}。',
  'Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with {{voiceModel}}.':
    '语音听写已启用（按住模式）。在空输入框中按住 Space，使用 {{voiceModel}} 听写。',
  'No models are configured.': '未配置模型。',
  'Configured models: {{models}}.': '已配置模型：{{models}}。',
  'Configure a unique model id in settings.modelProviders or run /model --voice to select an available model.':
    '请在 settings.modelProviders 中配置唯一的模型 ID，或运行 /model --voice 选择可用模型。',
  "Voice model '{{modelName}}' is not configured.":
    "语音模型 '{{modelName}}' 未配置。",
  "Voice model '{{modelName}}' cannot be used for transcription.":
    "语音模型 '{{modelName}}' 不能用于转写。",
  "Voice model '{{modelName}}' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.":
    "语音模型 '{{modelName}}' 不能用于转写。请在 settings.modelProviders 中配置带 baseUrl 的 OpenAI 兼容模型。",
  'Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.':
    '请在 settings.modelProviders 中配置带 baseUrl 的 OpenAI 兼容模型。',
  'Microphone access is denied. Enable it for your terminal in System Settings → Privacy & Security → Microphone, then restart voice dictation.':
    '麦克风访问被拒绝。请在系统设置 → 隐私与安全性 → 麦克风中允许当前终端访问，然后重新启动语音听写。',
  'Voice dictation is not supported on {{platform}}.':
    '语音听写不支持 {{platform}}。',
  'Voice dictation needs microphone access, which is unavailable in this WSL session. Use WSLg/PulseAudio, or run Qwen Code on a host with a microphone.':
    '语音听写需要麦克风访问，但当前 WSL 会话不可用。请使用 WSLg/PulseAudio，或在带麦克风的宿主机上运行 Qwen Code。',
  'Voice dictation needs microphone access. macOS will ask the first time you record — approve it, then start again. Your first recording may be empty while the dialog is open.':
    '语音听写需要麦克风访问。macOS 会在你首次录音时弹出授权请求——请同意后重新开始。弹窗打开期间的首次录音可能为空。',
  'Voice: recording': '语音：录音中',
  'Voice: transcribing': '语音：转写中',
  'listening…': '聆听中…',
  'transcribing…': '转写中…',
  'Content generator configuration not available.': '内容生成器配置不可用',
  'Authentication type not available.': '认证类型不可用',
  'No models available for the current authentication type ({{authType}}).':
    '当前认证类型 ({{authType}}) 没有可用的模型',
  // Needs translation

  // ============================================================================
  // Commands - Clear
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    '正在开始新会话，重置聊天并清屏。',
  'Starting a new session and clearing.': '正在开始新会话并清屏。',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    '正在压缩中，请等待上一个请求完成',
  'Failed to compress chat history.': '压缩聊天历史失败',
  'Failed to compress chat history: {{error}}': '压缩聊天历史失败：{{error}}',
  'Compressing chat history': '正在压缩聊天历史',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    '聊天历史已从 {{originalTokens}} 个 token 压缩到 {{newTokens}} 个 token。',
  'Compression was not beneficial for this history size.':
    '对于此历史记录大小，压缩没有益处。',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    '聊天历史压缩未能减小大小。这可能表明压缩提示存在问题。',
  'Could not compress chat history due to a token counting error.':
    '由于 token 计数错误，无法压缩聊天历史。',
  // ============================================================================
  // Commands - Directory
  // ============================================================================
  'Configuration is not available.': '配置不可用。',
  'Please provide at least one path to add.': '请提供至少一个要添加的路径。',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    '/directory add 命令在限制性沙箱配置文件中不受支持。请改为在启动会话时使用 --include-directories。',
  "Error adding '{{path}}': {{error}}": "添加 '{{path}}' 时出错：{{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    '如果存在，已成功从以下目录添加 QWEN.md 文件：\n- {{directories}}',
  'Error refreshing memory: {{error}}': '刷新内存时出错：{{error}}',
  'Successfully added directories:\n- {{directories}}':
    '成功添加目录：\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    '当前工作区目录：\n{{directories}}',

  // ============================================================================
  // Commands - Docs
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    '请在浏览器中打开以下 URL 以查看文档：\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    '正在浏览器中打开文档：{{url}}',

  // ============================================================================
  // Dialogs - Tool Confirmation
  // ============================================================================
  'Do you want to proceed?': '是否继续？',
  'Yes, allow once': '是，允许一次',
  'Allow always': '总是允许',
  Yes: '是',
  No: '否',
  'No (esc)': '否 (esc)',
  'Modify in progress:': '正在修改：',
  'Save and close external editor to continue': '保存并关闭外部编辑器以继续',
  'Apply this change?': '是否应用此更改？',
  'Yes, allow always': '是，总是允许',
  'Modify with external editor': '使用外部编辑器修改',
  'No, suggest changes (esc)': '否，建议更改 (esc)',
  "Allow execution of: '{{command}}'?": "允许执行：'{{command}}'？",
  'Always allow in this project': '在本项目中总是允许',
  'Always allow {{action}} in this project': '在本项目中总是允许{{action}}',
  'Always allow for this user': '对该用户总是允许',
  'Always allow {{action}} for this user': '对该用户总是允许{{action}}',
  'Yes, restore previous mode ({{mode}})': '是，恢复之前的模式 ({{mode}})',
  'Yes, and auto-accept edits': '是，并自动接受编辑',
  'Yes, and manually approve edits': '是，并手动批准编辑',
  'No, keep planning (esc)': '否，继续规划 (esc)',
  'URLs to fetch:': '要获取的 URL：',
  'MCP Server: {{server}}': 'MCP Server：{{server}}',
  'Tool: {{tool}}': '工具：{{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    '允许执行来自 MCP server "{{server}}" 的 MCP tool "{{tool}}"？',
  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell 命令执行',
  'A custom command wants to run the following shell commands:':
    '自定义命令想要运行以下 shell 命令：',
  // ============================================================================
  // Dialogs - Welcome Back
  // ============================================================================
  'Current Plan:': '当前计划：',
  'Progress: {{done}}/{{total}} tasks completed':
    '进度：已完成 {{done}}/{{total}} 个任务',
  ', {{inProgress}} in progress': '，{{inProgress}} 个进行中',
  'Pending Tasks:': '待处理任务：',
  'What would you like to do?': '您想要做什么？',
  'Choose how to proceed with your session:': '选择如何继续您的会话：',
  'Start new chat session': '开始新的聊天会话',
  'Continue previous conversation': '继续之前的对话',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 欢迎回来！（最后更新：{{timeAgo}}）',
  '🎯 Overall Goal:': '🎯 总体目标：',
  'Connect a Provider': '连接服务商',
  'You must connect a provider to proceed. Press Ctrl+C again to exit.':
    '必须连接一个服务商才能继续。再次按 Ctrl+C 退出',
  'Terms of Services and Privacy Notice': '服务条款和隐私声明',
  'Qwen OAuth': 'Qwen OAuth (免费)',
  'Discontinued — switch to Coding Plan or API Key':
    '已停用 — 请切换到 Coding Plan 或 API Key',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Qwen OAuth 免费额度已于 2026-04-15 停用。请选择 Coding Plan 或 API Key。',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Qwen OAuth免费层已于2026-04-15停止服务。请选择其他提供商的模型或运行 /auth 切换。',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Qwen OAuth 免费额度已于 2026-04-15 停用。请选择其他选项。\n',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    '付费 \u00B7 每 5 小时最多 6,000 次请求 \u00B7 支持阿里云百炼 Coding Plan 全部模型',
  'For teams \u00B7 Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    '适合团队 \u00B7 付费 \u00B7 每 5 小时最多 6,000 次请求 \u00B7 支持阿里云百炼 Coding Plan 全部模型',
  'For individual developers \u00B7 Pay per model call \u00B7 5-hour/weekly quotas':
    '适合个人开发场景 \u00B7 按模型调用次数计费 \u00B7 每 5 小时/每周限额',
  Subscribe: '订阅计划',
  'Paid subscription plans from Alibaba Cloud ModelStudio':
    'Alibaba Cloud ModelStudio 付费订阅计划',
  'Select Subscription Plan': '选择订阅计划',
  'Alibaba Cloud Coding Plan': '阿里云百炼 Coding Plan',
  'Alibaba Cloud Token Plan': '阿里云百炼 Token Plan',
  'Pay-as-you-go tokens \u00B7 Configure ModelStudio standard API key':
    '按 Token 付费 \u00B7 配置 ModelStudio 标准 API Key',
  'For individuals \u00B7 Pay-as-you-go tokens \u00B7 Dedicated Token Plan endpoint':
    '适合个人 \u00B7 按 Token 付费 \u00B7 使用独立 Token Plan Endpoint',
  'For teams/companies \u00B7 Credits deducted by token usage \u00B7 Dedicated API key and base URL':
    '适合一人公司/团队/企业 \u00B7 按 Token 消耗抵扣 Credits \u00B7 专属 API Key 和 Base URL',
  'Token Plan documentation': 'Token Plan 参考文档',
  'Bring your own API key': '使用自己的 API Key',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    '基于浏览器的第三方提供商认证（例如 OpenRouter、ModelScope）',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    '认证方式被强制设置为 {{enforcedType}}，但您当前使用的是 {{currentType}}',
  'Qwen OAuth Authentication': 'Qwen OAuth 认证',
  'Please visit this URL to authorize:': '请访问此 URL 进行授权：',
  'Waiting for authorization': '等待授权中',
  'Time remaining:': '剩余时间：',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth 认证超时',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth token 已过期（超过 {{seconds}} 秒）。请重新选择认证方法',
  'Press any key to return to authentication type selection.':
    '按任意键返回认证类型选择',
  'Waiting for Qwen OAuth authentication...': '正在等待 Qwen OAuth 认证...',
  'Authentication timed out. Please try again.': '认证超时。请重试。',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    '正在等待认证...（按 ESC 或 CTRL+C 取消）',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容认证的 API Key。请设置 settings.security.auth.apiKey 或设置 {{envKeyHint}} 环境变量。',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 环境变量。请在 .env 文件或系统环境变量中进行设置。',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 环境变量（或设置 settings.security.auth.apiKey）。请在 .env 文件或系统环境变量中进行设置。',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容认证的 API Key。请设置 {{envKeyHint}} 环境变量。',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Anthropic 提供商缺少必需的 baseUrl，请在 modelProviders[].baseUrl 中配置。',
  'ANTHROPIC_BASE_URL environment variable not found.':
    '未找到 ANTHROPIC_BASE_URL 环境变量。',
  'Invalid auth method selected.': '选择了无效的认证方式。',
  'Failed to authenticate. Message: {{message}}': '认证失败。消息：{{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    '使用 {{authType}} 凭据成功认证。',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    '无效的 QWEN_DEFAULT_AUTH_TYPE 值："{{value}}"。有效值为：{{validValues}}',
  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': '选择模型',
  'API Key': 'API Key',
  '(default)': '(默认)',
  '(not set)': '(未设置)',
  Modality: '模态',
  'Context Window': '上下文窗口',
  text: '文本',
  'text-only': '纯文本',
  image: '图像',
  pdf: 'PDF',
  audio: '音频',
  video: '视频',
  'not set': '未设置',
  'Current voice model: {{voiceModel}}\nUse "/model --voice <model-id>" to set voice model.':
    '当前语音模型：{{voiceModel}}\n使用 "/model --voice <model-id>" 设置语音模型。',
  "Voice model '{{modelName}}' is ambiguous. Configure a unique model id before using /model --voice.":
    "语音模型 '{{modelName}}' 不唯一。请先配置唯一的模型 ID，再使用 /model --voice。",
  none: '无',
  unknown: '未知',
  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': '管理文件夹信任设置',
  'Manage permission rules': '管理 permission rules',
  Allow: '允许',
  Ask: '询问',
  Deny: '拒绝',
  Workspace: '工作区',
  "Qwen Code won't ask before using allowed tools.":
    'Qwen Code 使用已允许的工具前不会询问。',
  'Qwen Code will ask before using these tools.':
    'Qwen Code 使用这些工具前会先询问。',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code 不允许使用被拒绝的工具。',
  'Manage trusted directories for this workspace.':
    '管理此工作区的受信任目录。',
  'Any use of the {{tool}} tool': '{{tool}} 工具的任何使用',
  "{{tool}} commands matching '{{pattern}}'":
    "匹配 '{{pattern}}' 的 {{tool}} 命令",
  'From user settings': '来自用户设置',
  'From project settings': '来自项目设置',
  'From session': '来自会话',
  'Project settings': '项目设置',
  'Checked in at .qwen/settings.json': '保存在 .qwen/settings.json',
  'User settings': '用户设置',
  'Saved in at ~/.qwen/settings.json': '保存在 ~/.qwen/settings.json',
  'Add a new rule…': '添加新规则…',
  'Add {{type}} permission rule': '添加 {{type}} permission rule',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'permission rules 是工具名称，可选地后跟括号中的限定符。',
  'e.g.,': '例如',
  or: '或',
  'Enter permission rule…': '输入 permission rule…',
  'Enter to submit · Esc to cancel': 'Enter 提交 · Esc 取消',
  'Where should this rule be saved?': '此规则应保存在哪里？',
  'Enter to confirm · Esc to cancel': 'Enter 确认 · Esc 取消',
  'Delete {{type}} rule?': '删除{{type}}规则？',
  'Are you sure you want to delete this permission rule?':
    '确定要删除此 permission rule 吗？',
  'Permissions:': '权限：',
  '(←/→ or tab to cycle)': '（←/→ 或 Tab 切换）',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    '按 ↑↓ 导航 · Enter 选择 · 输入搜索 · Esc 取消',
  'Search…': '搜索…',
  // Workspace directory management
  'Add directory…': '添加目录…',
  'Add directory to workspace': '添加工作区目录',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code 可以读取工作区中的文件，并在自动接受编辑模式开启时进行编辑。',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code 将能够读取此目录中的文件，并在自动接受编辑模式开启时进行编辑。',
  'Enter the path to the directory:': '输入目录路径：',
  'Enter directory path…': '输入目录路径…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab 补全 · Enter 添加 · Esc 取消',
  'Remove directory?': '删除目录？',
  'Are you sure you want to remove this directory from the workspace?':
    '确定要将此目录从工作区中移除吗？',
  '  (Original working directory)': '  （原始工作目录）',
  '  (from settings)': '  （来自设置）',
  'Directory does not exist.': '目录不存在。',
  'Path is not a directory.': '路径不是目录。',
  'This directory is already in the workspace.': '此目录已在工作区中。',
  'Already covered by existing directory: {{dir}}': '已被现有目录覆盖：{{dir}}',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': '已加载: ',
  '{{count}} open file': '{{count}} 个打开的文件',
  '{{count}} open files': '{{count}} 个打开的文件',
  '(ctrl+g to view)': '（按 ctrl+g 查看）',
  '{{count}} {{name}} file': '{{count}} 个 {{name}} 文件',
  '{{count}} {{name}} files': '{{count}} 个 {{name}} 文件',
  '{{count}} MCP server': '{{count}} 个 MCP server',
  '{{count}} MCP servers': '{{count}} 个 MCP servers',
  '{{count}} Blocked': '{{count}} 个已阻止',
  '(ctrl+t to view)': '（按 ctrl+t 查看）',
  '(ctrl+t to toggle)': '（按 ctrl+t 切换）',
  'Press Ctrl+C again to exit.': '再次按 Ctrl+C 退出',
  'Press Ctrl+D again to exit.': '再次按 Ctrl+D 退出',
  'Press Esc again to clear.': '再次按 Esc 清除',
  'Press ↑ to edit queued messages': '按 ↑ 编辑排队消息',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': '未配置 MCP servers',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers 正在启动（{{count}} 个正在初始化）...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    '注意：首次启动可能需要更长时间。工具可用性将自动更新',
  'Configured MCP servers:': '已配置的 MCP servers：',
  Ready: '就绪',
  'Starting... (first startup may take longer)':
    '正在启动...（首次启动可能需要更长时间）',
  Disconnected: '已断开连接',
  '{{count}} tool': '{{count}} 个工具',
  '{{count}} tools': '{{count}} 个工具',
  '{{count}} prompt': '{{count}} 个提示',
  '{{count}} prompts': '{{count}} 个提示',
  '(from {{extensionName}})': '（来自 {{extensionName}}）',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth 已过期',
  'OAuth not authenticated': 'OAuth 未认证',
  'tools and prompts will appear when ready': '工具和提示将在就绪时显示',
  '{{count}} tools cached': '{{count}} 个工具已缓存',
  'Tools:': '工具：',
  'Parameters:': '参数：',
  'Prompts:': '提示：',
  'Resources:': '资源：',
  Blocked: '已阻止',
  '💡 Tips:': '💡 提示：',
  Use: '使用',
  'to show server and tool descriptions': '显示服务器和工具描述',
  'to show tool parameter schemas': '显示 tool parameter schemas',
  'to hide descriptions': '隐藏描述',
  'to authenticate with OAuth-enabled servers':
    '使用支持 OAuth 的服务器进行认证',
  Press: '按',
  'to toggle tool descriptions on/off': '切换工具描述开关',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "正在为 MCP server '{{name}}' 启动 OAuth 认证...",
  // ============================================================================
  // Startup Tips
  // ============================================================================
  'Tips:': '提示：',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    '对话变长时用 /compress，总结历史并释放上下文。',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    '用 /clear 或 /new 开启新思路；之前的会话会保留在历史记录中。',
  'Use /bug to submit issues to the maintainers when something goes off.':
    '遇到问题时，用 /bug 将问题提交给维护者。',
  'Switch auth type quickly with /auth.': '用 /auth 快速切换认证方式。',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    '在 Qwen Code 中使用 ! 可运行任意 shell 命令（例如 !ls）。',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    '输入 / 打开命令弹窗；按 Tab 自动补全斜杠命令和保存的提示词。',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    '运行 qwen --continue 或 qwen --resume 可继续之前的会话。',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    '按 Shift+Tab 或输入 /approval-mode 可快速切换权限模式。',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    '按 Tab 或输入 /approval-mode 可快速切换权限模式。',
  'Try /insight to generate personalized insights from your chat history.':
    '试试 /insight，从聊天记录中生成个性化洞察。',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    '按 Ctrl+O 切换紧凑模式 ── 隐藏工具输出和思考过程，界面更简洁。',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    '添加 QWEN.md 文件，为 Qwen Code 提供持久的项目上下文。',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    '用 /btw 快速问一个小问题，不会打断当前对话。',
  'Context is almost full! Run /compress now or start /new to continue.':
    '上下文即将用满！请立即执行 /compress 或使用 /new 开启新会话。',
  'Context is getting full. Use /compress to free up space.':
    '上下文空间不足，用 /compress 释放空间。',
  'Long conversation? /compress summarizes history to free context.':
    '对话太长？用 /compress 总结历史，释放上下文。',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    '显示上下文窗口使用情况明细。使用 "/context detail" 查看逐项明细。',

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'Qwen Code 正在关闭，再见！',
  'To continue this session, run': '要继续此会话，请运行',
  'Interaction Summary': '交互摘要',
  'Session ID:': '会话 ID：',
  'Tool Calls:': '工具调用：',
  'Success Rate:': '成功率：',
  'User Agreement:': '用户同意率：',
  reviewed: '已审核',
  'Code Changes:': '代码变更：',
  Performance: '性能',
  'Wall Time:': '总耗时：',
  'Agent Active:': '智能体活跃时间：',
  'API Time:': 'API 时间：',
  'Tool Time:': '工具时间：',
  'Session Stats': '会话统计',
  'Model Usage': '模型使用情况',
  'Input Tokens': '输入 token 数',
  'Output Tokens': '输出 token 数',
  'Savings Highlight:': '节省亮点：',
  'of input tokens were served from the cache, reducing costs.':
    '从缓存载入 token ，降低了成本',
  'Tip: For a full token breakdown, run `/stats model`.':
    '提示：要查看完整的 token 明细，请运行 `/stats model`',
  'Model Stats For Nerds': '模型统计（技术细节）',
  'Tool Stats For Nerds': '工具统计（技术细节）',
  Metric: '指标',
  API: 'API',
  Session: '会话',
  Activity: '概览',
  Efficiency: '性能',
  Success: '成功率',
  Today: '今天',
  'Token Trend': 'Token 趋势',
  'Cache Hit Rate': '缓存命中率',
  'Tool Success': '工具成功率',
  'Tool Leaderboard': '工具排行',
  Calls: '调用次数',
  Time: '耗时',
  Reqs: '请求',
  Cache: '缓存',
  Latency: '延迟',
  'In/Out': '输入/输出',
  'Code Impact': '代码变更',
  'Failed to load stats. Press r to retry.': '加载统计失败，按 r 重试。',
  net: '净增',
  streak: '连续',
  best: '最长',
  Requests: '请求数',
  Errors: '错误数',
  'Avg Latency': '平均延迟',
  Tokens: 'Token',
  Total: '总计',
  Prompt: '提示',
  Cached: '缓存',
  Thoughts: '思考',
  Output: '输出',
  'No API calls have been made in this session.':
    '本次会话中未进行任何 API 调用',
  'Tool Name': '工具名称',
  'Success Rate': '成功率',
  'Avg Duration': '平均耗时',
  'User Decision Summary': '用户决策摘要',
  'Total Reviewed Suggestions:': '已审核建议总数：',
  ' » Accepted:': ' » 已接受：',
  ' » Rejected:': ' » 已拒绝：',
  ' » Modified:': ' » 已修改：',
  ' Overall Agreement Rate:': ' 总体同意率：',
  'No tool calls have been made in this session.':
    '本次会话中未进行任何工具调用',
  'Session start time is unavailable, cannot calculate stats.':
    '会话开始时间不可用，无法计算统计信息',

  // ============================================================================
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': '命令格式迁移',
  'Found {{count}} TOML command file:': '发现 {{count}} 个 TOML 命令文件：',
  'Found {{count}} TOML command files:': '发现 {{count}} 个 TOML 命令文件：',
  'Current tasks': '当前任务',
  '... and {{count}} more': '... 以及其他 {{count}} 个',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'TOML 格式已弃用。是否将它们迁移到 Markdown 格式？',
  '(Backups will be created and original files will be preserved)':
    '（将创建备份，原始文件将保留）',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': '等待用户确认...',
  WITTY_LOADING_PHRASES: [
    // --- 职场搬砖系列 ---
    '正在努力搬砖，请稍候...',
    '老板在身后，快加载啊！',
    '头发掉光前，一定能加载完...',
    '服务器正在深呼吸，准备放大招...',
    '正在向服务器投喂咖啡...',

    // --- 大厂黑话系列 ---
    '正在赋能全链路，寻找关键抓手...',
    '正在降本增效，优化加载路径...',
    '正在打破部门壁垒，沉淀方法论...',
    '正在拥抱变化，迭代核心价值...',
    '正在对齐颗粒度，打磨底层逻辑...',
    '大力出奇迹，正在强行加载...',

    // --- 程序员自嘲系列 ---
    '只要我不写代码，代码就没有 Bug...',
    '正在把 Bug 转化为 Feature...',
    '只要我不尴尬，Bug 就追不上我...',
    '正在试图理解去年的自己写了什么...',
    '正在猿力觉醒中，请耐心等待...',

    // --- 合作愉快系列 ---
    '正在询问产品经理：这需求是真的吗？',
    '正在给产品经理画饼，请稍等...',

    // --- 温暖治愈系列 ---
    '每一行代码，都在努力让世界变得更好一点点...',
    '每一个伟大的想法，都值得这份耐心的等待...',
    '别急，美好的事物总是需要一点时间去酝酿...',
    '愿你的代码永无 Bug，愿你的梦想终将成真...',
    '哪怕只有 0.1% 的进度，也是在向目标靠近...',
    '加载的是字节，承载的是对技术的热爱...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': '请输入值...',
  'Enter sensitive value...': '请输入敏感值...',
  'Press Enter to submit, Escape to cancel': '按 Enter 提交，Escape 取消',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Markdown 文件已存在：{{filename}}',
  'TOML Command Format Deprecation Notice': 'TOML 命令格式弃用通知',
  'Found {{count}} command file(s) in TOML format:':
    '发现 {{count}} 个 TOML 格式的命令文件：',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    '命令的 TOML 格式正在被弃用，推荐使用 Markdown 格式。',
  'Markdown format is more readable and easier to edit.':
    'Markdown 格式更易读、更易编辑。',
  'You can migrate these files automatically using:':
    '您可以使用以下命令自动迁移这些文件：',
  'Or manually convert each file:': '或手动转换每个文件：',
  'TOML: prompt = "..." / description = "..."':
    'TOML：prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content': 'Markdown：YAML frontmatter + 内容',
  'The migration tool will:': '迁移工具将：',
  'Convert TOML files to Markdown': '将 TOML 文件转换为 Markdown',
  'Create backups of original files': '创建原始文件的备份',
  'Preserve all command functionality': '保留所有命令功能',
  'TOML format will continue to work for now, but migration is recommended.':
    'TOML 格式目前仍可使用，但建议迁移。',

  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser': '在浏览器中打开扩展市场页面',
  'Unknown extensions source: {{source}}.': '未知的扩展来源：{{source}}。',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    '将在浏览器中打开扩展页面：{{url}}（测试环境中已跳过）',
  'View available extensions at {{url}}': '在 {{url}} 查看可用扩展',
  'Opening extensions page in your browser: {{url}}':
    '正在浏览器中打开扩展页面：{{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    '打开浏览器失败。请访问扩展市场：{{url}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    '将于 {{seconds}} 秒后重试…（第 {{attempt}}/{{maxRetries}} 次）',
  'Press Ctrl+Y to retry': '按 Ctrl+Y 重试。',
  'No failed request to retry.': '没有可重试的失败请求。',
  'to retry last request': '重试上一次请求',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'API Key 不能为空。',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    '无效的 API Key。Coding Plan API Key 以 "sk-sp-" 开头，请检查。',
  'You can get your Coding Plan API key here':
    '您可以在这里获取 Coding Plan API Key',
  'You can get your Token Plan API key here':
    '您可以在这里获取 Token Plan API Key',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'API Key 已存储在 settings.env 中。您可以将其迁移到 .env 文件以获得更好的安全性。',
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    '阿里云百炼 Coding Plan 有新模型配置可用。是否立即更新？',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan 配置更新成功。新模型现已可用。',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    '未找到 Coding Plan API Key。请重新通过 Coding Plan 认证。',
  'Failed to update Coding Plan configuration: {{message}}':
    '更新 Coding Plan 配置失败：{{message}}',

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    '您可以在 settings.json 中配置 API Key 和模型',
  'Refer to the documentation for setup instructions': '请参考文档了解配置说明',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  Custom: '自定义',
  'Select Region for Coding Plan': '选择 Coding Plan 区域',
  'Choose based on where your account is registered':
    '请根据您的账号注册地区选择',
  'Enter Coding Plan API Key': '输入 Coding Plan API Key',
  'Enter Token Plan API Key': '输入 Token Plan API Key',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    '{{region}} 有新的模型配置可用。是否立即更新？',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}} 配置更新成功。模型已切换至 "{{model}}"。',
  // ============================================================================
  // Context Usage
  // ============================================================================
  'Context Usage': '上下文使用情况',
  '% used': '% 已用',
  '% context used': '% 上下文已用',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    '上下文超出限制！请使用 /compress 或 /clear 来减少上下文。',
  'Context window': '上下文窗口',
  Used: '已用',
  Free: '空闲',
  'Autocompact buffer': '自动压缩缓冲区',
  'Usage by category': '分类用量',
  'System prompt': '系统提示',
  'Built-in tools': '内置工具',
  'MCP tools': 'MCP tools',
  'Memory files': '记忆文件',
  Skills: '技能',
  Messages: '消息',
  tokens: 'tokens',
  'Estimated pre-conversation overhead': '预估对话前开销',
  'No API response yet. Send a message to see actual usage.':
    '暂无 API 响应。发送消息以查看实际使用情况。',
  'Run /context detail for per-item breakdown.':
    '运行 /context detail 查看详细分解。',
  'body loaded': '内容已加载',
  memory: '记忆',
  '{{region}} configuration updated successfully.': '{{region}} 配置更新成功。',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    '成功通过 {{region}} 认证。API Key 和模型配置已保存至 settings.json。',
  'Tip: Use /model to switch between available Coding Plan models.':
    '提示：使用 /model 切换可用的 Coding Plan 模型。',
  'Type something...': '输入内容...',
  Submit: '提交',
  'Submit answers': '提交答案',
  Cancel: '取消',
  'Your answers:': '您的答案：',
  '(not answered)': '(未回答)',
  'Ready to submit your answers?': '准备好提交您的答案了吗？',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: 导航 | ←/→: 切换标签页 | Enter: 选择',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: 导航 | Enter: 选择 | Esc: 取消',
  'Authenticate using Qwen OAuth': '使用 Qwen OAuth 进行认证',
  'Authenticate using Alibaba Cloud Coding Plan':
    '使用阿里云百炼 Coding Plan 进行认证',
  'Region for Coding Plan (china/global)': 'Coding Plan 区域 (china/global)',
  'API key for Coding Plan': 'Coding Plan 的 API Key',
  'Show current authentication status': '显示当前认证状态',
  'Authentication completed successfully.': '认证完成。',
  'Starting Qwen OAuth authentication...': '正在启动 Qwen OAuth 认证...',
  'Successfully authenticated with Qwen OAuth.': '已成功通过 Qwen OAuth 认证。',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Qwen OAuth 认证失败：{{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    '正在处理阿里云百炼 Coding Plan 认证...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    '已成功通过阿里云百炼 Coding Plan 认证。',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Coding Plan 认证失败：{{error}}',
  Global: '全球',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': '选择 Coding Plan 区域：',
  'Enter your Coding Plan API key: ': '请输入您的 Coding Plan API Key：',
  'Select authentication method:': '选择认证方式：',
  '\n=== Authentication Status ===\n': '\n=== 认证状态 ===\n',
  '⚠️  No authentication method configured.\n': '⚠️  未配置认证方式。\n',
  'Run one of the following commands to get started:\n':
    '运行以下命令之一开始配置：\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - 使用 Qwen OAuth 登录（已停用）',
  'Or simply run:': '或者直接运行：',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - 交互式认证配置\n',
  '✓ Authentication Method: Qwen OAuth': '✓ 认证方式：Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  类型：免费额度（2026-04-15 已停用）',
  '  Limit: No longer available': '  限额：已不可用',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Qwen OAuth 免费额度已于 2026-04-15 停用。请运行 /auth 切换到 Coding Plan、OpenRouter、Fireworks AI 或其他服务商。',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ 认证方式：阿里云百炼 Coding Plan',
  'Global - Alibaba Cloud': '全球 - Alibaba Cloud',
  '  Region: {{region}}': '  区域：{{region}}',
  '  Current Model: {{model}}': '  当前模型：{{model}}',
  '  Config Version: {{version}}': '  配置版本：{{version}}',
  '  Status: API key configured\n': '  状态：API Key 已配置\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  认证方式：阿里云百炼 Coding Plan（不完整）',
  '  Issue: API key not found in environment or settings\n':
    '  问题：在环境变量或设置中未找到 API Key\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  运行 `qwen auth coding-plan` 重新配置。\n',
  '✓ Authentication Method: {{type}}': '✓ 认证方式：{{type}}',
  '  Status: Configured\n': '  状态：已配置\n',
  'Failed to check authentication status: {{error}}':
    '检查认证状态失败：{{error}}',
  'Select an option:': '请选择：',
  'Raw mode not available. Please run in an interactive terminal.':
    '原始模式不可用。请在交互式终端中运行。',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(使用 ↑ ↓ 箭头导航，Enter 选择，Ctrl+C 退出)\n',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    '紧凑模式下隐藏工具输出和思考过程，界面更简洁（Ctrl+O 切换）。',
  'Press Ctrl+O to show full tool output': '按 Ctrl+O 查看详细工具调用结果',
  'Switch to plan mode or exit plan mode': '切换到计划模式或退出计划模式',
  'Set a goal — keep working until the condition is met':
    '设定目标 — 持续工作直到条件满足',
  'Exited plan mode. Previous approval mode restored.':
    '已退出计划模式，已恢复之前的审批模式。',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    '启用计划模式。智能体将只分析和规划，而不执行工具。',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    '已处于计划模式。使用 "/plan exit" 退出计划模式。',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    '未处于计划模式。请先使用 "/plan" 进入计划模式。',
  "Set up Qwen Code's status line UI": '配置 Qwen Code 的状态栏',

  // === Core: added from PR #3328 ===
  'Ask a quick side question without affecting the main conversation':
    '在不影响主对话的情况下快速问一个旁支问题',
  'Manage Arena sessions': '管理 Arena 会话',
  'Start an Arena session with multiple models competing on the same task':
    '启动一个 Arena 会话，让多个模型在同一任务上竞争',
  'Stop the current Arena session': '停止当前 Arena 会话',
  'Show the current Arena session status': '显示当前 Arena 会话状态',
  'Select a model result and merge its diff into the current workspace':
    '选择一个模型结果并将其差异合并到当前工作区',
  'No running Arena session found.': '未找到正在运行的 Arena 会话。',
  'No Arena session found. Start one with /arena start.':
    '未找到 Arena 会话。请使用 /arena start 启动一个。',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Arena 会话仍在运行中。请等待其完成，或先使用 /arena stop。',
  'No successful agent results to select from. All agents failed or were cancelled.':
    '没有可选择的成功智能体结果。所有智能体均失败或被取消。',
  'Use /arena stop to end the session.': '使用 /arena stop 结束会话。',
  'No idle agent found matching "{{name}}".':
    '未找到匹配 "{{name}}" 的空闲智能体。',
  'Failed to apply changes from {{label}}: {{error}}':
    '从 {{label}} 应用更改失败：{{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    '已将 {{label}} 的更改应用到工作区。Arena 会话完成。',
  'Discard all Arena results and clean up worktrees?':
    '丢弃所有 Arena 结果并清理工作树？',
  'Arena results discarded. All worktrees cleaned up.':
    'Arena 结果已丢弃。所有工作树已清理。',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena 不支持非交互模式。请使用交互模式启动 Arena 会话。',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena 不支持非交互模式。请使用交互模式停止 Arena 会话。',
  'Arena is not supported in non-interactive mode.': 'Arena 不支持非交互模式。',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    '已存在 Arena 会话。请使用 /arena stop 或 /arena select 结束后再启动新会话。',
  'Usage: /arena start --models model1,model2 <task>':
    '用法：/arena start --models model1,model2 <task>',
  'Models to compete (required, at least 2)':
    '参与竞争的模型（必须，至少 2 个）',
  'Format: authType:modelId or just modelId':
    '格式：authType:modelId 或仅 modelId',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena 至少需要 2 个模型。请使用 --models model1,model2 指定。',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena 已启动 {{count}} 个智能体处理任务："{{task}}"\n模型：\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Arena 面板正在 tmux 中运行。使用以下命令附加：`{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] 失败：{{error}}',
  'Loading suggestions...': '正在加载建议...',
  'Open the memory manager.': '打开记忆管理器。',
  'Show current process memory diagnostics': '显示当前进程的内存诊断。',
  'Record a CPU profile for Chrome DevTools analysis':
    '录制 CPU 性能分析文件，用于 Chrome DevTools 分析',
  'Roll back a standalone update to the previous version':
    '将独立安装回滚到上一个版本',
  'Rollback is not available in ACP mode.': '回滚在 ACP 模式下不可用。',
  'Rollback is only available for standalone installations.':
    '回滚仅适用于独立安装。',
  'Rollback successful. Restart your terminal to use the previous version.':
    '回滚成功。请重启终端以使用上一个版本。',
  'Rollback failed:': '回滚失败：',
  'Rollback on Windows requires manual intervention. Rename qwen-code.old to qwen-code in your installation directory.':
    '在 Windows 上回滚需要手动操作。请将安装目录中的 qwen-code.old 重命名为 qwen-code。',
  'Save a durable memory to the memory system.':
    '将一条持久记忆保存到记忆系统。',
  'Show per-item context usage breakdown.': '显示按项目划分的上下文使用详情。',
  'Manage extension settings': '管理扩展设置',

  // === Core: added from PR #3328 ===
  'Background tasks': '后台任务',
  'No tasks currently running': '当前没有正在运行的任务',
  'No entry to show.': '没有可显示的条目。',
  'needs approval': '待审批',
  'Background agent needs approval': '后台 agent 等待审批',
  'Approve or deny the request above': '请批准或拒绝上方的请求',
  Running: '运行中',
  Paused: '已暂停',
  Completed: '已完成',
  Failed: '失败',
  Stopped: '已停止',
  Shell: 'Shell',
  Monitor: '监控',
  Command: '命令',
  Dream: '记忆整理',
  '[dream] memory consolidation': '[记忆整理] 记忆整理',
  '[dream] memory consolidation (reviewing {{count}} session)':
    '[记忆整理] 记忆整理（正在审阅 {{count}} 个会话）',
  '[dream] memory consolidation (reviewing {{count}} sessions)':
    '[记忆整理] 记忆整理（正在审阅 {{count}} 个会话）',
  '{{count}} session': '{{count}} 个会话',
  '{{count}} sessions': '{{count}} 个会话',
  '{{count}} topic': '{{count}} 个主题',
  '{{count}} topics': '{{count}} 个主题',
  '{{count}} tokens': '{{count}} tokens',
  '{{count}} tool call': '{{count}} 个工具调用',
  '{{count}} tool calls': '{{count}} 个工具调用',
  '{{count}} event': '{{count}} 个事件',
  '{{count}} events': '{{count}} 个事件',
  '{{count}} dropped': '丢弃 {{count}} 行',
  'pid {{pid}}': 'pid {{pid}}',
  'exit {{exitCode}}': '退出码 {{exitCode}}',
  'Sessions reviewing': '正在审阅的会话',
  Progress: '进度',
  'Resume blocked': '恢复受阻',
  'Working dir': '工作目录',
  'Output file': '输出文件',
  'Topics touched ({{count}})': '触及的主题（{{count}}）',
  '{{count}} more': '{{count}} 个',
  'Lock release warning': '锁释放警告',
  'Metadata write warning': '元数据写入警告',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    '后续记忆整理可能会因锁定而跳过，直到下一次会话过期清理清除此文件。',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    '调度门控未看到本次记忆整理的时间戳；下一轮记忆整理可能会比平时更早重新触发。',

  // ============================================================================
  // Stats
  // ============================================================================

  // statsCommand non-interactive output
  'Session duration: {{duration}}': '会话时长：{{duration}}',
  'Prompts: {{count}}': '提示次数：{{count}}',
  'API requests: {{count}}': 'API 请求数：{{count}}',
  'Tokens — prompt: {{prompt}}, output: {{output}}':
    'Tokens — 输入：{{prompt}}，输出：{{output}}',
  'Tool calls: {{total}} ({{success}} ok, {{fail}} fail)':
    '工具调用：{{total}}（{{success}} 成功，{{fail}} 失败）',
  'Files: +{{added}} / -{{removed}} lines':
    '文件：+{{added}} / -{{removed}} 行',
  prompt: '输入',
  output: '输出',
  cached: '缓存',
  'Estimated cost: ${{cost}}': '预估费用：${{cost}}',
  'No model usage data yet.': '暂无模型使用数据。',
  'No tool usage data yet.': '暂无工具使用数据。',

  // StatsDialog
  Models: '模型',
  'All time': '所有时间',
  'Last 7 days': '最近 7 天',
  'Last 30 days': '最近 30 天',
  'N/A': '无',
  Sessions: '会话数',
  days: '天',
  Input: '输入',
  'Tool calls': '工具调用',
  'Code changes': '代码变更',
  Projects: '项目统计',
  Name: '名称',
  Duration: '时长',
  'Activity Heatmap': '用量热力统计',
  'Loading stats...': '加载统计数据...',
  '\u2191 tabs \u00b7 r to cycle dates \u00b7 esc to close':
    '\u2191 tab 切换标签 \u00b7 r 切换时间范围 \u00b7 esc 关闭',
  Cost: '费用',
  Less: '少',
  More: '多',
  '(no data)': '（无数据）',
  d: '天',
  h: '时',
  m: '分',

  // Stats Dashboard — keyboard hints (not translated)
  'tab \xB7 esc': 'tab \xB7 esc',
  'tab \xB7 r dates \xB7 \u2190\u2192 month \xB7 esc':
    'tab \xB7 r dates \xB7 \u2190\u2192 month \xB7 esc',
  'tab \xB7 r dates \xB7 esc': 'tab \xB7 r dates \xB7 esc',

  // Stats Dashboard — missing labels
  'API Requests': 'API 请求',
  'Tool Calls': '工具调用',
  'Success rate': '成功率',
  'Code Changes': '代码变更',
  Tool: '工具',
  reqs: '请求',
  in: '输入',
  out: '输出',

  // === History collapse/expand commands ===
  'Set history to collapse by default when resuming a session':
    '恢复会话时默认折叠历史记录',
  'Set history to expand by default when resuming a session':
    '恢复会话时默认展开历史记录',
  'Expand the currently collapsed history transcript': '展开当前折叠的历史记录',
  'Control history display preferences and visibility':
    '控制历史记录显示偏好和可见性',
  'History will be collapsed by default for future resumed sessions.':
    '未来恢复的会话将默认折叠历史记录。',
  'History will be expanded by default for future resumed sessions.':
    '未来恢复的会话将默认展开历史记录。',
  'History is already expanded in this session.': '当前会话的历史记录已展开。',
  'Usage: /history collapse-on-resume|expand-on-resume|expand-now':
    '用法：/history collapse-on-resume|expand-on-resume|expand-now',
  'History collapsed: {{n}} messages hidden. Use /history expand-now to show.':
    '历史记录已折叠：{{n}} 条消息已隐藏。使用 /history expand-now 展开。',

  // === Same-as-English optimization ===
  ' (not in model registry)': '（不在模型注册表中）',
  'start server': '启动服务器',
  '中国 (China)': '中国',
  '中国 (China) - 阿里云百炼': '中国 - 阿里云百炼',
  '阿里云百炼 (aliyun.com)': '阿里云百炼（aliyun.com）',
  'No compression needed.': '无需压缩。',
};
