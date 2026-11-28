/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BRAND_IGNORE_FILE,
  BRAND_NAME,
  BRAND_CLI_NAME,
  type UiLocale,
} from '@qwen-code/core';
import { SHIFT_TAB_DISPLAY } from '../constants/shortcuts.js';

/**
 * Brand placeholders use the product constants selected at process startup.
 */
const BRAND_PLACEHOLDER = '{brand}';
const CLI_NAME_PLACEHOLDER = '{cli}';

export function applyBrandPlaceholders(text: string): string {
  return text
    .replaceAll(BRAND_PLACEHOLDER, BRAND_NAME)
    .replaceAll(CLI_NAME_PLACEHOLDER, BRAND_CLI_NAME);
}

/**
 * Single source of truth for built-in tips. Stable semantic IDs keep the
 * selected tip intact across locale switches, while colocated translations
 * prevent independent arrays from drifting out of alignment.
 */
export const INFORMATIVE_TIP_CATALOG = [
  {
    id: 'settings.set-your-preferred-editor-for-opening-files',
    en: 'Set your preferred editor for opening files (/settings)…',
    zhCN: '在 /settings 中设置打开文件时使用的首选编辑器…',
  },
  {
    id: 'settings.toggle-vim-mode-for-a-modal-editing',
    en: 'Toggle Vim mode for a modal editing experience (/settings)…',
    zhCN: '在 /settings 中切换 Vim 模式，体验模态编辑…',
  },
  {
    id: 'settings.disable-automatic-updates-if-you-prefer-manual',
    en: 'Disable automatic updates if you prefer manual control (/settings)…',
    zhCN: '如果更喜欢手动控制，可在 /settings 中关闭自动更新…',
  },
  {
    id: 'settings.turn-off-nagging-update-notifications-settings-json',
    en: 'Turn off nagging update notifications (settings.json)…',
    zhCN: '可在 settings.json 中关闭更新提醒…',
  },
  {
    id: 'settings.enable-file-checkpointing-to-rewind-code-changes',
    en: 'Enable file checkpointing to rewind code changes (settings.json)…',
    zhCN: '在 settings.json 中启用文件检查点，以便回溯代码变更…',
  },
  {
    id: 'settings.change-cli-output-format-to-json-for',
    en: 'Change CLI output format to JSON for scripting (/settings)…',
    zhCN: '在 /settings 中将 CLI 输出格式改为 JSON，方便脚本处理…',
  },
  {
    id: 'settings.personalize-your-cli-with-a-new-color',
    en: 'Personalize your CLI with a new color theme (/settings)…',
    zhCN: '在 /settings 中更换配色主题，个性化 CLI…',
  },
  {
    id: 'settings.create-and-use-your-own-custom-themes',
    en: 'Create and use your own custom themes (settings.json)…',
    zhCN: '在 settings.json 中创建并使用自定义主题…',
  },
  {
    id: 'settings.hide-window-title-for-a-more-minimal',
    en: 'Hide window title for a more minimal UI (/settings)…',
    zhCN: '在 /settings 中隐藏窗口标题，获得更简洁的界面…',
  },
  {
    id: 'settings.don-t-like-these-tips-you-can',
    en: "Don't like these tips? You can hide them (/settings)…",
    zhCN: '不喜欢这些提示？可在 /settings 中隐藏…',
  },
  {
    id: 'settings.hide-the-startup-banner-for-a-cleaner',
    en: 'Hide the startup banner for a cleaner launch (/settings)…',
    zhCN: '在 /settings 中隐藏启动横幅，让启动页更简洁…',
  },
  {
    id: 'settings.hide-the-context-summary-above-the-input',
    en: 'Hide the context summary above the input (/settings)…',
    zhCN: '在 /settings 中隐藏输入框上方的上下文摘要…',
  },
  {
    id: 'settings.reclaim-vertical-space-by-hiding-the-footer',
    en: 'Reclaim vertical space by hiding the footer (/settings)…',
    zhCN: '在 /settings 中隐藏底栏，释放垂直空间…',
  },
  {
    id: 'settings.hide-individual-footer-elements-like-cwd-or',
    en: 'Hide individual footer elements like CWD or model name (/settings)…',
    zhCN: '在 /settings 中隐藏 CWD 或模型名称等单个底栏项…',
  },
  {
    id: 'settings.hide-the-context-window-percentage-in-the',
    en: 'Hide the context window percentage in the footer (/settings)…',
    zhCN: '在 /settings 中隐藏底栏的上下文窗口百分比…',
  },
  {
    id: 'settings.show-memory-usage-for-performance-monitoring-settings',
    en: 'Show memory usage for performance monitoring (/settings)…',
    zhCN: '在 /settings 中显示内存用量，方便监控性能…',
  },
  {
    id: 'settings.show-line-numbers-in-the-chat-for',
    en: 'Show line numbers in the chat for easier reference (/settings)…',
    zhCN: '在 /settings 中显示聊天行号，方便引用…',
  },
  {
    id: 'settings.show-citations-to-see-where-the-model',
    en: 'Show citations to see where the model gets information (/settings)…',
    zhCN: '在 /settings 中显示引用来源，了解模型的信息依据…',
  },
  {
    id: 'settings.customize-loading-phrases-tips-witty-all-or',
    en: 'Customize loading phrases: tips, witty, all, or off (/settings)…',
    zhCN: '在 /settings 中自定义加载文案：提示、趣味文案、全部或关闭…',
  },
  {
    id: 'settings.add-custom-witty-phrases-to-the-loading',
    en: 'Add custom witty phrases to the loading screen (settings.json)…',
    zhCN: '在 settings.json 中为加载界面添加自定义趣味文案…',
  },
  {
    id: 'settings.use-alternate-screen-buffer-to-preserve-shell',
    en: 'Use alternate screen buffer to preserve shell history (/settings)…',
    zhCN: '在 /settings 中使用备用屏幕缓冲区，保留 shell 历史…',
  },
  {
    id: 'settings.choose-a-specific-brand-name-model-for',
    en: `Choose a specific {brand} model for conversations (/settings)…`,
    zhCN: `在 /settings 中为对话选择指定的 {brand} 模型…`,
  },
  {
    id: 'settings.limit-the-number-of-turns-in-your',
    en: 'Limit the number of turns in your session history (/settings)…',
    zhCN: '在 /settings 中限制会话历史保留的轮数…',
  },
  {
    id: 'settings.automatically-summarize-large-tool-outputs-to-save',
    en: 'Automatically summarize large tool outputs to save tokens (settings.json)…',
    zhCN: '在 settings.json 中自动摘要较大的工具输出，节省 token…',
  },
  {
    id: 'settings.control-when-chat-history-gets-compressed-based',
    en: 'Control when chat history gets compressed based on context compression threshold (settings.json)…',
    zhCN: '在 settings.json 中根据上下文压缩阈值控制聊天历史的压缩时机…',
  },
  {
    id: 'settings.define-custom-context-file-names-like-context',
    en: 'Define custom context file names, like CONTEXT.md (settings.json)…',
    zhCN: '在 settings.json 中定义自定义上下文文件名，例如 CONTEXT.md…',
  },
  {
    id: 'settings.set-max-directories-to-scan-for-context',
    en: 'Set max directories to scan for context files (/settings)…',
    zhCN: '在 /settings 中设置扫描上下文文件时的最大目录数…',
  },
  {
    id: 'settings.control-how-agents-md-context-files-are',
    en: 'Control how AGENTS.md context files are loaded (/settings)…',
    zhCN: '在 /settings 中控制 AGENTS.md 上下文文件的加载方式…',
  },
  {
    id: 'settings.toggle-respect-for-gitignore-files-in-context',
    en: 'Toggle respect for .gitignore files in context (/settings)…',
    zhCN: '在 /settings 中切换上下文是否遵循 .gitignore 文件…',
  },
  {
    id: 'settings.toggle-respect-for-brand-ignore-file-files',
    en: `Toggle respect for ${BRAND_IGNORE_FILE} files in context (/settings)…`,
    zhCN: `在 /settings 中切换上下文是否遵循 ${BRAND_IGNORE_FILE} 文件…`,
  },
  {
    id: 'settings.enable-recursive-file-search-for-file-completions',
    en: 'Enable recursive file search for @-file completions (/settings)…',
    zhCN: '在 /settings 中为 @ 文件补全启用递归文件搜索…',
  },
  {
    id: 'settings.disable-fuzzy-search-when-searching-for-files',
    en: 'Disable fuzzy search when searching for files (/settings)…',
    zhCN: '在 /settings 中搜索文件时关闭模糊搜索…',
  },
  {
    id: 'settings.use-an-interactive-terminal-for-shell-commands',
    en: 'Use an interactive terminal for shell commands (/settings)…',
    zhCN: '在 /settings 中为 shell 命令使用交互式终端…',
  },
  {
    id: 'settings.show-color-in-shell-command-output-settings',
    en: 'Show color in shell command output (/settings)…',
    zhCN: '在 /settings 中显示 shell 命令输出的颜色…',
  },
  {
    id: 'settings.automatically-accept-safe-read-only-tool-calls',
    en: 'Automatically accept safe read-only tool calls (/settings)…',
    zhCN: '在 /settings 中自动接受安全的只读工具调用…',
  },
  {
    id: 'settings.restrict-available-built-in-tools-settings-json',
    en: 'Restrict available built-in tools (settings.json)…',
    zhCN: '在 settings.json 中限制可用的内置工具…',
  },
  {
    id: 'settings.exclude-specific-tools-from-being-used-settings',
    en: 'Exclude specific tools from being used (settings.json)…',
    zhCN: '在 settings.json 中排除指定工具…',
  },
  {
    id: 'settings.bypass-confirmation-for-trusted-tools-settings-json',
    en: 'Bypass confirmation for trusted tools (settings.json)…',
    zhCN: '在 settings.json 中对可信工具跳过确认…',
  },
  {
    id: 'settings.use-a-custom-command-for-tool-discovery',
    en: 'Use a custom command for tool discovery (settings.json)…',
    zhCN: '在 settings.json 中使用自定义命令发现工具…',
  },
  {
    id: 'settings.define-a-custom-command-for-calling-discovered',
    en: 'Define a custom command for calling discovered tools (settings.json)…',
    zhCN: '在 settings.json 中定义调用已发现工具的自定义命令…',
  },
  {
    id: 'settings.define-and-manage-connections-to-mcp-servers',
    en: 'Define and manage connections to MCP servers (settings.json)…',
    zhCN: '在 settings.json 中定义和管理 MCP 服务器连接…',
  },
  {
    id: 'settings.enable-folder-trust-to-enhance-security-settings',
    en: 'Enable folder trust to enhance security (/settings)…',
    zhCN: '在 /settings 中启用文件夹信任，提升安全性…',
  },
  {
    id: 'settings.disable-bypass-permissions-mode-to-enforce-confirmations',
    en: 'Disable bypass permissions mode to enforce confirmations (settings.json)…',
    zhCN: '在 settings.json 中禁用绕过权限模式，强制执行确认…',
  },
  {
    id: 'settings.block-git-extensions-for-enhanced-security-settings',
    en: 'Block Git extensions for enhanced security (settings.json)…',
    zhCN: '在 settings.json 中阻止 Git 扩展，提升安全性…',
  },
  {
    id: 'settings.change-your-authentication-method-settings',
    en: 'Change your authentication method (/settings)…',
    zhCN: '在 /settings 中更改身份验证方式…',
  },
  {
    id: 'settings.enforce-auth-type-for-enterprise-use-settings',
    en: 'Enforce auth type for enterprise use (settings.json)…',
    zhCN: '在 settings.json 中为企业使用强制指定身份验证类型…',
  },
  {
    id: 'settings.let-node-js-auto-configure-memory-settings',
    en: 'Let Node.js auto-configure memory (settings.json)…',
    zhCN: '在 settings.json 中让 Node.js 自动配置内存…',
  },
  {
    id: 'settings.retry-on-fetch-failed-errors-automatically-settings',
    en: 'Retry on fetch failed errors automatically (settings.json)…',
    zhCN: '在 settings.json 中自动重试 fetch failed 错误…',
  },
  {
    id: 'settings.customize-the-dns-resolution-order-settings-json',
    en: 'Customize the DNS resolution order (settings.json)…',
    zhCN: '在 settings.json 中自定义 DNS 解析顺序…',
  },
  {
    id: 'settings.exclude-env-vars-from-the-context-settings',
    en: 'Exclude env vars from the context (settings.json)…',
    zhCN: '在 settings.json 中将环境变量排除在上下文之外…',
  },
  {
    id: 'settings.configure-a-custom-command-for-filing-bug',
    en: 'Configure a custom command for filing bug reports (settings.json)…',
    zhCN: '在 settings.json 中配置提交 bug 报告的自定义命令…',
  },
  {
    id: 'settings.choose-whether-to-log-prompt-content-settings',
    en: 'Choose whether to log prompt content (settings.json)…',
    zhCN: '在 settings.json 中选择是否记录 prompt 内容…',
  },
  {
    id: 'settings.enable-ai-powered-prompt-completion-while-typing',
    en: 'Enable AI-powered prompt completion while typing (/settings)…',
    zhCN: '在 /settings 中启用 AI 驱动的输入补全…',
  },
  {
    id: 'settings.enable-debug-logging-of-keystrokes-to-the',
    en: 'Enable debug logging of keystrokes to the console (/settings)…',
    zhCN: '在 /settings 中启用按键调试日志输出到控制台…',
  },
  {
    id: 'settings.enable-automatic-session-cleanup-of-old-conversations',
    en: 'Enable automatic session cleanup of old conversations (/settings)…',
    zhCN: '在 /settings 中启用旧对话的自动会话清理…',
  },
  {
    id: 'settings.show-brand-cli-name-status-in-the',
    en: `Show ${CLI_NAME_PLACEHOLDER} status in the terminal window title (/settings)…`,
    zhCN: `在 /settings 中于终端窗口标题显示 ${CLI_NAME_PLACEHOLDER} 状态…`,
  },
  {
    id: 'settings.use-the-entire-width-of-the-terminal',
    en: 'Use the entire width of the terminal for output (/settings)…',
    zhCN: '在 /settings 中使用终端的全部宽度输出…',
  },
  {
    id: 'settings.enable-screen-reader-mode-for-better-accessibility',
    en: 'Enable screen reader mode for better accessibility (/settings)…',
    zhCN: '在 /settings 中启用屏幕阅读器模式，提升无障碍性…',
  },
  {
    id: 'settings.use-ripgrep-for-faster-file-content-search',
    en: 'Use ripgrep for faster file content search (/settings)…',
    zhCN: '在 /settings 中使用 ripgrep 加快文件内容搜索…',
  },
  {
    id: 'settings.enable-truncation-of-large-tool-outputs-to',
    en: 'Enable truncation of large tool outputs to save tokens (/settings)…',
    zhCN: '在 /settings 中启用大型工具输出截断，节省 token…',
  },
  {
    id: 'settings.set-the-character-threshold-for-truncating-tool',
    en: 'Set the character threshold for truncating tool outputs (/settings)…',
    zhCN: '在 /settings 中设置截断工具输出的字符阈值…',
  },
  {
    id: 'settings.set-the-number-of-lines-to-keep',
    en: 'Set the number of lines to keep when truncating outputs (/settings)…',
    zhCN: '在 /settings 中设置截断输出时保留的行数…',
  },
  {
    id: 'settings.enable-policy-based-tool-confirmation-settings',
    en: 'Enable policy-based tool confirmation (/settings)…',
    zhCN: '在 /settings 中启用基于策略的工具确认…',
  },
  {
    id: 'settings.use-persistent-task-tools-to-organize-multi',
    en: 'Use persistent task tools to organize multi-step work…',
    zhCN: '使用持久化任务工具组织多步工作…',
  },
  {
    id: 'settings.enable-experimental-subagents-for-task-delegation-settings',
    en: 'Enable experimental subagents for task delegation (/settings)…',
    zhCN: '在 /settings 中启用实验性 subagent 进行任务委派…',
  },
  {
    id: 'settings.enable-extension-management-features-settings-json',
    en: 'Enable extension management features (settings.json)…',
    zhCN: '在 settings.json 中启用扩展管理功能…',
  },
  {
    id: 'settings.enable-extension-reloading-within-the-cli-session',
    en: 'Enable extension reloading within the CLI session (settings.json)…',
    zhCN: '在 settings.json 中启用 CLI 会话内扩展重载…',
  },
  {
    id: 'shortcut.close-dialogs-and-suggestions-with-esc',
    en: 'Close dialogs and suggestions with Esc',
    zhCN: '按 Esc 关闭对话框和建议列表',
  },
  {
    id: 'shortcut.cancel-a-request-with-ctrl-c-or',
    en: 'Cancel a request with Ctrl+C, or press twice to exit',
    zhCN: '按 Ctrl+C 取消请求，按两次可退出',
  },
  {
    id: 'shortcut.exit-the-app-with-ctrl-d-on',
    en: 'Exit the app with Ctrl+D on an empty line',
    zhCN: '在空白行按 Ctrl+D 退出应用',
  },
  {
    id: 'shortcut.clear-your-screen-at-any-time-with',
    en: 'Clear your screen at any time with Ctrl+L',
    zhCN: '随时按 Ctrl+L 清空屏幕',
  },
  {
    id: 'shortcut.toggle-the-debug-console-display-with-f12',
    en: 'Toggle the debug console display with F12',
    zhCN: '按 F12 切换调试控制台',
  },
  {
    id: 'shortcut.toggle-the-todo-list-display-with-ctrl',
    en: 'Toggle the todo list display with Ctrl+T',
    zhCN: '按 Ctrl+T 切换 todo 列表',
  },
  {
    id: 'shortcut.see-full-untruncated-responses-with-ctrl-o',
    en: 'See full, untruncated responses with Ctrl+O',
    zhCN: '按 Ctrl+O 查看完整、未截断的响应',
  },
  {
    id: 'shortcut.toggle-yolo-mode-for-all-tools-with',
    en: 'Toggle YOLO mode for all tools with Ctrl+Y',
    zhCN: '按 Ctrl+Y 为所有工具切换 YOLO 模式',
  },
  {
    id: 'shortcut.cycle-through-permission-modes-default-accept-edits',
    en: `Cycle through permission modes (Default, Accept Edits, Plan) with ${SHIFT_TAB_DISPLAY}`,
    zhCN: `按 ${SHIFT_TAB_DISPLAY} 在权限模式（默认、接受编辑、计划）之间切换`,
  },
  {
    id: 'shortcut.toggle-markdown-rendering-raw-markdown-mode-with',
    en: 'Toggle Markdown rendering (raw markdown mode) with Alt+M',
    zhCN: '按 Alt+M 切换 Markdown 渲染（原始 Markdown 模式）',
  },
  {
    id: 'shortcut.toggle-shell-mode-by-typing-in-an',
    en: 'Toggle shell mode by typing ! in an empty prompt',
    zhCN: '在空输入框中输入 ! 可切换 shell 模式',
  },
  {
    id: 'shortcut.insert-a-newline-with-a-backslash-followed',
    en: 'Insert a newline with a backslash (\\) followed by Enter',
    zhCN: '输入反斜杠（\\）后按 Enter 可插入换行',
  },
  {
    id: 'shortcut.navigate-your-prompt-history-with-the-up',
    en: 'Navigate your prompt history with the Up and Down arrows',
    zhCN: '使用上下方向键浏览 prompt 历史',
  },
  {
    id: 'shortcut.you-can-also-use-ctrl-p-up',
    en: 'You can also use Ctrl+P (up) and Ctrl+N (down) for history',
    zhCN: '也可使用 Ctrl+P（向上）和 Ctrl+N（向下）浏览历史',
  },
  {
    id: 'shortcut.search-through-command-history-with-ctrl-r',
    en: 'Search through command history with Ctrl+R',
    zhCN: '按 Ctrl+R 搜索命令历史',
  },
  {
    id: 'shortcut.accept-an-autocomplete-suggestion-with-tab-or',
    en: 'Accept an autocomplete suggestion with Tab or Enter',
    zhCN: '按 Tab 或 Enter 接受自动补全建议',
  },
  {
    id: 'shortcut.move-to-the-start-of-the-line',
    en: 'Move to the start of the line with Ctrl+A or Home',
    zhCN: '按 Ctrl+A 或 Home 移到行首',
  },
  {
    id: 'shortcut.move-to-the-end-of-the-line',
    en: 'Move to the end of the line with Ctrl+E or End',
    zhCN: '按 Ctrl+E 或 End 移到行尾',
  },
  {
    id: 'shortcut.move-one-character-left-or-right-with',
    en: 'Move one character left or right with Ctrl+B/F or the arrow keys',
    zhCN: '按 Ctrl+B/F 或左右方向键向左或向右移动一个字符',
  },
  {
    id: 'shortcut.move-one-word-left-or-right-with',
    en: 'Move one word left or right with Ctrl+Left/Right Arrow',
    zhCN: '按 Ctrl+Left/Right Arrow 向左或向右移动一个单词',
  },
  {
    id: 'shortcut.delete-the-character-to-the-left-with',
    en: 'Delete the character to the left with Ctrl+H or Backspace',
    zhCN: '按 Ctrl+H 或 Backspace 删除左侧字符',
  },
  {
    id: 'shortcut.delete-the-character-to-the-right-with',
    en: 'Delete the character to the right with Ctrl+D or Delete',
    zhCN: '按 Ctrl+D 或 Delete 删除右侧字符',
  },
  {
    id: 'shortcut.delete-the-word-to-the-left-of',
    en: 'Delete the word to the left of the cursor with Ctrl+W',
    zhCN: '按 Ctrl+W 删除光标左侧的单词',
  },
  {
    id: 'shortcut.delete-the-word-to-the-right-of',
    en: 'Delete the word to the right of the cursor with Ctrl+Delete',
    zhCN: '按 Ctrl+Delete 删除光标右侧的单词',
  },
  {
    id: 'shortcut.delete-from-the-cursor-to-the-start',
    en: 'Delete from the cursor to the start of the line with Ctrl+U',
    zhCN: '按 Ctrl+U 删除从光标到行首的内容',
  },
  {
    id: 'shortcut.delete-from-the-cursor-to-the-end',
    en: 'Delete from the cursor to the end of the line with Ctrl+K',
    zhCN: '按 Ctrl+K 删除从光标到行尾的内容',
  },
  {
    id: 'shortcut.clear-the-entire-input-prompt-with-a',
    en: 'Clear the entire input prompt with a double-press of Esc',
    zhCN: '连按两次 Esc 清空整个输入框',
  },
  {
    id: 'shortcut.paste-images-from-your-clipboard-with-alt',
    en: 'Paste images from your clipboard with Alt+V',
    zhCN: '按 Alt+V 粘贴剪贴板中的图像',
  },
  {
    id: 'shortcut.undo-text-edits-in-the-input-with',
    en: 'Undo text edits in the input with Alt+Z or Cmd+Z',
    zhCN: '按 Alt+Z 或 Cmd+Z 撤销输入框中的文本编辑',
  },
  {
    id: 'shortcut.redo-undone-text-edits-with-shift-alt',
    en: 'Redo undone text edits with Shift+Alt+Z or Shift+Cmd+Z',
    zhCN: '按 Shift+Alt+Z 或 Shift+Cmd+Z 重做已撤销的编辑',
  },
  {
    id: 'shortcut.open-the-current-prompt-in-an-external',
    en: 'Open the current prompt in an external editor with Ctrl+X',
    zhCN: '按 Ctrl+X 在外部编辑器中打开当前 prompt',
  },
  {
    id: 'shortcut.in-menus-move-up-down-with-k',
    en: 'In menus, move up/down with k/j or the arrow keys',
    zhCN: '在菜单中使用 k/j 或上下方向键移动',
  },
  {
    id: 'shortcut.in-menus-select-an-item-by-typing',
    en: 'In menus, select an item by typing its number',
    zhCN: '在菜单中输入项目编号进行选择',
  },
  {
    id: 'shortcut.if-you-re-using-an-ide-see',
    en: "If you're using an IDE, see the context with Ctrl+G",
    zhCN: '如果正在使用 IDE，可按 Ctrl+G 查看上下文',
  },
  {
    id: 'shortcut.toggle-background-shells-with-ctrl-b-or',
    en: 'Toggle background shells with Ctrl+B or /shells',
    zhCN: '按 Ctrl+B 或使用 /shells 切换后台 shell',
  },
  {
    id: 'shortcut.toggle-the-background-shell-process-list-with',
    en: 'Toggle the background shell process list with Ctrl+L',
    zhCN: '按 Ctrl+L 切换后台 shell 进程列表',
  },
  {
    id: 'command.show-version-info-with-about',
    en: 'Show version info with /about',
    zhCN: '使用 /about 查看版本信息',
  },
  {
    id: 'command.change-your-authentication-method-with-auth',
    en: 'Change your authentication method with /auth',
    zhCN: '使用 /auth 更改身份验证方式',
  },
  {
    id: 'command.file-a-bug-report-directly-with-bug',
    en: 'File a bug report directly with /bug',
    zhCN: '使用 /bug 直接提交 bug 报告',
  },
  {
    id: 'command.browse-previous-conversations-with-resume',
    en: 'Browse previous conversations with /resume',
    zhCN: '使用 /resume 浏览之前的对话',
  },
  {
    id: 'command.clear-the-screen-and-history-with-clear',
    en: 'Clear the screen and history with /clear',
    zhCN: '使用 /clear 清空屏幕和历史',
  },
  {
    id: 'command.save-tokens-by-summarizing-the-context-with',
    en: 'Save tokens by summarizing the context with /compact',
    zhCN: '使用 /compact 摘要上下文，节省 token',
  },
  {
    id: 'command.copy-the-last-response-to-your-clipboard',
    en: 'Copy the last response to your clipboard with /copy',
    zhCN: '使用 /copy 将上一条响应复制到剪贴板',
  },
  {
    id: 'command.open-the-full-documentation-in-your-browser',
    en: 'Open the full documentation in your browser with /docs',
    zhCN: '使用 /docs 在浏览器中打开完整文档',
  },
  {
    id: 'command.set-your-preferred-external-editor-with-editor',
    en: 'Set your preferred external editor with /editor',
    zhCN: '使用 /editor 设置首选外部编辑器',
  },
  {
    id: 'command.list-all-active-extensions-with-extensions-list',
    en: 'List all active extensions with /extensions list',
    zhCN: '使用 /extensions list 列出所有活动扩展',
  },
  {
    id: 'command.update-all-or-specific-extensions-with-extensions',
    en: 'Update all or specific extensions with /extensions update',
    zhCN: '使用 /extensions update 更新全部或指定扩展',
  },
  {
    id: 'command.get-help-on-commands-with-help',
    en: 'Get help on commands with /help',
    zhCN: '使用 /help 获取命令帮助',
  },
  {
    id: 'command.manage-ide-integration-with-ide',
    en: 'Manage IDE integration with /ide',
    zhCN: '使用 /ide 管理 IDE 集成',
  },
  {
    id: 'command.create-a-project-specific-agents-md-file',
    en: 'Create a project-specific AGENTS.md file with /init',
    zhCN: '使用 /init 创建项目专用的 AGENTS.md 文件',
  },
  {
    id: 'command.list-configured-mcp-servers-and-tools-with',
    en: 'List configured MCP servers and tools with /mcp list',
    zhCN: '使用 /mcp list 列出已配置的 MCP 服务器和工具',
  },
  {
    id: 'command.reload-mcp-servers-with-mcp-reload',
    en: 'Reload MCP servers with /mcp reload',
    zhCN: '使用 /mcp reload 重新加载 MCP 服务器',
  },
  {
    id: 'command.see-the-current-instructional-context-with-memory',
    en: 'See the current instructional context with /memory show',
    zhCN: '使用 /memory show 查看当前指令上下文',
  },
  {
    id: 'command.add-content-to-the-instructional-memory-with',
    en: 'Add content to the instructional memory with /memory add',
    zhCN: '使用 /memory add 向指令记忆添加内容',
  },
  {
    id: 'command.list-the-paths-of-the-agents-md',
    en: 'List the paths of the AGENTS.md files in use with /memory list',
    zhCN: '使用 /memory list 列出正在使用的 AGENTS.md 文件路径',
  },
  {
    id: 'command.choose-your-brand-name-model-with-model',
    en: `Choose your {brand} model with /model`,
    zhCN: `使用 /model 选择 {brand} 模型`,
  },
  {
    id: 'command.display-the-privacy-notice-with-privacy',
    en: 'Display the privacy notice with /privacy',
    zhCN: '使用 /privacy 显示隐私声明',
  },
  {
    id: 'command.exit-the-cli-with-quit-or-exit',
    en: 'Exit the CLI with /quit or /exit',
    zhCN: '使用 /quit 或 /exit 退出 CLI',
  },
  {
    id: 'command.check-model-specific-usage-stats-with-stats',
    en: 'Check model-specific usage stats with /stats model',
    zhCN: '使用 /stats model 查看特定模型的用量统计',
  },
  {
    id: 'command.check-tool-specific-usage-stats-with-stats',
    en: 'Check tool-specific usage stats with /stats tools',
    zhCN: '使用 /stats tools 查看特定工具的用量统计',
  },
  {
    id: 'command.change-the-cli-s-color-theme-with',
    en: "Change the CLI's color theme with /theme",
    zhCN: '使用 /theme 更改 CLI 配色主题',
  },
  {
    id: 'command.list-all-available-tools-with-tools',
    en: 'List all available tools with /tools',
    zhCN: '使用 /tools 列出所有可用工具',
  },
  {
    id: 'command.view-and-edit-settings-with-the-settings',
    en: 'View and edit settings with the /settings editor',
    zhCN: '使用 /settings 编辑器查看和修改设置',
  },
  {
    id: 'command.toggle-vim-keybindings-on-and-off-with',
    en: 'Toggle Vim keybindings on and off with /vim',
    zhCN: '使用 /vim 开启或关闭 Vim 按键绑定',
  },
  {
    id: 'command.find-relevant-documentation-with-find-docs',
    en: 'Find relevant documentation with /find-docs',
    zhCN: '使用 /find-docs 查找相关文档',
  },
  {
    id: 'command.execute-any-shell-command-with-command',
    en: 'Execute any shell command with !<command>',
    zhCN: '使用 !<command> 执行任意 shell 命令',
  },
] as const;

export type InformativeTipId = (typeof INFORMATIVE_TIP_CATALOG)[number]['id'];

const INFORMATIVE_TIPS_BY_ID = new Map(
  INFORMATIVE_TIP_CATALOG.map((tip) => [tip.id, tip] as const),
);

export function getLocalizedInformativeTip(
  locale: UiLocale,
  id: InformativeTipId,
): string | undefined {
  const tip = INFORMATIVE_TIPS_BY_ID.get(id);
  if (!tip) return undefined;
  return applyBrandPlaceholders(locale === 'zh-CN' ? tip.zhCN : tip.en);
}

export function hasCompleteInformativeTipCatalog(): boolean {
  return (
    INFORMATIVE_TIPS_BY_ID.size === INFORMATIVE_TIP_CATALOG.length &&
    INFORMATIVE_TIP_CATALOG.every(
      ({ id, en, zhCN }) =>
        id.trim().length > 0 && en.trim().length > 0 && zhCN.trim().length > 0,
    )
  );
}
