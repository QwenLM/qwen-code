/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { t } from '../../../i18n/index.js';
import type {
  MCPManagementDialogProps,
  MCPServerDisplayInfo,
  MCPToolDisplayInfo,
} from './types.js';
import { MCP_MANAGEMENT_STEPS } from './types.js';
import { ServerListStep } from './steps/ServerListStep.js';
import { ServerDetailStep } from './steps/ServerDetailStep.js';
import { ServerLogsStep } from './steps/ServerLogsStep.js';
import { ToolListStep } from './steps/ToolListStep.js';
import { ToolDetailStep } from './steps/ToolDetailStep.js';
import { DisableScopeSelectStep } from './steps/DisableScopeSelectStep.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import {
  getMCPServerStatus,
  DiscoveredMCPTool,
  type MCPServerConfig,
  type AnyDeclarativeTool,
  type DiscoveredMCPPrompt,
} from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../../config/settings.js';

export const MCPManagementDialog: React.FC<MCPManagementDialogProps> = ({
  onClose,
}) => {
  const config = useConfig();

  const [servers, setServers] = useState<MCPServerDisplayInfo[]>([]);
  const [selectedServerIndex, setSelectedServerIndex] = useState<number>(-1);
  const [selectedTool, setSelectedTool] = useState<MCPToolDisplayInfo | null>(
    null,
  );
  const [navigationStack, setNavigationStack] = useState<string[]>([
    MCP_MANAGEMENT_STEPS.SERVER_LIST,
  ]);
  const [isLoading, setIsLoading] = useState(true);

  // 加载MCP服务器数据
  useEffect(() => {
    const loadServers = async () => {
      if (!config) return;

      setIsLoading(true);
      try {
        const mcpServers = config.getMcpServers() || {};
        const toolRegistry = config.getToolRegistry();
        const promptRegistry = await config.getPromptRegistry();

        // 获取 settings 以确定每个服务器的 scope
        const settings = loadSettings();
        const userSettings = settings.forScope(SettingScope.User).settings;
        const workspaceSettings = settings.forScope(
          SettingScope.Workspace,
        ).settings;

        const serverInfos: MCPServerDisplayInfo[] = [];

        for (const [name, serverConfig] of Object.entries(mcpServers) as Array<
          [string, MCPServerConfig]
        >) {
          const status = getMCPServerStatus(name);

          // 获取该服务器的工具
          const allTools: AnyDeclarativeTool[] =
            toolRegistry?.getAllTools() || [];
          const serverTools = allTools.filter(
            (t): t is DiscoveredMCPTool =>
              t instanceof DiscoveredMCPTool && t.serverName === name,
          );

          // 获取该服务器的prompts
          const allPrompts: DiscoveredMCPPrompt[] =
            promptRegistry?.getAllPrompts() || [];
          const serverPrompts = allPrompts.filter(
            (p) => 'serverName' in p && p.serverName === name,
          );

          // 确定来源类型
          let source: 'user' | 'project' | 'extension' = 'user';
          if (serverConfig.extensionName) {
            source = 'extension';
          }

          // 确定配置所在的 scope
          let scope: 'user' | 'workspace' | 'extension' = 'user';
          if (serverConfig.extensionName) {
            scope = 'extension';
          } else if (workspaceSettings.mcpServers?.[name]) {
            scope = 'workspace';
          } else if (userSettings.mcpServers?.[name]) {
            scope = 'user';
          }

          // 使用 config.isMcpServerDisabled() 检查服务器是否被禁用
          const isDisabled = config.isMcpServerDisabled(name);

          serverInfos.push({
            name,
            status,
            source,
            scope,
            config: serverConfig,
            toolCount: serverTools.length,
            promptCount: serverPrompts.length,
            isDisabled,
          });
        }

        setServers(serverInfos);
      } finally {
        setIsLoading(false);
      }
    };

    loadServers();
  }, [config]);

  // 选中的服务器
  const selectedServer = useMemo(() => {
    if (selectedServerIndex >= 0 && selectedServerIndex < servers.length) {
      return servers[selectedServerIndex];
    }
    return null;
  }, [servers, selectedServerIndex]);

  // 当前步骤
  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      MCP_MANAGEMENT_STEPS.SERVER_LIST,
    [navigationStack],
  );

  // 导航处理
  const handleNavigateToStep = useCallback((step: string) => {
    setNavigationStack((prev) => [...prev, step]);
  }, []);

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) return prev;
      return prev.slice(0, -1);
    });
  }, []);

  // 选择服务器
  const handleSelectServer = useCallback(
    (index: number) => {
      setSelectedServerIndex(index);
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.SERVER_DETAIL);
    },
    [handleNavigateToStep],
  );

  // 获取服务器工具列表
  const getServerTools = useCallback((): MCPToolDisplayInfo[] => {
    if (!config || !selectedServer) return [];

    const toolRegistry = config.getToolRegistry();
    if (!toolRegistry) return [];

    const allTools: AnyDeclarativeTool[] = toolRegistry.getAllTools();
    const mcpTools: DiscoveredMCPTool[] = [];
    for (const tool of allTools) {
      if (
        tool instanceof DiscoveredMCPTool &&
        tool.serverName === selectedServer.name
      ) {
        mcpTools.push(tool);
      }
    }
    return mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      serverName: tool.serverName,
      schema: tool.parameterSchema as object | undefined,
    }));
  }, [config, selectedServer]);

  // 查看工具列表
  const handleViewTools = useCallback(() => {
    handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_LIST);
  }, [handleNavigateToStep]);

  // 查看服务器日志
  const handleViewLogs = useCallback(() => {
    handleNavigateToStep(MCP_MANAGEMENT_STEPS.SERVER_LOGS);
  }, [handleNavigateToStep]);

  // 选择工具
  const handleSelectTool = useCallback(
    (tool: MCPToolDisplayInfo) => {
      setSelectedTool(tool);
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
    },
    [handleNavigateToStep],
  );

  // 重新加载服务器数据
  const reloadServers = useCallback(async () => {
    if (!config) return;

    setIsLoading(true);
    try {
      const mcpServers = config.getMcpServers() || {};
      const toolRegistry = config.getToolRegistry();
      const promptRegistry = await config.getPromptRegistry();

      // 获取 settings 以确定每个服务器的 scope
      const settings = loadSettings();
      const userSettings = settings.forScope(SettingScope.User).settings;
      const workspaceSettings = settings.forScope(
        SettingScope.Workspace,
      ).settings;

      const serverInfos: MCPServerDisplayInfo[] = [];

      for (const [name, serverConfig] of Object.entries(mcpServers) as Array<
        [string, MCPServerConfig]
      >) {
        const status = getMCPServerStatus(name);

        const allTools: AnyDeclarativeTool[] =
          toolRegistry?.getAllTools() || [];
        const serverTools = allTools.filter(
          (t): t is DiscoveredMCPTool =>
            t instanceof DiscoveredMCPTool && t.serverName === name,
        );

        const allPrompts: DiscoveredMCPPrompt[] =
          promptRegistry?.getAllPrompts() || [];
        const serverPrompts = allPrompts.filter(
          (p) => 'serverName' in p && p.serverName === name,
        );

        // 确定来源类型
        let source: 'user' | 'project' | 'extension' = 'user';
        if (serverConfig.extensionName) {
          source = 'extension';
        }

        // 确定配置所在的 scope
        let scope: 'user' | 'workspace' | 'extension' = 'user';
        if (serverConfig.extensionName) {
          scope = 'extension';
        } else if (workspaceSettings.mcpServers?.[name]) {
          scope = 'workspace';
        } else if (userSettings.mcpServers?.[name]) {
          scope = 'user';
        }

        // 使用 config.isMcpServerDisabled() 检查服务器是否被禁用
        const isDisabled = config.isMcpServerDisabled(name);

        serverInfos.push({
          name,
          status,
          source,
          scope,
          config: serverConfig,
          toolCount: serverTools.length,
          promptCount: serverPrompts.length,
          isDisabled,
        });
      }

      setServers(serverInfos);
    } finally {
      setIsLoading(false);
    }
  }, [config]);

  // 重新连接服务器
  const handleReconnect = useCallback(async () => {
    if (!config || !selectedServer) return;

    try {
      setIsLoading(true);
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.discoverToolsForServer(selectedServer.name);
      }
      // 重新加载服务器数据以更新状态
      await reloadServers();
    } catch (_error) {
      // 错误处理 - 静默失败
    } finally {
      setIsLoading(false);
    }
  }, [config, selectedServer, reloadServers]);

  // 启用服务器
  const handleEnableServer = useCallback(async () => {
    if (!config || !selectedServer) return;

    try {
      setIsLoading(true);

      const server = selectedServer;
      const settings = loadSettings();

      // 从 user 和 workspace 的排除列表中移除
      for (const scope of [SettingScope.User, SettingScope.Workspace]) {
        const scopeSettings = settings.forScope(scope).settings;
        const currentExcluded = scopeSettings.mcp?.excluded || [];

        if (currentExcluded.includes(server.name)) {
          const newExcluded = currentExcluded.filter(
            (name: string) => name !== server.name,
          );
          settings.setValue(scope, 'mcp.excluded', newExcluded);
        }
      }

      // 更新运行时配置的排除列表
      const currentExcluded = config.getExcludedMcpServers() || [];
      const newExcluded = currentExcluded.filter(
        (name: string) => name !== server.name,
      );
      config.setExcludedMcpServers(newExcluded);

      // 重新发现该服务器的工具
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.discoverToolsForServer(server.name);
      }

      // 重新加载服务器列表
      await reloadServers();
    } catch (_error) {
      // 错误处理 - 静默失败
    } finally {
      setIsLoading(false);
    }
  }, [config, selectedServer, reloadServers]);

  // 处理禁用/启用操作
  const handleDisable = useCallback(() => {
    if (!selectedServer) return;

    // 如果服务器已被禁用，则直接启用
    if (selectedServer.isDisabled) {
      void handleEnableServer();
    } else {
      // 否则导航到禁用 scope 选择
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT);
    }
  }, [selectedServer, handleEnableServer, handleNavigateToStep]);

  // 选择禁用 scope 后执行禁用
  const handleSelectDisableScope = useCallback(
    async (scope: 'user' | 'workspace') => {
      if (!config || !selectedServer) return;

      try {
        setIsLoading(true);

        const server = selectedServer;
        const settings = loadSettings();

        // 获取当前的排除列表
        const scopeSettings = settings.forScope(
          scope === 'user' ? SettingScope.User : SettingScope.Workspace,
        ).settings;
        const currentExcluded = scopeSettings.mcp?.excluded || [];

        // 如果服务器不在排除列表中，添加它
        if (!currentExcluded.includes(server.name)) {
          const newExcluded = [...currentExcluded, server.name];
          settings.setValue(
            scope === 'user' ? SettingScope.User : SettingScope.Workspace,
            'mcp.excluded',
            newExcluded,
          );
        }

        // 使用新的 disableMcpServer 方法禁用服务器
        const toolRegistry = config.getToolRegistry();
        if (toolRegistry) {
          await toolRegistry.disableMcpServer(server.name);
        }

        // 重新加载服务器列表
        await reloadServers();

        // 返回到服务器详情页
        handleNavigateBack();
      } catch (_error) {
        // 错误处理 - 静默失败
      } finally {
        setIsLoading(false);
      }
    },
    [config, selectedServer, handleNavigateBack, reloadServers],
  );

  // 渲染步骤头部
  const renderStepHeader = useCallback(() => {
    const currentStep = getCurrentStep();
    let headerText = '';

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        headerText = t('Manage MCP servers');
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        headerText = selectedServer?.name || t('Server Detail');
        break;
      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        headerText = t('Disable Server');
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_LOGS:
        headerText = t('Server Logs');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        headerText = t('Tools');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        headerText = selectedTool?.name || t('Tool Detail');
        break;
      default:
        headerText = t('MCP Management');
    }

    return (
      <Box>
        <Text bold>{headerText}</Text>
      </Box>
    );
  }, [getCurrentStep, selectedServer, selectedTool]);

  // 渲染步骤内容
  const renderStepContent = useCallback(() => {
    if (isLoading) {
      return (
        <Box>
          <Text color={theme.text.secondary}>{t('Loading...')}</Text>
        </Box>
      );
    }

    const currentStep = getCurrentStep();

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        return (
          <ServerListStep servers={servers} onSelect={handleSelectServer} />
        );

      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        return (
          <ServerDetailStep
            server={selectedServer}
            onViewTools={handleViewTools}
            onViewLogs={handleViewLogs}
            onReconnect={handleReconnect}
            onDisable={handleDisable}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        return (
          <DisableScopeSelectStep
            server={selectedServer}
            onSelectScope={handleSelectDisableScope}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.SERVER_LOGS:
        return (
          <ServerLogsStep server={selectedServer} onBack={handleNavigateBack} />
        );

      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        return (
          <ToolListStep
            tools={getServerTools()}
            serverName={selectedServer?.name || ''}
            onSelect={handleSelectTool}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        return (
          <ToolDetailStep tool={selectedTool} onBack={handleNavigateBack} />
        );

      default:
        return (
          <Box>
            <Text color={theme.status.error}>{t('Unknown step')}</Text>
          </Box>
        );
    }
  }, [
    isLoading,
    getCurrentStep,
    servers,
    selectedServer,
    selectedTool,
    handleSelectServer,
    handleViewTools,
    handleViewLogs,
    handleReconnect,
    handleDisable,
    handleNavigateBack,
    handleSelectTool,
    handleSelectDisableScope,
    getServerTools,
  ]);

  // 渲染步骤底部
  const renderStepFooter = useCallback(() => {
    const currentStep = getCurrentStep();
    let footerText = '';

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        if (servers.length === 0) {
          footerText = t('Esc to close');
        } else {
          footerText = t('↑↓ to navigate · Enter to select · Esc to close');
        }
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        footerText = t('↑↓ to navigate · Enter to select · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        footerText = t('↑↓ to navigate · Enter to confirm · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_LOGS:
        footerText = t('↑↓ to navigate · M to pause/resume · Q/Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        footerText = t('↑↓ to navigate · Enter to select · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        footerText = t('Esc to back');
        break;
      default:
        footerText = t('Esc to close');
    }

    return (
      <Box>
        <Text color={theme.text.secondary}>{footerText}</Text>
      </Box>
    );
  }, [getCurrentStep, servers.length]);

  // ESC 键处理 - 仅关闭对话框，子组件的返回由各自处理避免重复触发
  useKeypress(
    (key) => {
      if (
        key.name === 'escape' &&
        getCurrentStep() === MCP_MANAGEMENT_STEPS.SERVER_LIST
      ) {
        onClose();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
        gap={1}
      >
        {renderStepHeader()}
        {renderStepContent()}
        {renderStepFooter()}
      </Box>
    </Box>
  );
};
