/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enSettings } from '../en/settings.js';

export const zhCNSettings = {
  'settings.title': '设置',
  'settings.search': '搜索设置',
  'settings.noMatches': '没有符合搜索条件的设置。',
  'settings.restartRequired': '需要重启。{shortcut}。',
  'settings.restartApplyResult': '请重启 CLI 以应用更改。',
  'settings.scope.user.label': '用户设置',
  'settings.scope.project.label': '项目设置',
  'settings.scope.user.description': '存储于 {path}。优先级低于项目设置。',
  'settings.scope.project.description': '存储于 {path}。会覆盖用户设置。',
  'settings.scope.modifiedIn': '（已在{scopes}中修改）',
  'settings.scope.alsoModifiedIn': '（也在{scopes}中修改）',
  'settings.scope.overriddenByProject': '（已被项目设置覆盖）',
  'settings.scope.overriddenByProjectWithEffectiveValue':
    '（已被项目设置覆盖 · 当前生效：{value}）',
  'settings.scope.overridesUser': '（覆盖用户设置）',
  'settings.scope.overridesUserWithValue': '（覆盖用户设置：{value}）',
  'settings.scope.user.short': '用户设置',
  'settings.scope.project.short': '项目设置',
  'settings.language.label': '界面语言',
  'settings.language.description': '交互式界面使用的语言。',
  'settings.language.option.auto': '自动',
  'settings.language.option.zhCN': '简体中文',
  'settings.language.option.en': '英文',
  'settings.scope.savedTo': '设置将保存到 {path}',
  'settings.autoMemoryEnabled.label': '项目自动记忆',
  'settings.autoMemoryEnabled.description':
    '自动保存和加载当前项目可复用的信息；未设置时使用 QCS 灰度默认值。',
  'settings.autoMemoryUserScopeEnabled.label': '用户自动记忆',
  'settings.autoMemoryUserScopeEnabled.description':
    '自动保存和加载跨项目共享的可复用信息；未设置时使用 QCS 灰度默认值。',
  'settings.promptSuggestionEnabled.label': '提示词建议',
  'settings.promptSuggestionEnabled.description':
    '一轮对话完成后显示建议的下一步操作。',
  'settings.dream.enabled.label': '记忆整理',
  'settings.dream.enabled.description':
    '启用后台自动记忆整理；未设置时使用 QCS 灰度默认值。',
  'settings.codeMode.mode.label': 'Code Mode',
  'settings.codeMode.mode.description':
    '受服务端总开关控制。默认沿用本地或远端设置；关闭停用，开启保留直接调用，仅 CodeMode 通过脚本调用支持的工具。重启后生效。',
  'settings.codeMode.mode.option.off': '关闭',
  'settings.codeMode.mode.option.on': '开启',
  'settings.codeMode.mode.option.only': '仅 CodeMode',
  'settings.respondToBashCommands.label': '响应 Shell 命令',
  'settings.respondToBashCommands.description':
    '输入框中的 `!` Shell 命令完成后是否让模型响应；关闭时只将命令及输出加入上下文。',
  'settings.general.vimMode.label': 'Vim 模式',
  'settings.general.vimMode.description': '启用 Vim 键位。',
  'settings.general.defaultPermissionMode.label': '默认权限模式',
  'settings.general.defaultPermissionMode.description':
    '工具执行使用的默认权限模式；配置值和别名不区分大小写。',
  'settings.general.defaultPermissionMode.option.default': '默认',
  'settings.general.defaultPermissionMode.option.acceptEdits': '接受编辑',
  'settings.general.defaultPermissionMode.option.auto': '自动',
  'settings.general.defaultPermissionMode.option.yolo': 'YOLO',
  'settings.general.defaultPermissionMode.option.dontAsk': '不再询问',
  'settings.general.enableAutoUpdate.label': '启用自动更新',
  'settings.general.enableAutoUpdate.description': '启用自动更新。',
  'settings.general.plan.enabled.label': '启用计划模式',
  'settings.general.plan.enabled.description':
    '在规划期间启用只读安全模式；关闭后将拒绝 /plan 和 --permission-mode plan。',
  'settings.ui.inlineThinkingMode.label': '内联显示思考',
  'settings.ui.inlineThinkingMode.description':
    '在对话中显示模型思考：关闭或完整。',
  'settings.ui.inlineThinkingMode.option.off': '关闭',
  'settings.ui.inlineThinkingMode.option.full': '完整',
  'settings.ui.maxTurns.label': '单次运行最大轮数',
  'settings.ui.maxTurns.description':
    '交互式 TUI 中每次提交后模型与工具循环的最大轮数；不影响 -p/--print 模式。',
  'settings.ui.maxTurns.option.1000': '1,000',
  'settings.ui.maxTurns.option.2000': '2,000',
  'settings.ui.maxTurns.option.3000': '3,000',
  'settings.ui.maxTurns.option.unlimited': '不限',
  'settings.ui.escapePastedAtSymbols.label': '转义粘贴内容中的 @ 符号',
  'settings.ui.escapePastedAtSymbols.description':
    '转义粘贴文本中的 @ 符号，避免意外触发 @path 展开。',
  'settings.ui.showShortcutsHint.label': '显示快捷键提示',
  'settings.ui.showShortcutsHint.description':
    '在输入框上方显示“? 查看快捷键”提示。',
  'settings.ui.copyFullResponse.label': '始终复制完整回复',
  'settings.ui.copyFullResponse.description':
    '跳过 /copy 选择器，始终复制完整的助手回复。',
  'settings.privacy.usageStatisticsEnabled.label': '隐私设置',
  'settings.privacy.usageStatisticsEnabled.description':
    '共享使用数据以帮助改进产品；关闭后进入隐私模式。',
  'settings.context.loadMemoryFromIncludeDirectories.label':
    '从附加目录加载记忆',
  'settings.context.loadMemoryFromIncludeDirectories.description':
    '启动时从可信的附加工作区目录加载上下文文件。',
  'settings.security.folderTrust.enabled.label': '文件夹信任',
  'settings.security.folderTrust.enabled.description':
    '控制是否启用文件夹信任。',
  'settings.advanced.useProxyFromEnvironment.label': '使用代理环境变量',
  'settings.advanced.useProxyFromEnvironment.description':
    '独立 CLI 网络请求使用 HTTPS_PROXY、https_proxy、HTTP_PROXY 或 http_proxy；SDK 集成需由宿主显式提供代理。',
  'settings.experimental.useOSC52Paste.label': '使用 OSC 52 粘贴',
  'settings.experimental.useOSC52Paste.description':
    '在兼容的远程终端会话中使用 OSC 52 粘贴。',
  'settings.experimental.useOSC52Copy.label': '使用 OSC 52 复制',
  'settings.experimental.useOSC52Copy.description':
    '在兼容的远程终端会话中使用 OSC 52 复制。',
  'settings.skills.loadFromAgentsDirectory.label': '从 .agents/skills 加载技能',
  'settings.skills.loadFromAgentsDirectory.description':
    '从旧版 .agents/skills 兼容目录加载技能；修改后需重启 CLI。',
  'settings.agentsMdExcludes.label': '上下文文件排除项',
  'settings.agentsMdExcludes.description':
    '从项目和本地记忆加载中排除上下文文件的 glob 模式或绝对路径。',
} as const satisfies Record<keyof typeof enSettings, string>;
