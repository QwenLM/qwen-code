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
    'MCPサーバーに接続中... ({{connected}}/{{total}})',
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
  'About Qwen Code': 'Qwen Code について',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'CLI Version': 'CLIバージョン',
  'Git Commit': 'Gitコミット',
  Model: 'モデル',
  Sandbox: 'サンドボックス',
  'OS Platform': 'OSプラットフォーム',
  'OS Arch': 'OSアーキテクチャ',
  'OS Release': 'OSリリース',
  'Node.js Version': 'Node.js バージョン',
  'NPM Version': 'NPM バージョン',
  'Session ID': 'セッションID',
  'Auth Method': '認証方式',
  'Base URL': 'ベースURL',
  'Memory Usage': 'メモリ使用量',
  'IDE Client': 'IDEクライアント',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'プロジェクトを分析し、カスタマイズされた QWEN.md ファイルを作成',
  'list available Qwen Code tools. Usage: /tools [desc]':
    '利用可能な Qwen Code ツールを一覧表示。使い方: /tools [desc]',
  'Available Qwen Code CLI tools:': '利用可能な Qwen Code CLI ツール:',
  'No tools available': '利用可能なツールはありません',
  'View or change the approval mode for tool usage':
    'ツール使用の承認モードを表示または変更',
  'View or change the language setting': '言語設定を表示または変更',
  'change the theme': 'テーマを変更',
  'Select Theme': 'テーマを選択',
  Preview: 'プレビュー',
  '(Use Enter to select, Tab to configure scope)':
    '(Enter で選択、Tab でスコープを設定)',
  '(Use Enter to apply scope, Tab to select theme)':
    '(Enter でスコープを適用、Tab でテーマを選択)',
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
  'change the auth method': '認証方式を変更',
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
    'MCPツールを含むすべてのツールを選択',
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
  '(Use Enter to select{{tabText}})': '(Enter で選択{{tabText}})',
  ', Tab to change focus': '、Tab でフォーカス変更',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    '変更を確認するには Qwen Code を再起動する必要があります。 r を押して終了し、変更を適用してください',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'コマンド "/{{command}}" は非対話モードではサポートされていません',
  'View and edit Qwen Code settings': 'Qwen Code の設定を表示・編集',
  Settings: '設定',
  'Vim Mode': 'Vim モード',
  'Disable Auto Update': '自動更新を無効化',
  Language: '言語',
  'Output Format': '出力形式',
  'Hide Tips': 'ヒントを非表示',
  'Hide Banner': 'バナーを非表示',
  'Show Memory Usage': 'メモリ使用量を表示',
  'Show Line Numbers': '行番号を表示',
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
  'Enable Prompt Completion': 'プロンプト補完を有効化',
  'Debug Keystroke Logging': 'キーストロークのデバッグログ',
  'Hide Window Title': 'ウィンドウタイトルを非表示',
  'Show Status in Title': 'タイトルにステータスを表示',
  'Hide Context Summary': 'コンテキスト要約を非表示',
  'Hide CWD': '作業ディレクトリを非表示',
  'Hide Sandbox Status': 'サンドボックス状態を非表示',
  'Hide Model Info': 'モデル情報を非表示',
  'Hide Footer': 'フッターを非表示',
  'Show Citations': '引用を表示',
  'Custom Witty Phrases': 'カスタムウィットフレーズ',
  'Enable Welcome Back': 'ウェルカムバック機能を有効化',
  'Disable Loading Phrases': 'ローディングフレーズを無効化',
  'Screen Reader Mode': 'スクリーンリーダーモード',
  'IDE Mode': 'IDEモード',
  'Max Session Turns': '最大セッションターン数',
  'Skip Next Speaker Check': '次の発言者チェックをスキップ',
  'Skip Loop Detection': 'ループ検出をスキップ',
  'Skip Startup Context': '起動時コンテキストをスキップ',
  'Enable OpenAI Logging': 'OpenAI ログを有効化',
  'OpenAI Logging Directory': 'OpenAI ログディレクトリ',
  'Disable Cache Control': 'キャッシュ制御を無効化',
  'Memory Discovery Max Dirs': 'メモリ検出の最大ディレクトリ数',
  'Load Memory From Include Directories':
    'インクルードディレクトリからメモリを読み込み',
  'Respect .gitignore': '.gitignore を優先',
  'Respect .qwenignore': '.qwenignore を優先',
  'Enable Recursive File Search': '再帰的ファイル検索を有効化',
  'Disable Fuzzy Search': 'ファジー検索を無効化',
  'Enable Interactive Shell': '対話型シェルを有効化',
  'Show Color': '色を表示',
  'Use Ripgrep': 'Ripgrep を使用',
  'Use Builtin Ripgrep': '組み込み Ripgrep を使用',
  'Enable Tool Output Truncation': 'ツール出力の切り詰めを有効化',
  'Tool Output Truncation Threshold': 'ツール出力切り詰めのしきい値',
  'Tool Output Truncation Lines': 'ツール出力の切り詰め行数',
  'Vision Model Preview': 'ビジョンモデルプレビュー',
  'Tool Schema Compliance': 'ツールスキーマ準拠',
  'Auto (detect from system)': '自動(システムから検出)',
  'check session stats. Usage: /stats [model|tools]':
    'セッション統計を確認。使い方: /stats [model|tools]',
  'Show model-specific usage statistics.': 'モデル別の使用統計を表示',
  'Show tool-specific usage statistics.': 'ツール別の使用統計を表示',
  'list configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    '設定済みのMCPサーバーとツールを一覧表示、またはOAuth対応サーバーで認証',
  'Manage workspace directories': 'ワークスペースディレクトリを管理',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'ワークスペースにディレクトリを追加。複数パスはカンマで区切ってください',
  'Show all directories in the workspace':
    'ワークスペース内のすべてのディレクトリを表示',
  'set external editor preference': '外部エディタの設定',
  'Manage extensions': '拡張機能を管理',
  'List active extensions': '有効な拡張機能を一覧表示',
  'Update extensions. Usage: update <extension-names>|--all':
    '拡張機能を更新。使い方: update <拡張機能名>|--all',
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
  'LLM output language not set': 'LLM出力言語が設定されていません',
  'Set UI language': 'UI言語を設定',
  'Set LLM output language': 'LLM出力言語を設定',
  'Usage: /language ui [{{options}}]': '使い方: /language ui [{{options}}]',
  'Usage: /language output <language>': '使い方: /language output <言語>',
  'Example: /language output 中文': '例: /language output 中文',
  'Example: /language output English': '例: /language output English',
  'Example: /language output 日本語': '例: /language output 日本語',
  'Example: /language output Português': '例: /language output Português',
  'UI language changed to {{lang}}': 'UI言語を {{lang}} に変更しました',
  'LLM output language rule file generated at {{path}}':
    'LLM出力言語ルールファイルを {{path}} に生成しました',
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
  // Approval Mode
  'Approval Mode': '承認モード',
  'Current approval mode: {{mode}}': '現在の承認モード: {{mode}}',
  'Available approval modes:': '利用可能な承認モード:',
  'Approval mode changed to: {{mode}}': '承認モードを変更しました: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    '承認モードを {{mode}} に変更しました({{scope}} 設定{{location}}に保存)',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    '使い方: /approval-mode <モード> [--session|--user|--project]',
  'Scope subcommands do not accept additional arguments.':
    'スコープサブコマンドは追加の引数を受け付けません',
  'Plan mode - Analyze only, do not modify files or execute commands':
    'プランモード - 分析のみ、ファイルの変更やコマンドの実行はしません',
  'Default mode - Require approval for file edits or shell commands':
    'デフォルトモード - ファイル編集やシェルコマンドには承認が必要',
  'Auto-edit mode - Automatically approve file edits':
    '自動編集モード - ファイル編集を自動承認',
  'YOLO mode - Automatically approve all tools':
    'YOLOモード - すべてのツールを自動承認',
  '{{mode}} mode': '{{mode}}モード',
  'Settings service is not available; unable to persist the approval mode.':
    '設定サービスが利用できません。承認モードを保存できません',
  'Failed to save approval mode: {{error}}':
    '承認モードの保存に失敗: {{error}}',
  'Failed to change approval mode: {{error}}':
    '承認モードの変更に失敗: {{error}}',
  'Apply to current session only (temporary)':
    '現在のセッションのみに適用(一時的)',
  'Persist for this project/workspace': 'このプロジェクト/ワークスペースに保存',
  'Persist for this user on this machine': 'このマシンのこのユーザーに保存',
  'Analyze only, do not modify files or execute commands':
    '分析のみ、ファイルの変更やコマンドの実行はしません',
  'Require approval for file edits or shell commands':
    'ファイル編集やシェルコマンドには承認が必要',
  'Automatically approve file edits': 'ファイル編集を自動承認',
  'Automatically approve all tools': 'すべてのツールを自動承認',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'ワークスペースの承認モードが存在し、優先されます。ユーザーレベルの変更は効果がありません',
  '(Use Enter to select, Tab to change focus)':
    '(Enter で選択、Tab でフォーカス変更)',
  'Apply To': '適用先',
  'User Settings': 'ユーザー設定',
  'Workspace Settings': 'ワークスペース設定',
  // Memory
  'Commands for interacting with memory.': 'メモリ操作のコマンド',
  'Show the current memory contents.': '現在のメモリ内容を表示',
  'Show project-level memory contents.': 'プロジェクトレベルのメモリ内容を表示',
  'Show global memory contents.': 'グローバルメモリ内容を表示',
  'Add content to project-level memory.':
    'プロジェクトレベルのメモリにコンテンツを追加',
  'Add content to global memory.': 'グローバルメモリにコンテンツを追加',
  'Refresh the memory from the source.': 'ソースからメモリを更新',
  'Usage: /memory add --project <text to remember>':
    '使い方: /memory add --project <記憶するテキスト>',
  'Usage: /memory add --global <text to remember>':
    '使い方: /memory add --global <記憶するテキスト>',
  'Attempting to save to project memory: "{{text}}"':
    'プロジェクトメモリへの保存を試行中: "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'グローバルメモリへの保存を試行中: "{{text}}"',
  'Current memory content from {{count}} file(s):':
    '{{count}} 個のファイルからの現在のメモリ内容:',
  'Memory is currently empty.': 'メモリは現在空です',
  'Project memory file not found or is currently empty.':
    'プロジェクトメモリファイルが見つからないか、現在空です',
  'Global memory file not found or is currently empty.':
    'グローバルメモリファイルが見つからないか、現在空です',
  'Global memory is currently empty.': 'グローバルメモリは現在空です',
  'Global memory content:\n\n---\n{{content}}\n---':
    'グローバルメモリ内容:\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    '{{path}} からのプロジェクトメモリ内容:\n\n---\n{{content}}\n---',
  'Project memory is currently empty.': 'プロジェクトメモリは現在空です',
  'Refreshing memory from source files...':
    'ソースファイルからメモリを更新中...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'メモリにコンテンツを追加。グローバルメモリには --global、プロジェクトメモリには --project を使用',
  'Usage: /memory add [--global|--project] <text to remember>':
    '使い方: /memory add [--global|--project] <記憶するテキスト>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'メモリ {{scope}} への保存を試行中: "{{fact}}"',
  // MCP
  'Authenticate with an OAuth-enabled MCP server':
    'OAuth対応のMCPサーバーで認証',
  'List configured MCP servers and tools':
    '設定済みのMCPサーバーとツールを一覧表示',
  'No MCP servers configured.': 'MCPサーバーが設定されていません',
  'Restarts MCP servers.': 'MCPサーバーを再起動します',
  'Config not loaded.': '設定が読み込まれていません',
  'Could not retrieve tool registry.': 'ツールレジストリを取得できませんでした',
  'No MCP servers configured with OAuth authentication.':
    'OAuth認証が設定されたMCPサーバーはありません',
  'MCP servers with OAuth authentication:': 'OAuth認証のMCPサーバー:',
  'Use /mcp auth <server-name> to authenticate.':
    '認証するには /mcp auth <サーバー名> を使用',
  "MCP server '{{name}}' not found.": "MCPサーバー '{{name}}' が見つかりません",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "'{{name}}' の認証とツール更新に成功しました",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "MCPサーバー '{{name}}' での認証に失敗: {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "'{{name}}' からツールを再検出中...",
  'Configured MCP servers:': '設定済みMCPサーバー:',
  Ready: '準備完了',
  Disconnected: '切断',
  '{{count}} tool': '{{count}} ツール',
  '{{count}} tools': '{{count}} ツール',
  'Restarting MCP servers...': 'MCPサーバーを再起動中...',
  // Chat
  'Manage conversation history.': '会話履歴を管理します',
  'List saved conversation checkpoints':
    '保存された会話チェックポイントを一覧表示',
  'No saved conversation checkpoints found.':
    '保存された会話チェックポイントが見つかりません',
  'List of saved conversations:': '保存された会話の一覧:',
  'Note: Newest last, oldest first':
    '注: 最新のものが下にあり、過去のものが上にあります',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    '現在の会話をチェックポイントとして保存。使い方: /chat save <タグ>',
  'Missing tag. Usage: /chat save <tag>':
    'タグが不足しています。使い方: /chat save <タグ>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    '会話チェックポイントを削除。使い方: /chat delete <タグ>',
  'Missing tag. Usage: /chat delete <tag>':
    'タグが不足しています。使い方: /chat delete <タグ>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "会話チェックポイント '{{tag}}' を削除しました",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "エラー: タグ '{{tag}}' のチェックポイントが見つかりません",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    'チェックポイントから会話を再開。使い方: /chat resume <タグ>',
  'Missing tag. Usage: /chat resume <tag>':
    'タグが不足しています。使い方: /chat resume <タグ>',
  'No saved checkpoint found with tag: {{tag}}.':
    'タグ {{tag}} のチェックポイントが見つかりません',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    'タグ {{tag}} のチェックポイントは既に存在します。上書きしますか?',
  'No chat client available to save conversation.':
    '会話を保存するためのチャットクライアントがありません',
  'Conversation checkpoint saved with tag: {{tag}}.':
    'タグ {{tag}} で会話チェックポイントを保存しました',
  'No conversation found to save.': '保存する会話が見つかりません',
  'No chat client available to share conversation.':
    '会話を共有するためのチャットクライアントがありません',
  'Invalid file format. Only .md and .json are supported.':
    '無効なファイル形式です。.md と .json のみサポートされています',
  'Error sharing conversation: {{error}}': '会話の共有中にエラー: {{error}}',
  'Conversation shared to {{filePath}}': '会話を {{filePath}} に共有しました',
  'No conversation found to share.': '共有する会話が見つかりません',
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    '現在の会話をmarkdownまたはjsonファイルに共有。使い方: /chat share <ファイル>',
  // Summary
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
  'Failed to generate summary - no text content received from LLM response':
    'サマリーの生成に失敗 - LLMレスポンスからテキストコンテンツを受信できませんでした',
  // Model
  'Switch the model for this session': 'このセッションのモデルを切り替え',
  'Content generator configuration not available.':
    'コンテンツジェネレーター設定が利用できません',
  'Authentication type not available.': '認証タイプが利用できません',
  'No models available for the current authentication type ({{authType}}).':
    '現在の認証タイプ({{authType}})で利用可能なモデルはありません',
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
  'Chat history is already compressed.': 'チャット履歴は既に圧縮されています',
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
  No: 'いいえ',
  'No (esc)': 'いいえ (Esc)',
  'Yes, allow always for this session': 'はい、このセッションで常に許可',
  'Modify in progress:': '変更中:',
  'Save and close external editor to continue':
    '続行するには外部エディタを保存して閉じてください',
  'Apply this change?': 'この変更を適用しますか?',
  'Yes, allow always': 'はい、常に許可',
  'Modify with external editor': '外部エディタで編集',
  'No, suggest changes (esc)': 'いいえ、変更を提案 (Esc)',
  "Allow execution of: '{{command}}'?": "'{{command}}' の実行を許可しますか?",
  'Yes, allow always ...': 'はい、常に許可...',
  'Yes, and auto-accept edits': 'はい、編集を自動承認',
  'Yes, and manually approve edits': 'はい、編集を手動承認',
  'No, keep planning (esc)': 'いいえ、計画を続ける (Esc)',
  'URLs to fetch:': '取得するURL:',
  'MCP Server: {{server}}': 'MCPサーバー: {{server}}',
  'Tool: {{tool}}': 'ツール: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'サーバー "{{server}}" からの MCPツール "{{tool}}" の実行を許可しますか?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'はい、サーバー "{{server}}" からのツール "{{tool}}" を常に許可',
  'Yes, always allow all tools from server "{{server}}"':
    'はい、サーバー "{{server}}" からのすべてのツールを常に許可',
  // Dialogs - Shell Confirmation
  'Shell Command Execution': 'シェルコマンド実行',
  'A custom command wants to run the following shell commands:':
    'カスタムコマンドが以下のシェルコマンドを実行しようとしています:',
  // Dialogs - Pro Quota
  'Pro quota limit reached for {{model}}.':
    '{{model}} のProクォータ上限に達しました',
  'Change auth (executes the /auth command)':
    '認証を変更(/auth コマンドを実行)',
  'Continue with {{model}}': '{{model}} で続行',
  // Dialogs - Welcome Back
  'Current Plan:': '現在のプラン:',
  'Progress: {{done}}/{{total}} tasks completed':
    '進捗: {{done}}/{{total}} タスク完了',
  ', {{inProgress}} in progress': '、{{inProgress}} 進行中',
  'Pending Tasks:': '保留中のタスク:',
  'What would you like to do?': '何をしますか?',
  'Choose how to proceed with your session:':
    'セッションの続行方法を選択してください:',
  'Start new chat session': '新しいチャットセッションを開始',
  'Continue previous conversation': '前回の会話を続行',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 おかえりなさい!(最終更新: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 全体目標:',
  // Dialogs - Auth
  'Get started': '始める',
  'How would you like to authenticate for this project?':
    'このプロジェクトの認証方法を選択してください:',
  'OpenAI API key is required to use OpenAI authentication.':
    'OpenAI認証を使用するには OpenAI APIキーが必要です',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    '続行するには認証方法を選択してください。Ctrl+C をもう一度押すと終了します',
  '(Use Enter to Set Auth)': '(Enter で認証を設定)',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Qwen Code の利用規約とプライバシー通知',
  'Qwen OAuth': 'Qwen OAuth',
  'Login with QwenChat account to use daily free quota.':
    'QwenChatアカウントでログインして、毎日の無料クォータをご利用ください。',
  'API-KEY': 'API-KEY',
  'Use coding plan credentials or your own api-keys/providers.':
    'Coding Planの認証情報またはご自身のAPIキー/プロバイダーをご利用ください。',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'ログインに失敗しました。メッセージ: {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    '認証は {{enforcedType}} に強制されていますが、現在 {{currentType}} を使用しています',
  'Qwen OAuth authentication timed out. Please try again.':
    'Qwen OAuth認証がタイムアウトしました。再度お試しください',
  'Qwen OAuth authentication cancelled.':
    'Qwen OAuth認証がキャンセルされました',
  'Qwen OAuth Authentication': 'Qwen OAuth認証',
  'Please visit this URL to authorize:':
    '認証するには以下のURLにアクセスしてください:',
  'Or scan the QR code below:': 'または以下のQRコードをスキャン:',
  'Waiting for authorization': '認証を待っています',
  'Time remaining:': '残り時間:',
  '(Press ESC or CTRL+C to cancel)': '(ESC または CTRL+C でキャンセル)',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth認証タイムアウト',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuthトークンが期限切れです({{seconds}}秒以上)。認証方法を再度選択してください',
  'Press any key to return to authentication type selection.':
    '認証タイプ選択に戻るには任意のキーを押してください',
  'Waiting for Qwen OAuth authentication...': 'Qwen OAuth認証を待っています...',
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    '注: Qwen OAuthを使用しても、settings.json内の既存のAPIキーはクリアされません。必要に応じて後でOpenAI認証に切り替えることができます',
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
  'OpenAI Configuration Required': 'OpenAI設定が必要です',
  'Please enter your OpenAI configuration. You can get an API key from':
    'OpenAI設定を入力してください。APIキーは以下から取得できます',
  'API Key:': 'APIキー:',
  'Invalid credentials: {{errorMessage}}': '無効な認証情報: {{errorMessage}}',
  'Failed to validate credentials': '認証情報の検証に失敗しました',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Enter で続行、Tab/↑↓ で移動、Esc でキャンセル',
  // Dialogs - Model
  'Select Model': 'モデルを選択',
  '(Press Esc to close)': '(Esc で閉じる)',
  'Qwen 3.5 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.5 Plus — 効率的なハイブリッドモデル、業界トップクラスのコーディング性能',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    'Alibaba Cloud ModelStudioの最新Qwen Visionモデル(バージョン: qwen3-vl-plus-2025-09-23)',
  // Dialogs - Permissions
  'Manage folder trust settings': 'フォルダ信頼設定を管理',
  // Status Bar
  'Using:': '使用中:',
  '{{count}} open file': '{{count}} 個のファイルを開いています',
  '{{count}} open files': '{{count}} 個のファイルを開いています',
  '(ctrl+g to view)': '(Ctrl+G で表示)',
  '{{count}} {{name}} file': '{{count}} {{name}} ファイル',
  '{{count}} {{name}} files': '{{count}} {{name}} ファイル',
  '{{count}} MCP server': '{{count}} MCPサーバー',
  '{{count}} MCP servers': '{{count}} MCPサーバー',
  '{{count}} Blocked': '{{count}} ブロック',
  '(ctrl+t to view)': '(Ctrl+T で表示)',
  '(ctrl+t to toggle)': '(Ctrl+T で切り替え)',
  'Press Ctrl+C again to exit.': 'Ctrl+C をもう一度押すと終了します',
  'Press Ctrl+D again to exit.': 'Ctrl+D をもう一度押すと終了します',
  'Press Esc again to clear.': 'Esc をもう一度押すとクリアします',
  // MCP Status
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCPサーバーを起動中({{count}} 初期化中)...',
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
  'to show tool parameter schemas': 'ツールパラメータスキーマを表示',
  'to hide descriptions': '説明を非表示',
  'to authenticate with OAuth-enabled servers': 'OAuth対応サーバーで認証',
  Press: '押す',
  'to toggle tool descriptions on/off': 'ツール説明の表示/非表示を切り替え',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "MCPサーバー '{{name}}' のOAuth認証を開始中...",
  // Startup Tips
  'Tips for getting started:': '始めるためのヒント:',
  '1. Ask questions, edit files, or run commands.':
    '1. 質問したり、ファイルを編集したり、コマンドを実行したりできます',
  '2. Be specific for the best results.':
    '2. 具体的に指示すると最良の結果が得られます',
  'files to customize your interactions with Qwen Code.':
    'Qwen Code との対話をカスタマイズするためのファイル',
  'for more information.': '詳細情報を確認できます',
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
  Tool: 'ツール',
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
  '(esc to cancel, {{time}})': '(Esc でキャンセル、{{time}})',
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
  // Custom API-KEY Configuration
  // ============================================================================
  'For advanced users who want to configure models manually.':
    'モデルを手動で設定したい上級ユーザー向け。',
  'Please configure your models in settings.json:':
    'settings.json でモデルを設定してください：',
  'Set API key via environment variable (e.g., OPENAI_API_KEY)':
    '環境変数を使用して API キーを設定してください（例：OPENAI_API_KEY）',
  "Add model configuration to modelProviders['openai'] (or other auth types)":
    "modelProviders['openai']（または他の認証タイプ）にモデル設定を追加してください",
  'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig':
    '各プロバイダーには：id、envKey（必須）、およびオプションの baseUrl、generationConfig が必要です',
  'Use /model command to select your preferred model from the configured list':
    '/model コマンドを使用して、設定済みリストからお好みのモデルを選択してください',
  'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.':
    'サポートされている認証タイプ：openai、anthropic、gemini、vertex-ai など',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'Please enter your API key:': 'APIキーを入力してください：',
  'API key cannot be empty.': 'APIキーは空にできません。',
  'You can get your exclusive Coding Plan API-KEY here:':
    'Coding Plan の API-KEY はこちらで取得できます：',
  'New model configurations are available for Bailian Coding Plan. Update now?':
    'Bailian Coding Plan の新しいモデル設定が利用可能です。今すぐ更新しますか？',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan の設定が正常に更新されました。新しいモデルが利用可能になりました。',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'Coding Plan の API キーが見つかりません。Coding Plan で再認証してください。',
  'Failed to update Coding Plan configuration: {{message}}':
    'Coding Plan の設定更新に失敗しました: {{message}}',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  'Coding Plan (Bailian, China)': 'Coding Plan (Bailian, 中国)',
  'Coding Plan (Bailian, Global/Intl)':
    'Coding Plan (Bailian, グローバル/国際)',
  "Paste your api key of Bailian Coding Plan and you're all set!":
    'Bailian Coding PlanのAPIキーを貼り付けるだけで準備完了です！',
  "Paste your api key of Coding Plan (Bailian, Global/Intl) and you're all set!":
    'Coding Plan (Bailian, グローバル/国際) のAPIキーを貼り付けるだけで準備完了です！',
  Custom: 'カスタム',
  'More instructions about configuring `modelProviders` manually.':
    '`modelProviders`を手動で設定する方法の詳細はこちら。',
  'Select API-KEY configuration mode:': 'API-KEY設定モードを選択してください：',
  '(Press Escape to go back)': '(Escapeキーで戻る)',
  '(Press Enter to submit, Escape to cancel)':
    '(Enterで送信、Escapeでキャンセル)',
  'More instructions please check:': '詳細な手順はこちらをご確認ください：',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    '{{region}} の新しいモデル設定が利用可能です。今すぐ更新しますか？',
  'New model configurations are available for Bailian Coding Plan (China). Update now?':
    'Bailian Coding Plan (中国) の新しいモデル設定が利用可能です。今すぐ更新しますか？',
  'New model configurations are available for Coding Plan (Bailian, Global/Intl). Update now?':
    'Coding Plan (Bailian, グローバル/国際) の新しいモデル設定が利用可能です。今すぐ更新しますか？',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}} の設定が正常に更新されました。モデルが "{{model}}" に切り替わりました。',
  'Authenticated successfully with {{region}}. API key is stored in settings.env.':
    '{{region}} での認証に成功しました。APIキーは settings.env に保存されています。',
};
