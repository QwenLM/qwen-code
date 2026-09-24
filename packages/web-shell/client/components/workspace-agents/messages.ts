/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent collaboration strings (the Agent page, collaboration conversations,
 * the @ picker's agent entries). Kept out of the main dictionary like Live
 * Voice's: an exported transcript never renders these surfaces, so
 * `vite.lib.config.ts` resolves this module to `messages.transcript-stub.ts`
 * in `--mode transcript` and the transcript bundle stays within its budget.
 */
type CollabMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const COLLAB_MESSAGES_EN: Record<string, CollabMessage> = {
  'collab.sending': 'Sending…',
  'collab.composer.placeholder': 'Reply, or @ an agent to bring it in…',
  'collab.elapsed.seconds': (v) => `${v?.count ?? 0}s`,
  'collab.elapsed.minutes': (v) => `${v?.minutes ?? 0}m ${v?.seconds ?? 0}s`,
  'collab.run.queued': (v) =>
    `${v?.agent} is queued and starts when it is free`,
  'collab.run.queuedBehind': (v) => `${v?.agent} is queued, ${v?.count} ahead`,
  'collab.run.starting': (v) => `Starting ${v?.agent}…`,
  'collab.run.resuming': (v) => `${v?.agent} is resuming its session…`,
  'collab.run.stopping': (v) => `Stopping ${v?.agent}…`,
  'collab.run.thinking': (v) => `${v?.agent} is thinking · ${v?.elapsed}`,
  'collab.run.responding': (v) => `${v?.agent} is replying · ${v?.elapsed}`,
  'collab.run.tool': (v) => `${v?.agent} is running a tool · ${v?.elapsed}`,
  'collab.run.toolNamed': (v) =>
    `${v?.agent} is running ${v?.tool} · ${v?.elapsed}`,
  'collab.run.working': (v) => `${v?.agent} is working · ${v?.elapsed}`,
  'collab.run.streamLost': (v) =>
    `Lost the live view of ${v?.agent}; its result will still appear here`,
  'collab.run.stalled': (v) =>
    `${v?.agent} has shown no progress for ${v?.elapsed}. It may be stuck.`,
  'collab.run.stop': 'Stop',
  'collab.tabs.agents': 'Agents',
  'collab.tabs.tasks': 'Conversations',
  'collab.tabs.agentsHint':
    'Agents are teammates you create. @ an agent in any conversation to bring it in; it can bring in others.',
  'collab.tabs.tasksHint':
    'Conversations where agents are working, grouped by what they need from you.',
  'collab.agent.new': 'New agent',
  'collab.agent.roles': 'Role templates',
  'collab.agent.mentionIt': '@ Mention',
  'collab.agent.more': (v) => `More actions for ${v?.name}`,
  'collab.agent.configure': 'Configure',
  'collab.agent.pause': 'Pause',
  'collab.agent.resume': 'Resume',
  'collab.agent.retire': 'Retire',
  'collab.agent.retireConfirm': (v) =>
    `Retire ${v?.name}? It takes no more work. Its messages stay, and its name stays reserved so no one else can post as it.`,
  'collab.agent.joins': (v) => `Joins the team for ${v?.project}.`,
  'collab.agent.nameHelp':
    'Shown in conversations. Mention it with @name to bring it in.',
  'collab.agent.role': 'Start from a role',
  'collab.agent.roleNone': 'No role',
  'collab.agent.roleHint':
    'A role from .qwen/agents supplies base instructions and tools; what you write below adds to it.',
  'collab.agent.instructions': 'Working instructions (optional)',
  'collab.agent.instructionsHint':
    'What it is responsible for and how it should hand back results.',
  'collab.agent.description':
    'When should other agents bring it in? (optional)',
  'collab.agent.concurrency': 'Conversations at once',
  'collab.agent.concurrencyInvalid':
    'Conversations at once must be between 1 and 8.',
  'collab.agent.afterCreate':
    'It starts working when you mention it in a conversation.',
  'collab.thread.new': 'New conversation',
  'collab.thread.context': 'Context from the conversation this started in',
  'collab.noWorkspace': 'Open a workspace to work with agents.',
  'collab.thread.back': 'Back',
  'collab.thread.loading': 'Loading conversation…',
  'collab.thread.newHint':
    'Say what you need and who should take it. The conversation opens once it is created.',
  'collab.agent.empty':
    'No agents yet. Create one, then @ it in any conversation.',
  'collab.run.keepWaiting': 'Keep waiting',
  'collab.run.timedOut': (v) =>
    `${v?.agent} was stopped after 15 minutes without progress`,
  'collab.run.failed': (v) => `${v?.agent} stopped with an error`,
  'collab.run.retry': 'Retry',
  'collab.run.steps': (v) => `Steps by ${v?.agent}`,
  'collab.step.running': 'Running',
  'collab.step.done': 'Done',
  'collab.step.failed': 'Failed',
  'collab.step.untitled': 'Tool call',
  'collab.run.retryPrompt': 'please continue from where you stopped.',
  'collab.mention.provider': 'Agents',
  'collab.mention.newAgent': 'New agent…',
  'collab.runRow.stage.starting': 'Starting',
  'collab.runRow.stage.resuming': 'Resuming the session',
  'collab.runRow.stage.waiting': 'Waiting for the model',
  'collab.runRow.stage.thinking': 'Thinking',
  'collab.runRow.stage.tool': 'Running a tool',
  'collab.runRow.stage.responding': 'Replying',
  'collab.runRow.stage.awaiting_approval': 'Waiting for your approval',
  'collab.runRow.working': 'Working',
  'collab.runRow.quiet': 'Waiting for new output',
  'collab.runRow.queued': 'Received, waiting to start',
  'collab.runRow.unconfirmed': 'Waiting for the run to start',
  'collab.runRow.cancel': 'Cancel',
  'collab.runRow.elapsed': (v) => `Running for ${v?.seconds}s`,
  'collab.runRow.lastActivity': (v) => `Last activity ${v?.seconds}s ago`,
  'collab.runRow.queuedHint':
    'The model has not started yet. The message stays queued; no need to resend.',
  'collab.runRow.unconfirmedHint':
    'No start signal yet. No need to send it again.',
  'collab.runRow.activity': 'Latest activity',
  'collab.runRow.thinking': 'Thinking',
  'collab.runRow.thinkingCap': 'The thinking preview reached its length limit.',
  'collab.runRow.output': 'Output so far',
  'collab.runRow.outputCap':
    'The live preview reached its length limit; the full reply is in the conversation.',
  'collab.runRow.openSession': (v) => `Open ${v?.agent}'s session`,
  'collab.runRow.stalled': 'Stopped after 15 minutes without progress',
  'collab.preview.nobody': 'This message will not reach any agent.',
  'collab.preview.to': (v) => `Goes to ${v?.names}.`,
  'collab.preview.only': (v) =>
    `Only ${v?.names} will get this. Other members are not interrupted.`,
  'collab.skip.agent_unknown': (v) =>
    `No agent is named ${v?.name}. Check the spelling, or create it.`,
  'collab.skip.agent_disabled': (v) =>
    `${v?.name} is paused. Resume it on the Agents page.`,
  'collab.skip.agent_retired': (v) =>
    `${v?.name} is retired. Hand this to another agent.`,
  'collab.skip.no_target':
    'This reaches nobody. Mention an agent to send it to them.',
  'collab.skip.queue_full': (v) =>
    `${v?.name} has a full backlog. Wait, or ask another agent.`,
  'collab.skip.turn_budget_exhausted':
    'The agents have used their unattended turns. Your reply lets them continue.',
  'collab.skip.token_budget_exhausted':
    'This conversation has used its token budget, so agents no longer wake each other. A reply from you can still wake them.',
  'collab.skip.thread_done':
    'This conversation is done. Start a new one to continue.',
  'collab.skip.self_trigger': (v) => `${v?.name} cannot wake itself.`,
  'collab.skip.other': (v) => `${v?.name} will not be woken.`,
  'collab.mention.noAttachments':
    'Attachments cannot be sent to an agent yet. Send text to start.',
  'collab.agentStatus.idle': 'Idle',
  'collab.agentStatus.working': 'Working',
  'collab.agentStatus.blocked': 'Waiting for you',
  'collab.agentStatus.offline': 'Runtime offline',
  'collab.agentStatus.error': 'Needs attention',
  'collab.agentStatus.paused': 'Paused',
  'collab.agentStatus.retired': 'Retired',
  'collab.team.title': 'Team',
  'collab.team.members': (v) => `Members (${v?.count ?? 0})`,
  'collab.team.empty': 'No agent has joined yet.',
  'collab.team.lead': 'lead',
  'collab.team.live': 'Working now',
  'collab.team.tasks': (v) => `Subtasks (${v?.count ?? 0})`,
  'collab.team.parent': (v) => `Parent task: ${v?.title}`,
  'collab.team.history': (v) => `Past runs (${v?.count ?? 0})`,
  'collab.member.idle': 'Idle',
  'collab.member.queued': 'Queued',
  'collab.member.starting': 'Starting',
  'collab.member.thinking': 'Thinking',
  'collab.member.responding': 'Replying',
  'collab.member.tool': (v) => `Running ${v?.tool}`,
  'collab.member.approval': 'Waiting for your approval',
  'collab.member.stalled': 'May be stuck',
  'collab.member.timedOut': 'Stopped: no progress for 15 minutes',
  'collab.member.failed': 'Failed',
  'collab.member.done': 'Done',
  'collab.markDone': 'Accept and mark done',
  'collab.details': 'Task details',
  'collab.approval.title': (v) => `${v?.agent} wants to run a tool`,
};

export const COLLAB_MESSAGES_ZH: Record<string, CollabMessage> = {
  'collab.sending': '正在发送…',
  'collab.composer.placeholder': '回复，或 @ 一个 Agent 让它加入…',
  'collab.elapsed.seconds': (v) => `${v?.count ?? 0} 秒`,
  'collab.elapsed.minutes': (v) =>
    `${v?.minutes ?? 0} 分 ${v?.seconds ?? 0} 秒`,
  'collab.run.queued': (v) => `${v?.agent} 排队中，空出来就开始`,
  'collab.run.queuedBehind': (v) =>
    `${v?.agent} 排队中，前面还有 ${v?.count} 个`,
  'collab.run.starting': (v) => `正在唤起 ${v?.agent}…`,
  'collab.run.resuming': (v) => `${v?.agent} 正在继续原会话…`,
  'collab.run.stopping': (v) => `正在停止 ${v?.agent}…`,
  'collab.run.thinking': (v) => `${v?.agent} 正在思考，${v?.elapsed}`,
  'collab.run.responding': (v) => `${v?.agent} 正在回复，${v?.elapsed}`,
  'collab.run.tool': (v) => `${v?.agent} 正在运行工具，${v?.elapsed}`,
  'collab.run.toolNamed': (v) =>
    `${v?.agent} 正在运行 ${v?.tool}，${v?.elapsed}`,
  'collab.run.working': (v) => `${v?.agent} 正在工作，${v?.elapsed}`,
  'collab.run.streamLost': (v) =>
    `${v?.agent} 的实时输出中断了，结果出来后仍会显示在这里`,
  'collab.run.stalled': (v) =>
    `${v?.agent} 已经 ${v?.elapsed} 没有进展，可能卡住了`,
  'collab.run.stop': '停止',
  'collab.tabs.agents': 'Agent',
  'collab.tabs.tasks': '协作对话',
  'collab.tabs.agentsHint':
    'Agent 是你新建的队友。在任何对话里 @ 它就能叫它来，它也能再叫别的 Agent。',
  'collab.tabs.tasksHint': 'Agent 正在工作的对话，按需要你做什么来分组。',
  'collab.agent.new': '新建 Agent',
  'collab.agent.roles': '角色模板',
  'collab.agent.mentionIt': '@ 它',
  'collab.agent.more': (v) => `${v?.name} 的更多操作`,
  'collab.agent.configure': '配置',
  'collab.agent.pause': '停用',
  'collab.agent.resume': '启用',
  'collab.agent.retire': '退役',
  'collab.agent.retireConfirm': (v) =>
    `退役 ${v?.name}？它不会再接任务。已有消息保留，名字也会保留，别人不能冒用。`,
  'collab.agent.joins': (v) => `加入 ${v?.project} 的团队。`,
  'collab.agent.nameHelp': '显示在对话里，用 @名字 把它叫进来。',
  'collab.agent.role': '从角色开始',
  'collab.agent.roleNone': '不使用角色',
  'collab.agent.roleHint':
    '.qwen/agents 里的角色提供基础指令和工具，下面写的内容在它之上补充。',
  'collab.agent.instructions': '工作说明（可选）',
  'collab.agent.instructionsHint': '它负责什么，结果怎么交回来。',
  'collab.agent.description': '其他 Agent 什么时候该找它（可选）',
  'collab.agent.concurrency': '同时处理的对话数',
  'collab.agent.concurrencyInvalid': '同时处理的对话数必须在 1 到 8 之间。',
  'collab.agent.afterCreate': '在对话里 @ 它，它就开始工作。',
  'collab.thread.new': '新建协作对话',
  'collab.thread.context': '来自原对话的上下文',
  'collab.noWorkspace': '先打开一个工作区，才能和 Agent 协作。',
  'collab.thread.back': '返回',
  'collab.thread.loading': '正在加载对话…',
  'collab.thread.newHint': '写下要做什么、交给谁。创建后会打开这个对话。',
  'collab.agent.empty': '还没有 Agent。新建一个，然后在任意对话里 @ 它。',
  'collab.run.keepWaiting': '再等等',
  'collab.run.timedOut': (v) => `${v?.agent} 15 分钟没有进展，已停止`,
  'collab.run.failed': (v) => `${v?.agent} 出错停止了`,
  'collab.run.retry': '重试',
  'collab.run.steps': (v) => `${v?.agent} 的步骤`,
  'collab.step.running': '进行中',
  'collab.step.done': '已完成',
  'collab.step.failed': '失败',
  'collab.step.untitled': '工具调用',
  'collab.run.retryPrompt': '请从中断的地方继续。',
  'collab.mention.provider': 'Agent',
  'collab.mention.newAgent': '新建 Agent…',
  'collab.runRow.stage.starting': '正在启动',
  'collab.runRow.stage.resuming': '继续会话中',
  'collab.runRow.stage.waiting': '等待模型',
  'collab.runRow.stage.thinking': '思考中',
  'collab.runRow.stage.tool': '调用工具中',
  'collab.runRow.stage.responding': '正在回复',
  'collab.runRow.stage.awaiting_approval': '等你批准',
  'collab.runRow.working': '执行中',
  'collab.runRow.quiet': '等待新输出',
  'collab.runRow.queued': '消息已接收，排队等待启动',
  'collab.runRow.unconfirmed': '等待开始运行',
  'collab.runRow.cancel': '取消',
  'collab.runRow.elapsed': (v) => `已运行 ${v?.seconds} 秒`,
  'collab.runRow.lastActivity': (v) => `最近活动：${v?.seconds} 秒前`,
  'collab.runRow.queuedHint': '模型还没启动，消息保留在队列里，无需重发。',
  'collab.runRow.unconfirmedHint': '还没收到启动信号，无需重复发送。',
  'collab.runRow.activity': '最近执行活动',
  'collab.runRow.thinking': '思考过程',
  'collab.runRow.thinkingCap': '思考预览已达长度上限。',
  'collab.runRow.output': '执行输出（含中间回复）',
  'collab.runRow.outputCap': '实时预览已达长度上限；完整回复见对话正文。',
  'collab.runRow.openSession': (v) => `打开 ${v?.agent} 的会话`,
  'collab.runRow.stalled': '15 分钟没有进展，已停止',
  'collab.preview.nobody': '这条消息不会发给任何 Agent。',
  'collab.preview.to': (v) => `发给 ${v?.names}。`,
  'collab.preview.only': (v) => `只发给 ${v?.names}，其他成员不会被打断。`,
  'collab.skip.agent_unknown': (v) =>
    `没有名为 ${v?.name} 的 Agent。检查拼写，或者先新建它。`,
  'collab.skip.agent_disabled': (v) =>
    `${v?.name} 已停用。在 Agent 页启用后才能接任务。`,
  'collab.skip.agent_retired': (v) => `${v?.name} 已退役，请交给别的 Agent。`,
  'collab.skip.no_target': '这条消息没有发给任何人。@ 一个 Agent 就能发给它。',
  'collab.skip.queue_full': (v) =>
    `${v?.name} 手上的任务已满。稍等，或者交给别的 Agent。`,
  'collab.skip.turn_budget_exhausted':
    'Agent 已用完无人值守的轮数。你回复一句，它们就能继续。',
  'collab.skip.token_budget_exhausted':
    '这个对话的 token 预算已用完，Agent 之间不再互相唤醒。你自己的回复仍然可以唤醒它们。',
  'collab.skip.thread_done': '这个对话已经结束，请新开一个继续。',
  'collab.skip.self_trigger': (v) => `${v?.name} 不能唤醒自己。`,
  'collab.skip.other': (v) => `${v?.name} 这次不会被唤醒。`,
  'collab.mention.noAttachments': '暂时不能把附件发给 Agent，请先用文字发起。',
  'collab.agentStatus.idle': '空闲',
  'collab.agentStatus.working': '正在工作',
  'collab.agentStatus.blocked': '等你处理',
  'collab.agentStatus.offline': 'Runtime 离线',
  'collab.agentStatus.error': '需要处理',
  'collab.agentStatus.paused': '已停用',
  'collab.agentStatus.retired': '已退役',
  'collab.team.title': '团队',
  'collab.team.members': (v) => `成员（${v?.count ?? 0}）`,
  'collab.team.empty': '还没有 Agent 加入。',
  'collab.team.lead': '负责人',
  'collab.team.live': '正在进行',
  'collab.team.tasks': (v) => `子任务（${v?.count ?? 0}）`,
  'collab.team.parent': (v) => `父任务：${v?.title}`,
  'collab.team.history': (v) => `历史运行（${v?.count ?? 0}）`,
  'collab.member.idle': '空闲',
  'collab.member.queued': '排队中',
  'collab.member.starting': '正在唤起',
  'collab.member.thinking': '正在思考',
  'collab.member.responding': '正在回复',
  'collab.member.tool': (v) => `正在运行 ${v?.tool}`,
  'collab.member.approval': '等你批准',
  'collab.member.stalled': '可能卡住了',
  'collab.member.timedOut': '已停止：15 分钟没有进展',
  'collab.member.failed': '失败',
  'collab.member.done': '已完成',
  'collab.markDone': '验收并完成',
  'collab.details': '任务详情',
  'collab.approval.title': (v) => `${v?.agent} 想运行一个工具`,
};
