/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent collaboration strings (the Agents page, agents' live runs in a chat
 * session, the @ picker's agent entries). Kept out of the main dictionary like Live
 * Voice's: an exported transcript never renders these surfaces, so
 * `vite.lib.config.ts` resolves this module to `messages.transcript-stub.ts`
 * in `--mode transcript` and the transcript bundle stays within its budget.
 */
type CollabMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const COLLAB_MESSAGES_EN: Record<string, CollabMessage> = {
  'toolName.thread_post': 'ThreadPost',
  'toolName.thread_wait': 'ThreadWait',
  'toolName.thread_block': 'ThreadBlock',
  'toolName.thread_review': 'ThreadReview',
  'toolName.thread_create': 'ThreadCreate',
  'toolName.thread_read': 'ThreadRead',
  'agents.description':
    'Manage reusable agent definitions for tasks, Agent Teams, and @-mention collaboration in chat.',
  'collab.elapsed.seconds': (v) => `${v?.count ?? 0}s`,
  'collab.elapsed.minutes': (v) => `${v?.minutes ?? 0}m ${v?.seconds ?? 0}s`,
  'collab.run.queued': (v) =>
    `${v?.agent} is queued and starts when it is free`,
  'collab.run.queuedBehind': (v) => `${v?.agent} is queued, ${v?.count} ahead`,
  'collab.run.stopping': (v) => `Stopping ${v?.agent}…`,
  'collab.run.stalled': (v) =>
    `${v?.agent} has shown no progress for ${v?.elapsed}. It may be stuck.`,
  'collab.run.stop': 'Stop',
  'collab.run.retry': 'Retry',
  'collab.run.retrying': 'Retrying…',
  'collab.run.dismiss': 'Dismiss',
  'collab.run.pendingRecord':
    'This reply will appear in the chat when the current reply finishes.',
  // --- session agents (chat) ---
  'collab.session.working': (v) => `${v?.agent} is working…`,
  'collab.session.thinking': (v) => `${v?.agent} is thinking…`,
  'collab.session.awaitingApproval': (v) =>
    `${v?.agent} is waiting for your approval`,
  'collab.session.offline': (v) => `${v?.agent}'s runtime is offline`,
  'collab.session.cancelled': (v) => `${v?.agent} was stopped`,
  'collab.session.stopAll': 'Stop all agents',
  // --- squads ---
  'collab.squad.new': 'New squad',
  'collab.squad.empty': 'No squads yet.',
  'collab.squad.name': 'Name',
  'collab.squad.nameHint': 'Called as @name in chats',
  'collab.squad.calledAs': (v) => `Called as @${v?.name} in chats`,
  'collab.squad.description': 'Description (optional)',
  'collab.squad.instructions': 'Instructions for the leader (optional)',
  'collab.squad.leader': 'Leader',
  'collab.squad.leads': 'leads',
  'collab.squad.leaderPick': 'Choose a leader',
  'collab.squad.members': 'Members',
  'collab.squad.role': 'Role (optional)',
  'collab.squad.save': 'Save squad',
  'collab.squad.edit': 'Edit',
  'collab.squad.retire': 'Retire',
  'collab.squad.retireConfirm': (v) =>
    `Retire squad "${v?.name}"? It keeps its history and takes no new work.`,
  'collab.squad.retired': 'Retired',
  'collab.squad.needsLeader': 'Needs a new leader',
  'collab.squad.leaderPaused': 'Leader is paused',
  'collab.squad.summary': (v) => `Leader ${v?.leader} · ${v?.count} member(s)`,
  'collab.squad.engagement': (v) => `Squad ${v?.squad}`,
  'collab.squad.memberWorking': 'working',
  'collab.squad.memberReplied': 'replied',
  'collab.squad.leaderDeciding': 'deciding',
  'collab.mention.squad': 'Squad',
  // --- end squads ---
  'collab.mention.noSession':
    'Could not start a session for this message. Try again.',
  // --- end session agents (chat) ---
  'collab.runtime.addTitle': 'Add a runtime',
  'collab.runtime.addDescription':
    'Let another computer run Qwen Code agents for this workspace.',
  'collab.runtime.replaceTitle': (v) => `Replace ${v?.name}`,
  'collab.runtime.replaceDescription': (v) =>
    `Replace ${v?.name} with a new host using a one-time join command.`,
  'collab.runtime.replaceEffects':
    'After the new host registers, the old credentials are revoked and agent bindings move to the new host. Running or cancelling tasks on the old host fail; results already being finalized are preserved.',
  'collab.runtime.replaceRecovery': (v) =>
    `Resuming replacement of ${v?.name} (${v?.id}). Link expiry does not cancel the pending replacement or undo migrated bindings. If the command expires, create a fresh command here and run it on the replacement machine.`,
  'collab.runtime.refreshReplacement': 'Refresh replacement command',
  'collab.runtime.methodCommand': 'Run one command there',
  'collab.runtime.methodExisting': 'I have its address and token',
  'collab.runtime.address':
    'This computer’s address, as the other computer sees it',
  'collab.runtime.addressHint':
    'The other computer connects out to this address, so it only has to be reachable from there.',
  'collab.runtime.loopbackHint':
    'localhost only works on this computer. Use its network address (for example http://192.168.1.8:4170) so the other computer can reach it.',
  'collab.runtime.generate': 'Create join command',
  'collab.runtime.runThis':
    'On the other computer, run this in the project folder:',
  'collab.runtime.noQwen': 'Qwen Code not installed there? This works too:',
  'collab.runtime.copy': 'Copy',
  'collab.runtime.copied': 'Copied',
  'collab.runtime.expires': (v) =>
    `The link works once and expires in ${v?.minutes ?? 0} min.`,
  'collab.runtime.httpHint':
    'It uses plain HTTP, so only use it on a network you trust.',
  'collab.runtime.waiting': 'Waiting for it to connect…',
  'collab.runtime.waitingFor': (v) =>
    `${v?.seconds ?? 0}s so far. This updates by itself when it connects.`,
  'collab.runtime.closeKeepLink': 'Close (the link keeps working)',
  'collab.runtime.connected': (v) => `${v?.name} is connected`,
  'collab.runtime.replaced': (v) => `${v?.oldName} was replaced by ${v?.name}`,
  'collab.runtime.replaceCompleted':
    'The old credentials were revoked and agent bindings were migrated. Old active runs were settled; results already being finalized were preserved.',
  'collab.runtime.offers': (v) => `Offers ${v?.programs}`,
  'collab.runtime.done': 'Done',
  'collab.runtime.createAgentOn': (v) => `Create an agent on ${v?.name}`,
  'collab.runtime.remoteUrl': 'Its Qwen Code address',
  'collab.runtime.remoteToken': 'Its access token',
  'collab.runtime.remoteCwd': 'Project folder on that computer',
  'collab.runtime.program': 'Program',
  'collab.runtime.allowHttp':
    'Allow plain HTTP (trusted networks only; token and tasks are unencrypted)',
  'collab.runtime.connect': 'Connect',
  'collab.share.title': (v) => `Share ${v?.name}`,
  'collab.share.description':
    'Anyone with the token can send this agent work over A2A. It runs wherever it is currently assigned, in that runtime’s workspace, with its current instructions and tools. Later changes — including moving it between this computer and a joined runtime — apply to shares already issued.',
  'collab.share.copy': 'Copy',
  'collab.share.copied': 'Copied',
  'collab.share.done': 'Done',
  'collab.share.create': 'Create link',
  'collab.share.endpoint': 'A2A endpoint',
  'collab.share.token': 'Token',
  'collab.share.try': 'Try it',
  'collab.share.once': 'The token is shown only now; revoke it here any time.',
  'collab.share.onceUntil': (v) =>
    `The token is shown only now. It expires on ${v?.date}; revoke it here any time.`,
  'collab.share.loopback':
    'This address only works on this computer. Open Web Shell through an address the caller can reach, then create the share.',
  'collab.share.active': (v) => `Active shares (${v?.count ?? 0})`,
  'collab.share.until': (v) => `until ${v?.date}`,
  'collab.share.revoke': 'Revoke',
  'collab.agent.share': 'Share',
  'collab.tabs.agents': 'Agents',
  'collab.tabs.squads': 'Squads',
  'collab.tabs.runtime': 'Runtimes',
  'collab.tabs.agentsHint':
    'Agents are teammates you create. Each runs on a runtime with one program. @ an agent in any conversation to bring it in; it can bring in others.',
  'collab.tabs.runtimeHint':
    'Runtimes are the computers agents run on: this one, and any that joined with a link.',
  'collab.tabs.squadsHint':
    'A squad is a leader and the agents it hands work to. @ the squad in any chat and the leader splits the work and reports back.',
  'collab.agent.new': 'New agent',
  'collab.agent.roles': 'Role templates',
  'collab.agent.mentionIt': 'Mention in chat',
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
  'collab.agent.runsOn': 'Runs on',
  'collab.agent.thisComputer': 'This computer',
  'collab.agent.cwdUnknown': 'Folder not reported yet',
  'collab.agent.hostPersona':
    'Remote agents use the runtime’s model and your instructions here. Local role and model overrides are unavailable.',
  'collab.agent.runsOnHint':
    'A joined runtime works in its own folder, shown under its name. Files here are not copied to it.',
  'collab.agent.programLocal': 'Runs only on a joined runtime',
  'collab.agent.programMissing': 'Not found on this runtime',
  'collab.error.dispatchAfterSave': (v) =>
    `The change was saved, but background processing failed: ${v?.error}`,
  'collab.agent.afterCreate':
    'It starts working when you mention it in a conversation.',
  'collab.noWorkspace': 'Open a workspace to work with agents.',
  'collab.agent.empty':
    'No agents yet. Create one, then @ it in any conversation.',
  'collab.runtime.localNote':
    'This computer. Its agents run in this workspace with Qwen Code.',
  'collab.runtime.remoteNote':
    'Another computer that joined this workspace. Agents assigned to it run there.',
  'collab.runtime.programs': 'Programs',
  'collab.runtime.empty': 'No runtime yet.',
  'collab.runtime.emptyHint':
    'Add a runtime to let another computer run agents, then create an agent on it.',
  'collab.runtime.badAddress': 'Enter an address like http://192.168.1.8:4170.',
  'collab.run.failed': (v) => `${v?.agent} stopped with an error`,
  'collab.run.steps': (v) => `Steps by ${v?.agent}`,
  'collab.mention.provider': 'Agents',
  'collab.mention.newAgent': 'New agent…',
  'collab.mention.noAttachments':
    'Attachments cannot be sent to an agent yet. Send text to start.',
  'collab.agentStatus.idle': 'Idle',
  'collab.agentStatus.working': 'Working',
  'collab.agentStatus.offline': 'Runtime offline',
  'collab.agentStatus.error': 'Needs attention',
  'collab.agentStatus.paused': 'Paused',
  'collab.agentStatus.retired': 'Retired',
  'collab.sharedThreads': 'Agent collaboration',
  'collab.approval.title': (v) => `${v?.agent} wants to run a tool`,
  'collab.agent.waiting': (v) => `${v?.count} waiting`,
  'collab.form.cancel': 'Cancel',
  'collab.config.description': 'Role',
  'collab.config.descriptionHint':
    'For example: review code and report problems to the lead',
  'collab.config.instructions': 'Instructions',
  'collab.config.instructionsHint':
    'How to work and what to deliver. Instructions cannot widen tool access.',
  'collab.config.agentType': 'Role template',
  'collab.config.workspaceDefault': 'Workspace default',
  'collab.config.model': 'Model',
  'collab.config.maxRuns': 'Conversations at once',
  'collab.config.note':
    "Leave a field empty to use the role template's default.",
  'collab.config.save': 'Save',
  'collab.agentStatus.online': 'Online',
  'collab.config.runtimes': 'Runs on',
  'collab.config.runtimesHint':
    'With no machine selected, this computer runs it.',
  'collab.runtime.folder': 'Working folder',
  'collab.runtime.agents': 'Agents',
  'collab.runtime.running': 'Running',
  'collab.runtime.queued': 'Queued',
  'collab.runtime.technical': 'Technical details',
  'collab.runtime.id': (v) => `Runtime ID: ${v?.id}`,
  'collab.runtime.sessions': (v) => `Sessions: ${v?.count}`,
  'collab.runtime.lastSeen': (v) => `Last heartbeat: ${v?.time}`,
  'collab.runtime.replace': 'Replace Host',
  'collab.runtime.remove': 'Remove',
  'collab.runtime.removeConfirm': (v) =>
    `Remove “${v?.name}”? Agents assigned only to it will move to this computer, and its active runs will stop.`,
  // --- runtime join (agents page) ---
  'collab.runtime.methodJoin': 'Join a coordinator',
  'collab.runtime.joinDescription':
    'Make this computer a runtime of another Qwen Code: paste the join link and token shown there under Runtimes › Add runtime.',
  'collab.runtime.joinLink': 'Join link',
  'collab.runtime.joinToken': 'Join token',
  'collab.runtime.joinBadLink':
    'That is not a join link. It looks like https://host:4170/join/<workspace>.',
  'collab.runtime.joinConnected': (v) =>
    `This computer joined ${v?.server} as a runtime.`,
  'collab.runtime.joinCli': 'Or from a terminal on this computer:',
};

export const COLLAB_MESSAGES_ZH: Record<string, CollabMessage> = {
  'toolName.thread_post': '发帖到线程',
  'toolName.thread_wait': '等待协作方',
  'toolName.thread_block': '提出阻塞问题',
  'toolName.thread_review': '提交待评审',
  'toolName.thread_create': '创建子线程',
  'toolName.thread_read': '读取线程',
  'agents.description':
    '管理可复用的智能体定义，用于任务执行、Agent Team 或在对话中 @ 协作。',
  'collab.elapsed.seconds': (v) => `${v?.count ?? 0} 秒`,
  'collab.elapsed.minutes': (v) =>
    `${v?.minutes ?? 0} 分 ${v?.seconds ?? 0} 秒`,
  'collab.run.queued': (v) => `${v?.agent} 排队中，空出来就开始`,
  'collab.run.queuedBehind': (v) =>
    `${v?.agent} 排队中，前面还有 ${v?.count} 个`,
  'collab.run.stopping': (v) => `正在停止 ${v?.agent}…`,
  'collab.run.stalled': (v) =>
    `${v?.agent} 已经 ${v?.elapsed} 没有进展，可能卡住了`,
  'collab.run.stop': '停止',
  'collab.run.retry': '重试',
  'collab.run.retrying': '正在重试…',
  'collab.run.dismiss': '忽略',
  'collab.run.pendingRecord': '当前回复结束后，这条回复会出现在对话中。',
  // --- session agents (chat) ---
  'collab.session.working': (v) => `${v?.agent} 正在工作…`,
  'collab.session.thinking': (v) => `${v?.agent} 正在思考…`,
  'collab.session.awaitingApproval': (v) => `${v?.agent} 在等你批准`,
  'collab.session.offline': (v) => `${v?.agent} 所在的 Runtime 离线了`,
  'collab.session.cancelled': (v) => `${v?.agent} 已停止`,
  'collab.session.stopAll': '停止全部 Agent',
  // --- squads ---
  'collab.squad.new': '新建小队',
  'collab.squad.empty': '还没有小队。',
  'collab.squad.name': '名字',
  'collab.squad.nameHint': '在对话里用 @名字 调用',
  'collab.squad.calledAs': (v) => `在对话里用 @${v?.name} 调用`,
  'collab.squad.description': '说明（可选）',
  'collab.squad.instructions': '给负责人的指令（可选）',
  'collab.squad.leader': '负责人',
  'collab.squad.leads': '牵头',
  'collab.squad.leaderPick': '选择负责人',
  'collab.squad.members': '成员',
  'collab.squad.role': '角色（可选）',
  'collab.squad.save': '保存小队',
  'collab.squad.edit': '编辑',
  'collab.squad.retire': '退役',
  'collab.squad.retireConfirm': (v) =>
    `确定退役小队“${v?.name}”吗？它保留历史记录，不再接新的工作。`,
  'collab.squad.retired': '已退役',
  'collab.squad.needsLeader': '需要新的负责人',
  'collab.squad.leaderPaused': '负责人已停用',
  'collab.squad.summary': (v) => `负责人 ${v?.leader} · ${v?.count} 名成员`,
  'collab.squad.engagement': (v) => `小队 ${v?.squad}`,
  'collab.squad.memberWorking': '进行中',
  'collab.squad.memberReplied': '已回复',
  'collab.squad.leaderDeciding': '决定中',
  'collab.mention.squad': '小队',
  // --- end squads ---
  'collab.mention.noSession': '没能为这条消息创建会话，请重试。',
  // --- end session agents (chat) ---
  'collab.runtime.addTitle': '添加 Runtime',
  'collab.runtime.addDescription':
    '让另一台电脑为这个工作区运行 Qwen Code Agent。',
  'collab.runtime.replaceTitle': (v) => `替换 ${v?.name}`,
  'collab.runtime.replaceDescription': (v) =>
    `使用一次性加入命令，用新主机替换 ${v?.name}。`,
  'collab.runtime.replaceEffects':
    '新主机注册后，旧凭据被撤销，Agent 绑定迁移到新主机。旧主机上正在运行或取消的任务会失败；已进入完成结算的结果会保留。',
  'collab.runtime.replaceRecovery': (v) =>
    `正在恢复对 ${v?.name}（${v?.id}）的替换。链接过期不会取消待完成的替换，也不会回滚已迁移的绑定。命令过期后，在这里生成新命令，再到替换主机上运行。`,
  'collab.runtime.refreshReplacement': '刷新替换命令',
  'collab.runtime.methodCommand': '在那台电脑上运行一行命令',
  'collab.runtime.methodExisting': '我已有地址和令牌',
  'collab.runtime.address': '这台电脑的地址（从那台电脑看过来）',
  'collab.runtime.addressHint':
    '那台电脑会主动连到这个地址，只要从那边能访问到就行。',
  'collab.runtime.loopbackHint':
    'localhost 只在这台电脑上有效。请换成它的局域网地址（例如 http://192.168.1.8:4170），另一台电脑才能连上。',
  'collab.runtime.generate': '生成加入命令',
  'collab.runtime.runThis': '在那台电脑的项目目录里运行：',
  'collab.runtime.noQwen': '那台电脑没装 Qwen Code？用这条也行：',
  'collab.runtime.copy': '复制',
  'collab.runtime.copied': '已复制',
  'collab.runtime.expires': (v) =>
    `链接只能用一次，${v?.minutes ?? 0} 分钟后失效。`,
  'collab.runtime.httpHint': '使用的是 HTTP 明文，只在可信网络里用。',
  'collab.runtime.waiting': '正在等待连接…',
  'collab.runtime.waitingFor': (v) =>
    `已等待 ${v?.seconds ?? 0} 秒。连上后这里会自动更新。`,
  'collab.runtime.closeKeepLink': '关闭（链接仍然有效）',
  'collab.runtime.connected': (v) => `${v?.name} 已连接`,
  'collab.runtime.replaced': (v) => `${v?.oldName} 已由 ${v?.name} 替换`,
  'collab.runtime.replaceCompleted':
    '旧主机凭据已撤销，Agent 绑定已迁移。旧的活动任务已结算，已进入完成结算的结果已保留。',
  'collab.runtime.offers': (v) => `提供 ${v?.programs}`,
  'collab.runtime.done': '完成',
  'collab.runtime.createAgentOn': (v) => `在 ${v?.name} 上新建 Agent`,
  'collab.runtime.remoteUrl': '它的 Qwen Code 地址',
  'collab.runtime.remoteToken': '它的访问令牌',
  'collab.runtime.remoteCwd': '那台电脑上的项目目录',
  'collab.runtime.program': '执行程序',
  'collab.runtime.allowHttp': '允许 HTTP 明文（仅可信网络，令牌和任务不加密）',
  'collab.runtime.connect': '连接',
  'collab.share.title': (v) => `分享 ${v?.name}`,
  'collab.share.description':
    '拿到令牌的人可以通过 A2A 给这个 Agent 派活。任务会在 Agent 当前分配的 Runtime 及其工作区中执行，并使用当前的指令和工具。之后的修改（包括在本机与已加入的 Runtime 之间迁移）也会作用于已发出的分享。',
  'collab.share.copy': '复制',
  'collab.share.copied': '已复制',
  'collab.share.done': '完成',
  'collab.share.create': '生成分享',
  'collab.share.endpoint': 'A2A 地址',
  'collab.share.token': '令牌',
  'collab.share.try': '试一下',
  'collab.share.once': '令牌只显示这一次，随时可以在这里撤销。',
  'collab.share.onceUntil': (v) =>
    `令牌只显示这一次，${v?.date} 失效，随时可以在这里撤销。`,
  'collab.share.loopback':
    '这个地址只在本机可用。请用别人能访问到的地址打开 Web Shell，再生成分享。',
  'collab.share.active': (v) => `已分享（${v?.count ?? 0}）`,
  'collab.share.until': (v) => `有效至 ${v?.date}`,
  'collab.share.revoke': '撤销',
  'collab.agent.share': '分享',
  'collab.tabs.agents': 'Agent',
  'collab.tabs.squads': '小队',
  'collab.tabs.runtime': 'Runtime',
  'collab.tabs.agentsHint':
    'Agent 是你新建的队友，每个都跑在某个 Runtime 上、用一个程序。在任何对话里 @ 它就能叫它来，它也能再叫别的 Agent。',
  'collab.tabs.runtimeHint':
    'Runtime 是运行 Agent 的电脑：这台电脑，以及用链接加入的其他电脑。',
  'collab.tabs.squadsHint':
    '小队由一个负责人和它分派工作的成员组成。在任意对话里 @ 小队，负责人拆分工作并汇报结果。',
  'collab.agent.new': '新建 Agent',
  'collab.agent.roles': '角色模板',
  'collab.agent.mentionIt': '在对话中 @',
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
  'collab.agent.runsOn': '运行在',
  'collab.agent.thisComputer': '这台电脑',
  'collab.agent.cwdUnknown': '尚未上报目录',
  'collab.agent.hostPersona':
    '远程 Agent 使用执行环境的模型和此处填写的指令，不支持本地角色与模型覆盖。',
  'collab.agent.runsOnHint':
    '加入的 Runtime 在它自己的目录里工作（显示在名字下方），这里的文件不会复制过去。',
  'collab.agent.programLocal': '只能在加入的 Runtime 上运行',
  'collab.agent.programMissing': '这个 Runtime 上没有检测到',
  'collab.error.dispatchAfterSave': (v) =>
    `更改已保存，但后台处理失败：${v?.error}`,
  'collab.agent.afterCreate': '在对话里 @ 它，它就开始工作。',
  'collab.noWorkspace': '先打开一个工作区，才能和 Agent 协作。',
  'collab.agent.empty': '还没有 Agent。新建一个，然后在任意对话里 @ 它。',
  'collab.runtime.localNote':
    '这台电脑。它上面的 Agent 用 Qwen Code 在这个工作区里运行。',
  'collab.runtime.remoteNote':
    '加入了这个工作区的另一台电脑。分配给它的 Agent 在那边运行。',
  'collab.runtime.programs': '程序',
  'collab.runtime.empty': '还没有 Runtime。',
  'collab.runtime.emptyHint':
    '添加一个 Runtime，让另一台电脑运行 Agent，再在它上面新建 Agent。',
  'collab.runtime.badAddress': '请填写类似 http://192.168.1.8:4170 的地址。',
  'collab.run.failed': (v) => `${v?.agent} 出错停止了`,
  'collab.run.steps': (v) => `${v?.agent} 的步骤`,
  'collab.mention.provider': 'Agent',
  'collab.mention.newAgent': '新建 Agent…',
  'collab.mention.noAttachments': '暂时不能把附件发给 Agent，请先用文字发起。',
  'collab.agentStatus.idle': '空闲',
  'collab.agentStatus.working': '正在工作',
  'collab.agentStatus.offline': 'Runtime 离线',
  'collab.agentStatus.error': '需要处理',
  'collab.agentStatus.paused': '已停用',
  'collab.agentStatus.retired': '已退役',
  'collab.sharedThreads': 'Agent 协作',
  'collab.approval.title': (v) => `${v?.agent} 想运行一个工具`,
  'collab.agent.waiting': (v) => `${v?.count} 项等待中`,
  'collab.form.cancel': '取消',
  'collab.config.description': '职责描述',
  'collab.config.descriptionHint': '例如：检查代码并向负责人汇报问题',
  'collab.config.instructions': '工作指令',
  'collab.config.instructionsHint':
    '说明工作方式和输出要求；指令不能扩大工具权限',
  'collab.config.agentType': '角色模板',
  'collab.config.workspaceDefault': '使用工作区默认配置',
  'collab.config.model': '模型',
  'collab.config.maxRuns': '同时处理的对话数',
  'collab.config.note': '清空字段后使用角色模板的默认配置。',
  'collab.config.save': '保存配置',
  'collab.agentStatus.online': '在线',
  'collab.config.runtimes': '执行主机',
  'collab.config.runtimesHint': '不选择外部主机时，由本机执行。',
  'collab.runtime.folder': '工作目录',
  'collab.runtime.agents': '关联 Agent',
  'collab.runtime.running': '执行中',
  'collab.runtime.queued': '排队中',
  'collab.runtime.technical': '技术详情',
  'collab.runtime.id': (v) => `主机标识：${v?.id}`,
  'collab.runtime.sessions': (v) => `会话数：${v?.count}`,
  'collab.runtime.lastSeen': (v) => `最近心跳：${v?.time}`,
  'collab.runtime.replace': '替换主机',
  'collab.runtime.remove': '移除',
  'collab.runtime.removeConfirm': (v) =>
    `确定移除“${v?.name}”吗？只绑定到它的 Agent 会切回这台电脑，正在执行的任务会停止。`,
  // --- runtime join (agents page) ---
  'collab.runtime.methodJoin': '加入协调方',
  'collab.runtime.joinDescription':
    '让这台电脑成为另一个 Qwen Code 的 Runtime：粘贴对方在「Runtime › 添加 Runtime」里给出的加入链接和令牌。',
  'collab.runtime.joinLink': '加入链接',
  'collab.runtime.joinToken': '加入令牌',
  'collab.runtime.joinBadLink':
    '这不是加入链接，格式应为 https://host:4170/join/<workspace>。',
  'collab.runtime.joinConnected': (v) =>
    `这台电脑已作为 Runtime 加入 ${v?.server}。`,
  'collab.runtime.joinCli': '也可以在这台电脑的终端里运行：',
};
