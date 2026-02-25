/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  MCPServerStatus,
} from '@qwen-code/qwen-code-core';

/**
 * MCP管理步骤定义
 */
export const MCP_MANAGEMENT_STEPS = {
  SERVER_LIST: 'server-list',
  SERVER_DETAIL: 'server-detail',
  DISABLE_SCOPE_SELECT: 'disable-scope-select',
  TOOL_LIST: 'tool-list',
  TOOL_DETAIL: 'tool-detail',
} as const;

export type MCPManagementStep =
  (typeof MCP_MANAGEMENT_STEPS)[keyof typeof MCP_MANAGEMENT_STEPS];

/**
 * MCP服务器显示信息
 */
export interface MCPServerDisplayInfo {
  /** 服务器名称 */
  name: string;
  /** 连接状态 */
  status: MCPServerStatus;
  /** 来源类型 */
  source: 'user' | 'project' | 'extension';
  /** 配置所在的 scope */
  scope: 'user' | 'workspace' | 'extension';
  /** 配置文件路径 */
  configPath?: string;
  /** 服务器配置 */
  config: MCPServerConfig;
  /** 工具数量 */
  toolCount: number;
  /** 无效工具数量（缺少name或description） */
  invalidToolCount?: number;
  /** Prompt数量 */
  promptCount: number;
  /** 错误信息 */
  errorMessage?: string;
  /** 是否被禁用（在排除列表中） */
  isDisabled: boolean;
}

/**
 * MCP工具显示信息
 */
export interface MCPToolDisplayInfo {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description?: string;
  /** 所属服务器 */
  serverName: string;
  /** 工具schema */
  schema?: object;
  /** 工具注解 */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** 工具是否有效（有name和description才能被LLM调用） */
  isValid: boolean;
  /** 无效原因（当isValid为false时） */
  invalidReason?: string;
}

/**
 * MCP Prompt显示信息
 */
export interface MCPPromptDisplayInfo {
  /** Prompt名称 */
  name: string;
  /** Prompt描述 */
  description?: string;
  /** 所属服务器 */
  serverName: string;
  /** 参数定义 */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * 分组后的服务器列表
 */
export interface GroupedServers {
  /** 来源标识 */
  source: string;
  /** 来源显示名称 */
  displayName: string;
  /** 配置文件路径 */
  configPath?: string;
  /** 服务器列表 */
  servers: MCPServerDisplayInfo[];
}

/**
 * ServerListStep组件属性
 */
export interface ServerListStepProps {
  /** 服务器列表 */
  servers: MCPServerDisplayInfo[];
  /** 选择回调 */
  onSelect: (index: number) => void;
}

/**
 * ServerDetailStep组件属性
 */
export interface ServerDetailStepProps {
  /** 选中的服务器 */
  server: MCPServerDisplayInfo | null;
  /** 查看工具列表回调 */
  onViewTools: () => void;
  /** 重新连接回调 */
  onReconnect?: () => void;
  /** 禁用服务器回调 */
  onDisable?: () => void;
  /** 返回回调 */
  onBack: () => void;
}

/**
 * DisableScopeSelectStep组件属性
 */
export interface DisableScopeSelectStepProps {
  /** 选中的服务器 */
  server: MCPServerDisplayInfo | null;
  /** 选择 scope 回调 */
  onSelectScope: (scope: 'user' | 'workspace') => void;
  /** 返回回调 */
  onBack: () => void;
}

/**
 * ToolListStep组件属性
 */
export interface ToolListStepProps {
  /** 工具列表 */
  tools: MCPToolDisplayInfo[];
  /** 服务器名称 */
  serverName: string;
  /** 选择回调 */
  onSelect: (tool: MCPToolDisplayInfo) => void;
  /** 返回回调 */
  onBack: () => void;
}

/**
 * ToolDetailStep组件属性
 */
export interface ToolDetailStepProps {
  /** 工具信息 */
  tool: MCPToolDisplayInfo | null;
  /** 返回回调 */
  onBack: () => void;
}

/**
 * MCP管理对话框属性
 */
export interface MCPManagementDialogProps {
  /** 关闭回调 */
  onClose: () => void;
}
