type ManagedMcpMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const MANAGED_MCP_MESSAGES_EN: Record<string, ManagedMcpMessage> = {
  'managed.mcp.manage': 'Manage MCP',
  'managed.mcp.selectSession':
    'Select a Managed Session to manage its MCP servers.',
  'managed.mcp.workspaceUnavailable':
    'The selected Session Workspace is unavailable.',
  'managed.mcp.unsupported': 'MCP management is unavailable for this Session.',
  'managed.mcp.sessionRevision': (v) =>
    `Session ${v?.sessionId} · settings revision ${v?.revision}`,
  'managed.mcp.sessionSettings':
    'Changes apply to this Session. Its original Agent definition stays fixed.',
  'managed.mcp.publishedOnly':
    'Choose an exact definition published for this Runtime and Workspace.',
  'managed.mcp.definition': 'Published definition',
  'managed.mcp.noPublished':
    'No published definitions are available for this selection.',
  'managed.mcp.apply': 'Apply',
  'managed.mcp.action.add': 'Add server',
  'managed.mcp.action.edit': 'Change definition',
  'managed.mcp.action.remove': 'Remove',
  'managed.mcp.action.enable': 'Enable',
  'managed.mcp.action.disable': 'Disable',
  'managed.mcp.action.reload': 'Reload',
  'managed.mcp.action.restart': 'Restart',
  'managed.mcp.state.enabled': 'Configured',
  'managed.mcp.state.disabled': 'Disabled',
  'managed.mcp.state.removed': 'Removed',
  'managed.mcp.drained': 'Drained',
  'managed.mcp.operation.pending': 'Pending',
  'managed.mcp.operation.settled': 'Completed',
  'managed.mcp.operation.failed': 'Failed',
  'managed.mcp.operation.recovery_required': 'Recovery required',
  'managed.mcp.unconfirmed':
    'The original command still needs confirmation. Check it before starting another change.',
  'managed.mcp.checkOperation': 'Check original command',
  'managed.mcp.retryCommand': 'Retry original command',
  'managed.mcp.metadataOnly':
    'Catalog metadata is a saved snapshot. Resource bodies and prompt expansion are unavailable here.',
  'managed.mcp.noCatalog': 'No catalog has been published for this server.',
  'managed.mcp.empty': 'No MCP servers are configured for this Session.',
};

export const MANAGED_MCP_MESSAGES_ZH: Record<string, ManagedMcpMessage> = {
  'managed.mcp.manage': '管理 MCP',
  'managed.mcp.selectSession': '请选择一个 Managed 会话以管理它的 MCP 服务。',
  'managed.mcp.workspaceUnavailable': '所选会话的工作区暂不可用。',
  'managed.mcp.unsupported': '当前会话不支持 MCP 管理。',
  'managed.mcp.sessionRevision': (v) =>
    `会话 ${v?.sessionId} · 设置修订 ${v?.revision}`,
  'managed.mcp.sessionSettings':
    '修改仅用于当前会话，原始 Agent 定义保持固定。',
  'managed.mcp.publishedOnly': '选择已为当前 Runtime 和工作区发布的确切定义。',
  'managed.mcp.definition': '已发布定义',
  'managed.mcp.noPublished': '当前选择没有可用的已发布定义。',
  'managed.mcp.apply': '应用',
  'managed.mcp.action.add': '添加服务',
  'managed.mcp.action.edit': '更换定义',
  'managed.mcp.action.remove': '移除',
  'managed.mcp.action.enable': '启用',
  'managed.mcp.action.disable': '禁用',
  'managed.mcp.action.reload': '重新加载',
  'managed.mcp.action.restart': '重启',
  'managed.mcp.state.enabled': '已配置',
  'managed.mcp.state.disabled': '已禁用',
  'managed.mcp.state.removed': '已移除',
  'managed.mcp.drained': '已排空',
  'managed.mcp.operation.pending': '待确认',
  'managed.mcp.operation.settled': '已完成',
  'managed.mcp.operation.failed': '失败',
  'managed.mcp.operation.recovery_required': '需要恢复',
  'managed.mcp.unconfirmed': '原命令仍需确认，请先查询该命令，再开始其他修改。',
  'managed.mcp.checkOperation': '查询原命令',
  'managed.mcp.retryCommand': '重试原命令',
  'managed.mcp.metadataOnly':
    '目录元数据为已保存快照，此处不读取资源正文或展开提示。',
  'managed.mcp.noCatalog': '此服务尚未发布目录。',
  'managed.mcp.empty': '当前会话尚未配置 MCP 服务。',
};
