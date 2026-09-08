/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type LiveLanguage = 'en' | 'zh-CN';

// Edit all fixed Live display text here. Keep {placeholders} in both languages.
export const LIVE_MESSAGES = {
  'language.choose': {
    en: 'Language / 语言 (← 简体中文 · English →, Enter / 回车)',
    'zh-CN': 'Language / 语言 (← 简体中文 · English →, Enter / 回车)',
  },
  'language.english': { en: 'English', 'zh-CN': 'English' },
  'language.chinese': { en: '简体中文', 'zh-CN': '简体中文' },
  'language.label': { en: 'Language', 'zh-CN': '语言' },
  // THEME_MESSAGES
  'theme.label': { en: 'Theme', 'zh-CN': '主题' },
  'theme.system': { en: 'System', 'zh-CN': '跟随系统' },
  'theme.light': { en: 'Light mode', 'zh-CN': '白天模式' },
  'theme.dark': { en: 'Dark mode', 'zh-CN': '黑暗模式' },
  'host.theme.invalid': {
    en: 'Invalid theme setting.',
    'zh-CN': '无效的主题设置。',
  },
  'host.theme.unavailable': {
    en: 'Theme settings are unavailable while Qwen Live is quitting.',
    'zh-CN': 'Qwen Live 正在退出，暂时无法修改主题。',
  },
  'host.theme.saveFailed': {
    en: 'Could not save the theme preference.',
    'zh-CN': '无法保存主题偏好。',
  },
  'ui.appName': { en: 'Qwen Live', 'zh-CN': 'Qwen Live' },
  'ui.screen': { en: 'Screen', 'zh-CN': '屏幕' },
  'ui.camera': { en: 'Camera', 'zh-CN': '摄像头' },
  'ui.onDemand': { en: 'On Demand', 'zh-CN': '按需截图' },
  'ui.liveFeed': { en: 'Live Feed', 'zh-CN': '实时画面' },
  'ui.audioSource': { en: 'Audio Source', 'zh-CN': '音频来源' },
  'ui.videoSource': { en: 'Video Source', 'zh-CN': '视频来源' },
  'ui.captureMode': { en: 'Capture Mode', 'zh-CN': '获取模式' },
  'ui.settings': { en: 'Settings', 'zh-CN': '设置' },
  'ui.close': { en: 'Close', 'zh-CN': '关闭' },
  'ui.closeSettings': { en: 'Close settings', 'zh-CN': '关闭设置' },
  'ui.quit': { en: 'Quit Host', 'zh-CN': '退出 Qwen Live' },
  'ui.controls': { en: 'Qwen Live controls', 'zh-CN': 'Qwen Live 控制' },
  'ui.toolbar': { en: 'Live controls', 'zh-CN': '语音控制' },
  'ui.dragHint': {
    en: 'Drag to move · Hover for controls',
    'zh-CN': '拖动以移动 · 悬停显示控制',
  },
  'ui.muteInput': { en: 'Mute microphone', 'zh-CN': '麦克风静音' },
  'ui.unmuteInput': { en: 'Unmute microphone', 'zh-CN': '取消麦克风静音' },
  'ui.muteOutput': { en: 'Mute voice output', 'zh-CN': '播报静音' },
  'ui.unmuteOutput': { en: 'Unmute voice output', 'zh-CN': '取消播报静音' },
  'ui.micOff': { en: 'Mic off', 'zh-CN': '麦克风已关闭' },
  'ui.speakerMuted': { en: 'Speaker muted', 'zh-CN': '播报已静音' },
  'ui.micAndSpeakerMuted': {
    en: 'Mic off · Speaker muted',
    'zh-CN': '麦克风已关闭 · 播报已静音',
  },
  'ui.startCall': { en: 'Start call', 'zh-CN': '开始通话' },
  'ui.endCall': { en: 'End call', 'zh-CN': '结束通话' },
  'ui.shortcutAction': {
    en: '{action} ({shortcut})',
    'zh-CN': '{action}（{shortcut}）',
  },
  'ui.openPermission': {
    en: 'Open permission request',
    'zh-CN': '打开权限请求',
  },
  'ui.hidePreview': { en: 'Hide camera preview', 'zh-CN': '隐藏摄像头预览' },
  'ui.showPreview': { en: 'Show camera preview', 'zh-CN': '显示摄像头预览' },
  'ui.previewConnecting': {
    en: 'Connecting camera…',
    'zh-CN': '正在连接摄像头…',
  },
  'ui.cameraConnecting': {
    en: 'Camera · Connecting',
    'zh-CN': '摄像头 · 连接中',
  },
  'ui.cameraBadge': { en: 'Camera · {mode}', 'zh-CN': '摄像头 · {mode}' },
  'ui.localPreview': { en: 'Local preview', 'zh-CN': '本地预览' },
  'ui.setupHint': {
    en: 'Choose what Live can see. Only the selected source needs permission.',
    'zh-CN': '选择 Live 可见的内容，只需授权当前来源。',
  },
  'ui.microphone': { en: 'Microphone', 'zh-CN': '麦克风' },
  'ui.accessibility': { en: 'Accessibility', 'zh-CN': '辅助功能' },
  'ui.screenRecording': { en: 'Screen recording', 'zh-CN': '屏幕录制' },
  'ui.allow': { en: 'Allow', 'zh-CN': '授权' },
  'ui.allowMicrophone': { en: 'Allow microphone', 'zh-CN': '授权麦克风' },
  'ui.allowCamera': { en: 'Allow camera', 'zh-CN': '授权摄像头' },
  'ui.allowAccessibility': {
    en: 'Allow accessibility',
    'zh-CN': '授权辅助功能',
  },
  'ui.allowScreenRecording': {
    en: 'Allow screen recording',
    'zh-CN': '授权屏幕录制',
  },
  'ui.allowed': { en: 'Allowed', 'zh-CN': '已授权' },
  'ui.required': { en: 'Required', 'zh-CN': '需要授权' },
  'ui.connecting': {
    en: 'Connecting to Qwen Live…',
    'zh-CN': '正在连接 Qwen Live…',
  },
  'ui.waiting': { en: 'Waiting for Qwen Live…', 'zh-CN': '等待 Qwen Live…' },
  'ui.allowRequired': {
    en: 'Allow the required permissions to start Live.',
    'zh-CN': '请完成所需授权以开始使用 Live。',
  },
  'ui.quitting': { en: 'Quitting Qwen Live…', 'zh-CN': '正在退出 Qwen Live…' },
  'ui.quitFailed': {
    en: 'Could not shut down Qwen Live. Please retry Quit.',
    'zh-CN': '未能完成退出，请再次点击退出。',
  },
  'ui.ready': {
    en: 'Ready · Hover for controls',
    'zh-CN': '已就绪 · 悬停显示控制',
  },
  'ui.starting': { en: 'Starting…', 'zh-CN': '正在开始…' },
  'ui.listening': { en: 'Listening', 'zh-CN': '聆听中' },
  'ui.thinking': { en: 'Thinking…', 'zh-CN': '思考中…' },
  'ui.speaking': { en: 'Speaking', 'zh-CN': '播报中' },
  'ui.stopping': { en: 'Ending call…', 'zh-CN': '正在结束通话…' },
  'ui.callEnded': { en: 'Call ended', 'zh-CN': '通话已结束' },
  'ui.unavailable': { en: 'Unavailable', 'zh-CN': '暂不可用' },
  'ui.refresh': { en: 'Refresh', 'zh-CN': '刷新' },
  'ui.refreshAudio': { en: 'Refresh audio sources', 'zh-CN': '刷新音频来源' },
  'ui.systemDefault': { en: 'System default', 'zh-CN': '系统默认' },
  'ui.modeFeedHint': {
    en: 'Live Feed sends frames from the selected video source continuously during a call, at your configured FPS and resolution.',
    'zh-CN':
      '实时画面会在通话期间，以配置的帧率和分辨率持续发送所选视频来源的画面。',
  },
  'ui.modeDemandHint': {
    en: 'On Demand lets the foreground model request an Appshot snapshot from the selected video source when visual context is needed.',
    'zh-CN':
      '按需截图会在前台模型需要视觉信息时，通过 Appshot 获取所选视频来源的截图。',
  },
  'ui.modeUnavailable': {
    en: 'Video capture settings are unavailable for this connection.',
    'zh-CN': '当前连接不支持视频获取设置。',
  },
  'ui.applying': { en: 'Applying…', 'zh-CN': '正在应用…' },
  'ui.loadingDevices': {
    en: 'Loading input devices…',
    'zh-CN': '正在加载输入设备…',
  },
  'ui.memory': { en: 'Memory', 'zh-CN': '记忆' },
  'ui.memoryEnable': { en: 'Enable memory', 'zh-CN': '启用记忆' },
  'ui.memoryVisual': { en: 'Visual memory', 'zh-CN': '视觉记忆' },
  'ui.memoryVisualHint': {
    en: 'Visual memory records observations from the selected Screen or Camera.',
    'zh-CN': '视觉记忆会记录从所选屏幕或摄像头画面中观察到的内容。',
  },
  'ui.memoryLibrary': { en: 'Memory library', 'zh-CN': '记忆库' },
  'ui.memoryNew': { en: 'New', 'zh-CN': '新建' },
  'ui.memoryRename': { en: 'Rename', 'zh-CN': '重命名' },
  'ui.save': { en: 'Save', 'zh-CN': '保存' },
  'ui.cancel': { en: 'Cancel', 'zh-CN': '取消' },
  'ui.saveModel': { en: 'Save model', 'zh-CN': '保存模型' },
  'ui.memoryModel': { en: 'Consolidation model', 'zh-CN': '记忆整理模型' },
  'ui.newLibraryName': { en: 'New library name', 'zh-CN': '新记忆库名称' },
  'ui.renameLibrary': { en: 'Rename library', 'zh-CN': '重命名记忆库' },
  'ui.memoryLockedHint': {
    en: 'End the current call to select or create a library, or change the model. You can rename a library now.',
    'zh-CN':
      '请先结束当前通话，再选择或新建记忆库、修改模型；通话中仍可重命名。',
  },
  'ui.memorySavedHint': {
    en: 'Library selection and settings are saved for your next call.',
    'zh-CN': '记忆库选择和设置会保存，并在后续通话中使用。',
  },
  'ui.memoryConnectHint': {
    en: 'Connect to Qwen Live to change memory settings.',
    'zh-CN': '请先连接 Qwen Live，再修改记忆设置。',
  },
  'ui.saving': { en: 'Saving…', 'zh-CN': '正在保存…' },
  // HOST_UI_MESSAGES
  'init.title': { en: 'qwen-live setup', 'zh-CN': 'qwen-live 初始化' },
  'init.overwrite': {
    en: 'A config.json already exists. Overwrite?',
    'zh-CN': 'config.json 已存在，要覆盖吗？',
  },
  'init.keep': {
    en: 'Keeping existing config. Run `qwen-live` to start.',
    'zh-CN': '已保留现有配置。运行 `qwen-live` 启动。',
  },
  'init.scanning': {
    en: 'Scanning for installed coding agents...',
    'zh-CN': '正在查找已安装的编程代理…',
  },
  'init.noAgents': {
    en: 'No supported coding agents found on your PATH.',
    'zh-CN': '在 PATH 中没有找到支持的编程代理。',
  },
  'init.installAgent': {
    en: 'Install at least one of: qodercli, qwen, gemini, claude, codex',
    'zh-CN': '请至少安装一个：qodercli、qwen、gemini、claude、codex',
  },
  'init.manualConfig': {
    en: 'You can create ~/.qwen-live/config.json manually instead.',
    'zh-CN': '也可以手动创建 ~/.qwen-live/config.json。',
  },
  'init.defaultAgent': {
    en: 'Which agent should be the default backend?',
    'zh-CN': '选择默认的编程代理：',
  },
  'init.cancelled': { en: 'Cancelled.', 'zh-CN': '已取消。' },
  'init.addAgent': {
    en: 'Add another backend? ({count} remaining)',
    'zh-CN': '要添加其他编程代理吗？（还有 {count} 个）',
  },
  'init.whichAgent': { en: 'Which agent?', 'zh-CN': '选择编程代理：' },
  'init.useEnv': {
    en: 'Use {name} from the environment?',
    'zh-CN': '使用环境变量 {name} 中的 API key 吗？',
  },
  'init.unsetEnv': {
    en: 'Note: unset {name} before starting qwen-live; environment variables override config.json.',
    'zh-CN':
      '提示：启动 qwen-live 前请取消设置 {name}；环境变量会覆盖 config.json。',
  },
  'init.apiKey': {
    en: 'DashScope realtime API key (sk-...):',
    'zh-CN': 'DashScope 实时 API key（sk-...）：',
  },
  'init.apiKeyRequired': {
    en: 'Please enter your API key',
    'zh-CN': '请输入 API key',
  },
  'init.cancelledKey': {
    en: 'Cancelled — API key is required.',
    'zh-CN': '已取消：API key 不能为空。',
  },
  'init.apiName': {
    en: 'DashScope Realtime API name:',
    'zh-CN': 'DashScope Realtime API 模型名：',
  },
  'init.apiNameRequired': {
    en: 'Please enter an API name',
    'zh-CN': '请输入 API 模型名',
  },
  'init.memoryEnabled': {
    en: 'Enable Memory for cross-call recall?',
    'zh-CN': '启用 Memory 以便在通话之间保留记忆吗？',
  },
  'init.memoryModel': {
    en: 'DashScope Memory consolidation model:',
    'zh-CN': 'DashScope 记忆整理模型：',
  },
  'init.modelRequired': {
    en: 'Please enter a valid model name',
    'zh-CN': '请输入有效的模型名',
  },
  'init.cwd': {
    en: 'Default working directory for coding sessions:',
    'zh-CN': '编程会话的默认工作目录：',
  },
  'init.hostChecking': {
    en: 'Checking Live Host app...',
    'zh-CN': '正在检查 Live Host 应用…',
  },
  'init.hostInstalled': {
    en: 'Live Host {version} is installed.',
    'zh-CN': '已安装 Live Host {version}。',
  },
  'init.hostInstall': {
    en: 'Live Host is not installed. Install now?',
    'zh-CN': '尚未安装 Live Host，现在安装吗？',
  },
  'init.hostInstalling': {
    en: 'Installing Live Host (this may take a minute)...',
    'zh-CN': '正在安装 Live Host（可能需要一分钟）…',
  },
  'init.hostInstallFailed': {
    en: 'Installation failed: {detail}',
    'zh-CN': '安装失败：{detail}',
  },
  'init.hostCheckFailed': {
    en: 'Host check failed: {detail}',
    'zh-CN': 'Host 检查失败：{detail}',
  },
  'init.hostMacOnly': {
    en: 'Live Host app is macOS-only. Voice features require a Mac.',
    'zh-CN': 'Live Host 仅支持 macOS；语音功能需要 Mac。',
  },
  'init.unknownError': { en: 'unknown error', 'zh-CN': '未知错误' },
  'init.saved': {
    en: 'Config written to {path}',
    'zh-CN': '配置已写入 {path}',
  },
  'init.backendSummary': {
    en: 'Default backend: {name}',
    'zh-CN': '默认编程代理：{name}',
  },
  'init.apiSummary': {
    en: 'Realtime API: {name}',
    'zh-CN': 'Realtime API：{name}',
  },
  'init.memorySummary': { en: 'Memory: {name}', 'zh-CN': '记忆：{name}' },
  'init.hostSummary': { en: 'Host: {status}', 'zh-CN': 'Host：{status}' },
  'init.run': {
    en: 'Run `qwen-live` to start the daemon.',
    'zh-CN': '运行 `qwen-live` 启动服务。',
  },
  'init.disabled': { en: 'disabled', 'zh-CN': '已关闭' },
  'init.hostSkipped': { en: 'skipped', 'zh-CN': '已跳过' },
  'init.hostReady': { en: 'installed', 'zh-CN': '已安装' },
  'init.hostFailed': { en: 'failed', 'zh-CN': '安装失败' },
  'init.hostError': { en: 'error', 'zh-CN': '检查失败' },
  'init.hostUnsupported': { en: 'unsupported', 'zh-CN': '不支持' },
  'init.yes': { en: 'yes', 'zh-CN': '是' },
  'init.no': { en: 'no', 'zh-CN': '否' },
  'init.yesOption': { en: '(Y/n)', 'zh-CN': '（Y 是 / n 否）' },
  'init.noOption': { en: '(y/N)', 'zh-CN': '（y 是 / N 否）' },
  'init.selectHint': {
    en: '- Use arrow-keys. Return to submit.',
    'zh-CN': '- 使用方向键选择，回车确认。',
  },
  'init.selectDisabled': {
    en: '- This option is disabled',
    'zh-CN': '- 此选项不可用',
  },
  // INIT_MESSAGES
  'cli.usage': {
    en: 'Usage: qwen-live [init] [--debug]\n\nOptions:\n  --debug, -d  Print privacy-safe runtime diagnostics to stderr\n  --help, -h   Show this help',
    'zh-CN':
      '用法：qwen-live [init] [--debug]\n\n选项：\n  --debug, -d  向 stderr 输出不含敏感内容的运行诊断日志\n  --help, -h   显示帮助',
  },
  'cli.unknownArgument': {
    en: 'Unknown qwen-live argument: {argument}',
    'zh-CN': '未知的 qwen-live 参数：{argument}',
  },
  'language.invalid': {
    en: 'Language must be en or zh-CN.',
    'zh-CN': '语言必须是 en 或 zh-CN。',
  },
  'language.configInvalid': {
    en: 'Live configuration must be an object.',
    'zh-CN': 'Live 配置必须是对象。',
  },
  'language.saveFailed': {
    en: 'Could not save the language preference.',
    'zh-CN': '无法保存语言设置。',
  },
  'language.unavailable': {
    en: 'Language settings are unavailable in this daemon.',
    'zh-CN': '当前服务不支持语言设置。',
  },
  'language.callChanged': {
    en: 'The Live call changed. Retry the language setting.',
    'zh-CN': 'Live 通话已变化，请重试语言设置。',
  },
  'runtime.hostMissing': {
    en: 'Qwen Live Host is not connected.',
    'zh-CN': '尚未连接 Qwen Live Host。',
  },
  'runtime.hostDisconnected': {
    en: 'Qwen Live Host disconnected.',
    'zh-CN': 'Qwen Live Host 已断开。',
  },
  'runtime.hostVersion': {
    en: 'Qwen Live Host is not protocol-compatible.',
    'zh-CN': 'Qwen Live Host 的协议版本不兼容。',
  },
  'runtime.microphonePermission': {
    en: 'Microphone permission is required.',
    'zh-CN': '需要麦克风权限。',
  },
  'runtime.cameraPermission': {
    en: 'Camera permission is required.',
    'zh-CN': '需要摄像头权限。',
  },
  'runtime.accessibilityPermission': {
    en: 'Accessibility permission is required.',
    'zh-CN': '需要辅助功能权限。',
  },
  'runtime.screenPermission': {
    en: 'Screen Recording permission is required.',
    'zh-CN': '需要屏幕录制权限。',
  },
  'runtime.audioInput': {
    en: 'Live Host audio input self-check failed.',
    'zh-CN': 'Live Host 音频输入自检失败。',
  },
  'runtime.audioOutput': {
    en: 'Live Host audio output self-check failed.',
    'zh-CN': 'Live Host 音频输出自检失败。',
  },
  'runtime.shortcut': {
    en: 'Live Host global shortcut self-check failed.',
    'zh-CN': 'Live Host 全局快捷键自检失败。',
  },
  'runtime.appshot': {
    en: 'Appshot self-check failed.',
    'zh-CN': 'Appshot 截图自检失败。',
  },
  'runtime.appshotUnchecked': {
    en: 'The dedicated Appshot channel has not been verified.',
    'zh-CN': '尚未验证 Appshot 截图通道。',
  },
  'runtime.providerConfig': {
    en: 'Live provider configuration is invalid.',
    'zh-CN': 'Live 模型服务配置无效。',
  },
  'runtime.providerUnavailable': {
    en: 'The Live provider is unreachable.',
    'zh-CN': '无法连接 Live 模型服务。',
  },
  'runtime.apiKeyMissing': {
    en: 'DashScope realtime API key is not configured.',
    'zh-CN': '尚未配置 DashScope 实时 API key。',
  },
  'runtime.startFailed': {
    en: 'Live Voice failed to start.',
    'zh-CN': 'Live 语音启动失败。',
  },
  'runtime.callFailed': {
    en: 'Live Voice failed.',
    'zh-CN': 'Live 语音运行失败。',
  },
  'runtime.audioDropped': {
    en: 'Live Voice audio transport dropped input.',
    'zh-CN': 'Live 语音传输丢失了输入音频。',
  },
  'runtime.audioInputFailed': {
    en: 'Live Voice audio input failed.',
    'zh-CN': 'Live 语音输入失败。',
  },
  'runtime.stopFailed': {
    en: 'Live Voice failed to stop safely.',
    'zh-CN': 'Live 语音未能安全停止。',
  },
  'runtime.finalInputCommit': {
    en: 'Live Voice could not commit the final spoken input.',
    'zh-CN': 'Live 语音无法提交最后一段语音输入。',
  },
  'runtime.finalInputTimeout': {
    en: 'Live Voice could not confirm the final spoken input before the stop deadline.',
    'zh-CN': 'Live 语音停止前未能及时确认最后一段输入。',
  },
  'runtime.realtimeConnect': {
    en: 'Live Voice could not connect.',
    'zh-CN': '无法连接 Live 语音。',
  },
  'runtime.realtimeFailed': {
    en: 'Live Voice failed.{detail}',
    'zh-CN': 'Live 语音运行失败。{detail}',
  },
  'runtime.realtimeDisconnected': {
    en: 'Live Voice disconnected.{detail}',
    'zh-CN': 'Live 语音已断开。{detail}',
  },
  'runtime.realtimeConnectDetail': {
    en: 'Live Voice could not connect.{detail}',
    'zh-CN': '无法连接 Live 语音。{detail}',
  },
  'runtime.realtimeAuth': {
    en: 'Realtime authentication failed: {detail} Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live.',
    'zh-CN':
      'Realtime 身份验证失败：{detail} 请更换或取消设置 DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY（环境变量会覆盖 config.json），然后重启 qwen-live。',
  },
  'runtime.realtimeConfig': {
    en: 'Realtime configuration failed: {detail} Run qwen-live init, then restart qwen-live.',
    'zh-CN':
      'Realtime 配置失败：{detail} 请运行 qwen-live init，然后重启 qwen-live。',
  },
  'runtime.invalidKey': { en: 'invalid API key.', 'zh-CN': 'API key 无效。' },
  'runtime.invalidSettings': { en: 'invalid settings.', 'zh-CN': '设置无效。' },
  'runtime.toolResultFailed': {
    en: 'Live Voice could not return a tool result.',
    'zh-CN': 'Live 语音无法返回工具结果。',
  },
  'memoryUI.closed': {
    en: 'Memory service is closed.',
    'zh-CN': 'Memory 服务已关闭。',
  },
  'memoryUI.locked': {
    en: 'End the current call before changing the memory library or model.',
    'zh-CN': '请先结束当前通话，再切换记忆库或模型。',
  },
  'memoryUI.unsupported': {
    en: 'Unsupported Memory action.',
    'zh-CN': '不支持此 Memory 操作。',
  },
  'memoryUI.callChanged': {
    en: 'The Live call changed. Retry the Memory action.',
    'zh-CN': 'Live 通话已变化，请重试 Memory 操作。',
  },
  'memoryUI.unavailable': {
    en: 'Memory is unavailable in this daemon.',
    'zh-CN': '当前服务不支持 Memory。',
  },
  'memoryUI.stateUnavailable': {
    en: 'Memory state is unavailable.',
    'zh-CN': '无法获取 Memory 状态。',
  },
  'memoryUI.pending': {
    en: 'Too many pending Memory requests.',
    'zh-CN': '等待中的 Memory 请求过多。',
  },
  'memoryUI.updateFailed': {
    en: 'Could not update Memory settings.',
    'zh-CN': '无法更新 Memory 设置。',
  },
  'memoryUI.fallback': {
    en: 'Selected memory is unavailable; using Default Memory.',
    'zh-CN': '所选记忆库不可用，已使用默认记忆库。',
  },
  'memoryUI.budget': {
    en: 'Stored memory exceeds the available prompt budget. Reduce its size or configured limits.',
    'zh-CN': '已存记忆超出提示词容量，请缩减记忆或配置的上限。',
  },
  'memoryUI.storage': {
    en: 'Memory storage is unavailable. Check its directory and permissions.',
    'zh-CN': '记忆存储不可用，请检查目录和访问权限。',
  },
  'memoryUI.id': {
    en: 'Memory library id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
    'zh-CN': '记忆库 ID 必须符合 [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
  },
  'memoryUI.nameText': {
    en: 'Memory name must be text',
    'zh-CN': '记忆库名称必须是文本',
  },
  'memoryUI.name': {
    en: 'Memory name must contain 1–80 characters without control characters',
    'zh-CN': '记忆库名称应为 1–80 个字符，不能包含控制字符',
  },
  'memoryUI.file': {
    en: 'Memory data must be a regular file',
    'zh-CN': '记忆数据必须是普通文件',
  },
  'memoryUI.storeClosed': {
    en: 'Memory store is closed',
    'zh-CN': '记忆存储已关闭',
  },
  'memoryUI.missing': {
    en: 'Memory library does not exist',
    'zh-CN': '记忆库不存在',
  },
  'memoryUI.directory': {
    en: 'Memory library must be a regular directory',
    'zh-CN': '记忆库必须是普通目录',
  },
  'memoryUI.metaMissing': {
    en: 'Memory library metadata does not exist',
    'zh-CN': '记忆库元数据不存在',
  },
  'memoryUI.metaUnreadable': {
    en: 'Memory library metadata is unreadable',
    'zh-CN': '无法读取记忆库元数据',
  },
  'memoryUI.metaInvalid': {
    en: 'Memory library metadata is invalid',
    'zh-CN': '记忆库元数据无效',
  },
  'memoryUI.exists': {
    en: 'Memory library already exists',
    'zh-CN': '记忆库已存在',
  },
  'memoryUI.schema': {
    en: 'Unsupported memory schema version',
    'zh-CN': '不支持此记忆数据版本',
  },
  'runtime.realtimeAuthEmpty': {
    en: 'Realtime authentication failed: invalid API key. Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live.',
    'zh-CN':
      'Realtime 身份验证失败：API key 无效。请更换或取消设置 DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY（环境变量会覆盖 config.json），然后重启 qwen-live。',
  },
  'runtime.realtimeConfigEmpty': {
    en: 'Realtime configuration failed: invalid settings. Run qwen-live init, then restart qwen-live.',
    'zh-CN':
      'Realtime 配置失败：设置无效。请运行 qwen-live init，然后重启 qwen-live。',
  },
  'installer.architecture': {
    en: 'Qwen Live Host is unavailable for architecture {architecture}.',
    'zh-CN': 'Qwen Live Host 不支持 {architecture} 架构。',
  },
  'installer.assetInvalid': {
    en: 'Live Host manifest asset is invalid.',
    'zh-CN': 'Live Host 清单中的资源无效。',
  },
  'installer.manifestInvalid': {
    en: 'Live Host manifest is invalid.',
    'zh-CN': 'Live Host 安装清单无效。',
  },
  'installer.manifestIncompatible': {
    en: 'Live Host manifest is incompatible.',
    'zh-CN': 'Live Host 安装清单不兼容。',
  },
  'installer.bundleInvalid': {
    en: 'Qwen Live Host installation is not a regular app bundle.',
    'zh-CN': 'Qwen Live Host 安装目录不是正常应用包。',
  },
  'installer.identityInvalid': {
    en: 'Qwen Live Host bundle identity is invalid.',
    'zh-CN': 'Qwen Live Host 应用标识无效。',
  },
  'installer.versionInvalid': {
    en: 'Qwen Live Host version is invalid.',
    'zh-CN': 'Qwen Live Host 版本无效。',
  },
  'installer.signatureInvalid': {
    en: 'Qwen Live Host signing identity is invalid.',
    'zh-CN': 'Qwen Live Host 签名身份无效。',
  },
  'installer.manifestDownload': {
    en: 'Live Host manifest download failed ({status}).',
    'zh-CN': 'Live Host 清单下载失败（{status}）。',
  },
  'installer.downloadStatus': {
    en: 'Live Host download failed ({status}).',
    'zh-CN': 'Live Host 下载失败（{status}）。',
  },
  'installer.sizeMismatch': {
    en: 'Live Host download size does not match its manifest.',
    'zh-CN': 'Live Host 下载大小与清单不一致。',
  },
  'installer.sizeExceeded': {
    en: 'Live Host download exceeded its manifest size.',
    'zh-CN': 'Live Host 下载内容超出清单标注大小。',
  },
  'installer.checksum': {
    en: 'Live Host checksum verification failed.',
    'zh-CN': 'Live Host 文件校验失败。',
  },
  'installer.downloadFailed': {
    en: 'Qwen Live Host download failed. {details}',
    'zh-CN': 'Qwen Live Host 下载失败。{details}',
  },
  'installer.packageVersion': {
    en: 'Live Host package version does not match its manifest.',
    'zh-CN': 'Live Host 安装包版本与清单不一致。',
  },
  'installer.installedVersion': {
    en: 'Installed Live Host version is invalid.',
    'zh-CN': '已安装的 Live Host 版本无效。',
  },
  'installer.setupFailed': {
    en: 'Qwen Live Host setup failed.',
    'zh-CN': 'Qwen Live Host 安装失败。',
  },
  'installer.macOnly': {
    en: 'Qwen Live Host is available only on macOS.',
    'zh-CN': 'Qwen Live Host 仅支持 macOS。',
  },
  'installer.notInstalled': {
    en: 'Qwen Live Host is not installed.',
    'zh-CN': '尚未安装 Qwen Live Host。',
  },
  'installer.sourcesFailed': {
    en: 'Qwen Live Host download failed. OSS: {oss}; GitHub: {github}',
    'zh-CN': 'Qwen Live Host 下载失败。OSS：{oss}；GitHub：{github}',
  },
  'installer.protocol': {
    en: 'Qwen Live Host protocol v{installed} is incompatible; v{required} is required.',
    'zh-CN': 'Qwen Live Host 协议 v{installed} 不兼容，需要 v{required}。',
  },
  // RUNTIME_MESSAGES
  // HOST_ERROR_MESSAGES
  'host.error.visualFailed': {
    en: 'Visual capture failed.',
    'zh-CN': '画面采集失败。',
  },
  'code.camera_transport_rejected': {
    en: 'The camera frame could not reach Live.',
    'zh-CN': '摄像头画面未能送达 Live。',
  },
  'code.screen_transport_rejected': {
    en: 'The screen frame could not reach Live.',
    'zh-CN': '屏幕画面未能送达 Live。',
  },
  'code.screen_failed': {
    en: 'Screen capture failed. Check permissions and try again.',
    'zh-CN': '屏幕采集失败，请检查权限后重试。',
  },
  'code.camera_snapshot_failed': {
    en: 'Camera snapshot failed. Please try again.',
    'zh-CN': '摄像头截图失败，请重试。',
  },
  'code.camera_preview_restore_failed': {
    en: 'Could not restore the camera preview after capture.',
    'zh-CN': '截图后无法恢复摄像头预览。',
  },
  'code.audio_unavailable': {
    en: 'Audio is unavailable. Check your devices and permissions.',
    'zh-CN': '音频不可用，请检查设备及权限。',
  },
  'code.camera_unavailable': {
    en: 'Camera is unavailable. Check your device and permissions.',
    'zh-CN': '摄像头不可用，请检查设备及权限。',
  },
  'code.NotAllowedError': {
    en: 'Device access was denied. Check system permissions.',
    'zh-CN': '设备访问被拒绝，请检查系统权限。',
  },
  'code.NotFoundError': {
    en: 'The requested device was not found.',
    'zh-CN': '未找到所需设备。',
  },
  'code.NotReadableError': {
    en: 'The device cannot be read. It may be in use.',
    'zh-CN': '无法读取设备，设备可能正被其他应用占用。',
  },
  'code.OverconstrainedError': {
    en: 'The device does not support these capture settings.',
    'zh-CN': '设备不支持这些采集设置。',
  },
  'code.AbortError': {
    en: 'The device operation was interrupted. Please try again.',
    'zh-CN': '设备操作已中断，请重试。',
  },
  'code.SecurityError': {
    en: 'Device access is blocked by the system.',
    'zh-CN': '设备访问被系统阻止。',
  },
  'code.host_version': {
    en: 'This Host version is incompatible. Update Qwen Live Host.',
    'zh-CN': 'Host 版本不兼容，请更新 Qwen Live Host。',
  },
  'code.daemon_identity': {
    en: 'Could not verify the Live daemon identity.',
    'zh-CN': '无法验证 Live 后台进程的身份。',
  },
  'code.daemon_connection': {
    en: 'Could not connect to Qwen Live.',
    'zh-CN': '无法连接 Qwen Live。',
  },
  'code.daemon_disconnected': {
    en: 'Qwen Live disconnected.',
    'zh-CN': 'Qwen Live 已断开连接。',
  },
  'code.daemon_reconnect_exhausted': {
    en: 'Could not reconnect to Qwen Live. Restart Live to try again.',
    'zh-CN': '无法重新连接 Qwen Live，请重启 Live 后重试。',
  },
  'code.camera_permission_required': {
    en: 'Camera permission is required.',
    'zh-CN': '需要摄像头权限。',
  },
  'code.camera_not_ready': {
    en: 'Camera is not ready.',
    'zh-CN': '摄像头尚未就绪。',
  },
  'code.camera_video_unavailable': {
    en: 'Camera video is unavailable.',
    'zh-CN': '无法读取摄像头画面。',
  },
  'code.camera_track_ended': {
    en: 'The camera was disconnected.',
    'zh-CN': '摄像头已断开。',
  },
  'code.camera_ready_timeout': {
    en: 'Camera startup timed out.',
    'zh-CN': '摄像头启动超时。',
  },
  'code.camera_snapshot_frame_timeout': {
    en: 'Timed out waiting for a camera frame.',
    'zh-CN': '等待摄像头画面超时。',
  },
  'code.camera_renderer_unavailable': {
    en: 'The camera renderer is unavailable.',
    'zh-CN': '摄像头界面暂不可用。',
  },
  'code.camera_snapshot_timeout': {
    en: 'Camera snapshot timed out.',
    'zh-CN': '摄像头截图超时。',
  },
  'code.camera_snapshot_resolution_unavailable': {
    en: 'The camera cannot capture the configured snapshot resolution.',
    'zh-CN': '摄像头无法按配置的分辨率截图。',
  },
  'code.camera_photo_resolution_unavailable': {
    en: 'The camera cannot capture a native-resolution photo.',
    'zh-CN': '摄像头无法拍摄原生分辨率照片。',
  },
  'code.camera_snapshot_asset_missing': {
    en: 'The camera snapshot could not be saved.',
    'zh-CN': '无法保存摄像头截图。',
  },
  'code.camera_capture_configuration_invalid': {
    en: 'Camera capture settings are invalid.',
    'zh-CN': '摄像头采集设置无效。',
  },
  'code.camera_snapshot_configuration_invalid': {
    en: 'Camera snapshot settings are invalid.',
    'zh-CN': '摄像头截图设置无效。',
  },
  'code.camera_not_in_on_demand_mode': {
    en: 'Select On Demand to take a snapshot.',
    'zh-CN': '请切换为按需截图模式。',
  },
  'code.camera_canvas_unavailable': {
    en: 'Could not prepare the camera image.',
    'zh-CN': '无法处理摄像头图片。',
  },
  'code.camera_frame_too_large': {
    en: 'The camera image is too large to send.',
    'zh-CN': '摄像头图片过大，无法发送。',
  },
  'code.screen_capture_unavailable': {
    en: 'Screen capture is unavailable. Check screen recording permission.',
    'zh-CN': '屏幕采集不可用，请检查屏幕录制权限。',
  },
  'code.screen_image_decode_failed': {
    en: 'Could not read the screen image.',
    'zh-CN': '无法读取屏幕图片。',
  },
  'code.screen_frame_too_large': {
    en: 'The screen image is too large to send.',
    'zh-CN': '屏幕图片过大，无法发送。',
  },
  'code.stale_visual_capture': {
    en: 'The source or call changed during capture. Try again.',
    'zh-CN': '采集过程中来源或通话已改变，请重试。',
  },
  'code.visual_settings_changed': {
    en: 'The video settings changed. Try capturing again.',
    'zh-CN': '视频设置已改变，请重新截图。',
  },
  'code.jpeg_encode_failed': {
    en: 'Could not encode the captured image.',
    'zh-CN': '无法编码所采集的图片。',
  },
  'code.jpeg_read_failed': {
    en: 'Could not read the captured image.',
    'zh-CN': '无法读取所采集的图片。',
  },
  'code.audio_service_inactive': {
    en: 'Audio is not active. Start a call first.',
    'zh-CN': '音频尚未启用，请先开始通话。',
  },
  'code.audio_epoch_unavailable': {
    en: 'The audio session is unavailable.',
    'zh-CN': '音频会话不可用。',
  },
  'code.audio_input_unavailable': {
    en: 'Microphone input is unavailable.',
    'zh-CN': '麦克风输入不可用。',
  },
  'code.audio_output_unavailable': {
    en: 'Voice output is unavailable.',
    'zh-CN': '语音输出不可用。',
  },
  'code.discovery_unreadable': {
    en: 'Could not read the Live connection file.',
    'zh-CN': '无法读取 Live 连接文件。',
  },
  'code.discovery_not_regular_file': {
    en: 'The Live connection file is invalid.',
    'zh-CN': 'Live 连接文件无效。',
  },
  'code.discovery_permissions': {
    en: 'The Live connection file has unsafe permissions.',
    'zh-CN': 'Live 连接文件权限不安全。',
  },
  'code.discovery_owner': {
    en: 'The Live connection file has an unexpected owner.',
    'zh-CN': 'Live 连接文件所有者不匹配。',
  },
  'code.discovery_size': {
    en: 'The Live connection file exceeds the allowed size.',
    'zh-CN': 'Live 连接文件过大。',
  },
  'code.discovery_json': {
    en: 'The Live connection file is not valid JSON.',
    'zh-CN': 'Live 连接文件不是有效的 JSON。',
  },
  'code.discovery_shape': {
    en: 'The Live connection file has an invalid format.',
    'zh-CN': 'Live 连接文件格式无效。',
  },
  'code.discovery_protocol': {
    en: 'The Live connection protocol is incompatible.',
    'zh-CN': 'Live 连接协议不兼容。',
  },
  'code.discovery_url': {
    en: 'The Live connection address is invalid.',
    'zh-CN': 'Live 连接地址无效。',
  },
  'host.error.captureTooLarge': {
    en: 'Visual capture exceeds the protocol limit.',
    'zh-CN': '画面超过协议允许的大小。',
  },
  'host.error.quitUnconfirmed': {
    en: 'Live shutdown was not confirmed; retry Quit.',
    'zh-CN': '尚未确认 Live 已关闭，请重试退出。',
  },
  'host.error.quitCredentials': {
    en: 'Missing shutdown credentials.',
    'zh-CN': '缺少当前 Live 实例的退出凭证。',
  },
  'host.error.quitRejected': {
    en: 'Shutdown request was rejected.',
    'zh-CN': '退出请求被拒绝。',
  },
  'host.error.quitAck': {
    en: 'Invalid shutdown acknowledgement.',
    'zh-CN': '退出确认无效。',
  },
  'host.error.stopFailed': {
    en: 'Could not stop the current Live call.',
    'zh-CN': '无法结束当前 Live 通话。',
  },
  'host.error.stopTimeout': {
    en: 'Live stop timed out.',
    'zh-CN': '结束 Live 通话超时。',
  },
  'host.error.memoryInvalid': {
    en: 'Invalid memory settings.',
    'zh-CN': '无效的记忆设置。',
  },
  'host.error.memoryUnavailable': {
    en: 'Memory settings are unavailable while disconnected.',
    'zh-CN': '连接断开时无法修改记忆设置。',
  },
  'host.error.memoryBusy': {
    en: 'A memory change is already in progress.',
    'zh-CN': '正在修改记忆设置，请稍候。',
  },
  'host.error.endCallFirst': {
    en: 'End the current call before changing this setting.',
    'zh-CN': '请先结束当前通话，再修改此设置。',
  },
  'host.error.memoryTimeout': {
    en: 'Memory settings timed out. Please try again.',
    'zh-CN': '记忆设置超时，请重试。',
  },
  'host.error.memorySendFailed': {
    en: 'Could not send memory settings.',
    'zh-CN': '无法发送记忆设置。',
  },
  'host.error.memoryCallChanged': {
    en: 'The Live call changed before the memory update completed.',
    'zh-CN': '记忆更新完成前，当前通话已改变，请重试。',
  },
  'host.error.memoryDisconnected': {
    en: 'The daemon disconnected before the memory update completed.',
    'zh-CN': '记忆更新完成前，Live 连接已断开。',
  },
  'host.error.visualUnavailable': {
    en: 'Visual capture is unavailable.',
    'zh-CN': '画面采集暂不可用。',
  },
  'host.error.visualWrongSource': {
    en: 'Visual capture returned the wrong source.',
    'zh-CN': '采集结果的画面来源不匹配。',
  },
  'host.error.shortcutUnavailable': {
    en: 'Global shortcut registration is unavailable.',
    'zh-CN': '无法注册全局快捷键。',
  },
  'host.error.visualStale': {
    en: 'The visual request belongs to a stale Live call.',
    'zh-CN': '画面请求属于已结束的通话。',
  },
  'host.error.visualStopped': {
    en: 'Visual capture stopped.',
    'zh-CN': '画面采集已停止。',
  },
  'host.error.untrusted': {
    en: 'Untrusted Live Host renderer',
    'zh-CN': '无法验证 Live Host 界面。',
  },
  'host.error.untrustedQuit': {
    en: 'Untrusted quit request.',
    'zh-CN': '无法验证退出请求。',
  },
  'host.error.untrustedMemory': {
    en: 'Untrusted memory settings request.',
    'zh-CN': '无法验证记忆设置请求。',
  },
  'host.error.requiredMessage': {
    en: 'Required Live message "{messageType}" could not reach the daemon. Reconnecting.',
    'zh-CN': '必要的 Live 消息“{messageType}”未能送达，正在重新连接。',
  },
  'host.error.notReady': {
    en: 'Qwen Live Host is not ready.',
    'zh-CN': 'Qwen Live Host 尚未就绪。',
  },
  'host.error.shortcutInvalid': {
    en: 'That shortcut is invalid.',
    'zh-CN': '此快捷键无效。',
  },
  'host.error.shortcutInUse': {
    en: 'That shortcut is already in use.',
    'zh-CN': '此快捷键已被占用。',
  },
  'host.device.fallback': {
    en: 'Microphone {index}',
    'zh-CN': '麦克风 {index}',
  },
  'host.settings.unavailable': {
    en: 'Settings are unavailable. Please reconnect.',
    'zh-CN': '设置暂不可用，请重新连接。',
  },
  'host.language.unavailable': {
    en: 'Language settings are unavailable for this connection.',
    'zh-CN': '当前连接不支持更改语言设置。',
  },
  'host.language.busy': {
    en: 'A language change is already in progress.',
    'zh-CN': '正在更改语言，请稍候。',
  },
  'host.language.timeout': {
    en: 'Language settings timed out. Please try again.',
    'zh-CN': '语言设置超时，请重试。',
  },
  'host.language.sendFailed': {
    en: 'Could not send language settings.',
    'zh-CN': '无法发送语言设置。',
  },
  'host.language.disconnected': {
    en: 'The daemon disconnected before the language update completed.',
    'zh-CN': '语言更新完成前，Live 连接已断开。',
  },
  'host.language.changedCall': {
    en: 'The Live call changed before the language update completed.',
    'zh-CN': '语言更新完成前，当前通话已改变，请重试。',
  },
  'host.language.invalid': {
    en: 'Invalid language setting.',
    'zh-CN': '无效的语言设置。',
  },
  'host.language.saveFailed': {
    en: 'Could not save the local language preference.',
    'zh-CN': '无法保存本地语言偏好。',
  },
  // SUBAGENTS_MESSAGES
  'subagents.back': { en: 'Back', 'zh-CN': '返回' },
  'subagents.title': { en: 'Subagents', 'zh-CN': '子智能体' },
  'subagents.details': { en: 'Task details', 'zh-CN': '任务详情' },
  'subagents.openList': { en: 'View subagents', 'zh-CN': '查看子智能体' },
  'subagents.summaryLabel': {
    en: 'View subagents: {running} running, {completed} completed, {waiting} waiting for your input.',
    'zh-CN':
      '查看子智能体：{running} 项进行中，{completed} 项已完成，{waiting} 项等待你处理。',
  },
  'subagents.summaryWaiting': {
    en: '{count} waiting for your input',
    'zh-CN': '{count} 项等待你处理',
  },
  'subagents.openTask': {
    en: 'View task: {title}',
    'zh-CN': '查看任务：{title}',
  },
  'subagents.running': { en: 'Running', 'zh-CN': '进行中' },
  'subagents.completed': { en: 'Completed', 'zh-CN': '已完成' },
  'subagents.needsAttention': { en: 'Needs you', 'zh-CN': '需关注' },
  'subagents.queued': { en: 'Queued', 'zh-CN': '排队中' },
  'subagents.starting': { en: 'Starting', 'zh-CN': '启动中' },
  'subagents.monitoring': { en: 'Monitoring', 'zh-CN': '监测中' },
  'subagents.waiting': { en: 'Waiting for input', 'zh-CN': '等待输入' },
  'subagents.delivering': { en: 'Delivering', 'zh-CN': '播报中' },
  'subagents.failed': { en: 'Failed', 'zh-CN': '失败' },
  'subagents.cancelled': { en: 'Cancelled', 'zh-CN': '已取消' },
  'subagents.interrupted': { en: 'Interrupted', 'zh-CN': '已中断' },
  'subagents.empty': {
    en: 'No subagent tasks in this Live run yet.',
    'zh-CN': '本次 Live 运行尚无子智能体任务。',
  },
  'subagents.noRetained': {
    en: 'No task details are retained in this view.',
    'zh-CN': '当前视图未保留任务详情。',
  },
  'subagents.unavailable': {
    en: 'Subagents are unavailable for this connection.',
    'zh-CN': '当前连接不支持子智能体视图。',
  },
  'subagents.disconnected': {
    en: 'Disconnected · Showing last known activity.',
    'zh-CN': '连接已断开 · 显示最后收到的任务信息。',
  },
  'subagents.missing': {
    en: 'This task is no longer in the retained history for this Live run.',
    'zh-CN': '当前 Live 运行保留的历史中已没有这项任务。',
  },
  'subagents.omitted': {
    en: '{count} other tasks are outside the retained history.',
    'zh-CN': '另有 {count} 项任务未保留在历史中。',
  },
  'subagents.history': {
    en: 'Current Live run · Closing this window does not stop tasks.',
    'zh-CN': '本次 Live 运行 · 关闭此窗口不会停止任务。',
  },
  'subagents.otherCounts': {
    en: '{failed} failed · {cancelled} cancelled · {interrupted} interrupted',
    'zh-CN': '{failed} 失败 · {cancelled} 已取消 · {interrupted} 已中断',
  },
  'subagents.request': { en: 'Original request', 'zh-CN': '原始任务' },
  'subagents.activity': { en: 'Recent activity', 'zh-CN': '近期动态' },
  'subagents.output': { en: 'Public output', 'zh-CN': '公开输出' },
  'subagents.result': { en: 'Result', 'zh-CN': '结果' },
  'subagents.noActivity': {
    en: 'No activity received yet.',
    'zh-CN': '尚未收到任务动态。',
  },
  'subagents.noOutput': {
    en: 'No public output received yet.',
    'zh-CN': '尚未收到公开输出。',
  },
  'subagents.truncated': {
    en: 'Only retained output is shown; earlier text was trimmed.',
    'zh-CN': '仅显示保留的输出，较早的内容已裁剪。',
  },
  'subagents.updated': { en: 'Updated {time}', 'zh-CN': '更新于 {time}' },
  'subagents.backend': { en: 'Backend', 'zh-CN': '执行后端' },
  'subagents.source': { en: 'Source', 'zh-CN': '输入源' },
  'subagents.harness': { en: 'Agent task', 'zh-CN': '智能体任务' },
  'subagents.proactive': { en: 'Proactive task', 'zh-CN': '主动任务' },
  'subagents.triggers': {
    en: 'Triggers: {count}',
    'zh-CN': '触发次数：{count}',
  },
  'subagents.pendingNotifications': {
    en: 'Pending announcements: {count}',
    'zh-CN': '等待播报：{count}',
  },
  'subagents.notificationQueued': {
    en: 'Announcement queued',
    'zh-CN': '播报已入队',
  },
  'subagents.notificationSpeaking': {
    en: 'Announcing',
    'zh-CN': '正在播报',
  },
  'subagents.notificationDelivered': {
    en: 'Announcement delivered',
    'zh-CN': '已播报',
  },
  'subagents.remaining': {
    en: 'Remaining: {seconds}s',
    'zh-CN': '剩余：{seconds} 秒',
  },
  'subagents.eventStatus': { en: 'Status', 'zh-CN': '状态' },
  'subagents.eventMessage': { en: 'Message', 'zh-CN': '消息' },
  'subagents.eventPlan': { en: 'Plan', 'zh-CN': '计划' },
  'subagents.eventTool': { en: 'Tool', 'zh-CN': '工具' },
  'subagents.eventObservation': { en: 'Observation', 'zh-CN': '观察' },
  'subagents.eventNotification': { en: 'Announcement', 'zh-CN': '播报' },
  'subagents.openFailed': {
    en: 'Could not open this task. Please try again.',
    'zh-CN': '无法打开任务，请重试。',
  },
  'subagents.loadFailed': {
    en: 'Could not load subagent activity. Close and reopen this window.',
    'zh-CN': '无法加载子智能体动态，请关闭后重新打开窗口。',
  },
  'subagents.reconnecting': {
    en: 'Reconnecting to task updates',
    'zh-CN': '正在重新连接任务更新',
  },
  'subagents.outcomeUnknown': {
    en: 'Task ended without a confirmed outcome',
    'zh-CN': '任务已结束，但未确认结果',
  },
  'subagents.callEnded': {
    en: 'Voice call ended',
    'zh-CN': '语音通话已结束',
  },
  // SUBAGENTS_MESSAGES_END
  'tray.show': { en: 'Show Qwen Live', 'zh-CN': '显示 Qwen Live' },
  'tray.start': { en: 'Start call', 'zh-CN': '开始对话' },
  'tray.new': { en: 'New conversation', 'zh-CN': '新对话' },
  'tray.stop': { en: 'End call', 'zh-CN': '结束对话' },
  'tray.quit': { en: 'Quit Qwen Live Host', 'zh-CN': '退出 Qwen Live Host' },
  'tray.tooltip': {
    en: 'Qwen Live Host · {state}',
    'zh-CN': 'Qwen Live Host · {state}',
  },
} as const satisfies Record<string, Record<LiveLanguage, string>>;

export type LiveMessageKey = keyof typeof LIVE_MESSAGES;
export type LiveMessageParams = Readonly<Record<string, string | number>>;

export function isLiveLanguage(value: unknown): value is LiveLanguage {
  return value === 'en' || value === 'zh-CN';
}

export function liveText(
  language: LiveLanguage,
  key: LiveMessageKey,
  params: LiveMessageParams = {},
): string {
  return LIVE_MESSAGES[key][language].replace(
    /\{(\w+)\}/g,
    (token, name: string) =>
      params[name] === undefined ? token : String(params[name]),
  );
}

const MESSAGE_PREFIX = 'qwen-live-ui:';

/** Carry a stable message through status fields and Electron's error bridge. */
export function liveMessage(
  key: LiveMessageKey,
  params: LiveMessageParams = {},
): string {
  const bounded: Record<string, string | number> = { ...params };
  const encode = () =>
    `${MESSAGE_PREFIX}${JSON.stringify({ key, params: bounded })}`;
  let encoded = encode();
  // Status fields cap messages at 512+ characters. Clip detail, never JSON.
  while (encoded.length > 512) {
    const longest = Object.entries(bounded)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].length > 1,
      )
      .sort((left, right) => right[1].length - left[1].length)[0];
    if (!longest)
      return `${MESSAGE_PREFIX}${JSON.stringify({ key, params: {} })}`;
    bounded[longest[0]] =
      `${longest[1].slice(0, Math.floor((longest[1].length - 1) / 2))}…`;
    encoded = encode();
  }
  return encoded;
}

export function displayLiveMessage(
  language: LiveLanguage,
  value: string,
  depth = 0,
): string {
  const codeKey = `code.${value}`;
  if (Object.hasOwn(LIVE_MESSAGES, codeKey))
    return liveText(language, codeKey as LiveMessageKey);
  const start = value.indexOf(MESSAGE_PREFIX);
  if (start < 0) return value;
  if (
    start > 0 &&
    !/^(?:Error: |Error invoking remote method ['"]live:[^'"]+['"]: Error: )$/.test(
      value.slice(0, start),
    )
  )
    return value;
  try {
    const parsed: unknown = JSON.parse(
      value.slice(start + MESSAGE_PREFIX.length),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return value;
    const record = parsed as Record<string, unknown>;
    const key = record['key'];
    const params = record['params'];
    if (typeof key !== 'string' || !Object.hasOwn(LIVE_MESSAGES, key))
      return value;
    if (!params || typeof params !== 'object' || Array.isArray(params))
      return value;
    if (
      Object.values(params).some(
        (entry) => typeof entry !== 'string' && typeof entry !== 'number',
      )
    )
      return value;
    const renderedParams = Object.fromEntries(
      Object.entries(params).map(([name, entry]) => [
        name,
        typeof entry === 'string' && depth < 3
          ? displayLiveMessage(language, entry, depth + 1)
          : entry,
      ]),
    );
    return liveText(
      language,
      key as LiveMessageKey,
      renderedParams as LiveMessageParams,
    );
  } catch {
    return value;
  }
}
