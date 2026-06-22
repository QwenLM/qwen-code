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
  RESOURCE_LIST: 'resource-list',
  RESOURCE_DETAIL: 'resource-detail',
  AUTHENTICATE: 'authenticate', // OAuth 认证步骤
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
  source: 'user' | 'project' | 'workspace' | 'system' | 'extension';
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
  /** Resource数量 */
  resourceCount: number;
  /** 错误信息 */
  errorMessage?: string;
  /** 是否被禁用（在排除列表中） */
  isDisabled: boolean;
  /** 是否存储有 OAuth 认证信息 */
  hasOAuthTokens?: boolean;
  /** 未连接且需要（重新）认证：连接时收到 401，或声明了 OAuth 但无已存 token */
  requiresAuth?: boolean;
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
 * MCP Resource显示信息
 */
export interface MCPResourceDisplayInfo {
  /** 资源 URI（在对话中通过 @server:uri 引用） */
  uri: string;
  /** 资源名称 */
  name?: string;
  /** 资源标题（更友好的展示名，若有） */
  title?: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 资源大小（字节） */
  size?: number;
  /** 所属服务器 */
  serverName: string;
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
 * ServerDetailStep 组件属性
 */
export interface ServerDetailStepProps {
  /** 选中的服务器 */
  server: MCPServerDisplayInfo | null;
  /** 查看工具列表回调 */
  onViewTools: () => void;
  /** 查看资源列表回调 */
  onViewResources?: () => void;
  /** 重新连接回调 */
  onReconnect?: () => void;
  /** 禁用服务器回调 */
  onDisable?: () => void;
  /** OAuth 认证回调 */
  onAuthenticate?: () => void;
  /** 清空认证信息回调 */
  onClearAuth?: () => void;
  /** 返回回调 */
  onBack: () => void;
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
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
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
}

/**
 * ToolDetailStep 组件属性
 */
export interface ToolDetailStepProps {
  /** 工具信息 */
  tool: MCPToolDisplayInfo | null;
  /** 返回回调 */
  onBack: () => void;
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
}

/**
 * ResourceListStep 组件属性
 */
export interface ResourceListStepProps {
  /** 资源列表 */
  resources: MCPResourceDisplayInfo[];
  /** 服务器名称 */
  serverName: string;
  /** 选择回调 */
  onSelect: (resource: MCPResourceDisplayInfo) => void;
  /** 返回回调 */
  onBack: () => void;
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
}

/**
 * ResourceDetailStep 组件属性
 */
export interface ResourceDetailStepProps {
  /** 资源信息 */
  resource: MCPResourceDisplayInfo | null;
  /** 返回回调 */
  onBack: () => void;
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
}

/**
 * AuthenticateStep 组件属性
 */
export interface AuthenticateStepProps {
  /** 服务器信息 */
  server: MCPServerDisplayInfo | null;
  /** 返回回调 */
  onBack: () => void;
  /** 是否响应键盘输入（默认 true） */
  isActive?: boolean;
}

/**
 * MCP管理对话框属性
 */
export interface MCPManagementDialogProps {
  /** 关闭回调 */
  onClose: () => void;
}
