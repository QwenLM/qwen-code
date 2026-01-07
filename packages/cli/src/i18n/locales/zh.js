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

  // ============================================================================
  // System Information Fields
  // ============================================================================
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
  '(Use Enter to apply scope, Tab to select theme)':
    '（使用 Enter 应用作用域，Tab 选择主题）',
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
  'Copy the last result or code snippet to clipboard':
    '将最后的结果或代码片段复制到剪贴板',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    '管理用于专门任务委派的子代理',
  'Manage existing subagents (view, edit, delete).':
    '管理现有子代理（查看、编辑、删除）',
  'Create a new subagent with guided setup.': '通过引导式设置创建新的子代理',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: '代理',
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
  'No subagents found.': '未找到子代理。',
  "Use '/agents create' to create your first subagent.":
    "使用 '/agents create' 创建您的第一个子代理。",
  '(built-in)': '（内置）',
  '(overridden by project level agent)': '（已被项目级代理覆盖）',
  'Project Level ({{path}})': '项目级 ({{path}})',
  'User Level ({{path}})': '用户级 ({{path}})',
  'Built-in Agents': '内置代理',
  'Using: {{count}} agents': '使用中: {{count}} 个代理',
  'View Agent': '查看代理',
  'Edit Agent': '编辑代理',
  'Delete Agent': '删除代理',
  Back: '返回',
  'No agent selected': '未选择代理',
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
    '您确定要删除代理 "{{name}}" 吗？',
  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': '项目级 (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': '用户级 (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ 子代理创建成功！',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    '子代理 "{{name}}" 已保存到 {{level}} 级别。',
  'Name: ': '名称: ',
  'Location: ': '位置: ',
  '❌ Error saving subagent:': '❌ 保存子代理时出错:',
  'Warnings:': '警告:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    '名称 "{{name}}" 在 {{level}} 级别已存在 - 将覆盖现有子代理',
  'Name "{{name}}" exists at user level - project level will take precedence':
    '名称 "{{name}}" 在用户级别存在 - 项目级别将优先',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    '名称 "{{name}}" 在项目级别存在 - 现有子代理将优先',
  'Description is over {{length}} characters': '描述超过 {{length}} 个字符',
  'System prompt is over {{length}} characters':
    '系统提示超过 {{length}} 个字符',
  // Agents - Creation Wizard Steps
  'Step {{n}}: Choose Location': '步骤 {{n}}: 选择位置',
  'Step {{n}}: Choose Generation Method': '步骤 {{n}}: 选择生成方式',
  'Generate with Qwen Code (Recommended)': '使用 Qwen Code 生成（推荐）',
  'Manual Creation': '手动创建',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    '描述此子代理应该做什么以及何时使用它。（为了获得最佳效果，请全面描述）',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    '例如：专业的代码审查员，根据最佳实践审查代码...',
  'Generating subagent configuration...': '正在生成子代理配置...',
  'Failed to generate subagent: {{error}}': '生成子代理失败: {{error}}',
  'Step {{n}}: Describe Your Subagent': '步骤 {{n}}: 描述您的子代理',
  'Step {{n}}: Enter Subagent Name': '步骤 {{n}}: 输入子代理名称',
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
    '为此子代理输入一个清晰、唯一的名称。',
  'e.g., Code Reviewer': '例如：代码审查员',
  'Name cannot be empty.': '名称不能为空。',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    '编写定义此子代理行为的系统提示。为了获得最佳效果，请全面描述。',
  'e.g., You are an expert code reviewer...':
    '例如：您是一位专业的代码审查员...',
  'System prompt cannot be empty.': '系统提示不能为空。',
  'Describe when and how this subagent should be used.':
    '描述何时以及如何使用此子代理。',
  'e.g., Reviews code for best practices and potential bugs.':
    '例如：审查代码以查找最佳实践和潜在错误。',
  'Description cannot be empty.': '描述不能为空。',
  'Failed to launch editor: {{error}}': '启动编辑器失败: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    '保存并编辑子代理失败: {{error}}',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': '查看和编辑 Qwen Code 设置',
  Settings: '设置',
  '(Use Enter to select{{tabText}})': '（使用 Enter 选择{{tabText}}）',
  ', Tab to change focus': '，Tab 切换焦点',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '要查看更改，必须重启 Qwen Code。按 r 退出并立即应用更改。',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    '不支持在非交互模式下使用命令 "/{{command}}"。',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim 模式',
  'Disable Auto Update': '禁用自动更新',
  'Enable Prompt Completion': '启用提示补全',
  'Debug Keystroke Logging': '调试按键记录',
  Language: '语言',
  'Output Format': '输出格式',
  'Hide Window Title': '隐藏窗口标题',
  'Show Status in Title': '在标题中显示状态',
  'Hide Tips': '隐藏提示',
  'Hide Banner': '隐藏横幅',
  'Hide Context Summary': '隐藏上下文摘要',
  'Hide CWD': '隐藏当前工作目录',
  'Hide Sandbox Status': '隐藏沙箱状态',
  'Hide Model Info': '隐藏模型信息',
  'Hide Footer': '隐藏页脚',
  'Show Memory Usage': '显示内存使用',
  'Show Line Numbers': '显示行号',
  'Show Citations': '显示引用',
  'Custom Witty Phrases': '自定义诙谐短语',
  'Enable Welcome Back': '启用欢迎回来',
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
  'Enable Interactive Shell': '启用交互式 Shell',
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
  'Manage extensions': '管理扩展',
  'List active extensions': '列出活动扩展',
  'Update extensions. Usage: update <extension-names>|--all':
    '更新扩展。用法：update <extension-names>|--all',
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
  'Invalid language. Available: en-US, zh-CN':
    '无效的语言。可用选项：en-US, zh-CN',
  'Language subcommands do not accept additional arguments.':
    '语言子命令不接受额外参数',
  'Current UI language: {{lang}}': '当前 UI 语言：{{lang}}',
  'Current LLM output language: {{lang}}': '当前 LLM 输出语言：{{lang}}',
  'LLM output language not set': '未设置 LLM 输出语言',
  'Set UI language': '设置 UI 语言',
  'Set LLM output language': '设置 LLM 输出语言',
  'Usage: /language ui [zh-CN|en-US]': '用法：/language ui [zh-CN|en-US]',
  'Usage: /language output <language>': '用法：/language output <语言>',
  'Example: /language output 中文': '示例：/language output 中文',
  'Example: /language output English': '示例：/language output English',
  'Example: /language output 日本語': '示例：/language output 日本語',
  'UI language changed to {{lang}}': 'UI 语言已更改为 {{lang}}',
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
  '  - zh-CN: Simplified Chinese': '  - zh-CN: 简体中文',
  '  - en-US: English': '  - en-US: English',
  'Set UI language to Simplified Chinese (zh-CN)':
    '将 UI 语言设置为简体中文 (zh-CN)',
  'Set UI language to English (en-US)': '将 UI 语言设置为英语 (en-US)',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Approval Mode': '审批模式',
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
  '(Use Enter to select, Tab to change focus)':
    '（使用 Enter 选择，Tab 切换焦点）',
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
  'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)':
    '来自阿里云 ModelStudio 的最新 Qwen Coder 模型（版本：qwen3-coder-plus-2025-09-23）',
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
  'Please view MCP documentation in your browser:':
    '请在浏览器中查看 MCP 文档：',
  'or use the cli /docs command': '或使用 cli /docs 命令',
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
  'Tips for getting started:': '入门提示：',
  '1. Ask questions, edit files, or run commands.':
    '1. 提问、编辑文件或运行命令',
  '2. Be specific for the best results.': '2. 具体描述以获得最佳结果',
  'files to customize your interactions with Qwen Code.':
    '文件以自定义您与 Qwen Code 的交互',
  'for more information.': '获取更多信息',

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
  'Agent Active:': '代理活跃时间：',
  'API Time:': 'API 时间：',
  'Tool Time:': '工具时间：',
  'Session Stats': '会话统计',
  'Model Usage': '模型使用情况',
  Reqs: '请求数',
  'Input Tokens': '输入令牌',
  'Output Tokens': '输出令牌',
  'Savings Highlight:': '节省亮点：',
  'of input tokens were served from the cache, reducing costs.':
    '的输入令牌来自缓存，降低了成本',
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
};
