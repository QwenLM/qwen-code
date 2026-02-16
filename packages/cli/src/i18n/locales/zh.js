/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Chinese translations for Qwen Code CLI

export default {
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  'Basics:': '基础功能：',
  'Add context': '添加上下文',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    '使用 {{symbol}} 指定文件作为上下文（例如，{{example}}），用于定位特定文件或文件夹',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Shell 模式',
  'YOLO mode': 'YOLO 模式',
  'plan mode': '规划模式',
  'auto-accept edits': '自动接受编辑',
  'Accepting edits': '接受编辑',
  '(shift + tab to cycle)': '(shift + tab 切换)',
  '(tab to cycle)': '(按 tab 切换)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    '通过 {{symbol}} 执行 shell 命令（例如，{{example1}}）或使用自然语言（例如，{{example2}}）',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'start server',
  'Commands:': '命令:',
  'shell command': 'shell 命令',
  'Model Context Protocol command (from external servers)':
    '模型上下文协议命令（来自外部服务器）',
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
    '正在连接到 MCP 服务器... ({{connected}}/{{total}})',
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
  'submit a bug report': '提交错误报告',
  'About Qwen Code': '关于 Qwen Code',
  Status: '状态',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: '运行环境',
  OS: '操作系统',
  Auth: '认证',
  'CLI Version': 'CLI 版本',
  'Git Commit': 'Git 提交',
  Model: '模型',
  Sandbox: '沙箱',
  'OS Platform': '操作系统平台',
  'OS Arch': '操作系统架构',
  'OS Release': '操作系统版本',
  'Node.js Version': 'Node.js 版本',
  'NPM Version': 'NPM 版本',
  'Session ID': '会话 ID',
  'Auth Method': '认证方式',
  'Base URL': '基础 URL',
  Proxy: '代理',
  'Memory Usage': '内存使用',
  'IDE Client': 'IDE 客户端',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    '分析项目并创建定制的 QWEN.md 文件',
  'list available Qwen Code tools. Usage: /tools [desc]':
    '列出可用的 Qwen Code 工具。用法：/tools [desc]',
  'Available Qwen Code CLI tools:': '可用的 Qwen Code CLI 工具：',
  'No tools available': '没有可用工具',
  'View or change the approval mode for tool usage':
    '查看或更改工具使用的审批模式',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    '无效的审批模式 "{{arg}}"。有效模式：{{modes}}',
  'Approval mode set to "{{mode}}"': '审批模式已设置为 "{{mode}}"',
  'View or change the language setting': '查看或更改语言设置',
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
    '通过用摘要替换来压缩上下文',
  'open full Qwen Code documentation in your browser':
    '在浏览器中打开完整的 Qwen Code 文档',
  'Configuration not available.': '配置不可用',
  'change the auth method': '更改认证方法',
  'Configure authentication information for login': '配置登录认证信息',
  'Copy the last result or code snippet to clipboard':
    '将最后的结果或代码片段复制到剪贴板',

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
  'All tools selected, including MCP tools': '已选择所有工具，包括 MCP 工具',
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
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': '查看和编辑 Qwen Code 设置',
  Settings: '设置',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '要查看更改，必须重启 Qwen Code。按 r 退出并立即应用更改。',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    '不支持在非交互模式下使用命令 "/{{command}}"。',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim 模式',
  'Disable Auto Update': '禁用自动更新',
  'Attribution: commit': '署名：提交',
  'Terminal Bell Notification': '终端响铃通知',
  'Enable Usage Statistics': '启用使用统计',
  Theme: '主题',
  'Preferred Editor': '首选编辑器',
  'Auto-connect to IDE': '自动连接到 IDE',
  'Enable Prompt Completion': '启用提示补全',
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
  'Not Sure Yet': '暂不评价',
  'Any other key': '任意其他键',
  'Disable Loading Phrases': '禁用加载短语',
  'Screen Reader Mode': '屏幕阅读器模式',
  'IDE Mode': 'IDE 模式',
  'Max Session Turns': '最大会话轮次',
  'Skip Next Speaker Check': '跳过下一个说话者检查',
  'Skip Loop Detection': '跳过循环检测',
  'Skip Startup Context': '跳过启动上下文',
  'Enable OpenAI Logging': '启用 OpenAI 日志',
  'OpenAI Logging Directory': 'OpenAI 日志目录',
  Timeout: '超时',
  'Max Retries': '最大重试次数',
  'Disable Cache Control': '禁用缓存控制',
  'Memory Discovery Max Dirs': '内存发现最大目录数',
  'Load Memory From Include Directories': '从包含目录加载内存',
  'Respect .gitignore': '遵守 .gitignore',
  'Respect .qwenignore': '遵守 .qwenignore',
  'Enable Recursive File Search': '启用递归文件搜索',
  'Disable Fuzzy Search': '禁用模糊搜索',
  'Interactive Shell (PTY)': '交互式 Shell (PTY)',
  'Show Color': '显示颜色',
  'Auto Accept': '自动接受',
  'Use Ripgrep': '使用 Ripgrep',
  'Use Builtin Ripgrep': '使用内置 Ripgrep',
  'Enable Tool Output Truncation': '启用工具输出截断',
  'Tool Output Truncation Threshold': '工具输出截断阈值',
  'Tool Output Truncation Lines': '工具输出截断行数',
  'Folder Trust': '文件夹信任',
  'Vision Model Preview': '视觉模型预览',
  'Tool Schema Compliance': '工具 Schema 兼容性',
  // Settings enum options
  'Auto (detect from system)': '自动（从系统检测）',
  Text: '文本',
  JSON: 'JSON',
  Plan: '规划',
  Default: '默认',
  'Auto Edit': '自动编辑',
  YOLO: 'YOLO',
  'toggle vim mode on/off': '切换 vim 模式开关',
  'check session stats. Usage: /stats [model|tools]':
    '检查会话统计信息。用法：/stats [model|tools]',
  'Show model-specific usage statistics.': '显示模型相关的使用统计信息',
  'Show tool-specific usage statistics.': '显示工具相关的使用统计信息',
  'exit the cli': '退出命令行界面',
  'list configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    '列出已配置的 MCP 服务器和工具，或使用支持 OAuth 的服务器进行身份验证',
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
  'List active extensions': '列出活动扩展',
  'Update extensions. Usage: update <extension-names>|--all':
    '更新扩展。用法：update <extension-names>|--all',
  'Disable an extension': '禁用扩展',
  'Enable an extension': '启用扩展',
  'Install an extension from a git repo or local path':
    '从 Git 仓库或本地路径安装扩展',
  'Uninstall an extension': '卸载扩展',
  'No extensions installed.': '未安装扩展。',
  'Usage: /extensions update <extension-names>|--all':
    '用法：/extensions update <扩展名>|--all',
  'Extension "{{name}}" not found.': '未找到扩展 "{{name}}"。',
  'No extensions to update.': '没有可更新的扩展。',
  'Usage: /extensions install <source>': '用法：/extensions install <来源>',
  'Installing extension from "{{source}}"...':
    '正在从 "{{source}}" 安装扩展...',
  'Extension "{{name}}" installed successfully.': '扩展 "{{name}}" 安装成功。',
  'Failed to install extension from "{{source}}": {{error}}':
    '从 "{{source}}" 安装扩展失败：{{error}}',
  'Usage: /extensions uninstall <extension-name>':
    '用法：/extensions uninstall <扩展名>',
  'Uninstalling extension "{{name}}"...': '正在卸载扩展 "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    '扩展 "{{name}}" 卸载成功。',
  'Failed to uninstall extension "{{name}}": {{error}}':
    '卸载扩展 "{{name}}" 失败：{{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    '用法：/extensions {{command}} <扩展> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", should be one of "user" or "workspace"':
    '不支持的作用域 "{{scope}}"，应为 "user" 或 "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    '扩展 "{{name}}" 已在作用域 "{{scope}}" 中禁用',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    '扩展 "{{name}}" 已在作用域 "{{scope}}" 中启用',
  'Do you want to continue? [Y/n]: ': '是否继续？[Y/n]：',
  'Do you want to continue?': '是否继续？',
  'Installing extension "{{name}}".': '正在安装扩展 "{{name}}"。',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**扩展可能会引入意外行为。请确保您已调查过扩展源并信任作者。**',
  'This extension will run the following MCP servers:':
    '此扩展将运行以下 MCP 服务器：',
  local: '本地',
  remote: '远程',
  'This extension will add the following commands: {{commands}}.':
    '此扩展将添加以下命令：{{commands}}。',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    '此扩展将使用 {{fileName}} 向您的 QWEN.md 上下文追加信息',
  'This extension will exclude the following core tools: {{tools}}':
    '此扩展将排除以下核心工具：{{tools}}',
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
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    '从 Git 仓库 URL、本地路径或 Claude 市场（marketplace-url:plugin-name）安装扩展。',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    '要安装的扩展的 GitHub URL、本地路径或市场源（marketplace-url:plugin-name）。',
  'The git ref to install from.': '要安装的 Git 引用。',
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
  'The name of the extension to update.': '要更新的扩展名称。',
  'Update all extensions.': '更新所有扩展。',
  'Either an extension name or --all must be provided':
    '必须提供扩展名称或 --all',
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
  'MCP servers:': 'MCP 服务器：',
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
    '使用 ↑↓ 或 j/k 导航，回车选择，Esc 取消',
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
  'LLM output language not set': '未设置 LLM 输出语言',
  'Set UI language': '设置 UI 语言',
  'Set LLM output language': '设置 LLM 输出语言',
  'Usage: /language ui [{{options}}]': '用法：/language ui [{{options}}]',
  'Usage: /language output <language>': '用法：/language output <语言>',
  'Example: /language output 中文': '示例：/language output 中文',
  'Example: /language output English': '示例：/language output English',
  'Example: /language output 日本語': '示例：/language output 日本語',
  'Example: /language output Português': '示例：/language output Português',
  'UI language changed to {{lang}}': 'UI 语言已更改为 {{lang}}',
  'LLM output language set to {{lang}}': 'LLM 输出语言已设置为 {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'LLM 输出语言规则文件已生成于 {{path}}',
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
  'Current approval mode: {{mode}}': '当前审批模式：{{mode}}',
  'Available approval modes:': '可用的审批模式：',
  'Approval mode changed to: {{mode}}': '审批模式已更改为：{{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    '审批模式已更改为：{{mode}}（已保存到{{scope}}设置{{location}}）',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    '用法：/approval-mode <mode> [--session|--user|--project]',

  'Scope subcommands do not accept additional arguments.':
    '作用域子命令不接受额外参数',
  'Plan mode - Analyze only, do not modify files or execute commands':
    '规划模式 - 仅分析，不修改文件或执行命令',
  'Default mode - Require approval for file edits or shell commands':
    '默认模式 - 需要批准文件编辑或 shell 命令',
  'Auto-edit mode - Automatically approve file edits':
    '自动编辑模式 - 自动批准文件编辑',
  'YOLO mode - Automatically approve all tools': 'YOLO 模式 - 自动批准所有工具',
  '{{mode}} mode': '{{mode}} 模式',
  'Settings service is not available; unable to persist the approval mode.':
    '设置服务不可用；无法持久化审批模式。',
  'Failed to save approval mode: {{error}}': '保存审批模式失败：{{error}}',
  'Failed to change approval mode: {{error}}': '更改审批模式失败：{{error}}',
  'Apply to current session only (temporary)': '仅应用于当前会话（临时）',
  'Persist for this project/workspace': '持久化到此项目/工作区',
  'Persist for this user on this machine': '持久化到此机器上的此用户',
  'Analyze only, do not modify files or execute commands':
    '仅分析，不修改文件或执行命令',
  'Require approval for file edits or shell commands':
    '需要批准文件编辑或 shell 命令',
  'Automatically approve file edits': '自动批准文件编辑',
  'Automatically approve all tools': '自动批准所有工具',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    '工作区审批模式已存在并具有优先级。用户级别的更改将无效。',
  'Apply To': '应用于',
  'User Settings': '用户设置',
  'Workspace Settings': '工作区设置',

  // ============================================================================
  // Commands - Memory
  // ============================================================================
  'Commands for interacting with memory.': '用于与记忆交互的命令',
  'Show the current memory contents.': '显示当前记忆内容',
  'Show project-level memory contents.': '显示项目级记忆内容',
  'Show global memory contents.': '显示全局记忆内容',
  'Add content to project-level memory.': '添加内容到项目级记忆',
  'Add content to global memory.': '添加内容到全局记忆',
  'Refresh the memory from the source.': '从源刷新记忆',
  'Usage: /memory add --project <text to remember>':
    '用法：/memory add --project <要记住的文本>',
  'Usage: /memory add --global <text to remember>':
    '用法：/memory add --global <要记住的文本>',
  'Attempting to save to project memory: "{{text}}"':
    '正在尝试保存到项目记忆："{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    '正在尝试保存到全局记忆："{{text}}"',
  'Current memory content from {{count}} file(s):':
    '来自 {{count}} 个文件的当前记忆内容：',
  'Memory is currently empty.': '记忆当前为空',
  'Project memory file not found or is currently empty.':
    '项目记忆文件未找到或当前为空',
  'Global memory file not found or is currently empty.':
    '全局记忆文件未找到或当前为空',
  'Global memory is currently empty.': '全局记忆当前为空',
  'Global memory content:\n\n---\n{{content}}\n---':
    '全局记忆内容：\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    '项目记忆内容来自 {{path}}：\n\n---\n{{content}}\n---',
  'Project memory is currently empty.': '项目记忆当前为空',
  'Refreshing memory from source files...': '正在从源文件刷新记忆...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    '添加内容到记忆。使用 --global 表示全局记忆，使用 --project 表示项目记忆',
  'Usage: /memory add [--global|--project] <text to remember>':
    '用法：/memory add [--global|--project] <要记住的文本>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    '正在尝试保存到记忆 {{scope}}："{{fact}}"',

  // ============================================================================
  // Commands - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    '使用支持 OAuth 的 MCP 服务器进行认证',
  'List configured MCP servers and tools': '列出已配置的 MCP 服务器和工具',
  'Restarts MCP servers.': '重启 MCP 服务器',
  'Config not loaded.': '配置未加载',
  'Could not retrieve tool registry.': '无法检索工具注册表',
  'No MCP servers configured with OAuth authentication.':
    '未配置支持 OAuth 认证的 MCP 服务器',
  'MCP servers with OAuth authentication:': '支持 OAuth 认证的 MCP 服务器：',
  'Use /mcp auth <server-name> to authenticate.':
    '使用 /mcp auth <server-name> 进行认证',
  "MCP server '{{name}}' not found.": "未找到 MCP 服务器 '{{name}}'",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "成功认证并刷新了 '{{name}}' 的工具",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "认证 MCP 服务器 '{{name}}' 失败：{{error}}",
  "Re-discovering tools from '{{name}}'...":
    "正在重新发现 '{{name}}' 的工具...",

  // ============================================================================
  // Commands - Chat
  // ============================================================================
  'Manage conversation history.': '管理对话历史',
  'List saved conversation checkpoints': '列出已保存的对话检查点',
  'No saved conversation checkpoints found.': '未找到已保存的对话检查点',
  'List of saved conversations:': '已保存的对话列表：',
  'Note: Newest last, oldest first': '注意：最新的在最后，最旧的在最前',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    '将当前对话保存为检查点。用法：/chat save <tag>',
  'Missing tag. Usage: /chat save <tag>': '缺少标签。用法：/chat save <tag>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    '删除对话检查点。用法：/chat delete <tag>',
  'Missing tag. Usage: /chat delete <tag>':
    '缺少标签。用法：/chat delete <tag>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "对话检查点 '{{tag}}' 已删除",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "错误：未找到标签为 '{{tag}}' 的检查点",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    '从检查点恢复对话。用法：/chat resume <tag>',
  'Missing tag. Usage: /chat resume <tag>':
    '缺少标签。用法：/chat resume <tag>',
  'No saved checkpoint found with tag: {{tag}}.':
    '未找到标签为 {{tag}} 的已保存检查点',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    '标签为 {{tag}} 的检查点已存在。您要覆盖它吗？',
  'No chat client available to save conversation.':
    '没有可用的聊天客户端来保存对话',
  'Conversation checkpoint saved with tag: {{tag}}.':
    '对话检查点已保存，标签：{{tag}}',
  'No conversation found to save.': '未找到要保存的对话',
  'No chat client available to share conversation.':
    '没有可用的聊天客户端来分享对话',
  'Invalid file format. Only .md and .json are supported.':
    '无效的文件格式。仅支持 .md 和 .json 文件',
  'Error sharing conversation: {{error}}': '分享对话时出错：{{error}}',
  'Conversation shared to {{filePath}}': '对话已分享到 {{filePath}}',
  'No conversation found to share.': '未找到要分享的对话',
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    '将当前对话分享到 markdown 或 json 文件。用法：/chat share <file>',

  // ============================================================================
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
  'Failed to generate summary - no text content received from LLM response':
    '生成摘要失败 - 未从 LLM 响应中接收到文本内容',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session': '切换此会话的模型',
  'Content generator configuration not available.': '内容生成器配置不可用',
  'Authentication type not available.': '认证类型不可用',
  'No models available for the current authentication type ({{authType}}).':
    '当前认证类型 ({{authType}}) 没有可用的模型',

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
  'Chat history is already compressed.': '聊天历史已经压缩。',

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
  No: '否',
  'No (esc)': '否 (esc)',
  'Yes, allow always for this session': '是，本次会话总是允许',
  'Modify in progress:': '正在修改：',
  'Save and close external editor to continue': '保存并关闭外部编辑器以继续',
  'Apply this change?': '是否应用此更改？',
  'Yes, allow always': '是，总是允许',
  'Modify with external editor': '使用外部编辑器修改',
  'No, suggest changes (esc)': '否，建议更改 (esc)',
  "Allow execution of: '{{command}}'?": "允许执行：'{{command}}'？",
  'Yes, allow always ...': '是，总是允许 ...',
  'Yes, and auto-accept edits': '是，并自动接受编辑',
  'Yes, and manually approve edits': '是，并手动批准编辑',
  'No, keep planning (esc)': '否，继续规划 (esc)',
  'URLs to fetch:': '要获取的 URL：',
  'MCP Server: {{server}}': 'MCP 服务器：{{server}}',
  'Tool: {{tool}}': '工具：{{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    '允许执行来自服务器 "{{server}}" 的 MCP 工具 "{{tool}}"？',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    '是，总是允许来自服务器 "{{server}}" 的工具 "{{tool}}"',
  'Yes, always allow all tools from server "{{server}}"':
    '是，总是允许来自服务器 "{{server}}" 的所有工具',

  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell 命令执行',
  'A custom command wants to run the following shell commands:':
    '自定义命令想要运行以下 shell 命令：',

  // ============================================================================
  // Dialogs - Pro Quota
  // ============================================================================
  'Pro quota limit reached for {{model}}.': '{{model}} 的 Pro 配额已达到上限',
  'Change auth (executes the /auth command)': '更改认证（执行 /auth 命令）',
  'Continue with {{model}}': '使用 {{model}} 继续',

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

  // ============================================================================
  // Dialogs - Auth
  // ============================================================================
  'Get started': '开始使用',
  'How would you like to authenticate for this project?':
    '您希望如何为此项目进行身份验证？',
  'OpenAI API key is required to use OpenAI authentication.':
    '使用 OpenAI 认证需要 OpenAI API 密钥',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    '您必须选择认证方法才能继续。再次按 Ctrl+C 退出',
  '(Use Enter to Set Auth)': '（使用 Enter 设置认证）',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Qwen Code 的服务条款和隐私声明',
  'Qwen OAuth': 'Qwen OAuth (免费)',
  'Login with QwenChat account to use daily free quota.':
    '使用 QwenChat 账号登录，享受每日免费额度。',
  'Use coding plan credentials or your own api-keys/providers.':
    '使用 Coding Plan 凭证或您自己的 API 密钥/提供商。',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}': '登录失败。消息：{{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    '认证方式被强制设置为 {{enforcedType}}，但您当前使用的是 {{currentType}}',
  'Qwen OAuth authentication timed out. Please try again.':
    'Qwen OAuth 认证超时。请重试',
  'Qwen OAuth authentication cancelled.': 'Qwen OAuth 认证已取消',
  'Qwen OAuth Authentication': 'Qwen OAuth 认证',
  'Please visit this URL to authorize:': '请访问此 URL 进行授权：',
  'Or scan the QR code below:': '或扫描下方的二维码：',
  'Waiting for authorization': '等待授权中',
  'Time remaining:': '剩余时间：',
  '(Press ESC or CTRL+C to cancel)': '（按 ESC 或 CTRL+C 取消）',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth 认证超时',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth 令牌已过期（超过 {{seconds}} 秒）。请重新选择认证方法',
  'Press any key to return to authentication type selection.':
    '按任意键返回认证类型选择',
  'Waiting for Qwen OAuth authentication...': '正在等待 Qwen OAuth 认证...',
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    '注意：使用 Qwen OAuth 时，settings.json 中现有的 API 密钥不会被清除。如果需要，您可以稍后切换回 OpenAI 认证。',
  'Authentication timed out. Please try again.': '认证超时。请重试。',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    '正在等待认证...（按 ESC 或 CTRL+C 取消）',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容认证的 API 密钥。请设置 settings.security.auth.apiKey 或设置 {{envKeyHint}} 环境变量。',
  '{{envKeyHint}} environment variable not found.':
    '未找到 {{envKeyHint}} 环境变量。',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 环境变量。请在 .env 文件或系统环境变量中进行设置。',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 环境变量（或设置 settings.security.auth.apiKey）。请在 .env 文件或系统环境变量中进行设置。',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容认证的 API 密钥。请设置 {{envKeyHint}} 环境变量。',
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
  'OpenAI Configuration Required': '需要配置 OpenAI',
  'Please enter your OpenAI configuration. You can get an API key from':
    '请输入您的 OpenAI 配置。您可以从以下地址获取 API 密钥：',
  'API Key:': 'API 密钥：',
  'Invalid credentials: {{errorMessage}}': '凭据无效：{{errorMessage}}',
  'Failed to validate credentials': '验证凭据失败',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    '按 Enter 继续，Tab/↑↓ 导航，Esc 取消',

  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': '选择模型',
  '(Press Esc to close)': '（按 Esc 关闭）',
  'Current (effective) configuration': '当前（实际生效）配置',
  AuthType: '认证方式',
  'API Key': 'API 密钥',
  unset: '未设置',
  '(default)': '(默认)',
  '(set)': '(已设置)',
  '(not set)': '(未设置)',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "无法切换到模型 '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.5 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.5 Plus — 高效混合架构，编程性能业界领先',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    '来自阿里云 ModelStudio 的最新 Qwen Vision 模型（版本：qwen3-vl-plus-2025-09-23）',

  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': '管理文件夹信任设置',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': '已加载: ',
  '{{count}} open file': '{{count}} 个打开的文件',
  '{{count}} open files': '{{count}} 个打开的文件',
  '(ctrl+g to view)': '（按 ctrl+g 查看）',
  '{{count}} {{name}} file': '{{count}} 个 {{name}} 文件',
  '{{count}} {{name}} files': '{{count}} 个 {{name}} 文件',
  '{{count}} MCP server': '{{count}} 个 MCP 服务器',
  '{{count}} MCP servers': '{{count}} 个 MCP 服务器',
  '{{count}} Blocked': '{{count}} 个已阻止',
  '(ctrl+t to view)': '（按 ctrl+t 查看）',
  '(ctrl+t to toggle)': '（按 ctrl+t 切换）',
  'Press Ctrl+C again to exit.': '再次按 Ctrl+C 退出',
  'Press Ctrl+D again to exit.': '再次按 Ctrl+D 退出',
  'Press Esc again to clear.': '再次按 Esc 清除',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': '未配置 MCP 服务器',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP 服务器正在启动（{{count}} 个正在初始化）...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    '注意：首次启动可能需要更长时间。工具可用性将自动更新',
  'Configured MCP servers:': '已配置的 MCP 服务器：',
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
  Blocked: '已阻止',
  '💡 Tips:': '💡 提示：',
  Use: '使用',
  'to show server and tool descriptions': '显示服务器和工具描述',
  'to show tool parameter schemas': '显示工具参数架构',
  'to hide descriptions': '隐藏描述',
  'to authenticate with OAuth-enabled servers':
    '使用支持 OAuth 的服务器进行认证',
  Press: '按',
  'to toggle tool descriptions on/off': '切换工具描述开关',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "正在为 MCP 服务器 '{{name}}' 启动 OAuth 认证...",
  'Restarting MCP servers...': '正在重启 MCP 服务器...',

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
  Reqs: '请求数',
  'Input Tokens': '输入 token 数',
  'Output Tokens': '输出 token 数',
  'Savings Highlight:': '节省亮点：',
  'of input tokens were served from the cache, reducing costs.':
    '从缓存载入 token ，降低了成本',
  'Tip: For a full token breakdown, run `/stats model`.':
    '提示：要查看完整的令牌明细，请运行 `/stats model`',
  'Model Stats For Nerds': '模型统计（技术细节）',
  'Tool Stats For Nerds': '工具统计（技术细节）',
  Metric: '指标',
  API: 'API',
  Requests: '请求数',
  Errors: '错误数',
  'Avg Latency': '平均延迟',
  Tokens: '令牌',
  Total: '总计',
  Prompt: '提示',
  Cached: '缓存',
  Thoughts: '思考',
  Tool: '工具',
  Output: '输出',
  'No API calls have been made in this session.':
    '本次会话中未进行任何 API 调用',
  'Tool Name': '工具名称',
  Calls: '调用次数',
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
  '... and {{count}} more': '... 以及其他 {{count}} 个',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'TOML 格式已弃用。是否将它们迁移到 Markdown 格式？',
  '(Backups will be created and original files will be preserved)':
    '（将创建备份，原始文件将保留）',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': '等待用户确认...',
  '(esc to cancel, {{time}})': '（按 esc 取消，{{time}}）',
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

  // ============================================================================
  // Retry / Rate Limit
  // ============================================================================
  'Rate limit error: {{reason}}': '触发限流：{{reason}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    '将于 {{seconds}} 秒后重试…（第 {{attempt}}/{{maxRetries}} 次）',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'Please enter your API key:': '请输入您的 API Key：',
  'API key cannot be empty.': 'API Key 不能为空。',
  'You can get your exclusive Coding Plan API-KEY here:':
    '您可以在这里获取专属的 Coding Plan API-KEY：',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'API Key 已存储在 settings.env 中。您可以将其迁移到 .env 文件以获得更好的安全性。',
  'New model configurations are available for Bailian Coding Plan. Update now?':
    '百炼 Coding Plan 有新模型配置可用。是否立即更新？',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan 配置更新成功。新模型现已可用。',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    '未找到 Coding Plan API Key。请重新通过 Coding Plan 认证。',
  'Failed to update Coding Plan configuration: {{message}}':
    '更新 Coding Plan 配置失败：{{message}}',

  // ============================================================================
  // Custom API-KEY Configuration
  // ============================================================================
  'For advanced users who want to configure models manually.':
    '适合需要手动配置模型的高级用户。',
  'Please configure your models in settings.json:':
    '请在 settings.json 中配置您的模型：',
  'Set API key via environment variable (e.g., OPENAI_API_KEY)':
    '通过环境变量设置 API Key（例如：OPENAI_API_KEY）',
  "Add model configuration to modelProviders['openai'] (or other auth types)":
    "将模型配置添加到 modelProviders['openai']（或其他认证类型）",
  'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig':
    '每个提供商需要：id、envKey（必需），以及可选的 baseUrl、generationConfig',
  'Use /model command to select your preferred model from the configured list':
    '使用 /model 命令从配置列表中选择您偏好的模型',
  'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.':
    '支持的认证类型：openai、anthropic、gemini、vertex-ai 等',
  'More instructions please check:': '更多说明请查看：',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'API-KEY': 'API-KEY',
  'Coding Plan': 'Coding Plan',
  "Paste your api key of Bailian Coding Plan and you're all set!":
    '粘贴您的百炼 Coding Plan API Key，即可完成设置！',
  Custom: '自定义',
  'More instructions about configuring `modelProviders` manually.':
    '关于手动配置 `modelProviders` 的更多说明。',
  'Select API-KEY configuration mode:': '选择 API-KEY 配置模式：',
  '(Press Escape to go back)': '(按 Escape 键返回)',
  '(Press Enter to submit, Escape to cancel)': '(按 Enter 提交，Escape 取消)',
};
