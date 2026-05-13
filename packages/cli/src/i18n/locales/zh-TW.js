/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

// Traditional Chinese (zh-TW) translations for Qwen Code CLI
// Bootstrapped from en.js structure with opencc(zh.js s2t),
// then extensively hand-corrected for Taiwan vocabulary conventions.
// This file is the authoritative source — do not overwrite with auto-generated output.
export default {
  '↑ to manage attachments': '↑ 管理附件',
  '← → select, Delete to remove, ↓ to exit': '← → 選擇，Delete 刪除，↓ 退出',
  'Attachments: ': '附件：',
  'Basics:': '基礎功能：',
  'Add context': '添加上下文',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    '使用 {{symbol}} 指定檔案作為上下文（例如，{{example}}），用於定位特定檔案或檔案夾',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Shell 模式',
  'YOLO mode': 'YOLO 模式',
  'plan mode': '規劃模式',
  'auto-accept edits': '自動接受編輯',
  'Accepting edits': '接受編輯',
  '(shift + tab to cycle)': '(Shift + Tab 切換)',
  '(tab to cycle)': '(按 Tab 切換)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    '通過 {{symbol}} 執行 shell 命令（例如，{{example1}}）或使用自然語言（例如，{{example2}}）',
  '!': '!',
  '!npm run start': '!npm run start',
  'Commands:': '命令：',
  'shell command': 'shell 命令',
  'Model Context Protocol command (from external servers)':
    'Model Context Protocol 命令（來自外部伺服器）',
  'Keyboard Shortcuts:': '鍵盤快捷鍵：',
  'Toggle this help display': '切換此幫助顯示',
  'Toggle shell mode': '切換命令行模式',
  'Open command menu': '打開命令選單',
  'Add file context': '添加檔案上下文',
  'Accept suggestion / Autocomplete': '接受建議 / 自動補全',
  'Reverse search history': '反向搜索歷史',
  'Press ? again to close': '再次按 ? 關閉',
  'for shell mode': '命令行模式',
  'for commands': '命令選單',
  'for file paths': '檔案路徑',
  'to clear input': '清空輸入',
  'to cycle approvals': '切換審批模式',
  'to quit': '退出',
  'for newline': '換行',
  'to clear screen': '清屏',
  'to search history': '搜索歷史',
  'to paste images': '粘貼圖片',
  'for external editor': '外部編輯器',
  'to toggle compact mode': '切換緊湊模式',
  'Jump through words in the input': '在輸入中按單詞跳轉',
  'Close dialogs, cancel requests, or quit application':
    '關閉對話框、取消請求或退出應用程序',
  'New line': '換行',
  'New line (Alt+Enter works for certain linux distros)':
    '換行（某些 Linux 發行版支持 Alt+Enter）',
  'Clear the screen': '清屏',
  'Open input in external editor': '在外部編輯器中打開輸入',
  'Send message': '發送消息',
  'Initializing...': '正在初始化...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    '正在連接到 MCP servers... ({{connected}}/{{total}})',
  'Type your message or @path/to/file': '輸入您的消息或 @ 檔案路徑',
  '? for shortcuts': '按 ? 查看快捷鍵',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "按 'i' 進入插入模式，按 'Esc' 進入普通模式",
  'Cancel operation / Clear input (double press)':
    '取消操作 / 清空輸入（雙擊）',
  'Cycle approval modes': '循環切換審批模式',
  'Cycle through your prompt history': '循環瀏覽提示歷史',
  'For a full list of shortcuts, see {{docPath}}':
    '完整快捷鍵列表，請參閱 {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': '獲取 Qwen Code 幫助',
  'show version info': '顯示版本信息',
  'submit a bug report': '提交錯誤報告',
  Status: '狀態',
  'Qwen Code': 'Qwen Code',
  Runtime: '運行環境',
  OS: '操作系統',
  Auth: '認證',
  Model: '模型',
  'Fast Model': '快速模型',
  Sandbox: '沙箱',
  'Session ID': '會話 ID',
  'Base URL': 'Base URL',
  Proxy: '代理',
  'Memory Usage': '內存使用',
  'IDE Client': 'IDE 客戶端',
  'Analyzes the project and creates a tailored QWEN.md file.':
    '分析項目並創建定製的 QWEN.md 檔案',
  'List available Qwen Code tools. Usage: /tools [desc]':
    '列出可用的 Qwen Code 工具。用法：/tools [desc]',
  'List available skills.': '列出可用技能。',
  'Available Qwen Code CLI tools:': '可用的 Qwen Code CLI 工具：',
  'No tools available': '沒有可用工具',
  'View or change the approval mode for tool usage':
    '查看或更改工具使用的審批模式',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    '無效的審批模式 "{{arg}}"。有效模式：{{modes}}',
  'Approval mode set to "{{mode}}"': '審批模式已設置為 "{{mode}}"',
  'View or change the language setting': '查看或更改語言設置',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    '列出背景任務（文字列表；互動式對話框可透過頁腳中的「背景任務」入口開啟）',
  'Delete a previous session': '刪除先前的會話',
  'Run installation and environment diagnostics': '執行安裝與環境診斷',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    '瀏覽動態模型目錄，並選擇要在本機保持啟用的模型',
  'Generate a one-line session recap now': '立即生成一條單行會話回顧',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    '重新命名目前的對話。--auto 會讓快速模型自動產生標題。',
  'Rewind conversation to a previous turn': '將對話回退到先前的某一輪',
  'change the theme': '更改主題',
  'Select Theme': '選擇主題',
  Preview: '預覽',
  '(Use Enter to select, Tab to configure scope)':
    '（使用 Enter 選擇，Tab 配置作用域）',
  '(Use Enter to apply scope, Tab to go back)':
    '（使用 Enter 應用作用域，Tab 返回）',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    '由於 NO_COLOR 環境變量，主題配置不可用。',
  'Theme "{{themeName}}" not found.': '未找到主題 "{{themeName}}"。',
  'Theme "{{themeName}}" not found in selected scope.':
    '在所選作用域中未找到主題 "{{themeName}}"。',
  'Clear conversation history and free up context': '清除對話歷史並釋放上下文',
  'Compresses the context by replacing it with a summary.':
    '通過摘要替換來壓縮上下文',
  'open full Qwen Code documentation in your browser':
    '在瀏覽器中打開完整的 Qwen Code 文檔',
  'Configuration not available.': '配置不可用',
  'Configure authentication information for login': '配置登錄認證信息',
  'Copy the last result or code snippet to clipboard':
    '將最後的結果或代碼片段複製到剪貼板',
  'Show working-tree change stats versus HEAD':
    '顯示工作區相對 HEAD 的變更統計',
  'Could not determine current working directory.': '無法確定當前工作目錄。',
  'Failed to compute git diff stats': '計算 git diff 統計失敗',
  'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.':
    '無可用 diff。可能不是 Git 倉庫、HEAD 缺失，或正在執行 merge/rebase/cherry-pick/revert。',
  'Clean working tree — no changes against HEAD.':
    '工作區乾淨 —— 與 HEAD 無差異。',
  '{{count}} file changed, +{{added}} / -{{removed}}':
    '{{count}} 個檔案變更，+{{added}} / -{{removed}}',
  '{{count}} files changed, +{{added}} / -{{removed}}':
    '{{count}} 個檔案變更，+{{added}} / -{{removed}}',
  '{{count}} file changed': '{{count}} 個檔案變更',
  '{{count}} files changed': '{{count}} 個檔案變更',
  '…and {{hidden}} more (showing first {{shown}})':
    '…還有 {{hidden}} 個（僅顯示前 {{shown}} 個）',
  '(binary)': '（二進位）',
  '(binary, new)': '（二進位，新增）',
  '(new)': '（新增）',
  '(new, partial)': '（新增，部分統計）',
  '(deleted)': '（已刪除）',
  '(binary, deleted)': '（二進位，已刪除）',
  'Manage subagents for specialized task delegation.':
    '管理用於專門任務委派的子智能體',
  'Manage existing subagents (view, edit, delete).':
    '管理現有子智能體（查看、編輯、刪除）',
  'Create a new subagent with guided setup.': '通過引導式設置創建新的子智能體',
  Agents: '智能體',
  'Choose Action': '選擇操作',
  'Edit {{name}}': '編輯 {{name}}',
  'Edit Tools: {{name}}': '編輯工具: {{name}}',
  'Edit Color: {{name}}': '編輯顏色: {{name}}',
  'Delete {{name}}': '刪除 {{name}}',
  'Unknown Step': '未知步驟',
  'Esc to close': '按 Esc 關閉',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter 選擇，↑↓ 導航，Esc 關閉',
  'Esc to go back': '按 Esc 返回',
  'Enter to confirm, Esc to cancel': 'Enter 確認，Esc 取消',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter 選擇，↑↓ 導航，Esc 返回',
  'Enter to submit, Esc to go back': 'Enter 提交，Esc 返回',
  'Invalid step: {{step}}': '無效步驟: {{step}}',
  'No subagents found.': '未找到子智能體。',
  "Use '/agents create' to create your first subagent.":
    "使用 '/agents create' 創建您的第一個子智能體。",
  '(built-in)': '（內置）',
  '(overridden by project level agent)': '（已被項目級智能體覆蓋）',
  'Project Level ({{path}})': '項目級 ({{path}})',
  'User Level ({{path}})': '用戶級 ({{path}})',
  'Built-in Agents': '內置智能體',
  'Extension Agents': '擴展智能體',
  'Using: {{count}} agents': '使用中: {{count}} 個智能體',
  'View Agent': '查看智能體',
  'Edit Agent': '編輯智能體',
  'Delete Agent': '刪除智能體',
  Back: '返回',
  'No agent selected': '未選擇智能體',
  'File Path: ': '檔案路徑: ',
  'Tools: ': '工具: ',
  'Color: ': '顏色: ',
  'Description:': '描述:',
  'System Prompt:': '系統提示:',
  'Open in editor': '在編輯器中打開',
  'Edit tools': '編輯工具',
  'Edit color': '編輯顏色',
  '❌ Error:': '❌ 錯誤:',
  'Are you sure you want to delete agent "{{name}}"?':
    '您確定要刪除智能體 "{{name}}" 嗎？',
  'Project Level (.qwen/agents/)': '項目級 (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': '用戶級 (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ 子智能體創建成功！',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    '子智能體 "{{name}}" 已保存到 {{level}} 級別。',
  'Name: ': '名稱: ',
  'Location: ': '位置: ',
  '❌ Error saving subagent:': '❌ 保存子智能體時出錯:',
  'Warnings:': '警告:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    '名稱 "{{name}}" 在 {{level}} 級別已存在 - 將覆蓋現有子智能體',
  'Name "{{name}}" exists at user level - project level will take precedence':
    '名稱 "{{name}}" 在用戶級別存在 - 項目級別將優先',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    '名稱 "{{name}}" 在項目級別存在 - 現有子智能體將優先',
  'Description is over {{length}} characters': '描述超過 {{length}} 個字符',
  'System prompt is over {{length}} characters':
    '系統提示超過 {{length}} 個字符',
  'Step {{n}}: Choose Location': '步驟 {{n}}: 選擇位置',
  'Step {{n}}: Choose Generation Method': '步驟 {{n}}: 選擇生成方式',
  'Generate with Qwen Code (Recommended)': '使用 Qwen Code 生成（推薦）',
  'Manual Creation': '手動創建',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    '描述此子智能體應該做什麼以及何時使用它。（為了獲得最佳效果，請全面描述）',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    '例如：專業的代碼審查員，根據最佳實踐審查代碼...',
  'Generating subagent configuration...': '正在生成子智能體配置...',
  'Failed to generate subagent: {{error}}': '生成子智能體失敗: {{error}}',
  'Step {{n}}: Describe Your Subagent': '步驟 {{n}}: 描述您的子智能體',
  'Step {{n}}: Enter Subagent Name': '步驟 {{n}}: 輸入子智能體名稱',
  'Step {{n}}: Enter System Prompt': '步驟 {{n}}: 輸入系統提示',
  'Step {{n}}: Enter Description': '步驟 {{n}}: 輸入描述',
  'Step {{n}}: Select Tools': '步驟 {{n}}: 選擇工具',
  'All Tools (Default)': '所有工具（默認）',
  'All Tools': '所有工具',
  'Read-only Tools': '只讀工具',
  'Read & Edit Tools': '讀取和編輯工具',
  'Read & Edit & Execution Tools': '讀取、編輯和執行工具',
  'All tools selected, including MCP tools': '已選擇所有工具，包括 MCP tools',
  'Selected tools:': '已選擇的工具:',
  'Read-only tools:': '只讀工具:',
  'Edit tools:': '編輯工具:',
  'Execution tools:': '執行工具:',
  'Step {{n}}: Choose Background Color': '步驟 {{n}}: 選擇背景顏色',
  'Step {{n}}: Confirm and Save': '步驟 {{n}}: 確認並保存',
  'Esc to cancel': '按 Esc 取消',
  'Press Enter to save, e to save and edit, Esc to go back':
    '按 Enter 保存，e 保存並編輯，Esc 返回',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    '按 Enter 繼續，{{navigation}}Esc {{action}}',
  cancel: '取消',
  'go back': '返回',
  '↑↓ to navigate, ': '↑↓ 導航，',
  'Enter a clear, unique name for this subagent.':
    '為此子智能體輸入一個清晰、唯一的名稱。',
  'e.g., Code Reviewer': '例如：代碼審查員',
  'Name cannot be empty.': '名稱不能為空。',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    '編寫定義此子智能體行為的系統提示。為了獲得最佳效果，請全面描述。',
  'e.g., You are an expert code reviewer...':
    '例如：您是一位專業的代碼審查員...',
  'System prompt cannot be empty.': '系統提示不能為空。',
  'Describe when and how this subagent should be used.':
    '描述何時以及如何使用此子智能體。',
  'e.g., Reviews code for best practices and potential bugs.':
    '例如：審查代碼以查找最佳實踐和潛在錯誤。',
  'Description cannot be empty.': '描述不能為空。',
  'Failed to launch editor: {{error}}': '啟動編輯器失敗: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    '保存並編輯子智能體失敗: {{error}}',
  'Manage Extensions': '管理擴展',
  'Extension Details': '擴展詳情',
  'View Extension': '查看擴展',
  'Update Extension': '更新擴展',
  'Disable Extension': '禁用擴展',
  'Enable Extension': '啟用擴展',
  'Uninstall Extension': '卸載擴展',
  'Select Scope': '選擇作用域',
  'User Scope': '用戶作用域',
  'Workspace Scope': '工作區作用域',
  'No extensions found.': '未找到擴展。',
  'Updating...': '更新中...',
  Unknown: '未知',
  Error: '錯誤',
  'Stopped because': '停止原因',
  'Version:': '版本：',
  'Status:': '狀態：',
  'Are you sure you want to uninstall extension "{{name}}"?':
    '確定要卸載擴展 "{{name}}" 嗎？',
  'This action cannot be undone.': '此操作無法撤銷。',
  'Extension "{{name}}" updated successfully.': '擴展 "{{name}}" 更新成功。',
  'Name:': '名稱：',
  'MCP Servers:': 'MCP Servers：',
  'Settings:': '設置：',
  active: '已啟用',
  disabled: '已禁用',
  enabled: '已啟用',
  'View Details': '查看詳情',
  'Update failed:': '更新失敗：',
  'Updating {{name}}...': '正在更新 {{name}}...',
  'Update complete!': '更新完成！',
  'User (global)': '用戶（全局）',
  'Workspace (project-specific)': '工作區（項目特定）',
  'Disable "{{name}}" - Select Scope': '禁用 "{{name}}" - 選擇作用域',
  'Enable "{{name}}" - Select Scope': '啟用 "{{name}}" - 選擇作用域',
  'No extension selected': '未選擇擴展',
  '{{count}} extensions installed': '已安裝 {{count}} 個擴展',
  "Use '/extensions install' to install your first extension.":
    "使用 '/extensions install' 安裝您的第一個擴展。",
  'up to date': '已是最新',
  'update available': '有可用更新',
  'checking...': '檢查中...',
  'not updatable': '不可更新',
  error: '錯誤',
  'View and edit Qwen Code settings': '查看和編輯 Qwen Code 設置',
  Settings: '設置',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '要查看更改，必須重啟 Qwen Code。按 r 退出並立即應用更改。',
  'Vim Mode': 'Vim 模式',
  'Attribution: commit': '署名：提交',
  'Terminal Bell Notification': '終端響鈴通知',
  'Enable Usage Statistics': '啟用使用統計',
  Theme: '主題',
  'Preferred Editor': '首選編輯器',
  'Auto-connect to IDE': '自動連接到 IDE',
  'Debug Keystroke Logging': '調試按鍵記錄',
  'Language: UI': '語言：界面',
  'Language: Model': '語言：模型',
  'Output Format': '輸出格式',
  'Hide Window Title': '隱藏窗口標題',
  'Show Status in Title': '在標題中顯示狀態',
  'Hide Tips': '隱藏提示',
  'Show Line Numbers in Code': '在代碼中顯示行號',
  'Show Citations': '顯示引用',
  'Custom Witty Phrases': '自定義詼諧短語',
  'Show Welcome Back Dialog': '顯示歡迎回來對話框',
  'Enable User Feedback': '啟用用戶反饋',
  'How is Qwen doing this session? (optional)': 'Qwen 這次表現如何？（可選）',
  Bad: '不滿意',
  Fine: '還行',
  Good: '滿意',
  Dismiss: '忽略',
  'Screen Reader Mode': '屏幕閱讀器模式',
  'Max Session Turns': '最大會話輪次',
  'Skip Next Speaker Check': '跳過下一個說話者檢查',
  'Skip Loop Detection': '跳過循環檢測',
  'Skip Startup Context': '跳過啟動上下文',
  'Enable OpenAI Logging': '啟用 OpenAI 日誌',
  'OpenAI Logging Directory': 'OpenAI 日誌目錄',
  Timeout: '超時',
  'Max Retries': '最大重試次數',
  'Load Memory From Include Directories': '從包含目錄加載內存',
  'Respect .gitignore': '遵守 .gitignore',
  'Respect .qwenignore': '遵守 .qwenignore',
  'Enable Recursive File Search': '啟用遞歸檔案搜索',
  'Interactive Shell (PTY)': '交互式 Shell (PTY)',
  'Show Color': '顯示顏色',
  'Auto Accept': '自動接受',
  'Use Ripgrep': '使用 Ripgrep',
  'Use Builtin Ripgrep': '使用內置 Ripgrep',
  'Tool Output Truncation Threshold': '工具輸出截斷閾值',
  'Tool Output Truncation Lines': '工具輸出截斷行數',
  'Folder Trust': '檔案夾信任',
  'Tool Schema Compliance': 'Tool Schema 兼容性',
  'Auto (detect from system)': '自動（從系統檢測）',
  'Auto (detect terminal theme)': '自動（檢測終端主題）',
  Auto: '自動',
  Text: '文本',
  JSON: 'JSON',
  Plan: '規劃',
  Default: '默認',
  'Auto Edit': '自動編輯',
  YOLO: 'YOLO',
  'toggle vim mode on/off': '切換 vim 模式開關',
  'check session stats. Usage: /stats [model|tools]':
    '檢查會話統計信息。用法：/stats [model|tools]',
  'Show model-specific usage statistics.': '顯示模型相關的使用統計信息',
  'Show tool-specific usage statistics.': '顯示工具相關的使用統計信息',
  'exit the cli': '退出命令行界面',
  'Manage workspace directories': '管理工作區目錄',
  'Add directories to the workspace. Use comma to separate multiple paths':
    '將目錄添加到工作區。使用逗號分隔多個路徑',
  'Show all directories in the workspace': '顯示工作區中的所有目錄',
  'set external editor preference': '設置外部編輯器首選項',
  'Select Editor': '選擇編輯器',
  'Editor Preference': '編輯器首選項',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    '當前支持以下編輯器。請注意，某些編輯器無法在沙箱模式下使用。',
  'Your preferred editor is:': '您的首選編輯器是：',
  'Manage extensions': '管理擴展',
  'Manage installed extensions': '管理已安裝的擴展',
  'Disable an extension': '禁用擴展',
  'Enable an extension': '啟用擴展',
  'Install an extension from a git repo or local path':
    '從 Git 倉庫或本地路徑安裝擴展',
  'Uninstall an extension': '卸載擴展',
  'No extensions installed.': '未安裝擴展。',
  'Extension "{{name}}" not found.': '未找到擴展 "{{name}}"。',
  'No extensions to update.': '沒有可更新的擴展。',
  'Usage: /extensions install <source>': '用法：/extensions install <來源>',
  'Installing extension from "{{source}}"...':
    '正在從 "{{source}}" 安裝擴展...',
  'Extension "{{name}}" installed successfully.': '擴展 "{{name}}" 安裝成功。',
  'Failed to install extension from "{{source}}": {{error}}':
    '從 "{{source}}" 安裝擴展失敗：{{error}}',
  'Do you want to continue? [Y/n]: ': '是否繼續？[Y/n]：',
  'Do you want to continue?': '是否繼續？',
  'Installing extension "{{name}}".': '正在安裝擴展 "{{name}}"。',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**擴展可能會引入意外行為。請確保您已調查過擴展源並信任作者。**',
  'This extension will run the following MCP servers:':
    '此擴展將運行以下 MCP servers：',
  local: '本地',
  remote: '遠程',
  'This extension will add the following commands: {{commands}}.':
    '此擴展將添加以下命令：{{commands}}。',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    '此擴展將使用 {{fileName}} 向您的 QWEN.md 上下文追加信息',
  'This extension will install the following skills:': '此擴展將安裝以下技能：',
  'This extension will install the following subagents:':
    '此擴展將安裝以下子智能體：',
  'Installation cancelled for "{{name}}".': '已取消安裝 "{{name}}"。',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    '您正在安裝來自 {{originSource}} 的擴展。某些功能可能無法完美兼容 Qwen Code。',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref 和 --auto-update 不適用於市場擴展。',
  'Extension "{{name}}" installed successfully and enabled.':
    '擴展 "{{name}}" 安裝成功並已啟用。',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    '要安裝的擴展的 GitHub URL、本地路徑或市場源（marketplace-url:plugin-name）。',
  'The git ref to install from.': '要安裝的 Git 引用。',
  'Enable auto-update for this extension.': '為此擴展啟用自動更新。',
  'Enable pre-release versions for this extension.': '為此擴展啟用預發佈版本。',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    '確認安裝擴展的安全風險並跳過確認提示。',
  'The source argument must be provided.': '必須提供來源參數。',
  'Extension "{{name}}" successfully uninstalled.':
    '擴展 "{{name}}" 卸載成功。',
  'Uninstalls an extension.': '卸載擴展。',
  'The name or source path of the extension to uninstall.':
    '要卸載的擴展的名稱或源路徑。',
  'Please include the name of the extension to uninstall as a positional argument.':
    '請將要卸載的擴展名稱作為位置參數。',
  'Enables an extension.': '啟用擴展。',
  'The name of the extension to enable.': '要啟用的擴展名稱。',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    '啟用擴展的作用域。如果未設置，將在所有作用域中啟用。',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    '擴展 "{{name}}" 已在作用域 "{{scope}}" 中啟用。',
  'Extension "{{name}}" successfully enabled in all scopes.':
    '擴展 "{{name}}" 已在所有作用域中啟用。',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    '無效的作用域：{{scope}}。請使用 {{scopes}} 之一。',
  'Disables an extension.': '禁用擴展。',
  'The name of the extension to disable.': '要禁用的擴展名稱。',
  'The scope to disable the extenison in.': '禁用擴展的作用域。',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    '擴展 "{{name}}" 已在作用域 "{{scope}}" 中禁用。',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    '擴展 "{{name}}" 更新成功：{{oldVersion}} → {{newVersion}}。',
  'Unable to install extension "{{name}}" due to missing install metadata':
    '由於缺少安裝元數據，無法安裝擴展 "{{name}}"',
  'Extension "{{name}}" is already up to date.':
    '擴展 "{{name}}" 已是最新版本。',
  'Updates all extensions or a named extension to the latest version.':
    '將所有擴展或指定擴展更新到最新版本。',
  'Update all extensions.': '更新所有擴展。',
  'The name of the extension to update.': '要更新的擴展名稱。',
  'Either an extension name or --all must be provided':
    '必須提供擴展名稱或 --all',
  'Lists installed extensions.': '列出已安裝的擴展。',
  'Path:': '路徑：',
  'Source:': '來源：',
  'Type:': '類型：',
  'Ref:': '引用：',
  'Release tag:': '發佈標籤：',
  'Enabled (User):': '已啟用（用戶）：',
  'Enabled (Workspace):': '已啟用（工作區）：',
  'Context files:': '上下文檔案：',
  'Skills:': '技能：',
  'Agents:': '智能體：',
  'MCP servers:': 'MCP servers：',
  'Link extension failed to install.': '連結擴展安裝失敗。',
  'Extension "{{name}}" linked successfully and enabled.':
    '擴展 "{{name}}" 連結成功並已啟用。',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    '從本地路徑連結擴展。對本地路徑的更新將始終反映。',
  'The name of the extension to link.': '要連結的擴展名稱。',
  'Set a specific setting for an extension.': '為擴展設置特定配置。',
  'Name of the extension to configure.': '要配置的擴展名稱。',
  'The setting to configure (name or env var).':
    '要配置的設置（名稱或環境變量）。',
  'The scope to set the setting in.': '設置配置的作用域。',
  'List all settings for an extension.': '列出擴展的所有設置。',
  'Name of the extension.': '擴展名稱。',
  'Extension "{{name}}" has no settings to configure.':
    '擴展 "{{name}}" 沒有可配置的設置。',
  'Settings for "{{name}}":': '"{{name}}" 的設置：',
  '(workspace)': '（工作區）',
  '(user)': '（用戶）',
  '[not set]': '［未設置］',
  '[value stored in keychain]': '［值存儲在鑰匙串中］',
  'Value:': '值：',
  'Manage extension settings.': '管理擴展設置。',
  'You need to specify a command (set or list).':
    '您需要指定命令（set 或 list）。',
  'No plugins available in this marketplace.': '此市場中沒有可用的插件。',
  'Select a plugin to install from marketplace "{{name}}":':
    '從市場 "{{name}}" 中選擇要安裝的插件：',
  'Plugin selection cancelled.': '插件選擇已取消。',
  'Select a plugin from "{{name}}"': '從 "{{name}}" 中選擇插件',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    '使用 ↑↓ 或 j/k 導航，Enter 選擇，Escape 取消',
  '{{count}} more above': '上方還有 {{count}} 項',
  '{{count}} more below': '下方還有 {{count}} 項',
  'manage IDE integration': '管理 IDE 集成',
  'check status of IDE integration': '檢查 IDE 集成狀態',
  'install required IDE companion for {{ideName}}':
    '安裝 {{ideName}} 所需的 IDE 配套工具',
  'enable IDE integration': '啟用 IDE 集成',
  'disable IDE integration': '禁用 IDE 集成',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    '您當前環境不支持 IDE 集成。要使用此功能，請在以下支持的 IDE 之一中運行 Qwen Code：VS Code 或 VS Code 分支版本。',
  'Set up GitHub Actions': '設置 GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    '配置終端按鍵綁定以支持多行輸入（VS Code、Cursor、Windsurf、Trae）',
  'Please restart your terminal for the changes to take effect.':
    '請重啟終端以使更改生效。',
  'Failed to configure terminal: {{error}}': '配置終端失敗：{{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    '無法確定 {{terminalName}} 在 Windows 上的配置路徑：未設置 APPDATA 環境變量。',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json 存在但不是有效的 JSON 數組。請手動修復檔案或刪除它以允許自動配置。',
  'File: {{file}}': '檔案：{{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    '解析 {{terminalName}} keybindings.json 失敗。檔案包含無效的 JSON。請手動修復檔案或刪除它以允許自動配置。',
  'Error: {{error}}': '錯誤：{{error}}',
  'Shift+Enter binding already exists': 'Shift+Enter 綁定已存在',
  'Ctrl+Enter binding already exists': 'Ctrl+Enter 綁定已存在',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    '檢測到現有按鍵綁定。為避免衝突，不會修改。',
  'Please check and modify manually if needed: {{file}}':
    '如有需要，請手動檢查並修改：{{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    '已為 {{terminalName}} 添加 Shift+Enter 和 Ctrl+Enter 按鍵綁定。',
  'Modified: {{file}}': '已修改：{{file}}',
  '{{terminalName}} keybindings already configured.':
    '{{terminalName}} 按鍵綁定已配置。',
  'Failed to configure {{terminalName}}.': '配置 {{terminalName}} 失敗。',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    '您的終端已配置為支持多行輸入（Shift+Enter 和 Ctrl+Enter）的最佳體驗。',
  'Manage Qwen Code hooks': '管理 Qwen Code Hook',
  'List all configured hooks': '列出所有已配置的 Hook',
  Hooks: 'Hook',
  'Loading hooks...': '正在加載 Hook...',
  'Error loading hooks:': '加載 Hook 出錯：',
  'Press Escape to close': '按 Escape 關閉',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    '按 Escape、Ctrl+C 或 Ctrl+D 取消',
  'Press Space, Enter, or Escape to dismiss': '按 Space、Enter 或 Escape 關閉',
  'No hook selected': '未選擇 Hook',
  'No hook events found.': '未找到 Hook 事件。',
  '{{count}} hook configured': '{{count}} 個 Hook 已配置',
  '{{count}} hooks configured': '{{count}} 個 Hook 已配置',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    '此選單為只讀。要添加或修改 Hook，請直接編輯 settings.json 或詢問 Qwen Code。',
  'Enter to select · Esc to cancel': 'Enter 選擇 · Esc 取消',
  'Exit codes:': '退出碼：',
  'Configured hooks:': '已配置的 Hook：',
  'No hooks configured for this event.': '此事件未配置 Hook。',
  'To add hooks, edit settings.json directly or ask Qwen.':
    '要添加 Hook，請直接編輯 settings.json 或詢問 Qwen。',
  'Enter to select · Esc to go back': 'Enter 選擇 · Esc 返回',
  'Hook details': 'Hook 詳情',
  'Event:': '事件：',
  'Extension:': '擴展：',
  'Desc:': '描述：',
  'No hook config selected': '未選擇 Hook 配置',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    '要修改或刪除此 Hook，請直接編輯 settings.json 或詢問 Qwen。',
  'Hook Configuration - Disabled': 'Hook 配置 - 已禁用',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    '所有 Hook 當前已禁用。您有 {{count}} 未運行。',
  '{{count}} configured hook': '{{count}} 個已配置的 Hook',
  '{{count}} configured hooks': '{{count}} 個已配置的 Hook',
  'When hooks are disabled:': '當 Hook 被禁用時：',
  'No hook commands will execute': '不會執行任何 Hook 命令',
  'StatusLine will not be displayed': '不會顯示狀態欄',
  'Tool operations will proceed without hook validation':
    '工具操作將在沒有 Hook 驗證的情況下繼續',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    '要重新啟用 Hook，請從 settings.json 中刪除 "disableAllHooks" 或詢問 Qwen Code。',
  Project: '項目',
  User: '用戶',
  Skill: '技能',
  System: '系統',
  Extension: '擴展',
  'Local Settings': '本地設置',
  'User Settings': '用戶設置',
  'System Settings': '系統設置',
  Extensions: '擴展',
  'Session (temporary)': '會話（臨時）',
  'Before tool execution': '工具執行前',
  'After tool execution': '工具執行後',
  'After tool execution fails': '工具執行失敗後',
  'When notifications are sent': '發送通知時',
  'When the user submits a prompt': '用戶提交提示時',
  'When a new session is started': '新會話開始時',
  'Right before Qwen Code concludes its response': 'Qwen Code 結束響應之前',
  'When a subagent (Agent tool call) is started':
    '子智能體（Agent 工具調用）啟動時',
  'Right before a subagent concludes its response': '子智能體結束響應之前',
  'Before conversation compaction': '對話壓縮前',
  'When a session is ending': '會話結束時',
  'When a permission dialog is displayed': '顯示權限對話框時',
  'Input to command is JSON of tool call arguments.':
    '命令輸入為工具調用參數的 JSON。',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    '命令輸入為包含 "inputs"（工具調用參數）和 "response"（工具調用響應）字段的 JSON。',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    '命令輸入為包含 tool_name、tool_input、tool_use_id、error、error_type、is_interrupt 和 is_timeout 的 JSON。',
  'Input to command is JSON with notification message and type.':
    '命令輸入為包含通知消息和類型的 JSON。',
  'Input to command is JSON with original user prompt text.':
    '命令輸入為包含原始用戶提示文本的 JSON。',
  'Input to command is JSON with session start source.':
    '命令輸入為包含會話啟動來源的 JSON。',
  'Input to command is JSON with session end reason.':
    '命令輸入為包含會話結束原因的 JSON。',
  'Input to command is JSON with agent_id and agent_type.':
    '命令輸入為包含 agent_id 和 agent_type 的 JSON。',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    '命令輸入為包含 agent_id、agent_type 和 agent_transcript_path 的 JSON。',
  'Input to command is JSON with compaction details.':
    '命令輸入為包含壓縮詳情的 JSON。',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    '命令輸入為包含 tool_name、tool_input 和 tool_use_id 的 JSON。輸出包含 hookSpecificOutput 的 JSON，其中包含允許或拒絕的決定。',
  'stdout/stderr not shown': 'stdout/stderr 不顯示',
  'show stderr to model and continue conversation':
    '向模型顯示 stderr 並繼續對話',
  'show stderr to user only': '僅向用戶顯示 stderr',
  'stdout shown in transcript mode (ctrl+o)': 'stdout 以轉錄模式顯示 (ctrl+o)',
  'show stderr to model immediately': '立即向模型顯示 stderr',
  'show stderr to user only but continue with tool call':
    '僅向用戶顯示 stderr 但繼續工具調用',
  'block processing, erase original prompt, and show stderr to user only':
    '阻止處理，擦除原始提示，僅向用戶顯示 stderr',
  'stdout shown to Qwen': '向 Qwen 顯示 stdout',
  'show stderr to user only (blocking errors ignored)':
    '僅向用戶顯示 stderr（忽略阻塞錯誤）',
  'command completes successfully': '命令成功完成',
  'stdout shown to subagent': '向子智能體顯示 stdout',
  'show stderr to subagent and continue having it run':
    '向子智能體顯示 stderr 並繼續運行',
  'stdout appended as custom compact instructions':
    'stdout 作為自定義壓縮指令追加',
  'block compaction': '阻止壓縮',
  'show stderr to user only but continue with compaction':
    '僅向用戶顯示 stderr 但繼續壓縮',
  'use hook decision if provided': '如果提供則使用 Hook 決定',
  'Config not loaded.': '配置未加載。',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Hook 未啟用。請在設置中啟用 Hook 以使用此功能。',
  'Export current session message history to a file':
    '將當前會話的消息記錄導出到檔案',
  'Export session to HTML format': '將會話導出為 HTML 檔案',
  'Export session to JSON format': '將會話導出為 JSON 檔案',
  'Export session to JSONL format (one message per line)':
    '將會話導出為 JSONL 檔案（每行一條消息）',
  'Export session to markdown format': '將會話導出為 Markdown 檔案',
  'generate personalized programming insights from your chat history':
    '根據你的聊天記錄生成個性化編程洞察',
  'Resume a previous session': '恢復先前會話',
  'Fork the current conversation into a new session': '將目前對話分支到新會話',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    '回應或工具呼叫正在進行時無法分支。請等待其完成或處理待確認的工具呼叫。',
  'No conversation to branch.': '沒有可分支的對話。',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    '恢復某次工具調用。這將把對話與檔案歷史重置到提出該工具調用建議時的狀態',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    '無法檢測終端類型。支持的終端：VS Code、Cursor、Windsurf 和 Trae。',
  'Terminal "{{terminal}}" is not supported yet.':
    '終端 "{{terminal}}" 尚未支持。',
  'Invalid language. Available: {{options}}':
    '無效的語言。可用選項：{{options}}',
  'Language subcommands do not accept additional arguments.':
    '語言子命令不接受額外參數',
  'Current UI language: {{lang}}': '當前 UI 語言：{{lang}}',
  'Current LLM output language: {{lang}}': '當前 LLM 輸出語言：{{lang}}',
  'Set UI language': '設置 UI 語言',
  'Set LLM output language': '設置 LLM 輸出語言',
  'Usage: /language ui [{{options}}]': '用法：/language ui [{{options}}]',
  'Usage: /language output <language>': '用法：/language output <語言>',
  'Example: /language output 中文': '示例：/language output 中文',
  'Example: /language output English': '示例：/language output English',
  'Example: /language output 日本語': '示例：/language output 日本語',
  'UI language changed to {{lang}}': 'UI 語言已更改為 {{lang}}',
  'LLM output language set to {{lang}}': 'LLM 輸出語言已設置為 {{lang}}',
  'Please restart the application for the changes to take effect.':
    '請重啟應用程序以使更改生效。',
  'Failed to generate LLM output language rule file: {{error}}':
    '生成 LLM 輸出語言規則檔案失敗：{{error}}',
  'Invalid command. Available subcommands:': '無效的命令。可用的子命令：',
  'Available subcommands:': '可用的子命令：',
  'To request additional UI language packs, please open an issue on GitHub.':
    '如需請求其他 UI 語言包，請在 GitHub 上提交 issue',
  'Available options:': '可用選項：',
  'Set UI language to {{name}}': '將 UI 語言設置為 {{name}}',
  'Tool Approval Mode': '工具審批模式',
  '{{mode}} mode': '{{mode}} 模式',
  'Analyze only, do not modify files or execute commands':
    '僅分析，不修改檔案或執行命令',
  'Require approval for file edits or shell commands':
    '需要批准檔案編輯或 shell 命令',
  'Automatically approve file edits': '自動批准檔案編輯',
  'Automatically approve all tools': '自動批准所有工具',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    '工作區審批模式已存在並具有優先級。用戶級別的更改將無效。',
  'Apply To': '應用於',
  'Workspace Settings': '工作區設置',
  'Open auto-memory folder': '打開自動記憶檔案夾',
  'Auto-memory: {{status}}': '自動記憶：{{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    '自動整理：{{status}} · {{lastDream}} · /dream 立即運行',
  never: '從未',
  on: '開',
  off: '關',
  'Remove matching entries from managed auto-memory.':
    '從託管自動記憶中刪除匹配的條目。',
  'Usage: /forget <memory text to remove>': '用法：/forget <要刪除的記憶文本>',
  'No managed auto-memory entries matched: {{query}}':
    '沒有匹配的託管自動記憶條目：{{query}}',
  'Consolidate managed auto-memory topic files.': '整理託管自動記憶主題檔案',
  'Open MCP management dialog': '打開 MCP 管理對話框',
  'Could not retrieve tool registry.': '無法檢索工具註冊表',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "成功認證並刷新了 '{{name}}' 的工具",
  "Re-discovering tools from '{{name}}'...":
    "正在重新發現 '{{name}}' 的工具...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "從 '{{name}}' 發現了 {{count}} 個工具。",
  'Authentication complete. Returning to server details...':
    '認證完成，正在返回伺服器詳情...',
  'Authentication successful.': '認證成功。',
  'Manage MCP servers': '管理 MCP servers',
  'Server Detail': '伺服器詳情',
  Tools: '工具',
  'Tool Detail': '工具詳情',
  'Loading...': '加載中...',
  'Unknown step': '未知步驟',
  'Esc to back': 'Esc 返回',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ 導航 · Enter 選擇 · Esc 關閉',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ 導航 · Enter 選擇 · Esc 返回',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ 導航 · Enter 確認 · Esc 返回',
  'User Settings (global)': '用戶設置（全局）',
  'Workspace Settings (project-specific)': '工作區設置（項目級）',
  'Disable server:': '禁用伺服器：',
  'Select where to add the server to the exclude list:':
    '選擇將伺服器添加到排除列表的位置：',
  'Press Enter to confirm, Esc to cancel': '按 Enter 確認，Esc 取消',
  'View tools': '查看工具',
  Reconnect: '重新連接',
  Enable: '啟用',
  Disable: '禁用',
  Authenticate: '認證',
  'Re-authenticate': '重新認證',
  'Clear Authentication': '清空認證',
  'Server:': '伺服器：',
  'Command:': '命令：',
  'Working Directory:': '工作目錄：',
  'No server selected': '未選擇伺服器',
  prompts: '提示詞',
  'Error:': '錯誤：',
  tool: '工具',
  tools: '個工具',
  connected: '已連接',
  connecting: '連接中',
  disconnected: '已斷開',
  'User MCPs': '用戶 MCP',
  'Project MCPs': '項目 MCP',
  'Extension MCPs': '擴展 MCP',
  server: '個伺服器',
  servers: '個伺服器',
  'Add MCP servers to your settings to get started.':
    '請在設置中添加 MCP servers 以開始使用。',
  'Run qwen --debug to see error logs': '運行 qwen --debug 查看錯誤日誌',
  'OAuth Authentication': 'OAuth 認證',
  'Authenticating... Please complete the login in your browser.':
    '認證中... 請在瀏覽器中完成登錄。',
  'Press c to copy the authorization URL to your clipboard.':
    '按 c 複製授權 URL 到剪貼板。',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    '已向終端發送複製請求；若粘貼為空，請手動複製上方 URL。',
  'Cannot write to terminal — copy the URL above manually.':
    '無法寫入終端，請手動複製上方 URL。',
  'No tools available for this server.': '此伺服器沒有可用工具。',
  destructive: '破壞性',
  'read-only': '只讀',
  'open-world': '開放世界',
  idempotent: '冪等',
  'Tools for {{serverName}}': '{{serverName}} 的工具',
  '{{current}}/{{total}}': '{{current}}/{{total}}',
  required: '必填',
  Parameters: '參數',
  'No tool selected': '未選擇工具',
  Server: '伺服器',
  '{{count}} invalid tools': '{{count}} 個無效工具',
  invalid: '無效',
  'invalid: {{reason}}': '無效：{{reason}}',
  'missing name': '缺少名稱',
  'missing description': '缺少描述',
  '(unnamed)': '(未命名)',
  'Warning: This tool cannot be called by the LLM':
    '警告：此工具無法被 LLM 調用',
  Reason: '原因',
  'Tools must have both name and description to be used by the LLM.':
    '工具必須同時具有名稱和描述才能被 LLM 使用。',
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    '生成項目摘要並保存到 .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    '沒有可用的聊天客戶端來生成摘要',
  'Already generating summary, wait for previous request to complete':
    '正在生成摘要，請等待上一個請求完成',
  'No conversation found to summarize.': '未找到要總結的對話',
  'Failed to generate project context summary: {{error}}':
    '生成項目上下文摘要失敗：{{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    '項目摘要已保存到 {{filePathForDisplay}}',
  'Saving project summary...': '正在保存項目摘要...',
  'Generating project summary...': '正在生成項目摘要...',
  'Processing summary...': '正在處理摘要...',
  'Project summary generated and saved successfully!':
    '項目摘要已生成並成功保存！',
  'Saved to: {{filePath}}': '儲存至：{{filePath}}',
  'Failed to generate summary - no text content received from LLM response':
    '生成摘要失敗 - 未從 LLM 響應中接收到文本內容',
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    '切換此會話的模型（--fast 可設置建議模型）',
  'Set a lighter model for prompt suggestions and speculative execution':
    '設置用於輸入建議和推測執行的輕量模型',
  'Content generator configuration not available.': '內容生成器配置不可用',
  'Authentication type not available.': '認證類型不可用',
  'No models available for the current authentication type ({{authType}}).':
    '當前認證類型 ({{authType}}) 沒有可用的模型',
  // Needs translation
  'Starting a new session, resetting chat, and clearing terminal.':
    '正在開始新會話，重置聊天並清屏。',
  'Starting a new session and clearing.': '正在開始新會話並清屏。',
  'Already compressing, wait for previous request to complete':
    '正在壓縮中，請等待上一個請求完成',
  'Failed to compress chat history.': '壓縮聊天歷史失敗',
  'Failed to compress chat history: {{error}}': '壓縮聊天歷史失敗：{{error}}',
  'Compressing chat history': '正在壓縮聊天歷史',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    '聊天歷史已從 {{originalTokens}} 個 token 壓縮到 {{newTokens}} 個 token。',
  'Compression was not beneficial for this history size.':
    '對於此歷史記錄大小，壓縮沒有益處。',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    '聊天歷史壓縮未能減小大小。這可能表明壓縮提示存在問題。',
  'Could not compress chat history due to a token counting error.':
    '由於 token 計數錯誤，無法壓縮聊天歷史。',
  'Configuration is not available.': '配置不可用。',
  'Please provide at least one path to add.': '請提供至少一個要添加的路徑。',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    '/directory add 命令在限制性沙箱配置檔案中不受支持。請改為在啟動會話時使用 --include-directories。',
  "Error adding '{{path}}': {{error}}": "添加 '{{path}}' 時出錯：{{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    '如果存在，已成功從以下目錄添加 QWEN.md 檔案：\n- {{directories}}',
  'Error refreshing memory: {{error}}': '刷新內存時出錯：{{error}}',
  'Successfully added directories:\n- {{directories}}':
    '成功添加目錄：\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    '當前工作區目錄：\n{{directories}}',
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    '請在瀏覽器中打開以下 URL 以查看文檔：\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    '正在瀏覽器中打開文檔：{{url}}',
  'Do you want to proceed?': '是否繼續？',
  'Yes, allow once': '是，允許一次',
  'Allow always': '總是允許',
  Yes: '是',
  No: '否',
  'No (esc)': '否 (esc)',
  'Modify in progress:': '正在修改：',
  'Save and close external editor to continue': '保存並關閉外部編輯器以繼續',
  'Apply this change?': '是否應用此更改？',
  'Yes, allow always': '是，總是允許',
  'Modify with external editor': '使用外部編輯器修改',
  'No, suggest changes (esc)': '否，建議更改 (esc)',
  "Allow execution of: '{{command}}'?": "允許執行：'{{command}}'？",
  'Always allow in this project': '在本項目中總是允許',
  'Always allow {{action}} in this project': '在本項目中總是允許{{action}}',
  'Always allow for this user': '對該用戶總是允許',
  'Always allow {{action}} for this user': '對該用戶總是允許{{action}}',
  'Yes, restore previous mode ({{mode}})': '是，恢復之前的模式 ({{mode}})',
  'Yes, and auto-accept edits': '是，並自動接受編輯',
  'Yes, and manually approve edits': '是，並手動批准編輯',
  'No, keep planning (esc)': '否，繼續規劃 (esc)',
  'URLs to fetch:': '要獲取的 URL：',
  'MCP Server: {{server}}': 'MCP Server：{{server}}',
  'Tool: {{tool}}': '工具：{{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    '允許執行來自 MCP server "{{server}}" 的 MCP tool "{{tool}}"？',
  'Shell Command Execution': 'Shell 命令執行',
  'A custom command wants to run the following shell commands:':
    '自定義命令想要運行以下 shell 命令：',
  'Current Plan:': '當前計劃：',
  'Progress: {{done}}/{{total}} tasks completed':
    '進度：已完成 {{done}}/{{total}} 個任務',
  ', {{inProgress}} in progress': '，{{inProgress}} 個進行中',
  'Pending Tasks:': '待處理任務：',
  'What would you like to do?': '您想要做什麼？',
  'Choose how to proceed with your session:': '選擇如何繼續您的會話：',
  'Start new chat session': '開始新的聊天會話',
  'Continue previous conversation': '繼續之前的對話',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 歡迎回來！（最後更新：{{timeAgo}}）',
  '🎯 Overall Goal:': '🎯 總體目標：',
  'Select Authentication Method': '選擇認證方式',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    '您必須選擇認證方法才能繼續。再次按 Ctrl+C 退出',
  'Terms of Services and Privacy Notice': '服務條款和隱私聲明',
  'Qwen OAuth': 'Qwen OAuth (免費)',
  'Discontinued — switch to Coding Plan or API Key':
    '已停用 — 請切換到 Coding Plan 或 API Key',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Qwen OAuth 免費額度已於 2026-04-15 停用。請選擇 Coding Plan 或 API Key。',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Qwen OAuth免費層已於2026-04-15停止服務。請選擇其他提供商的模型或運行 /auth 切換。',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Qwen OAuth 免費額度已於 2026-04-15 停用。請選擇其他選項。\n',
  'Paid · Up to 6,000 requests/5 hrs · All Alibaba Cloud Coding Plan Models':
    '付費 · 每 5 小時最多 6,000 次請求 · 支持阿里雲百鍊 Coding Plan 全部模型',
  'For teams · Paid · Up to 6,000 requests/5 hrs · All Alibaba Cloud Coding Plan Models':
    '適合團隊 · 付費 · 每 5 小時最多 6,000 次請求 · 支援阿里雲百鍊 Coding Plan 全部模型',
  'For individual developers · Pay per model call · 5-hour/weekly quotas':
    '適合個人開發場景 · 按模型調用次數計費 · 每 5 小時/每週限額',
  Subscribe: '訂閱計劃',
  'Paid subscription plans from Alibaba Cloud ModelStudio':
    'Alibaba Cloud ModelStudio 付費訂閱計劃',
  'Select Subscription Plan': '選擇訂閱計劃',
  'Alibaba Cloud Coding Plan': '阿里雲百鍊 Coding Plan',
  'Alibaba Cloud Token Plan': '阿里雲百鍊 Token Plan',
  'Pay-as-you-go tokens · Configure ModelStudio standard API key':
    '按 Token 付費 · 配置 ModelStudio 標準 API Key',
  'For individuals · Pay-as-you-go tokens · Dedicated Token Plan endpoint':
    '適合個人 · 按 Token 付費 · 使用獨立 Token Plan Endpoint',
  'For teams/companies · Credits deducted by token usage · Dedicated API key and base URL':
    '適合一人公司/團隊/企業 · 按 Token 消耗抵扣 Credits · 專屬 API Key 和 Base URL',
  'Token Plan documentation': 'Token Plan 參考文檔',
  'Bring your own API key': '使用自己的 API Key',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    '基於瀏覽器的第三方提供商認證（例如 OpenRouter、ModelScope）',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    '認證方式被強制設置為 {{enforcedType}}，但您當前使用的是 {{currentType}}',
  'Qwen OAuth Authentication': 'Qwen OAuth 認證',
  'Please visit this URL to authorize:': '請訪問此 URL 進行授權：',
  'Waiting for authorization': '等待授權中',
  'Time remaining:': '剩餘時間：',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth 認證超時',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth 令牌已過期（超過 {{seconds}} 秒）。請重新選擇認證方法',
  'Press any key to return to authentication type selection.':
    '按任意鍵返回認證類型選擇',
  'Waiting for Qwen OAuth authentication...': '正在等待 Qwen OAuth 認證...',
  'Authentication timed out. Please try again.': '認證超時。請重試。',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    '正在等待認證...（按 ESC 或 CTRL+C 取消）',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容認證的 API Key。請設置 settings.security.auth.apiKey 或設置 {{envKeyHint}} 環境變量。',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 環境變量。請在 .env 檔案或系統環境變量中進行設置。',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    '未找到 {{envKeyHint}} 環境變量（或設置 settings.security.auth.apiKey）。請在 .env 檔案或系統環境變量中進行設置。',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    '缺少 OpenAI 兼容認證的 API Key。請設置 {{envKeyHint}} 環境變量。',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Anthropic 提供商缺少必需的 baseUrl，請在 modelProviders[].baseUrl 中配置。',
  'ANTHROPIC_BASE_URL environment variable not found.':
    '未找到 ANTHROPIC_BASE_URL 環境變量。',
  'Invalid auth method selected.': '選擇了無效的認證方式。',
  'Failed to authenticate. Message: {{message}}': '認證失敗。消息：{{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    '使用 {{authType}} 憑據成功認證。',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    '無效的 QWEN_DEFAULT_AUTH_TYPE 值："{{value}}"。有效值為：{{validValues}}',
  'Select Model': '選擇模型',
  'API Key': 'API Key',
  '(default)': '(默認)',
  '(not set)': '(未設置)',
  Modality: '模態',
  'Context Window': '上下文窗口',
  text: '文本',
  'text-only': '純文本',
  image: '圖像',
  pdf: 'PDF',
  audio: '音頻',
  video: '視頻',
  'not set': '未設置',
  none: '無',
  unknown: '未知',
  'Manage folder trust settings': '管理檔案夾信任設置',
  'Manage permission rules': '管理 permission rules',
  Allow: '允許',
  Ask: '詢問',
  Deny: '拒絕',
  Workspace: '工作區',
  "Qwen Code won't ask before using allowed tools.":
    'Qwen Code 使用已允許的工具前不會詢問。',
  'Qwen Code will ask before using these tools.':
    'Qwen Code 使用這些工具前會先詢問。',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code 不允許使用被拒絕的工具。',
  'Manage trusted directories for this workspace.':
    '管理此工作區的受信任目錄。',
  'Any use of the {{tool}} tool': '{{tool}} 工具的任何使用',
  "{{tool}} commands matching '{{pattern}}'":
    "匹配 '{{pattern}}' 的 {{tool}} 命令",
  'From user settings': '來自用戶設置',
  'From project settings': '來自項目設置',
  'From session': '來自會話',
  'Project settings': '項目設置',
  'Checked in at .qwen/settings.json': '保存在 .qwen/settings.json',
  'User settings': '用戶設置',
  'Saved in at ~/.qwen/settings.json': '保存在 ~/.qwen/settings.json',
  'Add a new rule…': '添加新規則…',
  'Add {{type}} permission rule': '添加 {{type}} permission rule',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'permission rules 是工具名稱，可選地後跟括號中的限定符。',
  'e.g.,': '例如',
  or: '或',
  'Enter permission rule…': '輸入 permission rule…',
  'Enter to submit · Esc to cancel': 'Enter 提交 · Esc 取消',
  'Where should this rule be saved?': '此規則應保存在哪裏？',
  'Enter to confirm · Esc to cancel': 'Enter 確認 · Esc 取消',
  'Delete {{type}} rule?': '刪除{{type}}規則？',
  'Are you sure you want to delete this permission rule?':
    '確定要刪除此 permission rule 嗎？',
  'Permissions:': '權限：',
  '(←/→ or tab to cycle)': '（←/→ 或 Tab 切換）',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    '按 ↑↓ 導航 · Enter 選擇 · 輸入搜索 · Esc 取消',
  'Search…': '搜索…',
  'Add directory…': '添加目錄…',
  'Add directory to workspace': '添加工作區目錄',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code 可以讀取工作區中的檔案，並在自動接受編輯模式開啟時進行編輯。',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code 將能夠讀取此目錄中的檔案，並在自動接受編輯模式開啟時進行編輯。',
  'Enter the path to the directory:': '輸入目錄路徑：',
  'Enter directory path…': '輸入目錄路徑…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab 補全 · Enter 添加 · Esc 取消',
  'Remove directory?': '刪除目錄？',
  'Are you sure you want to remove this directory from the workspace?':
    '確定要將此目錄從工作區中移除嗎？',
  '  (Original working directory)': '  （原始工作目錄）',
  '  (from settings)': '  （來自設置）',
  'Directory does not exist.': '目錄不存在。',
  'Path is not a directory.': '路徑不是目錄。',
  'This directory is already in the workspace.': '此目錄已在工作區中。',
  'Already covered by existing directory: {{dir}}': '已被現有目錄覆蓋：{{dir}}',
  'Using:': '已加載: ',
  '{{count}} open file': '{{count}} 個打開的檔案',
  '{{count}} open files': '{{count}} 個打開的檔案',
  '(ctrl+g to view)': '（按 ctrl+g 查看）',
  '{{count}} {{name}} file': '{{count}} 個 {{name}} 檔案',
  '{{count}} {{name}} files': '{{count}} 個 {{name}} 檔案',
  '{{count}} MCP server': '{{count}} 個 MCP server',
  '{{count}} MCP servers': '{{count}} 個 MCP servers',
  '{{count}} Blocked': '{{count}} 個已阻止',
  '(ctrl+t to view)': '（按 ctrl+t 查看）',
  '(ctrl+t to toggle)': '（按 ctrl+t 切換）',
  'Press Ctrl+C again to exit.': '再次按 Ctrl+C 退出',
  'Press Ctrl+D again to exit.': '再次按 Ctrl+D 退出',
  'Press Esc again to clear.': '再次按 Esc 清除',
  'Press ↑ to edit queued messages': '按 ↑ 編輯排隊消息',
  'No MCP servers configured.': '未配置 MCP servers',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers 正在啟動（{{count}} 個正在初始化）...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    '注意：首次啟動可能需要更長時間。工具可用性將自動更新',
  'Configured MCP servers:': '已配置的 MCP servers：',
  Ready: '就緒',
  'Starting... (first startup may take longer)':
    '正在啟動...（首次啟動可能需要更長時間）',
  Disconnected: '已斷開連接',
  '{{count}} tool': '{{count}} 個工具',
  '{{count}} tools': '{{count}} 個工具',
  '{{count}} prompt': '{{count}} 個提示',
  '{{count}} prompts': '{{count}} 個提示',
  '(from {{extensionName}})': '（來自 {{extensionName}}）',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth 已過期',
  'OAuth not authenticated': 'OAuth 未認證',
  'tools and prompts will appear when ready': '工具和提示將在就緒時顯示',
  '{{count}} tools cached': '{{count}} 個工具已緩存',
  'Tools:': '工具：',
  'Parameters:': '參數：',
  'Prompts:': '提示：',
  Blocked: '已阻止',
  '💡 Tips:': '💡 提示：',
  Use: '使用',
  'to show server and tool descriptions': '顯示伺服器和工具描述',
  'to show tool parameter schemas': '顯示 tool parameter schemas',
  'to hide descriptions': '隱藏描述',
  'to authenticate with OAuth-enabled servers':
    '使用支持 OAuth 的伺服器進行認證',
  Press: '按',
  'to toggle tool descriptions on/off': '切換工具描述開關',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "正在為 MCP server '{{name}}' 啟動 OAuth 認證...",
  'Tips:': '提示：',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    '對話變長時用 /compress，總結歷史並釋放上下文。',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    '用 /clear 或 /new 開啟新思路；之前的會話會保留在歷史記錄中。',
  'Use /bug to submit issues to the maintainers when something goes off.':
    '遇到問題時，用 /bug 將問題提交給維護者。',
  'Switch auth type quickly with /auth.': '用 /auth 快速切換認證方式。',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    '在 Qwen Code 中使用 ! 可運行任意 shell 命令（例如 !ls）。',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    '輸入 / 打開命令彈窗；按 Tab 自動補全斜槓命令和保存的提示詞。',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    '運行 qwen --continue 或 qwen --resume 可繼續之前的會話。',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    '按 Shift+Tab 或輸入 /approval-mode 可快速切換權限模式。',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    '按 Tab 或輸入 /approval-mode 可快速切換權限模式。',
  'Try /insight to generate personalized insights from your chat history.':
    '試試 /insight，從聊天記錄中生成個性化洞察。',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    '按 Ctrl+O 切換緊湊模式 ── 隱藏工具輸出和思考過程，界面更簡潔。',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    '添加 QWEN.md 檔案，為 Qwen Code 提供持久的項目上下文。',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    '用 /btw 快速問一個小問題，不會打斷當前對話。',
  'Context is almost full! Run /compress now or start /new to continue.':
    '上下文即將用滿！請立即執行 /compress 或使用 /new 開啟新會話。',
  'Context is getting full. Use /compress to free up space.':
    '上下文空間不足，用 /compress 釋放空間。',
  'Long conversation? /compress summarizes history to free context.':
    '對話太長？用 /compress 總結歷史，釋放上下文。',
  'Agent powering down. Goodbye!': 'Qwen Code 正在關閉，再見！',
  'To continue this session, run': '要繼續此會話，請運行',
  'Interaction Summary': '交互摘要',
  'Session ID:': '會話 ID：',
  'Tool Calls:': '工具調用：',
  'Success Rate:': '成功率：',
  'User Agreement:': '用戶同意率：',
  reviewed: '已審覈',
  'Code Changes:': '代碼變更：',
  Performance: '性能',
  'Wall Time:': '總耗時：',
  'Agent Active:': '智能體活躍時間：',
  'API Time:': 'API 時間：',
  'Tool Time:': '工具時間：',
  'Session Stats': '會話統計',
  'Model Usage': '模型使用情況',
  Reqs: '請求數',
  'Input Tokens': '輸入 token 數',
  'Output Tokens': '輸出 token 數',
  'Savings Highlight:': '節省亮點：',
  'of input tokens were served from the cache, reducing costs.':
    '從緩存載入 token ，降低了成本',
  'Tip: For a full token breakdown, run `/stats model`.':
    '提示：要查看完整的令牌明細，請運行 `/stats model`',
  'Model Stats For Nerds': '模型統計（技術細節）',
  'Tool Stats For Nerds': '工具統計（技術細節）',
  Metric: '指標',
  API: 'API',
  Requests: '請求數',
  Errors: '錯誤數',
  'Avg Latency': '平均延遲',
  Tokens: '令牌',
  Total: '總計',
  Prompt: '提示',
  Cached: '緩存',
  Thoughts: '思考',
  Output: '輸出',
  'No API calls have been made in this session.':
    '本次會話中未進行任何 API 調用',
  'Tool Name': '工具名稱',
  Calls: '調用次數',
  'Success Rate': '成功率',
  'Avg Duration': '平均耗時',
  'User Decision Summary': '用戶決策摘要',
  'Total Reviewed Suggestions:': '已審覈建議總數：',
  ' » Accepted:': ' » 已接受：',
  ' » Rejected:': ' » 已拒絕：',
  ' » Modified:': ' » 已修改：',
  ' Overall Agreement Rate:': ' 總體同意率：',
  'No tool calls have been made in this session.':
    '本次會話中未進行任何工具調用',
  'Session start time is unavailable, cannot calculate stats.':
    '會話開始時間不可用，無法計算統計信息',
  'Command Format Migration': '命令格式遷移',
  'Found {{count}} TOML command file:': '發現 {{count}} 個 TOML 命令檔案：',
  'Found {{count}} TOML command files:': '發現 {{count}} 個 TOML 命令檔案：',
  'Current tasks': '目前任務',
  '... and {{count}} more': '... 以及其他 {{count}} 個',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'TOML 格式已棄用。是否將它們遷移到 Markdown 格式？',
  '(Backups will be created and original files will be preserved)':
    '（將創建備份，原始檔案將保留）',
  'Waiting for user confirmation...': '等待用戶確認...',
  WITTY_LOADING_PHRASES: [
    '正在努力搬磚，請稍候...',
    '老闆在身後，快加載啊！',
    '頭髮掉光前，一定能加載完...',
    '伺服器正在深呼吸，準備放大招...',
    '正在向伺服器投餵咖啡...',
    '正在賦能全鏈路，尋找關鍵抓手...',
    '正在降本增效，優化加載路徑...',
    '正在打破部門壁壘，沉澱方法論...',
    '正在擁抱變化，迭代核心價值...',
    '正在對齊顆粒度，打磨底層邏輯...',
    '大力出奇跡，正在強行加載...',
    '只要我不寫代碼，代碼就沒有 Bug...',
    '正在把 Bug 轉化為 Feature...',
    '只要我不尷尬，Bug 就追不上我...',
    '正在試圖理解去年的自己寫了什麼...',
    '正在猿力覺醒中，請耐心等待...',
    '正在詢問產品經理：這需求是真的嗎？',
    '正在給產品經理畫餅，請稍等...',
    '每一行代碼，都在努力讓世界變得更好一點點...',
    '每一個偉大的想法，都值得這份耐心的等待...',
    '別急，美好的事物總是需要一點時間去醞釀...',
    '願你的代碼永無 Bug，願你的夢想終將成真...',
    '哪怕只有 0.1% 的進度，也是在向目標靠近...',
    '加載的是字節，承載的是對技術的熱愛...',
  ],
  'Enter value...': '請輸入值...',
  'Enter sensitive value...': '請輸入敏感值...',
  'Press Enter to submit, Escape to cancel': '按 Enter 提交，Escape 取消',
  'Markdown file already exists: {{filename}}':
    'Markdown 檔案已存在：{{filename}}',
  'TOML Command Format Deprecation Notice': 'TOML 命令格式棄用通知',
  'Found {{count}} command file(s) in TOML format:':
    '發現 {{count}} 個 TOML 格式的命令檔案：',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    '命令的 TOML 格式正在被棄用，推薦使用 Markdown 格式。',
  'Markdown format is more readable and easier to edit.':
    'Markdown 格式更易讀、更易編輯。',
  'You can migrate these files automatically using:':
    '您可以使用以下命令自動遷移這些檔案：',
  'Or manually convert each file:': '或手動轉換每個檔案：',
  'TOML: prompt = "..." / description = "..."':
    'TOML：prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content': 'Markdown：YAML frontmatter + 內容',
  'The migration tool will:': '遷移工具將：',
  'Convert TOML files to Markdown': '將 TOML 檔案轉換為 Markdown',
  'Create backups of original files': '創建原始檔案的備份',
  'Preserve all command functionality': '保留所有命令功能',
  'TOML format will continue to work for now, but migration is recommended.':
    'TOML 格式目前仍可使用，但建議遷移。',
  'Open extensions page in your browser': '在瀏覽器中打開擴展市場頁面',
  'Unknown extensions source: {{source}}.': '未知的擴展來源：{{source}}。',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    '將在瀏覽器中打開擴展頁面：{{url}}（測試環境中已跳過）',
  'View available extensions at {{url}}': '在 {{url}} 查看可用擴展',
  'Opening extensions page in your browser: {{url}}':
    '正在瀏覽器中打開擴展頁面：{{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    '打開瀏覽器失敗。請訪問擴展市場：{{url}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    '將於 {{seconds}} 秒後重試…（第 {{attempt}}/{{maxRetries}} 次）',
  'Press Ctrl+Y to retry': '按 Ctrl+Y 重試。',
  'No failed request to retry.': '沒有可重試的失敗請求。',
  'to retry last request': '重試上一次請求',
  'API key cannot be empty.': 'API Key 不能為空。',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    '無效的 API Key，Coding Plan API Key 均以 "sk-sp-" 開頭，請檢查',
  'You can get your Coding Plan API key here':
    '您可以在這裏獲取 Coding Plan API Key',
  'You can get your Token Plan API key here':
    '您可以在這裏獲取 Token Plan API Key',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'API Key 已存儲在 settings.env 中。您可以將其遷移到 .env 檔案以獲得更好的安全性。',
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    '阿里雲百鍊 Coding Plan 有新模型配置可用。是否立即更新？',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan 配置更新成功。新模型現已可用。',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    '未找到 Coding Plan API Key。請重新通過 Coding Plan 認證。',
  'Failed to update Coding Plan configuration: {{message}}':
    '更新 Coding Plan 配置失敗：{{message}}',
  'You can configure your API key and models in settings.json':
    '您可以在 settings.json 中配置 API Key 和模型',
  'Refer to the documentation for setup instructions': '請參考文檔瞭解配置說明',
  'Coding Plan': 'Coding Plan',
  Custom: '自定義',
  'Select Region for Coding Plan': '選擇 Coding Plan 區域',
  'Choose based on where your account is registered':
    '請根據您的賬號註冊地區選擇',
  'Enter Coding Plan API Key': '輸入 Coding Plan API Key',
  'Enter Token Plan API Key': '輸入 Token Plan API Key',
  'New model configurations are available for {{region}}. Update now?':
    '{{region}} 有新的模型配置可用。是否立即更新？',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}} 配置更新成功。模型已切換至 "{{model}}"。',
  'Context Usage': '上下文使用情況',
  '% used': '% 已用',
  '% context used': '% 上下文已用',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    '上下文超出限制！請使用 /compress 或 /clear 來減少上下文。',
  'No API response yet. Send a message to see actual usage.':
    '暫無 API 響應。發送消息以查看實際使用情況。',
  'Estimated pre-conversation overhead': '預估對話前開銷',
  'Context window': '上下文窗口',
  tokens: 'tokens',
  Used: '已用',
  Free: '空閒',
  'Autocompact buffer': '自動壓縮緩衝區',
  'Usage by category': '分類用量',
  'System prompt': '系統提示',
  'Built-in tools': '內置工具',
  'MCP tools': 'MCP tools',
  'Memory files': '記憶檔案',
  Skills: '技能',
  Messages: '消息',
  'Run /context detail for per-item breakdown.':
    '運行 /context detail 查看詳細分解。',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    '顯示上下文窗口使用情況分解。輸入 "/context detail" 查看詳細分解。',
  'body loaded': '內容已加載',
  memory: '記憶',
  '{{region}} configuration updated successfully.': '{{region}} 配置更新成功。',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    '成功通過 {{region}} 認證。API Key 和模型配置已保存至 settings.json。',
  'Tip: Use /model to switch between available Coding Plan models.':
    '提示：使用 /model 切換可用的 Coding Plan 模型。',
  'Type something...': '輸入內容...',
  Submit: '提交',
  'Submit answers': '提交答案',
  Cancel: '取消',
  'Your answers:': '您的答案：',
  '(not answered)': '(未回答)',
  'Ready to submit your answers?': '準備好提交您的答案了嗎？',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: 導航 | ←/→: 切換標籤頁 | Enter: 選擇',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: 導航 | Enter: 選擇 | Esc: 取消',
  'Authenticate using Qwen OAuth': '使用 Qwen OAuth 進行認證',
  'Authenticate using Alibaba Cloud Coding Plan':
    '使用阿里雲百鍊 Coding Plan 進行認證',
  'Region for Coding Plan (china/global)': 'Coding Plan 區域 (china/global)',
  'API key for Coding Plan': 'Coding Plan 的 API Key',
  'Show current authentication status': '顯示當前認證狀態',
  'Authentication completed successfully.': '認證完成。',
  'Starting Qwen OAuth authentication...': '正在啟動 Qwen OAuth 認證...',
  'Successfully authenticated with Qwen OAuth.': '已成功通過 Qwen OAuth 認證。',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Qwen OAuth 認證失敗：{{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    '正在處理阿里雲百鍊 Coding Plan 認證...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    '已成功通過阿里雲百鍊 Coding Plan 認證。',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Coding Plan 認證失敗：{{error}}',
  '中国 (China)': '中國 (China)',
  '阿里云百炼 (aliyun.com)': '阿里雲百鍊 (aliyun.com)',
  Global: '全球',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': '選擇 Coding Plan 區域：',
  'Enter your Coding Plan API key: ': '請輸入您的 Coding Plan API Key：',
  'Select authentication method:': '選擇認證方式：',
  '\n=== Authentication Status ===\n': '\n=== 認證狀態 ===\n',
  '⚠️  No authentication method configured.\n': '⚠️  未配置認證方式。\n',
  'Run one of the following commands to get started:\n':
    '運行以下命令之一開始配置：\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - 使用 Qwen OAuth 登錄（已停用）',
  'Or simply run:': '或者直接運行：',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - 交互式認證配置\n',
  '✓ Authentication Method: Qwen OAuth': '✓ 認證方式：Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  類型：免費額度（2026-04-15 已停用）',
  '  Limit: No longer available': '  限額：已不可用',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Qwen OAuth 免費額度已於 2026-04-15 停用。請運行 /auth 切換到 Coding Plan、OpenRouter、Fireworks AI 或其他服務商。',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ 認證方式：阿里雲百鍊 Coding Plan',
  '中国 (China) - 阿里云百炼': '中國 (China) - 阿里雲百鍊',
  'Global - Alibaba Cloud': '全球 - Alibaba Cloud',
  '  Region: {{region}}': '  區域：{{region}}',
  '  Current Model: {{model}}': '  當前模型：{{model}}',
  '  Config Version: {{version}}': '  配置版本：{{version}}',
  '  Status: API key configured\n': '  狀態：API Key 已配置\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  認證方式：阿里雲百鍊 Coding Plan（不完整）',
  '  Issue: API key not found in environment or settings\n':
    '  問題：在環境變量或設置中未找到 API Key\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  運行 `qwen auth coding-plan` 重新配置。\n',
  '✓ Authentication Method: {{type}}': '✓ 認證方式：{{type}}',
  '  Status: Configured\n': '  狀態：已配置\n',
  'Failed to check authentication status: {{error}}':
    '檢查認證狀態失敗：{{error}}',
  'Select an option:': '請選擇：',
  'Raw mode not available. Please run in an interactive terminal.':
    '原始模式不可用。請在交互式終端中運行。',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(使用 ↑ ↓ 箭頭導航，Enter 選擇，Ctrl+C 退出)\n',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    '緊湊模式下隱藏工具輸出和思考過程，界面更簡潔（Ctrl+O 切換）。',
  'Press Ctrl+O to show full tool output': '按 Ctrl+O 查看詳細工具調用結果',
  'Switch to plan mode or exit plan mode': '切換到計劃模式或退出計劃模式',
  'Set a goal — keep working until the condition is met':
    '設定目標 — 持續工作直到條件滿足',
  'Exited plan mode. Previous approval mode restored.':
    '已退出計劃模式，已恢復之前的審批模式。',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    '啟用計劃模式。智能體將只分析和規劃，而不執行工具。',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    '已處於計劃模式。使用 "/plan exit" 退出計劃模式。',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    '未處於計劃模式。請先使用 "/plan" 進入計劃模式。',
  "Set up Qwen Code's status line UI": '配置 Qwen Code 的狀態欄',
  'When a new todo item is created': '建立新待辦事項時',
  'When a todo item is marked as completed': '待辦事項標記為完成時',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    '命令輸入為包含 todo_id、todo_content、todo_status、all_todos 和 phase 的 JSON。在 validation 中，輸出為包含 decision（allow/block/deny）和 reason 的 JSON。在 postWrite 中，block/deny 會被忽略。',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    '命令輸入為包含 todo_id、todo_content、previous_status、all_todos 和 phase 的 JSON。在 validation 中，輸出為包含 decision（allow/block/deny）和 reason 的 JSON。在 postWrite 中，block/deny 會被忽略。',
  'allow todo creation': '允許建立待辦事項',
  'block todo creation and show reason to model':
    '阻止建立待辦事項並向模型顯示原因',
  'allow todo completion': '允許完成待辦事項',
  'block todo completion and show reason to model':
    '阻止完成待辦事項並向模型顯示原因',

  // === Core: added from PR #3328 ===
  'Open the memory manager.': '打開記憶管理器。',
  'Save a durable memory to the memory system.': '將持久記憶保存到記憶系統。',
  'Ask a quick side question without affecting the main conversation':
    '在不影響主對話的情況下快速提問旁支問題',
  'Manage Arena sessions': '管理 Arena 會話',
  'Start an Arena session with multiple models competing on the same task':
    '啟動一個 Arena 會話，讓多個模型在同一任務上競爭',
  'Stop the current Arena session': '停止當前的 Arena 會話',
  'Show the current Arena session status': '顯示當前的 Arena 會話狀態',
  'Select a model result and merge its diff into the current workspace':
    '選擇一個模型結果並將其差異合併到當前工作區',
  'No running Arena session found.': '未找到正在執行的 Arena 會話。',
  'No Arena session found. Start one with /arena start.':
    '未找到 Arena 會話。請使用 /arena start 啟動一個。',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Arena 會話仍在執行中。請等待其完成，或先使用 /arena stop。',
  'No successful agent results to select from. All agents failed or were cancelled.':
    '沒有可選擇的成功代理結果。所有代理均失敗或被取消。',
  'Use /arena stop to end the session.': '使用 /arena stop 結束會話。',
  'No idle agent found matching "{{name}}".':
    '未找到匹配 "{{name}}" 的空閒代理。',
  'Failed to apply changes from {{label}}: {{error}}':
    '從 {{label}} 套用變更失敗：{{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    '已將 {{label}} 的變更套用到工作區。Arena 會話完成。',
  'Discard all Arena results and clean up worktrees?':
    '捨棄所有 Arena 結果並清理工作樹？',
  'Arena results discarded. All worktrees cleaned up.':
    'Arena 結果已捨棄。所有工作樹已清理。',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena 不支援非互動模式。請使用互動模式啟動 Arena 會話。',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena 不支援非互動模式。請使用互動模式停止 Arena 會話。',
  'Arena is not supported in non-interactive mode.': 'Arena 不支援非互動模式。',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    '已存在 Arena 會話。請使用 /arena stop 或 /arena select 結束後再啟動新會話。',
  'Usage: /arena start --models model1,model2 <task>':
    '用法：/arena start --models model1,model2 <task>',
  'Models to compete (required, at least 2)':
    '參與競爭的模型（必須，至少 2 個）',
  'Format: authType:modelId or just modelId':
    '格式：authType:modelId 或僅 modelId',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena 至少需要 2 個模型。請使用 --models model1,model2 指定。',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena 已啟動 {{count}} 個代理處理任務："{{task}}"\n模型：\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Arena 面板正在 tmux 中執行。使用以下命令附加：`{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] 失敗：{{error}}',
  'Loading suggestions...': '正在載入建議...',
  'Show per-item context usage breakdown.':
    '顯示每個項目的上下文使用情況細分。',
  'Manage extension settings': '管理擴展設置',
  'Background tasks': '背景任務',
  'No tasks currently running': '目前沒有正在執行的任務',
  'No entry to show.': '沒有可顯示的項目。',
  Running: '執行中',
  Paused: '已暫停',
  Completed: '已完成',
  Failed: '失敗',
  Stopped: '已停止',
  Shell: 'Shell',
  Monitor: '監控',
  Command: '命令',
  Dream: '記憶整理',
  '[dream] memory consolidation': '[記憶整理] 記憶整理',
  '[dream] memory consolidation (reviewing {{count}} session)':
    '[記憶整理] 記憶整理（正在檢視 {{count}} 個會話）',
  '[dream] memory consolidation (reviewing {{count}} sessions)':
    '[記憶整理] 記憶整理（正在檢視 {{count}} 個會話）',
  '{{count}} session': '{{count}} 個會話',
  '{{count}} sessions': '{{count}} 個會話',
  '{{count}} topic': '{{count}} 個主題',
  '{{count}} topics': '{{count}} 個主題',
  '{{count}} tokens': '{{count}} tokens',
  '{{count}} tool call': '{{count}} 個工具呼叫',
  '{{count}} tool calls': '{{count}} 個工具呼叫',
  '{{count}} event': '{{count}} 個事件',
  '{{count}} events': '{{count}} 個事件',
  '{{count}} dropped': '丟棄 {{count}} 行',
  'pid {{pid}}': 'pid {{pid}}',
  'exit {{exitCode}}': '退出碼 {{exitCode}}',
  'Sessions reviewing': '正在檢視的會話',
  Progress: '進度',
  'Resume blocked': '恢復受阻',
  'Working dir': '工作目錄',
  'Output file': '輸出檔案',
  'Topics touched ({{count}})': '觸及的主題（{{count}}）',
  '{{count}} more': '{{count}} 個',
  'Lock release warning': '鎖釋放警告',
  'Metadata write warning': '元資料寫入警告',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    '後續記憶整理可能會因鎖定而略過，直到下一次會話過期清理清除此檔案。',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    '排程門控未看到本次記憶整理的時間戳；下一輪記憶整理可能會比平時更早重新觸發。',

  // === Same-as-English optimization ===
  ' (not in model registry)': '（不在模型註冊表中）',
  'start server': '啟動伺服器',
};
