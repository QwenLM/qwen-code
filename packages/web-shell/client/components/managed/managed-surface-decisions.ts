export type ManagedSurfaceCategory =
  | 'configuration'
  | 'knowledge'
  | 'conversation'
  | 'files'
  | 'runtime';

export interface ManagedSurfaceDecision {
  id: string;
  category: ManagedSurfaceCategory;
  issue: 13396 | 15084 | 16546;
  label: readonly [string, string];
  reason: readonly [string, string];
}

export const MANAGED_SURFACE_CATEGORY_LABELS: Record<
  ManagedSurfaceCategory,
  readonly [string, string, string, string]
> = {
  configuration: [
    'Configuration and workspace identity',
    '配置与工作区身份',
    '組態與工作區身分識別',
    'Конфигурация и идентичность рабочей области',
  ],
  knowledge: [
    'Knowledge, Skills and extensions',
    '知识、Skills 与扩展',
    '知識、Skills 與擴充功能',
    'Знания, Skills и расширения',
  ],
  conversation: [
    'Conversation editing',
    '会话编辑',
    '對話編輯',
    'Редактирование диалога',
  ],
  files: [
    'Files, artifacts and sources',
    '文件、产物与来源',
    '檔案、成品與來源',
    'Файлы, артефакты и источники',
  ],
  runtime: [
    'Runtime and tooling',
    '运行时与工具',
    '執行階段與工具',
    'Среда выполнения и инструменты',
  ],
};

export const MANAGED_SURFACE_DECISIONS: readonly ManagedSurfaceDecision[] = [
  {
    id: 'settings',
    category: 'configuration',
    issue: 15084,
    label: ['Settings panel', '设置面板'],
    reason: [
      'Managed has no Session settings surface. The full-shell Settings panel configures the local daemon, not the Managed Session.',
      'Managed 没有会话设置界面。完整 Shell 的设置面板配置本地 daemon，而不是 Managed 会话。',
    ],
  },
  {
    id: 'providers',
    category: 'configuration',
    issue: 15084,
    label: ['Provider listing', 'Provider 列表'],
    reason: [
      'Managed has no provider-listing surface.',
      'Managed 没有 Provider 列表界面。',
    ],
  },
  {
    id: 'workspace-preflight',
    category: 'configuration',
    issue: 15084,
    label: [
      'Workspace env, preflight and init',
      '工作区 env、preflight 与 init',
    ],
    reason: [
      'Managed has no equivalents for the daemon workspace environment, preflight and initialization surfaces.',
      'Managed 没有 daemon 工作区环境、预检和初始化界面的对应功能。',
    ],
  },
  {
    id: 'tool-toggle',
    category: 'configuration',
    issue: 15084,
    label: ['Per-workspace tool toggle', '按工作区开关工具'],
    reason: [
      'The AgentDefinition fixes the execution profile; Managed has no per-workspace tool toggle.',
      '执行 profile 由 AgentDefinition 固定，Managed 没有按工作区开关工具的入口。',
    ],
  },
  {
    id: 'language-sync',
    category: 'configuration',
    issue: 15084,
    label: ['Language synchronization', '语言同步'],
    reason: [
      'The browser language is local to the UI. Managed has no Session or user language-synchronization route.',
      '浏览器语言仅属于当前 UI。Managed 没有会话或用户语言同步路由。',
    ],
  },
  {
    id: 'workspace-identity',
    category: 'configuration',
    issue: 15084,
    label: [
      'Workspace directories, clone source and identity',
      '工作区目录、克隆来源与身份',
    ],
    reason: [
      'Managed uses one registered root and creates empty directories. Extra directories, Git clone sources, display names and ordering are unavailable.',
      'Managed 使用一个已注册根目录，创建时只生成空目录。额外目录、Git 克隆来源、显示名和排序均不可用。',
    ],
  },
  {
    id: 'github',
    category: 'configuration',
    issue: 15084,
    label: ['GitHub setup and pull requests', 'GitHub 设置与 Pull Request'],
    reason: [
      'Managed has no GitHub setup, pull-request list or pull-request files surface.',
      'Managed 没有 GitHub 设置、Pull Request 列表或 Pull Request 文件界面。',
    ],
  },
  {
    id: 'workspace-permissions',
    category: 'configuration',
    issue: 15084,
    label: ['Workspace-level permissions', '工作区级权限'],
    reason: [
      'Managed has no Workspace-level permissions configuration. Session approval allow/ask/deny rules remain separately editable.',
      'Managed 没有工作区级权限配置。会话审批的 allow／ask／deny 规则仍可单独编辑。',
    ],
  },
  {
    id: 'memory',
    category: 'knowledge',
    issue: 13396,
    label: ['Memory panel and memory files', 'Memory 面板与记忆文件'],
    reason: [
      'Managed binds personal MemoryStores explicitly per Session; it has no Workspace memory-file API or daemon memory panel.',
      'Managed 按会话显式绑定个人 MemoryStore，没有工作区记忆文件 API 或 daemon Memory 面板。',
    ],
  },
  {
    id: 'agents',
    category: 'knowledge',
    issue: 16546,
    label: [
      'Agents manager, generation and Session listing',
      'Agents 管理、生成与会话列表',
    ],
    reason: [
      'Agent definitions are tenant resources. Managed has no Workspace agent files, generation UI or Session agent listing.',
      'Agent 定义属于租户资源。Managed 没有工作区 Agent 文件、生成界面或会话 Agent 列表。',
    ],
  },
  {
    id: 'skill-management',
    category: 'knowledge',
    issue: 15084,
    label: ['Skill settings and installation', 'Skill 设置与安装'],
    reason: [
      'Managed provides read-only Session Skills, runtime import and default Workspace pins at creation. Enable/disable, batch toggles, activation and archive/ZIP management are unavailable.',
      'Managed 提供只读会话 Skills、运行时导入和创建时的默认工作区固定。启停、批量开关、激活及归档／ZIP 管理不可用。',
    ],
  },
  {
    id: 'extension-management',
    category: 'knowledge',
    issue: 16546,
    label: ['Daemon extension management v2', 'daemon 扩展管理 v2'],
    reason: [
      'Managed has a separate Session-pinned package lifecycle, not the daemon extension list, state, credential, local-install and batch-activation contract.',
      'Managed 使用另一套按会话固定的包生命周期，不是 daemon 的扩展列表、状态、凭据、本地安装与批量激活合同。',
    ],
  },
  {
    id: 'hooks',
    category: 'knowledge',
    issue: 16546,
    label: ['Hooks panel', 'Hooks 面板'],
    reason: [
      'Managed exposes a backend Hooks catalog but has no sidebar provider slot or management panel.',
      'Managed 提供后端 Hooks 目录，但没有侧栏 provider 槽位或管理面板。',
    ],
  },
  {
    id: 'channels',
    category: 'knowledge',
    issue: 16546,
    label: ['Channel controls and observed contacts', '渠道控制与已观察联系人'],
    reason: [
      'Managed exposes channel list and delivery reads, but not control, reload, deletion or observed-contact surfaces.',
      'Managed 提供渠道列表与投递读取，但没有控制、重载、删除或已观察联系人界面。',
    ],
  },
  {
    id: 'scheduled-tasks',
    category: 'knowledge',
    issue: 16546,
    label: ['Scheduled tasks panel', '定时任务面板'],
    reason: [
      'Managed provides backend automation but no scheduled-task sidebar panel.',
      'Managed 提供后端自动化能力，但没有定时任务侧栏面板。',
    ],
  },
  {
    id: 'message-deletion',
    category: 'conversation',
    issue: 15084,
    label: ['Message deletion', '消息删除'],
    reason: ['Managed cannot delete messages.', 'Managed 不能删除消息。'],
  },
  {
    id: 'rewind',
    category: 'conversation',
    issue: 15084,
    label: ['Rewind', '回退'],
    reason: [
      'Managed has no conversation rewind operation.',
      'Managed 没有会话回退操作。',
    ],
  },
  {
    id: 'session-branches',
    category: 'conversation',
    issue: 15084,
    label: ['Conversation branches', '会话分支'],
    reason: [
      'Managed has no branch-session action, branch picker or branch indicator.',
      'Managed 没有创建会话分支、分支选择器或分支指示。',
    ],
  },
  {
    id: 'worktree-operations',
    category: 'conversation',
    issue: 15084,
    label: [
      'Worktree reset, branch and handoff',
      '工作树 reset、建分支与 handoff',
    ],
    reason: [
      'Managed creates and inspects Session-owned worktrees with an initial branch and supports cleanup. Ownership-transfer reset, post-create branch creation and work-carrying handoff are unavailable.',
      'Managed 可创建并检查带初始分支的会话工作树，也支持清理。所有权转移 reset、创建后建分支和携带工作的 handoff 不可用。',
    ],
  },
  {
    id: 'session-organization',
    category: 'conversation',
    issue: 15084,
    label: ['Session organization and metadata', '会话组织与元数据'],
    reason: [
      'Managed supports rename only; it has no Session organization or general metadata bag.',
      'Managed 只支持重命名，没有会话组织功能或通用元数据袋。',
    ],
  },
  {
    id: 'workspace-artifacts',
    category: 'files',
    issue: 15084,
    label: ['Workspace artifact library and stream', '工作区产物库与渐进流'],
    reason: [
      'Managed provides a cross-session artifact library with cursor pages, preview, download and refresh. Progressive streaming, live Session-summary updates and batch removal are unavailable.',
      'Managed 提供支持游标分页、预览、下载和刷新的跨会话产物库。渐进流、会话摘要实时更新和批量删除不可用。',
    ],
  },
  {
    id: 'file-mutations',
    category: 'files',
    issue: 15084,
    label: ['File and directory mutation', '文件与目录变更'],
    reason: [
      'Managed supports query, read and upload, but not file deletion, directory creation or directory deletion.',
      'Managed 支持查询、读取和上传，但不支持删除文件、创建目录或删除目录。',
    ],
  },
  {
    id: 'raw-file-reads',
    category: 'files',
    issue: 15084,
    label: ['Raw bytes and byte cursors', '原始字节与字节游标'],
    reason: [
      'Managed reads file snapshots; raw-byte reads and byte-cursor paging are unavailable.',
      'Managed 读取文件快照，不支持原始字节读取和字节游标分页。',
    ],
  },
  {
    id: 'attachments',
    category: 'files',
    issue: 15084,
    label: ['Daemon attachment surfaces', 'daemon 附件界面'],
    reason: [
      'Eligible Managed Sessions support inline text/images and Workspace upload. Daemon attachment references, chunked upload and attachment listing are unavailable.',
      '符合条件的 Managed 会话支持内联文本／图片和工作区上传。daemon 附件引用、分片上传和附件列表不可用。',
    ],
  },
  {
    id: 'generated-ui-state',
    category: 'files',
    issue: 15084,
    label: ['Generated UI view state', 'Generated UI 视图状态'],
    reason: [
      'Managed has no Generated UI view-state store or routes for persisting card state.',
      'Managed 没有用于保存卡片状态的 Generated UI 视图状态存储或路由。',
    ],
  },
  {
    id: 'session-sources',
    category: 'files',
    issue: 15084,
    label: ['Session sources and metadata', '会话来源与元数据'],
    reason: [
      'Managed has no Session source list or source-metadata surface.',
      'Managed 没有会话来源列表或来源元数据界面。',
    ],
  },
  {
    id: 'right-panels',
    category: 'files',
    issue: 15084,
    label: [
      'Review, change overview, web preview and side task',
      '评审、变更概览、网页预览与侧任务',
    ],
    reason: [
      'Managed provides Outputs, Tasks and Diagnostics panels. The daemon review, change-overview, web-preview and side-task panels have no Managed equivalent.',
      'Managed 提供输出、任务和诊断面板。daemon 的评审、变更概览、网页预览和侧任务面板没有对应功能。',
    ],
  },
  {
    id: 'voice',
    category: 'runtime',
    issue: 15084,
    label: ['Voice and transcription', '语音与转写'],
    reason: [
      'Managed has no voice, live-voice or transcription surface.',
      'Managed 没有语音、实时语音或转写界面。',
    ],
  },
  {
    id: 'browser-automation',
    category: 'runtime',
    issue: 15084,
    label: [
      'Browser automation, CDP and client MCP',
      '浏览器自动化、CDP 与客户端 MCP',
    ],
    reason: [
      'Managed has no browser-automation MCP, CDP tunnel or client-hosted MCP-over-WebSocket surface.',
      'Managed 没有浏览器自动化 MCP、CDP 隧道或客户端托管 MCP-over-WebSocket 界面。',
    ],
  },
  {
    id: 'mcp-pool',
    category: 'runtime',
    issue: 15084,
    label: ['MCP pool and guardrails', 'MCP 池与护栏'],
    reason: [
      'Managed provides Session-scoped MCP catalog and management. Workspace pools, pool restart, client guardrails and guardrail events are unavailable.',
      'Managed 提供会话级 MCP 目录与管理。工作区池、池重启、客户端护栏和护栏事件不可用。',
    ],
  },
  {
    id: 'lsp',
    category: 'runtime',
    issue: 15084,
    label: ['LSP', 'LSP'],
    reason: [
      'LSP is not part of the Managed execution profile.',
      'LSP 不在 Managed 执行 profile 中。',
    ],
  },
  {
    id: 'sub-session-send',
    category: 'runtime',
    issue: 15084,
    label: ['Sub-session send', '向子会话发送'],
    reason: [
      'Managed provides readable child Sessions and diagnostics, but no composer or /send action for submitting prompts to a child Session.',
      'Managed 提供可读的子会话和诊断，但没有用于向子会话提交提示的编辑器或 /send 操作。',
    ],
  },
  {
    id: 'mid-turn-send-now',
    category: 'runtime',
    issue: 15084,
    label: ['Mid-turn send now', '轮内立即发送'],
    reason: [
      'Managed consumes queued guidance automatically at safe model boundaries. A separate immediate-send action is tracked rather than silently implied.',
      'Managed 会在安全模型边界自动消费排队引导。是否需要单独的立即发送操作仍在跟踪，不会静默暗示已有入口。',
    ],
  },
  {
    id: 'live-state',
    category: 'runtime',
    issue: 15084,
    label: [
      'Live state and background-work indicator',
      '实时状态与后台工作指示',
    ],
    reason: [
      'Managed has no live-state snapshot or sidebar background-work indicator.',
      'Managed 没有实时状态快照或侧栏后台工作指示。',
    ],
  },
  {
    id: 'session-probes',
    category: 'runtime',
    issue: 15084,
    label: [
      'Session refresh, status, commands and context',
      '会话刷新、状态、命令与上下文',
    ],
    reason: [
      'Managed reads Sessions and Turns through list/get. Daemon refresh, status probes, supported-commands and context routes are unavailable.',
      'Managed 通过 list/get 读取会话和轮次。daemon 刷新、状态探针、支持命令和上下文路由不可用。',
    ],
  },
];
