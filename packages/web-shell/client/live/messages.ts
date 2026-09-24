/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live Voice strings: the call dialog and its setup card. Kept out of the
 * main dictionary so the read-only transcript build can drop them — an
 * exported transcript can never render these surfaces, yet every reader of an
 * exported file downloads the whole dictionary. `vite.lib.config.ts` resolves
 * this module to `messages.transcript-stub.ts` in `--mode transcript`.
 */
type LiveMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const LIVE_MESSAGES_EN: Record<string, LiveMessage> = {
  'live.feed.unsupported': 'On-demand screenshots only',
  'live.feed.idle': 'Screen ready for your call',
  'live.feed.starting': 'Connecting live screen…',
  'live.feed.streaming': 'Live screen · ask about what you see',
  'live.feed.stopped': 'Live screen stopped',
  'live.feed.error': 'Screen feed failed. Share again to retry.',
  'live.more': 'More',
  'live.captions': 'Captions',
  'live.feed.keepOpen': 'Keep this page and call open for live screen sharing.',
  'live.title': 'Live Voice',
  'live.open': 'Open Live Voice',
  'live.manage': 'Manage active Live Voice',
  'live.readyDescription':
    'Qwen Live Host and every required permission are ready.',
  'live.setupDescription':
    'Install Qwen Live Host and complete every permission before Live Voice can start.',
  'live.noFallback':
    'This daemon only supports Live Voice through Qwen Live Host; it never falls back to a reduced no-Appshot mode.',
  'live.shortcutHint': (v) => `Global shortcut: ${v?.shortcut ?? ''}`,
  'live.browser.connect': 'Talk in this browser',
  'live.browser.connecting': 'Connecting microphone…',
  'live.browser.requirement.host': 'This browser tab',
  'live.browser.level': 'Microphone level',
  'live.browser.levelMuted': 'Microphone muted',
  'live.browser.levelDropping':
    'Microphone is live, but audio is not reaching the daemon',
  'live.browser.requirement.runtime': 'Live runtime',
  'live.browser.takeOver': 'Take over in this tab',
  'live.browser.disconnect': 'Release microphone',
  'live.browser.setupDescription':
    'Use this browser tab as the microphone and speaker for Live Voice.',
  'live.browser.readyDescription':
    'This tab is the microphone and speaker for Live Voice.',
  'live.browser.otherTabDescription':
    'Another Web Shell tab is the microphone and speaker for Live Voice.',
  'live.browser.headphonesHint':
    'Headphones give the best result: they keep the reply out of the microphone.',
  'live.browser.startScreenShare': 'Share screen',
  'live.browser.stopScreenShare': 'Stop sharing screen',
  'live.browser.sharing': 'Screen shared',
  'live.browser.sharingNamed': (v) => `${v?.target ?? 'Screen'}`,
  'live.browser.screenRequested':
    'Qwen asked to see your screen. Share one to let it look.',
  'live.browser.lookedAtScreen': 'Qwen looked at your screen.',
  'live.browser.closed.occupied':
    'Another Live Voice endpoint is already connected.',
  'live.browser.closed.supersededNative':
    'Qwen Live Host took over Live Voice from this tab.',
  'live.browser.closed.supersededTab':
    'Another Web Shell tab took over Live Voice.',
  'live.browser.closed.refused':
    'Live Voice is turned off, or this workspace is not trusted.',
  'live.browser.closed.microphone': 'The microphone could not be opened.',
  'live.browser.closed.lost': 'The Live Voice connection was lost.',
  'settings.liveShortcut.capture': 'Press shortcut',
  'settings.liveShortcut.clear': 'Clear',
  'settings.liveShortcut.off': 'Off',
  'settings.liveSetup.title': 'Qwen Live',
  'settings.liveSetup.experimental': 'Experimental',
  'settings.liveSetup.description':
    'Talk to Qwen from anywhere on this Mac with Realtime voice, Appshot, and task handoff.',
  'settings.liveSetup.browserDescription':
    'Talk to Qwen with Realtime voice and task handoff, using this browser as the microphone and speaker.',
  'settings.liveSetup.enable': 'Enable Qwen Live',
  'settings.liveSetup.apiKey': 'DashScope Realtime API key',
  'settings.liveSetup.apiKeyPlaceholder': 'Enter a DashScope API key',
  'settings.liveSetup.apiKeyReplace': 'Enter a new key to replace it',
  'settings.liveSetup.keyFromEnv': (v) =>
    `Read from the ${v?.env ?? ''} environment variable of the selected model.`,
  'settings.liveSetup.keyFromEnvMissing': (v) =>
    `The selected model reads its key from ${v?.env ?? ''}, which is not set in the daemon's environment.`,
  'settings.liveSetup.model': 'Realtime model',
  'settings.liveSetup.modelHint':
    'Pick “Other model id…” to use any Realtime model.',
  'settings.liveSetup.modelCustom': 'Other model id…',
  'settings.liveSetup.endpoint': 'Realtime endpoint',
  'settings.liveSetup.endpointHint':
    'The OpenAI-compatible base URL of your key’s region or dedicated domain. Leave empty for the default (Beijing).',
  'settings.liveSetup.endpointFromRoute':
    "Follows the base URL of the selected model's modelProviders route.",
  'settings.liveSetup.voice': 'Voice',
  'settings.liveSetup.voiceHint':
    'A voice name of the selected model. It is checked with the provider when Live Voice is on.',
  'settings.liveSetup.appliesNextCall': 'Applies to the next call.',
  'settings.liveSetup.configured': 'Configured',
  'settings.liveSetup.notConfigured': 'Required',
  'settings.liveSetup.save': 'Save',
  'settings.liveSetup.removeKey': 'Remove key',
  'settings.liveSetup.shortcut': 'Global shortcut',
  'settings.liveSetup.host': 'Qwen Live Host',
  'settings.liveSetup.openHost': 'Open Host',
  'settings.liveSetup.retry': 'Retry',
  'settings.liveSetup.permission.microphone': 'Microphone',
  'settings.liveSetup.permission.accessibility': 'Accessibility',
  'settings.liveSetup.permission.screenRecording': 'Screen recording',
  'settings.liveSetup.permissionHint':
    'Complete any pending permission prompts in Qwen Live Host. Live stays unavailable until every permission is ready.',
  'settings.liveSetup.requirement.ready': 'Ready',
  'settings.liveSetup.requirement.missing': 'Missing',
  'settings.liveSetup.requirement.denied': 'Not allowed',
  'settings.liveSetup.requirement.unavailable': 'Unavailable',
  'settings.liveSetup.requirement.checking': 'Checking',
  'settings.liveSetup.install.missing': 'Waiting to install',
  'settings.liveSetup.install.checking': 'Checking installation…',
  'settings.liveSetup.install.downloading': 'Downloading signed Host…',
  'settings.liveSetup.install.verifying': 'Verifying signature and checksum…',
  'settings.liveSetup.install.installing': 'Installing…',
  'settings.liveSetup.install.launching': 'Opening Host…',
  'settings.liveSetup.install.installed': 'Installed',
  'settings.liveSetup.install.error': 'Setup needs attention',
  'settings.liveSetup.confirmTitle': 'Enable experimental Qwen Live?',
  'settings.liveSetup.confirmDescription':
    'Qwen Code will download, verify, install, and open the signed Qwen Live Host app. macOS will then ask you to grant Microphone, Accessibility, and Screen Recording access.',
  'settings.liveSetup.cancel': 'Cancel',
  'settings.liveSetup.confirm': 'Enable and install',
  'live.refresh': 'Refresh status',
  'live.startOrResume': 'Start or resume',
  'live.newConversation': 'New conversation',
  'live.stop': 'Stop Live',
  'live.muteInput': 'Mute microphone',
  'live.unmuteInput': 'Unmute microphone',
  'live.muteOutput': 'Mute speaker',
  'live.unmuteOutput': 'Unmute speaker',
  'live.state.unavailable': 'Voice chat unavailable',
  'live.state.idle': 'Ready for voice chat',
  'live.state.starting': 'Preparing voice chat…',
  'live.state.listening': 'Listening',
  'live.state.thinking': 'Thinking',
  'live.state.speaking': 'Speaking',
  'live.state.stopping': 'Stopping…',
  'live.state.error': 'Voice chat stopped',
  'live.requirement.host': 'Qwen Live Host',
  'live.requirement.microphone': 'Microphone',
  'live.requirement.accessibility': 'Accessibility',
  'live.requirement.screenRecording': 'Screen Recording',
  'live.requirement.audioInput': 'Audio input',
  'live.requirement.audioOutput': 'Audio output',
  'live.requirement.globalShortcut': 'Global shortcut',
  'live.requirement.appshot': 'Appshot',
  'live.requirement.provider': 'Realtime provider',
  'live.requirementState.ready': 'Ready',
  'live.requirementState.missing': 'Missing',
  'live.requirementState.denied': 'Not allowed',
  'live.requirementState.unavailable': 'Unavailable',
  'live.requirementState.checking': 'Checking',
};

export const LIVE_MESSAGES_ZH: Record<string, LiveMessage> = {
  'live.feed.unsupported': '仅支持按需截图',
  'live.feed.idle': '画面就绪，等待通话',
  'live.feed.starting': '正在连接实时画面…',
  'live.feed.streaming': '实时画面已连接，可直接询问',
  'live.feed.stopped': '实时画面已停止',
  'live.feed.error': '画面连接失败，请重新共享。',
  'live.more': '更多',
  'live.captions': '字幕',
  'live.feed.keepOpen': '实时共享画面时，请保持页面和通话开启。',
  'live.title': '实时语音',
  'live.open': '打开实时语音',
  'live.manage': '管理正在进行的实时语音',
  'live.readyDescription': 'Qwen Live Host 和所有必需权限均已就绪。',
  'live.setupDescription':
    '安装 Qwen Live Host 并完成全部授权后，才能使用实时语音。',
  'live.noFallback':
    '此 daemon 仅支持通过 Qwen Live Host 使用实时语音，不会降级为缺少 Appshot 的模式。',
  'live.shortcutHint': (v) => `全局快捷键：${v?.shortcut ?? ''}`,
  'live.browser.connect': '在此浏览器中通话',
  'live.browser.connecting': '正在连接麦克风…',
  'live.browser.requirement.host': '此浏览器标签页',
  'live.browser.level': '麦克风音量',
  'live.browser.levelMuted': '麦克风已静音',
  'live.browser.levelDropping': '麦克风正常，但音频没有送达 daemon',
  'live.browser.requirement.runtime': 'Live 运行时',
  'live.browser.takeOver': '在此标签页接管',
  'live.browser.disconnect': '释放麦克风',
  'live.browser.setupDescription':
    '将此浏览器标签页用作实时语音的麦克风和扬声器。',
  'live.browser.readyDescription': '此标签页正作为实时语音的麦克风和扬声器。',
  'live.browser.otherTabDescription':
    '另一个 Web Shell 标签页正作为实时语音的麦克风和扬声器。',
  'live.browser.headphonesHint':
    '建议佩戴耳机，避免回答的声音被麦克风再次收入。',
  'live.browser.startScreenShare': '共享屏幕',
  'live.browser.stopScreenShare': '停止共享屏幕',
  'live.browser.sharing': '正在共享屏幕',
  'live.browser.sharingNamed': (v) => `${v?.target ?? '屏幕'}`,
  'live.browser.screenRequested': 'Qwen 想看你的屏幕，共享后它才能查看。',
  'live.browser.lookedAtScreen': 'Qwen 查看了你的屏幕。',
  'live.browser.closed.occupied': '已有其他实时语音端连接。',
  'live.browser.closed.supersededNative':
    'Qwen Live Host 已从此标签页接管实时语音。',
  'live.browser.closed.supersededTab':
    '另一个 Web Shell 标签页已接管实时语音。',
  'live.browser.closed.refused': '实时语音未开启，或此工作区不受信任。',
  'live.browser.closed.microphone': '无法打开麦克风。',
  'live.browser.closed.lost': '实时语音连接已断开。',
  'settings.liveShortcut.capture': '请按下快捷键',
  'settings.liveShortcut.clear': '清除',
  'settings.liveShortcut.off': '关闭',
  'settings.liveSetup.title': 'Qwen Live',
  'settings.liveSetup.experimental': '实验性',
  'settings.liveSetup.description':
    '在这台 Mac 的任意界面通过 Realtime 语音、Appshot 和任务交接与 Qwen 对话。',
  'settings.liveSetup.browserDescription':
    '通过 Realtime 语音和任务交接与 Qwen 对话，由此浏览器充当麦克风和扬声器。',
  'settings.liveSetup.enable': '启用 Qwen Live',
  'settings.liveSetup.apiKey': 'DashScope Realtime API Key',
  'settings.liveSetup.apiKeyPlaceholder': '输入 DashScope API Key',
  'settings.liveSetup.apiKeyReplace': '输入新 Key 以替换当前配置',
  'settings.liveSetup.keyFromEnv': (v) =>
    `从所选模型的环境变量 ${v?.env ?? ''} 读取。`,
  'settings.liveSetup.keyFromEnvMissing': (v) =>
    `所选模型从 ${v?.env ?? ''} 读取 key，但 daemon 的环境里没有设置它。`,
  'settings.liveSetup.model': 'Realtime 模型',
  'settings.liveSetup.modelHint': '选“其他模型 id…”可填写任意 Realtime 模型。',
  'settings.liveSetup.modelCustom': '其他模型 id…',
  'settings.liveSetup.endpoint': 'Realtime 接入地址',
  'settings.liveSetup.endpointHint':
    '填写 Key 所属地域或专属域名的 OpenAI 兼容 baseUrl，留空使用默认地址（北京）。',
  'settings.liveSetup.endpointFromRoute':
    '跟随所选模型在 modelProviders 中路由的 baseUrl。',
  'settings.liveSetup.voice': '音色',
  'settings.liveSetup.voiceHint':
    '所选模型的音色名称。开启 Live Voice 时保存前会先向 provider 校验。',
  'settings.liveSetup.appliesNextCall': '将在下一次通话生效。',
  'settings.liveSetup.configured': '已配置',
  'settings.liveSetup.notConfigured': '必填',
  'settings.liveSetup.save': '保存',
  'settings.liveSetup.removeKey': '移除 Key',
  'settings.liveSetup.shortcut': '全局快捷键',
  'settings.liveSetup.host': 'Qwen Live Host',
  'settings.liveSetup.openHost': '打开 Host',
  'settings.liveSetup.retry': '重试',
  'settings.liveSetup.permission.microphone': '麦克风',
  'settings.liveSetup.permission.accessibility': '辅助功能',
  'settings.liveSetup.permission.screenRecording': '屏幕录制',
  'settings.liveSetup.permissionHint':
    '请在 Qwen Live Host 中完成尚未授权的项目；全部权限就绪前 Live 不可使用。',
  'settings.liveSetup.requirement.ready': '已就绪',
  'settings.liveSetup.requirement.missing': '缺失',
  'settings.liveSetup.requirement.denied': '未授权',
  'settings.liveSetup.requirement.unavailable': '不可用',
  'settings.liveSetup.requirement.checking': '检查中',
  'settings.liveSetup.install.missing': '等待安装',
  'settings.liveSetup.install.checking': '正在检查安装…',
  'settings.liveSetup.install.downloading': '正在下载已签名 Host…',
  'settings.liveSetup.install.verifying': '正在校验签名和校验和…',
  'settings.liveSetup.install.installing': '正在安装…',
  'settings.liveSetup.install.launching': '正在打开 Host…',
  'settings.liveSetup.install.installed': '已安装',
  'settings.liveSetup.install.error': '安装需要处理',
  'settings.liveSetup.confirmTitle': '启用实验性 Qwen Live？',
  'settings.liveSetup.confirmDescription':
    'Qwen Code 将自动下载、校验、安装并打开已签名的 Qwen Live Host。之后 macOS 会要求授予麦克风、辅助功能和屏幕录制权限。',
  'settings.liveSetup.cancel': '取消',
  'settings.liveSetup.confirm': '启用并安装',
  'live.refresh': '刷新状态',
  'live.startOrResume': '开始或继续',
  'live.newConversation': '新建对话',
  'live.stop': '停止实时语音',
  'live.muteInput': '麦克风静音',
  'live.unmuteInput': '取消麦克风静音',
  'live.muteOutput': '扬声器静音',
  'live.unmuteOutput': '取消扬声器静音',
  'live.state.unavailable': '实时语音不可用',
  'live.state.idle': '可以开始语音对话',
  'live.state.starting': '正在准备语音对话…',
  'live.state.listening': '正在聆听',
  'live.state.thinking': '思考中',
  'live.state.speaking': '正在回答',
  'live.state.stopping': '正在停止…',
  'live.state.error': '语音对话已停止',
  'live.requirement.host': 'Qwen Live Host',
  'live.requirement.microphone': '麦克风',
  'live.requirement.accessibility': '辅助功能',
  'live.requirement.screenRecording': '屏幕录制',
  'live.requirement.audioInput': '音频输入',
  'live.requirement.audioOutput': '音频输出',
  'live.requirement.globalShortcut': '全局快捷键',
  'live.requirement.appshot': 'Appshot',
  'live.requirement.provider': 'Realtime 模型服务',
  'live.requirementState.ready': '已就绪',
  'live.requirementState.missing': '未安装',
  'live.requirementState.denied': '未授权',
  'live.requirementState.unavailable': '不可用',
  'live.requirementState.checking': '检查中',
};
