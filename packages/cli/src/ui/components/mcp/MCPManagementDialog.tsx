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
import { ToolListStep } from './steps/ToolListStep.js';
import { ToolDetailStep } from './steps/ToolDetailStep.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import {
  getMCPServerStatus,
  DiscoveredMCPTool,
  type MCPServerConfig,
  type AnyDeclarativeTool,
  type DiscoveredMCPPrompt,
} from '@qwen-code/qwen-code-core';

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

          // 确定来源
          let source: 'user' | 'project' | 'extension' = 'user';
          if (serverConfig.extensionName) {
            source = 'extension';
          }
          // TODO: 区分user和project来源需要更详细的配置信息

          serverInfos.push({
            name,
            status,
            source,
            config: serverConfig,
            toolCount: serverTools.length,
            promptCount: serverPrompts.length,
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

  // 选择工具
  const handleSelectTool = useCallback(
    (tool: MCPToolDisplayInfo) => {
      setSelectedTool(tool);
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
    },
    [handleNavigateToStep],
  );

  // 重新连接服务器
  const handleReconnect = useCallback(async () => {
    if (!config || !selectedServer) return;

    try {
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.discoverToolsForServer(selectedServer.name);
      }
      // 重新加载服务器数据以更新状态
      const loadServers = async () => {
        setIsLoading(true);
        try {
          const mcpServers = config.getMcpServers() || {};
          const toolRegistry = config.getToolRegistry();
          const promptRegistry = await config.getPromptRegistry();

          const serverInfos: MCPServerDisplayInfo[] = [];

          for (const [name, serverConfig] of Object.entries(
            mcpServers,
          ) as Array<[string, MCPServerConfig]>) {
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

            let source: 'user' | 'project' | 'extension' = 'user';
            if (serverConfig.extensionName) {
              source = 'extension';
            }

            serverInfos.push({
              name,
              status,
              source,
              config: serverConfig,
              toolCount: serverTools.length,
              promptCount: serverPrompts.length,
            });
          }

          setServers(serverInfos);
        } finally {
          setIsLoading(false);
        }
      };
      await loadServers();
    } catch (_error) {
      // 错误处理 - 静默失败
    }
  }, [config, selectedServer]);

  // 禁用服务器
  const handleDisable = useCallback(async () => {
    if (!config || !selectedServer) return;

    // TODO: 实现禁用服务器的逻辑
    // 这需要修改配置文件，暂时返回到服务器列表
    handleNavigateBack();
  }, [config, selectedServer, handleNavigateBack]);

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
            onReconnect={handleReconnect}
            onDisable={handleDisable}
            onBack={handleNavigateBack}
          />
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
    handleReconnect,
    handleDisable,
    handleNavigateBack,
    handleSelectTool,
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

  // ESC键处理
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        const currentStep = getCurrentStep();
        if (currentStep === MCP_MANAGEMENT_STEPS.SERVER_LIST) {
          onClose();
        } else {
          handleNavigateBack();
        }
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
