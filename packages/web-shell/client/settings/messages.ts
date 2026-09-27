/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings panel strings. Kept out of the main dictionary so the read-only
 * transcript build can drop them — an exported transcript never renders the
 * settings panel, yet every reader of an exported file downloads the whole
 * dictionary. `vite.lib.config.ts` resolves this module to
 * `messages.transcript-stub.ts` in `--mode transcript`.
 */
type SettingsMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const SETTINGS_MESSAGES_EN: Record<string, SettingsMessage> = {
  'settings.models.editWindow': 'Edit context window',
  'settings.models.windowHint':
    'Leave empty to infer the limit from the model ID. Existing sessions need a restart to use the new limit.',
  'settings.models.windowSaved': 'Saved. Restart existing sessions to apply.',
  'settings.models.saved': 'Saved',
  'settings.label.advisorModel': 'Advisor Model',
  'settings.label.imageModel': 'Image Model',
  'settings.label.voiceModel': 'Voice Model',
  'settings.description.advisorModel':
    'Model used to review recent conversation progress. Leave empty to use the main model.',
  'settings.description.imageModel':
    'Model used for image generation. Add a custom model with Image generation purpose, then select it here.',
  'settings.description.voiceModel':
    'Model used for voice transcription. Add a custom model with Voice transcription purpose, then select it here.',

  'settings.title': 'Settings',
  'settings.loading': 'Loading settings...',
  'settings.empty': 'No settings available.',
  'settings.footer':
    '↑↓ Navigate  Enter Toggle  Tab Scope  r Reload  ESC Close',
  'settings.footer.edit': 'Enter Save  ESC Cancel',
  'settings.footer.theme': '↑↓ Navigate  Enter Select  ESC Back',
  'settings.scope.user': 'User',
  'settings.scope.workspace': 'Workspace',
  'settings.value.on': 'ON',
  'settings.value.off': 'OFF',
  'settings.action.edit': 'Edit',
  'settings.action.select': 'Select',
  'settings.action.save': 'Save',
  'settings.modifiedIn': (v) => `(Modified in ${v?.scope ?? ''})`,
  'settings.alsoModifiedIn': (v) => `(Also modified in ${v?.scope ?? ''})`,
  'settings.invalidNumber': 'Invalid number',
  'settings.requiresRestart': 'This change requires a restart to take effect.',
  'settings.localControl.title': 'Local Control',
  'settings.localControl.description':
    'Continue this Qwen Code session from a phone on the same trusted network.',
  'settings.localControl.on': 'On',
  'settings.localControl.off': 'Off',
  'settings.localControl.network': 'Local network',
  'settings.localControl.selectNetwork': 'Choose a network',
  'settings.localControl.qr': 'Local Control QR code',
  'settings.localControl.enable': 'Turn on Local Control',
  'settings.localControl.disable': 'Disconnect phone access',
  'settings.localControl.encrypted': 'Encrypted',
  'settings.localControl.unencrypted':
    'Unencrypted — trusted networks only; re-enable after network changes',
  'settings.localControl.awake': 'This Mac will stay awake',
  'settings.localControl.maySleep': 'This Mac may sleep',
  'settings.localControl.urlRedacted':
    'The pairing URL is not shown here because this daemon has no bearer token. It was printed to the terminal where the daemon is running — pair from there.',
  'settings.models.title': 'Models',
  'settings.models.context': (v) => `Context: ${v?.tokens ?? ''} tokens`,
  'settings.models.credentialEnv': 'Key environment variable',
  'settings.models.add': '+ Add Model',
  'settings.models.addDisabled': 'Adding models is disabled by the host.',
  'settings.models.setCurrent': 'Set current',
  'settings.models.current': 'Current',
  'settings.models.runtime': 'Runtime',
  'settings.models.savedConfiguration': 'Saved configuration',
  'settings.models.ambiguousWindow':
    'Multiple configurations share this route. Its context window cannot be edited here.',
  'settings.models.delete': 'Delete',
  'settings.models.confirmDelete': 'Confirm',
  'settings.models.cancel': 'Cancel',
  'settings.models.empty': 'No configured models yet.',
  'settings.models.loading': 'Loading models…',
  'settings.models.deleteFailed': 'Failed to delete model',
  'settings.models.runtimeSyncFailed':
    'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
  'settings.models.fallbacks.title': 'Model Fallbacks',
  'settings.models.fallbacks.hint': (v) =>
    `Select up to ${v?.max ?? 3}; tried in order when the main model is at capacity.`,
  'settings.models.fallbacks.confirm': 'Confirm',
  'settings.models.fallbacks.empty': 'No selectable models.',
  'settings.models.fallbacks.saveFailed': 'Failed to save fallback models',
  'settings.models.fallbacks.limitReached': (v) =>
    `Maximum of ${v?.max ?? 3} fallback models selected; deselect one to choose another.`,
  'settings.corrupted': (v) =>
    `Settings file was corrupted${v?.recovered === 'true' ? ' (recovered from backup)' : ''}`,
  'settings.label.ui.chatWidth': 'Chat width',
  'settings.description.ui.chatWidth':
    'Frontend-only chat content width. Stored in this browser.',
  'settings.label.ui.enableFollowupSuggestions': 'Enable Follow-up Suggestions',
  'settings.description.ui.enableFollowupSuggestions':
    'Show context-aware follow-up suggestions after a task completes. Press Tab or Right Arrow to insert, Enter to accept and submit.',
  'settings.option.ui.chatWidth.1000': 'Regular',
  'settings.option.ui.chatWidth.wide': 'Ultra wide',
  'settings.label.visionModel': 'Vision Model',
  'settings.description.visionModel':
    'Image-capable model used as the vision bridge. Leave empty to auto-select.',
};

export const SETTINGS_MESSAGES_ZH: Record<string, SettingsMessage> = {
  'settings.models.editWindow': '配置窗口大小',
  'settings.models.windowHint':
    '留空根据模型 ID 自动推断。已有会话需重启后使用新窗口大小。',
  'settings.models.windowSaved': '已保存，重启已有会话后生效。',
  'settings.models.saved': '已保存',
  'settings.label.advisorModel': '顾问模型',
  'settings.label.imageModel': '生图模型',
  'settings.label.voiceModel': '语音转写模型',
  'settings.description.advisorModel': '用于复查近期对话进展，默认使用主模型。',
  'settings.description.imageModel':
    '用于生成图片。添加自定义模型时选择“生图”用途，再在这里选择。',
  'settings.description.voiceModel':
    '用于将语音转成文字。添加自定义模型时选择“语音转写”用途，再在这里选择。',

  'settings.title': '设置',
  'settings.loading': '正在加载设置...',
  'settings.empty': '暂无可用设置。',
  'settings.footer': '↑↓ 导航  Enter 切换  Tab 切换作用域  r 刷新  ESC 关闭',
  'settings.footer.edit': 'Enter 保存  ESC 取消',
  'settings.footer.theme': '↑↓ 导航  Enter 选择  ESC 返回',
  'settings.scope.user': '用户',
  'settings.scope.workspace': '工作区',
  'settings.value.on': '开',
  'settings.value.off': '关',
  'settings.action.edit': '编辑',
  'settings.action.select': '选择',
  'settings.action.save': '保存',
  'settings.modifiedIn': (v) => `（已在${v?.scope ?? ''}中修改）`,
  'settings.alsoModifiedIn': (v) => `（同时在${v?.scope ?? ''}中修改）`,
  'settings.invalidNumber': '无效数字',
  'settings.requiresRestart': '此更改需要重启后才能生效。',
  'settings.localControl.title': '本地控制',
  'settings.localControl.description':
    '通过同一受信任网络中的手机继续当前 Qwen Code 会话。',
  'settings.localControl.on': '已开启',
  'settings.localControl.off': '关闭',
  'settings.localControl.network': '本地网络',
  'settings.localControl.selectNetwork': '选择网络',
  'settings.localControl.qr': '本地控制二维码',
  'settings.localControl.enable': '开启本地控制',
  'settings.localControl.disable': '断开手机访问',
  'settings.localControl.encrypted': '已加密',
  'settings.localControl.unencrypted':
    '未加密，仅限受信任网络；网络变化后请重新启用',
  'settings.localControl.awake': '这台 Mac 将保持唤醒',
  'settings.localControl.maySleep': '这台 Mac 可能进入睡眠',
  'settings.localControl.urlRedacted':
    '由于该守护进程未配置 bearer token，配对 URL 不在此显示。它已打印到运行守护进程的终端，请到该终端获取配对 URL 完成配对。',
  'settings.models.title': '模型',
  'settings.models.context': (v) => `上下文：${v?.tokens ?? ''} Token`,
  'settings.models.credentialEnv': '密钥环境变量',
  'settings.models.add': '+ 增加模型',
  'settings.models.addDisabled': '宿主已禁用添加模型。',
  'settings.models.setCurrent': '设为当前',
  'settings.models.current': '当前',
  'settings.models.runtime': '运行时',
  'settings.models.savedConfiguration': '已保存配置',
  'settings.models.ambiguousWindow':
    '多个配置共用此模型端点，无法在此修改窗口大小。',
  'settings.models.delete': '删除',
  'settings.models.confirmDelete': '确认删除',
  'settings.models.cancel': '取消',
  'settings.models.empty': '暂无配置的模型。',
  'settings.models.loading': '正在加载模型…',
  'settings.models.deleteFailed': '删除模型失败',
  'settings.models.runtimeSyncFailed':
    '更改已保存，但无法刷新正在运行的会话。请重启 qwen serve 后再使用更新后的模型列表。',
  'settings.models.fallbacks.title': '模型回退',
  'settings.models.fallbacks.hint': (v) =>
    `最多选择 ${v?.max ?? 3} 个；主模型容量不足时按顺序回退。`,
  'settings.models.fallbacks.confirm': '确认',
  'settings.models.fallbacks.empty': '暂无可选模型。',
  'settings.models.fallbacks.saveFailed': '保存回退模型失败',
  'settings.models.fallbacks.limitReached': (v) =>
    `最多可选 ${v?.max ?? 3} 个回退模型；请先取消一个再选择其他。`,
  'settings.corrupted': (v) =>
    `设置文件已损坏${v?.recovered === 'true' ? '（已从备份恢复）' : ''}`,
  'settings.label.ui.chatWidth': '屏宽',
  'settings.description.ui.chatWidth':
    '纯前端的聊天内容宽度设置，保存在当前浏览器中。',
  'settings.option.ui.chatWidth.1000': '常规',
  'settings.option.ui.chatWidth.wide': '超宽',
  'settings.category.General': '通用',
  'settings.category.UI': '界面',
  'settings.category.Privacy': '隐私',
  'settings.category.Model': '模型',
  'settings.category.Context': '上下文',
  'settings.category.Tools': '工具',
  'settings.category.Daemon': '守护进程',
  'settings.category.Connections': '连接',
  'settings.category.Experimental': '实验性',
  'settings.category.Advanced': '高级',
  'settings.label.general.enableAutoUpdate': '启用自动更新',
  'settings.description.general.enableAutoUpdate': '启动时自动检查并安装更新。',
  'settings.label.general.showSessionRecap': '显示会话回顾',
  'settings.description.general.showSessionRecap':
    '离开终端一段时间后返回时，自动显示一行“上次停在这里”的回顾。默认关闭。也可以随时使用 /recap 手动触发。',
  'settings.label.general.sessionRecapAwayThresholdMinutes':
    '会话回顾离开阈值（分钟）',
  'settings.description.general.sessionRecapAwayThresholdMinutes':
    '终端失焦多少分钟后，下一次重新聚焦时触发自动回顾。默认与 Claude Code 一致为 5 分钟；如果只是短暂切换窗口，可以调高。',
  'settings.label.general.cleanupPeriodDays': '清理周期（天）',
  'settings.description.general.cleanupPeriodDays':
    '~/.qwen/file-history/ 中用于 /rewind 的会话备份、以及 runtime debug/ 目录下的会话 debug 日志的保留天数。后台清理最多每天运行一次。设为 0 表示最小保留（约 1 小时），仍会保护最近一小时触碰过的会话和当前活动会话。',
  'settings.label.general.gitCoAuthor.commit': '归因：commit',
  'settings.description.general.gitCoAuthor.commit':
    '通过 Qwen Code 创建 commit 时，添加 Co-authored-by trailer，并写入逐文件 AI 归因 git note。关闭后两者都会跳过。',
  'settings.label.general.gitCoAuthor.pr': '归因：PR',
  'settings.description.general.gitCoAuthor.pr':
    '运行 gh pr create 时，在 PR 描述中追加 Qwen Code 归因行。',
  'settings.label.general.language': '语言：界面',
  'settings.description.general.language':
    '用户界面的语言。使用 auto 可根据系统设置自动检测；也可以在 ~/.qwen/locales/ 中放置 JS 语言文件来使用自定义语言代码。',
  'settings.label.general.preventSystemSleep': '运行时防止系统睡眠',
  'settings.description.general.preventSystemSleep':
    '当 Qwen Code 正在流式生成模型回复或执行工具时防止系统睡眠。空闲输入状态和权限确认状态不会阻止睡眠。',
  'settings.label.review.attribution': '归因：review',
  'settings.description.review.attribution':
    '向 GitHub 发布的 review 正文和行内评论会追加标注模型与 CLI 版本的归因页脚（例如“_— qwen3-coder via Qwen Code /review (v0.21.2)_”）。关闭后发布的 review 不带可见 AI 归因：没有页脚，评论和正文列表中也没有“**[Critical]**”/“**[Suggestion]**”严重级别标记。无归因内容在原始文本中仍可识别：每条评论携带不可见的严重级别标记（“<!-- qwen-review critical -->”），review 正文携带 ledger 标记（“<!-- qwen-review-ledger ... -->”）——读取评论内容的自动化（GitHub API 自动化、与此设置联动的工作流）仍能识别 /review 产物，presubmit 重复检测也能凭严重级别标记识别评审账号的历史评论（其他账号的无归因评论除外）。另一影响：qwen-autofix 的仅 Critical 模式（第 5 轮后启用，或计数窗口的 diff 增长预算触发时提前启用）将无法把已发布的发现识别为 Critical 而推迟处理。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.label.review.effort': '默认 effort：review',
  'settings.description.review.effort':
    '/review 在未给出 --effort、也没有项目记住的显式强度时的默认强度。“auto”保持内置规则（PR 用 high，本地改动用 medium）。显式指定或被记住的强度仍然优先；生效的 --comment 仍强制 high，--fix 仍保底 medium。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.option.review.effort.auto': '自动（PR 用 high，本地用 medium）',
  'settings.option.review.effort.low': '低',
  'settings.option.review.effort.medium': '中',
  'settings.option.review.effort.high': '高',
  'settings.label.review.comment': '默认发布评论：review',
  'settings.description.review.comment':
    '把每次 PR /review 视为带 --comment 执行：不加旗标也会把发现发布到 PR。发布仍绑定调用时指定的 PR。仅在你希望评审总是发布时开启。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.label.review.severityFloor': '发布下限：review',
  'settings.description.review.severityFloor':
    'PR /review 未指定 --severity-floor 时的最低发布级别。“auto”保持随轮次自适应的默认值：第 5 轮及以前发布 Suggestion，第 6 轮起只发布 Critical，其余本可发布的高置信 Suggestion 会被记录并推迟（低置信和 Nice-to-have 发现一如既往只留在终端）；“auto”下第 2–5 轮还会推迟针对上一轮以来未变更代码的新 Suggestion——正是这套规则防止评审轮次把 PR 越滚越大。“critical”从第 1 轮起就采用该姿态；“suggestion”每轮都发布 Suggestion。非 PR 目标没有轮次概念，忽略此项。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.option.review.severityFloor.auto': '自动（第 6 轮起仅 Critical）',
  'settings.option.review.severityFloor.critical': '仅 Critical（每轮）',
  'settings.option.review.severityFloor.suggestion': 'Suggestion 与 Critical',
  'settings.label.review.reverseAuditRounds': '反向审计轮次上限：review',
  'settings.description.review.reverseAuditRounds':
    '降低每次高强度评审中反向审计循环的轮次上限。上限通常按 diff 拓扑选择（小 diff 10 轮、分块 5 轮；巨型 diff 在有评审截止时间时为 3、没有时为 5——这一削减是为了应对 CI 上限，只在上限存在时生效），因为一轮在小 diff 上花费一个 agent，在巨型 diff 上约 90 分钟。此设置只能降低适用档位，不能提高：非正整数或超出范围的值（低于 3 或高于计划本身的档位）会被忽略，档位保持不变——此处的 JSON Schema 没有 integer 类型，小数能通过编辑器校验，但会在运行时被丢弃。启用前请理解代价：循环在连续两轮无新发现时结束，压低上限不会让评审更快收敛，只会让评审更常在收敛前停止——每次这种停止都会披露为未评审范围，且结论上限压到 Comment，更省钱的评审也因此无法再给出 Approve。想整体降低评审开销，请优先用“effort”。此设置没有任何让循环跑更久的效果：评审截止时间约束单次运行而非延长它，在巨型 diff 上设置截止时间会把上限从 5 降到 3 而非提高。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.label.output.showTimestamps': '显示时间戳',
  'settings.description.output.showTimestamps':
    '在每条助手回复前显示 [HH:MM:SS] 时间戳。',
  'settings.label.review.sandbox': '沙箱隔离被评审代码：review',
  'settings.description.review.sandbox':
    '在容器里运行被评审仓库自己的命令——带安装脚本的 `npm ci`、构建、测试套件以及每个变异探针——而不是直接以你的身份运行。评审会执行它所评审的代码，而今天这些命令继承评审进程的整个环境（在 CI 上包括模型和 GitHub 凭据）。“auto”在 docker 或 podman 可用时使用容器，两者都不可用时直接运行；“required”拒绝在非沙箱环境运行这些命令，此时依赖执行的证据（构建/测试发现、变异判定、`Source: [probe]`）在本次评审中不可用，而不是终止评审；“off”是今天的行为并保持默认，因为毫无预兆地把构建放进容器会改变原生模块的编译目标。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法关掉为约束它而存在的隔离。',
  'settings.option.review.sandbox.off': '关闭（直接运行被评审代码）',
  'settings.option.review.sandbox.auto': '自动（有可用容器时使用容器）',
  'settings.option.review.sandbox.required': '强制（绝不在沙箱外运行）',
  'settings.label.review.approachRounds': '方向提示轮次阈值：review',
  'settings.description.review.approachRounds':
    '一个 PR 要达到多少轮评审之后，评审才可以追加一段提示性文字，说明看起来成问题的是改动的方向而不是当前补丁本身。它只在 diff 自评审首次测量以来也膨胀了数倍时出现，且从不出现在 Approve 上。它仅是披露：不新增发现、不改变结论、不阻塞任何事——它存在的原因是每条发现都锚定在当前 diff 的某一行上，所以评审能报告某个方向在哪里漏，却永远说不出换个方向能一次性消除所有这些漏洞。保持 0 表示用内置的 5 轮阈值；调大让这段文字更晚出现；设得非常大则彻底关闭。非正整数的值会被忽略。仅在 User、System、SystemDefaults 作用域生效；Workspace 作用域的值会被忽略，仓库无法为其评审者设定评审策略。',
  'settings.label.ui.theme': '主题',
  'settings.description.ui.theme': '界面的颜色主题。',
  'settings.label.ui.hideTips': '隐藏提示',
  'settings.description.ui.hideTips': '隐藏界面中的帮助提示。',
  'settings.label.ui.enableWelcomeBack': '显示欢迎回来对话框',
  'settings.description.ui.enableWelcomeBack':
    '回到有历史会话的项目时显示欢迎回来对话框。选择“开始新的聊天会话”后，在项目摘要变化前不会再次显示。',
  'settings.label.ui.enableUserFeedback': '启用用户反馈',
  'settings.description.ui.enableUserFeedback':
    '对话结束后显示可选反馈对话框，帮助改进 Qwen 表现。',
  'settings.label.ui.enableFollowupSuggestions': '启用后续建议',
  'settings.description.ui.enableFollowupSuggestions':
    '任务完成后显示上下文相关的后续建议。按 Tab 或右方向键插入，按 Enter 接受并提交。',
  'settings.label.ui.compactMode': '紧凑模式',
  'settings.description.ui.compactMode':
    '已退役：紧凑视图在 TUI 和 Web Shell 中都始终开启。保留此键是为了让既有设置文件不再出现告警。',
  'settings.label.ui.shellOutputMaxLines': 'Shell 输出最大行数',
  'settings.description.ui.shellOutputMaxLines':
    '内联显示的 shell 输出最大行数。设为 0 可取消限制并显示完整输出；隐藏行数仍会通过 +N lines 指示器展示。',
  'settings.label.ui.disableWorkflowKeywordTrigger': '禁用 Workflow 关键词触发',
  'settings.description.ui.disableWorkflowKeywordTrigger':
    '开启后，提示词中提到 `workflow` 一词不再会把本轮软引导向 Workflow 工具（页脚的 `workflow active` 指示也会被抑制）。仅在启用 workflow 功能时生效。',
  'settings.label.ui.showStatusInTitle': '在标题栏显示状态',
  'settings.description.ui.showStatusInTitle':
    '在终端窗口标题中显示 Qwen Code 会话名称和状态。',
  'settings.label.ui.showResponseTokensPerSecond': '显示回复 Tokens/秒',
  'settings.description.ui.showResponseTokensPerSecond':
    '模型流式输出时，在回复 token 计数旁显示实时的 tokens/秒估值。下个会话生效。',
  'settings.label.ui.showToolCallDetails': '显示工具调用详情',
  'settings.description.ui.showToolCallDetails':
    '内联显示工具的参数和结果。关闭后普通工具调用渲染为单行摘要；在虚拟化历史中点击摘要或按 Ctrl+O 可展开详情。审批提示、用户主动发起的 shell 命令和获得焦点的交互式 shell 保持展开。',
  'settings.label.privacy.usageStatisticsEnabled': '启用使用统计',
  'settings.description.privacy.usageStatisticsEnabled': '启用使用统计收集。',
  'settings.label.fastModel': '快速模型',
  'settings.description.fastModel':
    '用于生成提示建议和推测执行的模型。留空则使用主模型。较小/更快的模型（例如 qwen3-coder-flash）可以降低延迟和成本。',
  'settings.label.visionModel': '视觉模型',
  'settings.description.visionModel':
    '用于视觉桥接的图像能力模型。留空则自动选择。',
  'settings.label.modelFallbacks': '模型回退',
  'settings.description.modelFallbacks':
    '主模型遇到容量错误（429/503/529）时按序尝试的回退模型 ID 列表（逗号分隔，最多 3 个）。例如“qwen-plus,qwen-turbo”。可用 CLI --fallback-model 设置。',
  'settings.label.model.reasoningEffort': '推理强度',
  'settings.description.model.reasoningEffort':
    '推理型模型的思考强度，对所有服务商生效。用 /effort 设置。各服务商会把它映射并收敛到当前模型支持的范围（例如 Gemini 最高到“high”；Anthropic 会裁掉模型不支持的档位）。留空则使用模型/服务商默认值。',
  'settings.option.model.reasoningEffort.low': '低',
  'settings.option.model.reasoningEffort.medium': '中',
  'settings.option.model.reasoningEffort.high': '高',
  'settings.option.model.reasoningEffort.xhigh': '极高',
  'settings.option.model.reasoningEffort.max': '最高',
  'settings.label.mcpServers': 'MCP 服务器',
  'settings.description.mcpServers': 'MCP 服务器配置。',
  'settings.label.advisorMaxUses': 'Advisor 会话调用上限',
  'settings.description.advisorMaxUses':
    '每个会话中 Advisor 原生请求的最大次数，由执行器及其子代理共享。失败的请求也计数。0 表示不限制。每次请求都会把会话内容发送给所选服务商并消耗额外 token。仅 user 和 system 作用域的设置生效。',
  'settings.label.context.fileFiltering.respectGitIgnore': '遵守 .gitignore',
  'settings.description.context.fileFiltering.respectGitIgnore':
    '搜索时遵守 .gitignore 文件。',
  'settings.label.context.fileFiltering.respectQwenIgnore': '遵守 .qwenignore',
  'settings.description.context.fileFiltering.respectQwenIgnore':
    '搜索时遵守 .qwenignore 文件。',
  'settings.label.context.fileFiltering.enableFuzzySearch': '启用模糊搜索',
  'settings.description.context.fileFiltering.enableFuzzySearch':
    '搜索文件时启用模糊搜索。',
  'settings.label.tools.toolSearch.enabled': '启用 ToolSearch',
  'settings.description.tools.toolSearch.enabled':
    '启用后，deferred 工具会先通过 ToolSearch 检查 schema，再通过 ToolCall 调用。桥接的查看与调用保持工具声明列表稳定——桥接不会把 reveal 的工具重新声明——从而减少提示词大小且不触碰 prompt-cache 前缀。但声明列表并非不可变：会话仍会在以下情况重新声明——恢复会话时；工具集刷新（MCP 发现、会话中首次进入计划模式、子代理定义变更）在实时历史中发现对某个仍隐藏的 deferred 工具的直接调用时；子代理定义变更改写 agent 工具自身描述时；以及 MCP server 在会话中以 alwaysLoadTools: true 注册时。',
  'settings.label.tools.toolSearch.threshold': '延迟工具预载阈值（%）',
  'settings.description.tools.toolSearch.threshold':
    '会话启动时为预载延迟工具（内置打包工具和 MCP 工具）划出的上下文窗口百分比预算。当所有延迟工具的 schema 都在预算内时，会在会话开始时全部声明而非按需加载，省去首次使用前的一次 tool_search 桥接往返。设为 0 表示不做基于阈值的预载，延迟工具按需经 ToolSearch + ToolCall 桥加载。',
  'settings.label.tools.webSearch.enabled': '启用 WebSearch',
  'settings.description.tools.webSearch.enabled':
    '设为 false 可禁用内置 web_search 工具。启动时自动启用要求 enabled、model 以及仅限环境变量配置的后端均保持未设置；设为 true 时，只有在仅限环境变量配置的后端也未设置时才允许自动推导，否则必须配置模型。环境变量覆盖：ENABLE_WEB_SEARCH。',
  'settings.label.tools.webSearch.model': '搜索模型',
  'settings.description.tools.webSearch.model':
    '显式搜索路径的模型选择器（“modelId”或“authType:modelId”）。设置了 WEB_SEARCH_BASE_URL 时，它是该端点的纯模型 ID；否则必须匹配带 envKey 的 DashScope 兼容 modelProviders 条目。自动路径使用 qwen3.8-flash。环境变量覆盖：WEB_SEARCH_MODEL。',
  'settings.label.tools.webSearch.webExtractor': '打开搜索结果页',
  'settings.description.tools.webSearch.webExtractor':
    '允许搜索 agent 打开并阅读搜索结果页（DashScope web_extractor），让回答更有依据。DashScope 对此单独计费。环境变量覆盖：WEB_SEARCH_EXTRACTOR。',
  'settings.label.tools.webSearch.timeoutMs': '搜索超时（毫秒）',
  'settings.description.tools.webSearch.timeoutMs':
    '一次 web_search 调用的总时间预算，单位毫秒（默认 120000，上限 600000；其他取值回落到默认值）。搜索 agent 会执行多个查询并可能打开结果页；超出预算时，只要已有至少一次搜索调用完成，就返回已到达的部分结果——如果预算在第一个搜索调用完成前耗尽，工具改为报告超时错误，因为没有任何已执行搜索的叙述不是可审计的证据。低于此预算的单工具执行上限（QWEN_CODE_TOOL_EXECUTION_TIMEOUT_MS）会先触发并丢弃部分结果；请让该上限高于此处的预算。环境变量覆盖：WEB_SEARCH_TIMEOUT_MS。',
  'settings.label.tools.webSearch.maxPerSession': '每会话最大搜索次数',
  'settings.description.tools.webSearch.maxPerSession':
    '单个会话中 web_search 调用的最大次数（默认 200，上限 10000；其他取值回落到默认值）。计数与子代理共享，会话切换时重置（/clear、/resume、分支）。达到上限后跳过后续搜索，并告知模型用已收集的内容继续。环境变量覆盖：WEB_SEARCH_MAX_PER_SESSION。',
  'settings.label.tools.listDirectory.enabled': '启用 ListDirectory',
  'settings.description.tools.listDirectory.enabled':
    '启用内置 list_directory 工具。默认关闭；当它被显式列入 coreTools 白名单（--core-tools / tools.core）时会自动启用。',
  'settings.label.tools.codeModeOnly': '仅代码模式（实验性）',
  'settings.description.tools.codeModeOnly':
    '普通工具只通过隔离的 exec JavaScript 工具暴露给模型。直接控制类工具仍然可用。在 safe 和 bare 模式下忽略。',
  'settings.label.tools.todoWrite.enabled': '启用 Todo Write',
  'settings.description.tools.todoWrite.enabled':
    '启用内置 todo_write 工具及其系统提示词引导。',
  'settings.label.tools.workflowsEnabled': '动态 Workflow',
  'settings.description.tools.workflowsEnabled':
    '启用 Workflow 工具：模型可以编写并运行一个编排多个子代理并行工作的脚本。默认关闭；一次运行可能派发大量子代理并相应消耗 token。QWEN_CODE_ENABLE_WORKFLOWS=1 和 QWEN_CODE_DISABLE_WORKFLOWS=1 环境变量会覆盖此设置（禁用时优先）。与 Session Workflow 的计划并审阅视图无关；要阻止“workflow”关键词引导对话走向，见“禁用 Workflow 关键词触发”。',
  'settings.label.tools.workflowSizeGuideline': '动态 Workflow 规模',
  'settings.description.tools.workflowSizeGuideline':
    '模型编写的动态 workflow 的建议规模指引：“small”目标少于 5 个 agent，“medium”（默认）少于 15 个，“large”少于 50 个，“unrestricted”不下发指引。这是建议而非强制限制。它同时决定运行中的 workflow 被标记为大型的 agent 数量（可用 QWEN_CODE_WORKFLOW_SIZE_WARNING_AGENTS 覆盖该阈值）。修改从下一条消息起生效。',
  'settings.option.tools.workflowSizeGuideline.small': '小（少于 5 个 agent）',
  'settings.option.tools.workflowSizeGuideline.medium':
    '中（少于 15 个 agent）',
  'settings.option.tools.workflowSizeGuideline.large': '大（少于 50 个 agent）',
  'settings.option.tools.workflowSizeGuideline.unrestricted':
    '不限制（不下发指引）',
  'settings.label.tools.workflowNameOnly': '仅允许命名 Workflow',
  'settings.description.tools.workflowNameOnly':
    '限制模型只能运行命名 workflow：已保存的 workflow 和扩展自带的 workflow，按名称调用。模型不能运行内联脚本或脚本路径，运行中的脚本也不能按路径嵌套脚本，因此模型发起的每次运行都能被 Workflow(name:...) 权限规则匹配。它不替代审批策略：模型仍可保存新的 workflow 文件并按名称运行，作用域为特定名称或脚本摘要的审批规则会照常询问。宿主通过 ACP 发起的运行（run-saved、run-script、retry、rerun）不受限制。QWEN_CODE_WORKFLOW_NAME_ONLY=1 也会开启。Workspace 只能把它设为 true。',
  'settings.label.tools.shell.enableInteractiveShell': '交互式 Shell（PTY）',
  'settings.description.tools.shell.enableInteractiveShell':
    '使用 node-pty 提供交互式 shell 体验。未设置时，明确的单次 prompt 默认使用 child_process；交互式和输入驱动模式默认使用 PTY。',
  'settings.label.policy.permissionStrategy': '权限协调策略',
  'settings.description.policy.permissionStrategy':
    '多个客户端连接时权限请求的决策方式。first-responder 表示任意客户端先响应者生效；designated 表示仅提示发起方决策；consensus 表示需要 N-of-M 投票同意；local-only 表示只有 loopback 客户端可决策。需要重启 daemon 后生效。',
  'settings.option.policy.permissionStrategy.first-responder': '先响应者',
  'settings.option.policy.permissionStrategy.designated': '指定发起方',
  'settings.option.policy.permissionStrategy.consensus': '共识法定人数',
  'settings.option.policy.permissionStrategy.local-only': '仅本机',
  'settings.label.experimental.cron': '启用 Cron/Loop 工具',
  'settings.description.experimental.cron':
    '启用会话内 cron/loop 工具。启用后，模型可以用 cron_create、cron_list 和 cron_delete 创建周期性提示。也可通过 QWEN_CODE_DISABLE_CRON=1 环境变量禁用。',
  'settings.label.experimental.sessionWorkflow': 'Session Workflow 计划并审阅',
  'settings.description.experimental.sessionWorkflow':
    '显示 Session Workflow DAG，并将 Plan 模式展示为计划并审阅。',
  'settings.label.experimental.emitToolUseSummaries': '工具使用摘要',
  'settings.description.experimental.emitToolUseSummaries':
    '每个工具批次完成后生成一个简短的 LLM 标签。已完成工具组的标签会替代通用的 Tool × N 标题；强制展开的工具组下方显示弱化的 ● <label> 行。需要配置快速模型。',
  'settings.label.experimental.sessionWriterLease': '启用 ACP 会话写入租约',
  'settings.description.experimental.sessionWriterLease':
    '为持久化的 ACP 和 daemon 会话启用跨进程写入围栏。生效值在 ACP 或 daemon 进程启动时冻结。每个并发的 ACP 或 daemon 写入方都必须开启此设置；交互式和 headless 写入方不参与该协议。',
  'settings.label.experimental.agentTeam': '启用 Agent Team',
  'settings.description.experimental.agentTeam':
    '启用 agent 团队协作工具（实验性）。启用后，模型可以创建 agent 团队，并用 team_create、team_delete、send_message、task_create、task_update 和 task_list 协调工作。也可通过 QWEN_CODE_ENABLE_AGENT_TEAM=1 环境变量启用。',
  'settings.label.experimental.artifact': '启用 Artifacts',
  'settings.description.experimental.artifact':
    '启用 artifact 工具，默认开启。在交互式非 SDK 会话中，模型可以把自包含 HTML 页面发布为交互式 Artifact 并在浏览器中打开；非 SDK 的 daemon 会话可使用仅记录元数据的 record_artifact 工具。设为 false 或用 QWEN_CODE_DISABLE_ARTIFACT=1 可同时禁用两者。',
  'settings.label.experimental.liveVoice.enabled': 'Live Voice 实时语音',
  'settings.description.experimental.liveVoice.enabled':
    '在 macOS Web Shell 上启用实验性的实时语音对话。',
  'settings.label.experimental.liveVoice.shortcut': 'Live Voice 全局快捷键',
  'settings.description.experimental.liveVoice.shortcut':
    '由 Qwen Live Host 全局注册的 Electron accelerator。',
  'settings.label.goals.modelProposed': '模型提议的 Goal',
  'settings.description.goals.modelProposed':
    '控制 propose_goal 工具：模型可以提议一个会话 Goal 供你批准。“alwaysAsk”（默认）把每个提议弹到确认对话框，你接受之前不会设置任何 Goal；“disabled”移除该工具。手动输入的 /goal 不受影响。此项涉及授权确认，仅从 User、System、SystemDefaults 作用域生效；Workspace 的值会被忽略。',
  'settings.option.goals.modelProposed.alwaysAsk': '始终询问',
  'settings.option.goals.modelProposed.disabled': '禁用',
  'settings.label.omni.enabled': '启用 Omni 媒体投递',
  'settings.description.omni.enabled':
    '启用 omni 媒体管线。用 @ 引用的媒体文件（视频、图片、音频）以及 @https:// URL 提供的媒体会被识别（ffprobe）、以内容寻址存储在 .qwen/omni/objects/ 下，经 DashScope 临时上传通道上传，并以 oss:// URL 投递，而不是内联 base64。仅对 DashScope 兼容端点生效。也可通过 QWEN_CODE_ENABLE_OMNI=1 启用。',
  'settings.label.agents.arena.preserveArtifacts': '保留 Arena 产物',
  'settings.description.agents.arena.preserveArtifacts':
    '启用后，Arena worktree 和会话状态文件会在会话结束或主智能体退出后保留。',
};
