/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Japanese translations for Qwen Code CLI

export default {
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  'Basics:': '基本操作:',
  'Add context': 'コンテキストを追加',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    '{{symbol}} を使用してコンテキスト用のファイルを指定します(例: {{example}}) また、特定のファイルやフォルダを対象にできます',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'シェルモード',
  'YOLO mode': 'YOLOモード',
  'plan mode': 'プランモード',
  'auto-accept edits': '編集を自動承認',
  'Accepting edits': '編集を承認中',
  '(shift + tab to cycle)': '(Shift + Tab で切り替え)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    '{{symbol}} でシェルコマンドを実行(例: {{example1}})、または自然言語で入力(例: {{example2}})',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'サーバーを起動',
  'Commands:': 'コマンド:',
  'shell command': 'シェルコマンド',
  'Model Context Protocol command (from external servers)':
    'Model Context Protocol コマンド(外部サーバーから)',
  'Keyboard Shortcuts:': 'キーボードショートカット:',
  'Jump through words in the input': '入力欄の単語間を移動',
  'Close dialogs, cancel requests, or quit application':
    'ダイアログを閉じる、リクエストをキャンセル、またはアプリを終了',
  'New line': '改行',
  'New line (Alt+Enter works for certain linux distros)':
    '改行(一部のLinuxディストリビューションではAlt+Enterが有効)',
  'Clear the screen': '画面をクリア',
  'Open input in external editor': '外部エディタで入力を開く',
  'Send message': 'メッセージを送信',
  'Initializing...': '初期化中...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'MCP servers に接続中... ({{connected}}/{{total}})',
  'Type your message or @path/to/file':
    'メッセージを入力、@パス/ファイルでファイルを添付(D&D対応)',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "'i' でINSERTモード、'Esc' でNORMALモード",
  'Cancel operation / Clear input (double press)':
    '操作をキャンセル / 入力をクリア(2回押し)',
  'Cycle approval modes': '承認モードを切り替え',
  'Cycle through your prompt history': 'プロンプト履歴を順に表示',
  'For a full list of shortcuts, see {{docPath}}':
    'ショートカットの完全なリストは {{docPath}} を参照',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'Qwen Code のヘルプ',
  'show version info': 'バージョン情報を表示',
  'submit a bug report': 'バグレポートを送信',
  Model: 'モデル',
  'Fast Model': '高速モデル',
  Sandbox: 'サンドボックス',
  'Session ID': 'セッションID',
  'Base URL': 'Base URL',
  'Memory Usage': 'メモリ使用量',
  'IDE Client': 'IDEクライアント',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'プロジェクトを分析し、カスタマイズされた QWEN.md ファイルを作成',
  'List available Qwen Code tools. Usage: /tools [desc]':
    '利用可能な Qwen Code ツールを一覧表示。使い方: /tools [desc]',
  'List available skills.': '利用可能なスキルを一覧表示する。',
  'Available Qwen Code CLI tools:': '利用可能な Qwen Code CLI ツール:',
  'No tools available': '利用可能なツールはありません',
  'View or change the approval mode for tool usage':
    'ツール使用の承認モードを表示または変更',
  'View or change the language setting': '言語設定を表示または変更',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    'バックグラウンドタスクを一覧表示する（テキスト出力。対話式ダイアログはフッターのタスク表示から開けます）',
  'Delete a previous session': '以前のセッションを削除する',
  'Run installation and environment diagnostics':
    'インストールと環境の診断を実行する',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    '動的なモデルカタログを参照し、ローカルで有効にしておくモデルを選択する',
  'Generate a one-line session recap now':
    'このセッションの1行要約を今すぐ生成する',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    '現在の会話の名前を変更する。--auto を使うと高速モデルがタイトルを決めます。',
  'Rewind conversation to a previous turn': '会話を前のターンまで巻き戻す',
  'change the theme': 'テーマを変更',
  'Select Theme': 'テーマを選択',
  Preview: 'プレビュー',
  '(Use Enter to select, Tab to configure scope)':
    '(Enter で選択、Tab でスコープを設定)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'NO_COLOR 環境変数のためテーマ設定は利用できません',
  'Theme "{{themeName}}" not found.': 'テーマ "{{themeName}}" が見つかりません',
  'Theme "{{themeName}}" not found in selected scope.':
    '選択したスコープにテーマ "{{themeName}}" が見つかりません',
  'Clear conversation history and free up context':
    '会話履歴をクリアしてコンテキストを解放',
  'Compresses the context by replacing it with a summary.':
    'コンテキストを要約に置き換えて圧縮',
  'open full Qwen Code documentation in your browser':
    'ブラウザで Qwen Code のドキュメントを開く',
  'Configuration not available.': '設定が利用できません',
  'Configure authentication information for login':
    'ログイン用の認証情報を設定',
  'Copy the last result or code snippet to clipboard':
    '最後の結果またはコードスニペットをクリップボードにコピー',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    '専門タスクを委任するサブエージェントを管理',
  'Manage existing subagents (view, edit, delete).':
    '既存のサブエージェントを管理(表示、編集、削除)',
  'Create a new subagent with guided setup.':
    'ガイド付きセットアップで新しいサブエージェントを作成',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: 'エージェント',
  'Choose Action': 'アクションを選択',
  'Edit {{name}}': '{{name}} を編集',
  'Edit Tools: {{name}}': 'ツールを編集: {{name}}',
  'Edit Color: {{name}}': '色を編集: {{name}}',
  'Delete {{name}}': '{{name}} を削除',
  'Unknown Step': '不明なステップ',
  'Esc to close': 'Esc で閉じる',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter で選択、↑↓ で移動、Esc で閉じる',
  'Esc to go back': 'Esc で戻る',
  'Enter to confirm, Esc to cancel': 'Enter で確定、Esc でキャンセル',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter で選択、↑↓ で移動、Esc で戻る',
  'Enter to submit, Esc to go back': 'Enter で送信、Esc で戻る',
  'Invalid step: {{step}}': '無効なステップ: {{step}}',
  'No subagents found.': 'サブエージェントが見つかりません',
  "Use '/agents create' to create your first subagent.":
    "'/agents create' で最初のサブエージェントを作成してください",
  '(built-in)': '(組み込み)',
  '(overridden by project level agent)':
    '(プロジェクトレベルのエージェントで上書き)',
  'Project Level ({{path}})': 'プロジェクトレベル ({{path}})',
  'User Level ({{path}})': 'ユーザーレベル ({{path}})',
  'Built-in Agents': '組み込みエージェント',
  'Using: {{count}} agents': '使用中: {{count}} エージェント',
  'View Agent': 'エージェントを表示',
  'Edit Agent': 'エージェントを編集',
  'Delete Agent': 'エージェントを削除',
  Back: '戻る',
  'No agent selected': 'エージェントが選択されていません',
  'File Path: ': 'ファイルパス: ',
  'Tools: ': 'ツール: ',
  'Color: ': '色: ',
  'Description:': '説明:',
  'System Prompt:': 'システムプロンプト:',
  'Open in editor': 'エディタで開く',
  'Edit tools': 'ツールを編集',
  'Edit color': '色を編集',
  '❌ Error:': '❌ エラー:',
  'Are you sure you want to delete agent "{{name}}"?':
    'エージェント "{{name}}" を削除してもよろしいですか?',
  'Project Level (.qwen/agents/)': 'プロジェクトレベル (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'ユーザーレベル (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!':
    '✅ サブエージェントの作成に成功しました!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'サブエージェント "{{name}}" を {{level}} に保存しました',
  'Name: ': '名前: ',
  'Location: ': '場所: ',
  '❌ Error saving subagent:': '❌ サブエージェント保存エラー:',
  'Warnings:': '警告:',
  'Step {{n}}: Choose Location': 'ステップ {{n}}: 場所を選択',
  'Step {{n}}: Choose Generation Method': 'ステップ {{n}}: 作成方法を選択',
  'Generate with Qwen Code (Recommended)': 'Qwen Code で生成(推奨)',
  'Manual Creation': '手動作成',
  'Generating subagent configuration...': 'サブエージェント設定を生成中...',
  'Failed to generate subagent: {{error}}':
    'サブエージェントの生成に失敗: {{error}}',
  'Step {{n}}: Describe Your Subagent':
    'ステップ {{n}}: サブエージェントを説明',
  'Step {{n}}: Enter Subagent Name': 'ステップ {{n}}: サブエージェント名を入力',
  'Step {{n}}: Enter System Prompt': 'ステップ {{n}}: システムプロンプトを入力',
  'Step {{n}}: Enter Description': 'ステップ {{n}}: 説明を入力',
  'Step {{n}}: Select Tools': 'ステップ {{n}}: ツールを選択',
  'All Tools (Default)': '全ツール(デフォルト)',
  'All Tools': '全ツール',
  'Read-only Tools': '読み取り専用ツール',
  'Read & Edit Tools': '読み取り＆編集ツール',
  'Read & Edit & Execution Tools': '読み取り＆編集＆実行ツール',
  'Selected tools:': '選択されたツール:',
  'Step {{n}}: Choose Background Color': 'ステップ {{n}}: 背景色を選択',
  'Step {{n}}: Confirm and Save': 'ステップ {{n}}: 確認して保存',
  'Esc to cancel': 'Esc でキャンセル',
  cancel: 'キャンセル',
  'go back': '戻る',
  '↑↓ to navigate, ': '↑↓ で移動、',
  'Name cannot be empty.': '名前は空にできません',
  'System prompt cannot be empty.': 'システムプロンプトは空にできません',
  'Description cannot be empty.': '説明は空にできません',
  'Failed to launch editor: {{error}}': 'エディタの起動に失敗: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'サブエージェントの保存と編集に失敗: {{error}}',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    '"{{name}}" は {{level}} に既に存在します - 既存のサブエージェントを上書きします',
  'Name "{{name}}" exists at user level - project level will take precedence':
    '"{{name}}" はユーザーレベルに存在します - プロジェクトレベルが優先されます',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    '"{{name}}" はプロジェクトレベルに存在します - 既存のサブエージェントが優先されます',
  'Description is over {{length}} characters':
    '説明が {{length}} 文字を超えています',
  'System prompt is over {{length}} characters':
    'システムプロンプトが {{length}} 文字を超えています',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'このサブエージェントの役割と使用タイミングを説明してください(詳細に記述するほど良い結果が得られます)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    '例: ベストプラクティスに基づいてコードをレビューするエキスパートレビュアー...',
  'All tools selected, including MCP tools':
    'MCP tools を含むすべてのツールを選択',
  'Read-only tools:': '読み取り専用ツール:',
  'Edit tools:': '編集ツール:',
  'Execution tools:': '実行ツール:',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Enter で保存、e で保存して編集、Esc で戻る',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Enter で続行、{{navigation}}Esc で{{action}}',
  'Enter a clear, unique name for this subagent.':
    'このサブエージェントの明確で一意な名前を入力してください',
  'e.g., Code Reviewer': '例: コードレビュアー',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'このサブエージェントの動作を定義するシステムプロンプトを記述してください (詳細に書くほど良い結果が得られます)',
  'e.g., You are an expert code reviewer...':
    '例: あなたはエキスパートコードレビュアーです...',
  'Describe when and how this subagent should be used.':
    'このサブエージェントをいつどのように使用するかを説明してください',
  'e.g., Reviews code for best practices and potential bugs.':
    '例: ベストプラクティスと潜在的なバグについてコードをレビューします。',
  // Commands - General (continued)
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '変更を確認するには Qwen Code を再起動する必要があります。 r を押して終了し、変更を適用してください',
  'View and edit Qwen Code settings': 'Qwen Code の設定を表示・編集',
  Settings: '設定',
  'Vim Mode': 'Vim モード',
  'Output Format': '出力形式',
  'Hide Tips': 'ヒントを非表示',
  Text: 'テキスト',
  JSON: 'JSON',
  Plan: 'プラン',
  Default: 'デフォルト',
  'Auto Edit': '自動編集',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'Vim モードのオン/オフを切り替え',
  'exit the cli': 'CLIを終了',
  Timeout: 'タイムアウト',
  'Max Retries': '最大リトライ回数',
  'Auto Accept': '自動承認',
  'Folder Trust': 'フォルダの信頼',
  'Debug Keystroke Logging': 'キーストロークのデバッグログ',
  'Hide Window Title': 'ウィンドウタイトルを非表示',
  'Show Status in Title': 'タイトルにステータスを表示',
  'Show Citations': '引用を表示',
  'Custom Witty Phrases': 'カスタムウィットフレーズ',
  'Screen Reader Mode': 'スクリーンリーダーモード',
  'Max Session Turns': '最大セッションターン数',
  'Skip Next Speaker Check': '次の発言者チェックをスキップ',
  'Skip Loop Detection': 'ループ検出をスキップ',
  'Skip Startup Context': '起動時コンテキストをスキップ',
  'Enable OpenAI Logging': 'OpenAI ログを有効化',
  'OpenAI Logging Directory': 'OpenAI ログディレクトリ',
  'Load Memory From Include Directories':
    'インクルードディレクトリからメモリを読み込み',
  'Respect .gitignore': '.gitignore を優先',
  'Respect .qwenignore': '.qwenignore を優先',
  'Enable Recursive File Search': '再帰的ファイル検索を有効化',
  'Show Color': '色を表示',
  'Use Ripgrep': 'Ripgrep を使用',
  'Use Builtin Ripgrep': '組み込み Ripgrep を使用',
  'Tool Output Truncation Threshold': 'ツール出力切り詰めのしきい値',
  'Tool Output Truncation Lines': 'ツール出力の切り詰め行数',
  'Tool Schema Compliance': 'Tool Schema 準拠',
  'Auto (detect from system)': '自動(システムから検出)',
  'Auto (detect terminal theme)': '自動（端末テーマを検出）',
  Auto: '自動',
  'check session stats. Usage: /stats [model|tools]':
    'セッション統計を確認。使い方: /stats [model|tools]',
  'Show model-specific usage statistics.': 'モデル別の使用統計を表示',
  'Show tool-specific usage statistics.': 'ツール別の使用統計を表示',
  'Manage workspace directories': 'ワークスペースディレクトリを管理',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'ワークスペースにディレクトリを追加。複数パスはカンマで区切ってください',
  'Show all directories in the workspace':
    'ワークスペース内のすべてのディレクトリを表示',
  'set external editor preference': '外部エディタの設定',
  'Manage extensions': '拡張機能を管理',
  'Manage installed extensions': 'インストール済みの拡張機能を管理する',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    '{{originSource}} から拡張機能をインストールしています。一部の機能は Qwen Code で完全に動作しない可能性があります。',
  'manage IDE integration': 'IDE連携を管理',
  'check status of IDE integration': 'IDE連携の状態を確認',
  'install required IDE companion for {{ideName}}':
    '{{ideName}} 用の必要なIDEコンパニオンをインストール',
  'enable IDE integration': 'IDE連携を有効化',
  'disable IDE integration': 'IDE連携を無効化',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    '現在の環境ではIDE連携はサポートされていません。この機能を使用するには、VS Code または VS Code 派生エディタで Qwen Code を実行してください',
  'Set up GitHub Actions': 'GitHub Actions を設定',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    '複数行入力用のターミナルキーバインドを設定(VS Code、Cursor、Windsurf、Trae)',
  'Please restart your terminal for the changes to take effect.':
    '変更を有効にするにはターミナルを再起動してください',
  'Failed to configure terminal: {{error}}':
    'ターミナルの設定に失敗: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Windows で {{terminalName}} の設定パスを特定できません: APPDATA 環境変数が設定されていません',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} の keybindings.json は存在しますが、有効なJSON配列ではありません。ファイルを手動で修正するか、削除して自動設定を許可してください',
  'File: {{file}}': 'ファイル: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} の keybindings.json の解析に失敗しました。ファイルに無効なJSONが含まれています。手動で修正するか、削除して自動設定を許可してください',
  'Error: {{error}}': 'エラー: {{error}}',
  'Shift+Enter binding already exists': 'Shift+Enter バインドは既に存在します',
  'Ctrl+Enter binding already exists': 'Ctrl+Enter バインドは既に存在します',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    '既存のキーバインドが検出されました。競合を避けるため変更をしません',
  'Please check and modify manually if needed: {{file}}':
    '必要に応じて手動で確認・変更してください: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    '{{terminalName}} に Shift+Enter と Ctrl+Enter のキーバインドを追加しました',
  'Modified: {{file}}': '変更済み: {{file}}',
  '{{terminalName}} keybindings already configured.':
    '{{terminalName}} のキーバインドは既に設定されています',
  'Failed to configure {{terminalName}}.':
    '{{terminalName}} の設定に失敗しました',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'ターミナルは複数行入力(Shift+Enter と Ctrl+Enter)に最適化されています',
  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Qwen Code のフックを管理する',
  'List all configured hooks': '設定済みのフックをすべて表示する',
  // Hooks - Dialog
  Hooks: 'フック',
  'Loading hooks...': 'フックを読み込んでいます...',
  'Error loading hooks:': 'フックの読み込みエラー：',
  'Press Escape to close': 'Escape キーで閉じる',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Escape、Ctrl+C、Ctrl+D でキャンセル',
  'Press Space, Enter, or Escape to dismiss': 'Space、Enter、Escape で閉じる',
  'No hook selected': 'フックが選択されていません',
  // Hooks - List Step
  'No hook events found.': 'フックイベントが見つかりません。',
  '{{count}} hook configured': '{{count}} 件のフックが設定されています',
  '{{count}} hooks configured': '{{count}} 件のフックが設定されています',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'このメニューは読み取り専用です。フックを追加または変更するには、settings.json を直接編集するか、Qwen Code に尋ねてください。',
  'Enter to select · Esc to cancel': 'Enter で選択 · Esc でキャンセル',
  // Hooks - Detail Step
  'Exit codes:': '終了コード：',
  'Configured hooks:': '設定済みのフック：',
  'No hooks configured for this event.':
    'このイベントにはフックが設定されていません。',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'フックを追加するには、settings.json を直接編集するか、Qwen に尋ねてください。',
  'Enter to select · Esc to go back': 'Enter で選択 · Esc で戻る',
  // Hooks - Config Detail Step
  'Hook details': 'フック詳細',
  'Event:': 'イベント：',
  'Extension:': '拡張機能：',
  'Desc:': '説明：',
  'No hook config selected': 'フック設定が選択されていません',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'このフックを変更または削除するには、settings.json を直接編集するか、Qwen に尋ねてください。',
  // Hooks - Disabled Step
  'Hook Configuration - Disabled': 'フック設定 - 無効',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'すべてのフックは現在無効です。{{count}} が実行されていません。',
  '{{count}} configured hook': '{{count}} 個の設定されたフック',
  '{{count}} configured hooks': '{{count}} 個の設定されたフック',
  'When hooks are disabled:': 'フックが無効な場合：',
  'No hook commands will execute': 'フックコマンドは実行されません',
  'StatusLine will not be displayed': 'StatusLine は表示されません',
  'Tool operations will proceed without hook validation':
    'ツール操作はフック検証なしで続行されます',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'フックを再有効化するには、settings.json から "disableAllHooks" を削除するか、Qwen Code に尋ねてください。',
  // Hooks - Source
  Project: 'プロジェクト',
  User: 'ユーザー',
  Skill: 'スキル',
  System: 'システム',
  Extension: '拡張機能',
  'Local Settings': 'ローカル設定',
  'User Settings': 'ユーザー設定',
  'System Settings': 'システム設定',
  Extensions: '拡張機能',
  'Session (temporary)': 'セッション（一時）',
  // Hooks - Event Descriptions (short)
  'Before tool execution': 'ツール実行前',
  'After tool execution': 'ツール実行後',
  'After tool execution fails': 'ツール実行失敗時',
  'When notifications are sent': '通知送信時',
  'When the user submits a prompt': 'ユーザーがプロンプトを送信した時',
  'When a new session is started': '新しいセッションが開始された時',
  'Right before Qwen Code concludes its response':
    'Qwen Code が応答を終了する直前',
  'When a subagent (Agent tool call) is started':
    'サブエージェント（Agent ツール呼び出し）が開始された時',
  'Right before a subagent concludes its response':
    'サブエージェントが応答を終了する直前',
  'Before conversation compaction': '会話圧縮前',
  'When a session is ending': 'セッション終了時',
  'When a permission dialog is displayed': '権限ダイアログ表示時',
  'When a new todo item is created': '新Todo項目作成時',
  'When a todo item is marked as completed': 'Todo項目完了時',
  // Hooks - Event Descriptions (detailed)
  'Input to command is JSON of tool call arguments.':
    'コマンドへの入力はツール呼び出し引数の JSON です。',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'コマンドへの入力は "inputs"（ツール呼び出し引数）と "response"（ツール呼び出し応答）フィールドを持つ JSON です。',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'コマンドへの入力は tool_name、tool_input、tool_use_id、error、error_type、is_interrupt、is_timeout を持つ JSON です。',
  'Input to command is JSON with notification message and type.':
    'コマンドへの入力は通知メッセージとタイプを持つ JSON です。',
  'Input to command is JSON with original user prompt text.':
    'コマンドへの入力は元のユーザープロンプトテキストを持つ JSON です。',
  'Input to command is JSON with session start source.':
    'コマンドへの入力はセッション開始ソースを持つ JSON です。',
  'Input to command is JSON with session end reason.':
    'コマンドへの入力はセッション終了理由を持つ JSON です。',
  'Input to command is JSON with agent_id and agent_type.':
    'コマンドへの入力は agent_id と agent_type を持つ JSON です。',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    'コマンドへの入力は agent_id、agent_type、agent_transcript_path を持つ JSON です。',
  'Input to command is JSON with compaction details.':
    'コマンドへの入力は圧縮詳細を持つ JSON です。',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    'コマンドへの入力は tool_name、tool_input、tool_use_id を持つ JSON です。許可または拒否の決定を含む hookSpecificOutput を持つ JSON を出力します。',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'コマンドへの入力は todo_id、todo_content、todo_status、all_todos、phase を持つ JSON です。validation では decision（allow/block/deny）と reason を持つ JSON を出力します。postWrite では block/deny は無視されます。',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'コマンドへの入力は todo_id、todo_content、previous_status、all_todos、phase を持つ JSON です。validation では decision（allow/block/deny）と reason を持つ JSON を出力します。postWrite では block/deny は無視されます。',
  // Hooks - Exit Code Descriptions
  'stdout/stderr not shown': 'stdout/stderr は表示されません',
  'show stderr to model and continue conversation':
    'stderr をモデルに表示し、会話を続ける',
  'show stderr to user only': 'stderr をユーザーのみに表示',
  'stdout shown in transcript mode (ctrl+o)':
    'stdout はトランスクリプトモードで表示 (ctrl+o)',
  'show stderr to model immediately': 'stderr をモデルに即座に表示',
  'show stderr to user only but continue with tool call':
    'stderr をユーザーのみに表示し、ツール呼び出しを続ける',
  'block processing, erase original prompt, and show stderr to user only':
    '処理をブロックし、元のプロンプトを消去し、stderr をユーザーのみに表示',
  'stdout shown to Qwen': 'stdout を Qwen に表示',
  'show stderr to user only (blocking errors ignored)':
    'stderr をユーザーのみに表示（ブロッキングエラーは無視）',
  'command completes successfully': 'コマンドが正常に完了',
  'stdout shown to subagent': 'stdout をサブエージェントに表示',
  'show stderr to subagent and continue having it run':
    'stderr をサブエージェントに表示し、実行を続ける',
  'stdout appended as custom compact instructions':
    'stdout をカスタム圧縮指示として追加',
  'block compaction': '圧縮をブロック',
  'show stderr to user only but continue with compaction':
    'stderr をユーザーのみに表示し、圧縮を続ける',
  'use hook decision if provided': '提供されている場合はフックの決定を使用',
  'allow todo creation': 'Todo作成を許可',
  'block todo creation and show reason to model':
    'Todo作成をブロックし、理由をモデルに表示',
  'allow todo completion': 'Todo完了を許可',
  'block todo completion and show reason to model':
    'Todo完了をブロックし、理由をモデルに表示',
  // Hooks - Messages
  'Config not loaded.': '設定が読み込まれていません。',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'フックが有効になっていません。この機能を使用するには設定でフックを有効にしてください。',
  // ============================================================================
  // Commands - Session Export
  // ============================================================================
  'Export current session message history to a file':
    '現在のセッションのメッセージ履歴をファイルにエクスポートする',
  'Export session to HTML format': 'セッションを HTML 形式でエクスポートする',
  'Export session to JSON format': 'セッションを JSON 形式でエクスポートする',
  'Export session to JSONL format (one message per line)':
    'セッションを JSONL 形式でエクスポートする（1 行に 1 メッセージ）',
  'Export session to markdown format':
    'セッションを Markdown 形式でエクスポートする',

  // ============================================================================
  // Commands - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    'チャット履歴からパーソナライズされたプログラミングインサイトを生成する',

  // ============================================================================
  // Commands - Session History
  // ============================================================================
  'Resume a previous session': '前のセッションを再開する',
  'Fork the current conversation into a new session':
    '現在の会話を新しいセッションに分岐する',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    '応答またはツール呼び出しの処理中は分岐できません。完了するか、保留中のツール呼び出しを解決してください。',
  'No conversation to branch.': '分岐できる会話がありません。',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    'ツール呼び出しを復元します。これにより、会話とファイルの履歴はそのツール呼び出しが提案された時点の状態に戻ります',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'ターミナルの種類を検出できませんでした。サポートされているターミナル: VS Code、Cursor、Windsurf、Trae',
  'Terminal "{{terminal}}" is not supported yet.':
    'ターミナル "{{terminal}}" はまだサポートされていません',
  // Commands - Language
  'Invalid language. Available: {{options}}':
    '無効な言語です。使用可能: {{options}}',
  'Language subcommands do not accept additional arguments.':
    '言語サブコマンドは追加の引数を受け付けません',
  'Current UI language: {{lang}}': '現在のUI言語: {{lang}}',
  'Current LLM output language: {{lang}}': '現在のLLM出力言語: {{lang}}',
  'Set UI language': 'UI言語を設定',
  'Set LLM output language': 'LLM出力言語を設定',
  'Usage: /language ui [{{options}}]': '使い方: /language ui [{{options}}]',
  'Usage: /language output <language>': '使い方: /language output <言語>',
  'Example: /language output 中文': '例: /language output 中文',
  'Example: /language output English': '例: /language output English',
  'Example: /language output 日本語': '例: /language output 日本語',
  'UI language changed to {{lang}}': 'UI言語を {{lang}} に変更しました',
  'Please restart the application for the changes to take effect.':
    '変更を有効にするにはアプリケーションを再起動してください',
  'Failed to generate LLM output language rule file: {{error}}':
    'LLM出力言語ルールファイルの生成に失敗: {{error}}',
  'Invalid command. Available subcommands:':
    '無効なコマンドです。使用可能なサブコマンド:',
  'Available subcommands:': '使用可能なサブコマンド:',
  'To request additional UI language packs, please open an issue on GitHub.':
    '追加のUI言語パックをリクエストするには、GitHub で Issue を作成してください',
  'Available options:': '使用可能なオプション:',
  'Set UI language to {{name}}': 'UI言語を {{name}} に設定',
  '{{mode}} mode': '{{mode}}モード',
  'Analyze only, do not modify files or execute commands':
    '分析のみ、ファイルの変更やコマンドの実行はしません',
  'Require approval for file edits or shell commands':
    'ファイル編集やシェルコマンドには承認が必要',
  'Automatically approve file edits': 'ファイル編集を自動承認',
  'Automatically approve all tools': 'すべてのツールを自動承認',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'ワークスペースの承認モードが存在し、優先されます。ユーザーレベルの変更は効果がありません',
  'Apply To': '適用先',
  'Workspace Settings': 'ワークスペース設定',
  'Open auto-memory folder': '自動メモリフォルダを開く',
  'Auto-memory: {{status}}': '自動メモリ: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    '自動統合: {{status}} · {{lastDream}} · /dream で実行',
  never: '未実行',
  on: 'オン',
  off: 'オフ',
  'Remove matching entries from managed auto-memory.':
    'マネージド自動メモリから一致するエントリを削除する。',
  'Usage: /forget <memory text to remove>':
    '使い方: /forget <削除するメモリテキスト>',
  'No managed auto-memory entries matched: {{query}}':
    '一致するマネージド自動メモリエントリなし: {{query}}',
  'Consolidate managed auto-memory topic files.':
    'マネージド自動メモリトピックファイルを統合する。',
  'No MCP servers configured.': 'MCP servers が設定されていません',
  'Could not retrieve tool registry.': 'ツールレジストリを取得できませんでした',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "'{{name}}' の認証とツール更新に成功しました",
  "Re-discovering tools from '{{name}}'...":
    "'{{name}}' からツールを再検出中...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "'{{name}}' から {{count}} 個のツールを検出しました。",
  'Authentication complete. Returning to server details...':
    '認証完了。サーバー詳細に戻ります...',
  'Authentication successful.': '認証成功。',
  'Configured MCP servers:': '設定済み MCP servers:',
  Ready: '準備完了',
  Disconnected: '切断',
  '{{count}} tool': '{{count}} ツール',
  '{{count}} tools': '{{count}} ツール',
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'プロジェクトサマリーを生成し、.qwen/PROJECT_SUMMARY.md に保存',
  'No chat client available to generate summary.':
    'サマリーを生成するためのチャットクライアントがありません',
  'Already generating summary, wait for previous request to complete':
    'サマリー生成中です。前のリクエストの完了をお待ちください',
  'No conversation found to summarize.': '要約する会話が見つかりません',
  'Failed to generate project context summary: {{error}}':
    'プロジェクトコンテキストサマリーの生成に失敗: {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'プロジェクトサマリーを {{filePathForDisplay}} に保存しました',
  'Saving project summary...': 'プロジェクトサマリーを保存中...',
  'Generating project summary...': 'プロジェクトサマリーを生成中...',
  'Processing summary...': 'サマリーを処理中...',
  'Project summary generated and saved successfully!':
    'プロジェクトサマリーを生成して保存しました！',
  'Saved to: {{filePath}}': '保存先: {{filePath}}',
  'Stopped because': '停止理由',
  'Failed to generate summary - no text content received from LLM response':
    'サマリーの生成に失敗 - LLMレスポンスからテキストコンテンツを受信できませんでした',
  // Model
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'このセッションのモデルを切り替え（--fast で提案モデルを設定）',
  'Set a lighter model for prompt suggestions and speculative execution':
    'プロンプト提案と投機的実行用の軽量モデルを設定',
  'Content generator configuration not available.':
    'コンテンツジェネレーター設定が利用できません',
  'Authentication type not available.': '認証タイプが利用できません',
  'No models available for the current authentication type ({{authType}}).':
    '現在の認証タイプ({{authType}})で利用可能なモデルはありません',
  // Needs translation
  // Clear
  'Starting a new session, resetting chat, and clearing terminal.':
    '新しいセッションを開始し、チャットをリセットし、ターミナルをクリアしています',
  'Starting a new session and clearing.':
    '新しいセッションを開始してクリアしています',
  // Compress
  'Already compressing, wait for previous request to complete':
    '圧縮中です。前のリクエストの完了をお待ちください',
  'Failed to compress chat history.': 'チャット履歴の圧縮に失敗しました',
  'Failed to compress chat history: {{error}}':
    'チャット履歴の圧縮に失敗: {{error}}',
  'Compressing chat history': 'チャット履歴を圧縮中',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'チャット履歴を {{originalTokens}} トークンから {{newTokens}} トークンに圧縮しました',
  'Compression was not beneficial for this history size.':
    'この履歴サイズには圧縮の効果がありませんでした',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'チャット履歴の圧縮でサイズが減少しませんでした。圧縮プロンプトに問題がある可能性があります',
  'Could not compress chat history due to a token counting error.':
    'トークンカウントエラーのため、チャット履歴を圧縮できませんでした',
  // Directory
  'Configuration is not available.': '設定が利用できません',
  'Please provide at least one path to add.':
    '追加するパスを少なくとも1つ指定してください',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    '制限的なサンドボックスプロファイルでは /directory add コマンドはサポートされていません。代わりにセッション開始時に --include-directories を使用してください',
  "Error adding '{{path}}': {{error}}":
    "'{{path}}' の追加中にエラー: {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    '以下のディレクトリから QWEN.md ファイルを追加しました(存在する場合):\n- {{directories}}',
  'Error refreshing memory: {{error}}': 'メモリの更新中にエラー: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'ディレクトリを正常に追加しました:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    '現在のワークスペースディレクトリ:\n{{directories}}',
  // Docs
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'ドキュメントを表示するには、ブラウザで以下のURLを開いてください:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    '  ブラウザでドキュメントを開きました: {{url}}',
  // Dialogs - Tool Confirmation
  'Do you want to proceed?': '続行しますか?',
  'Yes, allow once': 'はい(今回のみ許可)',
  'Allow always': '常に許可する',
  Yes: 'はい',
  No: 'いいえ',
  'No (esc)': 'いいえ (Esc)',
  // MCP Management - Core translations
  'Manage MCP servers': 'MCP servers を管理',
  'Server Detail': 'サーバー詳細',
  Tools: 'ツール',
  'Tool Detail': 'ツール詳細',
  'Loading...': '読み込み中...',
  'Unknown step': '不明なステップ',
  'Esc to back': 'Esc 戻る',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ ナビゲート · Enter 選択 · Esc 閉じる',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ ナビゲート · Enter 選択 · Esc 戻る',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ ナビゲート · Enter 確認 · Esc 戻る',
  'User Settings (global)': 'ユーザー設定（グローバル）',
  'Workspace Settings (project-specific)':
    'ワークスペース設定（プロジェクト固有）',
  'Disable server:': 'サーバーを無効化:',
  'Select where to add the server to the exclude list:':
    'サーバーを除外リストに追加する場所を選択してください:',
  'Press Enter to confirm, Esc to cancel': 'Enter で確認、Esc でキャンセル',
  Disable: '無効化',
  Enable: '有効化',
  Authenticate: '認証',
  'Re-authenticate': '再認証',
  'Clear Authentication': '認証をクリア',
  disabled: '無効',
  enabled: '有効',
  'Server:': 'サーバー:',
  Reconnect: '再接続',
  'View tools': 'ツールを表示',
  'Status:': 'ステータス:',
  'Source:': 'ソース:',
  'Command:': 'コマンド:',
  'Working Directory:': '作業ディレクトリ:',
  'No server selected': 'サーバーが選択されていません',
  'Error:': 'エラー:',
  tool: 'ツール',
  tools: 'ツール',
  connected: '接続済み',
  connecting: '接続中',
  disconnected: '切断済み',
  error: 'エラー',

  // MCP Server List
  'User MCPs': 'ユーザーMCP',
  'Project MCPs': 'プロジェクトMCP',
  'Extension MCPs': '拡張機能MCP',
  server: 'サーバー',
  servers: 'サーバー',
  'Add MCP servers to your settings to get started.':
    '設定に MCP servers を追加して開始してください。',
  'Run qwen --debug to see error logs':
    'qwen --debug を実行してエラーログを確認してください',

  // MCP OAuth Authentication
  'OAuth Authentication': 'OAuth 認証',
  'Authenticating... Please complete the login in your browser.':
    '認証中... ブラウザでログインを完了してください。',
  // MCP Tool List
  'No tools available for this server.':
    'このサーバーには使用可能なツールがありません。',
  destructive: '破壊的',
  'read-only': '読み取り専用',
  'open-world': 'オープンワールド',
  idempotent: '冪等',
  'Tools for {{serverName}}': '{{serverName}} のツール',
  '{{current}}/{{total}}': '{{current}}/{{total}}',

  // MCP Tool Detail
  required: '必須',
  Parameters: 'パラメータ',
  'No tool selected': 'ツールが選択されていません',
  Server: 'サーバー',

  // Invalid tool related translations
  '{{count}} invalid tools': '{{count}} 個の無効なツール',
  invalid: '無効',
  'invalid: {{reason}}': '無効: {{reason}}',
  'missing name': '名前なし',
  'missing description': '説明なし',
  '(unnamed)': '(名前なし)',
  'Warning: This tool cannot be called by the LLM':
    '警告: このツールはLLMによって呼び出すことができません',
  Reason: '理由',
  'Tools must have both name and description to be used by the LLM.':
    'ツールはLLMによって使用されるには名前と説明の両方が必要です。',
  'Modify in progress:': '変更中:',
  'Save and close external editor to continue':
    '続行するには外部エディタを保存して閉じてください',
  'Apply this change?': 'この変更を適用しますか?',
  'Yes, allow always': 'はい、常に許可',
  'Modify with external editor': '外部エディタで編集',
  'No, suggest changes (esc)': 'いいえ、変更を提案 (Esc)',
  "Allow execution of: '{{command}}'?": "'{{command}}' の実行を許可しますか?",
  'Always allow in this project': 'このプロジェクトで常に許可',
  'Always allow {{action}} in this project':
    'このプロジェクトで{{action}}を常に許可',
  'Always allow for this user': 'このユーザーに常に許可',
  'Always allow {{action}} for this user': 'このユーザーに{{action}}を常に許可',
  'Yes, restore previous mode ({{mode}})':
    'はい、以前のモードに戻す ({{mode}})',
  'Yes, and auto-accept edits': 'はい、編集を自動承認',
  'Yes, and manually approve edits': 'はい、編集を手動承認',
  'No, keep planning (esc)': 'いいえ、計画を続ける (Esc)',
  'URLs to fetch:': '取得するURL:',
  'MCP Server: {{server}}': 'MCP Server: {{server}}',
  'Tool: {{tool}}': 'ツール: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'MCP server "{{server}}" からの MCP tool "{{tool}}" の実行を許可しますか?',
  // Dialogs - Shell Confirmation
  'Shell Command Execution': 'シェルコマンド実行',
  'A custom command wants to run the following shell commands:':
    'カスタムコマンドが以下のシェルコマンドを実行しようとしています:',
  // Dialogs - Welcome Back
  'Current Plan:': '現在のプラン:',
  'Progress: {{done}}/{{total}} tasks completed':
    '進捗: {{done}}/{{total}} タスク完了',
  ', {{inProgress}} in progress': '、{{inProgress}} 進行中',
  'Pending Tasks:': '保留中のタスク:',
  'Current tasks': '現在のタスク',
  '... and {{count}} more': '... 他 {{count}} 件',
  'What would you like to do?': '何をしますか?',
  'Choose how to proceed with your session:':
    'セッションの続行方法を選択してください:',
  'Start new chat session': '新しいチャットセッションを開始',
  'Continue previous conversation': '前回の会話を続行',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 おかえりなさい!(最終更新: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 全体目標:',
  'Select Authentication Method': '認証方法を選択',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    '続行するには認証方法を選択してください。Ctrl+C をもう一度押すと終了します',
  'Terms of Services and Privacy Notice': '利用規約とプライバシー通知',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    '終了 — Coding Plan または API Key に切り替えてください',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Qwen OAuth 無料枠は 2026-04-15 に終了しました。Coding Plan または API Key を選択してください。',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Qwen OAuth無料プランは2026-04-15に終了しました。他のプロバイダーのモデルを選択するか、/authを実行して切り替えてください。',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Qwen OAuth 無料枠は 2026-04-15 に終了しました。他のオプションを選択してください。\n',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    '有料 \u00B7 5時間最大6,000リクエスト \u00B7 すべての Alibaba Cloud Coding Plan モデル',
  'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
  'Bring your own API key': '自分の API Key を使用',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    'サードパーティプロバイダーによるブラウザベースの認証（例：OpenRouter、ModelScope）',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    '認証は {{enforcedType}} に強制されていますが、現在 {{currentType}} を使用しています',
  'Qwen OAuth Authentication': 'Qwen OAuth認証',
  'Please visit this URL to authorize:':
    '認証するには以下のURLにアクセスしてください:',
  'Waiting for authorization': '認証を待っています',
  'Time remaining:': '残り時間:',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth認証タイムアウト',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuthトークンが期限切れです({{seconds}}秒以上)。認証方法を再度選択してください',
  'Press any key to return to authentication type selection.':
    '認証タイプ選択に戻るには任意のキーを押してください',
  'Waiting for Qwen OAuth authentication...': 'Qwen OAuth認証を待っています...',
  'Authentication timed out. Please try again.':
    '認証がタイムアウトしました。再度お試しください',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    '認証を待っています... (ESC または CTRL+C でキャンセル)',
  'Failed to authenticate. Message: {{message}}':
    '認証に失敗しました。メッセージ: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    '{{authType}} 認証情報で正常に認証されました',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    '無効な QWEN_DEFAULT_AUTH_TYPE 値: "{{value}}"。有効な値: {{validValues}}',
  // Dialogs - Model
  'Select Model': 'モデルを選択',
  Modality: 'モダリティ',
  'Context Window': 'コンテキストウィンドウ',
  text: 'テキスト',
  'text-only': 'テキストのみ',
  image: '画像',
  pdf: 'PDF',
  audio: '音声',
  video: '動画',
  'not set': '未設定',
  none: 'なし',
  unknown: '不明',
  // Dialogs - Permissions
  'Manage folder trust settings': 'フォルダ信頼設定を管理',
  'Manage permission rules': 'permission rules を管理',
  Allow: '許可',
  Ask: '確認',
  Deny: '拒否',
  Workspace: 'ワークスペース',
  "Qwen Code won't ask before using allowed tools.":
    'Qwen Code は許可されたツールを使用する前に確認しません。',
  'Qwen Code will ask before using these tools.':
    'Qwen Code はこれらのツールを使用する前に確認します。',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code は拒否されたツールを使用できません。',
  'Manage trusted directories for this workspace.':
    'このワークスペースの信頼済みディレクトリを管理します。',
  'Any use of the {{tool}} tool': '{{tool}} ツールのすべての使用',
  "{{tool}} commands matching '{{pattern}}'":
    "'{{pattern}}' に一致する {{tool}} コマンド",
  'From user settings': 'ユーザー設定から',
  'From project settings': 'プロジェクト設定から',
  'From session': 'セッションから',
  'Project settings': 'プロジェクト設定',
  'Checked in at .qwen/settings.json': '.qwen/settings.json にチェックイン',
  'User settings': 'ユーザー設定',
  'Saved in at ~/.qwen/settings.json': '~/.qwen/settings.json に保存',
  'Add a new rule…': '新しいルールを追加…',
  'Add {{type}} permission rule': '{{type}} permission rule を追加',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'permission rules はツール名で、オプションで括弧内に指定子を付けます。',
  'e.g.,': '例：',
  or: 'または',
  'Enter permission rule…': 'permission rule を入力…',
  'Enter to submit · Esc to cancel': 'Enter で送信 · Esc でキャンセル',
  'Where should this rule be saved?': 'このルールをどこに保存しますか？',
  'Enter to confirm · Esc to cancel': 'Enter で確認 · Esc でキャンセル',
  'Delete {{type}} rule?': '{{type}}ルールを削除しますか？',
  'Are you sure you want to delete this permission rule?':
    'この permission rule を削除してもよろしいですか？',
  'Permissions:': '権限：',
  '(←/→ or tab to cycle)': '（←/→ または Tab で切替）',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    '↑↓ でナビゲート · Enter で選択 · 入力で検索 · Esc でキャンセル',
  'Search…': '検索…',
  // Workspace directory management
  'Add directory…': 'ディレクトリを追加…',
  'Add directory to workspace': 'ワークスペースにディレクトリを追加',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code はワークスペース内のファイルを読み取り、自動編集承認が有効な場合は編集を行えます。',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code はこのディレクトリ内のファイルを読み取り、自動編集承認が有効な場合は編集を行えます。',
  'Enter the path to the directory:': 'ディレクトリのパスを入力してください:',
  'Enter directory path…': 'ディレクトリパスを入力…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab で補完 · Enter で追加 · Esc でキャンセル',
  'Remove directory?': 'ディレクトリを削除しますか？',
  'Are you sure you want to remove this directory from the workspace?':
    'このディレクトリをワークスペースから削除してもよろしいですか？',
  '  (Original working directory)': '  （元の作業ディレクトリ）',
  '  (from settings)': '  （設定より）',
  'Directory does not exist.': 'ディレクトリが存在しません。',
  'Path is not a directory.': 'パスはディレクトリではありません。',
  'This directory is already in the workspace.':
    'このディレクトリはすでにワークスペースに含まれています。',
  'Already covered by existing directory: {{dir}}':
    '既存のディレクトリによって既にカバーされています: {{dir}}',
  // Status Bar
  'Using:': '使用中:',
  '{{count}} open file': '{{count}} 個のファイルを開いています',
  '{{count}} open files': '{{count}} 個のファイルを開いています',
  '(ctrl+g to view)': '(Ctrl+G で表示)',
  '{{count}} {{name}} file': '{{count}} {{name}} ファイル',
  '{{count}} {{name}} files': '{{count}} {{name}} ファイル',
  '{{count}} MCP server': '{{count}} MCP server',
  '{{count}} MCP servers': '{{count}} MCP servers',
  '{{count}} Blocked': '{{count}} ブロック',
  '(ctrl+t to view)': '(Ctrl+T で表示)',
  '(ctrl+t to toggle)': '(Ctrl+T で切り替え)',
  'Press Ctrl+C again to exit.': 'Ctrl+C をもう一度押すと終了します',
  'Press Ctrl+D again to exit.': 'Ctrl+D をもう一度押すと終了します',
  'Press Esc again to clear.': 'Esc をもう一度押すとクリアします',
  'Press ↑ to edit queued messages': '↑ を押してキュー内のメッセージを編集',
  // MCP Status
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers を起動中({{count}} 初期化中)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    '注: 初回起動には時間がかかる場合があります。ツールの利用可能状況は自動的に更新されます',
  'Starting... (first startup may take longer)':
    '起動中...(初回起動には時間がかかる場合があります)',
  '{{count}} prompt': '{{count}} プロンプト',
  '{{count}} prompts': '{{count}} プロンプト',
  '(from {{extensionName}})': '({{extensionName}} から)',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth 期限切れ',
  'OAuth not authenticated': 'OAuth 未認証',
  'tools and prompts will appear when ready':
    'ツールとプロンプトは準備完了後に表示されます',
  '{{count}} tools cached': '{{count}} ツール(キャッシュ済み)',
  'Tools:': 'ツール:',
  'Parameters:': 'パラメータ:',
  'Prompts:': 'プロンプト:',
  Blocked: 'ブロック',
  '💡 Tips:': '💡 ヒント:',
  Use: '使用',
  'to show server and tool descriptions': 'サーバーとツールの説明を表示',
  'to show tool parameter schemas': 'tool parameter schemas を表示',
  'to hide descriptions': '説明を非表示',
  'to authenticate with OAuth-enabled servers': 'OAuth対応サーバーで認証',
  Press: '押す',
  'to toggle tool descriptions on/off': 'ツール説明の表示/非表示を切り替え',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "MCP server '{{name}}' の OAuth 認証を開始中...",
  // Startup Tips
  'Tips:': 'ヒント：',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    '会話が長くなったら /compress で履歴を要約し、コンテキストを解放できます。',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    '/clear または /new で新しいアイデアを始められます。前のセッションは履歴に残ります。',
  'Use /bug to submit issues to the maintainers when something goes off.':
    '問題が発生したら /bug でメンテナーに報告できます。',
  'Switch auth type quickly with /auth.':
    '/auth で認証タイプをすばやく切り替えられます。',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'Qwen Code から ! を使って任意のシェルコマンドを実行できます（例: !ls）。',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    '/ を入力してコマンドポップアップを開きます。Tab でスラッシュコマンドと保存済みプロンプトを補完できます。',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'qwen --continue または qwen --resume で前の会話を再開できます。',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'Shift+Tab または /approval-mode で権限モードをすばやく切り替えられます。',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'Tab または /approval-mode で権限モードをすばやく切り替えられます。',
  'Try /insight to generate personalized insights from your chat history.':
    '/insight でチャット履歴からパーソナライズされたインサイトを生成できます。',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    'Ctrl+O でコンパクトモードを切り替え — ツール出力と思考を非表示にしてすっきり表示。',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'QWEN.md ファイルを追加すると、Qwen Code に永続的なプロジェクトコンテキストを与えられます。',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    '会話を中断せずに /btw でちょっとした横道の質問ができます。',
  'Context is almost full! Run /compress now or start /new to continue.':
    'コンテキストがもうすぐいっぱいです！今すぐ /compress を実行するか、/new を開始して続けてください。',
  'Context is getting full. Use /compress to free up space.':
    'コンテキストが埋まりつつあります。/compress を使って空きを増やしてください。',
  'Long conversation? /compress summarizes history to free context.':
    '会話が長くなりましたか？ /compress は履歴を要約してコンテキストを空けます。',
  // Exit Screen / Stats
  'Agent powering down. Goodbye!': 'エージェントを終了します。さようなら!',
  'To continue this session, run': 'このセッションを続行するには、次を実行:',
  'Interaction Summary': 'インタラクション概要',
  'Session ID:': 'セッションID:',
  'Tool Calls:': 'ツール呼び出し:',
  'Success Rate:': '成功率:',
  'User Agreement:': 'ユーザー同意:',
  reviewed: 'レビュー済み',
  'Code Changes:': 'コード変更:',
  Performance: 'パフォーマンス',
  'Wall Time:': '経過時間:',
  'Agent Active:': 'エージェント稼働時間:',
  'API Time:': 'API時間:',
  'Tool Time:': 'ツール時間:',
  'Session Stats': 'セッション統計',
  'Model Usage': 'モデル使用量',
  Reqs: 'リクエスト',
  'Input Tokens': '入力トークン',
  'Output Tokens': '出力トークン',
  'Savings Highlight:': '節約ハイライト:',
  'of input tokens were served from the cache, reducing costs.':
    '入力トークンがキャッシュから提供され、コストを削減しました',
  'Tip: For a full token breakdown, run `/stats model`.':
    'ヒント: トークンの詳細な内訳は `/stats model` を実行してください',
  'Model Stats For Nerds': 'マニア向けモデル統計',
  'Tool Stats For Nerds': 'マニア向けツール統計',
  Metric: 'メトリック',
  API: 'API',
  Requests: 'リクエスト',
  Errors: 'エラー',
  'Avg Latency': '平均レイテンシ',
  Tokens: 'トークン',
  Total: '合計',
  Prompt: 'プロンプト',
  Cached: 'キャッシュ',
  Thoughts: '思考',
  Output: '出力',
  'No API calls have been made in this session.':
    'このセッションではAPI呼び出しが行われていません',
  'Tool Name': 'ツール名',
  Calls: '呼び出し',
  'Success Rate': '成功率',
  'Avg Duration': '平均時間',
  'User Decision Summary': 'ユーザー決定サマリー',
  'Total Reviewed Suggestions:': '総レビュー提案数:',
  ' » Accepted:': ' » 承認:',
  ' » Rejected:': ' » 却下:',
  ' » Modified:': ' » 変更:',
  ' Overall Agreement Rate:': ' 全体承認率:',
  'No tool calls have been made in this session.':
    'このセッションではツール呼び出しが行われていません',
  'Session start time is unavailable, cannot calculate stats.':
    'セッション開始時刻が利用できないため、統計を計算できません',
  // Loading
  'Waiting for user confirmation...': 'ユーザーの確認を待っています...',
  // Witty Loading Phrases
  WITTY_LOADING_PHRASES: [
    '運任せで検索中...',
    '中の人がタイピング中...',
    'ロジックを最適化中...',
    '電子の数を確認中...',
    '宇宙のバグをチェック中...',
    '大量の0と1をコンパイル中...',
    'HDDと思い出をデフラグ中...',
    'ビットをこっそり入れ替え中...',
    'ニューロンの接続を再構築中...',
    'どこかに行ったセミコロンを捜索中...',
    'フラックスキャパシタを調整中...',
    'フォースと交感中...',
    'アルゴリズムをチューニング中...',
    '白いウサギを追跡中...',
    'カセットフーフー中...',
    'ローディングメッセージを考え中...',
    'ほぼ完了...多分...',
    '最新のミームについて調査中...',
    'この表示を改善するアイデアを思索中...',
    'この問題を考え中...',
    'それはバグでなく誰も知らない新機能だよ',
    'ダイヤルアップ接続音が終わるのを待機中...',
    'コードに油を追加中...',

    // かなり意訳が入ってるもの
    'イヤホンをほどき中...',
    'カフェインをコードに変換中...',
    '天動説を地動説に書き換え中...',
    'プールで時計の完成を待機中...',
    '笑撃的な回答を用意中...',
    '適切なミームを記述中...',
    'Aボタンを押して次へ...',
    'コードにリックロールを仕込み中...',
    'プログラマーが貧乏なのはキャッシュを使いすぎるから...',
    'プログラマーがダークモードなのはバグを見たくないから...',
    'コードが壊れた?叩けば治るさ',
    'USBの差し込みに挑戦中...',
  ],

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'settings.json で API Key とモデルを設定できます',
  'Refer to the documentation for setup instructions':
    'セットアップ手順はドキュメントを参照してください',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'API Key は空にできません。',
  'You can get your Coding Plan API key here':
    'Coding Plan API Key はこちらで取得できます',
  'Failed to update Coding Plan configuration: {{message}}':
    'Coding Plan の設定更新に失敗しました: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  Custom: 'カスタム',
  'Select Region for Coding Plan': 'Coding Planのリージョンを選択',
  'Choose based on where your account is registered':
    'アカウントの登録先に応じて選択してください',
  'Enter Coding Plan API Key': 'Coding Plan API Key を入力',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    '{{region}} の新しいモデル設定が利用可能です。今すぐ更新しますか？',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}} の設定が正常に更新されました。モデルが "{{model}}" に切り替わりました。',
  // ============================================================================
  // Context Usage Component
  // ============================================================================
  'Context Usage': 'コンテキスト使用量',
  '% used': '% 使用',
  '% context used': '% コンテキスト使用',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'コンテキストが制限を超えています！/compress または /clear を使用して減らしてください。',
  'No API response yet. Send a message to see actual usage.':
    'API応答はありません。メッセージを送信して実際の使用量を確認してください。',
  'Estimated pre-conversation overhead': '推定事前会話オーバーヘッド',
  'Context window': 'コンテキストウィンドウ',
  tokens: 'トークン',
  Used: '使用済み',
  Free: '空き',
  'Autocompact buffer': '自動圧縮バッファ',
  'Usage by category': 'カテゴリ別の使用量',
  'System prompt': 'システムプロンプト',
  'Built-in tools': '組み込みツール',
  'MCP tools': 'MCP tools',
  'Memory files': 'メモリファイル',
  Skills: 'スキル',
  Messages: 'メッセージ',
  'Run /context detail for per-item breakdown.':
    '/context detail を実行すると項目ごとの内訳を表示します。',
  active: '有効',
  'body loaded': '本文読み込み済み',
  memory: 'メモリ',
  '{{region}} configuration updated successfully.':
    '{{region}} の設定が正常に更新されました。',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    '{{region}} での認証に成功しました。API Key とモデル設定が settings.json に保存されました。',
  'Tip: Use /model to switch between available Coding Plan models.':
    'ヒント: /model で利用可能な Coding Plan モデルを切り替えられます。',
  'Type something...': '何か入力...',
  Submit: '送信',
  'Submit answers': '回答を送信',
  Cancel: 'キャンセル',
  'Your answers:': 'あなたの回答：',
  '(not answered)': '(未回答)',
  'Ready to submit your answers?': '回答を送信しますか？',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: ナビゲート | ←/→: タブ切り替え | Enter: 選択',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: ナビゲート | Enter: 選択 | Esc: キャンセル',
  'Authenticate using Qwen OAuth': 'Qwen OAuth で認証する',
  'Authenticate using Alibaba Cloud Coding Plan':
    'Alibaba Cloud Coding Plan で認証する',
  'Region for Coding Plan (china/global)':
    'Coding Plan のリージョン (china/global)',
  'API key for Coding Plan': 'Coding Plan の API Key',
  'Show current authentication status': '現在の認証ステータスを表示',
  'Authentication completed successfully.': '認証が正常に完了しました。',
  'Starting Qwen OAuth authentication...': 'Qwen OAuth 認証を開始しています...',
  'Successfully authenticated with Qwen OAuth.':
    'Qwen OAuth での認証に成功しました。',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Qwen OAuth での認証に失敗しました: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'Alibaba Cloud Coding Plan 認証を処理しています...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'Alibaba Cloud Coding Plan での認証に成功しました。',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Coding Plan での認証に失敗しました: {{error}}',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'グローバル',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Coding Plan のリージョンを選択:',
  'Enter your Coding Plan API key: ':
    'Coding Plan の API Key を入力してください: ',
  'Select authentication method:': '認証方法を選択:',
  '\n=== Authentication Status ===\n': '\n=== 認証ステータス ===\n',
  '⚠️  No authentication method configured.\n':
    '⚠️  認証方法が設定されていません。\n',
  'Run one of the following commands to get started:\n':
    '以下のコマンドのいずれかを実行して開始してください:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - Qwen OAuth で認証（終了）',
  'Or simply run:': 'または以下を実行:',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - インタラクティブ認証セットアップ\n',
  '✓ Authentication Method: Qwen OAuth': '✓ 認証方法: Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  タイプ: 無料枠（2026-04-15 終了）',
  '  Limit: No longer available': '  制限: 利用不可',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Qwen OAuth 無料枠は 2026-04-15 に終了しました。/auth を実行して Coding Plan、OpenRouter、Fireworks AI、または他のプロバイダーに切り替えてください。',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ 認証方法: Alibaba Cloud Coding Plan',
  'Global - Alibaba Cloud': 'グローバル - Alibaba Cloud',
  '  Region: {{region}}': '  リージョン: {{region}}',
  '  Current Model: {{model}}': '  現在のモデル: {{model}}',
  '  Config Version: {{version}}': '  設定バージョン: {{version}}',
  '  Status: API key configured\n': '  ステータス: API Key 設定済み\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  認証方法: Alibaba Cloud Coding Plan（不完全）',
  '  Issue: API key not found in environment or settings\n':
    '  問題: 環境変数または設定に API Key が見つかりません\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  `qwen auth coding-plan` を実行して再設定してください。\n',
  '✓ Authentication Method: {{type}}': '✓ 認証方法: {{type}}',
  '  Status: Configured\n': '  ステータス: 設定済み\n',
  'Failed to check authentication status: {{error}}':
    '認証ステータスの確認に失敗しました: {{error}}',
  'Select an option:': 'オプションを選択:',
  'Raw mode not available. Please run in an interactive terminal.':
    'Rawモードが利用できません。インタラクティブターミナルで実行してください。',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(↑ ↓ 矢印キーで移動、Enter で選択、Ctrl+C で終了)\n',
  'to toggle compact mode': 'コンパクトモードの切り替え',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'コンパクトモードでツール出力と思考を非表示にします（Ctrl+O で切り替え）。',
  'Press Ctrl+O to show full tool output': 'Ctrl+O で完全なツール出力を表示',
  'Switch to plan mode or exit plan mode':
    'プランモードに切り替えるか、プランモードを終了する',
  'Exited plan mode. Previous approval mode restored.':
    'プランモードを終了しました。以前の承認モードに戻りました。',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'プランモードを有効にしました。エージェントはツールを実行せずに分析と計画のみを行います。',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'すでにプランモードです。"/plan exit" でプランモードを終了します。',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'プランモードではありません。"/plan" で先にプランモードに入ってください。',
  "Set up Qwen Code's status line UI": 'Qwen Code のステータスライン UI を設定',

  // === Core: added from PR #3328 ===
  'Open the memory manager.': 'メモリマネージャーを開く。',
  'Save a durable memory to the memory system.':
    '永続メモリをメモリシステムに保存する。',
  prompts: 'プロンプト',
  '↑ to manage attachments': '↑ で添付を管理',
  '← → select, Delete to remove, ↓ to exit':
    '← → で選択、Delete で削除、↓ で終了',
  'Attachments: ': '添付: ',
  '(tab to cycle)': '(Tab で切り替え)',
  'Toggle this help display': 'このヘルプ表示を切り替え',
  'Toggle shell mode': 'シェルモードを切り替え',
  'Open command menu': 'コマンドメニューを開く',
  'Add file context': 'ファイルコンテキストを追加',
  'Accept suggestion / Autocomplete': '候補を受け入れる / 自動補完',
  'Reverse search history': '履歴を逆方向に検索',
  'Press ? again to close': '? をもう一度押して閉じる',
  'for shell mode': 'シェルモード用',
  'for commands': 'コマンド用',
  'for file paths': 'ファイルパス用',
  'to clear input': '入力をクリア',
  'to cycle approvals': '承認モードを切り替え',
  'to quit': '終了',
  'for newline': '改行',
  'to clear screen': '画面をクリア',
  'to search history': '履歴を検索',
  'to paste images': '画像を貼り付け',
  'for external editor': '外部エディタ用',
  '? for shortcuts': '? でショートカット表示',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    '無効な承認モード "{{arg}}" です。有効なモード: {{modes}}',
  'Approval mode set to "{{mode}}"': '承認モードを "{{mode}}" に設定しました',
  '(Use Enter to apply scope, Tab to go back)':
    '(Enter でスコープを適用、Tab で戻る)',
  'Extension Agents': '拡張エージェント',
  'Terminal Bell Notification': 'ターミナルベル通知',
  'Enable Usage Statistics': '使用統計を有効化',
  'Preferred Editor': '優先エディタ',
  'Auto-connect to IDE': 'IDE に自動接続',
  'Language: UI': '言語: UI',
  'Language: Model': '言語: モデル',
  'Show Line Numbers in Code': 'コードの行番号を表示',
  'Show Welcome Back Dialog': 'おかえりダイアログを表示',
  'Enable User Feedback': 'ユーザーフィードバックを有効化',
  'How is Qwen doing this session? (optional)':
    'このセッションでの Qwen の調子はどうですか？（任意）',
  'Interactive Shell (PTY)': '対話型シェル (PTY)',
  'Select Editor': 'エディタを選択',
  'Editor Preference': 'エディタ設定',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    '現在サポートされているエディタです。サンドボックスモードでは一部のエディタが利用できない場合があります。',
  'Your preferred editor is:': '現在の優先エディタ:',
  'Open MCP management dialog': 'MCP 管理ダイアログを開く',
  'Install an extension from a git repo or local path':
    'git リポジトリまたはローカルパスから拡張機能をインストール',
  'Disable an extension': '拡張機能を無効化',
  'Enable an extension': '拡張機能を有効化',
  'Uninstall an extension': '拡張機能をアンインストール',
  'Manage extension settings': '拡張機能の設定を管理',
  'Lists installed extensions.': 'インストール済みの拡張機能を一覧表示します。',
  'Updates all extensions or a named extension to the latest version.':
    'すべての拡張機能、または指定した拡張機能を最新バージョンに更新します。',
  'Open extensions page in your browser': 'ブラウザで拡張機能ページを開く',
  'Manage Extensions': '拡張機能を管理',
  'Extension Details': '拡張機能の詳細',
  'View Extension': '拡張機能を表示',
  'Update Extension': '拡張機能を更新',
  'Disable Extension': '拡張機能を無効化',
  'Enable Extension': '拡張機能を有効化',
  'Uninstall Extension': '拡張機能をアンインストール',
  'Select Scope': 'スコープを選択',
  'User Scope': 'ユーザースコープ',
  'Workspace Scope': 'ワークスペーススコープ',
  'No extensions found.': '拡張機能が見つかりません。',
  'Are you sure you want to uninstall extension "{{name}}"?':
    '拡張機能 "{{name}}" をアンインストールしてもよろしいですか？',
  'This action cannot be undone.': 'この操作は元に戻せません。',
  'Extension "{{name}}" updated successfully.':
    '拡張機能 "{{name}}" を更新しました。',
  'Name:': '名前:',
  'MCP Servers:': 'MCP Servers:',
  'Settings:': '設定:',
  'View Details': '詳細を表示',
  'Update failed:': '更新に失敗しました:',
  'Updating {{name}}...': '{{name}} を更新中...',
  'Update complete!': '更新が完了しました！',
  'User (global)': 'ユーザー (グローバル)',
  'Workspace (project-specific)': 'ワークスペース (プロジェクト固有)',
  'Disable "{{name}}" - Select Scope': '"{{name}}" を無効化 - スコープを選択',
  'Enable "{{name}}" - Select Scope': '"{{name}}" を有効化 - スコープを選択',
  'No extension selected': '拡張機能が選択されていません',
  '{{count}} extensions installed': '{{count}} 個の拡張機能をインストール済み',
  'up to date': '最新',
  'update available': '更新あり',
  'checking...': '確認中...',
  'not updatable': '更新不可',
  'LLM output language set to {{lang}}':
    'LLM 出力言語を {{lang}} に設定しました',
  'Tool Approval Mode': 'ツール承認モード',
  'Ask a quick side question without affecting the main conversation':
    'メインの会話に影響を与えずに、ちょっとした質問をする',
  'Manage Arena sessions': 'Arena セッションを管理',
  'Start an Arena session with multiple models competing on the same task':
    '同じタスクで複数モデルを競わせる Arena セッションを開始',
  'Stop the current Arena session': '現在の Arena セッションを停止',
  'Show the current Arena session status':
    '現在の Arena セッションの状態を表示',
  'Select a model result and merge its diff into the current workspace':
    'モデル結果を選択し、その差分を現在のワークスペースにマージ',
  'No running Arena session found.':
    '実行中の Arena セッションが見つかりません。',
  'No Arena session found. Start one with /arena start.':
    'Arena セッションが見つかりません。/arena start で開始してください。',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Arena セッションはまだ実行中です。完了を待つか、最初に /arena stop を使用してください。',
  'No successful agent results to select from. All agents failed or were cancelled.':
    '選択可能な成功したエージェント結果がありません。すべてのエージェントが失敗したかキャンセルされました。',
  'Use /arena stop to end the session.':
    '/arena stop でセッションを終了してください。',
  'No idle agent found matching "{{name}}".':
    '"{{name}}" に一致するアイドルエージェントが見つかりません。',
  'Failed to apply changes from {{label}}: {{error}}':
    '{{label}} からの変更の適用に失敗しました: {{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    '{{label}} からの変更をワークスペースに適用しました。Arena セッションが完了しました。',
  'Discard all Arena results and clean up worktrees?':
    'すべての Arena 結果を破棄してワークツリーをクリーンアップしますか？',
  'Arena results discarded. All worktrees cleaned up.':
    'Arena 結果が破棄されました。すべてのワークツリーがクリーンアップされました。',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena は非対話モードではサポートされていません。対話モードで Arena セッションを開始してください。',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena は非対話モードではサポートされていません。対話モードで Arena セッションを停止してください。',
  'Arena is not supported in non-interactive mode.':
    'Arena は非対話モードではサポートされていません。',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    '既存の Arena セッションがあります。新しいセッションを開始する前に /arena stop または /arena select で終了してください。',
  'Usage: /arena start --models model1,model2 <task>':
    '使用法: /arena start --models model1,model2 <task>',
  'Models to compete (required, at least 2)':
    '競合させるモデル（必須、最低2つ）',
  'Format: authType:modelId or just modelId':
    '形式: authType:modelId または modelId のみ',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena には最低 2 つのモデルが必要です。--models model1,model2 で指定してください。',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena が {{count}} エージェントでタスク "{{task}}" を開始しました\nモデル:\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Arena ペインが tmux で実行中です。次のコマンドで接続: `{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] 失敗: {{error}}',
  'Loading suggestions...': '提案を読み込み中...',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'コンテキストウィンドウ使用量の内訳を表示します。項目ごとの内訳は "/context detail" を使用してください。',
  'Show per-item context usage breakdown.':
    '項目ごとのコンテキスト使用量の内訳を表示します。',

  // === Missing key backfill ===
  Status: 'ステータス',
  'Qwen Code': 'Qwen Code',
  Runtime: 'ランタイム',
  OS: 'OS',
  Auth: '認証',
  Proxy: 'プロキシ',
  'Updating...': '更新中...',
  Unknown: '不明',
  Error: 'エラー',
  'Version:': 'バージョン:',
  "Use '/extensions install' to install your first extension.":
    "'/extensions install' を使って最初の拡張機能をインストールしてください。",
  Theme: 'テーマ',
  Bad: '悪い',
  Fine: '普通',
  Good: '良い',
  Dismiss: '閉じる',
  'No extensions installed.': 'インストールされた拡張機能はありません。',
  'Extension "{{name}}" not found.': '拡張機能 "{{name}}" が見つかりません。',
  'No extensions to update.': '更新する拡張機能はありません。',
  'Usage: /extensions install <source>': '使用法: /extensions install <source>',
  'Installing extension from "{{source}}"...':
    '"{{source}}" から拡張機能をインストールしています...',
  'Extension "{{name}}" installed successfully.':
    '拡張機能 "{{name}}" をインストールしました。',
  'Failed to install extension from "{{source}}": {{error}}':
    '"{{source}}" からの拡張機能インストールに失敗しました: {{error}}',
  'Do you want to continue? [Y/n]: ': '続行しますか？ [Y/n]: ',
  'Do you want to continue?': '続行しますか？',
  'Installing extension "{{name}}".':
    '拡張機能 "{{name}}" をインストールしています。',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**拡張機能は予期しない動作を引き起こす可能性があります。ソースを確認し、作者を信頼できることを確認してください。**',
  'This extension will run the following MCP servers:':
    'この拡張機能は次の MCP servers を実行します:',
  local: 'ローカル',
  remote: 'リモート',
  'This extension will add the following commands: {{commands}}.':
    'この拡張機能は次のコマンドを追加します: {{commands}}。',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'この拡張機能は {{fileName}} を使って QWEN.md コンテキストに情報を追記します',
  'This extension will install the following skills:':
    'この拡張機能は次のスキルをインストールします:',
  'This extension will install the following subagents:':
    'この拡張機能は次のサブエージェントをインストールします:',
  'Installation cancelled for "{{name}}".':
    '"{{name}}" のインストールをキャンセルしました。',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref と --auto-update はマーケットプレイス拡張機能には適用できません。',
  'Extension "{{name}}" installed successfully and enabled.':
    '拡張機能 "{{name}}" をインストールし、有効化しました。',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'インストールする拡張機能の GitHub URL、ローカルパス、またはマーケットプレイスソース (marketplace-url:plugin-name)。',
  'The git ref to install from.': 'インストール元の git ref。',
  'Enable auto-update for this extension.':
    'この拡張機能の自動更新を有効にします。',
  'Enable pre-release versions for this extension.':
    'この拡張機能でプレリリース版を有効にします。',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    '拡張機能インストールのセキュリティリスクを了承し、確認プロンプトをスキップします。',
  'The source argument must be provided.':
    'source 引数を指定する必要があります。',
  'Extension "{{name}}" successfully uninstalled.':
    '拡張機能 "{{name}}" を正常にアンインストールしました。',
  'Uninstalls an extension.': '拡張機能をアンインストールします。',
  'The name or source path of the extension to uninstall.':
    'アンインストールする拡張機能の名前またはソースパス。',
  'Please include the name of the extension to uninstall as a positional argument.':
    'アンインストールする拡張機能名を位置引数として指定してください。',
  'Enables an extension.': '拡張機能を有効にします。',
  'The name of the extension to enable.': '有効化する拡張機能の名前。',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    '拡張機能を有効化するスコープ。未指定の場合はすべてのスコープで有効化されます。',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'スコープ "{{scope}}" で拡張機能 "{{name}}" を正常に有効化しました。',
  'Extension "{{name}}" successfully enabled in all scopes.':
    '拡張機能 "{{name}}" をすべてのスコープで正常に有効化しました。',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    '無効なスコープです: {{scope}}。{{scopes}} のいずれかを指定してください。',
  'Disables an extension.': '拡張機能を無効にします。',
  'The name of the extension to disable.': '無効化する拡張機能の名前。',
  'The scope to disable the extenison in.': '拡張機能を無効化するスコープ。',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'スコープ "{{scope}}" で拡張機能 "{{name}}" を正常に無効化しました。',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    '拡張機能 "{{name}}" を更新しました: {{oldVersion}} → {{newVersion}}。',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'インストールメタデータが不足しているため拡張機能 "{{name}}" をインストールできません',
  'Extension "{{name}}" is already up to date.':
    '拡張機能 "{{name}}" はすでに最新です。',
  'Update all extensions.': 'すべての拡張機能を更新します。',
  'The name of the extension to update.': '更新する拡張機能の名前。',
  'Either an extension name or --all must be provided':
    '拡張機能名または --all のいずれかを指定する必要があります',
  'Path:': 'パス:',
  'Type:': '種類:',
  'Ref:': '参照:',
  'Release tag:': 'リリースタグ:',
  'Enabled (User):': '有効 (ユーザー):',
  'Enabled (Workspace):': '有効 (ワークスペース):',
  'Context files:': 'コンテキストファイル:',
  'Skills:': 'スキル:',
  'Agents:': 'エージェント:',
  'MCP servers:': 'MCP servers:',
  'Link extension failed to install.':
    'リンク拡張機能のインストールに失敗しました。',
  'Extension "{{name}}" linked successfully and enabled.':
    '拡張機能 "{{name}}" を正常にリンクし、有効化しました。',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'ローカルパスから拡張機能をリンクします。ローカルパスへの更新は常に反映されます。',
  'The name of the extension to link.': 'リンクする拡張機能の名前。',
  'Set a specific setting for an extension.':
    '拡張機能に特定の設定を行います。',
  'Name of the extension to configure.': '設定する拡張機能の名前。',
  'The setting to configure (name or env var).':
    '設定する項目 (名前または環境変数)。',
  'The scope to set the setting in.': '設定を適用するスコープ。',
  'List all settings for an extension.':
    '拡張機能のすべての設定を一覧表示します。',
  'Name of the extension.': '拡張機能の名前。',
  'Extension "{{name}}" has no settings to configure.':
    '拡張機能 "{{name}}" には設定可能な項目がありません。',
  'Settings for "{{name}}":': '"{{name}}" の設定:',
  '(workspace)': '(ワークスペース)',
  '(user)': '(ユーザー)',
  '[not set]': '[未設定]',
  '[value stored in keychain]': '[値はキーチェーンに保存されています]',
  'Value:': '値:',
  'Manage extension settings.': '拡張機能の設定を管理します。',
  'You need to specify a command (set or list).':
    'コマンド (set または list) を指定する必要があります。',
  'No plugins available in this marketplace.':
    'このマーケットプレイスで利用可能なプラグインはありません。',
  'Select a plugin to install from marketplace "{{name}}":':
    'マーケットプレイス "{{name}}" からインストールするプラグインを選択してください:',
  'Plugin selection cancelled.': 'プラグイン選択をキャンセルしました。',
  'Select a plugin from "{{name}}"': '"{{name}}" からプラグインを選択',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    '↑↓ または j/k で移動、Enter で選択、Escape でキャンセル',
  '{{count}} more above': '上にあと {{count}} 件',
  '{{count}} more below': '下にあと {{count}} 件',
  'Press c to copy the authorization URL to your clipboard.':
    'c キーで認証 URL をクリップボードにコピーします。',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'コピー要求をターミナルに送信しました。貼り付け結果が空の場合は、上の URL を手動でコピーしてください。',
  'Cannot write to terminal — copy the URL above manually.':
    'ターミナルに書き込めないため、上の URL を手動でコピーしてください。',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'OpenAI 互換認証用の API Key がありません。`settings.security.auth.apiKey` を設定するか、環境変数 {{envKeyHint}} を設定してください。',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    '環境変数 {{envKeyHint}} が見つかりません。.env ファイルまたは環境変数に設定してください。',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    '環境変数 {{envKeyHint}} が見つかりません (または settings.security.auth.apiKey を設定してください)。.env ファイルまたは環境変数に設定してください。',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'OpenAI 互換認証用の API Key がありません。環境変数 {{envKeyHint}} を設定してください。',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Anthropic プロバイダーで必須の `modelProviders[].baseUrl` が設定されていません。',
  'ANTHROPIC_BASE_URL environment variable not found.':
    '環境変数 ANTHROPIC_BASE_URL が見つかりません。',
  'Invalid auth method selected.': '無効な認証方式が選択されました。',
  'API Key': 'API Key',
  '(default)': '(デフォルト)',
  '(not set)': '(未設定)',
  'Command Format Migration': 'コマンド形式の移行',
  'Found {{count}} TOML command file:':
    'TOML 形式のコマンドファイルが {{count}} 件見つかりました:',
  'Found {{count}} TOML command files:':
    'TOML 形式のコマンドファイルが {{count}} 件見つかりました:',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'TOML 形式は非推奨です。Markdown 形式へ移行しますか？',
  '(Backups will be created and original files will be preserved)':
    '(バックアップが作成され、元のファイルは保持されます)',
  'Enter value...': '値を入力...',
  'Enter sensitive value...': '機密な値を入力...',
  'Press Enter to submit, Escape to cancel':
    'Enter で送信、Escape でキャンセル',
  'Markdown file already exists: {{filename}}':
    'Markdown ファイルはすでに存在します: {{filename}}',
  'TOML Command Format Deprecation Notice':
    'TOML コマンド形式廃止予定のお知らせ',
  'Found {{count}} command file(s) in TOML format:':
    'TOML 形式のコマンドファイルが {{count}} 件見つかりました:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'コマンドの TOML 形式は廃止予定で、Markdown 形式に移行します。',
  'Markdown format is more readable and easier to edit.':
    'Markdown 形式はより読みやすく、編集しやすくなります。',
  'You can migrate these files automatically using:':
    '次の方法でこれらのファイルを自動移行できます:',
  'Or manually convert each file:': 'または各ファイルを手動で変換できます:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: YAML フロントマター + 本文',
  'The migration tool will:': '移行ツールは次を行います:',
  'Convert TOML files to Markdown': 'TOML ファイルを Markdown に変換',
  'Create backups of original files': '元のファイルのバックアップを作成',
  'Preserve all command functionality': 'すべてのコマンド機能を保持',
  'TOML format will continue to work for now, but migration is recommended.':
    'TOML 形式は当面引き続き使用できますが、移行を推奨します。',
  'Unknown extensions source: {{source}}.':
    '不明な拡張機能ソースです: {{source}}。',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'ブラウザで拡張機能ページを開く予定でした: {{url}} (テスト環境のためスキップ)',
  'View available extensions at {{url}}': '{{url}} で利用可能な拡張機能を表示',
  'Opening extensions page in your browser: {{url}}':
    'ブラウザで拡張機能ページを開いています: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'ブラウザを開けませんでした。拡張機能ギャラリーを {{url}} で確認してください',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    '{{seconds}} 秒後に再試行します… ({{attempt}}/{{maxRetries}} 回目)',
  'Press Ctrl+Y to retry': 'Ctrl+Y で再試行',
  'No failed request to retry.': '再試行できる失敗したリクエストはありません。',
  'to retry last request': '最後のリクエストを再試行',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    '無効な API Key です。Coding Plan の API Key は "sk-sp-" で始まります。確認してください。',
  'Lock release warning': 'ロック解除の警告',
  'Metadata write warning': 'メタデータ書き込みの警告',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    '次回のセッション期限切れクリーンアップでファイルが削除されるまで、以降の dream はロック中としてスキップされる可能性があります。',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    'スケジューラーゲートがこの dream のタイムスタンプを認識しませんでした。次の dream サイクルは通常より早く再実行される可能性があります。',
  // === Same-as-English optimization ===
  ' (not in model registry)': '（モデルレジストリにありません）',
  'Attribution: commit': 'コミットの帰属表示',
  '中国 (China)': '中国',
  '中国 (China) - 阿里云百炼': '中国 - 阿里云百炼',
};
