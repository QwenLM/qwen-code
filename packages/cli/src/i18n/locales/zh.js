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

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    '分析项目并创建定制的 QWEN.md 文件',
  'list available Qwen Code tools. Usage: /tools [desc]':
    '列出可用的 Qwen Code 工具。用法：/tools [desc]',
  'View or change the approval mode for tool usage':
    '查看或更改工具使用的审批模式',
  'View or change the language setting': '查看或更改语言设置',
  'change the theme': '更改主题',
  'clear the screen and conversation history': '清屏并清除对话历史',
  'Compresses the context by replacing it with a summary.':
    '通过用摘要替换来压缩上下文',
  'open full Qwen Code documentation in your browser':
    '在浏览器中打开完整的 Qwen Code 文档',
  'Configuration not available.': '配置不可用',
  'change the auth method': '更改认证方法',
  'Show quit confirmation dialog': '显示退出确认对话框',
  'Copy the last result or code snippet to clipboard':
    '将最后的结果或代码片段复制到剪贴板',
  'Manage subagents for specialized task delegation.':
    '管理用于专门任务委派的子代理',
  'Manage existing subagents (view, edit, delete).':
    '管理现有子代理（查看、编辑、删除）',
  'Create a new subagent with guided setup.': '通过引导式设置创建新的子代理',
  'View and edit Qwen Code settings': '查看和编辑 Qwen Code 设置',
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
  'Set up GitHub Actions': '设置 GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf)':
    '配置终端按键绑定以支持多行输入（VS Code、Cursor、Windsurf）',

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
  'Current approval mode: {{mode}}': '当前审批模式：{{mode}}',
  'Available approval modes:': '可用的审批模式：',
  'Approval mode changed to: {{mode}}': '审批模式已更改为：{{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    '审批模式已更改为：{{mode}}（已保存到{{scope}}设置{{location}}）',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    '用法：/approval-mode <mode> [--session|--user|--project]',
  'Invalid approval mode: {{mode}}': '无效的审批模式：{{mode}}',
  'Multiple scope flags provided': '提供了多个作用域标志',
  'Invalid arguments provided': '提供了无效的参数',
  'Missing approval mode': '缺少审批模式',
  'Scope subcommands do not accept additional arguments.':
    '作用域子命令不接受额外参数',
  'Plan mode - Analyze only, do not modify files or execute commands':
    '计划模式 - 仅分析，不修改文件或执行命令',
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
  'Clearing terminal and resetting chat.': '正在清屏并重置聊天',
  'Clearing terminal.': '正在清屏',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    '正在压缩中，请等待上一个请求完成',
  'Failed to compress chat history.': '压缩聊天历史失败',
  'Failed to compress chat history: {{error}}': '压缩聊天历史失败：{{error}}',

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

  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell 命令执行',
  'A custom command wants to run the following shell commands:':
    '自定义命令想要运行以下 shell 命令：',

  // ============================================================================
  // Dialogs - Quit Confirmation
  // ============================================================================
  'What would you like to do before exiting?': '退出前您想要做什么？',
  'Quit immediately (/quit)': '立即退出 (/quit)',
  'Generate summary and quit (/summary)': '生成摘要并退出 (/summary)',
  'Save conversation and quit (/chat save)': '保存对话并退出 (/chat save)',
  'Cancel (stay in application)': '取消（留在应用程序中）',

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
    '您想如何为此项目进行认证？',
  'OpenAI API key is required to use OpenAI authentication.':
    '使用 OpenAI 认证需要 OpenAI API 密钥',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    '您必须选择认证方法才能继续。再次按 Ctrl+C 退出',
  '(Use Enter to Set Auth)': '（使用 Enter 设置认证）',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Qwen Code 的服务条款和隐私声明',
  'Qwen OAuth': 'Qwen OAuth',
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
};
